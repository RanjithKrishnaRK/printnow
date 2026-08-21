// src/routes/settings.js
// Public, read-only settings the frontends need before/without logging in.
// Payment fee breakdown so a student can see "includes ₹X service fee"
// before opening checkout, and upload feature flags so the student app
// knows whether docx/image-to-PDF conversion are currently available
// before offering them as options.
const express = require('express');
const { getPaymentFees, getUploadFlags } = require('../settings');

const router = express.Router();

// GET /api/settings/payment-fees ->
// { serviceFeePercent, serviceFeeEnabled, serviceFeeTier1Flat, serviceFeeTier2Flat,
//   gatewayFeePercent, gatewayFeeEnabled, gatewayFeeTier1Flat, gatewayFeeTier2Flat }
router.get('/payment-fees', async (req, res, next) => {
  try {
    const fees = await getPaymentFees();
    return res.status(200).json(fees);
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/upload-flags -> { docxConversionEnabled, imageConversionEnabled }
router.get('/upload-flags', async (req, res, next) => {
  try {
    const flags = await getUploadFlags();
    return res.status(200).json(flags);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
