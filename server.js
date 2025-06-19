// backend/server.js

const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); // You already have this
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// --- PDF & Canvas Imports ---
const { getDocument } = require('pdfjs-dist/legacy/build/pdf.js');
const { createCanvas } = require('canvas');

// --- Firebase Initialization ---
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'ilets-b4b42.appspot.com'
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

const app = express();

// =========================================================================
// --- MODIFICATION: DETAILED CORS CONFIGURATION ---
// =========================================================================

// Define the list of allowed origins (frontends).
// It's best practice to use an environment variable for your production URL.
const allowedOrigins = [
  'https://anantainfotech.com', // Your production frontend
  'http://localhost:3000',      // Your local development frontend (adjust port if needed)
  'http://localhost:3001'       // Add any other local ports you use
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // If the origin is in our whitelist, allow it.
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      // Otherwise, block it.
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'], // Explicitly allow DELETE and the preflight OPTIONS
  allowedHeaders: ['Content-Type', 'Authorization'], // Allow common headers
  credentials: true
};

// Use the detailed CORS options
app.use(cors(corsOptions));
// This must come BEFORE your routes.
// =========================================================================


app.use(express.json());

// In-memory store for processing jobs
const processingJobs = {};

// Multer setup for in-memory file storage
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

// ... THE REST OF YOUR CODE REMAINS EXACTLY THE SAME ...
// No other changes are needed below this line.

// =========================================================================
// --- REUSABLE UPLOAD & PROCESSING LOGIC ---
// =========================================================================

const createUploadJob = (req, res, targetCollection, uid = null) => {
    // ... same as before
    if (!req.file) {
        return res.status(400).json({ message: 'Missing file.' });
    }
    if (!req.body.mainCategory || !req.body.subcategory) {
        return res.status(400).json({ message: 'Missing main category or subcategory.' });
    }

    const jobId = uuidv4();
    processingJobs[jobId] = {
        file: req.file,
        targetCollection: targetCollection,
        uid: uid,
        mainCategory: req.body.mainCategory,
        subcategory: req.body.subcategory,
    };

    console.log(`Job created for collection '${targetCollection}' with ID: ${jobId}`);
    res.json({ jobId });
};

// STAGE 1 (Admin): Upload to the public collection
app.post('/api/upload-pdf', upload.single('pdfFile'), (req, res) => {
    createUploadJob(req, res, 'flipbooks');
});

// STAGE 1 (Team): Upload to the team collection
app.post('/api/upload-team-pdf', upload.single('pdfFile'), (req, res) => {
    if (!req.body.uid) {
        return res.status(400).json({ message: 'User ID (uid) is required for this operation.' });
    }
    createUploadJob(req, res, 'team-member', req.body.uid);
});

