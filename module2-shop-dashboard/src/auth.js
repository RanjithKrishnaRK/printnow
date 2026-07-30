// Tiny session helper. Shop owners stay logged in on their counter machine
// across refreshes/browser restarts, so we persist to localStorage - this is
// a real deployed app (not a Claude artifact), so localStorage is fine here.

const STORAGE_KEY = "shopSession";

export function saveSession(shopId, token) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ shopId, token }));
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.shopId || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}
