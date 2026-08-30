// src/razorpay.js
//
// Single place that touches the Razorpay SDK/keys, so every route that
// needs online payment goes through the same two functions instead of
// re-deriving the client or the signature check.
//
// Both functions now accept an OPTIONAL { keyId, keySecret } override -
// this is what makes shop-owned Razorpay accounts work. A shop that's
// registered their own keys (routes/shops.js PATCH .../settings) gets
// their order created against THEIR account, via getClient({ keyId,
// keySecret }) with their credentials - the platform's own
// RAZORPAY_KEY_ID/SECRET are only ever the fallback for a shop that
// hasn't set up their own account yet. Callers are responsible for
// passing the SAME keySecret to verifyPaymentSignature that was used to
// create the order (see routes/jobs.js razorpay_account_key_id) - the
// override isn't looked up here, it's just applied.
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = require('./config');

// Keyed by key_id so a shop's own client and the platform's own client
// (or several different shops' clients, across requests) don't overwrite
// a single module-level cache.
const clients = new Map();

function getClient({ keyId, keySecret } = {}) {
  const id = keyId || RAZORPAY_KEY_ID;
  const secret = keySecret || RAZORPAY_KEY_SECRET;
  if (!id || !secret) {
    // Fails the request that called this (via the route's try/catch), not
    // the whole server at boot - lets everything else keep working in an
    // environment where Razorpay just hasn't been set up yet.
    throw new Error(
      'Razorpay is not configured - set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET'
    );
  }
  if (!clients.has(id)) {
    clients.set(id, new Razorpay({ key_id: id, key_secret: secret }));
  }
  return clients.get(id);
}

// Verifies the signature Razorpay Checkout hands back to the browser after
// a successful payment. This - not the browser's "success" callback - is
// the only thing that actually proves money moved: it's
// HMAC-SHA256(`${orderId}|${paymentId}`, key_secret), which only Razorpay's
// servers and ours can produce. A compromised or scripted client can lie
// about "success" but can't forge this without the secret.
//
// timingSafeEqual (not === or string comparison) so a failed check doesn't
// leak how many leading bytes matched via response timing.
function verifyPaymentSignature({ orderId, paymentId, signature, keySecret }) {
  const secret = keySecret || RAZORPAY_KEY_SECRET;
  if (!secret) {
    throw new Error('Razorpay is not configured - set RAZORPAY_KEY_SECRET');
  }
  if (!orderId || !paymentId || !signature) return false;

  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const expected = Buffer.from(expectedHex, 'hex');
  const given = Buffer.from(String(signature), 'hex');
  if (expected.length !== given.length) return false;

  return crypto.timingSafeEqual(expected, given);
}

module.exports = { getClient, verifyPaymentSignature };
