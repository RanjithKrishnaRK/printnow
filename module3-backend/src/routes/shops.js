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
const { calculateAmountDue, parseColorPages } = require('../pricing');
const { PRICING } = require('../config');

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
      `SELECT id AS "shopId", name, landmark_id AS "landmarkId"
       FROM shops WHERE landmark_id = $1 ORDER BY name ASC`,
      [landmarkId]
    );

    return res.status(200).json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/shops/signup
// Public - self-service shop owner registration (previously only possible
// via scripts/seedShop.js run by hand). body: { name, email, password, landmarkId }
// -> { shopId, token } (signs the new shop straight in, same as /login would)
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
    return res.status(201).json({ shopId: id, token });
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
    const { fileUrl, pages, copies, colorMode, studentPhone, sides, colorPages } = req.body || {};

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
    if (!Number.isInteger(pages) || pages < 1) {
      return res.status(400).json({ error: 'pages must be a positive integer' });
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
    const jobId = randomUUID();

    await pool.query(
      `INSERT INTO print_jobs
         (id, shop_id, file_url, pages, copies, color_mode, color_pages, sides,
          student_phone, status, token_number, amount_due, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'uploaded', NULL, $10, NOW(), NOW())`,
      [jobId, shopId, fileUrl, pages, copies, colorMode, colorPagesValue, sidesValue, studentPhone, amountDue]
    );

    return res.status(201).json({ jobId, amountDue, status: 'uploaded' });
  } catch (err) {
    next(err);
  }
});

// POST /api/shops/login
// body: { email, password } -> { shopId, token }
router.post('/login', async (req, res, next) => {
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

    const ok = await comparePassword(password, shop.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signShopToken(shop);
    return res.status(200).json({ shopId: shop.id, token });
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
             file_url AS "fileUrl", student_phone AS "studentPhone", status,
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
      `SELECT auto_print_enabled AS "autoPrintEnabled",
              price_bw AS "priceBw", price_color AS "priceColor",
              max_pages_per_hour AS "maxPagesPerHour"
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

// PATCH /api/shops/:shopId/settings
// Shop-owner-only (JWT required, must match :shopId).
// body: any subset of { autoPrintEnabled, priceBw, priceColor, maxPagesPerHour }
// -> the full updated settings object. Partial updates: only fields present
// in the body get validated and changed, so the Settings page can save
// pricing and the hourly cap independently of the auto-print toggle.
// maxPagesPerHour: send null (or omit and pass explicitly as null) to clear
// the cap entirely ("no limit") - 0 or a negative number is rejected rather
// than silently treated as "no limit", since that's an easy typo to make.
router.patch('/:shopId/settings', requireShopAuth, requireOwnShop, async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { autoPrintEnabled, priceBw, priceColor, maxPagesPerHour } = req.body || {};

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

    if (sets.length === 0) {
      return res.status(400).json({
        error: 'Provide at least one of: autoPrintEnabled, priceBw, priceColor, maxPagesPerHour',
      });
    }

    values.push(shopId);
    const { rows } = await pool.query(
      `UPDATE shops SET ${sets.join(', ')} WHERE id = $${paramIndex}
       RETURNING auto_print_enabled AS "autoPrintEnabled",
                 price_bw AS "priceBw", price_color AS "priceColor",
                 max_pages_per_hour AS "maxPagesPerHour"`,
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

// GET /api/shops/:shopId/public
// Public - no auth. Powers Module 1: once a student has picked a shop, this
// is what shows them that shop's per-page pricing and hourly print
// capacity before they commit to uploading. Deliberately excludes anything
// account-related (email, autoPrintEnabled, etc).
router.get('/:shopId/public', async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { rows } = await pool.query(
      `SELECT id AS "shopId", name,
              price_bw AS "priceBw", price_color AS "priceColor",
              max_pages_per_hour AS "maxPagesPerHour"
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
// summary in the dashboard header. Revenue only counts jobs that actually
// got paid for (status != 'uploaded') - same rule the admin panel's
// platform-wide revenue stat already uses, so the two numbers stay
// consistent with each other.
router.get('/:shopId/earnings', requireShopAuth, requireOwnShop, async (req, res, next) => {
  try {
    const { shopId } = req.params;

    const [totalRes, todayRes, statusRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(amount_due), 0)::int AS "totalEarnings",
                COUNT(*)::int AS "totalJobs"
         FROM print_jobs WHERE shop_id = $1 AND status != 'uploaded'`,
        [shopId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount_due), 0)::int AS "todayEarnings",
                COUNT(*)::int AS "todayJobs"
         FROM print_jobs
         WHERE shop_id = $1 AND status != 'uploaded' AND created_at::date = CURRENT_DATE`,
        [shopId]
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS count FROM print_jobs WHERE shop_id = $1 GROUP BY status`,
        [shopId]
      ),
    ]);

    return res.status(200).json({
      totalEarnings: totalRes.rows[0].totalEarnings,
      totalJobs: totalRes.rows[0].totalJobs,
      todayEarnings: todayRes.rows[0].todayEarnings,
      todayJobs: todayRes.rows[0].todayJobs,
      jobsByStatus: statusRes.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
