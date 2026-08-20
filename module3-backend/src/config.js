// src/config.js
// Central place for all env-driven config. No secrets are hardcoded here -
// real values come from .env (see .env.example). Defaults let the app boot
// out of the box for local MVP testing.

const crypto = require('crypto');

require('dotenv').config();

// JWT_SECRET used to fall back to a fixed, hardcoded string
// ('dev-secret-change-me-in-prod') if the env var wasn't set. Since this
// file lives in a public repo, that string was effectively public - anyone
// could forge a valid admin token against a deploy that never actually set
// JWT_SECRET on Render. Now: production refuses to boot without a real
// secret (fail loudly at deploy time, not silently at attack time); local
// dev gets a random secret generated fresh each process start, so it's
// never a fixed/guessable value, at the cost of dev-only sessions not
// surviving a restart.
function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET is not set. Refusing to start in production without it - ' +
        'set it in your hosting provider\'s environment variables before deploying ' +
        '(see module3-backend/.env.example for how to generate one).'
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    '[config] JWT_SECRET is not set - using a random secret for this process only. ' +
      'Fine for local dev; set a real JWT_SECRET before deploying.'
  );
  return crypto.randomBytes(48).toString('hex');
}

module.exports = {
  PORT: process.env.PORT || 4000,

  JWT_SECRET: resolveJwtSecret(),
  JWT_EXPIRES_IN: '7d',

  // Postgres connection string, e.g.
  // postgres://user:password@localhost:5432/printnow_db
  DATABASE_URL: process.env.DATABASE_URL,

  // Flat per-page pricing for v1 (INR). Same rate for every shop for now -
  // "configurable per shop later" per the assignment, so this is the one
  // deliberate simplification. See README for how to extend this.
  PRICING: {
    bw: 2,     // Rs 2 / page
    color: 10, // Rs 10 / page
  },

  UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',

  // Used ONLY to seed the single admin account the very first time the
  // `admins` table is empty (see db.js migrate()). After that first boot,
  // the password lives in the database (bcrypt-hashed) and is changed via
  // POST /api/admin/change-password, not by editing .env - editing these
  // after first boot has no effect unless you also update the DB row.
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@printnow.in',
  ADMIN_INITIAL_PASSWORD: process.env.ADMIN_INITIAL_PASSWORD || 'change-me-on-first-login',

  // Razorpay keys for online payments. Deliberately NO fallback value for
  // either - unlike JWT_SECRET above, there's no safe default for these:
  // a fallback would either be a real secret (never hardcode that) or a
  // fake one that fails every payment silently. Leave unset in dev; the
  // razorpay/create-order route below fails loudly if they're missing
  // rather than pretending to work.
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || null,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || null,

  // Comma-separated list of allowed frontend origins, e.g.
  // "http://localhost:5173,http://localhost:5174"
  // Module 1 (student app) and Module 2 (shop dashboard) will run on
  // different ports/origins during development - both need to be listed here.
  CORS_ORIGINS: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};
