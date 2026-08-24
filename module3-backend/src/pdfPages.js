// src/pdfPages.js
//
// The `pages` value used to calculate amount_due used to come straight
// from the client with nothing checking it against the actual file - a
// request could claim a 50-page document was 1 page and be charged
// accordingly. Every upload (a real PDF, or a docx/photo already converted
// to PDF client-side before it reaches /api/uploads) is a real PDF file on
// disk by the time a job/batch gets created, so the true page count can be
// read directly rather than trusted from the request body. Pure JS
// (pdf-lib) - no LibreOffice/native binary dependency, so this works on
// Render's default runtime unlike routes/convert.js's docx conversion.
const path = require('path');
const fs = require('fs/promises');
const { PDFDocument } = require('pdf-lib');
const { UPLOAD_DIR } = require('./config');

// Reads the real page count of an already-uploaded PDF. `fileUrl` must
// already be validated by isValidUploadedFileUrl (see uploadUrl.js) before
// this is called - this trusts the caller on that, but still resolves via
// path.basename so nothing here could escape UPLOAD_DIR even if that
// changed. Returns null (not a thrown error) if the file is missing or
// isn't a well-formed PDF (e.g. someone submits an already-uploaded image
// url for the payment-screenshot flow, or a raw docx that was never run
// through conversion) - callers decide what to do with "unknown".
async function getRealPageCount(fileUrl) {
  try {
    const filename = path.basename(fileUrl);
    const filePath = path.join(UPLOAD_DIR, filename);
    const bytes = await fs.readFile(filePath);
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    return pdf.getPageCount();
  } catch (err) {
    return null;
  }
}

module.exports = { getRealPageCount };
