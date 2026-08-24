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
const { randomUUID } = require('crypto');
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

// Builds a brand-new PDF containing only the given 1-indexed page numbers,
// in ascending order, and saves it as a fresh upload under a new random
// filename - this is what actually powers "print only pages 1-3": the shop
// dashboard and print agent only ever fetch this extracted file, never the
// student's full original document, so there's no way for a shop to
// print (or even see) pages the student didn't select and pay for.
// `pageNumbers` must already be validated against the source's real page
// count by the caller (see pricing.js's page-range parser). Returns
// { fileUrl, pageCount } in the same shape routes/uploads.js's own
// response uses, so callers can treat it identically to a fresh upload.
async function extractPdfPages(fileUrl, pageNumbers) {
  const filename = path.basename(fileUrl);
  const filePath = path.join(UPLOAD_DIR, filename);
  const bytes = await fs.readFile(filePath);
  const sourceDoc = await PDFDocument.load(bytes, { updateMetadata: false });

  const sortedIndices = [...new Set(pageNumbers)].sort((a, b) => a - b).map((n) => n - 1);
  const newDoc = await PDFDocument.create();
  const copiedPages = await newDoc.copyPages(sourceDoc, sortedIndices);
  for (const page of copiedPages) newDoc.addPage(page);
  const newBytes = await newDoc.save();

  const newFilename = `${randomUUID()}.pdf`;
  await fs.writeFile(path.join(UPLOAD_DIR, newFilename), newBytes);

  return { fileUrl: `/uploads/${newFilename}`, pageCount: sortedIndices.length };
}

// Best-effort delete of an uploaded file - used to clean up a student's
// full original document once its extracted subset has replaced it as the
// job's actual file_url, so a rejected/unused full upload doesn't sit on
// disk indefinitely. Failure here is deliberately swallowed (logged, not
// thrown) - losing the ability to delete an old temp file is never a
// reason to fail the order itself.
async function deleteUploadedFile(fileUrl) {
  try {
    const filename = path.basename(fileUrl);
    await fs.unlink(path.join(UPLOAD_DIR, filename));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Could not clean up uploaded file ${fileUrl}:`, err.message);
  }
}

module.exports = { getRealPageCount, extractPdfPages, deleteUploadedFile };
