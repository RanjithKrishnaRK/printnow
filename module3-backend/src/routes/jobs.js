// src/routes/jobs.js
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { pool } = require('../db');
const { requireShopAuth } = require('../auth');
const { generateTokenNumber } = require('../tokenGenerator');
const { notifyStudent } = require('../notify');
const { UPLOAD_DIR, RAZORPAY_KEY_ID, STUDENT_APP_URL } = require('../config');
const { getClient, verifyPaymentSignature } = require('../razorpay');
const { createOrder: createCashfreeOrder, getOrder: getCashfreeOrder, createOrderSplit } = require('../cashfree');
const { getPaymentFees, computeFeeBreakdown } = require('../settings');
const { isValidUploadedFileUrl } = require('../uploadUrl');

const router = express.Router();

const SHOP_SETTABLE_STATUSES = ['printing', 'ready', 'collected'];

// POST /api/jobs/:jobId/razorpay/create-order
// Public. -> { orderId, amount, currency, keyId, jobId }
// amount always comes from the job's own amount_due (never a client-
// supplied number) and is converted to paise, since Razorpay orders are
// denominated in the smallest currency unit. This mints a gateway order
// but does NOT change the job's status - only a verified payment does.
router.post('/:jobId/razorpay/create-order', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { rows } = await pool.query(
      `SELECT pj.*, s.razorpay_key_id AS shop_razorpay_key_id, s.razorpay_key_secret AS shop_razorpay_key_secret
       FROM print_jobs pj JOIN shops s ON s.id = pj.shop_id WHERE pj.id = $1`,
      [jobId]
    );
    const job = rows[0];
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'uploaded') {
      return res.status(409).json({
        error: `Cannot start payment for a job in status "${job.status}" (expected "uploaded")`,
      });
    }

    const fees = await getPaymentFees();
    const baseAmount = job.amount_due;
    const { serviceFee, gatewayFee, totalAmount } = computeFeeBreakdown(baseAmount, fees);

    // Use the shop's own Razorpay account if they've configured one - the
    // whole order (print cost + fees) then lands directly with them,
    // instead of the platform's pooled account. accountKeyId is stamped
    // onto the job below so verify (and later, commission accounting)
    // know exactly which account was actually used for THIS payment, even
    // if the shop changes their keys afterward.
    const usingShopAccount = Boolean(job.shop_razorpay_key_id && job.shop_razorpay_key_secret);
    const razorpay = getClient(
      usingShopAccount ? { keyId: job.shop_razorpay_key_id, keySecret: job.shop_razorpay_key_secret } : {}
    );
    const accountKeyId = usingShopAccount ? job.shop_razorpay_key_id : RAZORPAY_KEY_ID;
    const order = await razorpay.orders.create({
      amount: totalAmount * 100,
      currency: 'INR',
      receipt: `job_${jobId}`,
      notes: { jobId },
    });

    await pool.query(
      `UPDATE print_jobs
       SET razorpay_order_id = $1, service_fee = $2, gateway_fee = $3,
           razorpay_account_key_id = $4, updated_at = NOW()
       WHERE id = $5`,
      [order.id, serviceFee, gatewayFee, accountKeyId, jobId]
    );

    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: accountKeyId,
      jobId,
      baseAmount,
      serviceFee,
      gatewayFee,
      totalAmount,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:jobId/razorpay/verify
