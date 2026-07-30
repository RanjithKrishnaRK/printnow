// Tiny session helper, same pattern as Module 2's auth.js.
const STORAGE_KEY = "adminSession";

export function saveSession(token, email) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, email }));
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}
