// src/routes/admin.js
//
// Module 5 - Admin panel backend. Single admin account (see db.js migrate()
// for the one-time seed). Password is changeable any time via
// POST /change-password - nothing here reads ADMIN_INITIAL_PASSWORD again
// after the first boot, so editing .env later does nothing on its own.
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const { pool } = require('../db');
const { hashPassword, comparePassword, signAdminToken, requireAdminAuth } = require('../auth');
const { UPLOAD_DIR } = require('../config');
const { getPaymentFees, updatePaymentFees } = require('../settings');
const { loginRateLimiter } = require('../rateLimit');

const router = express.Router();

// POST /api/admin/login
// body: { email, password } -> { token }
router.post('/login', loginRateLimiter('email'), async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { rows } = await pool.query('SELECT * FROM admins WHERE LOWER(email) = LOWER($1)', [
      email.trim(),
    ]);
    const admin = rows[0];
    if (!admin) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const ok = await comparePassword(password, admin.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signAdminToken(admin);
    return res.status(200).json({ token, email: admin.email });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/change-password
// Auth required. body: { currentPassword, newPassword } -> { ok: true }
// Can be called any time, as many times as needed - this IS the mechanism
// for changing the admin password, there's no separate settings flow.
router.post('/change-password', requireAdminAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
    }

    const { rows } = await pool.query('SELECT * FROM admins WHERE id = $1', [req.adminId]);
    const admin = rows[0];
    if (!admin) {
      return res.status(404).json({ error: 'Admin account not found' });
    }

    const ok = await comparePassword(currentPassword, admin.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await hashPassword(newPassword);
    await pool.query('UPDATE admins SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
      newHash,
      admin.id,
    ]);

    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/settings/payment-fees
// Auth required. -> { serviceFee, gatewayFeePercent }
router.get('/settings/payment-fees', requireAdminAuth, async (req, res, next) => {
  try {
    const fees = await getPaymentFees();
    return res.status(200).json(fees);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/settings/payment-fees
// Auth required. body: { serviceFee, gatewayFeePercent } -> the updated values
// serviceFee is a flat INR amount added to every online payment;
// gatewayFeePercent is a percentage of the print cost, rounded to the
// nearest rupee when actually applied (see routes/jobs.js and
// routes/batches.js razorpay/create-order). Both must be >= 0 - a negative
// fee would mean paying a student to check out, which is never intended
// even as a promo (do that by editing PRICING/amount_due directly instead).
router.patch('/settings/payment-fees', requireAdminAuth, async (req, res, next) => {
  try {
    const { serviceFee, gatewayFeePercent } = req.body || {};
    if (typeof serviceFee !== 'number' || !Number.isFinite(serviceFee) || serviceFee < 0) {
      return res.status(400).json({ error: 'serviceFee must be a non-negative number' });
    }
    if (
      typeof gatewayFeePercent !== 'number' ||
      !Number.isFinite(gatewayFeePercent) ||
      gatewayFeePercent < 0 ||
      gatewayFeePercent > 100
    ) {
      return res.status(400).json({ error: 'gatewayFeePercent must be a number between 0 and 100' });
    }

    const updated = await updatePaymentFees({ serviceFee, gatewayFeePercent });
    return res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/shops
// Auth required. All shops platform-wide, with landmark name and a job
// count, for the admin's shop list view. Revenue only counts jobs the shop
// owner has actually confirmed payment for (past 'payment_pending') - see
// routes/shops.js' earnings route for the same rule and rationale.
router.get('/shops', requireAdminAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        s.id AS "shopId",
        s.name,
        s.email,
        s.created_at AS "createdAt",
        l.name AS "landmarkName",
        COUNT(pj.id)::int AS "totalJobs",
        COALESCE(SUM(CASE WHEN pj.status NOT IN ('uploaded', 'payment_pending') THEN pj.amount_due ELSE 0 END), 0)::int AS "totalRevenue"
      FROM shops s
      LEFT JOIN landmarks l ON l.id = s.landmark_id
      LEFT JOIN print_jobs pj ON pj.shop_id = s.id
      GROUP BY s.id, l.name
      ORDER BY "totalRevenue" DESC
    `);
    return res.status(200).json(rows);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/shops/:shopId
// Auth required. Removes a shop entirely - used to moderate spam/bad
// signups. shops.print_jobs and shops.token_counters both have NOT NULL
// FK references to shops(id) with no ON DELETE CASCADE (deliberately, so a
// stray app bug can never silently wipe job history) - so this route does
// the cascade itself, in a transaction: delete the shop's uploaded PDFs
// from disk (best-effort, a missing file shouldn't block the delete),
// then token_counters, then print_jobs, then the shop row.
router.delete('/shops/:shopId', requireAdminAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { shopId } = req.params;

    const { rows: shopRows } = await client.query('SELECT id FROM shops WHERE id = $1', [shopId]);
    if (shopRows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const { rows: jobRows } = await client.query(
      'SELECT file_url AS "fileUrl" FROM print_jobs WHERE shop_id = $1',
      [shopId]
    );

    await client.query('BEGIN');
    await client.query('DELETE FROM print_jobs WHERE shop_id = $1', [shopId]);
    await client.query('DELETE FROM token_counters WHERE shop_id = $1', [shopId]);
    await client.query('DELETE FROM shops WHERE id = $1', [shopId]);
    await client.query('COMMIT');

    // File cleanup happens after the DB commit succeeds, so a disk error
    // never leaves the delete half-done. Best-effort - a file that's
    // already gone (e.g. collected jobs auto-delete theirs) just gets
    // logged and skipped rather than failing a delete the admin is waiting on.
    for (const job of jobRows) {
      if (!job.fileUrl) continue;
      const localPath = path.join(path.resolve(UPLOAD_DIR), path.basename(job.fileUrl));
      try {
        await fs.unlink(localPath);
      } catch (fileErr) {
        console.warn(`Could not delete file at ${localPath} for removed shop ${shopId}:`, fileErr.message);
      }
    }

    return res.status(200).json({ ok: true, shopId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/admin/shops/:shopId/stats
// Auth required. Per-shop financial detail: total/today earnings, and both
// split by payment method (cash vs UPI) - the shop owner's own earnings
// route (GET /api/shops/:shopId/earnings) shows totals but not this
// breakdown, since a shop owner doesn't need to see it split that way, but
// the platform admin does, to understand cash-vs-digital mix across shops.
// Same "confirmed payment only" revenue rule as everywhere else: a job still
// sitting at 'uploaded' or 'payment_pending' isn't counted.
router.get('/shops/:shopId/stats', requireAdminAuth, async (req, res, next) => {
  try {
    const { shopId } = req.params;

    const { rows: shopRows } = await pool.query('SELECT id, name FROM shops WHERE id = $1', [shopId]);
    if (shopRows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const CONFIRMED = `status NOT IN ('uploaded', 'payment_pending')`;
    const [totalRes, todayRes, byMethodRes, todayByMethodRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(amount_due), 0)::int AS "totalEarnings", COUNT(*)::int AS "totalJobs"
         FROM print_jobs WHERE shop_id = $1 AND ${CONFIRMED}`,
        [shopId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount_due), 0)::int AS "todayEarnings", COUNT(*)::int AS "todayJobs"
         FROM print_jobs WHERE shop_id = $1 AND ${CONFIRMED} AND created_at::date = CURRENT_DATE`,
        [shopId]
      ),
      pool.query(
        `SELECT COALESCE(payment_method, 'unknown') AS method,
                COALESCE(SUM(amount_due), 0)::int AS total, COUNT(*)::int AS count
         FROM print_jobs WHERE shop_id = $1 AND ${CONFIRMED}
         GROUP BY payment_method`,
        [shopId]
      ),
      pool.query(
        `SELECT COALESCE(payment_method, 'unknown') AS method,
                COALESCE(SUM(amount_due), 0)::int AS total, COUNT(*)::int AS count
         FROM print_jobs WHERE shop_id = $1 AND ${CONFIRMED} AND created_at::date = CURRENT_DATE
         GROUP BY payment_method`,
        [shopId]
      ),
    ]);

    // Reshape the group-by rows into a flat { cash: N, upi: N } - easier for
    // the admin UI to render than iterating an array, and guarantees both
    // keys exist (0) even if a shop has never had one payment method at all.
    function toMethodTotals(rows) {
      const totals = { cash: 0, upi: 0 };
      for (const row of rows) {
        if (row.method === 'cash' || row.method === 'upi') totals[row.method] = row.total;
      }
      return totals;
    }

    return res.status(200).json({
      shopId,
      shopName: shopRows[0].name,
      totalEarnings: totalRes.rows[0].totalEarnings,
      totalJobs: totalRes.rows[0].totalJobs,
      todayEarnings: todayRes.rows[0].todayEarnings,
      todayJobs: todayRes.rows[0].todayJobs,
      totalByMethod: toMethodTotals(byMethodRes.rows),
      todayByMethod: toMethodTotals(todayByMethodRes.rows),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/landmarks
// Auth required. Same landmarks as the public endpoint, plus a shop count -
// the public /api/landmarks endpoint stays lean for Module 1/2's dropdowns.
router.get('/landmarks', requireAdminAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT l.id, l.name, l.created_at AS "createdAt",
             COUNT(s.id)::int AS "shopCount"
      FROM landmarks l
      LEFT JOIN shops s ON s.landmark_id = l.id
      GROUP BY l.id
      ORDER BY l.created_at ASC
    `);
    return res.status(200).json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/landmarks
// Auth required. body: { name } -> { id, name }
// This is what replaces the old "seeded by hand in db.js" approach for
// adding new campuses/areas beyond Anurag University.
router.post('/landmarks', requireAdminAuth, async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const trimmedName = name.trim();

    const { rows: existing } = await pool.query(
      'SELECT id FROM landmarks WHERE LOWER(name) = LOWER($1)',
      [trimmedName]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'A landmark with this name already exists' });
    }

    // Slug-style id (e.g. "lm_kphb_colony") for readability in logs/DB
    // browsing - falls back to a random suffix if the slug would be empty
    // (e.g. a name that's entirely punctuation/emoji).
    const slug = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const id = `lm_${slug || randomUUID().slice(0, 8)}`;

    await pool.query(
      `INSERT INTO landmarks (id, name, created_at) VALUES ($1, $2, NOW())`,
      [id, trimmedName]
    );

    return res.status(201).json({ id, name: trimmedName });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/landmarks/:landmarkId
// Auth required. -> { ok: true, shopsUnassigned }
// Any shop currently registered under this landmark gets its landmark_id
// cleared (not deleted along with it - a shop losing its physical location
// tag is very different from a shop being removed entirely, which is what
// DELETE /shops/:shopId is for). Those shops simply stop appearing in that
// landmark's browse list until reassigned to a different one from their own
// Settings page.
router.delete('/landmarks/:landmarkId', requireAdminAuth, async (req, res, next) => {
  try {
    const { landmarkId } = req.params;

    const { rows } = await pool.query('SELECT id FROM landmarks WHERE id = $1', [landmarkId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Landmark not found' });
    }

    const { rowCount: shopsUnassigned } = await pool.query(
      'UPDATE shops SET landmark_id = NULL WHERE landmark_id = $1',
      [landmarkId]
    );
    await pool.query('DELETE FROM landmarks WHERE id = $1', [landmarkId]);

    return res.status(200).json({ ok: true, shopsUnassigned });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/stats
// Auth required. Platform-wide analytics for the admin dashboard's charts.
router.get('/stats', requireAdminAuth, async (req, res, next) => {
  try {
    const [
      totals,
      jobsByStatus,
      revenue,
      colorMix,
      sidesMix,
      dailyVolume,
      topShops,
    ] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM shops) AS "totalShops",
          (SELECT COUNT(*)::int FROM landmarks) AS "totalLandmarks",
          (SELECT COUNT(*)::int FROM print_jobs) AS "totalJobs"
      `),
      pool.query(`
        SELECT status, COUNT(*)::int AS count
        FROM print_jobs GROUP BY status
      `),
      // Revenue only counts jobs that actually got paid for and confirmed
      // by the shop owner (past 'payment_pending') - an "uploaded" job was
      // never paid, and "payment_pending" is only a claim not yet reviewed.
      pool.query(`
        SELECT COALESCE(SUM(amount_due), 0)::int AS "totalRevenue"
        FROM print_jobs WHERE status NOT IN ('uploaded', 'payment_pending')
      `),
      pool.query(`
        SELECT color_mode AS "colorMode", COUNT(*)::int AS count
        FROM print_jobs GROUP BY color_mode
      `),
      pool.query(`
        SELECT sides, COUNT(*)::int AS count
        FROM print_jobs GROUP BY sides
      `),
      // Last 14 days of job volume, platform-wide, for a trend chart.
      // generate_series ensures days with zero jobs still show up as 0
      // instead of just being missing from the array.
      pool.query(`
        SELECT
          to_char(d.day, 'YYYY-MM-DD') AS date,
          COUNT(pj.id)::int AS count
        FROM generate_series(
          CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day'
        ) AS d(day)
        LEFT JOIN print_jobs pj ON pj.created_at::date = d.day
        GROUP BY d.day
        ORDER BY d.day ASC
      `),
      pool.query(`
        SELECT s.name, COUNT(pj.id)::int AS "jobCount"
        FROM shops s
        LEFT JOIN print_jobs pj ON pj.shop_id = s.id
        GROUP BY s.id
        ORDER BY "jobCount" DESC
        LIMIT 5
      `),
    ]);

    return res.status(200).json({
      ...totals.rows[0],
      jobsByStatus: jobsByStatus.rows,
      totalRevenue: revenue.rows[0].totalRevenue,
      colorMix: colorMix.rows,
      sidesMix: sidesMix.rows,
      dailyVolume: dailyVolume.rows,
      topShops: topShops.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/reviews
// Auth required. Every review across every shop - real and fake, visible
// and hidden - with the shop name attached, so admin can moderate the
// platform-wide front-page feed (see routes/reviews.js) without having to
// open each shop individually. GET /shops/:shopId/reviews below still
// exists for the per-shop view inside a shop's own detail page.
router.get('/reviews', requireAdminAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.shop_id AS "shopId", s.name AS "shopName",
              r.rating, r.comment, r.author_name AS "authorName", r.source, r.visible,
              r.sort_order AS "sortOrder", r.created_at AS "createdAt"
       FROM reviews r
       JOIN shops s ON s.id = r.shop_id
       ORDER BY r.sort_order DESC, r.created_at DESC`
    );
    return res.status(200).json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/reviews
// Auth required. body: { shopId, rating, comment?, authorName }
// Same as POST /shops/:shopId/reviews below, but for the global Reviews tab
// where the shop is picked from a dropdown rather than already being on
// that shop's own page.
router.post('/reviews', requireAdminAuth, async (req, res, next) => {
  try {
    const { shopId, rating, comment, authorName } = req.body || {};

    if (!shopId || typeof shopId !== 'string') {
      return res.status(400).json({ error: 'shopId is required' });
    }
    const { rows: shopRows } = await pool.query('SELECT id, name FROM shops WHERE id = $1', [shopId]);
    if (shopRows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be a whole number from 1 to 5' });
    }
    if (!authorName || typeof authorName !== 'string' || !authorName.trim()) {
      return res.status(400).json({ error: 'authorName is required' });
    }
    const commentValue = typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 1000) : null;

    const id = randomUUID();
    await pool.query(
      `INSERT INTO reviews (id, shop_id, job_id, rating, comment, author_name, source, visible, created_at)
       VALUES ($1, $2, NULL, $3, $4, $5, 'fake', TRUE, NOW())`,
      [id, shopId, rating, commentValue, authorName.trim()]
    );

    return res.status(201).json({
      id,
      shopId,
      shopName: shopRows[0].name,
      rating,
      comment: commentValue,
      authorName: authorName.trim(),
      source: 'fake',
      visible: true,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/shops/:shopId/reviews
// Auth required. Every review for a shop - real and fake, visible and
// hidden - for moderation. (The public GET /api/shops/:shopId/reviews only
// ever returns visible ones; this is the admin-only superset.)
router.get('/shops/:shopId/reviews', requireAdminAuth, async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { rows } = await pool.query(
      `SELECT id, rating, comment, author_name AS "authorName", source, visible,
              created_at AS "createdAt"
       FROM reviews WHERE shop_id = $1 ORDER BY sort_order DESC, created_at DESC`,
      [shopId]
    );
    return res.status(200).json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/shops/:shopId/reviews
// Auth required. body: { rating, comment?, authorName }
// Creates an admin-authored review (source: 'fake') - renders identically to
// a real student review everywhere a student sees it. Meant to seed early
// social proof before there's enough real order volume for genuine reviews
// to carry a new shop - not a permanent substitute; the admin should phase
// these out (hide or delete) as real ones accumulate.
router.post('/shops/:shopId/reviews', requireAdminAuth, async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const { rating, comment, authorName } = req.body || {};

    const { rows: shopRows } = await pool.query('SELECT id FROM shops WHERE id = $1', [shopId]);
    if (shopRows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be a whole number from 1 to 5' });
    }
    if (!authorName || typeof authorName !== 'string' || !authorName.trim()) {
      return res.status(400).json({ error: 'authorName is required' });
    }
    const commentValue = typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 1000) : null;

    const id = randomUUID();
    await pool.query(
      `INSERT INTO reviews (id, shop_id, job_id, rating, comment, author_name, source, visible, created_at)
       VALUES ($1, $2, NULL, $3, $4, $5, 'fake', TRUE, NOW())`,
      [id, shopId, rating, commentValue, authorName.trim()]
    );

    return res.status(201).json({
      id,
      rating,
      comment: commentValue,
      authorName: authorName.trim(),
      source: 'fake',
      visible: true,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/reviews/:reviewId
// Auth required. body: { visible: boolean } -> the updated review
// Hides or re-shows a review (real or fake) without deleting it - useful
// for pulling a real review that's abusive/spam without losing the record,
// or temporarily unpublishing a fake one.
router.patch('/reviews/:reviewId', requireAdminAuth, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const { visible } = req.body || {};
    if (typeof visible !== 'boolean') {
      return res.status(400).json({ error: 'visible must be a boolean' });
    }

    const { rows } = await pool.query(
      `UPDATE reviews SET visible = $1 WHERE id = $2
       RETURNING id, rating, comment, author_name AS "authorName", source, visible, created_at AS "createdAt"`,
      [visible, reviewId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Review not found' });
    }

    return res.status(200).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/reviews/:reviewId/move
// Auth required. body: { direction: "up" | "down" } -> the full reordered list
// Swaps a review's position with its immediate neighbor in the current
// display order (sort_order DESC, created_at DESC) - "up" moves it toward
// the top of the platform-wide front-page feed and every shop's own list,
// "down" toward the bottom. Before swapping, every review's sort_order is
// renumbered to match its current visual position (dense, strictly
// descending integers) - most reviews start at the same default (0), so a
// raw value-swap between two equal sort_orders would do nothing; this
// guarantees the two being swapped always end up with genuinely different
// values, and that every future move keeps behaving predictably.
router.post('/reviews/:reviewId/move', requireAdminAuth, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const { direction } = req.body || {};
    if (direction !== 'up' && direction !== 'down') {
      return res.status(400).json({ error: 'direction must be "up" or "down"' });
    }

    const { rows: ordered } = await pool.query(
      `SELECT id FROM reviews ORDER BY sort_order DESC, created_at DESC`
    );
    const index = ordered.findIndex((r) => r.id === reviewId);
    if (index === -1) {
      return res.status(404).json({ error: 'Review not found' });
    }

    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= ordered.length) {
      // Already at the top/bottom - nothing to do, not an error.
      return res.status(200).json({ ok: true, moved: false });
    }

    // Renumber everything to its current position (highest number = top),
    // then swap the two positions being moved.
    const n = ordered.length;
    const newOrders = ordered.map((r, i) => ({ id: r.id, sortOrder: n - i }));
    const a = newOrders[index];
    const b = newOrders[swapIndex];
    [a.sortOrder, b.sortOrder] = [b.sortOrder, a.sortOrder];

    for (const row of newOrders) {
      await pool.query('UPDATE reviews SET sort_order = $1 WHERE id = $2', [row.sortOrder, row.id]);
    }

    return res.status(200).json({ ok: true, moved: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/reviews/:reviewId
// Auth required. -> { ok: true }
router.delete('/reviews/:reviewId', requireAdminAuth, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const { rowCount } = await pool.query('DELETE FROM reviews WHERE id = $1', [reviewId]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Review not found' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
