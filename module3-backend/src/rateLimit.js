// src/rateLimit.js
//
// In-memory rate limiting is enough here: this runs as a single Render
// instance (no horizontal scaling in this deploy), so there's no need for
// a shared store like Redis just to slow down login guessing. If this ever
// moves to multiple instances, swap the default MemoryStore for a Redis
// store - everything else here stays the same.
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// Keyed by IP + the email/phone being attempted, not IP alone - a shared
// campus wifi/NAT means many real students can share one IP, and limiting
// by IP alone would lock all of them out over one person's typos. Keying
// by the pair means an attacker grinding through passwords for ONE account
// gets slowed down without collaterally blocking everyone else on the
// same network from their own, unrelated logins.
// ipKeyGenerator normalizes IPv6 addresses (collapses to a /64-ish prefix)
// so a single attacker can't dodge the limit by cycling through addresses
// within their own IPv6 block.
function keyByIpAndBody(field) {
  return (req) => `${ipKeyGenerator(req.ip)}:${(req.body && req.body[field]) || ''}`;
}

// 10 attempts per 15 minutes per IP+email is generous for a genuine typo
// or two, while making a brute-force sweep through a password list
// impractically slow (bcrypt already adds ~100ms/guess on top of this).
const loginRateLimiter = (field) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyByIpAndBody(field),
    message: { error: 'Too many login attempts. Please wait a few minutes and try again.' },
  });

// Plain per-IP limiter (no field-keying) for public endpoints that don't
// have a natural "account" to key by, but are still worth slowing down:
// - GET /api/students/:phone(/jobs) has no auth at all by design (see
//   routes/students.js) - anyone who knows a phone number can see that
//   number's order history. Without this, the same lack of auth means
//   anyone could script through thousands of numbers per minute looking
//   for real ones; this doesn't fix the underlying trust model (a
//   documented, accepted MVP tradeoff) but makes bulk enumeration
//   impractical rather than trivial.
// - POST /api/uploads(/payment-screenshot) and /api/convert/docx-to-pdf
//   are all unauthenticated by necessity (students aren't logged in) -
//   without any limit, either could be hammered to fill disk space,
//   burn bandwidth, or (for docx conversion specifically) spawn many
//   concurrent LibreOffice processes.
const publicRateLimiter = ({ windowMs = 15 * 60 * 1000, max = 30 } = {}) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a few minutes and try again.' },
  });

module.exports = { loginRateLimiter, publicRateLimiter };
