// src/push.js
//
// Push notifications to the shop-owner mobile app, via Firebase Cloud
// Messaging (covers both Android and iOS/APNs from one integration). Same
// shape as notify.js's role for the student-facing SMS stub: this is the
// ONE place that touches the FCM SDK - callers just call sendPushToShop()
// and don't know or care how the message actually gets delivered.
//
// Two real trigger points call this today (see routes/jobs.js and
// routes/batches.js): a job reaching "queued" (new job for the shop to
// see), and a job reaching "printed_pending_removal" (auto-print finished,
// needs a human to physically take the paper off the tray - see db.js and
// routes/jobs.js's confirm-removed route for the rest of that flow).
//
// If FCM_SERVICE_ACCOUNT_JSON isn't set (local dev, or a deploy that
// hasn't configured push yet), this quietly no-ops rather than throwing -
// exactly like notify.js's stub - so nothing that calls sendPushToShop
// needs to guard every call site with "if push is configured". It logs
// once at boot so it's obvious from the server log whether push is live.
const { pool } = require('./db');
const { FCM_SERVICE_ACCOUNT_JSON } = require('./config');

let messaging = null; // null until (if) Firebase Admin initializes successfully

if (FCM_SERVICE_ACCOUNT_JSON) {
  try {
    const admin = require('firebase-admin');
    const serviceAccount = JSON.parse(FCM_SERVICE_ACCOUNT_JSON);
    const app = admin.apps.length ? admin.app() : admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    messaging = app.messaging();
    console.log('[push] FCM configured - shop push notifications are live.');
  } catch (err) {
    // A malformed/invalid service account shouldn't take the whole server
    // down at boot - log it clearly and keep running with push disabled,
    // same "degrade, don't crash" choice as the rest of this file.
    console.error(
      '[push] FCM_SERVICE_ACCOUNT_JSON is set but could not be parsed/initialized - ' +
        'push notifications are disabled until this is fixed. Error:',
      err.message
    );
  }
} else {
  console.warn('[push] FCM_SERVICE_ACCOUNT_JSON is not set - shop push notifications are disabled.');
}

// Sends one notification to every device this shop has registered
// (shop_push_tokens - see routes/shops.js POST .../push-tokens). Best
// effort per-token: one dead/unregistered token failing to send doesn't
// stop the others, and gets cleaned up automatically (see below) rather
// than retried forever.
//
// `data` values must all be strings - that's an FCM requirement (its data
// payload is string-to-string only), so anything non-string (jobId is
// already a TEXT/uuid, but this guards future callers) gets coerced here
// rather than failing the whole send.
async function sendPushToShop(shopId, { title, body, data = {} }) {
  if (!messaging) return; // push not configured - see the module-load block above

  const { rows: tokenRows } = await pool.query(
    'SELECT token FROM shop_push_tokens WHERE shop_id = $1',
    [shopId]
  );
  if (tokenRows.length === 0) return; // shop has no app installed/registered yet - nothing to send

  const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));

  const response = await messaging.sendEachForMulticast({
    tokens: tokenRows.map((r) => r.token),
    notification: { title, body },
    data: stringData,
  });

  // Standard FCM token-hygiene practice: a token that comes back
  // "unregistered" or "invalid" means that install no longer exists (app
  // uninstalled, token rotated, etc.) - delete it now rather than paying
  // for a failed send attempt against it forever.
  const deadTokens = [];
  response.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
        deadTokens.push(tokenRows[i].token);
      }
    }
  });
  if (deadTokens.length > 0) {
    await pool.query('DELETE FROM shop_push_tokens WHERE token = ANY($1)', [deadTokens]);
  }
}

module.exports = { sendPushToShop };
