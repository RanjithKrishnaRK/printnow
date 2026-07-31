# PrintNow — Print Agent (Module 6)

A small background program a shop owner runs on their **own computer** (the
one connected to the printer). It watches their queue and, when
**Auto-print** is turned on from the shop dashboard, automatically prints
each new job instead of the shop owner having to open and print it by hand.

This is entirely optional. Nothing else in the project depends on it —
the shop dashboard's manual "Send to printer" button still works exactly
the same whether this agent is running or not.

## How the on/off toggle works

Auto-print is a **per-shop setting stored on the backend**, not a setting
inside this agent. Turn it on/off from the "🖨️ Auto-print" button in the
shop dashboard header. This agent checks that same setting before every
poll cycle — turn it off from the dashboard and the agent notices within
one cycle (`POLL_INTERVAL_MS`, default 10s) and stops printing. You don't
need to restart or reconfigure the agent when you flip the toggle.

## Setup — shop owner (using the packaged app)

1. Copy `PrintNowAgent.exe` (from `dist/`, see **Building the .exe** below)
   onto the shop's computer — the one physically connected to the printer.
2. Double-click it. The **first time only**, it opens a small setup page
   in your default browser:
   - Enter your shop email/password (the same login you use on the shop
     dashboard).
   - Under **Printer**, pick **SumatraPDF (recommended)** and click
     **Browse…** to find `SumatraPDF.exe` on this computer (usually under
     `Program Files`) — no copy-pasting a path by hand. Don't have
     SumatraPDF yet? It's free at sumatrapdfreader.org; install it first,
     then browse to it. If you use a different print tool, pick **Custom
     command** and type it in instead (see **Print settings** below for
     the syntax), or **Skip for now** to configure it later.
3. Submit. That's it — the agent saves everything, starts running in the
   background, and registers itself to launch automatically every time you
   log into Windows. You never have to open it, a terminal, or a `.env`
   file again.

**To change the printer or account later** (new printer, password
changed, picked "Skip" the first time), run the exe from a Command Prompt
with the `--setup` flag to reopen this same page, prefilled with what's
already saved:
```
PrintNowAgent.exe --setup
```

If your saved shop password stops working (e.g. it was changed on the
dashboard), the agent's console window will say so and point you at
`--setup` as well.

Before relying on it unattended, still test `PRINT_COMMAND` by hand once
(see **Print settings**, below) — that part depends on your specific
printer and can't be verified without your hardware.

## Setup — developer (running from source)

```bash
cd module6-print-agent
npm install
npm start
```

Running from source still shows the same first-run setup page in your
browser. As a dev-only shortcut you can skip it entirely by copying
`.env.example` to `.env` and filling in `SHOP_EMAIL`/`SHOP_PASSWORD` there —
if both are set in `.env`, the agent uses them directly and never shows the
setup UI or touches the saved-config file. Autostart registration is also
skipped automatically when running via plain `node` (it only registers the
packaged `.exe`, not `node.exe`).

## Building the .exe

```bash
cd module6-print-agent
npm install
npm run build:win
```

