// src/index.js
//
// PrintNow local print agent (item 5, the auto-print half - the buzzer half
// lives in module2-shop-dashboard).
//
// What this is: a small background process the shop owner runs on their
// OWN computer (the one physically connected to the printer). It is NOT
// part of the web app - nothing in module1/2/3/5 depends on it running,
// and the shop dashboard works exactly the same with or without it. All it
// does is automate the one manual step a shop owner would otherwise do by
// hand: open each new job's PDF and hit print.
//
// How it decides whether to print anything: it reads the SAME
// "auto-print enabled" flag the shop owner controls from the dashboard's
// header toggle (GET /api/shops/:shopId/settings). If the shop owner turns
// it off from the dashboard, this agent notices within one poll cycle and
// stops printing - no separate on/off switch to keep in sync by hand.
//
// What "printing" means here, concretely: run whatever local OS command is
// configured in PRINT_COMMAND (see .env.example) against the downloaded
// PDF. This is the one part of the whole project that depends entirely on
// what's installed on the shop's specific computer and printer driver -
// it could not be tested against real hardware in the environment this
// was built in. Test PRINT_COMMAND by hand first (see .env.example).

// Only loads a .env if one is actually sitting next to the exe/script -
// harmless no-op otherwise. This remains the way to override the
// technical settings below (API_BASE_URL/POLL_INTERVAL_MS/PRINT_COMMAND);
// it is NOT how the shop's login gets in anymore - that now comes from the
// one-time setup UI (setupWizard.js) via config.js, so a shop owner never
// has to open a text file. SHOP_EMAIL/SHOP_PASSWORD in .env still work as
// a dev-time shortcut (skips the setup UI) but are no longer required.
require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { randomUUID } = require('crypto');
const agentConfig = require('./config');
const { runSetupWizard } = require('./setupWizard');
const autostart = require('./autostart');
const { splitIntoColorSegments } = require('./pdfSplit');

const {
  SHOP_EMAIL: ENV_SHOP_EMAIL,
  SHOP_PASSWORD: ENV_SHOP_PASSWORD,
  API_BASE_URL = 'http://localhost:4000',
  POLL_INTERVAL_MS = '10000',
  PRINT_COMMAND: ENV_PRINT_COMMAND,
} = process.env;

const DEFAULT_PRINT_COMMAND = 'lp {file}';
const POLL_MS = Number(POLL_INTERVAL_MS) || 10000;
const TMP_DIR = path.join(os.tmpdir(), 'printnow-agent');

// Set once main() resolves where the shop's settings came from (a saved
// config file, or freshly entered/picked into the setup UI this run).
let SHOP_EMAIL = ENV_SHOP_EMAIL;
let SHOP_PASSWORD = ENV_SHOP_PASSWORD;
let PRINT_COMMAND = ENV_PRINT_COMMAND || DEFAULT_PRINT_COMMAND;

let shopId = null;
let token = null;
let stopped = false;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function fail(message) {
  console.error(`[${new Date().toISOString()}] FATAL:`, message);
  process.exit(1);
}

// The backend returns fileUrl as a host-relative path (e.g.
// "/uploads/xyz.pdf") - same reasoning as the fix in module2's api.js: it's
// only meaningful once joined with the backend's own origin.
function absoluteFileUrl(fileUrl) {
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl;
  return `${API_BASE_URL}${fileUrl.startsWith('/') ? '' : '/'}${fileUrl}`;
}

// email/password are optional overrides so the setup wizard can validate
// what was just typed into the form (see runSetupWizard's validateLogin
// callback below) without that call also mutating the agent's live
// shopId/token - it's just "does this login work?", not "log the agent in
// as this". Normal polling calls login() with no args, which falls back to
// the module-level SHOP_EMAIL/SHOP_PASSWORD and does update shopId/token.
async function login(email = SHOP_EMAIL, password = SHOP_PASSWORD, { setLiveSession = true } = {}) {
  const res = await fetch(`${API_BASE_URL}/api/shops/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Login failed (${res.status})`);
  }
  const data = await res.json();
  if (setLiveSession) {
    shopId = data.shopId;
    token = data.token;
    log(`Logged in as shop ${shopId}`);
  }
  return data;
}

