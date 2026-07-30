# CHANGES.md — What was broken, what I changed, and why

This project is three modules built somewhat independently:

- **Module 1** — `module1-student-app/` — student-facing order form (was a single loose `.jsx` file)
- **Module 2** — `module2-shop-dashboard/` — shop owner's queue dashboard
- **Module 3** — `module3-backend/` — the Express + SQLite API all of them talk to

Independently they were each fine. Wired together, three real problems surfaced. Here's each one, the fix, and the reasoning — read this before you touch the code further, so you don't accidentally revert a fix.

---

## 1. Module 1 called an endpoint that doesn't exist

**Symptom:** Every order would fail at the upload step.

**Cause:** Module 1's `realApi` called `GET /api/shops/:shopId/upload-url`, assuming a "pre-signed URL" upload pattern (get a URL, then PUT the file to it). Module 3 never implemented that — it implements a much simpler pattern: `POST /api/uploads` as `multipart/form-data`, where you send the actual file and get `{ fileUrl }` back directly.

**Fix:**
- `module1-student-app/src/StudentApp.jsx` — replaced `getUploadUrl()` with `uploadFile(file)`, which builds a `FormData` and posts the real file straight to `POST /api/uploads`. Both the mock and real implementations were updated so `MOCK_MODE` still works standalone.
- The call site in `UploadStep.handleSubmit` now does `await api.uploadFile(file)` instead of `await api.getUploadUrl(shopId)`.

**Why this way and not the reverse:** Module 3's upload route (`multer` disk storage) was already fully built and is simpler to run for an MVP (no S3/pre-signed-URL infra needed). Changing Module 1 to match it was less work and lower-risk than building a pre-signed-URL system in Module 3 just for this.

---

## 2. "Mixed" color mode and "sides" had nowhere to live

**Symptom:** Any order with `colorMode: "mixed"` would get rejected with a 400 from Module 3 (`colorMode must be "bw" or "color"`). The `sides` field (single/double) was silently dropped even for valid orders.

**Cause:** Module 1 was already flagging this itself in its file header — it added `sides`, `colorMode: "mixed"`, and `colorPages` beyond what Module 3's original contract supported, and left a comment saying it needed cross-team sign-off. Module 3's database schema and validation only knew `bw`/`color` and had no columns for the new fields.

**Fix (all in `module3-backend/`):**
- `src/db.js` — added two columns to `print_jobs`: `sides` (`'single'|'double'`, defaults to `'single'`) and `color_pages` (nullable text). Widened the `color_mode` CHECK constraint to allow `'mixed'`.
- `src/pricing.js` — added `parseColorPages(input, maxPages)`, a page-range parser (`"3,5,8-10"` → validated page set) that mirrors the one already written client-side in Module 1, so both sides agree on what's valid. Extended `calculateAmountDue` so `"mixed"` bills the listed pages at the color rate and every other page at the b/w rate.
- `src/routes/shops.js` — job creation now accepts and validates `sides` and `colorPages`, storing them, and pricing correctly. `colorPages` is required and validated only when `colorMode === "mixed"`. The shop's job-list query (`GET /api/shops/:shopId/jobs`) now also returns `sides` and `colorPages` so Module 2 can display them.
- `module2-shop-dashboard/src/components/JobCard.jsx` — the badge now shows "Mixed (pg 3,5,8-10)" instead of collapsing everything non-"color" into "B&W", plus a small "2-sided" badge when `sides === "double"`.

**Why validate on the backend too, not just trust Module 1's client-side check:** Never trust client-side validation alone — anyone can call the API directly (Postman, curl, a modified frontend) and bypass Module 1 entirely. The backend is the actual source of truth for pricing, so it has to independently validate and compute `amountDue`.

---

## 3. Module 1 had no project — just one file

**Symptom:** `StudentApp.jsx` couldn't be run at all. No `package.json`, no `index.html`, no build tooling, no way to `npm run dev` it.

**Fix:** Built out `module1-student-app/` as a full Vite + React + Tailwind project, matching Module 2's setup exactly (same dependency versions, same tool: Vite, same styling: Tailwind) so both frontends are built and run identically:
- `package.json`, `vite.config.js`, `index.html`, `src/main.jsx`, `tailwind.config.js`, `postcss.config.js`, `src/index.css`
- `StudentApp.jsx` dropped into `src/` unchanged apart from the fixes above

**Also fixed:** `MOCK_MODE` and `API_BASE_URL` were hardcoded (`true` and `"https://api.example.com"`). Changed to read from Vite env vars (`VITE_USE_MOCK`, `VITE_API_BASE_URL`) via a `.env` file, exactly like Module 2 already did in its `api.js`. This means switching from mock data to the real backend is now a one-line `.env` edit in both frontends, not a code change.

---

## 4. Ports and CORS

Three dev servers need three different ports, and Module 3's CORS allow-list has to name them exactly.

