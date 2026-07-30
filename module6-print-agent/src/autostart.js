// src/autostart.js
//
// Registers this agent to launch automatically when the shop owner logs
// into Windows, so "run it once after install, then forget about it" is
// actually true - no need to keep a terminal window open or remember to
// start it by hand each morning.
//
// Approach: HKCU Run key (not HKLM, not a Scheduled Task, not a Windows
// Service). Reasoning:
//   - HKCU (current user) needs no admin/UAC prompt - HKLM or a real
//     service would. The install story here is "shop owner double-clicks
//     the exe", so anything requiring elevation is a worse first-run
//     experience for the audience this targets.
//   - It's also the same reason this can be installed/removed by the exe
//     itself at runtime with a plain `reg` command, no separate installer
//     needed.
// Trade-off: it only starts once that specific Windows user logs in (fine
// for a single shop-owner PC, which is the assumed setup), and a curious
// user could remove it from Task Manager's Startup tab - acceptable for
// this use case, not trying to be tamper-proof.
//
// This is intentionally Windows-only, matching the rest of this module's
// "confirmed working on Windows" scope (see README's Known limitations).
// On other platforms, install() is a no-op that just logs what to do
// manually instead.

const { exec } = require('child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'PrintNowAgent';

// When packaged with pkg, process.pkg is set and process.execPath IS the
// exe itself - that's the path we want in the registry. Running un-packaged
// under plain `node` during development, process.execPath is node.exe,
// which isn't something we want to silently register to run at every
// login - so autostart is skipped in that case (see index.js).
function exePath() {
  return process.execPath;
}

function install(log) {
  if (process.platform !== 'win32') {
    log('Autostart: skipped (not Windows) - start the agent manually on this platform.');
    return Promise.resolve(false);
  }
  if (!process.pkg) {
    log('Autostart: skipped (running from source with plain Node, not the packaged .exe).');
    return Promise.resolve(false);
  }
  const target = exePath();
  const cmd = `reg add "${RUN_KEY}" /v ${VALUE_NAME} /t REG_SZ /d "\\"${target}\\"" /f`;
  return new Promise((resolve) => {
    exec(cmd, (err) => {
      if (err) {
        log(`Autostart: could not register (${err.message}). You can start the agent manually instead.`);
        resolve(false);
      } else {
        log('Autostart: registered - the agent will now launch automatically when you log into Windows.');
        resolve(true);
      }
    });
  });
}

function remove(log) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const cmd = `reg delete "${RUN_KEY}" /v ${VALUE_NAME} /f`;
  return new Promise((resolve) => {
    exec(cmd, (err) => {
      if (err) {
        log(`Autostart: could not remove registry entry (${err.message}).`);
        resolve(false);
      } else {
        log('Autostart: removed.');
        resolve(true);
      }
    });
  });
}

module.exports = { install, remove };
