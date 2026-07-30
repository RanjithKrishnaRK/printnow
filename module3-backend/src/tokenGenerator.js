// src/tokenGenerator.js
const { pool } = require('./db');

function todayStr() {
  // YYYY-MM-DD in server-local time. Fine for a single-timezone (India) MVP.
  return new Date().toISOString().slice(0, 10);
}

/**
 * Generates the next token number for a shop, e.g. "A-1", "A-2", ... "A-26",
 * then rolls over to "B-1". Resets automatically each calendar day because
 * the counter is keyed by (shop_id, date).
 *
 * NOTE: single-letter prefix supports up to 26*99 = 2574 tokens/day per shop
 * before it would need a second letter - far beyond what one xerox shop
 * does in a day, so kept simple for v1.
 *
 * Uses an UPSERT (INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING) so the
 * read-then-write is a single atomic statement - safe under concurrent
 * requests, unlike a separate SELECT then UPDATE/INSERT (which real Postgres
 * needs, unlike the single-connection SQLite file this replaced).
 */
async function generateTokenNumber(shopId) {
  const date = todayStr();

  const { rows } = await pool.query(
    `INSERT INTO token_counters (shop_id, date, last_seq)
     VALUES ($1, $2, 1)
     ON CONFLICT (shop_id, date)
     DO UPDATE SET last_seq = token_counters.last_seq + 1
     RETURNING last_seq`,
    [shopId, date]
  );

  const nextSeq = rows[0].last_seq;
  const letterIndex = Math.floor((nextSeq - 1) / 99); // 99 tokens per letter
  const numberInLetter = ((nextSeq - 1) % 99) + 1;
  const letter = String.fromCharCode(65 + (letterIndex % 26)); // A-Z, wraps if needed

  return `${letter}-${numberInLetter}`;
}

module.exports = { generateTokenNumber };
