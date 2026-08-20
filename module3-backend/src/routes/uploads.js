// src/routes/uploads.js
//
// Simplest possible option for MVP: local disk storage, served statically.
// fileUrl returned is a relative-to-host path like "/uploads/<generated-name>.pdf"
// that Module 1/2 can use directly as the fileUrl field elsewhere in the
// contract. Swap the `storage` engine below for an S3-compatible bucket
// later without touching any other route - this file is the only place
// that would need to change.

const express = require('express');
const multer = require('multer');
const { randomUUID } = require('crypto');
const { UPLOAD_DIR } = require('../config');

const router = express.Router();

// Extensions are derived ONLY from the mimetype we've already validated in
// fileFilter below - never from file.originalname. originalname is
// attacker-controlled (multer just copies whatever filename the client
// sends), and mimetype itself is also client-supplied but at least gets
// checked against a whitelist first. Taking the extension from
// originalname directly used to mean an attacker could upload a file
// claiming to be a PDF by mimetype while actually naming it "x.html" -
// stored and served back with a ".html" name, letting a browser render it
// as HTML on this domain (stored XSS via file upload, with access to
// whatever's in this origin's cookies/localStorage). Whitelisting the
// extension by verified mimetype closes that off entirely: whatever the
// client calls the file, it's saved as <uuid>.pdf or <uuid>.jpg/.png, full stop.
const PDF_EXT = '.pdf';
const IMAGE_EXT_BY_MIMETYPE = { 'image/jpeg': '.jpg', 'image/png': '.png' };
const MAX_PDF_BYTES = 50 * 1024 * 1024; // 50MB - a scanned/compiled assignment PDF from a PC can run
// well past the old 20MB cap; this is comfortably above what a typical
// multi-page scan produces.

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${randomUUID()}${PDF_EXT}`),
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_PDF_BYTES },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are accepted'));
    }
    cb(null, true);
  },
});

// Rejects an oversized upload from its Content-Length header, before
// multer/busboy ever starts reading the request body. Without this, a
// file that exceeds multer's own limit gets caught mid-stream instead -
// busboy stops consuming the body once the limit is hit, but the browser
// is often still mid-upload sending the rest of a large file, and the
// resulting broken connection surfaces to the client as a raw "Failed to
// fetch" network error rather than the clean 400 JSON response the route
// normally sends. Checking Content-Length up front means an oversized
// file gets a fast, readable error instead - for the common case of a
// single file with a known size (which fetch() + FormData always sends).
function rejectIfTooLarge(maxBytes) {
  return (req, res, next) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return res.status(413).json({
        error: `That file is too large (max ${Math.round(maxBytes / (1024 * 1024))}MB).`,
      });
    }
    next();
  };
}

// POST /api/uploads
// multipart/form-data, field name: "file"
// -> { fileUrl: string }
router.post('/', rejectIfTooLarge(MAX_PDF_BYTES), (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (expected field name "file")' });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    return res.status(201).json({ fileUrl });
  });
});

// Separate multer instance for payment screenshots - photos of a UPI app's
// "payment successful" screen, so this accepts images (not PDFs) and caps
// size much lower since it's a phone screenshot, not a scanned document.
const screenshotStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) =>
    cb(null, `${randomUUID()}${IMAGE_EXT_BY_MIMETYPE[file.mimetype] || '.jpg'}`),
});
const uploadScreenshot = multer({
  storage: screenshotStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB - plenty for a phone screenshot
  fileFilter: (req, file, cb) => {
    if (!IMAGE_EXT_BY_MIMETYPE[file.mimetype]) {
      return cb(new Error('Only JPEG or PNG screenshots are accepted'));
    }
    cb(null, true);
  },
});

// POST /api/uploads/payment-screenshot
// multipart/form-data, field name: "file"
// -> { screenshotUrl: string }
// Used by POST /api/jobs/:jobId/submit-payment and
// POST /api/batches/:batchId/submit-payment's { method: "upi", screenshotUrl }.
router.post('/payment-screenshot', (req, res) => {
  uploadScreenshot.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (expected field name "file")' });
    }

    const screenshotUrl = `/uploads/${req.file.filename}`;
    return res.status(201).json({ screenshotUrl });
  });
});

module.exports = router;
