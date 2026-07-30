// src/buzzer.js
//
// Software buzzer (item 5, scoped down from the full auto-print + hardware
// buzzer idea): an in-browser alert so a shop owner notices a new job
// without staring at the tab. Two parts:
//   1. A short two-tone chime, synthesized with the Web Audio API - no
//      audio file to ship or fetch, so it works offline out of the box.
//   2. The document title flashes between the alert text and its normal
//      value until the tab regains focus, so it's noticeable even if the
//      dashboard is a background tab.
//
// Mute preference is stored in localStorage - this is a real browser app
// running on the shop owner's own machine (not a sandboxed artifact), so
// that's the normal, correct place for a small durable UI preference.

const MUTE_KEY = "printnow.buzzerMuted";
const ORIGINAL_TITLE = document.title;
const ALERT_TITLE = "🔔 New job! — PrintNow";
const FLASH_INTERVAL_MS = 1000;

let audioCtx = null;
let flashTimer = null;

export function isMuted() {
  return localStorage.getItem(MUTE_KEY) === "true";
}

export function setMuted(muted) {
  localStorage.setItem(MUTE_KEY, muted ? "true" : "false");
}

// AudioContext must be created/resumed after a user gesture in most
// browsers (autoplay policy) - call this once from a click handler (e.g.
// the login button) so it's ready by the time a buzzer needs to fire from
// a background poll, which has no gesture of its own.
export function primeAudio() {
  if (audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return; // very old/unsupported browser - buzzer just stays silent
  audioCtx = new Ctx();
}

function playTone(freq, startTime, duration) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // Quick fade in/out so each tone is a clean "ding" rather than a click.
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.25, startTime + 0.02);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playChime() {
  if (!audioCtx) return;
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  // Two-note rising chime (like a doorbell), ~500ms total.
  playTone(880, now, 0.22);
  playTone(1108.73, now + 0.18, 0.28);
}

function startTitleFlash() {
  if (flashTimer) return; // already flashing
  let showingAlert = false;
  flashTimer = setInterval(() => {
    document.title = showingAlert ? ORIGINAL_TITLE : ALERT_TITLE;
    showingAlert = !showingAlert;
  }, FLASH_INTERVAL_MS);
}

export function stopTitleFlash() {
  if (flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
  document.title = ORIGINAL_TITLE;
}

// Call when a new job is detected. Respects mute, but the title still
// flashes even if muted (silent visual alert), since mute is specifically
// about sound.
export function triggerBuzzer() {
  if (!isMuted()) playChime();
  startTitleFlash();
}

// Wire this up once, e.g. in App.jsx - stops the flash as soon as the shop
// owner actually looks at the tab again.
export function stopFlashOnFocus() {
  const stop = () => stopTitleFlash();
  window.addEventListener("focus", stop);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") stop();
  });
}