// STAGE 2: Process the file and stream live updates via SSE
app.get('/api/process-stream/:jobId', async (req, res) => {
    // ... same as before
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const { jobId } = req.params;
    const job = processingJobs[jobId];

    if (!job) {
        sendEvent({ type: 'error', message: 'Job not found or has expired.' });
        return res.end();
    }

    const { file, targetCollection, uid, mainCategory, subcategory } = job;
    const bookId = uuidv4();
    
    try {
        const sendLog = (message) => sendEvent({ type: 'log', message });
        const sendProgress = (value) => sendEvent({ type: 'progress', value });

        sendLog(`Server received job for collection: ${targetCollection}.`);
        console.log(`[${jobId}] Starting processing for bookId: ${bookId}`);

        sendLog('Uploading original PDF to storage...');
        const pdfPathInStorage = `source-pdfs/${bookId}/${file.originalname}`;
        const pdfFileInStorage = bucket.file(pdfPathInStorage);
        await pdfFileInStorage.save(file.buffer, {
            metadata: { contentType: file.mimetype }
        });
        sendLog('Original PDF uploaded.');

        sendLog('Converting PDF to images...');
        const data = new Uint8Array(file.buffer);
        const pdfDocument = await getDocument(data).promise;
        const numPages = pdfDocument.numPages;
        
        const uploadedUrls = [];
        const processedImagesPath = `processed-images/${bookId}/`;

        for (let i = 1; i <= numPages; i++) {
            const page = await pdfDocument.getPage(i);
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = createCanvas(viewport.width, viewport.height);
            const context = canvas.getContext('2d');
            
            await page.render({ canvasContext: context, viewport: viewport }).promise;

            const imageBuffer = canvas.toBuffer('image/jpeg');
            const imageFileName = `page-${i}.jpg`;
            const destination = `${processedImagesPath}${imageFileName}`;
            
            await bucket.file(destination).save(imageBuffer, { metadata: { contentType: 'image/jpeg' }});

            const [url] = await bucket.file(destination).getSignedUrl({ action: 'read', expires: '03-09-2491' });
            uploadedUrls.push(url);
            
            sendProgress(Math.round((i / numPages) * 100));
        }
        sendLog('All pages converted and uploaded.');

        sendLog(`Saving flipbook metadata to '${targetCollection}'...`);
        const thumbnailUrl = uploadedUrls.length > 0 ? uploadedUrls[0] : null;
        
        const bookData = {
            mainCategory: mainCategory,
            subcategory: subcategory,
            pdfName: file.originalname,
            pdfPathInStorage: pdfPathInStorage,
            imageFolderPath: processedImagesPath,
            pageImageUrls: uploadedUrls,
            thumbnailUrl: thumbnailUrl,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (uid) {
            bookData.uid = uid;
        }

        await db.collection(targetCollection).doc(bookId).set(bookData);
        sendLog('Metadata saved.');
        
        sendEvent({ type: 'done', message: 'Flipbook processed successfully!' });

    } catch (error) {
        console.error(`[Processing Error for jobId: ${jobId}]`, error);
        sendEvent({ type: 'error', message: error.message || 'An unknown server error occurred.' });
    } finally {
        delete processingJobs[jobId];
        console.log(`[${jobId}] Process finished. Cleaning up.`);
        res.end();
    }
});


// =========================================================================
// --- DELETE & APPROVAL ENDPOINTS ---
// =========================================================================

app.delete('/api/delete-flipbook', async (req, res) => {
    // ... same as before
    const { id: bookId } = req.body;
    if (!bookId) return res.status(400).json({ message: 'Flipbook ID is required.' });

    try {
        const docRef = db.collection('flipbooks').doc(bookId);
        const doc = await docRef.get();
        if (!doc.exists) return res.status(404).json({ message: 'Flipbook not found.' });
        
        const data = doc.data();
        if (data.imageFolderPath) await bucket.deleteFiles({ prefix: data.imageFolderPath });
        if (data.pdfPathInStorage) await bucket.file(data.pdfPathInStorage).delete().catch(() => {});
        
        await docRef.delete();
        res.status(200).json({ message: 'Public flipbook deleted successfully.' });
    } catch (error) {
        console.error(`[Delete Error for bookId: ${bookId}]`, error);
        res.status(500).json({ message: 'Server error while deleting flipbook.' });
    }
});

app.delete('/api/delete-team-flipbook', async (req, res) => {
    // ... same as before
    const { id: bookId } = req.body;
    if (!bookId) return res.status(400).json({ message: 'Flipbook ID is required.' });

    try {
        const docRef = db.collection('team-member').doc(bookId);
        const doc = await docRef.get();
        if (!doc.exists) return res.status(404).json({ message: 'Pending flipbook not found.' });

        const data = doc.data();
        if (data.imageFolderPath) await bucket.deleteFiles({ prefix: data.imageFolderPath });
        if (data.pdfPathInStorage) await bucket.file(data.pdfPathInStorage).delete().catch(() => {});

        await docRef.delete();
        res.status(200).json({ message: 'Pending flipbook deleted successfully.' });
    } catch (error) {
        console.error(`[Team Delete Error for bookId: ${bookId}]`, error);
        res.status(500).json({ message: 'Server error while deleting pending flipbook.' });
    }
});

app.post('/api/approve-flipbook', async (req, res) => {
    // ... same as before
    const { id: bookId } = req.body;
    if (!bookId) return res.status(400).json({ message: 'Flipbook ID is required.' });

    const teamDocRef = db.collection('team-member').doc(bookId);
    const publicDocRef = db.collection('flipbooks').doc(bookId);

    try {
        await db.runTransaction(async (transaction) => {
            const teamDoc = await transaction.get(teamDocRef);
            if (!teamDoc.exists) {
                throw new Error('Pending flipbook does not exist. It may have been deleted.');
            }
            
            const bookData = teamDoc.data();
            
            transaction.set(publicDocRef, bookData);
            transaction.delete(teamDocRef);
        });

        console.log(`[Approval] Book ${bookId} approved and moved to public collection.`);
        res.status(200).json({ message: 'Flipbook approved and published successfully!' });

    } catch (error) {
        console.error(`[Approval Error for bookId: ${bookId}]`, error);
        res.status(500).json({ message: error.message || 'Server error during approval process.' });
    }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
