# Deploying PrintNow for a real pilot with print shops

This covers three things: (1) where to put each module for free, (2) how
the print agent actually works in the real world (it's different from the
rest), (3) getting this onto GitHub.

## 1. Where each piece goes (all free tiers, checked July 2026)

| Module | What it is | Where | Why |
|---|---|---|---|
| module3-backend | Node/Express API | **Render** (free Web Service) | Only real free option left for a persistent Node process with Git deploys |
| Database | Postgres | **Neon** (free tier) | Permanent free tier, no card. Render's own free Postgres **expires after 30 days** - wrong choice for a pilot that needs to survive past a month |
| module1-student-app | Vite/React static site | **Vercel** or **Netlify** (free) | Static hosting, unlimited on both free tiers |
| module2-shop-dashboard | Vite/React static site | Same as above | Same |
| module5-admin | Vite/React static site | Same as above | Same |
| module6-print-agent | Node script | **A shop's own PC** - not a cloud service | See section 2, this one can't be "deployed" anywhere else |

### Two free-tier gotchas worth knowing before you start

1. **Render's free web service sleeps after 15 minutes idle**, and takes
   30-60 seconds to wake back up on the next request. A student ordering
   right after a quiet spell will see a slow first request. Two options:
   live with it (fine for a small pilot), or ping a health endpoint every
   ~10 minutes with a free service like cron-job.org to keep it awake
   during business hours.
2. **Uploaded PDFs are stored on local disk (`UPLOAD_DIR`), and Render's
   free web service disk is not persistent** - it resets on every
   redeploy *and* every time the service wakes from sleep. In practice:
   a PDF uploaded, then left un-printed for >15 minutes of overall site
   inactivity, can vanish before the print agent downloads it. For a
   short pilot this may not bite you, but it's the single biggest gap
   between "works locally" and "works for real" - worth moving uploads to
   something like Cloudflare R2 (10 GB free, S3-compatible) before this
   goes further than a test. Flagging it now rather than after a shop
   loses a real student's file.

### Step by step

**Database (Neon):**
1. neon.tech -> sign up, create a project -> copy the connection string it gives you.
2. That's your `DATABASE_URL`.

**Backend (Render):**
1. Push this repo to GitHub first (section 3).
2. render.com -> New -> Web Service -> connect the repo, root directory
   `module3-backend`, build command `npm install`, start command `npm start`.
3. Add environment variables from `module3-backend/.env.example` -
   `DATABASE_URL` (from Neon), `JWT_SECRET` (generate one, the file tells
   you how), `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD`, `UPLOAD_DIR`, and
   `CORS_ORIGINS` (leave this last one - come back to it once you have the
   frontend URLs below).
4. Deploy. Render gives you a URL like `https://printnow-backend.onrender.com`.

**Frontends (Vercel, one project per module):**
1. vercel.com -> New Project -> same GitHub repo -> set "Root Directory"
   to `module1-student-app` (repeat separately for `module2-shop-dashboard`
   and `module5-admin` - three separate Vercel projects, one repo).
2. Framework preset: Vite. Build command `npm run build`, output `dist`.
3. Environment variables: `VITE_API_BASE_URL` = your Render backend URL,
   `VITE_USE_MOCK=false` (module1/module2 only - module5 has no mock mode).
4. Deploy each. You'll get three URLs, e.g.
   `printnow-student.vercel.app`, `printnow-shop.vercel.app`,
   `printnow-admin.vercel.app`.

**Back to the backend - close the loop:**
1. On Render, set `CORS_ORIGINS` to the student app + shop dashboard URLs
   (comma-separated, no spaces) and redeploy.
2. In the Vercel project for module2, set `VITE_STUDENT_APP_URL` to the
   student app's URL so shop QR codes point at the real deployed app.

## 2. The print agent (module6) - this one doesn't "deploy"

Everything else above is a cloud service. This isn't, and can't be - it
has to physically talk to a printer, and no cloud provider has access to
a printer sitting in a shop in Telangana. It runs as a small background
program **on the shop owner's own computer**, the one plugged into their
printer, and nowhere else.

For each shop that wants auto-print:
1. On that shop's PC: `git clone` the repo (or just copy the
   `module6-print-agent` folder), `npm install`.
2. Copy `.env.example` to `.env`, fill in:
   - `SHOP_EMAIL` / `SHOP_PASSWORD` - their real dashboard login
   - `API_BASE_URL` - your deployed Render backend URL (not localhost anymore)
   - `PRINT_COMMAND` - the one thing that's genuinely per-computer; the
     `.env.example` file has a tested Windows command (SumatraPDF) and a
     Mac/Linux one (`lp`). Test it by hand with a real PDF before trusting
     the agent to run it unattended - this is the one part that can't be
     verified from here, it depends on that machine's printer driver.
3. `npm start` - and leave it running. For it to survive a PC restart or
   the shop owner closing the terminal by accident, wrap it in something
   that keeps Node processes alive: **pm2** (`npm i -g pm2` then
   `pm2 start src/index.js --name printnow-agent`, works on Windows/Mac/
   Linux) is the simplest cross-platform option. On Windows specifically,
   `pm2-windows-startup` (or just a shortcut to a `.bat` file in the
   Startup folder) makes it start automatically on boot.
4. One consequence of the backend sleeping (gotcha #1 above): the agent's
   poll requests will occasionally hit that 30-60s wake delay too. It
   already retries and re-logs in on failure, so this shows up as a slower
   cycle now and then, not a crash - but worth knowing if a shop asks why
   auto-print seems to "pause" sometimes.

Each shop that wants auto-print runs their own copy of this agent, pointed
at the one shared backend. Shops without it just use the dashboard's
manual "Send to printer" button - nothing else in the project depends on
this agent running.

## 3. Getting this onto GitHub

You mentioned the project's only ever lived as plain folders. From the
project's root folder (the one containing all six `module*` folders):

```bash
git init
```

Create a `.gitignore` at the root (if you don't already have per-module
ones covering this) so you don't commit `node_modules`, `.env` files, or
build output:

```
node_modules/
dist/
.env
uploads/
```

Then:

```bash
git add .
git commit -m "Initial commit"
```

Create an empty repo on github.com (no README/gitignore/license - keep it
truly empty so it doesn't conflict with what you just committed), then:

```bash
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

From then on, any time you want to save progress: `git add .`, then
`git commit -m "describe what changed"`, then `git push`. Render and
Vercel above both auto-redeploy on every push to `main` once connected -
that's the main practical benefit of doing this now.
