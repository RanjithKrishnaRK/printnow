// src/routes/batches.js
const express = require('express');
const { pool } = require('../db');
const { requireShopAuth } = require('../auth');
const { generateTokenNumber } = require('../tokenGenerator');

const router = express.Router();

// POST /api/batches/:batchId/submit-payment
// Public. body: { method: "upi" | "cash", screenshotUrl? }
// -> { batchId, status: "payment_pending" }
// One combined submission covers every document in the batch - mirrors
// POST /api/jobs/:jobId/submit-payment, see that route's comment for the
// full rationale. Never mints a token itself; only confirm-payment does.
router.post('/:batchId/submit-payment', async (req, res, next) => {
  try {
    const { batchId } = req.params;
    const { method, screenshotUrl } = req.body || {};

    if (method !== 'upi' && method !== 'cash') {
      return res.status(400).json({ error: 'method must be "upi" or "cash"' });
    }
    if (method === 'upi' && (!screenshotUrl || typeof screenshotUrl !== 'string')) {
      return res.status(400).json({ error: 'screenshotUrl is required for method "upi"' });
    }

    const { rows } = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = rows[0];
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    if (batch.status !== 'uploaded') {
      return res.status(409).json({
        error: `Cannot submit payment for a batch in status "${batch.status}" (expected "uploaded")`,
      });
    }

    const screenshotValue = method === 'upi' ? screenshotUrl : null;
    await pool.query(
      `UPDATE batches
       SET status = 'payment_pending', payment_method = $1, payment_screenshot_url = $2,
           payment_rejection_reason = NULL, updated_at = NOW()
       WHERE id = $3`,
      [method, screenshotValue, batchId]
    );
    // Documents mirror the batch's payment fields too, so a shop owner
    // scanning the plain per-job list (outside the batch grouping) still
    // sees consistent status/evidence per row.
    await pool.query(
      `UPDATE print_jobs
       SET status = 'payment_pending', payment_method = $1, payment_screenshot_url = $2,
           payment_rejection_reason = NULL, updated_at = NOW()
       WHERE batch_id = $3`,
      [method, screenshotValue, batchId]
    );

    return res.status(200).json({ batchId, status: 'payment_pending' });
  } catch (err) {
    next(err);
  }
});

// POST /api/batches/:batchId/confirm-payment
// Shop-owner-only (JWT required). -> { batchId, status: "queued", tokenNumber }
router.post('/:batchId/confirm-payment', requireShopAuth, async (req, res, next) => {
  try {
    const { batchId } = req.params;
    const { rows } = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = rows[0];
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    if (batch.shop_id !== req.shopId) {
      return res.status(403).json({ error: 'This batch does not belong to your shop' });
    }
    if (batch.status !== 'payment_pending') {
      return res.status(409).json({
        error: `Cannot confirm payment for a batch in status "${batch.status}" (expected "payment_pending")`,
      });
    }

    const tokenNumber = await generateTokenNumber(batch.shop_id);
    await pool.query(
      `UPDATE batches SET status = 'queued', token_number = $1, updated_at = NOW() WHERE id = $2`,
      [tokenNumber, batchId]
    );
    await pool.query(
      `UPDATE print_jobs SET status = 'queued', token_number = $1, updated_at = NOW() WHERE batch_id = $2`,
      [tokenNumber, batchId]
    );

    return res.status(200).json({ batchId, status: 'queued', tokenNumber });
  } catch (err) {
    next(err);
  }
});

// POST /api/batches/:batchId/reject-payment
// Shop-owner-only (JWT required). body: { reason? } -> { batchId, status: "uploaded" }
router.post('/:batchId/reject-payment', requireShopAuth, async (req, res, next) => {
  try {
    const { batchId } = req.params;
    const { reason } = req.body || {};
    const { rows } = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = rows[0];
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    if (batch.shop_id !== req.shopId) {
      return res.status(403).json({ error: 'This batch does not belong to your shop' });
    }
    if (batch.status !== 'payment_pending') {
      return res.status(409).json({
        error: `Cannot reject payment for a batch in status "${batch.status}" (expected "payment_pending")`,
      });
    }

    const reasonValue = typeof reason === 'string' && reason.trim() ? reason.trim() : 'Payment could not be verified';
    await pool.query(
      `UPDATE batches
       SET status = 'uploaded', payment_method = NULL, payment_screenshot_url = NULL,
           payment_rejection_reason = $1, updated_at = NOW()
       WHERE id = $2`,
      [reasonValue, batchId]
    );
    await pool.query(
      `UPDATE print_jobs
       SET status = 'uploaded', payment_method = NULL, payment_screenshot_url = NULL,
           payment_rejection_reason = $1, updated_at = NOW()
       WHERE batch_id = $2`,
      [reasonValue, batchId]
    );

    return res.status(200).json({ batchId, status: 'uploaded' });
  } catch (err) {
    next(err);
  }
});

// GET /api/batches/:batchId
// Public. -> { batchId, status, tokenNumber, shopName, shopUpiId, amountDue,
//              createdAt, paymentMethod, paymentScreenshotUrl, paymentRejectionReason, documents }
// Powers the student app's status screen for a multi-doc order.
router.get('/:batchId', async (req, res, next) => {
  try {
    const { batchId } = req.params;

    const { rows } = await pool.query(
      `SELECT b.id AS "batchId", b.status, b.token_number AS "tokenNumber",
              s.name AS "shopName", s.upi_id AS "shopUpiId",
              b.amount_due AS "amountDue", b.created_at AS "createdAt",
              b.payment_method AS "paymentMethod",
              b.payment_screenshot_url AS "paymentScreenshotUrl",
              b.payment_rejection_reason AS "paymentRejectionReason"
       FROM batches b
       JOIN shops s ON s.id = b.shop_id
       WHERE b.id = $1`,
      [batchId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    const { rows: docRows } = await pool.query(
      `SELECT id AS "jobId", file_name AS "fileName", pages, copies,
              color_mode AS "colorMode", color_pages AS "colorPages", sides,
              amount_due AS "amountDue", status
       FROM print_jobs WHERE batch_id = $1 ORDER BY created_at ASC`,
      [batchId]
    );

    return res.status(200).json({ ...rows[0], documents: docRows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
