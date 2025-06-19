// backend/server.js

const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs'); // Still needed for serviceAccountKey.json
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// --- PDF & Canvas Imports ---
const { getDocument } = require('pdfjs-dist/legacy/build/pdf.js');
const { createCanvas } = require('canvas');

// --- Firebase Initialization ---
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'ilets-b4b42.appspot.com' // Make sure this matches your bucket name
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

const app = express();

// =========================================================================
// --- DETAILED CORS CONFIGURATION ---
// =========================================================================
const allowedOrigins = [
  'https://anantainfotech.com', // Your production frontend
  'http://localhost:3000',      // Your local development frontend
  'http://localhost:3001'       // Add any other ports you use
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions)); // Use the detailed CORS options
app.use(express.json());

// In-memory store for processing jobs. In a production environment, this should be a more robust system like Redis.
const processingJobs = {};

// Multer setup for in-memory file storage
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // Optional: Set a file size limit (e.g., 50MB)
});


// =========================================================================
// --- REUSABLE UPLOAD & PROCESSING LOGIC ---
// =========================================================================
const createUploadJob = (req, res, targetCollection, uid = null) => {
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

        sendLog('Uploading original PDF to storage...');
        const pdfPathInStorage = `source-pdfs/${bookId}/${file.originalname}`;
        await bucket.file(pdfPathInStorage).save(file.buffer, { metadata: { contentType: file.mimetype }});
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
            await page.render({ canvasContext: context, viewport }).promise;
            const imageBuffer = canvas.toBuffer('image/jpeg');
            const imageFileName = `page-${i}.jpg`;
            const destination = `${processedImagesPath}${imageFileName}`;
            await bucket.file(destination).save(imageBuffer, { metadata: { contentType: 'image/jpeg' } });
            const [url] = await bucket.file(destination).getSignedUrl({ action: 'read', expires: '03-09-2491' });
            uploadedUrls.push(url);
            sendProgress(Math.round((i / numPages) * 100));
        }
        sendLog('All pages converted and uploaded.');

        sendLog(`Saving flipbook metadata to '${targetCollection}'...`);
        const thumbnailUrl = uploadedUrls.length > 0 ? uploadedUrls[0] : null;
        const bookData = {
            mainCategory: mainCategory, subcategory: subcategory, pdfName: file.originalname,
            pdfPathInStorage: pdfPathInStorage, imageFolderPath: processedImagesPath,
            pageImageUrls: uploadedUrls, thumbnailUrl: thumbnailUrl,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (uid) { bookData.uid = uid; }
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
// --- NEW: UPDATE ENDPOINT FOR TEAM PDFS ---
// This route is required for the "Update PDF" button in the frontend.
// =========================================================================
app.post('/api/update-team-pdf/:bookId', upload.single('pdfFile'), async (req, res) => {
    const { bookId } = req.params;
    const { uid } = req.body;
    const newFile = req.file;

    if (!bookId || !uid || !newFile) {
        return res.status(400).json({ message: 'Missing book ID, user ID, or new file for update.' });
    }

    console.log(`[Update] Starting update for bookId: ${bookId}`);
    try {
        const docRef = db.collection('team-member').doc(bookId);
        const doc = await docRef.get();
        if (!doc.exists) {
            return res.status(404).json({ message: 'Flipbook to update not found.' });
        }
        
        // Step 1: Delete old files from Firebase Storage
        const oldData = doc.data();
        console.log(`[Update] Deleting old files: ${oldData.imageFolderPath} and ${oldData.pdfPathInStorage}`);
        if (oldData.imageFolderPath) {
            await bucket.deleteFiles({ prefix: oldData.imageFolderPath });
        }
        if (oldData.pdfPathInStorage) {
            await bucket.file(oldData.pdfPathInStorage).delete().catch(err => console.error("Old PDF not found, continuing...", err.message));
        }

        // Step 2: Process and upload the NEW file
        console.log(`[Update] Processing new file: ${newFile.originalname}`);
        const pdfPathInStorage = `source-pdfs/${bookId}/${newFile.originalname}`;
        await bucket.file(pdfPathInStorage).save(newFile.buffer, { metadata: { contentType: newFile.mimetype } });

        const data = new Uint8Array(newFile.buffer);
        const pdfDocument = await getDocument(data).promise;
        const numPages = pdfDocument.numPages;
        const uploadedUrls = [];
        const processedImagesPath = `processed-images/${bookId}/`;

        for (let i = 1; i <= numPages; i++) {
            const page = await pdfDocument.getPage(i);
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = createCanvas(viewport.width, viewport.height);
            const context = canvas.getContext('2d');
            await page.render({ canvasContext: context, viewport }).promise;
            const imageBuffer = canvas.toBuffer('image/jpeg');
            const imageFileName = `page-${i}.jpg`;
            const destination = `${processedImagesPath}${imageFileName}`;
            await bucket.file(destination).save(imageBuffer, { metadata: { contentType: 'image/jpeg' } });
            const [url] = await bucket.file(destination).getSignedUrl({ action: 'read', expires: '03-09-2491' });
            uploadedUrls.push(url);
        }
        
        // Step 3: Update the Firestore document with new metadata
        const thumbnailUrl = uploadedUrls.length > 0 ? uploadedUrls[0] : null;
        const bookUpdateData = {
            pdfName: newFile.originalname,
            pdfPathInStorage: pdfPathInStorage,
            imageFolderPath: processedImagesPath,
            pageImageUrls: uploadedUrls,
            thumbnailUrl: thumbnailUrl,
            timestamp: admin.firestore.FieldValue.serverTimestamp(), // Update the timestamp
        };

        await docRef.update(bookUpdateData);
        console.log(`[Update] Successfully updated bookId: ${bookId}`);
        res.status(200).json({ message: 'Flipbook updated successfully!' });
    } catch (error) {
        console.error(`[Update Error for bookId: ${bookId}]`, error);
        res.status(500).json({ message: 'Server error during update process.' });
    }
});


// =========================================================================
// --- DELETE & APPROVAL ENDPOINTS ---
// =========================================================================
app.delete('/api/delete-flipbook', async (req, res) => {
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

// This is the route your frontend is now correctly calling.
app.delete('/api/delete-team-flipbook', async (req, res) => {
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
