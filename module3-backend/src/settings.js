// src/settings.js
//
// Thin wrapper around the `settings` key/value table (see db.js migrate()).
// No caching - this app's traffic is low enough that a query per read costs
// nothing, and caching would risk a stale fee surviving after an admin
// changes it, which is exactly the kind of bug you don't want in a payment
// amount calculation.
const { pool } = require('./db');

async function getPaymentFees() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN ('service_fee', 'gateway_fee_percent')`
  );
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    serviceFee: Number(map.service_fee ?? 0),
    gatewayFeePercent: Number(map.gateway_fee_percent ?? 0),
  };
}

async function updatePaymentFees({ serviceFee, gatewayFeePercent }) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('service_fee', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [String(serviceFee)]
  );
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('gateway_fee_percent', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [String(gatewayFeePercent)]
  );
  return getPaymentFees();
}

module.exports = { getPaymentFees, updatePaymentFees };
