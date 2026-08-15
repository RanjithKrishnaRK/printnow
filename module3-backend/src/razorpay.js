// src/razorpay.js
//
// Single place that touches the Razorpay SDK/keys, so every route that
// needs online payment goes through the same two functions instead of
// re-deriving the client or the signature check.
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = require('./config');

let client = null;

function getClient() {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    // Fails the request that called this (via the route's try/catch), not
    // the whole server at boot - lets everything else keep working in an
    // environment where Razorpay just hasn't been set up yet.
    throw new Error(
      'Razorpay is not configured - set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET'
    );
  }
  if (!client) {
    client = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
  }
  return client;
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
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay is not configured - set RAZORPAY_KEY_SECRET');
  }
  if (!orderId || !paymentId || !signature) return false;

  const expectedHex = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const expected = Buffer.from(expectedHex, 'hex');
  const given = Buffer.from(String(signature), 'hex');
  if (expected.length !== given.length) return false;

  return crypto.timingSafeEqual(expected, given);
}

module.exports = { getClient, verifyPaymentSignature };
