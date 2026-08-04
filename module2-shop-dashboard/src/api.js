// ---------------------------------------------------------------------------
// API layer for Module 2 (Shop Owner Dashboard)
//
// This file is the ONLY place that talks to the backend.
//
// Mode is controlled by VITE_USE_MOCK in .env (same pattern as Module 1).
// Module 3's real Postgres backend is now built and tested, so this
// defaults to REAL mode. Set VITE_USE_MOCK=true in .env to fall back to the
// in-memory mock (e.g. demoing with zero backend running).
// No other file in this app needs to change - Login.jsx and Dashboard.jsx
// only ever call the exported functions below, never fetch() directly.
// ---------------------------------------------------------------------------

const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

// The five valid non-terminal job statuses in the locked state machine, plus
// "cancelled" as a terminal state reachable from any state before "printing".
// Module 2 only ever needs to render/act on: queued, printing, ready,
// collected. ("uploaded" and "paid" are Module 1 / Module 3 concerns - by
// the time a job is visible to the shop, it's already "queued".)
export const JOB_STATUSES = [
  "uploaded",
  "paid",
  "payment_pending",
  "queued",
  "printing",
  "ready",
  "collected",
  "cancelled",
];

// -----------------------------
// Real network calls (used when USE_MOCK = false)
// -----------------------------

async function realLogin(email, password) {
  const res = await fetch(`${BASE_URL}/api/shops/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("Login failed. Check your email and password.");
  return res.json(); // { shopId, token }
}

async function realSignup(name, email, password, landmarkId) {
  const res = await fetch(`${BASE_URL}/api/shops/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password, landmarkId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Signup failed. Please try again.");
  }
  return res.json(); // { shopId, token }
}

async function realGetLandmarks() {
  const res = await fetch(`${BASE_URL}/api/landmarks`);
  if (!res.ok) throw new Error("Could not load landmarks.");
  return res.json(); // [{ id, name }]
}

// The backend returns fileUrl as a host-relative path (e.g. "/uploads/xxx.pdf")
// so it stays storage-agnostic (see uploads.js). That's correct for the
// backend, but the shop dashboard runs on its own origin/port in dev (and
// in prod too, if ever split across a subdomain) - a bare "/uploads/..."
// href resolves against THIS app's origin, not the backend's, so "View
// file" 404s. Bug: files never "reflected" for the shop owner because the
// link just pointed at the wrong server. Normalize to an absolute URL here,
// once, so every caller of getJobs() gets a link that actually works.
function absoluteFileUrl(fileUrl) {
  if (!fileUrl) return fileUrl;
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl; // already absolute (e.g. mock data)
  return `${BASE_URL}${fileUrl.startsWith("/") ? "" : "/"}${fileUrl}`;
}

async function realGetJobs(shopId, token, status) {
  const url = new URL(`${BASE_URL}/api/shops/${shopId}/jobs`);
  if (status) url.searchParams.set("status", status);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Could not load jobs.");
  const jobs = await res.json();
  return jobs.map((j) => ({
    ...j,
    fileUrl: absoluteFileUrl(j.fileUrl),
    paymentScreenshotUrl: absoluteFileUrl(j.paymentScreenshotUrl),
  }));
}

async function realUpdateJobStatus(jobId, token, status) {
  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error("Could not update job status.");
  return res.json(); // { jobId, status }
}

// kind: "job" | "batch" - a batch's confirm/reject advances every document
// in it together (see routes/batches.js), a job's advances just itself.
async function realConfirmPayment(kind, id, token) {
  const path = kind === "batch" ? `/api/batches/${id}/confirm-payment` : `/api/jobs/${id}/confirm-payment`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Could not confirm payment.");
  }
  return res.json(); // { jobId/batchId, status: "queued", tokenNumber }
}

async function realRejectPayment(kind, id, token, reason) {
  const path = kind === "batch" ? `/api/batches/${id}/reject-payment` : `/api/jobs/${id}/reject-payment`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Could not reject payment.");
  }
  return res.json(); // { jobId/batchId, status: "uploaded" }
}

