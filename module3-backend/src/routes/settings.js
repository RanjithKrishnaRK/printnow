// src/routes/settings.js
// Public, read-only settings the frontends need before/without logging in.
// Currently just the online-payment fee breakdown, so a student can see
// "includes ₹X service fee" before opening checkout rather than being
// surprised by a different total inside the Razorpay popup.
const express = require('express');
const { getPaymentFees } = require('../settings');

const router = express.Router();

// GET /api/settings/payment-fees -> { serviceFeePercent, serviceFeeEnabled, gatewayFeePercent, gatewayFeeEnabled }
router.get('/payment-fees', async (req, res, next) => {
  try {
    const fees = await getPaymentFees();
    return res.status(200).json(fees);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
