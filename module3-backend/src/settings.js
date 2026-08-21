// src/settings.js
//
// Thin wrapper around the `settings` key/value table (see db.js migrate()).
// No caching - this app's traffic is low enough that a query per read costs
// nothing, and caching would risk a stale fee surviving after an admin
// changes it, which is exactly the kind of bug you don't want in a payment
// amount calculation.
const { pool } = require('./db');

const KEYS = [
  'service_fee_percent',
  'service_fee_enabled',
  'service_fee_tier1_flat',
  'service_fee_tier2_flat',
  'gateway_fee_percent',
  'gateway_fee_enabled',
  'gateway_fee_tier1_flat',
  'gateway_fee_tier2_flat',
];

async function getPaymentFees() {
  const { rows } = await pool.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [KEYS]);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    serviceFeePercent: Number(map.service_fee_percent ?? 0),
    serviceFeeEnabled: map.service_fee_enabled === 'true',
    serviceFeeTier1Flat: Number(map.service_fee_tier1_flat ?? 1),
    serviceFeeTier2Flat: Number(map.service_fee_tier2_flat ?? 1.5),
    gatewayFeePercent: Number(map.gateway_fee_percent ?? 0),
    gatewayFeeEnabled: map.gateway_fee_enabled === 'true',
    gatewayFeeTier1Flat: Number(map.gateway_fee_tier1_flat ?? 1),
    gatewayFeeTier2Flat: Number(map.gateway_fee_tier2_flat ?? 1.5),
  };
}

async function updatePaymentFees({
  serviceFeePercent,
  serviceFeeEnabled,
  serviceFeeTier1Flat,
  serviceFeeTier2Flat,
  gatewayFeePercent,
  gatewayFeeEnabled,
  gatewayFeeTier1Flat,
  gatewayFeeTier2Flat,
}) {
  const entries = [
    ['service_fee_percent', String(serviceFeePercent)],
    ['service_fee_enabled', String(!!serviceFeeEnabled)],
    ['service_fee_tier1_flat', String(serviceFeeTier1Flat)],
    ['service_fee_tier2_flat', String(serviceFeeTier2Flat)],
    ['gateway_fee_percent', String(gatewayFeePercent)],
    ['gateway_fee_enabled', String(!!gatewayFeeEnabled)],
    ['gateway_fee_tier1_flat', String(gatewayFeeTier1Flat)],
    ['gateway_fee_tier2_flat', String(gatewayFeeTier2Flat)],
  ];
  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  }
  return getPaymentFees();
}

// A percentage of a small order rounds to ₹0 (round(₹5 × 2%) = 0), which
// made every low-value job silently fee-free even with fees switched on -
// not what "add a fee" means for a ₹5 print job. Below ₹21, each fee falls
// back to a flat rupee amount instead of its percentage; ₹21 and up uses
// the percentage as normal. Two flat tiers (not one) because a flat ₹1 on
// a ₹2 job and a flat ₹1 on a ₹19 job aren't really the same proportion -
// the second tier lets the flat amount step up as the order does, before
// handing off to the percentage entirely once it's worth calculating.
const SMALL_ORDER_TIER1_MAX = 10; // orders from ₹0 to ₹10
const SMALL_ORDER_TIER2_MAX = 20; // orders from ₹11 to ₹20 - above this, percentage applies

function computeSingleFee(baseAmount, percent, tier1Flat, tier2Flat) {
  if (baseAmount <= SMALL_ORDER_TIER1_MAX) return tier1Flat;
  if (baseAmount <= SMALL_ORDER_TIER2_MAX) return tier2Flat;
  return Math.round((baseAmount * percent) / 100);
}

// Single source of truth for turning (baseAmount, fee settings) into actual
// rupee amounts - used by both routes/jobs.js and routes/batches.js so the
// two can never drift apart. A disabled fee contributes exactly 0
// regardless of what percentage/flat amounts are stored for it - "off"
// always means off, not "off until someone forgets to also zero out every
// other field".
function computeFeeBreakdown(baseAmount, fees) {
  const serviceFee = fees.serviceFeeEnabled
    ? computeSingleFee(baseAmount, fees.serviceFeePercent, fees.serviceFeeTier1Flat, fees.serviceFeeTier2Flat)
    : 0;
  const gatewayFee = fees.gatewayFeeEnabled
    ? computeSingleFee(baseAmount, fees.gatewayFeePercent, fees.gatewayFeeTier1Flat, fees.gatewayFeeTier2Flat)
    : 0;
  return { serviceFee, gatewayFee, totalAmount: baseAmount + serviceFee + gatewayFee };
}

const UPLOAD_FLAG_KEYS = ['docx_conversion_enabled', 'image_conversion_enabled'];

// docx -> PDF conversion (routes/convert.js) needs the `soffice`
// (LibreOffice headless) binary on PATH, which only exists on a
// Docker-based deploy - it silently fails on Render's default native Node
// runtime. Rather than delete the feature outright, it's gated behind this
// admin toggle (off by default, since it doesn't actually work in the
// current deploy) so it can be switched back on the moment the backend
// moves to Docker, with no code changes needed at that point. Image -> PDF
// (imageFileToPdfFile in the student app) runs entirely client-side via
// pdf-lib and works regardless of hosting - defaults to on - but gets the
// same toggle for consistency and in case it's ever worth turning off too.
async function getUploadFlags() {
  const { rows } = await pool.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [
    UPLOAD_FLAG_KEYS,
  ]);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    docxConversionEnabled: map.docx_conversion_enabled === 'true',
    imageConversionEnabled: map.image_conversion_enabled !== 'false', // defaults on if unset
  };
}

async function updateUploadFlags({ docxConversionEnabled, imageConversionEnabled }) {
  const entries = [
    ['docx_conversion_enabled', String(!!docxConversionEnabled)],
    ['image_conversion_enabled', String(!!imageConversionEnabled)],
  ];
  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  }
  return getUploadFlags();
}

module.exports = {
  getPaymentFees,
  updatePaymentFees,
  computeFeeBreakdown,
  getUploadFlags,
  updateUploadFlags,
};
