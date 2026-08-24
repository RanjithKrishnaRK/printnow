// src/routes/batches.js
const express = require('express');
const { pool } = require('../db');
const { requireShopAuth } = require('../auth');
const { generateTokenNumber } = require('../tokenGenerator');
const { RAZORPAY_KEY_ID } = require('../config');
const { getClient, verifyPaymentSignature } = require('../razorpay');
const { getPaymentFees, computeFeeBreakdown } = require('../settings');
const { isValidUploadedFileUrl } = require('../uploadUrl');

const router = express.Router();

// POST /api/batches/:batchId/razorpay/create-order
// Public. -> { orderId, amount, currency, keyId, batchId }
// Mirrors POST /api/jobs/:jobId/razorpay/create-order - one order for the
// whole batch's combined amount_due, same as UPI/cash already do.
router.post('/:batchId/razorpay/create-order', async (req, res, next) => {
  try {
    const { batchId } = req.params;
    const { rows } = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = rows[0];
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    if (batch.status !== 'uploaded') {
      return res.status(409).json({
        error: `Cannot start payment for a batch in status "${batch.status}" (expected "uploaded")`,
      });
    }

    const fees = await getPaymentFees();
    const baseAmount = batch.amount_due;
    const { serviceFee, gatewayFee, totalAmount } = computeFeeBreakdown(baseAmount, fees);

    const razorpay = getClient();
    const order = await razorpay.orders.create({
      amount: totalAmount * 100,
      currency: 'INR',
      receipt: `batch_${batchId}`,
      notes: { batchId },
    });

    await pool.query(
      `UPDATE batches
       SET razorpay_order_id = $1, service_fee = $2, gateway_fee = $3, updated_at = NOW()
       WHERE id = $4`,
      [order.id, serviceFee, gatewayFee, batchId]
    );

    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_KEY_ID,
      batchId,
      baseAmount,
      serviceFee,
      gatewayFee,
      totalAmount,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/batches/:batchId/razorpay/verify
// Public. body: { razorpayOrderId, razorpayPaymentId, razorpaySignature }
// -> { batchId, status: "queued", tokenNumber }
// Same trust boundary as the per-job version - see razorpay.js. On success,
// mints one token for the whole batch and mirrors it onto every print_jobs
// row under it, exactly like confirm-payment already does for UPI/cash.
router.post('/:batchId/razorpay/verify', async (req, res, next) => {
  try {
    const { batchId } = req.params;
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({
        error: 'razorpayOrderId, razorpayPaymentId and razorpaySignature are required',
      });
    }

    const valid = verifyPaymentSignature({
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature,
    });
    if (!valid) {
      return res.status(400).json({ error: 'Payment could not be verified' });
    }

    const { rows } = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = rows[0];
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    if (batch.status !== 'uploaded') {
      if (batch.razorpay_payment_id === razorpayPaymentId) {
        return res.status(200).json({ batchId, status: batch.status, tokenNumber: batch.token_number });
      }
      return res.status(409).json({
        error: `Cannot verify payment for a batch in status "${batch.status}" (expected "uploaded")`,
      });
    }
    if (batch.razorpay_order_id && batch.razorpay_order_id !== razorpayOrderId) {
      return res.status(400).json({ error: 'Order does not match this batch' });
    }

    const tokenNumber = await generateTokenNumber(batch.shop_id);
    await pool.query(
      `UPDATE batches
       SET status = 'queued', token_number = $1, payment_method = 'razorpay',
           razorpay_order_id = $2, razorpay_payment_id = $3, updated_at = NOW()
       WHERE id = $4`,
      [tokenNumber, razorpayOrderId, razorpayPaymentId, batchId]
    );
    await pool.query(
      `UPDATE print_jobs
       SET status = 'queued', token_number = $1, payment_method = 'razorpay', updated_at = NOW()
       WHERE batch_id = $2`,
      [tokenNumber, batchId]
    );

    return res.status(200).json({ batchId, status: 'queued', tokenNumber });
  } catch (err) {
    next(err);
  }
});

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
    if (method === 'upi' && !isValidUploadedFileUrl(screenshotUrl)) {
      return res.status(400).json({ error: 'screenshotUrl must reference a file uploaded through this platform' });
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
              b.payment_rejection_reason AS "paymentRejectionReason",
              b.service_fee AS "serviceFee", b.gateway_fee AS "gatewayFee"
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