// Wraps an authenticated request; on a 401 (e.g. token expired) it logs in
// again once and retries, rather than crashing the whole agent over a
// token refresh - this is meant to run unattended for days at a time.
async function authedFetch(url, options = {}) {
  const doFetch = () =>
    fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });

  let res = await doFetch();
  if (res.status === 401) {
    log('Token rejected, logging in again...');
    await login();
    res = await doFetch();
  }
  return res;
}

async function getAutoPrintEnabled() {
  const res = await authedFetch(`${API_BASE_URL}/api/shops/${shopId}/settings`);
  if (!res.ok) throw new Error(`Could not check auto-print setting (${res.status})`);
  const data = await res.json();
  return !!data.autoPrintEnabled;
}

async function getQueuedJobs() {
  const url = new URL(`${API_BASE_URL}/api/shops/${shopId}/jobs`);
  url.searchParams.set('status', 'queued');
  const res = await authedFetch(url);
  if (!res.ok) throw new Error(`Could not fetch queued jobs (${res.status})`);
  return res.json();
}

async function downloadJobFile(job) {
  const url = absoluteFileUrl(job.fileUrl);
  const res = await fetch(url); // uploads are served statically, no auth needed
  if (!res.ok) throw new Error(`Could not download file (${res.status})`);
  await fs.mkdir(TMP_DIR, { recursive: true });
  const localPath = path.join(TMP_DIR, `${job.jobId}-${randomUUID().slice(0, 8)}.pdf`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(localPath, buffer);
  return localPath;
}

// Turns a job's settings into the placeholder values PRINT_COMMAND can use.
// colorOverride lets a caller force "color"/"monochrome" regardless of
// job.colorMode - used for "mixed" jobs, which get split into single-color
// segments and printed one at a time (see printMixedJob below); each
// segment passes its own override in here rather than job.colorMode, since
// job.colorMode for a mixed job is just "mixed", not printer-usable.
function jobPrintPlaceholders(job, colorOverride) {
  const copies = Math.max(1, parseInt(job.copies, 10) || 1);
  const duplex = job.sides === 'double' ? 'duplex' : 'simplex';
  const color = colorOverride || (job.colorMode === 'bw' ? 'monochrome' : 'color');
  return { copies, duplex, color };
}

function printFile(localPath, job, colorOverride) {
  return new Promise((resolve, reject) => {
    // {file} is substituted in, quoted, so paths with spaces don't break
    // the command. {copies}/{duplex}/{color} come from the job's actual
    // settings (see jobPrintPlaceholders) - not every printer/tool supports
    // all of these; only include the tokens your PRINT_COMMAND actually
    // understands (see .env.example for SumatraPDF/CUPS examples).
    // PRINT_COMMAND itself is trusted local config the shop owner sets in
    // their own .env - not user/network input.
    const { copies, duplex, color } = jobPrintPlaceholders(job, colorOverride);
    const command = PRINT_COMMAND.replace('{file}', `"${localPath}"`)
      .replace(/{copies}/g, String(copies))
      .replace(/{duplex}/g, duplex)
      .replace(/{color}/g, color);
    exec(command, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout);
    });
  });
}

// "Mixed" jobs (some pages color, some b&w) get split into contiguous
// same-color runs (see pdfSplit.js) and each run is printed as its own
// single-color print job, sequentially, in original page order - so the
// physical output comes out of the tray already collated, instead of two
// stacks (all color, all b&w) the shop owner would have to reassemble by
// hand. Each segment is written to its own temp file and cleaned up after.
//
// Known limitation: PRINT_COMMAND is invoked once per segment, i.e. as N
// separate print jobs. On a duplex ("double-sided") job, most drivers
// start every print job on a fresh sheet, so a segment boundary that falls
// mid-sheet (e.g. page 3 color / page 4 b&w, printed double-sided) will
// leave page 3's back side blank rather than actually printing page 4 on
// it - the output is still fully correct and in order, just on one extra
// sheet of paper at each boundary. Flagged in the log below so the shop
// owner isn't caught off guard; there's no generic fix for this without a
// print driver that supports true mid-document media/tray switching.
async function printMixedJob(localPath, job) {
  const pdfBytes = await fs.readFile(localPath);
  const segments = await splitIntoColorSegments(pdfBytes, job.colorPages, job.pages);

  if (job.sides === 'double' && segments.length > 1) {
    log(
      `⚠ Job ${job.jobId} is "mixed" color AND double-sided - each of the ${segments.length} ` +
        `color/b&w segments prints as its own job, so a segment boundary that falls mid-sheet ` +
        `will use an extra sheet there (blank on one side) rather than continuing the duplex ` +
        `pairing across colors. Page order and content will still be correct.`
    );
  }

  const tempPaths = [];
  try {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segPath = path.join(
        TMP_DIR,
        `${job.jobId}-seg${i}-${segment.color ? 'color' : 'bw'}-${randomUUID().slice(0, 8)}.pdf`
      );
      await fs.writeFile(segPath, segment.bytes);
      tempPaths.push(segPath);
      log(
        `Printing job ${job.jobId} segment ${i + 1}/${segments.length}: pages ${segment.pages[0]}` +
          `${segment.pages.length > 1 ? `-${segment.pages[segment.pages.length - 1]}` : ''} (${
            segment.color ? 'color' : 'b&w'
          })...`
      );
      await printFile(segPath, job, segment.color ? 'color' : 'monochrome');
    }
  } finally {
    for (const p of tempPaths) fs.unlink(p).catch(() => {});
  }
}

