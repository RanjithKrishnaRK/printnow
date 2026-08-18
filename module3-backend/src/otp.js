// src/otp.js
//
// Generic one-time-code generation/verification, shared by shop signup
// email verification and forgot-password. See db.js migrate() for the
// otps table this reads/writes.
const { pool } = require('./db');
const { randomUUID } = require('crypto');
const { hashPassword, comparePassword } = require('./auth');

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

function generateOtp() {
  // Always exactly 6 digits, including a possible leading zero - padStart
  // instead of a bare Math.floor(100000 + ...) keeps the length constant.
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

// Creates and stores a new OTP for (email, purpose), returning the plain
// code to send by email. Deletes any earlier unconsumed code for the same
// (email, purpose) first, so only the most recently requested code is ever
// valid - "resend code" always means the new one, not "now two codes work".
async function createOtp({ email, purpose, payload = null }) {
  await pool.query('DELETE FROM otps WHERE email = $1 AND purpose = $2', [email, purpose]);
  const otp = generateOtp();
  const otpHash = await hashPassword(otp);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO otps (id, email, purpose, otp_hash, attempts, expires_at, payload, created_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6, NOW())`,
    [id, email, purpose, otpHash, new Date(Date.now() + OTP_TTL_MS), payload ? JSON.stringify(payload) : null]
  );
  return otp;
}

// Verifies a submitted code against the stored one for (email, purpose).
// Returns { ok: true, payload } on success, or { ok: false, error } with a
// message safe to show the person directly. Always consumes (deletes) the
// row on success, on expiry, and on hitting the attempt limit - only a
// wrong-but-still-retryable guess leaves the row in place.
async function verifyOtp({ email, purpose, otp }) {
  const { rows } = await pool.query(
    `SELECT * FROM otps WHERE email = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1`,
    [email, purpose]
  );
  const row = rows[0];
  if (!row) {
    return { ok: false, error: 'No verification code found for this email. Please request a new one.' };
  }
  if (new Date(row.expires_at) < new Date()) {
    await pool.query('DELETE FROM otps WHERE id = $1', [row.id]);
    return { ok: false, error: 'This code has expired. Please request a new one.' };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await pool.query('DELETE FROM otps WHERE id = $1', [row.id]);
    return { ok: false, error: 'Too many incorrect attempts. Please request a new code.' };
  }

  const matches = await comparePassword(String(otp || ''), row.otp_hash);
  if (!matches) {
    await pool.query('UPDATE otps SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    const remaining = MAX_ATTEMPTS - (row.attempts + 1);
    return {
      ok: false,
      error: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
    };
  }

  await pool.query('DELETE FROM otps WHERE id = $1', [row.id]);
  return { ok: true, payload: row.payload };
}

module.exports = { createOtp, verifyOtp };
