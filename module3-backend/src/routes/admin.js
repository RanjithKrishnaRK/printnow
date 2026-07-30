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

const router = express.Router();

// POST /api/admin/login
// body: { email, password } -> { token }
router.post('/login', async (req, res, next) => {
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

// GET /api/admin/shops
// Auth required. All shops platform-wide, with landmark name and a job
// count, for the admin's shop list view.
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
        COALESCE(SUM(CASE WHEN pj.status != 'uploaded' THEN pj.amount_due ELSE 0 END), 0)::int AS "totalRevenue"
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
      // Revenue only counts jobs that actually got paid for (paid or later
      // in the lifecycle) - an "uploaded" job that was never paid isn't
      // real revenue yet.
      pool.query(`
        SELECT COALESCE(SUM(amount_due), 0)::int AS "totalRevenue"
        FROM print_jobs WHERE status != 'uploaded'
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

module.exports = router;