Produces `dist/PrintNowAgent.exe` — a single self-contained Windows binary
(via [`pkg`](https://github.com/vercel/pkg)) that a shop owner can just
double-click. No Node.js install required on their machine.

## Print settings

Check `.env.example` — it still controls the technical, per-computer
settings (`API_BASE_URL`, `POLL_INTERVAL_MS`, and especially
`PRINT_COMMAND`, which is the one thing that varies by printer/OS and is
worth testing by hand first). These are advanced/optional overrides read
from a `.env` file sitting next to the exe if you want to change them from
their defaults; the shop login itself no longer goes through this file.

## Testing duplex/color against your real printer

`duplex`/`color` support is genuinely driver-dependent — some
printers/drivers silently ignore one or both even with correct command
syntax. Worth verifying on your actual hardware once, rather than assuming
it works because the syntax looks right. You don't need a live queued job
to test this — point the agent at any local PDF directly:

```bash
node src/index.js --test-print ./sample.pdf --copies 2 --sides double --color bw
```

Add `--dry-run` first to just print the exact command(s) that would run,
without using any paper, so you can sanity-check the placeholder
substitution before testing against the real printer:

```bash
node src/index.js --test-print ./sample.pdf --copies 2 --sides double --color mixed --color-pages "2,4-5" --dry-run
```

Then run it again without `--dry-run` and physically check the output:
right number of copies, actually double-sided (not two single-sided
stacks), and color/b&w pages matching what you asked for. If something's
off, the driver is likely ignoring that setting — try `duplexlong` or
`duplexshort` instead of `duplex` in `PRINT_COMMAND`, or check the
printer's own default settings/driver version.

## Where the saved settings live

`%APPDATA%\PrintNowAgent\config.json` on Windows (or
`~/.printnow-agent/config.json` when running from source on Mac/Linux for
development) — holds the shop login and the print command picked/entered
during setup. Plain JSON, not encrypted — see the comment at the top of
`src/config.js` for the reasoning and what that trade-off actually means
in practice. Run the agent with `--setup` to change anything in this file
through the UI, or delete it directly to force a completely fresh setup on
next launch.

## What it actually does, each poll cycle

1. Check `GET /api/shops/:shopId/settings` — if `autoPrintEnabled` is
   `false`, do nothing this cycle.
2. If it's `true`, fetch `GET /api/shops/:shopId/jobs?status=queued`.
3. For each queued job: download its PDF, run `PRINT_COMMAND` against it —
   with `{copies}`, `{duplex}`, and `{color}` filled in from that job's
   actual settings, alongside `{file}` (see `.env.example` for exact
   syntax) — then `PATCH /api/jobs/:jobId/status` to `printing`, the same
   transition the dashboard's manual "Send to printer" button causes.
4. The shop owner still manually marks a job `ready` / `collected` from the
   dashboard once it's actually finished printing and in hand — this agent
   only automates the "send it to the printer, with the right settings"
   step.

## Known limitations (flagging clearly, not hiding them)

- **Not tested against real hardware** beyond one confirmed working setup
  (Windows + SumatraPDF). `PRINT_COMMAND` is fully configurable
  specifically because printer/OS/driver behavior varies a lot.
- **Windows has no single built-in print-from-command-line tool** the way
  Mac/Linux have `lp`/`lpr` via CUPS. See `.env.example` for the
  SumatraPDF command (recommended, confirmed working).
- **"Mixed" color jobs (some pages color, some b&w)** are split into
  contiguous color/b&w runs and printed as separate single-color jobs, back
  to back, in original page order (see `src/pdfSplit.js`) — so the output
  comes out of the tray already collated. One caveat: on a **double-sided**
  mixed job, each run starts on a fresh sheet, so a color/b&w boundary that
  falls mid-sheet costs one extra sheet there (blank on one side) rather
  than continuing the duplex pairing across the color change. Content and
  page order are still correct either way; the agent logs a warning when
  this applies to a given job.
- **If printing succeeds but the status-update call fails** (e.g. a brief
  network blip right after printing), the job stays `queued` and will be
  picked up and printed *again* next cycle. A duplicate physical print is
  the known failure mode here, not a missed one — reasonable for an MVP,
  but worth knowing. The downloaded temp file is still cleaned up either
  way (this doesn't leak files, just potentially re-prints one).
- Runs jobs **one at a time**, in the order the queue returns them — not
  parallelized, so a slow print doesn't cause two jobs to print
  interleaved on the same printer.
- The shop's login token is valid for 7 days (same as the dashboard); the
  agent automatically re-logs in on a `401` rather than requiring a manual
  restart.
- **Autostart is Windows-only** and uses the current user's registry Run
  key (`HKCU\...\Run`) — no admin/UAC prompt needed, which is why setup can
  register it automatically, but it also means it's per-Windows-user (fine
  for the assumed one-owner-PC setup) and easy to remove from Task
  Manager's Startup tab if someone wants to (not tamper-proof — see
  `src/autostart.js` for the full reasoning).
- **The saved login (`config.json`) is plain text, not encrypted** — same
  exposure `.env` had before, just moved out of the project folder into
  the Windows user's own app-data folder. See `src/config.js` for why this
  trade-off was made rather than adding real encryption.
- The setup UI is a plain local HTTP page opened in the browser, not a
  native window — deliberate, to keep the packaged `.exe` a single small
  binary with no GUI framework bundled in. It only ever listens on
  `127.0.0.1` on a random free port, and only while setup (first-run or
  `--setup`) is actually in progress — it shuts itself down as soon as
  you submit.
