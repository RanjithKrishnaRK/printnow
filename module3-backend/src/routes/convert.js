// src/routes/convert.js
//
// Standalone "convert your Word doc to PDF" tool - deliberately NOT part
// of the order pipeline (uploads.js/jobs.js). If LibreOffice ever hangs,
// crashes, or times out, only this one feature degrades - job creation,
// the print agent, and everything else keep working exactly as before.
// This isolation is the whole point of building it this way rather than
// bolting docx support directly onto the existing upload flow.
//
// Requires the `soffice` binary (LibreOffice headless) to be present on
// PATH - see the project's Dockerfile. This will NOT work on Render's
// default native Node runtime; the service needs to be switched to a
// Docker-based deploy first.

const express = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // same cap as the main PDF upload
  fileFilter: (req, file, cb) => {
    const okMime =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const okExt = path.extname(file.originalname).toLowerCase() === '.docx';
    if (!okMime && !okExt) return cb(new Error('Only .docx files are accepted'));
    cb(null, true);
  },
});

// LibreOffice needs its own scratch profile dir per run (sharing one
// across concurrent conversions causes lock-file contention/corruption -
// a known LibreOffice headless gotcha, not a bug in this code), so every
// request gets a fresh temp working directory that's fully cleaned up
// afterwards regardless of success or failure.
async function convertDocxToPdf(docxBuffer) {
  const workDir = path.join(os.tmpdir(), `docx2pdf-${randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });
  const inputPath = path.join(workDir, 'input.docx');
  await fs.writeFile(inputPath, docxBuffer);

  try {
    await new Promise((resolve, reject) => {
      // A 30s timeout keeps one stuck conversion from tying up the
      // container indefinitely - LibreOffice headless can occasionally
      // hang on malformed files. A genuine multi-page assignment doc
      // normally converts in a few seconds.
      const child = execFile(
        'soffice',
        [
          '--headless',
          '--norestore',
          `-env:UserInstallation=file://${workDir}/profile`,
          '--convert-to',
          'pdf',
          '--outdir',
          workDir,
          inputPath,
        ],
        { timeout: 30_000 },
        (err) => (err ? reject(err) : resolve())
      );
      child.on('error', reject);
    });

    const outputPath = path.join(workDir, 'input.pdf');
    const pdfBuffer = await fs.readFile(outputPath);
    return pdfBuffer;
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// POST /api/convert/docx-to-pdf
// multipart/form-data, field name: "file"
// -> raw PDF bytes (Content-Type: application/pdf), NOT a fileUrl - this
// intentionally doesn't touch the uploads table/disk storage. The
// frontend hands the returned bytes straight back into the existing "pick
// a file" step as a normal in-memory File, so from that point on it's
// indistinguishable from a student picking a PDF directly.
router.post('/docx-to-pdf', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected field name "file")' });

    try {
      const pdfBuffer = await convertDocxToPdf(req.file.buffer);
      res.setHeader('Content-Type', 'application/pdf');
      res.status(200).send(pdfBuffer);
    } catch (err) {
      console.error('docx-to-pdf conversion failed:', err);
      res.status(502).json({
        error: 'Could not convert that document. It may be corrupted, password-protected, or an unsupported .docx variant.',
      });
    }
  });
});

module.exports = router;
