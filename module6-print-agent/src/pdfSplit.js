// src/pdfSplit.js
//
// Handles "mixed" color-mode jobs (some pages color, some b&w). No generic
// PRINT_COMMAND can express "pages 3,7,9 in color, the rest b&w" as one
// print job (see the old comment this replaces in index.js's
// jobPrintPlaceholders). The workaround: cut the job's PDF into contiguous
// same-color runs and print each run as its own small, single-color print
// job, in original page order, back to back - so the physical output comes
// out of the tray already collated correctly, no manual reassembly by the
// shop owner. This avoids the naive alternative (all color pages in one
// stack, all b&w in another) which comes out in the wrong physical order.
const { PDFDocument } = require('pdf-lib');

// Mirrors module3-backend/src/pricing.js parseColorPages. Kept as its own
// small copy rather than a shared package - these run in different
// processes (this is the agent, that's the API), and by the time a job
// reaches here colorPages has already been validated at submit time in
// routes/shops.js, so this copy can stay lenient/best-effort rather than
// re-validating.
function parseColorPages(input, maxPages) {
  const pageSet = new Set();
  const trimmed = (input || '').trim();
  if (!trimmed) return pageSet;
  for (const part of trimmed.split(',').map((p) => p.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      for (let i = start; i <= end && i <= maxPages; i++) pageSet.add(i);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n <= maxPages) pageSet.add(n);
    }
    // Anything else is silently skipped - malformed strings shouldn't have
    // gotten this far, and failing loudly here would just block an
    // otherwise-fine print job over a cosmetic issue in one field.
  }
  return pageSet;
}

// Walks pages 1..totalPages in order and groups consecutive pages that
// share the same color/b&w-ness into runs, e.g. colorPages "2,3,7" over 8
// pages ->
//   [{color:false,pages:[1]}, {color:true,pages:[2,3]}, {color:false,pages:[4,5,6]},
//    {color:true,pages:[7]}, {color:false,pages:[8]}]
function buildSegments(colorPages, totalPages) {
  const colorSet = parseColorPages(colorPages, totalPages);
  const segments = [];
  for (let page = 1; page <= totalPages; page++) {
    const isColor = colorSet.has(page);
    const last = segments[segments.length - 1];
    if (last && last.color === isColor) {
      last.pages.push(page);
    } else {
      segments.push({ color: isColor, pages: [page] });
    }
  }
  return segments;
}

// Given the full job PDF's bytes, returns the same segments with each
// one's own extracted PDF bytes attached, ready to be written to a temp
// file and printed one at a time. copyPages needs 0-indexed page numbers;
// job page numbers (and colorPages) are 1-indexed throughout the rest of
// the app.
async function splitIntoColorSegments(pdfBytes, colorPages, totalPages) {
  const segments = buildSegments(colorPages, totalPages);
  const srcDoc = await PDFDocument.load(pdfBytes);
  const results = [];
  for (const segment of segments) {
    const outDoc = await PDFDocument.create();
    const copiedPages = await outDoc.copyPages(srcDoc, segment.pages.map((p) => p - 1));
    copiedPages.forEach((p) => outDoc.addPage(p));
    results.push({ ...segment, bytes: await outDoc.save() });
  }
  return results;
}

module.exports = { parseColorPages, buildSegments, splitIntoColorSegments };
