// src/routes/webhooks.js
//
// Cashfree's redirect-based checkout means the primary confirmation path
// is POST /api/jobs/:jobId/cashfree/verify, called by the student's own
// browser after Cashfree redirects it back (see routes/jobs.js). But a
// browser can fail to make it back - closed tab, flaky connection right
// after paying, killed mobile app - leaving a real payment with no job
// ever queued. This webhook is Cashfree calling US directly the moment a
// payment succeeds, independent of what the student's browser does next,
// so that failure mode gets caught too. Whichever path (verify or
// webhook) arrives first queues the job; the other is a no-op via the
// same idempotency check the /verify routes already use.
//
// Mounted in app.js BEFORE the global express.json() middleware, with its
// own express.raw() parser - webhook signature verification needs the
// exact raw bytes Cashfree sent, not a re-serialized JSON.parse/stringify
// round-trip, which can differ in whitespace/key order and would make a
// genuine webhook fail verification.
const express = require('express');
const { pool } = require('../db');
const { verifyWebhookSignature } = require('../cashfree');
const { generateTokenNumber } = require('../tokenGenerator');

const router = express.Router();

router.post('/cashfree', express.raw({ type: '*/*' }), async (req, res, next) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const timestamp = req.headers['x-webhook-timestamp'];
    const signature = req.headers['x-webhook-signature'];

    const valid = verifyWebhookSignature({ rawBody, timestamp, signature });
    if (!valid) {
      // Deliberately vague and a 400, not 401/403 - doesn't help a bad
      // actor learn anything about why verification failed.
      return res.status(400).json({ error: 'Invalid webhook' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (parseErr) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    if (payload.type !== 'PAYMENT_SUCCESS_WEBHOOK') {
      // Acknowledge and ignore - Cashfree sends other event types
      // (PAYMENT_FAILED_WEBHOOK, etc.) this endpoint doesn't need to act
      // on; returning 200 stops Cashfree from retrying an event that was
      // never going to be actionable here.
      return res.status(200).json({ ok: true });
    }

    const cashfreeOrderId = payload.data?.order?.order_id;
    if (!cashfreeOrderId || typeof cashfreeOrderId !== 'string') {
      return res.status(200).json({ ok: true });
    }

    // order_id was minted as either job_<jobId>_<timestamp> or
    // batch_<batchId>_<timestamp> at create-order time (see routes/jobs.js
    // and routes/batches.js) - which table to update comes from that
    // prefix, not from anything else in the webhook payload.
    if (cashfreeOrderId.startsWith('job_')) {
      const { rows } = await pool.query('SELECT * FROM print_jobs WHERE cashfree_order_id = $1', [
        cashfreeOrderId,
      ]);
      const job = rows[0];
      if (job && job.status === 'uploaded') {
        const tokenNumber = await generateTokenNumber(job.shop_id);
        await pool.query(
          `UPDATE print_jobs
           SET status = 'queued', token_number = $1, payment_method = 'cashfree', updated_at = NOW()
           WHERE id = $2`,
          [tokenNumber, job.id]
        );
      }
    } else if (cashfreeOrderId.startsWith('batch_')) {
      const { rows } = await pool.query('SELECT * FROM batches WHERE cashfree_order_id = $1', [
        cashfreeOrderId,
      ]);
      const batch = rows[0];
      if (batch && batch.status === 'uploaded') {
        const tokenNumber = await generateTokenNumber(batch.shop_id);
        await pool.query(
          `UPDATE batches
           SET status = 'queued', token_number = $1, payment_method = 'cashfree', updated_at = NOW()
           WHERE id = $2`,
          [tokenNumber, batch.id]
        );
        await pool.query(
          `UPDATE print_jobs
           SET status = 'queued', token_number = $1, payment_method = 'cashfree', updated_at = NOW()
           WHERE batch_id = $2`,
          [tokenNumber, batch.id]
        );
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
