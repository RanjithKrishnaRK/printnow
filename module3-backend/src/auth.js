// src/auth.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET, JWT_EXPIRES_IN } = require('./config');

const SALT_ROUNDS = 10;

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signShopToken(shop) {
  // Token payload only ever carries shopId - keep it minimal.
  return jwt.sign({ shopId: shop.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function signAdminToken(admin) {
  // role: 'admin' is what distinguishes this from a shop token below - a
  // valid shop token must NOT pass requireAdminAuth, and vice versa.
  return jwt.sign({ role: 'admin', adminId: admin.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Middleware: requires a valid `Authorization: Bearer <token>` header.
 * Attaches req.shopId from the token payload.
 * Use this on every shop-owner-only endpoint (dashboard-facing).
 */
function requireShopAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.shopId = payload.shopId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Use after requireShopAuth on routes with a :shopId param, to ensure a
 * shop can only touch its own data (can't pass someone else's shopId in
 * the URL with your own valid token).
 */
function requireOwnShop(req, res, next) {
  if (req.params.shopId && req.params.shopId !== req.shopId) {
    return res.status(403).json({ error: 'Token does not match this shopId' });
  }
  next();
}

/**
 * Middleware: requires a valid admin `Authorization: Bearer <token>` header
 * (a token signed by signAdminToken, role === 'admin'). A shop's own token
 * fails this check, and this deliberately does NOT accept a :shopId-style
 * match - admin endpoints aren't scoped to one shop.
 */
function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.adminId = payload.adminId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = {
  hashPassword,
  comparePassword,
  signShopToken,
  requireShopAuth,
  requireOwnShop,
  signAdminToken,
  requireAdminAuth,
};
