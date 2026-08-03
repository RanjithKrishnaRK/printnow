// src/routes/batches.js
const express = require('express');
const { pool } = require('../db');
const { generateTokenNumber } = require('../tokenGenerator');

const router = express.Router();

// POST /api/batches/:batchId/payment
// Public. body: { paymentRef } -> { batchId, status: "queued", tokenNumber }
// One combined payment for the whole order: mints a single token number and
// advances the batch AND every document in it to "queued" together. Mirrors
// POST /api/jobs/:jobId/payment's trust-the-paymentRef MVP simplification -
// see that route's comment for the real-payment-verification caveat.
router.post('/:batchId/payment', async (req, res, next) => {
  try {
    const { batchId } = req.params;
    const { paymentRef } = req.body || {};

    if (!paymentRef || typeof paymentRef !== 'string') {
      return res.status(400).json({ error: 'paymentRef is required' });
    }

    const { rows } = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    const batch = rows[0];
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    if (batch.status !== 'uploaded') {
      return res.status(409).json({
        error: `Cannot pay for a batch in status "${batch.status}" (expected "uploaded")`,
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

// GET /api/batches/:batchId
// Public. -> { batchId, status, tokenNumber, shopName, amountDue, createdAt, documents }
// Powers the student app's status screen for a multi-doc order.
router.get('/:batchId', async (req, res, next) => {
  try {
    const { batchId } = req.params;

    const { rows } = await pool.query(
      `SELECT b.id AS "batchId", b.status, b.token_number AS "tokenNumber",
              s.name AS "shopName", b.amount_due AS "amountDue", b.created_at AS "createdAt"
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