async function markPrinting(jobId) {
  const res = await authedFetch(`${API_BASE_URL}/api/jobs/${jobId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'printing' }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Could not update job status (${res.status})`);
    // 429 = the shop's hourly page cap is full for this hour (see routes/jobs.js).
    // This is an expected, routine outcome during a busy hour, not a fault -
    // tagged so processJob/pollOnce can log it calmly instead of as an error.
    if (res.status === 429) err.hourlyCapReached = true;
    throw err;
  }
}

// Handles one job end to end: download -> claim a printing slot -> print.
// The slot is claimed (marked "printing" server-side) BEFORE the physical
// print now, specifically so the hourly page-cap check in routes/jobs.js
// can actually stop paper/ink being spent on a job that's over the shop's
// own limit for this hour - checking after printing would be too late.
// Trade-off this flips from the original approach (print, then mark): if
// the physical print itself then fails for some unrelated reason (printer
// offline, bad file), the job is left showing "printing" without having
// actually printed, instead of silently retrying (and possibly
// double-printing) next cycle. That failure is loud - logged clearly below
// - rather than silent, which is the safer direction once real hourly
// quotas are on the line.
async function processJob(job) {
  log(`New queued job ${job.jobId} (token ${job.tokenNumber || 'pending'}) - downloading...`);
  const localPath = await downloadJobFile(job);
  try {
    log(`Requesting a printing slot for job ${job.jobId}...`);
    await markPrinting(job.jobId);
    log(`Slot granted - printing (${job.copies}x, ${job.sides}, ${job.colorMode})...`);
    if (job.colorMode === 'mixed') {
      await printMixedJob(localPath, job);
    } else {
      await printFile(localPath, job);
    }
    log(`Done: job ${job.jobId}`);
  } catch (err) {
    if (err.hourlyCapReached) {
      // Routine, not a fault: job stays "queued" and will be retried
      // automatically next poll cycle once the shop's hourly quota resets.
      log(`Job ${job.jobId} skipped this cycle - ${err.message}`);
      return;
    }
    throw new Error(
      `Marked job ${job.jobId} as "printing" but the physical print failed - it will NOT auto-retry (would double-print). Check the printer and reprint manually from the dashboard. Underlying error: ${err.message}`
    );
  } finally {
    // Delete the downloaded copy from this PC regardless of outcome - once
    // we're done with it (printed, skipped, or failed) there's no reason to
    // leave it sitting in the temp folder.
    fs.unlink(localPath).catch(() => {}); // best-effort, not worth failing over
  }
}

async function pollOnce() {
  const enabled = await getAutoPrintEnabled();
  if (!enabled) {
    log('Auto-print is off for this shop - skipping this cycle.');
    return;
  }

  const jobs = await getQueuedJobs();
  if (jobs.length === 0) {
    log('No new queued jobs.');
    return;
  }

  log(`${jobs.length} queued job(s) found - processing one at a time...`);
  for (const job of jobs) {
    try {
      await processJob(job);
    } catch (err) {
      // One bad job (corrupt PDF, printer offline, etc.) shouldn't stop the
      // rest of the queue - log it and move on to the next job.
      console.error(`[${new Date().toISOString()}] Could not process job ${job.jobId}:`, err.message);
    }
  }
}

