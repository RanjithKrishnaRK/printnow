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
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Login failed. Check your email and password.");
  }
  return res.json(); // { shopId, token, mustChangePassword? }
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
  return res.json(); // { shopId, token, shopName }
}

async function realChangePassword(shopId, token, currentPassword, newPassword) {
  const res = await fetch(`${BASE_URL}/api/shops/${shopId}/change-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Could not change your password. Please try again.");
  }
  return res.json(); // { ok: true }
}

async function realGetVendorStatus(shopId, token) {
  const res = await fetch(`${BASE_URL}/api/shops/${shopId}/vendor-status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Could not load your payout settings.");
  return res.json(); // { vendorStatus, bankAccountLast4, bankIfsc, bankAccountHolder, pan }
}

async function realSubmitVendorDetails(shopId, token, details) {
  const res = await fetch(`${BASE_URL}/api/shops/${shopId}/vendor`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(details),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Could not save your bank details. Please try again.");
  }
  return res.json(); // { vendorStatus }
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
  return res.json(); // { name, autoPrintEnabled, priceBw, priceColor, maxPagesPerHour, upiId }
}

async function realGetEarnings(shopId, token) {
  const res = await fetch(`${BASE_URL}/api/shops/${shopId}/earnings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Could not load earnings.");
  return res.json(); // { totalEarnings, totalJobs, todayEarnings, todayJobs, jobsByStatus, totalByMethod: {cash, online}, todayByMethod, settledTotal, unsettledOnline }
}

async function realGetEarningsHistory(shopId, token, groupBy) {
  const res = await fetch(`${BASE_URL}/api/shops/${shopId}/earnings/history?groupBy=${groupBy}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Could not load earnings history.");
  return res.json(); // { groupBy, history: [{ period, cash, online, total, jobs }] }
}

async function realGetSettlements(shopId, token) {
  const res = await fetch(`${BASE_URL}/api/shops/${shopId}/settlements`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Could not load settlement history.");
  return res.json(); // [{ id, amount, settledDate, mode, note, createdAt }]
}

async function realGetCommissionPayments(shopId, token) {
  const res = await fetch(`${BASE_URL}/api/shops/${shopId}/commission-payments`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Could not load commission payment history.");
  return res.json(); // [{ id, amount, paidDate, mode, note, createdAt }]
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
let mockSettings = {
  name: "Campus Xerox",
  autoPrintEnabled: false,
  priceBw: 2,
  priceColor: 10,
  maxPagesPerHour: null,
  upiId: null,
  razorpayKeyId: null,
  razorpaySecretConfigured: false,
};

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
  const normalizedEmail = email.trim().toLowerCase();
  const exists =
    normalizedEmail === MOCK_SHOP.email ||
    mockSignedUpShops.some((s) => s.email.toLowerCase() === normalizedEmail);
  if (exists) throw new Error("A shop with this email already exists");
  const shopId = `mock_shop_${Date.now()}`;
  const token = `mock-token-${Date.now()}`;
  mockSignedUpShops.push({ name, email: normalizedEmail, password, shopId, token });
  return { shopId, token, shopName: name };
}

async function mockChangePassword(shopId, token, currentPassword, newPassword) {
  await wait(MOCK_LATENCY_MS);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  if (shopId === MOCK_SHOP.shopId) {
    if (currentPassword !== MOCK_SHOP.password) throw new Error("Current password is incorrect");
    MOCK_SHOP.password = newPassword; // demo-only mutation, resets on page reload
    return { ok: true };
  }
  const shop = mockSignedUpShops.find((s) => s.shopId === shopId);
  if (!shop) throw new Error("Shop not found");
  if (currentPassword !== shop.password) throw new Error("Current password is incorrect");
  shop.password = newPassword;
  return { ok: true };
}

let mockVendor = { vendorStatus: null, bankAccountLast4: null, bankIfsc: null, bankAccountHolder: null, pan: null };

async function mockGetVendorStatus(shopId, token) {
  await wait(150);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  return { ...mockVendor };
}

async function mockSubmitVendorDetails(shopId, token, details) {
  await wait(400);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  // Mimics the backend's own validation so the mock demo behaves the same
  // way as a real submission would.
  if (!/^\d{9,18}$/.test(String(details.bankAccountNumber || ""))) {
    throw new Error("bankAccountNumber must be 9-18 digits");
  }
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(details.bankIfsc || "").toUpperCase())) {
    throw new Error("bankIfsc must be a valid IFSC code (e.g. HDFC0001234)");
  }
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(details.pan || "").toUpperCase())) {
    throw new Error("pan must be a valid PAN (e.g. ABCDE1234F)");
  }
  mockVendor = {
    vendorStatus: "ACTIVE", // instant in mock mode, since there's no real bank to verify against
    bankAccountLast4: String(details.bankAccountNumber).slice(-4),
    bankIfsc: String(details.bankIfsc).toUpperCase(),
    bankAccountHolder: details.bankAccountHolder,
    pan: String(details.pan).toUpperCase(),
  };
  return { vendorStatus: mockVendor.vendorStatus };
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
  const paidJobs = shopJobs.filter((j) => j.status !== "uploaded" && j.status !== "payment_pending");
  const today = new Date().toDateString();
  const todayJobs = paidJobs.filter((j) => new Date(j.createdAt).toDateString() === today);
  const jobsByStatus = {};
  for (const j of shopJobs) {
    jobsByStatus[j.status] = (jobsByStatus[j.status] || 0) + 1;
  }
  function toMethodTotals(jobList) {
    const totals = { cash: 0, online: 0 };
    for (const j of jobList) {
      if (j.paymentMethod === "cash") totals.cash += j.amountDue || 0;
      else if (j.paymentMethod === "razorpay" || j.paymentMethod === "upi") totals.online += j.amountDue || 0;
    }
    return totals;
  }
  const totalByMethod = toMethodTotals(paidJobs);
  const settledTotal = mockSettlements.reduce((sum, s) => sum + s.amount, 0);
  const commissionPaid = mockCommissionPayments.reduce((sum, p) => sum + p.amount, 0);
  // Mock mode has no real shop-owned Razorpay account routing (see
  // routes/jobs.js), so there's nothing accrued to owe yet - the demo
  // just shows the shape of the numbers, always at 0.
  const commissionAccrued = 0;
  return {
    totalEarnings: paidJobs.reduce((sum, j) => sum + (j.amountDue || 0), 0),
    totalJobs: paidJobs.length,
    todayEarnings: todayJobs.reduce((sum, j) => sum + (j.amountDue || 0), 0),
    todayJobs: todayJobs.length,
    jobsByStatus: Object.entries(jobsByStatus).map(([status, count]) => ({ status, count })),
    totalByMethod,
    todayByMethod: toMethodTotals(todayJobs),
    settledTotal,
    unsettledOnline: Math.max(0, totalByMethod.online - settledTotal),
    commissionAccrued,
    commissionPaid,
    commissionOwed: Math.max(0, commissionAccrued - commissionPaid),
  };
}

