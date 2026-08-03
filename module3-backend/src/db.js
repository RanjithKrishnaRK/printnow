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
}

module.exports = { pool, migrate };
