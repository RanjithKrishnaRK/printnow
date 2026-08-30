// src/routes/shops.js
const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../db');
const {
  hashPassword,
  comparePassword,
  signShopToken,
  requireShopAuth,
  requireOwnShop,
} = require('../auth');
const { calculateAmountDue, parseColorPages, parsePageRange } = require('../pricing');
const { PRICING } = require('../config');
const { resolveStudentName, StudentNameRequiredError } = require('../studentName');
const { loginRateLimiter } = require('../rateLimit');
const {
  CONFIRMED_STATUS_SQL,
  getShopMethodTotals,
  listSettlements,
  getSettledTotal,
  getCommissionOwed,
  listCommissionPayments,
} = require('../earnings');
const { isValidUploadedFileUrl } = require('../uploadUrl');
const { getRealPageCount, extractPdfPages, deleteUploadedFile } = require('../pdfPages');
const { createVendor } = require('../cashfree');

const router = express.Router();

const VALID_COLOR_MODES = ['bw', 'color', 'mixed'];
const VALID_SIDES = ['single', 'double'];

// GET /api/shops?landmarkId=lm_xxx
// Public. Powers Module 1's home page ("shops near this landmark").
// -> [{ shopId, name, landmarkId }]
router.get('/', async (req, res, next) => {
  try {
    const { landmarkId } = req.query;

    if (!landmarkId) {
      return res.status(400).json({ error: 'landmarkId query param is required' });
    }

    const { rows } = await pool.query(
      `SELECT s.id AS "shopId", s.name, s.landmark_id AS "landmarkId",
              COALESCE(ROUND(AVG(r.rating)::numeric, 1), 0)::float AS "avgRating",
              COUNT(r.id)::int AS "reviewCount"
       FROM shops s
       LEFT JOIN reviews r ON r.shop_id = s.id AND r.visible = TRUE
       WHERE s.landmark_id = $1
       GROUP BY s.id
       ORDER BY s.name ASC`,
      [landmarkId]
    );

    return res.status(200).json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/shops/signup
// Public - self-service shop owner registration (previously only possible
// via scripts/seedShop.js run by hand).
// body: { name, email, password, landmarkId } -> { shopId, token, shopName }
router.post('/signup', async (req, res, next) => {
  try {
    const { name, email, password, landmarkId } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'email is required' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'password is required and must be at least 8 characters' });
    }
    if (!landmarkId || typeof landmarkId !== 'string') {
      return res.status(400).json({ error: 'landmarkId is required' });
    }

    const { rows: landmarkRows } = await pool.query('SELECT id FROM landmarks WHERE id = $1', [
      landmarkId,
    ]);
    if (landmarkRows.length === 0) {
      return res.status(400).json({ error: 'Unknown landmarkId' });
    }

    const trimmedName = name.trim();
    const normalizedEmail = email.trim().toLowerCase();

    // Case-insensitive checks: "Ravi@x.in" and "ravi@x.in" (or "Sharma
    // Xerox" and "sharma xerox") are the same for our purposes.
    const { rows: existingEmailRows } = await pool.query(
      'SELECT id FROM shops WHERE LOWER(email) = LOWER($1)',
      [normalizedEmail]
    );
    if (existingEmailRows.length > 0) {
      return res.status(409).json({ error: 'A shop with this email already exists' });
    }

    const { rows: existingNameRows } = await pool.query(
      'SELECT id FROM shops WHERE LOWER(name) = LOWER($1)',
      [trimmedName]
    );
    if (existingNameRows.length > 0) {
      return res
        .status(409)
        .json({ error: 'A shop with this name already exists. Try a more specific name (e.g. add your area or landmark).' });
    }

    const id = randomUUID();
    const passwordHash = await hashPassword(password);

    try {
      await pool.query(
        `INSERT INTO shops (id, name, email, password_hash, landmark_id, price_bw, price_color, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [id, trimmedName, normalizedEmail, passwordHash, landmarkId, PRICING.bw, PRICING.color]
      );
    } catch (err) {
      // Race-condition fallback: two signups for the same email/name landing
      // between our SELECT check above and this INSERT. The DB-level unique
      // indexes (see db.js migrate()) catch it here as Postgres error 23505.
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A shop with this name or email already exists' });
      }
      throw err;
    }

    const token = signShopToken({ id });
    return res.status(201).json({ shopId: id, token, shopName: trimmedName });
  } catch (err) {
    next(err);
  }
});

// POST /api/shops/:shopId/jobs
// Public (student-facing, pre-auth). body: { fileUrl, pages, copies, colorMode, studentPhone }
// -> { jobId, amountDue, status: "uploaded" }
router.post('/:shopId/jobs', async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { copies, colorMode, studentPhone, sides, colorPages, fileName, studentName, pageSelection } =
      req.body || {};
    let { pages, fileUrl } = req.body || {};

    const { rows: shopRows } = await pool.query(
      'SELECT id, price_bw AS "priceBw", price_color AS "priceColor" FROM shops WHERE id = $1',
      [shopId]
    );
    if (shopRows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const shop = shopRows[0];

    if (!fileUrl || typeof fileUrl !== 'string') {
      return res.status(400).json({ error: 'fileUrl is required' });
    }
    if (!isValidUploadedFileUrl(fileUrl)) {
      return res.status(400).json({ error: 'fileUrl must reference a file uploaded through this platform' });
    }
    if (!Number.isInteger(pages) || pages < 1) {
      return res.status(400).json({ error: 'pages must be a positive integer' });
    }

    // Pricing is computed from the ACTUAL file, never the client's claimed
    // `pages` - without this, a request could claim a 50-page document was
    // 1 page and be charged accordingly. Every upload is a real PDF on
    // disk by this point (images/docx are converted client-side before
    // reaching /api/uploads), so this should always succeed for a
    // genuinely-uploaded file; a null result means the file is missing or
    // not a well-formed PDF, which is itself worth rejecting rather than
    // falling back to trusting the client number.
    const realPages = await getRealPageCount(fileUrl);
    if (realPages === null) {
      return res.status(400).json({ error: 'Could not verify the uploaded file. Please upload it again.' });
    }
    pages = realPages;

    // pageSelection lets a student print only some pages of a larger
    // document ("just pages 1-3") instead of the whole thing - optional,
    // same "1-3,5,8-10" syntax as colorPages. When present, this is where
    // the actual page count and fileUrl the rest of the order is built
    // from get replaced: a brand-new PDF containing only the selected
    // pages is generated server-side, and every downstream step (pricing,
    // the file the shop dashboard/print agent ever fetches, colorPages
    // numbering) works from that extracted subset - never the full
    // original document. This is what makes "shop only ever receives the
    // paid-for pages" actually true rather than just a client-side promise.
    if (pageSelection) {
      const { pageSet, error: selectionError } = parsePageRange(pageSelection, pages);
      if (selectionError) {
        return res.status(400).json({ error: `pageSelection: ${selectionError}` });
      }
      const selectedPages = Array.from(pageSet).sort((a, b) => a - b);
      const extracted = await extractPdfPages(fileUrl, selectedPages);
      // Best-effort - the original full upload is no longer referenced by
      // anything once the extracted subset takes its place, but a failed
      // cleanup here should never block the order itself.
      deleteUploadedFile(fileUrl).catch(() => {});
      fileUrl = extracted.fileUrl;
      pages = extracted.pageCount;
    }

    if (!Number.isInteger(copies) || copies < 1) {
      return res.status(400).json({ error: 'copies must be a positive integer' });
    }
    if (!VALID_COLOR_MODES.includes(colorMode)) {
      return res.status(400).json({ error: 'colorMode must be "bw", "color", or "mixed"' });
    }
    if (!studentPhone || typeof studentPhone !== 'string') {
      return res.status(400).json({ error: 'studentPhone is required' });
    }

    // sides is optional - Module 2/older clients that don't send it default to "single".
    const sidesValue = sides === undefined ? 'single' : sides;
    if (!VALID_SIDES.includes(sidesValue)) {
      return res.status(400).json({ error: 'sides must be "single" or "double"' });
    }

    // colorPages is only required (and only validated) when colorMode is "mixed".
    let colorPagesValue = null;
    if (colorMode === 'mixed') {
      const { error: rangeError } = parseColorPages(colorPages, pages);
      if (rangeError) {
        return res.status(400).json({ error: `colorPages: ${rangeError}` });
      }
      colorPagesValue = colorPages.trim();
    }

    const amountDue = calculateAmountDue({
      pages,
      copies,
      colorMode,
      colorPages: colorPagesValue,
      rates: { bw: shop.priceBw, color: shop.priceColor },
    });

    let resolvedName;
    try {
      resolvedName = await resolveStudentName(studentPhone, studentName);
    } catch (err) {
      if (err instanceof StudentNameRequiredError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    const jobId = randomUUID();
    const fileNameValue = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : null;

    await pool.query(
      `INSERT INTO print_jobs
         (id, shop_id, file_url, file_name, pages, copies, color_mode, color_pages, sides,
          student_phone, student_name, status, token_number, amount_due, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'uploaded', NULL, $12, NOW(), NOW())`,
      [jobId, shopId, fileUrl, fileNameValue, pages, copies, colorMode, colorPagesValue, sidesValue, studentPhone, resolvedName, amountDue]
    );

    return res.status(201).json({ jobId, amountDue, status: 'uploaded' });
  } catch (err) {
    next(err);
  }
});

// POST /api/shops/:shopId/batches
// Public (student-facing, pre-auth). One combined order for multiple
// documents uploaded together, each with its own print settings.
// body: { studentPhone, documents: [{ fileUrl, fileName, pages, copies,
//         colorMode, colorPages, sides }, ...] }
// -> { batchId, amountDue, status: "uploaded",
//      documents: [{ jobId, fileName, amountDue }] }
// Each document becomes its own print_jobs row (batch_id set), so the shop
// dashboard's existing per-job rendering keeps working unchanged - only the
// grouping/payment is new. amount_due on the batch is the sum of every
// document's own amount_due, computed the exact same way single-doc jobs
// already are (per-shop price_bw/price_color, mixed-mode page splitting).
router.post('/:shopId/batches', async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { studentPhone, studentName, documents } = req.body || {};

    const { rows: shopRows } = await pool.query(
      'SELECT id, price_bw AS "priceBw", price_color AS "priceColor" FROM shops WHERE id = $1',
      [shopId]
    );
    if (shopRows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const shop = shopRows[0];

    if (!studentPhone || typeof studentPhone !== 'string') {
      return res.status(400).json({ error: 'studentPhone is required' });
    }
    if (!Array.isArray(documents) || documents.length === 0) {
      return res.status(400).json({ error: 'documents must be a non-empty array' });
    }
    if (documents.length === 1) {
      return res.status(400).json({
        error: 'documents has only one file - use POST /:shopId/jobs for a single document',
      });
    }

    // Validate every document up front (same rules as the single-job route)
    // before inserting anything, so a bad 4th document doesn't leave 3
    // half-created jobs behind.
    const prepared = [];
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i] || {};
      const { copies, colorMode, sides, colorPages, fileName, pageSelection } = doc;
      let { pages, fileUrl } = doc;
      const label = `documents[${i}]`;

      if (!fileUrl || typeof fileUrl !== 'string') {
        return res.status(400).json({ error: `${label}.fileUrl is required` });
      }
      if (!isValidUploadedFileUrl(fileUrl)) {
        return res.status(400).json({ error: `${label}.fileUrl must reference a file uploaded through this platform` });
      }
      if (!Number.isInteger(pages) || pages < 1) {
        return res.status(400).json({ error: `${label}.pages must be a positive integer` });
      }

      // Same reasoning as the single-job route above - pricing comes from
      // the actual file, never the client's claimed pages.
      const realPages = await getRealPageCount(fileUrl);
      if (realPages === null) {
        return res.status(400).json({ error: `${label}: could not verify the uploaded file. Please upload it again.` });
      }
      pages = realPages;

      // Same "print only pages 1-3" handling as the single-job route -
      // see that route's comment for the full rationale. Each document in
      // a batch can select its own page range independently.
      if (pageSelection) {
        const { pageSet, error: selectionError } = parsePageRange(pageSelection, pages);
        if (selectionError) {
          return res.status(400).json({ error: `${label}.pageSelection: ${selectionError}` });
        }
        const selectedPages = Array.from(pageSet).sort((a, b) => a - b);
        const extracted = await extractPdfPages(fileUrl, selectedPages);
        deleteUploadedFile(fileUrl).catch(() => {});
        fileUrl = extracted.fileUrl;
        pages = extracted.pageCount;
      }

      if (!Number.isInteger(copies) || copies < 1) {
        return res.status(400).json({ error: `${label}.copies must be a positive integer` });
      }
      if (!VALID_COLOR_MODES.includes(colorMode)) {
        return res.status(400).json({ error: `${label}.colorMode must be "bw", "color", or "mixed"` });
      }

      const sidesValue = sides === undefined ? 'single' : sides;
      if (!VALID_SIDES.includes(sidesValue)) {
        return res.status(400).json({ error: `${label}.sides must be "single" or "double"` });
      }

      let colorPagesValue = null;
      if (colorMode === 'mixed') {
        const { error: rangeError } = parseColorPages(colorPages, pages);
        if (rangeError) {
          return res.status(400).json({ error: `${label}.colorPages: ${rangeError}` });
        }
        colorPagesValue = colorPages.trim();
      }

      const docAmountDue = calculateAmountDue({
        pages,
        copies,
        colorMode,
        colorPages: colorPagesValue,
        rates: { bw: shop.priceBw, color: shop.priceColor },
      });

      prepared.push({
        jobId: randomUUID(),
        fileUrl,
        fileName: typeof fileName === 'string' && fileName.trim() ? fileName.trim() : null,
        pages,
        copies,
        colorMode,
        colorPagesValue,
        sidesValue,
        amountDue: docAmountDue,
      });
    }

    const batchId = randomUUID();
    const totalAmountDue = prepared.reduce((sum, d) => sum + d.amountDue, 0);

    let resolvedName;
    try {
      resolvedName = await resolveStudentName(studentPhone, studentName);
    } catch (err) {
      if (err instanceof StudentNameRequiredError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    await pool.query(
      `INSERT INTO batches (id, shop_id, student_phone, student_name, status, token_number, amount_due, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'uploaded', NULL, $5, NOW(), NOW())`,
      [batchId, shopId, studentPhone, resolvedName, totalAmountDue]
    );

    for (const doc of prepared) {
      await pool.query(
        `INSERT INTO print_jobs
           (id, shop_id, batch_id, file_url, file_name, pages, copies, color_mode, color_pages, sides,
            student_phone, student_name, status, token_number, amount_due, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'uploaded', NULL, $13, NOW(), NOW())`,
        [
          doc.jobId, shopId, batchId, doc.fileUrl, doc.fileName, doc.pages, doc.copies,
          doc.colorMode, doc.colorPagesValue, doc.sidesValue, studentPhone, resolvedName, doc.amountDue,
        ]
      );
    }

    return res.status(201).json({
      batchId,
      amountDue: totalAmountDue,
      status: 'uploaded',
      documents: prepared.map((d) => ({ jobId: d.jobId, fileName: d.fileName, amountDue: d.amountDue })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/shops/login
// body: { email, password } -> { shopId, token, mustChangePassword? }
// Accepts either the shop's real password, or a still-valid admin-issued
// temporary password (see POST /api/admin/shops/:shopId/temp-password) -
// checked only if the real password doesn't match, so a correct real
// password always wins even if a temp password happens to also be live.
// Logging in with a temp password sets mustChangePassword: true and
// immediately consumes it (single use) - the shop owner is expected to set
// a real password via Settings right after.
router.post('/login', loginRateLimiter('email'), async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { rows } = await pool.query('SELECT * FROM shops WHERE LOWER(email) = LOWER($1)', [
      email.trim(),
    ]);
    const shop = rows[0];
    if (!shop) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    let ok = await comparePassword(password, shop.password_hash);
    let mustChangePassword = false;

    if (!ok && shop.temp_password_hash && shop.temp_password_expires_at && new Date(shop.temp_password_expires_at) > new Date()) {
      const tempOk = await comparePassword(password, shop.temp_password_hash);
      if (tempOk) {
        ok = true;
        mustChangePassword = true;
        // Single use - the moment it's successfully used to log in, it's
        // gone, whether or not the shop owner then goes on to set a real
        // password. Prevents the same temp password being used again to
        // log in a second time within its 10-minute window.
        await pool.query(
          'UPDATE shops SET temp_password_hash = NULL, temp_password_expires_at = NULL WHERE id = $1',
          [shop.id]
        );
      }
    }

    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signShopToken(shop, { viaTempPassword: mustChangePassword });
    return res.status(200).json({ shopId: shop.id, token, mustChangePassword });
  } catch (err) {
    next(err);
  }
});

// GET /api/shops/:shopId/jobs?status=queued
// Shop-owner-only (JWT required, must match :shopId).
router.get('/:shopId/jobs', requireShopAuth, requireOwnShop, async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { status } = req.query;

    const { rows: shopRows } = await pool.query('SELECT id FROM shops WHERE id = $1', [shopId]);
    if (shopRows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const baseSelect = `
      SELECT id AS "jobId", token_number AS "tokenNumber", pages, copies,
             color_mode AS "colorMode", color_pages AS "colorPages", sides,
             file_url AS "fileUrl", file_name AS "fileName", batch_id AS "batchId",
             student_phone AS "studentPhone", student_name AS "studentName",
             status, amount_due AS "amountDue",
             payment_method AS "paymentMethod", payment_screenshot_url AS "paymentScreenshotUrl",
             payment_rejection_reason AS "paymentRejectionReason",
             created_at AS "createdAt"
      FROM print_jobs WHERE shop_id = $1`;

    const { rows } = status
      ? await pool.query(`${baseSelect} AND status = $2 ORDER BY created_at ASC`, [shopId, status])
      : await pool.query(`${baseSelect} ORDER BY created_at ASC`, [shopId]);

    return res.status(200).json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/shops/:shopId/settings
// Shop-owner-only (JWT required, must match :shopId).
// -> { autoPrintEnabled }
// This is the source of truth both the dashboard toggle AND the local
// print agent read from - the agent is a separate long-running process, so
// it needs to check this itself rather than trust whatever the browser tab
// last showed, in case the shop owner flips the toggle while the agent's
// mid-poll-cycle.
router.get('/:shopId/settings', requireShopAuth, requireOwnShop, async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { rows } = await pool.query(
      `SELECT name, auto_print_enabled AS "autoPrintEnabled",
              price_bw AS "priceBw", price_color AS "priceColor",
              max_pages_per_hour AS "maxPagesPerHour", upi_id AS "upiId",
              razorpay_key_id AS "razorpayKeyId",
              (razorpay_key_secret IS NOT NULL) AS "razorpaySecretConfigured"
       FROM shops WHERE id = $1`,
      [shopId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    // razorpay_key_secret itself is never sent back to the browser once
    // saved - same "confirm it's there without re-displaying it" rule as
    // the bank account number on /vendor-status. razorpayKeyId is fine to
    // return in full: Razorpay's own Checkout widget needs it client-side
    // anyway, so it was never secret to begin with.
    return res.status(200).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shops/:shopId/settings
// Shop-owner-only (JWT required, must match :shopId).
// body: any subset of { autoPrintEnabled, priceBw, priceColor, maxPagesPerHour, upiId }
// -> the full updated settings object. Partial updates: only fields present
// in the body get validated and changed, so the Settings page can save
// pricing and the hourly cap independently of the auto-print toggle.
// maxPagesPerHour: send null (or omit and pass explicitly as null) to clear
// the cap entirely ("no limit") - 0 or a negative number is rejected rather
// than silently treated as "no limit", since that's an easy typo to make.
// upiId: the shop's own UPI ID (e.g. "shopowner@okhdfcbank") - whatever's
// already registered to their existing soundbox/QR. Send null to clear it
// (students then only see the cash-at-counter option, gated separately by
// a fresh QR scan - see routes/jobs.js submit-payment).
router.patch('/:shopId/settings', requireShopAuth, requireOwnShop, async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { autoPrintEnabled, priceBw, priceColor, maxPagesPerHour, upiId, razorpayKeyId, razorpaySecret } =
      req.body || {};

    const sets = [];
    const values = [];
    let paramIndex = 1;

    if (autoPrintEnabled !== undefined) {
      if (typeof autoPrintEnabled !== 'boolean') {
        return res.status(400).json({ error: 'autoPrintEnabled must be true or false' });
      }
      sets.push(`auto_print_enabled = $${paramIndex++}`);
      values.push(autoPrintEnabled);
    }

    if (priceBw !== undefined) {
      if (!Number.isInteger(priceBw) || priceBw < 1) {
        return res.status(400).json({ error: 'priceBw must be a positive integer (INR per page)' });
      }
      sets.push(`price_bw = $${paramIndex++}`);
      values.push(priceBw);
    }

    if (priceColor !== undefined) {
      if (!Number.isInteger(priceColor) || priceColor < 1) {
        return res.status(400).json({ error: 'priceColor must be a positive integer (INR per page)' });
      }
      sets.push(`price_color = $${paramIndex++}`);
      values.push(priceColor);
    }

    if (maxPagesPerHour !== undefined) {
      if (maxPagesPerHour !== null && (!Number.isInteger(maxPagesPerHour) || maxPagesPerHour < 1)) {
        return res
          .status(400)
          .json({ error: 'maxPagesPerHour must be a positive integer, or null for no limit' });
      }
      sets.push(`max_pages_per_hour = $${paramIndex++}`);
      values.push(maxPagesPerHour);
    }

    if (upiId !== undefined) {
      if (upiId !== null) {
        if (typeof upiId !== 'string' || !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,64}$/.test(upiId.trim())) {
          return res.status(400).json({ error: 'upiId must look like "name@bank" (e.g. shop123@okhdfcbank), or null to clear it' });
        }
        sets.push(`upi_id = $${paramIndex++}`);
        values.push(upiId.trim());
      } else {
        sets.push(`upi_id = $${paramIndex++}`);
        values.push(null);
      }
    }

    // razorpayKeyId/razorpaySecret: the shop's own Razorpay account, so
    // their online payments (including the platform's service/gateway
    // fees baked into the total - see routes/jobs.js) land directly with
    // them instead of the platform's pooled account. Set null on
    // razorpayKeyId to clear BOTH fields at once - a key_id with no
    // matching secret (or vice versa) is just a broken config that would
    // fail every checkout attempt with a confusing error, so it's not a
    // state this route allows getting into. Setting a new pair always
    // requires both together in the same request, for the same reason.
    if (razorpayKeyId !== undefined) {
      if (razorpayKeyId === null) {
        sets.push(`razorpay_key_id = $${paramIndex++}`);
        values.push(null);
        sets.push(`razorpay_key_secret = $${paramIndex++}`);
        values.push(null);
      } else {
        if (typeof razorpayKeyId !== 'string' || razorpayKeyId.trim().length < 8) {
          return res.status(400).json({ error: 'razorpayKeyId does not look like a valid Razorpay key ID' });
        }
        if (typeof razorpaySecret !== 'string' || razorpaySecret.trim().length < 8) {
          return res
            .status(400)
            .json({ error: 'razorpaySecret is required (and must be valid) whenever razorpayKeyId is set' });
        }
        sets.push(`razorpay_key_id = $${paramIndex++}`);
        values.push(razorpayKeyId.trim());
        sets.push(`razorpay_key_secret = $${paramIndex++}`);
        values.push(razorpaySecret.trim());
      }
    } else if (razorpaySecret !== undefined) {
      return res.status(400).json({ error: 'razorpaySecret must be set together with razorpayKeyId' });
    }

    if (sets.length === 0) {
      return res.status(400).json({
        error:
          'Provide at least one of: autoPrintEnabled, priceBw, priceColor, maxPagesPerHour, upiId, razorpayKeyId',
      });
    }

    values.push(shopId);
    const { rows } = await pool.query(
      `UPDATE shops SET ${sets.join(', ')} WHERE id = $${paramIndex}
       RETURNING auto_print_enabled AS "autoPrintEnabled",
                 price_bw AS "priceBw", price_color AS "priceColor",
                 max_pages_per_hour AS "maxPagesPerHour", upi_id AS "upiId",
                 razorpay_key_id AS "razorpayKeyId",
                 (razorpay_key_secret IS NOT NULL) AS "razorpaySecretConfigured"`,
      values
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    return res.status(200).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const BANK_ACCOUNT_REGEX = /^\d{9,18}$/;

// GET /api/shops/:shopId/vendor-status
// Shop-owner-only. -> { vendorStatus, bankAccountLast4, bankIfsc, bankAccountHolder, pan }
// Never returns the full account number back to the browser once saved -
// only enough (last 4 digits) to confirm "yes, that's the right account"
// without re-displaying the whole thing on every page load.
router.get('/:shopId/vendor-status', requireShopAuth, requireOwnShop, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT vendor_status AS "vendorStatus", bank_account_number AS "bankAccountNumber",
              bank_ifsc AS "bankIfsc", bank_account_holder AS "bankAccountHolder", pan
       FROM shops WHERE id = $1`,
      [req.params.shopId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const row = rows[0];
    return res.status(200).json({
      vendorStatus: row.vendorStatus,
      bankAccountLast4: row.bankAccountNumber ? row.bankAccountNumber.slice(-4) : null,
      bankIfsc: row.bankIfsc,
      bankAccountHolder: row.bankAccountHolder,
      pan: row.pan,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/shops/:shopId/vendor
// Shop-owner-only. body: { bankAccountNumber, bankIfsc, bankAccountHolder, pan }
// -> { vendorStatus }
// Registers (or re-registers, if called again) this shop as a Cashfree
// Easy Split vendor - the one-time step that lets their share of a future
// online payment settle straight to this bank account instead of sitting
// in the platform's own Cashfree balance. Calling this again with updated
// details creates a fresh vendor record under the same vendorId (Cashfree
// treats a repeat Create Vendor call as an update).
router.post('/:shopId/vendor', requireShopAuth, requireOwnShop, async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { bankAccountNumber, bankIfsc, bankAccountHolder, pan } = req.body || {};

    if (!bankAccountNumber || !BANK_ACCOUNT_REGEX.test(String(bankAccountNumber))) {
      return res.status(400).json({ error: 'bankAccountNumber must be 9-18 digits' });
    }
    const normalizedIfsc = String(bankIfsc || '').trim().toUpperCase();
    if (!IFSC_REGEX.test(normalizedIfsc)) {
      return res.status(400).json({ error: 'bankIfsc must be a valid IFSC code (e.g. HDFC0001234)' });
    }
    if (!bankAccountHolder || typeof bankAccountHolder !== 'string' || !bankAccountHolder.trim()) {
      return res.status(400).json({ error: 'bankAccountHolder is required' });
    }
    const normalizedPan = String(pan || '').trim().toUpperCase();
    if (!PAN_REGEX.test(normalizedPan)) {
      return res.status(400).json({ error: 'pan must be a valid PAN (e.g. ABCDE1234F)' });
    }

    const { rows: shopRows } = await pool.query('SELECT name, email, cashfree_vendor_id FROM shops WHERE id = $1', [
      shopId,
    ]);
    if (shopRows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const shop = shopRows[0];
    // Stable per-shop vendor ID, generated once and reused on every later
    // call (including re-submission) - never Cashfree-assigned, since we
    // need to know it before the first API call.
    const vendorId = shop.cashfree_vendor_id || `shop_${shopId}`.slice(0, 40);

    let vendor;
    try {
      vendor = await createVendor({
        vendorId,
        name: shop.name,
        email: shop.email,
        phone: 9999999999, // TODO: collect a real contact number at signup; Cashfree requires one
        bankAccountNumber: String(bankAccountNumber),
        bankIfsc: normalizedIfsc,
        bankAccountHolder: bankAccountHolder.trim(),
        pan: normalizedPan,
      });
    } catch (cfErr) {
      // eslint-disable-next-line no-console
      console.error('Cashfree createVendor failed:', cfErr.message, cfErr.cashfreeResponse);
      return res.status(502).json({ error: 'Could not register with the payment provider. Please try again.' });
    }

    await pool.query(
      `UPDATE shops
       SET cashfree_vendor_id = $1, vendor_status = $2, bank_account_number = $3,
           bank_ifsc = $4, bank_account_holder = $5, pan = $6, updated_at = NOW()
       WHERE id = $7`,
      [vendorId, vendor.status || 'PENDING', String(bankAccountNumber), normalizedIfsc, bankAccountHolder.trim(), normalizedPan, shopId]
    );

    return res.status(200).json({ vendorStatus: vendor.status || 'PENDING' });
  } catch (err) {
    next(err);
  }
});

// POST /api/shops/:shopId/change-password
// Shop-owner-only (JWT required, must match :shopId).
// body: { currentPassword?, newPassword } -> { ok: true }
// currentPassword is required UNLESS this session started by logging in
// with an admin-issued temporary password (req.viaTempPassword, set by
// requireShopAuth from the token - see auth.js signShopToken) - someone
// who needed a temp password by definition doesn't know their old one, so
// there's nothing valid to confirm against. A normal session (real
// password login) still must prove the current password to change it.
router.post('/:shopId/change-password', requireShopAuth, requireOwnShop, async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { currentPassword, newPassword } = req.body || {};

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'newPassword is required and must be at least 8 characters' });
    }

    const { rows } = await pool.query('SELECT * FROM shops WHERE id = $1', [shopId]);
    const shop = rows[0];
    if (!shop) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    if (!req.viaTempPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'currentPassword is required' });
      }
      const ok = await comparePassword(currentPassword, shop.password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }

    const newHash = await hashPassword(newPassword);
    await pool.query('UPDATE shops SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
      newHash,
      shopId,
    ]);

    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/shops/:shopId/public
// Public - no auth. Powers Module 1: once a student has picked a shop, this
// is what shows them that shop's per-page pricing, hourly print capacity,
// and UPI ID (to build the "pay at this shop's usual UPI ID" deep link)
// before they commit to uploading. Deliberately excludes anything
// account-related (email, autoPrintEnabled, etc). upiId may be null if the
// shop hasn't set one yet - the student app falls back to cash-only in that
// case.
router.get('/:shopId/public', async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { rows } = await pool.query(
      `SELECT id AS "shopId", name,
              price_bw AS "priceBw", price_color AS "priceColor",
              max_pages_per_hour AS "maxPagesPerHour", upi_id AS "upiId"
       FROM shops WHERE id = $1`,
      [shopId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    return res.status(200).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/shops/:shopId/earnings
// Shop-owner-only (JWT required, must match :shopId). Powers the earnings
// summary in the dashboard header AND the Earnings page's headline
// numbers. Revenue only counts jobs the shop owner has actually confirmed
// payment for (status past 'payment_pending') - an 'uploaded' job was
// never paid at all, and 'payment_pending' one is just a claim
// (screenshot/cash promise) not yet reviewed, so neither is real revenue
// yet. Same rule the admin panel's stats use, so the numbers agree.
router.get('/:shopId/earnings', requireShopAuth, requireOwnShop, async (req, res, next) => {
  try {
    const { shopId } = req.params;

    const [totalRes, todayRes, statusRes, totalByMethod, todayByMethod, settledTotal, commission] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(amount_due), 0)::int AS "totalEarnings",
                COUNT(*)::int AS "totalJobs"
         FROM print_jobs WHERE shop_id = $1 AND ${CONFIRMED_STATUS_SQL}`,
        [shopId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount_due), 0)::int AS "todayEarnings",
                COUNT(*)::int AS "todayJobs"
         FROM print_jobs
         WHERE shop_id = $1 AND ${CONFIRMED_STATUS_SQL} AND created_at::date = CURRENT_DATE`,
        [shopId]
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS count FROM print_jobs WHERE shop_id = $1 GROUP BY status`,
        [shopId]
      ),
      getShopMethodTotals(shopId),
      getShopMethodTotals(shopId, { today: true }),
      getSettledTotal(shopId),
      getCommissionOwed(shopId),
    ]);

    return res.status(200).json({
      totalEarnings: totalRes.rows[0].totalEarnings,
      totalJobs: totalRes.rows[0].totalJobs,
      todayEarnings: todayRes.rows[0].todayEarnings,
      todayJobs: todayRes.rows[0].todayJobs,
      jobsByStatus: statusRes.rows,
      // cash vs online split - what the shop owner actually wants to know
      // for reconciling the till vs. what's still sitting with the platform
      totalByMethod,
      todayByMethod,
      // Online money only exists as a number until it's actually paid out;
      // this is "what's still owed to me" at a glance.
      settledTotal,
      unsettledOnline: Math.max(0, totalByMethod.online - settledTotal),
      // The reverse direction: jobs paid straight into the shop's OWN
      // Razorpay account never sent the platform its service/gateway fee
      // cut, so this is what the shop owes the platform instead - paid
      // whenever, not on a fixed schedule (see earnings.js).
      commissionAccrued: commission.accrued,
      commissionPaid: commission.paid,
      commissionOwed: commission.owed,
    });
  } catch (err) {
    next(err);
  }
});

const VALID_GROUP_BY = ['day', 'month', 'year'];
const GROUP_BY_LIMIT = { day: 30, month: 24, year: 10 };

// GET /api/shops/:shopId/earnings/history?groupBy=day|month|year
// Shop-owner-only. Powers the Earnings page's history table - earnings
// bucketed by day (last 30), month (last 24), or year (last 10), each
// split into cash/online same as the summary above. Only confirmed
// payments count, same rule as everywhere else.
router.get('/:shopId/earnings/history', requireShopAuth, requireOwnShop, async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const groupBy = VALID_GROUP_BY.includes(req.query.groupBy) ? req.query.groupBy : 'day';
    const truncUnit = groupBy; // Postgres date_trunc accepts 'day'/'month'/'year' directly
    const limit = GROUP_BY_LIMIT[groupBy];

    const { rows } = await pool.query(
      `SELECT date_trunc($2, created_at)::date AS period,
              COALESCE(payment_method, 'unknown') AS method,
              COALESCE(SUM(amount_due), 0)::int AS total,
              COUNT(*)::int AS count
       FROM print_jobs
       WHERE shop_id = $1 AND ${CONFIRMED_STATUS_SQL}
       GROUP BY period, payment_method
       ORDER BY period DESC
       LIMIT 500`,
      [shopId, truncUnit]
    );

    // Reshape (period, method) rows into one row per period with cash/online
    // split and a running job count - the frontend renders this directly as
    // a table, one row per day/month/year.
    const byPeriod = new Map();
    for (const row of rows) {
      const key = row.period.toISOString();
      if (!byPeriod.has(key)) {
        byPeriod.set(key, { period: key, cash: 0, online: 0, jobs: 0 });
      }
      const bucket = byPeriod.get(key);
      bucket.jobs += row.count;
      if (row.method === 'cash') bucket.cash += row.total;
      else if (row.method === 'razorpay' || row.method === 'upi') bucket.online += row.total;
    }

    const history = Array.from(byPeriod.values())
      .sort((a, b) => new Date(b.period) - new Date(a.period))
      .slice(0, limit)
      .map((row) => ({ ...row, total: row.cash + row.online }));

    return res.status(200).json({ groupBy, history });
  } catch (err) {
    next(err);
  }
});

// GET /api/shops/:shopId/settlements
// Shop-owner-only, read-only - the admin panel is the only place these get
// created/edited/deleted (see routes/admin.js). Lets a shop owner see
// exactly when and how much of their online earnings they've been paid,
// without having to ask.
router.get('/:shopId/settlements', requireShopAuth, requireOwnShop, async (req, res, next) => {
  try {
    const settlements = await listSettlements(req.params.shopId);
    return res.status(200).json(settlements);
  } catch (err) {
    next(err);
  }
});

// GET /api/shops/:shopId/commission-payments
// Shop-owner-only, read-only - the admin panel is the only place these get
// created/edited/deleted (see routes/admin.js). The reverse of
// /settlements above: this is what the shop owner has paid the PLATFORM
// for jobs that settled straight to their own Razorpay account - lets
// them see their own payment history without having to ask.
router.get('/:shopId/commission-payments', requireShopAuth, requireOwnShop, async (req, res, next) => {
  try {
    const payments = await listCommissionPayments(req.params.shopId);
    return res.status(200).json(payments);
  } catch (err) {
    next(err);
  }
});

// POST /api/shops/:shopId/reviews
// Public. body: { jobId, rating, comment? } -> { id, rating, comment, authorName, createdAt }
// jobId can be either a print_jobs row's own id, or - for a batch order - any
// one of its documents' job ids (a batch has no single "job" of its own to
// point at, and one review per order reads more naturally than one per
// document anyway, so the first doc found for that batch_id is used).
// Requires the job to have actually moved past payment review (queued or
// later) - a review on a job still sitting at 'uploaded'/'payment_pending'
// would mean nothing was ever confirmed, let alone experienced. authorName
// comes from the job's own student_name, never re-typed.
router.post('/:shopId/reviews', async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { jobId, rating, comment } = req.body || {};

    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({ error: 'jobId is required' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be a whole number from 1 to 5' });
    }
    const commentValue = typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 1000) : null;

    const { rows } = await pool.query(
      `SELECT id, shop_id, student_name, status FROM print_jobs WHERE id = $1`,
      [jobId]
    );
    const job = rows[0];
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.shop_id !== shopId) {
      return res.status(403).json({ error: 'This job does not belong to this shop' });
    }
    if (job.status === 'uploaded' || job.status === 'payment_pending') {
      return res.status(409).json({ error: 'This order needs to be paid and confirmed before it can be reviewed' });
    }

    const { rows: existing } = await pool.query(
      `SELECT id FROM reviews WHERE job_id = $1 AND source = 'real'`,
      [jobId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'This order has already been reviewed' });
    }

    const id = randomUUID();
    await pool.query(
      `INSERT INTO reviews (id, shop_id, job_id, rating, comment, author_name, source, visible, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'real', TRUE, NOW())`,
      [id, shopId, jobId, rating, commentValue, job.student_name || 'A student']
    );

    return res.status(201).json({
      id,
      rating,
      comment: commentValue,
      authorName: job.student_name || 'A student',
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/shops/:shopId/reviews
// Public. -> { averageRating, count, reviews: [{ id, rating, comment, authorName, createdAt }] }
// Only visible reviews - real and admin-added "fake" ones render identically
// here, which is deliberate (see db.js migration comment on the reviews
// table) - a hidden real review and a never-approved one are indistinguishable
// to a student either way.
router.get('/:shopId/reviews', async (req, res, next) => {
  try {
    const { shopId } = req.params;

    const { rows: summaryRows } = await pool.query(
      `SELECT COALESCE(ROUND(AVG(rating)::numeric, 1), 0)::float AS "averageRating", COUNT(*)::int AS count
       FROM reviews WHERE shop_id = $1 AND visible = TRUE`,
      [shopId]
    );
    const { rows: reviewRows } = await pool.query(
      `SELECT id, rating, comment, author_name AS "authorName", created_at AS "createdAt"
       FROM reviews WHERE shop_id = $1 AND visible = TRUE
       ORDER BY sort_order DESC, created_at DESC LIMIT 50`,
      [shopId]
    );

    return res.status(200).json({ ...summaryRows[0], reviews: reviewRows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
