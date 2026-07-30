// src/config.js
//
// Persisted agent config (shop email/password + advanced overrides), stored
// OUTSIDE the install folder so it survives the exe being replaced/updated.
// This is what the first-run setup UI (setupWizard.js) writes to, and what
// every later launch reads from instead of asking again.
//
// Storage location:
//   Windows: %APPDATA%\PrintNowAgent\config.json
//   Mac/Linux (dev use only - the packaged build targets Windows): 
//     ~/.printnow-agent/config.json
//
// Known limitation, flagged honestly: the shop password is stored in plain
// JSON on disk, same as it was in .env before this change. This file lives
// under the current Windows user's own profile (not world-readable on a
// normal multi-user Windows setup), and file permissions are tightened to
// owner-only where the OS supports it (see writeConfig). That is
// obfuscation-by-file-permissions, not encryption - anyone with access to
// that Windows login already has access to the dashboard via the browser
// anyway, so this doesn't meaningfully change the trust boundary, but it's
// worth knowing this isn't encrypted at rest.

const fs = require('fs/promises');
const path = require('path');
const os = require('os');

function configDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'PrintNowAgent');
  }
  // Dev/testing on Mac/Linux - the shipped .exe only targets Windows.
  return path.join(os.homedir(), '.printnow-agent');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

async function readConfig() {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Could not read saved config at ${configPath()}: ${err.message}`);
  }
}

async function writeConfig(config) {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true });
  const file = configPath();
  await fs.writeFile(file, JSON.stringify(config, null, 2), 'utf8');
  // Owner-only permissions where the OS honors chmod (no-op-ish on Windows,
  // but harmless there and does the right thing if this ever runs on Mac/
  // Linux during dev).
  await fs.chmod(file, 0o600).catch(() => {});
  return file;
}

async function clearConfig() {
  await fs.rm(configPath(), { force: true });
}

module.exports = { configDir, configPath, readConfig, writeConfig, clearConfig };