async function mockGetEarningsHistory(token, groupBy) {
  await wait(200);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  const shopJobs = token === MOCK_SHOP.token ? mockJobs : [];
  const paidJobs = shopJobs.filter((j) => j.status !== "uploaded" && j.status !== "payment_pending");
  const buckets = new Map();
  for (const j of paidJobs) {
    const d = new Date(j.createdAt);
    let key;
    if (groupBy === "year") key = `${d.getFullYear()}`;
    else if (groupBy === "month") key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    else key = d.toISOString().slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, { period: key, cash: 0, online: 0, jobs: 0 });
    const b = buckets.get(key);
    b.jobs += 1;
    if (j.paymentMethod === "cash") b.cash += j.amountDue || 0;
    else if (j.paymentMethod === "razorpay" || j.paymentMethod === "upi") b.online += j.amountDue || 0;
  }
  const history = Array.from(buckets.values())
    .sort((a, b) => (a.period < b.period ? 1 : -1))
    .map((row) => ({ ...row, total: row.cash + row.online }));
  return { groupBy, history };
}

let mockSettlements = [];

async function mockGetSettlements(token) {
  await wait(150);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  return [...mockSettlements].sort((a, b) => (a.settledDate < b.settledDate ? 1 : -1));
}

async function mockUpdateSettings(token, patch) {
  await wait(150);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  const { autoPrintEnabled, priceBw, priceColor, maxPagesPerHour, upiId, razorpayKeyId, razorpaySecret } =
    patch || {};

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
  if (razorpayKeyId !== undefined) {
    if (razorpayKeyId === null) {
      mockSettings.razorpayKeyId = null;
      mockSettings.razorpaySecretConfigured = false;
    } else {
      if (typeof razorpayKeyId !== "string" || razorpayKeyId.trim().length < 8) {
        throw new Error("razorpayKeyId does not look like a valid Razorpay key ID");
      }
      if (typeof razorpaySecret !== "string" || razorpaySecret.trim().length < 8) {
        throw new Error("razorpaySecret is required (and must be valid) whenever razorpayKeyId is set");
      }
      mockSettings.razorpayKeyId = razorpayKeyId.trim();
      mockSettings.razorpaySecretConfigured = true;
    }
  }
  return { ...mockSettings };
}

let mockCommissionPayments = [];

async function mockGetCommissionPayments(token) {
  await wait(150);
  if (!isValidMockToken(token)) throw new Error("Session expired. Please log in again.");
  return [...mockCommissionPayments].sort((a, b) => (a.paidDate < b.paidDate ? 1 : -1));
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

export function changePassword(shopId, token, currentPassword, newPassword) {
  return USE_MOCK
    ? mockChangePassword(shopId, token, currentPassword, newPassword)
    : realChangePassword(shopId, token, currentPassword, newPassword);
}

export function getVendorStatus(shopId, token) {
  return USE_MOCK ? mockGetVendorStatus(shopId, token) : realGetVendorStatus(shopId, token);
}

export function submitVendorDetails(shopId, token, details) {
  return USE_MOCK
    ? mockSubmitVendorDetails(shopId, token, details)
    : realSubmitVendorDetails(shopId, token, details);
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

export function getEarningsHistory(shopId, token, groupBy) {
  return USE_MOCK ? mockGetEarningsHistory(token, groupBy) : realGetEarningsHistory(shopId, token, groupBy);
}

export function getSettlements(shopId, token) {
  return USE_MOCK ? mockGetSettlements(token) : realGetSettlements(shopId, token);
}

export function getCommissionPayments(shopId, token) {
  return USE_MOCK ? mockGetCommissionPayments(token) : realGetCommissionPayments(shopId, token);
}

export function updateSettings(shopId, token, patch) {
  return USE_MOCK ? mockUpdateSettings(token, patch) : realUpdateSettings(shopId, token, patch);
}

export function setAutoPrint(shopId, token, enabled) {
  return updateSettings(shopId, token, { autoPrintEnabled: enabled });
}
