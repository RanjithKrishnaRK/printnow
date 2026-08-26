# PrintNow Print Agent (Module 6) — Context & Rebuild Spec

This document has two parts:

1. **Context** — plain explanation of what the agent is, how it works today, and exactly which parts of your backend it talks to (verified against the actual code, not just the README).
2. **A ready-to-use prompt** — paste this into a fresh AI conversation (or hand to a developer) to build an equivalent agent from scratch, correctly wired to your current API.

---

## Part 1 — Context: what this agent is and how it works

### The problem it solves

Without it, a shop owner has to manually open every paid order and click print by hand. The agent runs in the background on the shop's own PC (the one physically connected to the printer), checks the queue automatically, and prints new jobs itself — with the right number of copies, duplex, and color settings already applied. It's entirely optional: the shop dashboard's manual "Send to printer" button works identically whether the agent is running or not.

### Where it lives, technically

- A single Node.js script (`src/index.js`), packaged into one self-contained Windows `.exe` via `pkg` — no Node.js install required on the shop owner's machine.
- Runs continuously, polling every 10 seconds by default.
- Registers itself to auto-launch on Windows login (registry `Run` key, no admin prompt needed).
- First run opens a small local setup page in the browser (login + printer picker) — after that, it never needs to be touched again.

### The on/off switch

Auto-print is a **setting stored on your backend**, per shop — not a setting inside the agent itself. The shop owner flips "🖨️ Auto-print" in the dashboard header; the agent checks that same flag every poll cycle and starts/stops accordingly, no restart needed.

### What happens each poll cycle, step by step

1. `GET /api/shops/:shopId/settings` — if `autoPrintEnabled` is `false`, do nothing this cycle.
2. If `true`: `GET /api/shops/:shopId/jobs?status=queued` — fetch every job currently waiting to print.
3. For each queued job, **in order, one at a time** (not parallel):
   a. Download the job's file directly from its `fileUrl` (served statically, no auth needed for this part).
   b. **Claim the print slot first**: `PATCH /api/jobs/:jobId/status` with `{ "status": "printing" }` — this happens *before* the physical print, specifically so your backend's hourly-page-cap check can reject it (`429`) before any paper/ink is spent, if the shop is over its configured hourly limit.
   c. Run the shop's configured print command against the file, substituting in that job's actual `copies`, `sides` (duplex/simplex), and `colorMode`.
   d. Clean up the downloaded temp file.
4. The shop owner still manually marks a job `ready` / `collected` from the dashboard once it's physically done and handed over — the agent only automates the "send it to the printer with correct settings" step, nothing after.

### Auth

- Logs in once via `POST /api/shops/login` with the shop's normal email/password (same credentials as the dashboard) and stores the returned JWT in memory.
- Every authenticated call wraps the request; on a `401` (expired token), it transparently logs in again and retries once — meant to run unattended for days without a manual restart.
- File downloads are unauthenticated (uploads are served as static files), so no token needed for that step.

### Config storage

- `%APPDATA%\PrintNowAgent\config.json` on Windows (shop email/password + the picked print command). Plain JSON, not encrypted — file permissions are tightened to owner-only where the OS supports it, which is "obfuscation," not real security, and is documented as such rather than hidden.
- Advanced overrides (`API_BASE_URL`, `POLL_INTERVAL_MS`, hand-tuned `PRINT_COMMAND`) come from an optional `.env` file sitting next to the exe.

### The tricky part: mixed color/b&w jobs

Windows has no single built-in "print this PDF with these settings" command the way Mac/Linux have `lp`/`lpr`. The agent uses **SumatraPDF** (free, recommended) with a configurable command template, e.g.:

```
"C:\Program Files\SumatraPDF\SumatraPDF.exe" -print-to-default -print-settings "{copies}x,{duplex},{color}" {file}
```

For a "mixed" job (some pages color, some black & white — see your `colorPages` field), the agent **splits the PDF into contiguous color/b&w runs and prints them as separate single-color jobs back to back**, in original page order, so the output comes out of the tray already collated. One documented caveat: on a double-sided mixed job, each run starts on a fresh sheet, so a color boundary falling mid-sheet costs one extra blank-backed sheet there — the agent logs a warning when this applies.