// Public. body: { razorpayOrderId, razorpayPaymentId, razorpaySignature }
// -> { jobId, status: "queued", tokenNumber }
// The only place an online payment is trusted - see razorpay.js for why
// the signature (not the browser's "success" callback) is what's checked.
// Goes straight to "queued", skipping payment_pending entirely: unlike
// UPI/cash there's no shop owner confirmation step left to wait on, the
// gateway already did the verifying server-side-to-server-side.
router.post('/:jobId/razorpay/verify', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({
        error: 'razorpayOrderId, razorpayPaymentId and razorpaySignature are required',
      });
    }

    const { rows } = await pool.query(
      `SELECT pj.*, s.razorpay_key_id AS shop_razorpay_key_id, s.razorpay_key_secret AS shop_razorpay_key_secret
       FROM print_jobs pj JOIN shops s ON s.id = pj.shop_id WHERE pj.id = $1`,
      [jobId]
    );
    const job = rows[0];
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Verify with whichever account's secret actually created this order -
    // the shop's own, if that's what razorpay_account_key_id (stamped at
    // create-order) says was used AND still matches their current key
    // (guards against a shop clearing/rotating keys mid-payment); the
    // platform's own secret otherwise.
    const usingShopAccount =
      job.razorpay_account_key_id &&
      job.razorpay_account_key_id === job.shop_razorpay_key_id &&
      Boolean(job.shop_razorpay_key_secret);
    const valid = verifyPaymentSignature({
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature,
      keySecret: usingShopAccount ? job.shop_razorpay_key_secret : undefined,
    });
    if (!valid) {
      return res.status(400).json({ error: 'Payment could not be verified' });
    }

    // Idempotent: a retried/duplicate verify call for a job already queued
    // by this exact payment just returns the existing result instead of
    // erroring, since the frontend may legitimately call this twice (e.g.
    // a flaky network after the first call actually succeeded).
    if (job.status !== 'uploaded') {
      if (job.razorpay_payment_id === razorpayPaymentId) {
        return res.status(200).json({ jobId, status: job.status, tokenNumber: job.token_number });
      }
      return res.status(409).json({
        error: `Cannot verify payment for a job in status "${job.status}" (expected "uploaded")`,
      });
    }
    if (job.razorpay_order_id && job.razorpay_order_id !== razorpayOrderId) {
      return res.status(400).json({ error: 'Order does not match this job' });
    }

    const tokenNumber = await generateTokenNumber(job.shop_id);
    await pool.query(
      `UPDATE print_jobs
       SET status = 'queued', token_number = $1, payment_method = 'razorpay',
           razorpay_order_id = $2, razorpay_payment_id = $3, updated_at = NOW()
       WHERE id = $4`,
      [tokenNumber, razorpayOrderId, razorpayPaymentId, jobId]
    );

    return res.status(200).json({ jobId, status: 'queued', tokenNumber });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:jobId/cashfree/create-order
