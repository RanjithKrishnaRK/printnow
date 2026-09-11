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
 * Volume/range pricing: given the TOTAL number of pages that will actually
 * be printed across every copy (pages x copies for one document), finds
 * the shop-defined range it falls into, if any. Ranges are inclusive on
 * both ends and shouldn't overlap (enforced at write time - see
 * routes/priceRanges.js) - if totalPages doesn't fall inside any
 * configured range (below the lowest, above the highest, or the shop
 * hasn't set any ranges at all), returns null, and the caller falls back
 * to normal per-page pricing.
 */
function pickPriceRange(totalPages, priceRanges) {
  if (!Array.isArray(priceRanges) || priceRanges.length === 0) return null;
  return priceRanges.find((r) => totalPages >= r.minPages && totalPages <= r.maxPages) || null;
}

/**
 * Flat per-page rate x pages x copies for single-sided "bw"/"color". For
 * "mixed", the pages listed in colorPages are billed at the color rate and
 * every other page at the bw rate. colorMode is already validated by the
 * route; when colorMode is "mixed", colorPages must already be a validated
 * page string.
 *
 * Double-sided ("sides: 'double'") bills per SHEET of paper, not per page -
 * two pages share one physical sheet (front/back), so a 6-page double-sided
 * document only uses 3 sheets and should cost 3 x the double rate, not 6x.
 * An odd page count leaves one final page that can't be paired with
 * anything - it's printed (and billed) single-sided, at the ordinary
 * single-sided rate, since that sheet only actually uses one side.
 * For "mixed" + double-sided, pages pair up sequentially into sheets
 * (1&2, 3&4, ...); a sheet counts as a color sheet if EITHER side on it is
 * a color page - there's no half-color-sheet rate on the machines these
 * shops use, so any color content makes the whole sheet a color sheet. A
 * leftover final page (odd total) is billed single-sided at its own page's
 * actual color rate.
 *
 * Volume/range pricing (`priceRanges`, single-sided only - see
 * pickPriceRange above and routes/priceRanges.js): a shop can define
 * pricing tiers by TOTAL printable pages across all copies of a document
 * (pages x copies), each with its own flat per-page bw/color rate that
 * REPLACES the shop's normal per-page rate entirely for jobs whose total
 * falls in that range - e.g. 2 copies of a 5-page document (10 total
 * pages) might land in a "10-19 pages" tier priced at a lower per-page
 * rate than a single 5-page copy would get. This only applies to
 * single-sided jobs; a double-sided job always uses the double-sided sheet
 * pricing above, untouched, regardless of any configured ranges - combining
 * both tiered systems at once wasn't asked for and adds a lot of
 * complexity for a combination that may never come up. If the job's total
 * printable pages don't fall inside any configured range (including when
 * the shop has no ranges configured at all), pricing falls straight back
 * to the shop's normal per-page rate, same as before this feature existed.
 *
 * `rates` is the shop's own per-page pricing (see shops.price_bw /
 * price_color / price_bw_double / price_color_double, editable anytime
 * from the shop's Settings page): { bw, color, bwDouble, colorDouble }.
 * bwDouble/colorDouble are optional - callers resolve "shop hasn't set a
 * double-sided rate" down to the single-sided rate via COALESCE in SQL
 * before calling this (see routes/shops.js), so by the time `rates`
 * reaches here it always has real numbers for whichever sides value was
 * requested; the `!= null` fallback below only matters for a caller that
 * skips `rates` entirely (see the PRICING fallback note).
 *
 * Falls back to the platform-wide PRICING constant only if a caller
 * doesn't pass rates at all, so older call sites keep working - PRICING
 * has no double-sided variant, so `sides` is ignored in that fallback path
 * (single-sided rate used regardless).
 *
 * `sides` defaults to "single" so every existing caller that doesn't pass
 * it (there were none before double-sided pricing existed) keeps billing
 * exactly as before.
 */
function calculateAmountDue({ pages, copies, colorMode, colorPages, rates, sides = 'single', priceRanges }) {
  const effectiveRates = rates || PRICING;
  const double = sides === 'double';
  const bwSingle = effectiveRates.bw;
  const colorSingle = effectiveRates.color;
  const bwDouble = effectiveRates.bwDouble != null ? effectiveRates.bwDouble : effectiveRates.bw;
  const colorDouble = effectiveRates.colorDouble != null ? effectiveRates.colorDouble : effectiveRates.color;

  // Volume pricing only applies single-sided - see the big comment above.
  // Computed once up front so both the mixed and non-mixed paths below can
  // use it without duplicating the "which range, if any" lookup.
  const matchedRange = !double ? pickPriceRange(pages * copies, priceRanges) : null;

  if (colorMode === 'mixed') {
    const { pageSet } = parseColorPages(colorPages, pages); // 1-indexed color page numbers
    const colorPageCount = pageSet.size;
    const bwPageCount = Math.max(0, pages - colorPageCount);

    if (matchedRange) {
      // Total printable pages already includes copies, so the split below
      // does too - no separate "* copies" at the end here.
      return colorPageCount * copies * matchedRange.priceColor + bwPageCount * copies * matchedRange.priceBw;
    }

    if (!double) {
      return (colorPageCount * colorSingle + bwPageCount * bwSingle) * copies;
    }

    const fullSheets = Math.floor(pages / 2);
    let total = 0;
    for (let sheet = 0; sheet < fullSheets; sheet++) {
      const firstPage = sheet * 2 + 1;
      const secondPage = sheet * 2 + 2;
      const sheetIsColor = pageSet.has(firstPage) || pageSet.has(secondPage);
      total += sheetIsColor ? colorDouble : bwDouble;
    }
    if (pages % 2 === 1) {
      total += pageSet.has(pages) ? colorSingle : bwSingle;
    }
    return total * copies;
  }

  if (matchedRange) {
    const rangeRate = colorMode === 'color' ? matchedRange.priceColor : matchedRange.priceBw;
    return rangeRate * pages * copies;
  }

  if (!double) {
    return (colorMode === 'color' ? colorSingle : bwSingle) * pages * copies;
  }

  const doubleRate = colorMode === 'color' ? colorDouble : bwDouble;
  const singleRate = colorMode === 'color' ? colorSingle : bwSingle;
  const fullSheets = Math.floor(pages / 2);
  const hasOddPage = pages % 2 === 1;
  return (fullSheets * doubleRate + (hasOddPage ? singleRate : 0)) * copies;
}

module.exports = { calculateAmountDue, parseColorPages, pickPriceRange };
// parseColorPages is a general "1-3,5,8-10" range parser with nothing
// color-specific about it - the same function also validates which pages
// a student wants printed at all (see routes/shops.js's pageSelection
// handling). Exported under both names so each call site reads clearly.
module.exports.parsePageRange = parseColorPages;
