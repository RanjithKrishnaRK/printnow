// src/pricing.js
const { PRICING } = require('./config');

/**
 * Parses a page-range string like "1-3,5,8-10" into a Set of page numbers,
 * validating every entry falls within 1..maxPages. Mirrors the parser used
 * client-side in Module 1's UploadStep so both sides agree on what's valid.
 * Returns { pageSet, error } - error is null when the string is valid.
 */
function parseColorPages(input, maxPages) {
  const trimmed = (input || '').trim();
  if (!trimmed) return { pageSet: new Set(), error: 'colorPages is required when colorMode is "mixed"' };

  const pageSet = new Set();
  const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < 1 || end > maxPages || start > end) {
        return { pageSet: new Set(), error: `"${part}" is outside 1-${maxPages}` };
      }
      for (let i = start; i <= end; i++) pageSet.add(i);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n < 1 || n > maxPages) {
        return { pageSet: new Set(), error: `Page ${n} is outside 1-${maxPages}` };
      }
      pageSet.add(n);
    } else {
      return { pageSet: new Set(), error: `Could not parse "${part}"` };
    }
  }

  return { pageSet, error: null };
}

/**
 * Flat per-page rate x pages x copies for "bw"/"color". For "mixed", the
 * pages listed in colorPages are billed at the color rate and every other
 * page at the bw rate. colorMode is already validated by the route; when
 * colorMode is "mixed", colorPages must already be a validated page string.
 *
 * `rates` is the shop's own { bw, color } per-page pricing (see
 * shops.price_bw / shops.price_color, editable anytime from the shop's
 * Settings page). Falls back to the platform-wide PRICING constant only if
 * a caller doesn't pass rates at all, so older call sites keep working.
 */
function calculateAmountDue({ pages, copies, colorMode, colorPages, rates }) {
  const effectiveRates = rates || PRICING;
  if (colorMode === 'mixed') {
    const { pageSet } = parseColorPages(colorPages, pages);
    const colorPageCount = pageSet.size;
    const bwPageCount = Math.max(0, pages - colorPageCount);
    return (colorPageCount * effectiveRates.color + bwPageCount * effectiveRates.bw) * copies;
  }
  const rate = effectiveRates[colorMode];
  return rate * pages * copies;
}

module.exports = { calculateAmountDue, parseColorPages };
