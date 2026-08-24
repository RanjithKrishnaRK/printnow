// src/uploadUrl.js
//
// Validates that a client-supplied file URL actually points to something
// this platform's own upload endpoints (routes/uploads.js) created, not an
// arbitrary external address. Before this existed, fileUrl/screenshotUrl
// fields on job/batch creation and payment submission were accepted as any
// string. The most serious consequence: the print agent (module6, running
// on a shop owner's own PC, on their own local network) fetches
// job.fileUrl directly and treats an absolute http(s) URL as-is - so a
// crafted request could have pointed a "print job" at an arbitrary
// internal or external address, a genuine SSRF reaching into a shop
// owner's local network, not just this server. Every upload this platform
// creates has a predictable shape (randomUUID() + a fixed extension - see
// uploads.js), so anything that doesn't match that exact shape is rejected.
const UPLOADED_FILE_URL_REGEX =
  /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$/i;

function isValidUploadedFileUrl(url) {
  return typeof url === 'string' && UPLOADED_FILE_URL_REGEX.test(url);
}

module.exports = { isValidUploadedFileUrl };
