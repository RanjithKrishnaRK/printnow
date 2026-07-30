// src/routes/jobs.js
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { pool } = require('../db');
const { requireShopAuth } = require('../auth');
const { generateTokenNumber } = require('../tokenGenerator');
const { notifyStudent } = require('../notify');
const { UPLOAD_DIR } = require('../config');

const router = express.Router();

const SHOP_SETTABLE_STATUSES = ['printing', 'ready', 'collected'];

// POST /api/jobs/:jobId/payment
// Public. body: { paymentRef } -> { jobId, status: "paid", tokenNumber }
// On success: auto-advances uploaded -> paid -> queued and mints a token number.
router.post('/:jobId/payment', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { paymentRef } = req.body || {};

    if (!paymentRef || typeof paymentRef !== 'string') {
      return res.status(400).json({ error: 'paymentRef is required' });
    }

    const { rows } = await pool.query('SELECT * FROM print_jobs WHERE id = $1', [jobId]);
    const job = rows[0];
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status !== 'uploaded') {
      return res.status(409).json({
        error: `Cannot pay for a job in status "${job.status}" (expected "uploaded")`,
      });
    }

    // NOTE (MVP simplification): this endpoint trusts paymentRef as proof of
    // payment rather than verifying it against a Razorpay/UPI webhook. Real
    // payment verification (webhook signature check against the gateway)
    // should replace this before taking real money. Flagging clearly rather
    // than silently shipping a fake-secure version.
    const tokenNumber = await generateTokenNumber(job.shop_id);

    await pool.query(
      `UPDATE print_jobs SET status = 'queued', token_number = $1, updated_at = NOW() WHERE id = $2`,
      [tokenNumber, jobId]
    );

    return res.status(200).json({ jobId, status: 'queued', tokenNumber });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:jobId
// Public. -> { jobId, status, tokenNumber, shopName, amountDue, createdAt }
router.get('/:jobId', async (req, res, next) => {
  try {
    const { jobId } = req.params;

    const { rows } = await pool.query(
      `SELECT pj.id AS "jobId", pj.status, pj.token_number AS "tokenNumber",
              s.name AS "shopName", pj.amount_due AS "amountDue", pj.created_at AS "createdAt"
       FROM print_jobs pj
       JOIN shops s ON s.id = pj.shop_id
       WHERE pj.id = $1`,
      [jobId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.status(200).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/jobs/:jobId/status
// Shop-owner-only (JWT required). body: { status: "printing" | "ready" | "collected" }
router.patch('/:jobId/status', requireShopAuth, async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { status: newStatus } = req.body || {};

    if (!SHOP_SETTABLE_STATUSES.includes(newStatus)) {
      return res.status(400).json({
        error: `status must be one of: ${SHOP_SETTABLE_STATUSES.join(', ')}`,
      });
    }

    const { rows } = await pool.query('SELECT * FROM print_jobs WHERE id = $1', [jobId]);
    const job = rows[0];
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // A shop can only change jobs that belong to it (from its own JWT).
    if (job.shop_id !== req.shopId) {
      return res.status(403).json({ error: 'This job does not belong to your shop' });
    }

    const allowedTransitions = {
      queued: ['printing'],
      printing: ['ready'],
      ready: ['collected'],
    };

    const allowedNext = allowedTransitions[job.status] || [];
    if (!allowedNext.includes(newStatus)) {
      return res.status(409).json({
        error: `Cannot move from "${job.status}" to "${newStatus}"`,
      });
    }

    // Hourly page cap: only applies to queued -> printing, since that's the
    // moment pages actually go to a physical printer. Counts pages already
    // sent to print (pages * copies, per job) since the top of the current
    // clock hour - if this job would push the shop over its own cap, it's
    // simply left "queued" (i.e. auto-queued for the next open hour) rather
    // than rejected outright. Both the dashboard's manual "Send to printer"
    // click and the Module 6 auto-print agent hit this same endpoint, so
    // the cap is enforced identically for both.
    if (newStatus === 'printing') {
      const { rows: shopRows } = await pool.query(
        'SELECT max_pages_per_hour AS "maxPagesPerHour" FROM shops WHERE id = $1',
        [job.shop_id]
      );
      const maxPagesPerHour = shopRows[0]?.maxPagesPerHour;

      if (maxPagesPerHour) {
        const { rows: usageRows } = await pool.query(
          `SELECT COALESCE(SUM(pages * copies), 0)::int AS "pagesThisHour"
           FROM print_jobs
           WHERE shop_id = $1 AND printed_at >= date_trunc('hour', NOW())`,
          [job.shop_id]
        );
        const pagesThisHour = usageRows[0].pagesThisHour;
        const jobPages = job.pages * job.copies;

        // Allow a lone oversized job through only when the hour is
        // otherwise empty - a job bigger than the cap shouldn't be able to
        // starve forever, but a normal job should never be able to push
        // the shop over budget for the hour it's in.
        const overCap = pagesThisHour > 0 && pagesThisHour + jobPages > maxPagesPerHour;
        if (overCap) {
          const nextHour = new Date(Math.ceil(Date.now() / 3600000) * 3600000);
          return res.status(429).json({
            error: `Hourly print limit reached (${pagesThisHour}/${maxPagesPerHour} pages this hour). This job stays queued and will be tried again after ${nextHour.getHours()}:00.`,
            pagesThisHour,
            maxPagesPerHour,
            retryAfter: nextHour.toISOString(),
          });
        }
      }
    }

    const setPrintedAt = newStatus === 'printing' ? ', printed_at = NOW()' : '';
    await pool.query(
      `UPDATE print_jobs SET status = $1, updated_at = NOW()${setPrintedAt} WHERE id = $2`,
      [newStatus, jobId]
    );

    if (newStatus === 'ready') {
      notifyStudent(
        job.student_phone,
        `Your print job (token ${job.token_number}) is ready for pickup!`
      );
    }

    // Auto-delete the uploaded PDF once the student has collected it - it
    // has served its purpose (the shop already printed it) and there's no
    // reason to keep someone's assignment/notes sitting on disk indefinitely.
    // Best-effort: if the file's already gone or unreadable, log and move on
    // rather than failing the status update the shop owner is waiting on.
    if (newStatus === 'collected') {
      const localPath = path.join(
        path.resolve(UPLOAD_DIR),
        path.basename(job.file_url)
      );
      try {
        await fs.unlink(localPath);
        await pool.query('UPDATE print_jobs SET file_deleted_at = NOW() WHERE id = $1', [jobId]);
      } catch (fileErr) {
        console.warn(`Could not delete file for job ${jobId} at ${localPath}:`, fileErr.message);
      }
    }

    return res.status(200).json({ jobId, status: newStatus });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
