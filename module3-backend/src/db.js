// src/db.js
//
// Real PostgreSQL now (previously node:sqlite - fine for early dev, not for
// production: no concurrent-writer story, doesn't run anywhere but this one
// machine's disk, no managed backups). Everything below is async because
// node-postgres is async-only - every call site (routes, tokenGenerator,
// scripts/seedShop.js) had to change from db.prepare(...).get()/.run()/.all()
// (synchronous) to `await pool.query(...)`. See CHANGES.md for the full list
// of what changed.
//
// IMPORTANT: Postgres folds unquoted identifiers to lowercase, so an alias
// like `SELECT id AS jobId` silently comes back as `jobid`, not `jobId`. To
// keep the exact camelCase field names both frontends already expect,
// every camelCase alias in this codebase's SQL is double-quoted, e.g.
// `SELECT id AS "jobId"`. Don't remove those quotes.

const { Pool } = require('pg');
const { DATABASE_URL, ADMIN_EMAIL, ADMIN_INITIAL_PASSWORD, PRICING } = require('./config');

const pool = new Pool({ connectionString: DATABASE_URL });

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS landmarks (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      landmark_id   TEXT REFERENCES landmarks(id),
      created_at    TIMESTAMPTZ NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id              TEXT PRIMARY KEY,
      shop_id         TEXT NOT NULL REFERENCES shops(id),
      file_url        TEXT NOT NULL,
      pages           INTEGER NOT NULL,
      copies          INTEGER NOT NULL,
      color_mode      TEXT NOT NULL CHECK (color_mode IN ('bw','color','mixed')),
      color_pages     TEXT,
      sides           TEXT NOT NULL DEFAULT 'single' CHECK (sides IN ('single','double')),
      student_phone   TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('uploaded','queued','printing','ready','collected')),
      token_number    TEXT,
      amount_due      INTEGER NOT NULL,
      file_deleted_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL,
      updated_at      TIMESTAMPTZ NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_counters (
      shop_id  TEXT NOT NULL REFERENCES shops(id),
      date     TEXT NOT NULL,
      last_seq INTEGER NOT NULL,
      PRIMARY KEY (shop_id, date)
    );
  `);

  // Migration: file_deleted_at added after print_jobs already existed on some
  // installs (auto-delete-on-collection feature, added after the first
  // Postgres cutover). Safe to run every boot.
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_deleted_at TIMESTAMPTZ;
  `);

  // Migration: auto_print_enabled (item 5's auto-print agent). Defaults to
  // false - auto-print is opt-in per shop, never turned on without the shop
  // owner explicitly flipping it on from the dashboard.
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS auto_print_enabled BOOLEAN NOT NULL DEFAULT false;
  `);

  // Migration: per-shop pricing + hourly page cap. price_bw/price_color are
  // per-page rates in INR (previously a single flat PRICING constant shared
  // by every shop - see config.js). max_pages_per_hour is nullable: NULL
  // means "no cap", same as leaving it unset in the settings UI. Existing
  // shops are backfilled with the old flat-rate constants below so nothing
  // that already priced a job changes price on this deploy - they just
  // start out editable instead of hardcoded.
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_bw INTEGER;
  `);
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_color INTEGER;
  `);
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS max_pages_per_hour INTEGER;
  `);
  await pool.query(
    `UPDATE shops SET price_bw = $1 WHERE price_bw IS NULL`,
    [PRICING.bw]
  );
  await pool.query(
    `UPDATE shops SET price_color = $1 WHERE price_color IS NULL`,
    [PRICING.color]
  );

  // Migration: printed_at marks the moment a job first entered "printing" -
  // distinct from updated_at, which keeps changing on every later status
  // move (ready, collected). The hourly page cap needs to know specifically
  // "how many pages did this shop send to a printer since the top of this
  // clock hour", so it needs its own timestamp that's set once and never
  // touched again.
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ;
  `);

  // Migration: index on student_phone (item #3 — order history lookup by
  // phone number). Every history query filters on this column, and it was
  // unindexed before now (fine while there were only a handful of rows,
  // not fine once a shop has a real volume of jobs).
  await pool.query(`
    CREATE INDEX IF NOT EXISTS print_jobs_student_phone_idx ON print_jobs (student_phone);
  `);

  // Case-insensitive uniqueness on shop email and name. The `email` column
  // already has a plain UNIQUE constraint, but that's case-sensitive at the
  // DB level (Postgres treats 'Ravi@x.in' and 'ravi@x.in' as different
  // strings) - these functional indexes close that gap, and also stop two
  // shops registering under the same name (e.g. "Sharma Xerox" twice).
  // Wrapped in try/catch: if an existing install already has case-variant
  // duplicates sitting in the table, creating the index would fail and take
  // the whole app down on boot - better to log a warning and let the app
  // start, so whoever's running this can clean up the dupes and restart.
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS shops_email_lower_idx ON shops (LOWER(email));
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS shops_name_lower_idx ON shops (LOWER(name));
    `);
  } catch (err) {
    console.warn(
      '[migrate] Could not create case-insensitive uniqueness indexes on shops - ' +
        'likely existing case-variant duplicate name/email rows. New signups are ' +
        'still checked in application code either way. Error:',
      err.message
    );
  }


  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL
    );
  `);

  // Seed the single admin account, but ONLY if the table is completely
  // empty - this runs on every boot, so without this guard it would reset
  // the password back to ADMIN_INITIAL_PASSWORD every restart, undoing
  // anything changed via POST /api/admin/change-password. Uses bcrypt
  // directly here (not auth.js's hashPassword) to avoid a require cycle
  // between db.js and auth.js.
  const { rows: adminCountRows } = await pool.query('SELECT COUNT(*)::int AS count FROM admins');
  if (adminCountRows[0].count === 0) {
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(ADMIN_INITIAL_PASSWORD, 10);
    await pool.query(
      `INSERT INTO admins (id, email, password_hash, created_at, updated_at)
       VALUES ('admin_001', $1, $2, NOW(), NOW())`,
      [ADMIN_EMAIL.trim().toLowerCase(), passwordHash]
    );
    console.log(
      `[migrate] Seeded initial admin account (${ADMIN_EMAIL}). ` +
        'Log in and change the password via the admin panel - this seed only runs once.'
    );
  }


  // - simulated here at boot since there's no admin panel yet. Safe to run
  // every startup: ON CONFLICT DO NOTHING means it's only ever created once.
  await pool.query(
    `INSERT INTO landmarks (id, name, created_at)
     VALUES ('lm_anurag_university', 'Anurag University', NOW())
     ON CONFLICT (id) DO NOTHING;`
  );

  await pool.query(
    `UPDATE shops SET landmark_id = 'lm_anurag_university' WHERE landmark_id IS NULL;`
  );

  // Migration: multi-document batch upload. A batch groups several
  // print_jobs rows (one per uploaded document) under a single combined
  // payment and a single token number, so a student uploading 3 files pays
  // once and picks up once. batches.status/token_number mirror print_jobs'
  // own status machine (uploaded -> queued -> printing -> ready ->
  // collected) but track the whole order, not any one document - the
  // per-document rows still carry their own status too, since a shop owner
  // may in principle advance them individually.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS batches (
      id            TEXT PRIMARY KEY,
      shop_id       TEXT NOT NULL REFERENCES shops(id),
      student_phone TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('uploaded','queued','printing','ready','collected')),
      token_number  TEXT,
      amount_due    INTEGER NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS batch_id TEXT REFERENCES batches(id);
  `);
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS print_jobs_batch_id_idx ON print_jobs (batch_id);
  `);

  // Migration: shop's own UPI ID (e.g. "shopowner@okhdfcbank") + the
  // pay-then-prove-it flow. A student is redirected to pay this UPI ID
  // directly (same soundbox/QR the shop already uses for every other
  // customer) rather than through a payment gateway - there's no webhook to
  // tell us payment succeeded, so instead:
  //   uploaded -> payment_pending (student submitted a screenshot, or chose
  //               cash-at-counter) -> queued (SHOP OWNER reviewed the
  //               evidence and tapped confirm) -> ...
  // payment_method distinguishes the two paths; payment_screenshot_url is
  // only ever set for 'upi'. If the shop owner rejects what they see (bad
  // screenshot, no cash handed over), the row goes back to 'uploaded' with
  // payment_rejection_reason set, and the student can resubmit.
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS upi_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS payment_method TEXT CHECK (payment_method IN ('upi','cash'));
  `);
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS payment_screenshot_url TEXT;
  `);
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS payment_rejection_reason TEXT;
  `);
  await pool.query(`
    ALTER TABLE batches ADD COLUMN IF NOT EXISTS payment_method TEXT CHECK (payment_method IN ('upi','cash'));
  `);
  await pool.query(`
    ALTER TABLE batches ADD COLUMN IF NOT EXISTS payment_screenshot_url TEXT;
  `);
  await pool.query(`
    ALTER TABLE batches ADD COLUMN IF NOT EXISTS payment_rejection_reason TEXT;
  `);
  // Widen both status CHECK constraints to admit 'payment_pending', sitting
  // between 'uploaded' and 'queued'. Postgres names an inline column CHECK
  // constraint "<table>_<column>_check" by default, so that's what's
  // dropped before re-adding it with the new allowed list.
  await pool.query(`
    ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_status_check;
  `);
  await pool.query(`
    ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_status_check
      CHECK (status IN ('uploaded','payment_pending','queued','printing','ready','collected'));
  `);
  await pool.query(`
    ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_status_check;
  `);
  await pool.query(`
    ALTER TABLE batches ADD CONSTRAINT batches_status_check
      CHECK (status IN ('uploaded','payment_pending','queued','printing','ready','collected'));
  `);

  // Migration: Razorpay online payments. Unlike UPI/cash, this path never
  // touches 'payment_pending' - the gateway's signature IS the
  // confirmation, so uploaded -> queued directly (see routes/jobs.js and
  // routes/batches.js POST .../razorpay/verify). razorpay_order_id is set
  // the moment an order is created (before payment); razorpay_payment_id
  // only after verify succeeds - so a row with an order id but no payment
  // id means "checkout was opened but never completed", useful for
  // debugging abandoned payments later.
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS razorpay_order_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE batches ADD COLUMN IF NOT EXISTS razorpay_order_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE batches ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT;
  `);
  // Cashfree Easy Split order tracking - parallel to the razorpay_* columns
  // above, added alongside (not replacing) Razorpay so the existing,
  // working payment flow keeps functioning while Cashfree is rolled out
  // shop-by-shop as each one completes vendor (bank account) onboarding -
  // see the cashfree_vendor_id/vendor_status columns further down.
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS cashfree_order_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE batches ADD COLUMN IF NOT EXISTS cashfree_order_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_payment_method_check;
  `);
  await pool.query(`
    ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_payment_method_check
      CHECK (payment_method IN ('upi','cash','razorpay','cashfree'));
  `);
  await pool.query(`
    ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_payment_method_check;
  `);
  await pool.query(`
    ALTER TABLE batches ADD CONSTRAINT batches_payment_method_check
      CHECK (payment_method IN ('upi','cash','razorpay','cashfree'));
  `);

  // Migration: generic admin-editable settings (key/value), starting with
  // the two online-payment surcharges. Kept as a flexible table rather than
  // dedicated columns since "what settings the admin can tune" will likely
  // grow past just these two. Both fees are percentages of the print cost
  // (rounded to the nearest rupee when applied - see settings.js
  // computeFeeBreakdown, shared by routes/jobs.js and routes/batches.js),
  // and each has its own *_enabled toggle so the admin can turn a fee off
  // entirely without having to remember to also zero out its percentage -
  // "off" always means the fee contributes nothing, full stop. All four
  // default to 0/false - "no fee for the first few weeks" per the launch
  // plan - and are only inserted if missing, so re-running this migration
  // never resets a value an admin has already changed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`
    INSERT INTO settings (key, value, updated_at) VALUES
      ('service_fee_percent', '0', NOW()),
      ('service_fee_enabled', 'false', NOW()),
      ('service_fee_tier1_flat', '1', NOW()),
      ('service_fee_tier2_flat', '1.5', NOW()),
      ('gateway_fee_percent', '0', NOW()),
      ('gateway_fee_enabled', 'false', NOW()),
      ('gateway_fee_tier1_flat', '1', NOW()),
      ('gateway_fee_tier2_flat', '1.5', NOW())
    ON CONFLICT (key) DO NOTHING;
  `);
  // The old flat-rupee 'service_fee' key from before this table had
  // per-fee enabled toggles is no longer read anywhere - drop it so a
  // stale value can't cause confusion later.
  await pool.query(`DELETE FROM settings WHERE key = 'service_fee';`);

  // Migration: docx-to-pdf conversion needs LibreOffice on PATH, which
  // only exists on a Docker-based deploy - it doesn't work on Render's
  // default native Node runtime. Off by default rather than deleting the
  // feature, so it can be switched back on with zero code changes once the
  // backend moves to Docker. Image-to-PDF is client-side (pdf-lib) and
  // works regardless of hosting, so it defaults on - see settings.js
  // getUploadFlags for the exact default logic.
  await pool.query(`
    INSERT INTO settings (key, value, updated_at) VALUES
      ('docx_conversion_enabled', 'false', NOW()),
      ('image_conversion_enabled', 'true', NOW())
    ON CONFLICT (key) DO NOTHING;
  `);

  // Migration: record what was actually charged for an online payment
  // (print cost is amount_due; these two are the surcharges layered on top
  // at the moment the Razorpay order was created), so the fee breakdown a
  // student saw is auditable later even if the admin changes the fee
  // settings afterward.
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS service_fee INTEGER NOT NULL DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS gateway_fee INTEGER NOT NULL DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE batches ADD COLUMN IF NOT EXISTS service_fee INTEGER NOT NULL DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE batches ADD COLUMN IF NOT EXISTS gateway_fee INTEGER NOT NULL DEFAULT 0;
  `);

  // Migration: settlements - the platform (admin) periodically pays out a
  // shop's accumulated ONLINE (Razorpay) earnings to their bank account,
  // since that money lands in the platform's own Razorpay account first,
  // not the shop owner's. Cash payments never need a settlement row - the
  // shop owner already has that cash in hand the moment a student pays it
  // over the counter. Each row is one payout event: how much, when, and
  // how (bank transfer, UPI, cash, cheque). The shop owner's Earnings page
  // shows these read-only; only the admin panel can create/edit/delete them.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settlements (
      id           TEXT PRIMARY KEY,
      shop_id      TEXT NOT NULL REFERENCES shops(id),
      amount       INTEGER NOT NULL,
      settled_date DATE NOT NULL,
      mode         TEXT NOT NULL CHECK (mode IN ('bank_transfer','upi','cash','cheque','other')),
      note         TEXT,
      created_at   TIMESTAMPTZ NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS settlements_shop_id_idx ON settlements (shop_id);
  `);

  // Migration: admin-issued temporary passwords for shop owners who lose
  // access. Deliberately NOT self-service (no email OTP) - the admin
  // generates a numeric temp password out-of-band (see
  // POST /api/admin/shops/:shopId/temp-password) and relays it to the shop
  // owner directly (phone/in person), who logs in with it via the normal
  // login form. It's checked as a fallback in POST /api/shops/login only
  // when the real password doesn't match, expires after 10 minutes, and is
  // consumed (cleared) the moment it's used - a temp password only ever
  // gets someone in the door once.
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS temp_password_hash TEXT;
  `);
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS temp_password_expires_at TIMESTAMPTZ;
  `);
  // shops never had an updated_at column at all (unlike print_jobs,
  // batches, settlements) - the new change-password route needs one to
  // record when the password last changed, which is what actually
  // surfaced this gap (a 500 from referencing a column that didn't exist).
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
  `);

  // Migration: Cashfree Easy Split vendor onboarding. Each shop that wants
  // online payments settled straight to their own bank (rather than
  // sitting in this platform's account until an admin manually settles it
  // out) submits these once; the backend uses them to register the shop
  // as a Cashfree "vendor". cashfree_vendor_id is our own generated ID
  // (not something Cashfree assigns), sent on every split/order call.
  // vendor_status tracks Cashfree's own onboarding state for that vendor
  // (e.g. 'IN_BENE_CREATION' right after creation, 'ACTIVE' once bank
  // details are verified) - a shop can't actually receive a split until
  // it reaches an active state, so routes/jobs.js checks this before
  // ever creating a split payment for that shop.
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS cashfree_vendor_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS vendor_status TEXT;
  `);
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_account_number TEXT;
  `);
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_ifsc TEXT;
  `);
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_account_holder TEXT;
  `);
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS pan TEXT;
  `);

  // Migration: a student's name, captured once per phone number. The first
  // time a phone number places an order anywhere, the student app requires
  // a name and this table remembers it - every order after that (at any
  // shop) recognizes the phone number and skips asking again. student_name
  // is denormalized onto print_jobs/batches at creation time (rather than
  // joined from here on every read) so the shop dashboard's job list stays
  // a single query, and so a job's displayed name doesn't retroactively
  // change if the name were ever edited later.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      phone      TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS student_name TEXT;
  `);
  await pool.query(`
    ALTER TABLE batches ADD COLUMN IF NOT EXISTS student_name TEXT;
  `);

  // Migration: shop reviews, shown to students browsing shops (average
  // rating + count on the shop list, full list on a shop's page) and
  // optional to leave after an order is confirmed paid. source
  // distinguishes a real student's review (job_id set, tied to their
  // actual order) from one an admin typed in directly ('fake') - both
  // render identically to students, which is the whole point while the
  // platform is still building up a real review base, but admins can tell
  // them apart and moderate either kind (hide instead of only delete, so a
  // bad real review can be pulled without losing the record of it existing).
  // One real review per job/batch: the partial unique index only applies to
  // source='real' rows, so admin-added fake reviews (job_id always NULL)
  // are untouched by it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id           TEXT PRIMARY KEY,
      shop_id      TEXT NOT NULL REFERENCES shops(id),
      job_id       TEXT REFERENCES print_jobs(id),
      rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment      TEXT,
      author_name  TEXT NOT NULL,
      source       TEXT NOT NULL CHECK (source IN ('real','fake')),
      visible      BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_per_real_job
      ON reviews (job_id) WHERE source = 'real';
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS reviews_shop_id_idx ON reviews (shop_id);
  `);

  // Migration: admin-controlled top-to-bottom ordering for reviews. Default
  // display order is newest-first (created_at DESC); sort_order lets an
  // admin override that by hand from the Reviews tab, moving a chosen
  // review up or down. Higher sort_order sorts first - everywhere reviews
  // are listed for display uses "ORDER BY sort_order DESC, created_at DESC",
  // so reviews that have never been manually reordered (all sort_order = 0,
  // the default) fall back to the original newest-first order among
  // themselves, and only get displaced by ones an admin has actually moved.
  await pool.query(`
    ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
  `);

  // Migration: dual payment gateway + shop-owned Razorpay accounts.
  //
  // Cashfree isn't actually usable yet (the merchant account is still
  // pending activation), so the platform needs to keep running on Razorpay
  // in the meantime, and switch over to Cashfree later with one admin
  // toggle instead of a code change. 'active_payment_gateway' is that
  // toggle - the only settings key here that isn't a fee - and both
  // checkout routes (POST .../razorpay/create-order and .../cashfree/
  // create-order) keep working regardless of which one is "active"; the
  // setting only controls which one the student app actually offers, via
  // GET /api/settings/active-gateway.
  //
  // Separately: instead of every shop's online payment landing in this
  // platform's own Razorpay account first (the original design - see the
  // 'settlements' table above, which pays a shop OUT of that pooled
  // money), a shop can now register their own Razorpay key_id/key_secret.
  // When they have, their Razorpay orders are created directly against
  // their account, so the money - print cost AND the service/gateway fees
  // both - lands with them immediately, never touching this platform's
  // balance at all. That's the whole point (shop asked for payments to
  // "go to their account only"), but it also means the platform no longer
  // automatically collects its service fee for these jobs - see the
  // 'commission_payments' table below for how that's tracked instead.
  //
  // razorpay_key_secret is stored as plaintext, same trust level as every
  // other credential already in this table (cashfree_client_secret-style
  // fields don't exist because Cashfree uses one platform-wide account,
  // but bank_account_number/pan above are the same kind of sensitive
  // value already living here unencrypted) - real secrets-at-rest
  // encryption is a genuine gap, flagged here rather than silently
  // skipped, worth addressing before this handles real shop volume.
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS razorpay_key_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS razorpay_key_secret TEXT;
  `);
  await pool.query(`
    INSERT INTO settings (key, value, updated_at) VALUES
      ('active_payment_gateway', 'razorpay', NOW())
    ON CONFLICT (key) DO NOTHING;
  `);

  // print_jobs/batches.razorpay_account_key_id: which key_id actually
  // created this specific order - the shop's own (if they'd configured
  // one at that moment) or the platform's global RAZORPAY_KEY_ID. Denormalized
  // (not re-derived from the shop's current settings) for two reasons:
  // (1) verify must HMAC-check the signature with the SAME secret that
  // created the order, and a shop could in principle change/clear their
  // keys between create-order and verify; (2) commission accounting later
  // needs to know, permanently, whether this particular job's money went
  // to the shop directly or into the platform's own account, even if the
  // shop's key setup changes afterward.
  await pool.query(`
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS razorpay_account_key_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE batches ADD COLUMN IF NOT EXISTS razorpay_account_key_id TEXT;
  `);

  // commission_payments: the reverse of 'settlements'. Settlements are the
  // platform paying a shop money it already collected on their behalf;
  // commission_payments are a shop paying the PLATFORM its service-fee cut
  // for jobs that settled straight to the shop's own Razorpay account
  // (their own keys), where the platform never touched the money at all.
  // "Owed" isn't stored anywhere - it's computed on read as SUM(service_fee
  // + gateway_fee) over that shop's own-account jobs, minus SUM(amount)
  // here (see earnings.js getCommissionOwed) - same "ledger, not a
  // balance column" approach as settlements, for the same reason: it's
  // always derivable and can't drift out of sync with the underlying jobs.
  // No fixed cadence - the shop pays "weekly or whenever" per the
  // original ask, and the admin just records each payment as it comes in.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS commission_payments (
      id         TEXT PRIMARY KEY,
      shop_id    TEXT NOT NULL REFERENCES shops(id),
      amount     INTEGER NOT NULL,
      paid_date  DATE NOT NULL,
      mode       TEXT NOT NULL CHECK (mode IN ('bank_transfer','upi','cash','cheque','other')),
      note       TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS commission_payments_shop_id_idx ON commission_payments (shop_id);
  `);
}

module.exports = { pool, migrate };