// Resolves shop login + print command, in priority order:
//   1. .env (dev-time shortcut for login; PRINT_COMMAND in .env always
//      wins too, e.g. for testing a print command without going through
//      the picker)
//   2. saved config.json from a previous run's setup
//   3. neither (or --setup was passed) -> launch the setup UI, block here
//      until the shop owner submits a working login (+ optionally a print
//      command), save it, and - on a genuine first run - register
//      autostart so this only has to happen once.
async function resolveSettings({ forceSetup = false } = {}) {
  if (ENV_SHOP_EMAIL && ENV_SHOP_PASSWORD) {
    log('Using SHOP_EMAIL/SHOP_PASSWORD from .env (dev override) - skipping saved config and setup UI.');
    return {
      shopEmail: ENV_SHOP_EMAIL,
      shopPassword: ENV_SHOP_PASSWORD,
      printCommand: ENV_PRINT_COMMAND || DEFAULT_PRINT_COMMAND,
      wizardRan: false,
    };
  }

  const saved = await agentConfig.readConfig();
  if (saved && saved.shopEmail && saved.shopPassword && !forceSetup) {
    log(`Using saved settings from ${agentConfig.configPath()} (from earlier setup).`);
    return {
      shopEmail: saved.shopEmail,
      shopPassword: saved.shopPassword,
      printCommand: ENV_PRINT_COMMAND || saved.printCommand || DEFAULT_PRINT_COMMAND,
      wizardRan: false,
    };
  }

  log(forceSetup ? 'Reconfiguring (--setup) - opening setup UI...' : 'No saved settings found - this looks like the first run.');
  const entered = await runSetupWizard({
    // Validates against the real backend without touching the module-level
    // shopId/token - login() proper runs again just below with these same
    // credentials to actually establish the live session.
    validateLogin: (email, password) => login(email, password, { setLiveSession: false }),
    log,
    existing: saved || {},
  });
  const toSave = {
    shopEmail: entered.shopEmail,
    shopPassword: entered.shopPassword,
    printCommand: entered.printCommand || undefined,
    setupCompletedAt: new Date().toISOString(),
  };
  const savedPath = await agentConfig.writeConfig(toSave);
  log(`Saved settings to ${savedPath} - you won't need to enter this again.`);
  return {
    shopEmail: toSave.shopEmail,
    shopPassword: toSave.shopPassword,
    printCommand: ENV_PRINT_COMMAND || toSave.printCommand || DEFAULT_PRINT_COMMAND,
    wizardRan: true,
  };
}

async function main() {
  const forceSetup = process.argv.includes('--setup');
  const settings = await resolveSettings({ forceSetup });
  SHOP_EMAIL = settings.shopEmail;
  SHOP_PASSWORD = settings.shopPassword;
  PRINT_COMMAND = settings.printCommand;

  log(`Starting PrintNow print agent (backend: ${API_BASE_URL}, poll every ${POLL_MS}ms)`);
  log(`Print command: ${PRINT_COMMAND}`);
  if (PRINT_COMMAND === DEFAULT_PRINT_COMMAND && !(ENV_PRINT_COMMAND)) {
    log(
      `⚠ No printer was configured during setup - using the fallback "${DEFAULT_PRINT_COMMAND}", ` +
        `which won't work on Windows. Run the agent with --setup to pick your print program, or ` +
        `set PRINT_COMMAND in a .env file next to it.`
    );
  }

  try {
    await login();
  } catch (err) {
    // Only realistically hit here if a saved/previously-working password
    // was later changed on the dashboard. The setup UI path above already
    // validates before saving, so first-run typos are caught there instead.
    fail(
      `Could not log in with the saved shop login (${err.message}). If the shop password changed, ` +
        `run the agent with --setup to re-enter it, or delete ${agentConfig.configPath()}.`
    );
  }

  // Register autostart whenever the wizard actually ran this time (a
  // genuine first run, or a --setup reconfigure) - not on every plain
  // launch, since that would be a pointless registry write each time. The
  // reg command is idempotent either way, so re-registering on
  // reconfigure is harmless, just unnecessary to do on every normal start.
  if (settings.wizardRan) {
    await autostart.install(log);
  }

  while (!stopped) {
    try {
      await pollOnce();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Poll cycle failed:`, err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  log('Shutting down...');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
