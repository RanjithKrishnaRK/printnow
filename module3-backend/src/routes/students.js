// src/routes/students.js
//
// Item #3 — student "login" by mobile number + order history.
//
// Deliberately no OTP, no account, no password: per the agreed trust level
// for this MVP (same call as trusting `paymentRef` at face value, or a shop
// signup with no email verification), a student "logs in" simply by typing
// the same phone number they ordered with. Whoever knows that number can
// see that number's order history — there is nothing stronger to check
// against, because there's no account record beyond the phone number
// already stored on each print_jobs row. Revisit with a real OTP provider
// if this ever needs to be tamper-resistant.
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const PHONE_REGEX = /^[6-9]\d{9}$/;

// GET /api/students/:phone/jobs
// Public. -> [{ jobId, shopId, shopName, status, tokenNumber, amountDue,
//               pages, copies, colorMode, createdAt }, ...]
// Most recent first, capped at 20 so this can't become an unbounded dump.
router.get('/:phone/jobs', async (req, res, next) => {
  try {
    const { phone } = req.params;

    if (!PHONE_REGEX.test(phone)) {
      return res.status(400).json({
        error: 'Phone number must be a 10-digit number starting with 6-9',
      });
    }

    const { rows } = await pool.query(
      `SELECT pj.id AS "jobId", s.id AS "shopId", s.name AS "shopName",
              pj.status, pj.token_number AS "tokenNumber",
              pj.amount_due AS "amountDue", pj.pages, pj.copies,
              pj.color_mode AS "colorMode", pj.created_at AS "createdAt"
       FROM print_jobs pj
       JOIN shops s ON s.id = pj.shop_id
       WHERE pj.student_phone = $1
       ORDER BY pj.created_at DESC
       LIMIT 20`,
      [phone]
    );

    return res.status(200).json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
