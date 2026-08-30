// src/earnings.js
//
// Shared logic for turning payment_method rows into the two buckets a shop
// owner actually thinks in: cash handed over at the counter, vs. online
// (anything through the payment gateway). 'razorpay' is the current online
// method; legacy 'upi' rows (the old manual-screenshot flow, since removed
// from the student app but still present in old data) count as online too -
// both are money that arrived digitally, not cash in the till.
const { pool } = require('./db');
const { randomUUID } = require('crypto');

function toCashOnlineTotals(rows) {
  const totals = { cash: 0, online: 0 };
  for (const row of rows) {
    if (row.method === 'cash') totals.cash += row.total;
    else if (row.method === 'razorpay' || row.method === 'upi') totals.online += row.total;
  }
  return totals;
}

// Every earnings query across shop + admin routes uses this exact
// "confirmed" definition, so the numbers always agree with each other: a
// job still at 'uploaded' was never paid, and 'payment_pending' is just an
// unreviewed claim (screenshot/cash promise), not real revenue yet.
const CONFIRMED_STATUS_SQL = `status NOT IN ('uploaded', 'payment_pending')`;

async function getShopMethodTotals(shopId, { today = false } = {}) {
  const dateClause = today ? `AND created_at::date = CURRENT_DATE` : '';
  const { rows } = await pool.query(
    `SELECT COALESCE(payment_method, 'unknown') AS method,
            COALESCE(SUM(amount_due), 0)::int AS total, COUNT(*)::int AS count
     FROM print_jobs WHERE shop_id = $1 AND ${CONFIRMED_STATUS_SQL} ${dateClause}
     GROUP BY payment_method`,
    [shopId]
  );
  return toCashOnlineTotals(rows);
}

// Settlements - only ever created against a shop's ONLINE earnings (cash
// never needs settling, see db.js migration comment).
async function listSettlements(shopId) {
  const { rows } = await pool.query(
    `SELECT id, shop_id AS "shopId", amount, settled_date AS "settledDate", mode, note,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM settlements WHERE shop_id = $1 ORDER BY settled_date DESC, created_at DESC`,
    [shopId]
  );
  return rows;
}

async function getSettledTotal(shopId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::int AS total FROM settlements WHERE shop_id = $1`,
    [shopId]
  );
  return rows[0].total;
}

async function createSettlement({ shopId, amount, settledDate, mode, note }) {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO settlements (id, shop_id, amount, settled_date, mode, note, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     RETURNING id, shop_id AS "shopId", amount, settled_date AS "settledDate", mode, note,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [id, shopId, amount, settledDate, mode, note || null]
  );
  return rows[0];
}

async function updateSettlement(id, { amount, settledDate, mode, note }) {
  const { rows } = await pool.query(
    `UPDATE settlements
     SET amount = $1, settled_date = $2, mode = $3, note = $4, updated_at = NOW()
     WHERE id = $5
     RETURNING id, shop_id AS "shopId", amount, settled_date AS "settledDate", mode, note,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [amount, settledDate, mode, note || null, id]
  );
  return rows[0] || null;
}

async function deleteSettlement(id) {
  const { rowCount } = await pool.query('DELETE FROM settlements WHERE id = $1', [id]);
  return rowCount > 0;
}

// Commission owed - the reverse of settlements. A job only counts here if
// its money went straight to the SHOP's own Razorpay account (their own
// keys), not the platform's - see db.js's razorpay_account_key_id comment.
// For those jobs the platform never touched the money at all, so its
// service_fee + gateway_fee cut (normally captured automatically, either
// because it stayed in the platform's own pooled Razorpay balance, or via
// Cashfree's Easy Split remainder) has to be tracked as a running due
// instead. Cash and shop-owned-Cashfree-vendor jobs never appear here -
// only 'razorpay' jobs where razorpay_account_key_id is set AND matches
// that shop's OWN configured key (not the platform's).
async function getShopCommissionAccrued(shopId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(pj.service_fee + pj.gateway_fee), 0)::int AS total
     FROM print_jobs pj
     JOIN shops s ON s.id = pj.shop_id
     WHERE pj.shop_id = $1 AND ${CONFIRMED_STATUS_SQL.replace(/status/g, 'pj.status')}
       AND pj.payment_method = 'razorpay'
       AND pj.razorpay_account_key_id IS NOT NULL
       AND pj.razorpay_account_key_id = s.razorpay_key_id`,
    [shopId]
  );
  return rows[0].total;
}

async function listCommissionPayments(shopId) {
  const { rows } = await pool.query(
    `SELECT id, shop_id AS "shopId", amount, paid_date AS "paidDate", mode, note,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM commission_payments WHERE shop_id = $1 ORDER BY paid_date DESC, created_at DESC`,
    [shopId]
  );
  return rows;
}

async function getCommissionPaidTotal(shopId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::int AS total FROM commission_payments WHERE shop_id = $1`,
    [shopId]
  );
  return rows[0].total;
}

// Owed = accrued (this shop's own-account jobs' fees) minus whatever's
// already been paid in - never negative (a shop that's paid ahead, or an
// admin correcting an over-recorded payment, shouldn't show as "we owe
// them"; that's a separate, deliberately out-of-scope reconciliation).
async function getCommissionOwed(shopId) {
  const [accrued, paid] = await Promise.all([
    getShopCommissionAccrued(shopId),
    getCommissionPaidTotal(shopId),
  ]);
  return { accrued, paid, owed: Math.max(0, accrued - paid) };
}

async function createCommissionPayment({ shopId, amount, paidDate, mode, note }) {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO commission_payments (id, shop_id, amount, paid_date, mode, note, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     RETURNING id, shop_id AS "shopId", amount, paid_date AS "paidDate", mode, note,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [id, shopId, amount, paidDate, mode, note || null]
  );
  return rows[0];
}

async function updateCommissionPayment(id, { amount, paidDate, mode, note }) {
  const { rows } = await pool.query(
    `UPDATE commission_payments
     SET amount = $1, paid_date = $2, mode = $3, note = $4, updated_at = NOW()
     WHERE id = $5
     RETURNING id, shop_id AS "shopId", amount, paid_date AS "paidDate", mode, note,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [amount, paidDate, mode, note || null, id]
  );
  return rows[0] || null;
}

async function deleteCommissionPayment(id) {
  const { rowCount } = await pool.query('DELETE FROM commission_payments WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = {
  toCashOnlineTotals,
  CONFIRMED_STATUS_SQL,
  getShopMethodTotals,
  listSettlements,
  getSettledTotal,
  createSettlement,
  updateSettlement,
  deleteSettlement,
  getShopCommissionAccrued,
  listCommissionPayments,
  getCommissionPaidTotal,
  getCommissionOwed,
  createCommissionPayment,
  updateCommissionPayment,
  deleteCommissionPayment,
};