### Known, deliberately-not-hidden limitations

- Confirmed working on exactly one real setup (Windows + SumatraPDF) — `PRINT_COMMAND` is fully configurable *because* driver/printer behavior varies this much.
- If the physical print succeeds but the status-update call fails right after, the job stays `queued` and gets printed again next cycle — a duplicate print is the failure mode, not a missed job.
- Autostart is per-Windows-user, not tamper-proof (visible/removable from Task Manager's Startup tab).
- The setup UI is a plain local page on `127.0.0.1` (a random free port), only listening while setup is actually in progress — not a bundled GUI framework, to keep the packaged binary small.

---

## Part 2 — The exact API contract (verified against the live backend code)

Anyone rebuilding this agent needs to implement against these endpoints exactly. Base URL is your Render backend, e.g. `https://printnow-1.onrender.com`.

### 1. Login

```
POST /api/shops/login
Content-Type: application/json

{ "email": "owner@shop.in", "password": "..." }
```
**Response `200`:** `{ "shopId": "...", "token": "<JWT>" }`
**Response `401`:** `{ "error": "Invalid email or password" }`

Store the token; send it as `Authorization: Bearer <token>` on every call below. On any `401` from those calls, log in again and retry once.

### 2. Check auto-print is on

```
GET /api/shops/:shopId/settings
Authorization: Bearer <token>
```
**Response `200`:** includes `"autoPrintEnabled": true|false` among other shop settings. If `false`, do nothing this cycle.

### 3. Fetch the queue

```
GET /api/shops/:shopId/jobs?status=queued
Authorization: Bearer <token>
```
**Response `200`:** an array of job objects. The fields the agent actually needs per job:
```json
{
  "jobId": "uuid",
  "fileUrl": "/uploads/<uuid>.pdf",
  "pages": 12,
  "copies": 2,
  "sides": "single" | "double",
  "colorMode": "bw" | "color" | "mixed",
  "colorPages": "1-3,7"     // only present/meaningful when colorMode is "mixed"
}
```
`fileUrl` is always a **relative** path (`/uploads/...`) — join it with your backend's own base URL before fetching. Never treat it as an absolute URL from anywhere else; the backend guarantees it only ever points to something it uploaded itself.

### 4. Download the file

```
GET <API_BASE_URL><fileUrl>
```
No auth header needed — this is served as a static file.

### 5. Claim the print slot (before physically printing)

```
PATCH /api/jobs/:jobId/status
Authorization: Bearer <token>
Content-Type: application/json

{ "status": "printing" }
```
**Response `200`:** success — proceed to the physical print.
**Response `429`:** the shop's hourly page cap is currently full. Body: `{ "error": "...", "maxPagesPerHour": N }`. This is routine, not a fault — leave the job queued, it'll be retried automatically next hour.
**Response `4xx` (other):** a real error — log it, leave the job queued, move to the next job.

That's the entire contract. Nothing else in your backend needs to change for a rebuilt agent to work, as long as it implements exactly these five interactions in this order.

---

## Part 3 — The prompt to rebuild it from scratch

Copy everything in the box below into a new conversation with an AI coding assistant (or hand it to a developer) to build a fresh, equivalent agent.

```
Build a Windows background agent in Node.js called the "PrintNow Print Agent." It polls a print-shop backend's job queue and automatically sends new print jobs to a local printer.

CONTEXT
This agent runs on a shop owner's own PC (the one connected to their printer). It has nothing to do with the shop's login/dashboard except sharing the same account credentials. Auto-print is an on/off setting stored on the backend per shop, not inside this agent - the agent just checks that flag every cycle.

BACKEND API CONTRACT (do not deviate from this - it's a live production API)
Base URL is configurable (API_BASE_URL, default http://localhost:4000).

1. POST /api/shops/login
   body: { "email": "...", "password": "..." }
   -> 200 { "shopId": "...", "token": "<JWT>" }
   -> 401 { "error": "..." }
   Store the token in memory. Send it as "Authorization: Bearer <token>" on every authenticated call below.
   On a 401 from any authenticated call, log in again once and retry that call - never crash the process over an expired token, since this needs to run unattended for days.

2. GET /api/shops/:shopId/settings   (authenticated)
   -> 200 { "autoPrintEnabled": true|false, ...other fields you can ignore }
   If autoPrintEnabled is false, do nothing this poll cycle - don't fetch jobs at all.

3. GET /api/shops/:shopId/jobs?status=queued   (authenticated)
   -> 200 [ { "jobId": "...", "fileUrl": "/uploads/xyz.pdf", "pages": N, "copies": N, "sides": "single"|"double", "colorMode": "bw"|"color"|"mixed", "colorPages": "1-3,7" (only when colorMode is "mixed") }, ... ]
   fileUrl is always a relative path - join it with API_BASE_URL. Process jobs one at a time, in array order, never in parallel.

4. GET <API_BASE_URL><fileUrl>   (no auth needed - static file)
   Download the PDF to a local temp file.

5. PATCH /api/jobs/:jobId/status   (authenticated)
   body: { "status": "printing" }
   Call this BEFORE physically printing, not after - it's how the backend enforces an hourly page cap per shop.
   -> 200: proceed to print.
   -> 429 { "error": "...", "maxPagesPerHour": N }: the shop is over its hourly cap right now. This is routine - leave the job queued (don't error/crash), it'll be picked up again automatically next cycle/hour.
   -> other 4xx: log the error, leave the job queued, move to the next job in this cycle.
   Delete the local temp file when done, whether printing succeeded or failed.

PRINTING
Windows has no single built-in print-from-command-line tool. Use a configurable command template (a string with {file}, {copies}, {duplex}, {color} placeholders) that the shop owner sets up once, e.g. for SumatraPDF:
  "C:\Program Files\SumatraPDF\SumatraPDF.exe" -print-to-default -print-settings "{copies}x,{duplex},{color}" {file}
Support both a default system printer and printing to a specific named printer.

For colorMode "mixed" (some pages color, some black & white, described by the colorPages field, e.g. "1-3,7"): split the PDF into contiguous color/b&w page runs and print each run as a separate single-color print job, back to back in original page order, so they come out of the tray already collated in the right order. Log a warning if a color boundary falls in the middle of a duplex sheet pair, since that costs an extra sheet there.

CONFIG & SETUP
- First run: open a small local web page (127.0.0.1, random free port, shuts itself down once submitted) asking for shop email/password and printer choice (browse to a printer executable, or type a custom command). Save the result to a config file OUTSIDE the install folder (e.g. %APPDATA%\<AppName>\config.json on Windows) so it survives the exe being replaced.
- Every later launch reads that saved config directly - no browser page unless run with a --setup flag to reconfigure.
- Support a dev-mode shortcut: if SHOP_EMAIL and SHOP_PASSWORD are both set via environment variables/.env, skip the setup UI and log in with those directly (for local development only).
- Register the exe to auto-launch on Windows login (per-user registry Run key, no admin prompt) after first successful setup.
- Poll every 10 seconds by default (configurable).
- Package as a single self-contained Windows .exe (e.g. via `pkg`) so the shop owner never needs Node.js installed.

BE HONEST ABOUT LIMITATIONS IN THE README, DON'T HIDE THEM:
- Config file is plain JSON, not encrypted (tighten file permissions to owner-only where the OS allows it, but call this obfuscation, not real security).
- If a physical print succeeds but the status-update PATCH call fails right after, the job should stay "queued" and print again next cycle - a duplicate print is the acceptable failure mode here, not a silently lost job.
- Duplex/color driver support is genuinely hardware/driver-dependent and can't be guaranteed generically - include a way to test the exact print command against a real file without needing a live queued job (e.g. a --test-print flag with --dry-run to preview the command before actually printing).

Write this as clean, well-commented Node.js (CommonJS), structured for a solo maintainer to read a year later - explain WHY behind non-obvious decisions in comments, not just what the code does.
```

---

## If you want an AI to build a *replacement or improved* agent

Attach this whole document to the conversation and add one line describing what you want changed (e.g. "same as this, but also support macOS/CUPS" or "add a system tray icon instead of pure background"). Everything in Part 2's API contract stays fixed either way — that's the one part that must never drift from what your backend actually expects, since changing it would require also changing `routes/jobs.js` and `routes/shops.js` on the backend to match.