// Public. -> { paymentSessionId, cashfreeOrderId, jobId, baseAmount, serviceFee, gatewayFee, totalAmount, splitConfigured }
// Cashfree equivalent of the Razorpay route above - same fee computation,
// same "amount always comes from the job's own amount_due" rule. The
// difference: if this shop has completed vendor (bank account)
// onboarding (see POST /api/shops/:shopId/vendor), a split is attached so
// baseAmount (the print cost, NOT the platform's service/gateway fee)
// settles straight to the shop's own bank account - splitConfigured tells
// the frontend whether that actually happened, purely informational.
// A shop that hasn't onboarded yet still works exactly as before: the
// full amount goes to this platform's own Cashfree balance, unsplit.
router.post('/:jobId/cashfree/create-order', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { rows } = await pool.query(
      `SELECT pj.*, s.cashfree_vendor_id, s.vendor_status
       FROM print_jobs pj JOIN shops s ON s.id = pj.shop_id
       WHERE pj.id = $1`,
      [jobId]
    );
    const job = rows[0];
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'uploaded') {
      return res.status(409).json({
        error: `Cannot start payment for a job in status "${job.status}" (expected "uploaded")`,
      });
    }

    const fees = await getPaymentFees();
    const baseAmount = job.amount_due;
    const { serviceFee, gatewayFee, totalAmount } = computeFeeBreakdown(baseAmount, fees);

    const cashfreeOrderId = `job_${jobId}_${Date.now()}`;
    const order = await createCashfreeOrder({
      orderId: cashfreeOrderId,
      amount: totalAmount,
      customerPhone: job.student_phone,
      returnUrl: `${STUDENT_APP_URL}?jobId=${jobId}&cfOrderId={order_id}`,
    });

    let splitConfigured = false;
    if (job.cashfree_vendor_id && job.vendor_status && job.vendor_status !== 'REJECTED') {
      try {
        await createOrderSplit({ orderId: cashfreeOrderId, vendorId: job.cashfree_vendor_id, vendorAmount: baseAmount });
        splitConfigured = true;
      } catch (splitErr) {
        // Non-fatal - the payment itself still works, it just settles
        // fully into this platform's own balance this time instead of
        // splitting, same as if the shop hadn't onboarded at all. Logged
        // clearly so this doesn't go unnoticed if it starts happening a lot.
        // eslint-disable-next-line no-console
        console.error(`Cashfree split failed for job ${jobId}:`, splitErr.message, splitErr.cashfreeResponse);
      }
    }

    await pool.query(
      `UPDATE print_jobs
       SET cashfree_order_id = $1, service_fee = $2, gateway_fee = $3, updated_at = NOW()
       WHERE id = $4`,
      [cashfreeOrderId, serviceFee, gatewayFee, jobId]
    );

    return res.status(200).json({
      paymentSessionId: order.payment_session_id,
      cashfreeOrderId,
      jobId,
      baseAmount,
      serviceFee,
      gatewayFee,
      totalAmount,
      splitConfigured,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:jobId/cashfree/verify
// Public. body: { cashfreeOrderId } -> { jobId, status: "queued", tokenNumber }
// Cashfree's checkout redirects the browser back to STUDENT_APP_URL with
// the order id in the query string (see create-order above) rather than
// handing back anything like Razorpay's client-side signature - so there
// is nothing to "verify" from what the client submits. This is purely a
// pointer: the actual confirmation is the server-to-server
// getCashfreeOrder call below, asking Cashfree directly what that order's
// real status is. A client claiming a fake cashfreeOrderId just gets a
// 404/mismatch, never a queued job.
router.post('/:jobId/cashfree/verify', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { cashfreeOrderId } = req.body || {};
    if (!cashfreeOrderId) {
      return res.status(400).json({ error: 'cashfreeOrderId is required' });
    }

    const { rows } = await pool.query('SELECT * FROM print_jobs WHERE id = $1', [jobId]);
    const job = rows[0];
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Idempotent, same reasoning as the Razorpay route above - a retried
    // verify call for a job already queued by this exact order just
    // returns the existing result rather than erroring.
    if (job.status !== 'uploaded') {
      if (job.cashfree_order_id === cashfreeOrderId) {
        return res.status(200).json({ jobId, status: job.status, tokenNumber: job.token_number });
      }
      return res.status(409).json({
        error: `Cannot verify payment for a job in status "${job.status}" (expected "uploaded")`,
      });
    }
    if (job.cashfree_order_id !== cashfreeOrderId) {
      return res.status(400).json({ error: 'Order does not match this job' });
    }

    const order = await getCashfreeOrder(cashfreeOrderId);
    if (order.order_status !== 'PAID') {
      return res.status(400).json({ error: `Payment not completed yet (status: ${order.order_status})` });
    }

    const tokenNumber = await generateTokenNumber(job.shop_id);
    await pool.query(
      `UPDATE print_jobs
       SET status = 'queued', token_number = $1, payment_method = 'cashfree', updated_at = NOW()
       WHERE id = $2`,
      [tokenNumber, jobId]
    );

    return res.status(200).json({ jobId, status: 'queued', tokenNumber });
  } catch (err) {
    next(err);
  }
});

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
    if (method === 'upi' && !isValidUploadedFileUrl(screenshotUrl)) {
      return res.status(400).json({ error: 'screenshotUrl must reference a file uploaded through this platform' });
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
              pj.payment_rejection_reason AS "paymentRejectionReason",
              pj.service_fee AS "serviceFee", pj.gateway_fee AS "gatewayFee"
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