async function realGetSettings(shopId, token) {
  const res = await fetch(`${BASE_URL}/api/shops/${shopId}/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Could not load settings.");
  return res.json(); // { autoPrintEnabled, priceBw, priceColor, maxPagesPerHour }
}

async function realGetEarnings(shopId, token) {
  const res = await fetch(`${BASE_URL}/api/shops/${shopId}/earnings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Could not load earnings.");
  return res.json(); // { totalEarnings, totalJobs, todayEarnings, todayJobs, jobsByStatus }
}

async function realUpdateSettings(shopId, token, patch) {
  const res = await fetch(`${BASE_URL}/api/shops/${shopId}/settings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Could not update settings.");
  }
  return res.json(); // { autoPrintEnabled, priceBw, priceColor, maxPagesPerHour }
}

// -----------------------------
// Mock backend (used when USE_MOCK = true)
// -----------------------------
// Simulates network latency and keeps an in-memory job list so the whole
// login -> queue -> printing -> ready -> collected flow can be clicked
// through end to end without a real server running.

const MOCK_LATENCY_MS = 350;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const MOCK_SHOP = {
  email: "owner@campusxerox.in",
  password: "printshop123",
  shopId: "shop_001",
  token: "mock-token-abc123",
};

let mockJobs = [
  {
    jobId: "job_1000",
    tokenNumber: null,
    pages: 8,
    copies: 1,
    colorMode: "bw",
    fileUrl: "https://example.com/files/job_1000.pdf",
    status: "payment_pending",
    paymentMethod: "upi",
    paymentScreenshotUrl: "https://placehold.co/300x600?text=UPI+Paid+%E2%82%B916",
    paymentRejectionReason: null,
    amountDue: 16,
    createdAt: new Date(Date.now() - 1000 * 60 * 3).toISOString(),
  },
  {
    jobId: "job_1001",
    tokenNumber: "A101",
    pages: 24,
    copies: 1,
    colorMode: "bw",
    fileUrl: "https://example.com/files/job_1001.pdf",
    status: "queued",
    amountDue: 48,
    createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
  },
  {
    jobId: "job_1002",
    tokenNumber: "A102",
    pages: 6,
    copies: 2,
    colorMode: "color",
    fileUrl: "https://example.com/files/job_1002.pdf",
    status: "queued",
    amountDue: 120,
    createdAt: new Date(Date.now() - 1000 * 60 * 9).toISOString(),
  },
  {
    jobId: "job_1003",
    tokenNumber: "A103",
    pages: 112,
    copies: 1,
    colorMode: "bw",
    fileUrl: "https://example.com/files/job_1003.pdf",
    status: "printing",
    amountDue: 224,
    createdAt: new Date(Date.now() - 1000 * 60 * 22).toISOString(),
  },
  {
    jobId: "job_1004",
    tokenNumber: "A104",
    pages: 2,
    copies: 5,
    colorMode: "color",
    fileUrl: "https://example.com/files/job_1004.pdf",
    status: "ready",
    amountDue: 100,
    createdAt: new Date(Date.now() - 1000 * 60 * 34).toISOString(),
  },
  {
    jobId: "job_1005",
    tokenNumber: "A099",
    pages: 40,
    copies: 1,
    colorMode: "bw",
    fileUrl: "https://example.com/files/job_1005.pdf",
    status: "collected",
    amountDue: 80,
    createdAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
  },
];

const MOCK_LANDMARKS = [{ id: "lm_anurag_university", name: "Anurag University" }];
const mockSignedUpShops = []; // { name, email, password, shopId, token }
// Mirrors the shape returned by GET/PATCH /api/shops/:shopId/settings.
// priceBw/priceColor default to the same starter rates the real backend
// backfills new shops with; maxPagesPerHour null = no cap (default).
let mockSettings = { autoPrintEnabled: false, priceBw: 2, priceColor: 10, maxPagesPerHour: null, upiId: null };

async function mockLogin(email, password) {
  await wait(MOCK_LATENCY_MS);
  if (email.trim().toLowerCase() === MOCK_SHOP.email && password === MOCK_SHOP.password) {
    return { shopId: MOCK_SHOP.shopId, token: MOCK_SHOP.token };
  }
  const match = mockSignedUpShops.find(
    (s) => s.email.toLowerCase() === email.trim().toLowerCase() && s.password === password
  );
  if (match) return { shopId: match.shopId, token: match.token };
  throw new Error("Invalid email or password.");
}

async function mockSignup(name, email, password, landmarkId) {
  await wait(MOCK_LATENCY_MS);
  if (!landmarkId) throw new Error("landmarkId is required");
  const exists =
    email.trim().toLowerCase() === MOCK_SHOP.email ||
    mockSignedUpShops.some((s) => s.email.toLowerCase() === email.trim().toLowerCase());
  if (exists) throw new Error("A shop with this email already exists");
  const shopId = `mock_shop_${Date.now()}`;
  const token = `mock-token-${Date.now()}`;
  mockSignedUpShops.push({ name, email, password, shopId, token });
  return { shopId, token };
}

async function mockGetLandmarks() {
  await wait(200);
  return MOCK_LANDMARKS;
}

// Bug fix: this used to compare only against MOCK_SHOP.token, so ANY
// freshly mock-signed-up shop (which gets its own generated token) would
// immediately see "Session expired" the moment the dashboard loaded jobs
// after signup. Now checks against the full set of valid mock tokens.
function isValidMockToken(token) {
  return token === MOCK_SHOP.token || mockSignedUpShops.some((s) => s.token === token);
}

async function mockGetJobs(shopId, token, status) {
  await wait(MOCK_LATENCY_MS);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  // Newly signed-up mock shops have no jobs yet - only the seeded demo shop
  // (MOCK_SHOP) has the sample job list below.
  const shopJobs = token === MOCK_SHOP.token ? mockJobs : [];
  const jobs = status ? shopJobs.filter((j) => j.status === status) : shopJobs;
  // Return a copy sorted oldest-first (first come, first printed)
  return [...jobs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

async function mockUpdateJobStatus(jobId, token, status) {
  await wait(MOCK_LATENCY_MS);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  const job = mockJobs.find((j) => j.jobId === jobId);
  if (!job) throw new Error("Job not found.");
  job.status = status;
  return { jobId: job.jobId, status: job.status };
}

// Mock has no separate batches list - kind is accepted for signature parity
// with the real API but always operates on mockJobs by id.
async function mockConfirmPayment(kind, id, token) {
  await wait(MOCK_LATENCY_MS);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  const job = mockJobs.find((j) => j.jobId === id);
  if (!job) throw new Error("Job not found.");
  if (job.status !== "payment_pending") throw new Error(`Cannot confirm payment for a job in status "${job.status}"`);
  job.status = "queued";
  job.tokenNumber = job.tokenNumber || `A${100 + Math.floor(Math.random() * 900)}`;
  return { jobId: job.jobId, status: "queued", tokenNumber: job.tokenNumber };
}

async function mockRejectPayment(kind, id, token, reason) {
  await wait(MOCK_LATENCY_MS);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  const job = mockJobs.find((j) => j.jobId === id);
  if (!job) throw new Error("Job not found.");
  if (job.status !== "payment_pending") throw new Error(`Cannot reject payment for a job in status "${job.status}"`);
  job.status = "uploaded";
  job.paymentMethod = null;
  job.paymentScreenshotUrl = null;
  job.paymentRejectionReason = reason || "Payment could not be verified";
  return { jobId: job.jobId, status: "uploaded" };
}

async function mockGetSettings(token) {
  await wait(150);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  return { ...mockSettings };
}

// Only the seeded demo shop (MOCK_SHOP) has sample jobs/earnings - a
// freshly mock-signed-up shop legitimately has ₹0 and 0 jobs so far.
async function mockGetEarnings(token) {
  await wait(200);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  const shopJobs = token === MOCK_SHOP.token ? mockJobs : [];
  const paidJobs = shopJobs.filter((j) => j.status !== "uploaded");
  const today = new Date().toDateString();
  const todayJobs = paidJobs.filter((j) => new Date(j.createdAt).toDateString() === today);
  const jobsByStatus = {};
  for (const j of shopJobs) {
    jobsByStatus[j.status] = (jobsByStatus[j.status] || 0) + 1;
  }
  return {
    totalEarnings: paidJobs.reduce((sum, j) => sum + (j.amountDue || 0), 0),
    totalJobs: paidJobs.length,
    todayEarnings: todayJobs.reduce((sum, j) => sum + (j.amountDue || 0), 0),
    todayJobs: todayJobs.length,
    jobsByStatus: Object.entries(jobsByStatus).map(([status, count]) => ({ status, count })),
  };
}

async function mockUpdateSettings(token, patch) {
  await wait(150);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  const { autoPrintEnabled, priceBw, priceColor, maxPagesPerHour, upiId } = patch || {};

  if (autoPrintEnabled !== undefined) {
    if (typeof autoPrintEnabled !== "boolean") throw new Error("autoPrintEnabled must be true or false");
    mockSettings.autoPrintEnabled = autoPrintEnabled;
  }
  if (priceBw !== undefined) {
    if (!Number.isInteger(priceBw) || priceBw < 1) throw new Error("priceBw must be a positive integer");
    mockSettings.priceBw = priceBw;
  }
  if (priceColor !== undefined) {
    if (!Number.isInteger(priceColor) || priceColor < 1)
      throw new Error("priceColor must be a positive integer");
    mockSettings.priceColor = priceColor;
  }
  if (maxPagesPerHour !== undefined) {
    if (maxPagesPerHour !== null && (!Number.isInteger(maxPagesPerHour) || maxPagesPerHour < 1)) {
      throw new Error("maxPagesPerHour must be a positive integer, or null for no limit");
    }
    mockSettings.maxPagesPerHour = maxPagesPerHour;
  }
  if (upiId !== undefined) {
    mockSettings.upiId = upiId;
  }
  return { ...mockSettings };
}

// -----------------------------
// Exported functions - these are what components call
// -----------------------------

export function login(email, password) {
  return USE_MOCK ? mockLogin(email, password) : realLogin(email, password);
}

export function signup(name, email, password, landmarkId) {
  return USE_MOCK
    ? mockSignup(name, email, password, landmarkId)
    : realSignup(name, email, password, landmarkId);
}

export function getLandmarks() {
  return USE_MOCK ? mockGetLandmarks() : realGetLandmarks();
}

export function getJobs(shopId, token, status) {
  return USE_MOCK ? mockGetJobs(shopId, token, status) : realGetJobs(shopId, token, status);
}

export function updateJobStatus(jobId, token, status) {
  return USE_MOCK
    ? mockUpdateJobStatus(jobId, token, status)
    : realUpdateJobStatus(jobId, token, status);
}

// kind: "job" | "batch"
export function confirmPayment(kind, id, token) {
  return USE_MOCK ? mockConfirmPayment(kind, id, token) : realConfirmPayment(kind, id, token);
}

export function rejectPayment(kind, id, token, reason) {
  return USE_MOCK ? mockRejectPayment(kind, id, token, reason) : realRejectPayment(kind, id, token, reason);
}

export function getSettings(shopId, token) {
  return USE_MOCK ? mockGetSettings(token) : realGetSettings(shopId, token);
}

export function getEarnings(shopId, token) {
  return USE_MOCK ? mockGetEarnings(token) : realGetEarnings(shopId, token);
}

export function updateSettings(shopId, token, patch) {
  return USE_MOCK ? mockUpdateSettings(token, patch) : realUpdateSettings(shopId, token, patch);
}

export function setAutoPrint(shopId, token, enabled) {
  return updateSettings(shopId, token, { autoPrintEnabled: enabled });
}
