# Print Queue Automation — full project

Five modules now, one system:

```
┌──────────────────────┐        ┌───────────────────────┐        ┌──────────────────────┐
│ module1-student-app   │  HTTP  │    module3-backend     │  HTTP  │ module2-shop-dashboard │
│ (student, :5173)      │◄──────►│  Express + PostgreSQL   │◄──────►│ (shop owner, :5174)   │
│ React + Vite           │        │  (:4000)               │        │ React + Vite          │
└──────────────────────┘        └───────────┬────────────┘        └──────────┬────────────┘
                                              │ HTTP                            │ polls
                                   ┌──────────▼───────────┐         ┌─────────▼──────────┐
                                   │   module5-admin        │         │ module6-print-agent │
                                   │   (admin, :5175)       │         │ (local, no port)     │
                                   │   React + Vite          │         │ Node.js, runs on the │
                                   └────────────────────────┘         │ shop's own computer   │
                                                                       └──────────────────────┘
```

- **Module 1** — a student picks a shop (via QR scan, a saved QR image, or browsing by landmark), uploads a PDF, picks pages/copies/color mode, pays, and tracks their token number.
- **Module 3** — the API + PostgreSQL database. The only thing every other module talks to. Owns pricing, the job state machine, auth (shop + admin), shop signup, landmark discovery, file storage, and analytics.
- **Module 2** — the shop owner signs up or logs in and works the print queue: queued → printing → ready → collected. Has a software buzzer (sound + flashing tab title) for new jobs, and an Auto-print on/off toggle.
- **Module 5** — a single admin account manages landmarks, views/deletes shops, and sees platform-wide analytics (jobs, revenue, busiest shops).
- **Module 6** — an optional local agent a shop owner runs on their own computer. When Auto-print is on, it pulls queued jobs and sends them straight to the printer.

**If you're picking this up for the first time, read `CHANGES.md` first.** It's the running log of every bug fixed and feature added, in order, with reasoning — don't undo anything in there without reading why it's there first.

---

## 1. Prerequisites

- **Node.js 18+** (22+ is fine too). Check with:
  ```bash
  node --version
  ```
  If it's older or missing, get it from https://nodejs.org.
