// src/setupWizard.js
//
// First-run (and re-run via `--setup`) UI. Instead of a full GUI toolkit
// (Electron etc - heavy for a background agent that otherwise has zero UI
// needs), this spins up a tiny local HTTP server on the shop's own PC and
// opens it in their default browser. That's the entire UI surface this
// agent needs, and it means the packaged .exe stays a single small file
// with no extra runtime bundled in.
//
// Two things get collected here:
//   1. Shop login (email/password) - validated against the real backend
//      before anything is saved.
//   2. Print command - which program to run against each downloaded PDF.
//      Rather than making the shop owner hand-type/copy-paste a full
//      SumatraPDF.exe path into a text file (error-prone, and most shop
//      owners won't know that syntax), they browse to the .exe using a
//      folder picker rendered right in the page and click it.
//
// Why a server-rendered file browser instead of a plain <input
// type="file">: modern browsers deliberately do NOT expose the real
// filesystem path from a file input (Chrome/Edge/Firefox give you a
// filename only, sometimes a fake "C:\fakepath\..." string) - a security
// restriction with no workaround from page JS. Since this page is served
// by OUR OWN local Node process, not a random website, it can do something
// a random website isn't allowed to: list real directories server-side
// (see the /browse endpoint below) and hand back the actual absolute path
// when the shop owner clicks a file. It only ever browses the local
// filesystem of the machine it's already running on, over 127.0.0.1.
//
// Flow:
//   1. index.js finds no saved config (or was launched with --setup) ->
//      calls runSetupWizard()
//   2. this starts a server on 127.0.0.1 (a free port), opens it in the
//      default browser
//   3. shop owner enters their dashboard email/password, and either
//      browses to SumatraPDF.exe or pastes/edits a custom print command
//   4. server validates the login by actually calling POST
//      /api/shops/login against the real backend (same call the agent
//      itself makes) - a typo'd password is caught HERE, not three
//      retries into an unattended poll loop tomorrow
//   5. on success: page shows "Setup complete", server shuts itself down,
//      runSetupWizard() resolves with everything for index.js to save
//   6. on failure: page shows the real error and lets them try again
//      without restarting the agent

const http = require('http');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');

function openInBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {
    // Best-effort. If this fails (e.g. headless environment) the URL is
    // still logged to the console below so the shop owner can open it by
    // hand.
  });
}

// ---- server-side file browsing, for the "Browse..." picker ----

// Starting points shown when the picker first opens ("This PC"). On
// Windows this is drive letters (scanned by trying to access each one -
// no dependency on `wmic`, which is being phased out on newer Windows).
// On Mac/Linux (dev use only) it's just the home folder and root.
async function listRoots() {
  if (process.platform === 'win32') {
    const drives = [];
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      try {
        await fs.access(drive);
        drives.push(drive);
      } catch {
        // drive letter doesn't exist - fine, just skip it
      }
    }
    return drives.length ? drives : ['C:\\'];
  }
  return [os.homedir(), '/'];
}

// Lists one directory: subfolders (to navigate into) and .exe files (the
// thing we're actually looking for - filtered so the list isn't cluttered
// with every file type under the sun). Entries that error out on stat
// (permission-denied system folders etc) are silently skipped rather than
// failing the whole listing.
async function listDir(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('$')) continue; // Windows system junk, e.g. $Recycle.Bin
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    } else if (entry.isFile() && /\.exe$/i.test(entry.name)) {
      files.push(entry.name);
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));
  return { dirs, files };
}

async function handleBrowse(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const dir = url.searchParams.get('dir');
  try {
    if (!dir) {
      const roots = await listRoots();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dir: null, parent: null, dirs: roots, files: [] }));
      return;
    }
    const resolved = path.resolve(dir);
    const { dirs, files } = await listDir(resolved);
    const parentOf = path.dirname(resolved);
    const parent = parentOf === resolved ? null : parentOf;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        dir: resolved,
        parent,
        dirs: dirs.map((d) => path.join(resolved, d)),
        files: files.map((f) => path.join(resolved, f)),
      })
    );
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || 'Could not list that folder.' }));
  }
}