- `module1-student-app` → pinned to port **5173** in `vite.config.js`
- `module2-shop-dashboard` → pinned to port **5174** in `vite.config.js`
- `module3-backend` → **4000** (`PORT` in `.env`)
- `module3-backend/.env` → `CORS_ORIGINS=http://localhost:5173,http://localhost:5174` (this already matched by default — no change needed there, just made sure the frontends actually use those exact ports instead of leaving it to Vite's auto-increment, which could silently pick 5175/5176 and get CORS-blocked)

---

## What I deliberately did NOT change

- **Payment verification is still a stub.** `POST /api/jobs/:jobId/payment` trusts whatever `paymentRef` string it's given — it doesn't verify anything against a real payment gateway. Fine for a demo, not fine for real money. Flagged in the backend code already; still flagging it here.
- **SMS notifications are still a `console.log` stub** (`src/notify.js`). Plug in Twilio/Gupshup/WhatsApp Business API there later — it's the only file that needs to change for that.
- **There's no shop signup/registration endpoint** — shops are created via `scripts/seedShop.js` directly against the DB. Fine for a handful of pilot shops onboarded manually; would need a real endpoint (with its own auth/approval story) beyond that.
- **Single flat pricing for all shops** (`PRICING` in `config.js`). Per-shop pricing is a bigger schema change (a `shop_pricing` table) — not done here since it wasn't part of what was blocking integration.

I did not touch anything in these three files/areas beyond what's listed above.

---

# Phase 1 additions — branding, home page, location-based discovery, responsive layout

Everything below was added after the initial integration fix above, per an explicit feature request. Order matters here too — read this before changing landmark/discovery-related code.

## 1. Rebranding to "PrintNow"

Cosmetic only — page titles (`index.html` in both frontends), the shop dashboard's header/logo letter, and Module 1's header label. No behavior changed. `package.json` `name` fields updated too (`printnow-student-app`, `printnow-shop-dashboard`, `printnow-backend`) — doesn't affect how anything runs, just what shows up in `npm ls` etc.

## 2. Landmark-based shop discovery (NOT GPS)

**What "location-based" means here, specifically:** an admin creates a landmark (e.g. a college — "Anurag University" is the only one seeded for beta). A shop registers under exactly one landmark. Students pick a landmark on Module 1's new home page and see only shops under it. This is deliberately simpler than GPS: no location permissions, no distance math, no accuracy issues — just a lookup table. GPS-based "shops near me" was explicitly ruled out for the beta.

**Backend (`module3-backend/`):**
- `src/db.js` — new `landmarks` table (`id`, `name`, `created_at`). New `landmark_id` column on `shops`, referencing `landmarks(id)`. The default landmark (`Anurag University`, id `lm_anurag_university`) is auto-seeded on every server boot via `INSERT OR IGNORE`, so it's always there without a manual step.
- **Migration safety:** if you already had a `data/printqueue.db` from before this change (you did — from testing the Phase 0 fixes), `CREATE TABLE IF NOT EXISTS shops` would NOT retroactively add the new `landmark_id` column, since the table already existed. `db.js` now checks `PRAGMA table_info(shops)` on boot and runs `ALTER TABLE shops ADD COLUMN landmark_id ...` if it's missing, then backfills any shop with a null `landmark_id` onto the default landmark. Verified this works by simulating an old-schema DB and confirming the migration + backfill both ran correctly.
- `src/routes/landmarks.js` (new) — `GET /api/landmarks`, public, returns `[{id, name}]`.
- `src/routes/shops.js` — new `GET /api/shops?landmarkId=...`, public, returns `[{shopId, name, landmarkId}]` for shops under that landmark. This had to go *before* the existing `/:shopId/jobs` routes in the file so Express doesn't try to match `landmarkId` as a `:shopId` path param.
- `scripts/seedShop.js` — now takes an optional 4th argument, a landmark name, defaulting to `"Anurag University"`. Errors clearly if you pass a landmark name that doesn't exist yet (since there's no admin UI to create one yet — that's Phase 4, the admin panel).

**Module 1 (`module1-student-app/src/StudentApp.jsx`):**
- New `HomeStep` component — shown when the URL has no `?shopId=` (a printed QR code pointing straight at a shop still skips this and goes straight to the order flow, unchanged).
- Real camera-based QR scanning via `html5-qrcode` (added as a dependency) — not a placeholder, it actually opens the device camera and decodes a QR code live. Scanned text is parsed as either a full URL containing `?shopId=` or a bare shop ID, so shops can print either kind of QR code.
- Landmark dropdown (populated from `GET /api/landmarks`) → tapping a landmark loads its shops (`GET /api/shops?landmarkId=...`) → tapping a shop moves into the existing upload flow with that `shopId`.
- Added a "← Choose a different shop" link back to the home screen, but only when the student arrived via the home page (not via a direct QR-code URL, where there's no "other shop" to switch to in that context).

## 3. Responsive layout (Module 2 / shop dashboard)

Module 1 was already mobile-first (narrow `max-w-md` layout) since students use phones. Module 2 was built desktop-first since shop owners use PCs, but per the request it also needs to work on mobile. Changes, all in `module2-shop-dashboard/src/components/`:
- `Dashboard.jsx` — header and main content padding shrink on small screens (`px-4 sm:px-6`); the status-tabs/refresh-button row stacks vertically below the `sm` breakpoint instead of forcing both into one cramped row, and the tabs row scrolls horizontally if it doesn't fit.
- `JobCard.jsx` — stacks vertically (job info, then action button) on narrow screens, sits side-by-side from `sm:` up. The action button goes full-width on mobile so it's easy to tap.

Nothing here changes desktop behavior — all changes are additive Tailwind breakpoint classes (`sm:`), so anything above ~640px wide renders exactly as it did before.

## What's still not done (next phases, in agreed order)

- Daily/time-window print copy limits per shop, shown to students
- Admin panel with cross-shop analytics/charts (separate login, no login change for students)
- Auto-print agent + physical buzzer alert (separate local-agent module, "Module 4" — explicitly not a website feature, see conversation)

---

# Phase 2 additions — real database, shop signup, QR image upload, auto-delete

## 1. Real database: SQLite → PostgreSQL

**Why this had to change:** `node:sqlite` (used through Phase 1) is a single-file, single-process database — fine for local development, but it doesn't handle concurrent writers safely for production, doesn't run anywhere but one machine's disk, and has no backup/replication story. PostgreSQL is the standard choice here: mature, battle-tested for exactly this kind of transactional app (jobs, payments, status transitions), and free to run either locally or hosted.

**What changed, file by file (all in `module3-backend/`):**
- `src/db.js` — completely rewritten. Was a synchronous `node:sqlite` wrapper (`db.prepare(...).get()/.run()/.all()`); now a `pg` connection `Pool` with an async `migrate()` function that creates all four tables (`landmarks`, `shops`, `print_jobs`, `token_counters`) with `CREATE TABLE IF NOT EXISTS`, plus a safe `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for the one column (`file_deleted_at`, see below) added after some installs' tables already existed.
- **Every route file and `tokenGenerator.js` had to change from sync to async**, since `pg` has no synchronous query API. Every `db.prepare(...).get(x)` became `await pool.query('... $1', [x])` — note the placeholder syntax also changed from SQLite's `?` to Postgres's `$1, $2, ...`.
- **Important gotcha handled:** Postgres folds unquoted column aliases to lowercase. The old SQLite code aliased columns like `id AS jobId` and got back `jobId` (SQLite preserves case). The exact same SQL against Postgres returns `jobid` (lowercase) — which would have silently broken every field name both frontends expect. Fixed by double-quoting every camelCase alias in every query: `id AS "jobId"`. If you add a new query later, remember this or you'll get lowercase keys.
- `tokenGenerator.js` — the token-number counter (`token_counters` table) is now a single atomic `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` statement, instead of a separate SELECT-then-INSERT-or-UPDATE. This is actually a correctness improvement, not just a port: the old two-step version had a race condition risk under concurrent requests (two students paying at the same instant could get the same token number) that Postgres's real concurrent-transaction support now closes properly.
- `src/config.js` — `DB_PATH` (file path) replaced with `DATABASE_URL` (a Postgres connection string).
- `src/server.js` — now does an explicit `SELECT 1` connectivity check and `migrate()` call before `app.listen()`, so if Postgres isn't reachable you get one clear error message pointing at `.env`, instead of the server appearing to start and then failing confusingly on the first request.
- `scripts/seedShop.js` — same sync-to-async conversion, and now calls `migrate()` itself first so it also works against a completely empty, brand-new database (not just one the server has already started against once).

**Tested against a real, running PostgreSQL 16 instance** (not just written and assumed correct) — full lifecycle re-run end to end: shop signup, duplicate-email rejection, unknown-landmark rejection, landmark-based shop discovery, file upload, mixed-mode job creation and pricing, payment, atomic token minting, all three status transitions, and the new auto-delete-on-collected behavior (see below). See the step-by-step setup section in `README.md` for exactly how to stand this up yourself — either a local install or a free hosted option.

## 2. Shop owner signup (self-service, with landmark selection)

Previously the *only* way to create a shop account was running `scripts/seedShop.js` by hand — fine for a couple of pilot shops onboarded personally, not something a shop owner could do themselves.

- **New endpoint:** `POST /api/shops/signup` in `src/routes/shops.js`. Body: `{ name, email, password, landmarkId }` → `{ shopId, token }` (signs them straight in, same shape as `/login`). Validates: name present, password ≥ 8 characters, `landmarkId` refers to a real landmark, email not already registered (409 if it is).
- **New UI:** `module2-shop-dashboard/src/components/Signup.jsx` — a form with a landmark dropdown (populated from `GET /api/landmarks`), wired into `App.jsx` as a second view alongside `Login.jsx`, with links both directions ("New shop? Register here" / "Already registered? Log in").
- **Confirmed this closes the loop you asked about:** a shop that signs up through this form is immediately visible to students browsing that landmark on Module 1's home page — there's no caching or separate step, `GET /api/shops?landmarkId=...` reads directly from the same `shops` table `POST /api/shops/signup` just wrote to. Verified this with a live test: signed up a new shop, then immediately queried the landmark endpoint and saw it appear.

## 3. QR: upload a saved image, not just live camera

Added an alternative to live camera scanning on Module 1's home page: a "Upload a saved QR image" button that opens the phone's file/photo picker, then decodes any QR code found in that image using the same `html5-qrcode` library's `scanFile()` method (rather than its live-camera `start()` method used for the camera option). Useful if a student has a screenshot of a shop's QR code, or a photo of one taken earlier, rather than pointing their camera at a physical code right now. Shows a clear error ("Could not find a QR code in that image...") if decoding fails, rather than a silent no-op.

## 4. Auto-delete uploaded files after "collected"

In `module3-backend/src/routes/jobs.js`'s `PATCH /:jobId/status` handler: when a shop owner marks a job `"collected"`, the server now deletes the uploaded PDF from disk (`fs.unlink`) and records `file_deleted_at` on the job row. This is best-effort — if the file's already missing or unreadable for some reason, it logs a warning and still completes the status update, rather than failing the request the shop owner is waiting on.

**Why after "collected" specifically, not earlier:** the file has served its entire purpose once it's been printed and physically handed over — there's no legitimate reason to keep a student's assignment/notes sitting on a shop's disk indefinitely after that point, but deleting it any earlier (e.g. at "ready") would risk the shop needing to reprint a page that jammed or came out wrong before the student has actually picked it up.

**Not yet done, flagging clearly:** this only deletes the local copy Module 3 stores. If you ever move file storage to S3/a cloud bucket (see the note already in `uploads.js` about swapping the storage engine), the delete-on-collect call in `jobs.js` will need to change from `fs.unlink` to that provider's delete API — it's isolated to one `try` block, so that's a small, contained change when the time comes.

## 5. Fixed: both frontends were still in mock mode (root cause of the signup/session-expired/landmark bugs you hit)

The real Postgres backend built in the previous pass was solid, but neither frontend had actually been switched over to use it yet:

- **Module 1** (`module1-student-app/.env`) had `VITE_USE_MOCK=true` — the landmark/shop browser was reading a hardcoded 2-shop fake list (`Sharma Xerox & Print Center`, `Campus Copy Point`), never touching the real database. This is exactly why a real signup "wasn't reflecting" — it genuinely wasn't being asked.
- **Module 2** (`module2-shop-dashboard/src/api.js`) had `USE_MOCK = true` hardcoded (not even env-driven). Its mock layer checked every job-fetch/status-update request's token against one fixed demo token (`MOCK_SHOP.token`). A shop that signed up got its own freshly-generated mock token, which never matched — so the dashboard's very first "load my jobs" call after signup threw `"Session expired. Please log in again."` immediately. This is the red-text bug.

**Fix:**
- `module2-shop-dashboard/src/api.js`: `USE_MOCK` is now env-driven (`VITE_USE_MOCK`, same pattern as Module 1), defaulting to `false` (real backend) now that it's tested.
- `module1-student-app/.env` and `module2-shop-dashboard/.env` (+ `.env.example` in both): `VITE_USE_MOCK` now defaults to `false`.
- Also fixed the underlying mock-mode bug itself (token check now validates against all mock-signed-up shops, not just the one demo shop), so mock mode still works correctly if you ever set `VITE_USE_MOCK=true` to demo without a server running.
- **Verified live**, not just written: stood up Postgres + the real backend, signed up a shop via `POST /api/shops/signup`, confirmed it appeared *immediately* in `GET /api/shops?landmarkId=...` (the exact call Module 1 makes), and confirmed `GET /api/shops/:shopId/jobs` returned `200 []` for the brand-new shop's own token (no session-expired error).

**If you deploy Module 1/2 separately from your dev machine**, double check `VITE_API_BASE_URL` in each `.env` points at wherever Module 3 is actually running — that's the other way "real mode" can silently fail (e.g. still pointing at `localhost:4000` from a deployed frontend).

## 6. Shop QR code — generate + download

- New `module2-shop-dashboard/src/components/ShopQrCode.jsx`: renders a QR code (via the `qrcode` npm package) encoding the shop's ID, with a "Download QR code" button that saves it as a PNG (`<shop-name>-qr-code.png`).
- Shows automatically right after a shop finishes signing up, and is always reachable afterward via a "Shop QR code" button in the dashboard header.
- QR content: by default encodes the bare `shopId` — Module 1's scanner already treats a raw scanned value as a shopId (see `extractShopIdFromScan` in `StudentApp.jsx`), so this works with zero backend or contract changes. If you later deploy Module 1 at a public URL, set `VITE_STUDENT_APP_URL` in `module2-shop-dashboard/.env` (e.g. `https://order.printnow.in`) and the QR will instead encode a full clickable link (`<that-url>?shopId=...`) — useful if you also want the QR to work for someone without the camera-scan flow, e.g. opening it from a gallery app.
- New dependency: `qrcode` (added to `module2-shop-dashboard/package.json`) — run `npm install` in that folder after unzipping.

## 7. Fixed: duplicate shop name/email at signup

Two gaps, both in `module3-backend/src/routes/shops.js`:

- **Email check was case-sensitive.** `owner@sunrise.in` and `Owner@Sunrise.in` were treated as two different emails, so the duplicate check silently let case-variant duplicates through.
- **Shop name had no check at all.** Nothing stopped two shops registering under the exact same name.

**Fix:**
- Signup now checks both email and name case-insensitively (`LOWER(email)`, `LOWER(name)`) and rejects duplicates of either with `409`.
- Email is normalized to lowercase before it's stored, and login now looks it up case-insensitively too, so `OWNER@SUNRISE.IN` still logs into the same account created as `owner@sunrise.in`.
- Added real database-level protection, not just an application-code check: two case-insensitive unique indexes on `shops` (`db.js`'s `migrate()`), so even if two signup requests land at the exact same instant (a race the app-code check alone can't fully prevent), Postgres itself refuses the second insert. The route catches that as Postgres error `23505` and still returns a clean `409` rather than a 500.
- **Verified live** against a real Postgres instance: same email in different casing → rejected; same name in different casing (different email) → rejected; logging in with the original email in a different case → still works.

## 7. Item 4: Admin panel (Module 5) — landmarks, shops, analytics, password management

New module, `module5-admin/` — a small separate React app (port 5175, same stack as Module 2). One admin account, no self-service admin signup.

**Backend (`module3-backend`):**
- New `admins` table (`src/db.js`). Seeded **once** on first boot from `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` in `.env` — the seed is guarded by "only if the table is empty," so restarting the server never resets a password you've since changed.
- `src/auth.js`: added `signAdminToken` / `requireAdminAuth`, separate from shop auth. A shop's token is rejected on admin routes (`403 Admin access required`) and vice versa — verified live.
- New `src/routes/admin.js`, mounted at `/api/admin`:
  - `POST /login` → `{ token, email }`
  - `POST /change-password` (auth) — `{ currentPassword, newPassword }`. **This is the "changeable any time" mechanism** — no separate reset flow, just log in and change it whenever, as many times as you like.
  - `GET /shops` (auth) — every shop platform-wide, with landmark name + job count
  - `GET /landmarks` / `POST /landmarks` (auth) — list with shop counts, and add new landmarks through the UI instead of hand-editing `db.js`'s seed
  - `GET /stats` (auth) — totals, revenue, jobs-by-status, color/sides mix, 14-day daily volume, top 5 shops by job count
- **Also fixed while in here:** `POST /api/shops/signup` previously only rejected a duplicate **email** — a second shop could register under an identical **name**. Now checks both, case-insensitively (`"Sharma Xerox"` and `"sharma xerox"` count as the same), with a clear `409` error. Added a matching DB-level unique index as a race-condition backstop, so two signups landing at the exact same instant still can't both succeed.

**Frontend (`module5-admin`):**
- `Login.jsx`, `Dashboard.jsx` (tab shell: Overview / Shops / Landmarks / Settings), `Overview.jsx` (stat cards + `recharts` charts — daily volume line chart, jobs-by-status bar chart, color-mix pie chart, top-shops bar chart), `Shops.jsx` (table), `Landmarks.jsx` (table + add form), `ChangePassword.jsx`.
- No mock mode — unlike Modules 1/2, an admin panel with fake data isn't useful even for a demo, so this always calls the real backend.

**Verified live**, not just written: seeded the admin account on boot, logged in, changed the password, confirmed the *old* password then correctly failed and the *new* one worked, added a landmark, listed shops with correct job counts, hit the duplicate-name signup rejection, pulled real stats, and confirmed a shop's token is rejected on admin routes.

**To run it:** `module3-backend/.env` needs `ADMIN_EMAIL` and `ADMIN_INITIAL_PASSWORD` (defaults provided, change them before going live) — restart the backend once against a fresh/updated database so the `admins` table gets created and seeded, then `cd module5-admin && npm install && npm run dev`. Default login is whatever you set in `.env`; change it immediately from Settings.

## 8. Fixed: uploaded file not showing for shop owner, admin panel shop delete, admin panel auto-refresh

Three separate items from this pass, one bug fix + two new admin panel features.

**Bug: student's uploaded PDF wasn't "reflecting" for the shop owner**

Root cause: `module3-backend`'s `/api/uploads` deliberately returns a host-relative `fileUrl` (e.g. `/uploads/<id>.pdf`), documented in `uploads.js` as swap-friendly for a future S3 move. That's correct for the backend, but `module2-shop-dashboard`'s `JobCard.jsx` used that value directly as an `<a href>`. A relative href resolves against the *current page's* origin — the shop dashboard's own dev server (port 5174), not the backend (port 4000) — so "View file" was a 404 the whole time, even though the job itself showed up fine.

**Fix:** `module2-shop-dashboard/src/api.js`'s `realGetJobs()` now normalizes every job's `fileUrl` to an absolute URL (`${VITE_API_BASE_URL}` + the relative path) before handing jobs to any component. Nothing in `JobCard.jsx` or `Dashboard.jsx` needed to change — they were already just rendering whatever `fileUrl` they were given. Mock mode already used absolute `https://example.com/...` URLs, so it's unaffected.

**Admin panel: shop delete**

- New `DELETE /api/admin/shops/:shopId` (`module3-backend/src/routes/admin.js`, auth required). `print_jobs.shop_id` and `token_counters.shop_id` are both `NOT NULL REFERENCES shops(id)` with no `ON DELETE CASCADE` (deliberate — a stray bug elsewhere should never be able to silently wipe job history), so this route does the cascade itself in a transaction: delete the shop's `print_jobs` rows, then `token_counters`, then the shop row, commit, then best-effort delete each of that shop's uploaded PDFs from disk (a missing/already-deleted file — e.g. a collected job that already auto-deleted its own PDF — just gets logged and skipped, never fails the request).
- `module5-admin/src/api.js`: new `deleteShop(token, shopId)`.
- `module5-admin/src/components/Shops.jsx`: each row now has a "Delete" button — confirms first (names the shop, warns it's permanent), removes it from the table optimistically, and rolls back with an error message if the request fails.

**Admin panel: auto-refresh**

Neither `Overview.jsx` nor `Shops.jsx` had ever been wired for auto-refresh — both only fetched once on mount, unlike Module 2's dashboard which already polled every 15s. Added the same pattern to both:
- `Overview.jsx`: stats/charts now refetch every 15s.
- `Shops.jsx`: shop list now refetches every 15s (so a newly-signed-up or newly-deleted shop shows up without a manual reload), plus a manual "↻ Refresh" button matching Module 2's.

**Verified:** both `module2-shop-dashboard` and `module5-admin` build clean (`npm run build`) with these changes; `admin.js` passes a Node syntax check. (No live Postgres instance was available in this environment to re-run the full end-to-end flow this pass — worth a quick smoke test on your end: sign up a shop, upload+pay for a job as a student, confirm "View file" opens the PDF from the shop dashboard; and in the admin panel, delete a test shop and confirm both the table and a follow-up `GET /api/admin/shops` no longer show it.)

## 9. Item 5: Software buzzer (audible + visual alert for new jobs)

Scoped down per your call: software buzzer only — no auto-print agent, no hardware buzzer. Lives entirely in `module2-shop-dashboard`.

**New `module2-shop-dashboard/src/buzzer.js`:**
- A two-tone chime (like a doorbell), synthesized on the fly with the Web Audio API — no audio file to ship, no new dependency.
- The document title flashes between `"🔔 New job! — PrintNow"` and its normal title every second until the tab regains focus, so it's noticeable even as a background tab.
- Mute preference stored in `localStorage` (this is a real browser app on the shop owner's own machine, not a sandboxed artifact, so that's the right place for it) — persists across reloads.

**Wired in:**
- `Dashboard.jsx`: tracks which job IDs it's already seen (`useRef`, not state — doesn't need to trigger a re-render). On every 15s poll, any job that's newly `queued` and wasn't seen before triggers the buzzer. The shop's *existing* queue at login time is recorded silently on the first load — it only buzzes for jobs that arrive *after* you're already looking at the dashboard, not the whole backlog the moment you log in.
- Header now has a `🔔 Buzzer on` / `🔕 Muted` toggle next to "Shop QR code" — muting silences the chime but the title still flashes (a silent visual alert), since mute is specifically about sound.
- `Login.jsx` / `Signup.jsx`: call `primeAudio()` on the submit click. Browsers require a user gesture before they'll allow audio playback at all — logging in / signing up is that gesture, so the chime is armed and ready well before the first job ever arrives (a background poll 15s later has no gesture of its own to piggyback on).
- `App.jsx`: wires up `stopFlashOnFocus()` once, so the flashing title clears the instant the shop owner clicks back into the tab.

**Verified:** `npm run build` passes clean with all of the above wired in. Browser audio/notification behavior (autoplay policy edge cases, exact chime volume/tone) is worth a quick real-browser check on your end — that's not something a build check confirms.

**Deliberately not built (per your steer):** the auto-print agent (a local background service that pulls jobs and sends them straight to a printer) and the hardware buzzer (physical device wired to the backend). Both are still on the table if you want them later — the auto-print piece in particular would need real hardware to verify against, which isn't available in this environment.

## 10. Item 5 (continued): Auto-print agent + per-shop on/off toggle

Building on last pass's software buzzer. This adds the other half of item 5 — a local agent that actually sends jobs to the printer — plus the on/off control you asked for.

**New: per-shop "Auto-print" setting (backend + dashboard)**

- `module3-backend/src/db.js`: new `shops.auto_print_enabled` column, `DEFAULT false` — opt-in, never on by default.
- New `GET` / `PATCH /api/shops/:shopId/settings` (`module3-backend/src/routes/shops.js`, shop-owner-only). This is the single source of truth — both the dashboard toggle and the print agent read/write the *same* flag, so they can never drift out of sync with each other.
- `module2-shop-dashboard`: header now has a `🖨️ Auto-print: On/Off` toggle right next to the buzzer toggle. Optimistic update with rollback on failure, same pattern as the buzzer mute toggle and job status changes elsewhere in this dashboard.

**New: `module6-print-agent/`** — the actual local agent

A small standalone Node.js program the shop owner runs on their **own computer** (the one physically wired to the printer) — not part of the web app, and nothing else depends on it running.

- Logs into the backend with the shop's own email/password (from a local `.env` — see `.env.example`), then polls every `POLL_INTERVAL_MS` (default 10s).
- Each cycle: checks `GET /settings` first — if auto-print is off, does nothing that cycle. This is the mechanism behind "shop owner has the option to turn autoprint on or off" — the agent has no separate switch of its own, it just obeys whatever the dashboard toggle currently says, checked fresh every cycle.
- If on: fetches `queued` jobs, downloads each PDF, runs a configurable `PRINT_COMMAND` against it (default `lp {file}` — works out of the box on Mac/most Linux via CUPS), then `PATCH`es the job to `printing` — the exact same transition the dashboard's manual "Send to printer" button already causes.
- Auto re-logs in on a `401` (token expiry) rather than requiring a manual restart; one bad job (corrupt PDF, printer offline) is logged and skipped rather than stopping the whole queue.

**Flagging clearly, not hiding it:** `PRINT_COMMAND` is fully configurable specifically because this is the one piece that depends entirely on what's actually installed on the shop's computer/printer/driver, and it could not be tested against real hardware in this environment. `module6-print-agent/README.md` and `.env.example` both call this out with Windows-specific notes (no built-in CLI print tool the way Mac/Linux have `lp`) and a recommendation to test the chosen command by hand first.

**Verified, concretely:** since no real printer/Postgres was available here, I stood up a throwaway fake HTTP backend that mimics the exact three endpoints the agent calls (`/login`, `/settings`, `/jobs`, `/status`) and ran the real agent against it end to end: login succeeded, it correctly skipped a cycle when `autoPrintEnabled: false`, and with it `true` it downloaded a fake PDF, ran a stand-in print command, called `PATCH .../status` with `{"status":"printing"}`, and correctly stopped re-processing that job on the next poll (queue came back empty). That confirms the agent's request flow, retry logic, and status transition are all correct — it does **not** confirm real printer output, which depends on your hardware and `PRINT_COMMAND` choice.

**To run it:** `cd module6-print-agent && npm install && cp .env.example .env` — fill in your shop's email/password and check `PRINT_COMMAND` against your printer setup, then `npm start`. Toggle Auto-print on/off any time from the dashboard header; the agent picks up the change within one poll cycle, no restart needed.

## 11. Five fixes/features from testing feedback

**1. Shop owner couldn't see the student's phone number**
`student_phone` was collected at upload and stored in the DB the whole time, but the shop-facing `GET /api/shops/:shopId/jobs` query (`module3-backend/src/routes/shops.js`) never actually selected it - so it existed in Postgres but never reached the dashboard. Added `student_phone AS "studentPhone"` to that query. `module2-shop-dashboard/src/components/JobCard.jsx` now shows it as a tap-to-call `tel:` link right under the job's status line.

**2. No back button in the student app (Module 1)**
There was a partial one (a small text link, only shown in one specific case) but nothing on the Review or Status steps. Rebuilt properly:
- The whole order-form (file, pages, copies, sides, color mode, phone) is now lifted from `UploadStep` up into `App` as `orderForm` state, instead of living inside the step component.
- `UploadStep` and `ReviewPaymentStep` both render a consistent "← Back" at the top now. Going back from Review to Upload keeps everything the student already entered - including the actual chosen file - because it was never thrown away, just handed down as props.
- Known gap, flagged rather than hidden: by the time Review is shown, a job already exists server-side in `uploaded` status (that's when `POST /jobs` runs). Going back doesn't cancel that row - it's simply left unpaid, same category as an abandoned cart. Nothing prints or charges from it.

**3. "Pages" was freely typed - no connection to the actual PDF**
A student could type any number, right or wrong, with no relationship to their file's real length. `module1-student-app` now reads the PDF client-side the moment it's chosen (`pdfjs-dist`, no server round trip) and gets the *real* page count, which becomes both the default value and a hard cap - the student can lower it (e.g. print only the first few pages) but can't type in more pages than the document actually has. If a file can't be parsed as a well-formed PDF for any reason, it falls back to manual entry with no cap rather than blocking the order.

**4. Print agent wasn't printing according to what the student actually chose**
It was just running `PRINT_COMMAND` against the raw file - number of copies, single/double-sided, and color/b&w were completely ignored; every job printed as 1 copy, simplex, in whatever mode the printer defaulted to. `PRINT_COMMAND` now supports `{copies}`, `{duplex}`, and `{color}` placeholders alongside `{file}`, filled in from the job's real settings before the command runs - see `.env.example` for exact SumatraPDF and CUPS/`lp` syntax. Flagged clearly: a "mixed" color job (some pages color, some b&w) has no generic command-line way to selectively color just those pages across arbitrary printer drivers - the agent logs a loud warning and falls back to printing the whole thing in color for that specific case, so it's never silently wrong.

**5. Manual "Send to printer" didn't print anything - it only changed the status**
New `module2-shop-dashboard/src/printHelper.js`: clicking "Send to printer" now fetches the PDF, opens it in a new tab, and triggers the browser's print dialog automatically - no more separately clicking "View file" then Ctrl+P. **Real, hard limit worth being upfront about** (not glossed over): no browser lets a webpage silently send a job to the printer without that final dialog - that's a security boundary no website can bypass, which is exactly why the Module 6 agent exists as a separate desktop program for shops that want truly zero-click printing. The manual path gets as close as the web platform allows: dialog opens automatically, and the exact copies/duplex/color for that job are already shown right on the job card next to the button, so it's a glance-and-match rather than a guess.

**Also fixed while in there:** the print agent's temp-file cleanup only ran if the status-update call succeeded - if that one call failed, the downloaded PDF was left behind. Restructured with a `finally` so the local file is deleted after every print attempt regardless of what happens after.

**Verified:** all three apps (`module1-student-app`, `module2-shop-dashboard`, backend) build/syntax-check clean. The print agent's new placeholder substitution was verified directly (a job with `copies: 3, sides: "double", colorMode: "bw"` correctly produced `COPIES=3 DUPLEX=duplex COLOR=monochrome`). The browser auto-print-dialog behavior and the PDF page-count detection depend on real browser behavior (pop-up blockers, PDF viewer quirks) that aren't fully exercisable in this environment - worth a quick real-world check on your end, same as the printer hardware itself.

## 12. One-command setup shortcut (root `package.json`)

Testing this locally meant 5 terminals, each with its own `npm install` and `npm run dev` — tedious, and easy to forget one. Added a root-level `package.json` (new — this project had none before, each module was fully independent) that's purely a convenience wrapper:

- `npm install` — installs the one small tool this needs (`concurrently`).
- `npm run install:all` — runs `npm install` inside all 5 module folders for you, via `npm --prefix <module> install` (no `cd`-ing around, works identically on Windows/Mac/Linux).
- `npm run dev` — starts the backend + all 3 frontends (`module1`, `module2`, `module5`) together in one terminal, each line labeled and color-coded (`[backend]`, `[student]`, `[shop]`, `[admin]`) via `concurrently`. Ctrl+C once stops all four.
- `npm run dev:agent` — starts Module 6 separately (kept out of the combined `dev` script on purpose, since it needs its own `.env` with real shop credentials filled in first — see step 7 in the README).

This changes nothing about how the 5 modules work individually — it's a thin wrapper, each module still has its own independent `package.json`/`node_modules`/lockfile exactly as before. Any one module can still be run on its own the old way if you ever need to restart just one without the others.

**Verified:** ran `npm run install:all` for real — all 5 modules installed cleanly in one pass. Ran `npm run dev` for real — backend, student app, shop dashboard, and admin panel all started together in one terminal, correctly labeled/colored, all three frontends reached "ready" (backend only failed here because this environment has no real Postgres — same as every other pass, not a shortcut-specific issue).

## §13 — Per-shop pricing + hourly page cap (item #2)

**Pricing is no longer one flat platform-wide rate.** Each shop now sets its
own ₹/page for black & white and color from a dedicated Settings page
(`module2-shop-dashboard/src/components/Settings.jsx`), editable anytime.
Fresh signups land there first, before the dashboard - a shop can't collect
orders priced at nothing.

**Backend (module3-backend):**
- `shops` table: new `price_bw`, `price_color`, `max_pages_per_hour`
  columns. Existing shops are backfilled with the old flat-rate constants
  from `config.js` so nothing re-prices on deploy - they just become
  editable instead of hardcoded.
- `print_jobs` table: new `printed_at`, stamped the moment a job first
  enters "printing". Distinct from `updated_at`, which keeps changing on
  later moves (ready, collected) - the hourly cap needs to know
  specifically "pages sent to a printer since the top of this clock hour".
- `pricing.js`: `calculateAmountDue()` now takes the shop's own `rates`
  instead of always reading the global constant.
- `GET/PATCH /api/shops/:shopId/settings`: extended to cover
  `priceBw`, `priceColor`, `maxPagesPerHour` alongside the existing
  `autoPrintEnabled`. PATCH accepts any subset - only fields present in the
  body are validated/changed. `maxPagesPerHour: null` clears the cap
  entirely ("no limit").
- New `GET /api/shops/:shopId/public` (no auth) - name + pricing + cap, for
  Module 1 to show a student once they've picked a shop.
- `PATCH /api/jobs/:jobId/status`: the queued → printing transition now
  enforces the shop's hourly page cap (pages × copies, summed since the
  top of the current clock hour). Over cap → 429, job is simply left
  "queued" - this **is** the auto-queue-for-next-open-hour behavior, no
  separate scheduling logic needed. A lone job bigger than the cap is still
  allowed through if the hour is otherwise empty, so it can't starve
  forever.

**Module 6 (print agent):** now claims the printing slot (calls the status
endpoint, which enforces the cap) **before** physically printing, not
after - printing first and finding out about the cap afterward would waste
paper/ink. A 429 (cap reached) is treated as routine and logged calmly,
not as an error; the job naturally gets retried next poll cycle.

**Module 1 (student app):** after a shop is picked, `UploadStep` fetches
that shop's public pricing/cap info and shows it, and the running estimate
now uses the shop's real rates instead of a hardcoded flat one.

**Module 2 (shop dashboard):** new Settings screen; dashboard header gets
a "⚙️ Settings" button to reach it anytime after onboarding.

Verified: all four touched modules (`module1`, `module2`, `module3`,
`module6`) build/syntax-check clean. No live Postgres in this environment,
so the actual hourly-cap SQL and migration haven't been run against a real
database - worth a quick real-world check on your end, same as always with
this sandbox.

## §14 — Student login by mobile number + order history (item #3)

No OTP, no password, no account table - matches the trust level already in
use elsewhere in this project (e.g. `paymentRef` is trusted at face value).
A student "logs in" simply by typing the same phone number they ordered
with; whoever knows that number can see that number's history, because
there's nothing stronger to check it against - each `print_jobs` row
already stores `student_phone`, and that's the only identity that exists.

**Backend (module3-backend):**
- New `GET /api/students/:phone/jobs` (`src/routes/students.js`, public,
  no auth). Validates the phone against the same `^[6-9]\d{9}$` pattern
  Module 1 already validates client-side, then returns that phone's last
  20 jobs (any shop), most recent first: shop name, status, token number,
  amount, pages/copies/color mode, created date.
- `src/db.js`: new index on `print_jobs.student_phone` - every history
  query filters on it, and it was unindexed before now.

**Module 1 (student app):**
- New `MyOrdersStep` component, reachable via a "📋 My Orders" link at the
  bottom of the home screen. Enter a phone number once → results list →
  tap any past order to land on the existing token/status screen
  (`StatusStep`), same as picking a shop and ordering fresh.
- The phone number is remembered in `localStorage` (`printq_phone`) after
  the first successful lookup, so returning students skip straight to
  their list next time - "Use a different number" clears it. This is the
  entire "login": nothing to verify, only something to save so it isn't
  retyped every visit.
- `api.getOrderHistory(phone)` added to both the mock layer (reads the
  same in-memory `mockDb` every `createJob()` call already writes to, so
  anything ordered earlier in a mock session actually shows up) and the
  real layer (calls the new endpoint above).

**Not done, flagging clearly:** this is intentionally NOT a secure login -
by design, per the "no OTP" instruction. Anyone who knows a phone number
(a shop owner, someone standing nearby who saw it once) can look up that
number's order history. Fine for names/token numbers/amounts on a campus
print queue; would need a real OTP provider (Twilio Verify, MSG91, etc.)
before this pattern should ever guard anything more sensitive.

Verified: `module1-student-app` builds clean (`npm run build`); all
backend files pass `node --check`, including the new route.

## §15 — Shop earnings dashboard, admin per-shop revenue, order-history summary

Three small, independent additions from the same feedback pass. Per-shop
pricing/hourly-cap editing (item #2) and showing that to students after
they pick a shop were both already built (§13) - not re-done here, just
confirming for the record since they came up again in the same list.

**Backend (module3-backend):**
- New `GET /api/shops/:shopId/earnings` (shop-owner-only). Returns
  `totalEarnings`/`totalJobs` (all-time, jobs that were actually paid for
  - `status != 'uploaded'`) and `todayEarnings`/`todayJobs` (same rule,
  `created_at` = today), plus a `jobsByStatus` breakdown.
- `GET /api/admin/shops` now also returns `totalRevenue` per shop (same
  "paid or later" rule), and the list is sorted by revenue instead of
  signup date - "shop-wise business data" for the admin to scan at a glance.

**Module 2 (shop dashboard):** new stat strip above the queue tabs -
today's earnings, all-time earnings, and current active-job count. Polled
on the same 15s cycle as the job queue, non-fatal if it fails to load (the
rest of the dashboard still works).

**Module 5 (admin panel):** `Shops.jsx` table gets a "Revenue" column next
to "Total jobs".

**Module 1 (student app):** `MyOrdersStep` (§14's phone-based order
history) now shows a 4-box summary above the list - total orders, orders
still in progress (paid/queued/printing), orders ready for pickup, and
total spent (paid orders only, matches the backend's revenue rule so the
number a student sees matches what the shop/admin see for the same jobs).

**Flagged, then fixed defensively (back-button "reload" report):** couldn't
get specifics on which back action or which page, so rather than wait,
fixed the two most likely causes and hardened against a third:
1. Every `<button>` in `module1-student-app` now has an explicit `type`
   (`"button"` unless it's an actual form submit). A button inside a form
   with no `type` defaults to `type="submit"` in HTML and triggers a real
   page navigation on click - the one form added this pass (My Orders'
   phone lookup) made this a live risk for the first time in this file.
2. Going "Back" to the home screen used to re-fetch landmarks and the
   selected landmark's shop list from scratch every time, showing a
   loading spinner mid-navigation - not a real page reload, but exactly
   what one looks like to someone tapping Back. `HomeStep` now caches both
   in a module-level object that survives the component unmounting/
   remounting (cleared only by an actual page reload), so returning to
   Home is instant and keeps whatever landmark was previously selected.

If the reload still happens after this, it's worth a screen recording -
that'll pin down the exact trigger a lot faster than guessing further.

Verified: `module1-student-app`, `module2-shop-dashboard`, and
`module5-admin` all build clean (`npm run build`); every backend file
passes `node --check`. No live Postgres in this environment to re-run the
earnings queries against real data - worth a quick check on your end.