- Any code editor (VS Code works well, isn't required).

---

## 2. Database setup (do this first — everything else needs it)

Module 3 uses real PostgreSQL. Pick **one** option, then edit `module3-backend/.env`.

### Option A — hosted, zero local install (recommended)

1. Go to **https://neon.tech**, sign up free, create a new project (any name, e.g. "printnow").
2. Copy the **connection string** from the project dashboard — looks like:
   ```
   postgres://<user>:<password>@<host>/<database>?sslmode=require
   ```
3. Open `module3-backend/.env`, replace the `DATABASE_URL=` line with it.

(Supabase, Railway, and Render all work the same way if you'd rather use one of those.)

### Option B — install PostgreSQL locally

1. Download from **https://www.postgresql.org/download/** for your OS and run the installer.
2. It'll ask you to set a password for the `postgres` superuser — remember it. Keep the default port (`5432`).
3. Open a SQL shell (`psql`, or "SQL Shell (psql)" on Windows) and run:
   ```sql
   CREATE USER printnow WITH PASSWORD 'pick-your-own-password';
   CREATE DATABASE printnow_db OWNER printnow;
   ```
4. Open `module3-backend/.env` and set:
   ```
   DATABASE_URL=postgres://printnow:pick-your-own-password@localhost:5432/printnow_db
   ```

### Either way — you don't create tables by hand

The first time you run `npm run dev` in `module3-backend`, it automatically creates every table (shops, print_jobs, landmarks, admins, token_counters) and seeds the "Anurag University" landmark plus the one admin account — see `src/db.js`'s `migrate()`. This runs on every boot but only actually changes anything the first time.

---

## 3. Running everything

There are two ways to do this. Try the shortcut first — it's the same end
result, just one terminal instead of five.

### Shortcut — one terminal, one install, one run

From the project's root folder (the one with this README in it):

```bash
npm install          # installs the one small tool (concurrently) this shortcut needs
npm run install:all  # runs `npm install` inside all 5 module folders for you
npm run dev           # starts the backend + all 3 frontends together, labeled and color-coded
```

You'll see all four running in the same window, each line prefixed with
which one it's from:
```
[backend] Module 3 backend listening on http://localhost:4000
[student] ➜  Local:   http://localhost:5173/
[shop]    ➜  Local:   http://localhost:5174/
[admin]   ➜  Local:   http://localhost:5175/
```
Ctrl+C once stops all four together. This does **not** start the print
agent (Module 6) — that one needs its own `.env` filled in with real shop
credentials first (see step 7 below), so it's kept separate on purpose:
```bash
npm run dev:agent
```

This is a convenience wrapper only — `package.json` at the root just calls
`npm --prefix <module> install` / `run dev` for each module under the
hood. Nothing about how the 5 modules themselves work changes; you can
still run any one of them individually exactly as below if you ever need
to restart just one without the others.

### Manual — one terminal per module

Each module gets its own terminal. Start the backend first — everything else needs it.

### Terminal 1 — Backend (module3-backend)

```bash
cd module3-backend
npm install
npm run dev
```
You should see `Module 3 backend listening on http://localhost:4000`. Leave this running.

`.env` already has working defaults for everything except `DATABASE_URL` (which you just set in step 2). It also bootstraps the single admin account from `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` — defaults to `admin@printnow.in` / `change-me-on-first-login` if you don't change them. **Change that password from the admin panel (Module 5) the first time you log in.**

### Terminal 2 — Student app (module1-student-app)

```bash
cd module1-student-app
npm install
npm run dev
```
Opens at **http://localhost:5173**. Already pointed at the real backend (`.env` has `VITE_USE_MOCK=false`).

### Terminal 3 — Shop dashboard (module2-shop-dashboard)

```bash
cd module2-shop-dashboard
npm install
npm run dev
```
Opens at **http://localhost:5174**. Also real-backend by default. Click **"Register here"** to create your first shop — no need to seed one by hand.

### Terminal 4 — Admin panel (module5-admin)

```bash
cd module5-admin
npm install
npm run dev
```
Opens at **http://localhost:5175**. Log in with the admin email/password from Terminal 1's `.env`, then go to **Settings → change password** right away.

### Terminal 5 — Print agent (module6-print-agent) — optional

Only needed if you want a shop's queued jobs to print automatically. Skip this entirely if you're fine with the shop owner clicking "Send to printer" by hand.

```bash
cd module6-print-agent
npm install
cp .env.example .env
```
Edit `.env`: fill in `SHOP_EMAIL` / `SHOP_PASSWORD` (a real shop login from Terminal 3), and check `PRINT_COMMAND` matches something that works on this computer — see the comments in `.env.example` (defaults to `lp`, which works out of the box on Mac/most Linux; Windows needs a tool like SumatraPDF, noted there). Then:
```bash
npm start
```
It stays idle until the shop owner flips **🖨️ Auto-print: On** in the Module 2 dashboard header — the agent checks that setting itself every ~10 seconds, so toggling it in the dashboard is all you need, no agent restart.

---

## 4. Trying the whole flow end-to-end

1. **Module 5 (5175):** log in as admin, confirm "Anurag University" is listed under Landmarks (seeded automatically).
2. **Module 2 (5174):** click "Register here", sign up a shop under that landmark.
3. **Module 1 (5173):** pick "Anurag University" → your new shop should appear in the list → tap it → "Scan shop QR code" (or skip straight to the order form) → upload any PDF → fill in pages/copies/color/phone (phone must start 6-9) → submit → pay.
4. **Module 2 (5174):** the job appears in the Queued tab within 15 seconds (auto-refreshes). Click through Queued → Printing → Ready → Collected. "View file" should open the actual PDF you uploaded.
5. **Module 5 (5175):** refresh Overview/Shops — the shop, job count, and revenue should all reflect what you just did.
6. **Optional — Module 6:** turn on Auto-print in Module 2's header, upload another job from Module 1, and watch the agent's terminal log it downloading and "printing" the job automatically.

If you ever want to skip Module 1's home page and land directly on a shop's order page (e.g. for a printed QR code), go straight to:
```
http://localhost:5173/?shopId=<the shop's ID>
```

---

## 5. Verifying the backend directly (no frontend needed)

Useful when debugging "which side is broken":

```bash
# Health check
curl http://localhost:4000/health

# Upload a file
curl -X POST http://localhost:4000/api/uploads -F "file=@/path/to/some.pdf;type=application/pdf"
# -> {"fileUrl":"/uploads/<generated-name>.pdf"}

# Create a job (use the fileUrl above and a real shopId)
curl -X POST http://localhost:4000/api/shops/<shopId>/jobs \
  -H "Content-Type: application/json" \
  -d '{"fileUrl":"<fileUrl>","pages":10,"copies":1,"colorMode":"bw","studentPhone":"9876543210"}'

# Admin login
curl -X POST http://localhost:4000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@printnow.in","password":"change-me-on-first-login"}'
```

---

## 6. Git workflow

None of this is in Git yet. Recommended, since these modules are tightly coupled through Module 3's API contract:

### One repo, not five
Keep all five as top-level folders in **one monorepo** — exactly the layout you already have. A change to Module 3's job schema affects Modules 1, 2, and 6 all at once; separate repos would just mean cross-referencing commits to answer "what changed together."

```bash
cd "Print Queue Automation"
git init
git add .
git commit -m "Initial commit: 5 modules wired together"
```

### Branch naming
Prefix with which module a change touches:
```
module1/upload-flow-fix
module2/auto-print-toggle
module3/admin-shop-delete
module5/analytics-charts
module6/windows-print-command
shared/update-cors-ports
```

### Commit messages
Since a change to Module 3 usually affects at least one other module, say which side of the contract it touches:
```
module3: add auto_print_enabled column + settings endpoint

Module 2's new header toggle and module6's agent both read/write
this. See CHANGES.md #10 for full reasoning.
```

### Protecting the contract
The request/response shape between modules is the riskiest thing to break silently. Before changing a field name or endpoint in Module 3, grep every consumer:
```bash
grep -rn "autoPrintEnabled" module2-shop-dashboard/src module6-print-agent/src
```

### `.gitignore`
Already set up per-module (`node_modules/`, `dist/`, `.env` all excluded). `.env.example` files ARE committed — they're the template, not the secret.

---

## 7. Known gaps (not blockers, just be aware)

Flagged in the code and in `CHANGES.md` — repeating here so they're not missed:
- Payment (`POST /api/jobs/:jobId/payment`) trusts any `paymentRef` string — no real payment-gateway verification yet.
- SMS notifications are a `console.log` stub (`module3-backend/src/notify.js`).
- Pricing is flat/global, not per-shop.
- No per-shop/per-day print copy limits yet (deliberately skipped — see `CHANGES.md`).
- Module 6's print agent is untested against real hardware — `PRINT_COMMAND` is fully configurable specifically because printer/OS/driver behavior varies; test it by hand first (see `module6-print-agent/README.md`).
- If a print succeeds but the agent's status-update call fails right after, the same job can be picked up and printed again next cycle — a duplicate print, not a missed one. Documented in `module6-print-agent/README.md`.
- Only a software buzzer exists (sound + flashing tab title) — no physical/hardware buzzer.
