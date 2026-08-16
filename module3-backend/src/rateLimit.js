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

module.exports = { loginRateLimiter };
