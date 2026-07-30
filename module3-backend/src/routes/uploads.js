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
const path = require('path');
const { randomUUID } = require('crypto');
const { UPLOAD_DIR } = require('../config');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB - generous for a scanned assignment/notes PDF
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are accepted'));
    }
    cb(null, true);
  },
});

// POST /api/uploads
// multipart/form-data, field name: "file"
// -> { fileUrl: string }
router.post('/', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (expected field name "file")' });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    return res.status(201).json({ fileUrl });
  });
});

module.exports = router;
