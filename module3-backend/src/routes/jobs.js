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

// POST /api/jobs/:jobId/submit-payment
// Public. body: { method: "upi" | "cash", screenshotUrl? }
// -> { jobId, status: "payment_pending" }
// Replaces the old trust-a-paymentRef auto-confirm: this never mints a
// token by itself. It just records what the student says they did (paid via
// UPI with this screenshot as proof, or will pay cash at the counter) and
// waits for the shop owner's own confirm-payment/reject-payment call below -
// same "human backstop" as a shop owner glancing at their soundbox today.
// screenshotUrl is required for 'upi' (student uploads it via
// POST /api/uploads/payment-screenshot first) and ignored for 'cash' - the
// cash path has no evidence beyond the shop owner's own eyes at the counter.
router.post('/:jobId/submit-payment', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { method, screenshotUrl } = req.body || {};

    if (method !== 'upi' && method !== 'cash') {
      return res.status(400).json({ error: 'method must be "upi" or "cash"' });
    }
    if (method === 'upi' && (!screenshotUrl || typeof screenshotUrl !== 'string')) {
      return res.status(400).json({ error: 'screenshotUrl is required for method "upi"' });
    }

    const { rows } = await pool.query('SELECT * FROM print_jobs WHERE id = $1', [jobId]);
    const job = rows[0];
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'uploaded') {
      return res.status(409).json({
        error: `Cannot submit payment for a job in status "${job.status}" (expected "uploaded")`,
      });
    }

    await pool.query(
      `UPDATE print_jobs
       SET status = 'payment_pending', payment_method = $1, payment_screenshot_url = $2,
           payment_rejection_reason = NULL, updated_at = NOW()
       WHERE id = $3`,
      [method, method === 'upi' ? screenshotUrl : null, jobId]
    );

    return res.status(200).json({ jobId, status: 'payment_pending' });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:jobId/confirm-payment
// Shop-owner-only (JWT required). -> { jobId, status: "queued", tokenNumber }
// The actual moment a token gets minted - only reachable after the shop
// owner has looked at the screenshot (or received the cash) and confirmed
// it themselves.
router.post('/:jobId/confirm-payment', requireShopAuth, async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { rows } = await pool.query('SELECT * FROM print_jobs WHERE id = $1', [jobId]);
    const job = rows[0];
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.shop_id !== req.shopId) {
      return res.status(403).json({ error: 'This job does not belong to your shop' });
    }
    if (job.status !== 'payment_pending') {
      return res.status(409).json({
        error: `Cannot confirm payment for a job in status "${job.status}" (expected "payment_pending")`,
      });
    }

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

// POST /api/jobs/:jobId/reject-payment
// Shop-owner-only (JWT required). body: { reason? }
// -> { jobId, status: "uploaded" }
// Sends it back to the student to retry (bad/unclear screenshot, cash never
// actually handed over, wrong amount, etc) - clears the prior payment
// attempt so submit-payment can be called again.
router.post('/:jobId/reject-payment', requireShopAuth, async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { reason } = req.body || {};
    const { rows } = await pool.query('SELECT * FROM print_jobs WHERE id = $1', [jobId]);
    const job = rows[0];
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.shop_id !== req.shopId) {
      return res.status(403).json({ error: 'This job does not belong to your shop' });
    }
    if (job.status !== 'payment_pending') {
      return res.status(409).json({
        error: `Cannot reject payment for a job in status "${job.status}" (expected "payment_pending")`,
      });
    }

    await pool.query(
      `UPDATE print_jobs
       SET status = 'uploaded', payment_method = NULL, payment_screenshot_url = NULL,
           payment_rejection_reason = $1, updated_at = NOW()
       WHERE id = $2`,
      [typeof reason === 'string' && reason.trim() ? reason.trim() : 'Payment could not be verified', jobId]
    );

    return res.status(200).json({ jobId, status: 'uploaded' });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:jobId
// Public. -> { jobId, status, tokenNumber, shopName, shopUpiId, amountDue,
//              createdAt, paymentMethod, paymentScreenshotUrl, paymentRejectionReason }
router.get('/:jobId', async (req, res, next) => {
  try {
    const { jobId } = req.params;

    const { rows } = await pool.query(
      `SELECT pj.id AS "jobId", pj.status, pj.token_number AS "tokenNumber",
              s.name AS "shopName", s.upi_id AS "shopUpiId",
              pj.amount_due AS "amountDue", pj.created_at AS "createdAt",
              pj.payment_method AS "paymentMethod",
              pj.payment_screenshot_url AS "paymentScreenshotUrl",
              pj.payment_rejection_reason AS "paymentRejectionReason"
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