// ---- print command assembly ----
// Kept server-side (not duplicated in the page's JS) so there's exactly
// one place that knows the SumatraPDF flag syntax - see .env.example for
// the same template documented for the manual/.env path.
function buildSumatraCommand(exePath) {
  return `"${exePath}" -print-to-default -print-settings "{copies}x,{duplex},{color}" {file}`;
}

// ---- pages ----

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderPage({ error, values = {} } = {}) {
  const { email = '', printTool = 'sumatra', sumatraPath = '', customCommand = '' } = values;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>PrintNow Print Agent - Setup</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; background: #f4f5f7; margin: 0;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px 0; }
  .card { background: #fff; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,0.08);
          padding: 32px; width: 400px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .03em; color: #888;
       margin: 24px 0 10px; border-top: 1px solid #eee; padding-top: 18px; }
  p.sub { color: #666; font-size: 13px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 4px; }
  input[type=email], input[type=password], input[type=text], textarea {
    width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #d0d3d9;
    border-radius: 6px; font-size: 14px; font-family: inherit; }
  textarea { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; resize: vertical; min-height: 54px; }
  .radio-row { display: flex; gap: 16px; margin-top: 6px; }
  .radio-row label { display: flex; align-items: center; gap: 6px; font-weight: 500; margin: 0; }
  .radio-row input { width: auto; }
  .path-row { display: flex; gap: 8px; margin-top: 4px; }
  .path-row input { flex: 1; background: #f7f7f8; }
  .browse-btn { width: auto; margin-top: 0; padding: 9px 14px; white-space: nowrap; }
  button { border: none; border-radius: 6px; background: #2563eb; color: #fff; font-size: 14px;
           font-weight: 600; cursor: pointer; }
  button.secondary { background: #eee; color: #333; }
  #submitBtn { width: 100%; margin-top: 22px; padding: 10px; }
  #submitBtn:disabled { background: #9ab4f0; cursor: default; }
  .error { background: #fdecec; color: #b3261e; font-size: 13px; padding: 10px 12px;
           border-radius: 6px; margin-top: 16px; }
  .hint { color: #888; font-size: 12px; margin-top: 6px; line-height: 1.4; }
  .field-group.hidden { display: none; }
  /* file browser overlay */
  #browseOverlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.35);
    align-items: center; justify-content: center; z-index: 10; }
  #browseOverlay.open { display: flex; }
  #browsePanel { background: #fff; border-radius: 10px; width: 420px; max-height: 480px;
    display: flex; flex-direction: column; overflow: hidden; }
  #browseHeader { padding: 14px 16px; border-bottom: 1px solid #eee; display: flex;
    align-items: center; gap: 8px; }
  #browsePath { font-size: 12px; color: #666; flex: 1; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; font-family: ui-monospace, Consolas, monospace; }
  #browseList { overflow-y: auto; flex: 1; padding: 6px 0; }
  .browse-item { padding: 8px 16px; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 8px; }
  .browse-item:hover { background: #f2f4f8; }
  .browse-empty { padding: 16px; color: #999; font-size: 13px; text-align: center; }
  #browseFooter { padding: 10px 16px; border-top: 1px solid #eee; text-align: right; }
</style>
</head>
<body>
  <div class="card">
    <h1>PrintNow Print Agent</h1>
    <p class="sub">This is the same email/password you use to log into your shop dashboard.</p>
    <form id="f" method="POST" action="/submit">
      <label for="email">Shop email</label>
      <input id="email" name="email" type="email" required autofocus value="${esc(email)}" />
      <label for="password">Shop password</label>
      <input id="password" name="password" type="password" required />

      <h2>Printer</h2>
      <p class="sub" style="margin-bottom:8px;">Which program should the agent use to print a job's PDF?</p>
      <div class="radio-row">
        <label><input type="radio" name="printTool" value="sumatra" ${printTool === 'sumatra' ? 'checked' : ''} /> SumatraPDF (recommended)</label>
        <label><input type="radio" name="printTool" value="custom" ${printTool === 'custom' ? 'checked' : ''} /> Custom command</label>
        <label><input type="radio" name="printTool" value="skip" ${printTool === 'skip' ? 'checked' : ''} /> Skip for now</label>
      </div>

      <div id="sumatraGroup" class="field-group">
        <label for="sumatraPath">SumatraPDF.exe location</label>
        <div class="path-row">
          <input id="sumatraPath" name="sumatraPath" type="text" readonly placeholder="Click Browse to find it..." value="${esc(sumatraPath)}" />
          <button type="button" class="browse-btn" onclick="openBrowser()">Browse&hellip;</button>
        </div>
        <div class="hint">Don't have it yet? It's free at sumatrapdfreader.org - download and install it first, then come back and browse to it (usually under Program Files).</div>
      </div>

      <div id="customGroup" class="field-group hidden">
        <label for="customCommand">Print command</label>
        <textarea id="customCommand" name="customCommand" placeholder="e.g. lp -n {copies} -o sides=two-sided-long-edge -o ColorModel={color} {file}">${esc(customCommand)}</textarea>
        <div class="hint">Must include <code>{file}</code>. <code>{copies}</code>, <code>{duplex}</code>, <code>{color}</code> are optional - only include the ones your tool understands.</div>
      </div>

      <div id="skipGroup" class="field-group hidden">
        <div class="hint">You can set this later by editing <code>PRINT_COMMAND</code> in a <code>.env</code> file next to the agent, or by running the agent with <code>--setup</code> to come back to this screen. Nothing will print automatically until this is configured.</div>
      </div>

      <button id="submitBtn" type="submit">Save and start agent</button>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      <div class="hint" style="margin-top:16px;">Runs quietly in the background after this. You won't need to enter this again.</div>
    </form>
  </div>

  <div id="browseOverlay">
    <div id="browsePanel">
      <div id="browseHeader">
        <span id="browsePath">This PC</span>
        <button type="button" class="secondary" style="padding:6px 10px;font-size:12px;" onclick="browseUp()">Up</button>
      </div>
      <div id="browseList"></div>
      <div id="browseFooter">
        <button type="button" class="secondary" style="padding:8px 14px;" onclick="closeBrowser()">Cancel</button>
      </div>
    </div>
  </div>

<script>
  var groups = { sumatra: document.getElementById('sumatraGroup'),
                 custom: document.getElementById('customGroup'),
                 skip: document.getElementById('skipGroup') };
  function syncGroups() {
    var picked = document.querySelector('input[name=printTool]:checked').value;
    Object.keys(groups).forEach(function (k) {
      groups[k].classList.toggle('hidden', k !== picked);
    });
  }
  document.querySelectorAll('input[name=printTool]').forEach(function (r) {
    r.addEventListener('change', syncGroups);
  });
  syncGroups();

  var browseState = { parent: null };
  function openBrowser() {
    document.getElementById('browseOverlay').classList.add('open');
    loadDir(null);
  }
  function closeBrowser() {
    document.getElementById('browseOverlay').classList.remove('open');
  }
  function browseUp() {
    if (browseState.parent) loadDir(browseState.parent);
  }
  function loadDir(dir) {
    var url = '/browse' + (dir ? ('?dir=' + encodeURIComponent(dir)) : '');
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      if (data.error) {
        document.getElementById('browseList').innerHTML = '<div class="browse-empty">' + data.error + '</div>';
        return;
      }
      browseState.parent = data.parent;
      document.getElementById('browsePath').textContent = data.dir || 'This PC';
      var list = document.getElementById('browseList');
      list.innerHTML = '';
      var items = data.dirs.map(function (d) { return { name: d, type: 'dir' }; })
        .concat(data.files.map(function (f) { return { name: f, type: 'file' }; }));
      if (!items.length) {
        list.innerHTML = '<div class="browse-empty">Nothing here</div>';
        return;
      }
      items.forEach(function (item) {
        var row = document.createElement('div');
        row.className = 'browse-item';
        var label = item.name.split(/[\\\\/]/).pop() || item.name;
        row.innerHTML = (item.type === 'dir' ? '&#128193; ' : '&#128196; ') + label;
        row.onclick = function () {
          if (item.type === 'dir') loadDir(item.name);
          else selectFile(item.name);
        };
        list.appendChild(row);
      });
    });
  }
  function selectFile(fullPath) {
    document.getElementById('sumatraPath').value = fullPath;
    closeBrowser();
  }

  document.getElementById('f').addEventListener('submit', function () {
    var btn = document.getElementById('submitBtn');
    btn.disabled = true;
    btn.textContent = 'Checking...';
  });
</script>
</body>
</html>`;
}

function renderDonePage() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>PrintNow Print Agent - Setup</title>
<style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f4f5f7;margin:0;
display:flex;align-items:center;justify-content:center;min-height:100vh;}
.card{background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,0.08);padding:32px;
width:360px;text-align:center;}
h1{font-size:18px;margin:0 0 8px;}p{color:#555;font-size:13px;line-height:1.5;}</style></head>
<body><div class="card">
<h1>&#10003; Setup complete</h1>
<p>The print agent is now running in the background and will start automatically next time you
log in to Windows. You can close this window.</p>
</div></body></html>`;
}

function parseFormBody(body) {
  const params = new URLSearchParams(body);
  return {
    email: (params.get('email') || '').trim(),
    password: params.get('password') || '',
    printTool: params.get('printTool') || 'sumatra',
    sumatraPath: (params.get('sumatraPath') || '').trim(),
    customCommand: (params.get('customCommand') || '').trim(),
  };
}

// validateLogin is injected from index.js (it's the exact same login()
// call the agent uses for its normal polling), so "the setup wizard
// accepted your password" and "the agent can actually log in" can never
// drift apart into two different code paths.
//
// `existing` optionally prefills the form (used when re-running via
// `--setup` to adjust settings rather than starting from a blank page).
// The password field is never prefilled, even on reconfigure - re-entering
// it also re-validates that it's still correct.
function runSetupWizard({ validateLogin, log, existing = {} }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          renderPage({
            values: {
              email: existing.shopEmail || '',
              printTool: existing.printCommand ? 'custom' : 'sumatra',
              customCommand: existing.printCommand || '',
            },
          })
        );
        return;
      }

      if (req.method === 'GET' && req.url.startsWith('/browse')) {
        await handleBrowse(req, res);
        return;
      }

      if (req.method === 'POST' && req.url === '/submit') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          const { email, password, printTool, sumatraPath, customCommand } = parseFormBody(body);

          if (!email || !password) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(renderPage({ error: 'Both fields are required.', values: { email, printTool, sumatraPath, customCommand } }));
            return;
          }
          if (printTool === 'sumatra' && !sumatraPath) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
              renderPage({
                error: 'Click Browse and select your SumatraPDF.exe, or switch to Custom command / Skip.',
                values: { email, printTool, sumatraPath, customCommand },
              })
            );
            return;
          }
          if (printTool === 'custom' && !customCommand.includes('{file}')) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
              renderPage({
                error: 'Custom command must include {file} (the placeholder for the downloaded PDF).',
                values: { email, printTool, sumatraPath, customCommand },
              })
            );
            return;
          }

          try {
            await validateLogin(email, password);
          } catch (err) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
              renderPage({
                error: err.message || 'Login failed. Check your email/password.',
                values: { email, printTool, sumatraPath, customCommand },
              })
            );
            return;
          }

          const printCommand =
            printTool === 'sumatra' ? buildSumatraCommand(sumatraPath) : printTool === 'custom' ? customCommand : '';

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(renderDonePage());
          // Give the response a moment to actually flush to the browser
          // before tearing the server down underneath it.
          setTimeout(() => {
            server.close();
            resolve({ shopEmail: email, shopPassword: password, printCommand });
          }, 300);
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}/`;
      log(`Setup - opening ${url} in your browser...`);
      log(`(If it doesn't open automatically, copy that link into a browser by hand.)`);
      openInBrowser(url);
    });
  });
}

module.exports = { runSetupWizard };
