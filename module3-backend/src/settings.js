// src/settings.js
//
// Thin wrapper around the `settings` key/value table (see db.js migrate()).
// No caching - this app's traffic is low enough that a query per read costs
// nothing, and caching would risk a stale fee surviving after an admin
// changes it, which is exactly the kind of bug you don't want in a payment
// amount calculation.
const { pool } = require('./db');

const KEYS = ['service_fee_percent', 'service_fee_enabled', 'gateway_fee_percent', 'gateway_fee_enabled'];

async function getPaymentFees() {
  const { rows } = await pool.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [KEYS]);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    serviceFeePercent: Number(map.service_fee_percent ?? 0),
    serviceFeeEnabled: map.service_fee_enabled === 'true',
    gatewayFeePercent: Number(map.gateway_fee_percent ?? 0),
    gatewayFeeEnabled: map.gateway_fee_enabled === 'true',
  };
}

async function updatePaymentFees({ serviceFeePercent, serviceFeeEnabled, gatewayFeePercent, gatewayFeeEnabled }) {
  const entries = [
    ['service_fee_percent', String(serviceFeePercent)],
    ['service_fee_enabled', String(!!serviceFeeEnabled)],
    ['gateway_fee_percent', String(gatewayFeePercent)],
    ['gateway_fee_enabled', String(!!gatewayFeeEnabled)],
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

// Single source of truth for turning (baseAmount, fee settings) into actual
// rupee amounts - used by both routes/jobs.js and routes/batches.js so the
// two can never drift apart. A disabled fee contributes exactly 0
// regardless of what percentage is stored for it - "off" always means off,
// not "off until someone forgets to also zero out the percentage".
function computeFeeBreakdown(baseAmount, fees) {
  const serviceFee = fees.serviceFeeEnabled ? Math.round((baseAmount * fees.serviceFeePercent) / 100) : 0;
  const gatewayFee = fees.gatewayFeeEnabled ? Math.round((baseAmount * fees.gatewayFeePercent) / 100) : 0;
  return { serviceFee, gatewayFee, totalAmount: baseAmount + serviceFee + gatewayFee };
}

module.exports = { getPaymentFees, updatePaymentFees, computeFeeBreakdown };
