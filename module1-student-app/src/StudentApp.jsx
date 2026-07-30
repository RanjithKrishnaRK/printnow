import React, { useState, useEffect, useCallback, useRef } from "react";
import { Html5Qrcode } from "html5-qrcode";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocument } from "pdf-lib";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// Reads a PDF's actual page count client-side (no server round trip) so the
// "Pages" field can default to - and be capped at - the real number instead
// of trusting whatever the student happens to type. If the file turns out
// not to be a well-formed PDF (or parsing fails for any other reason),
// resolves to null rather than throwing - the caller falls back to manual
// entry with no cap, so a slightly unusual PDF never blocks someone from
// ordering a print.
async function countPdfPages(file) {
  try {
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    return pdf.numPages;
  } catch (err) {
    return null;
  }
}

// Wraps a photo (JPEG/PNG) in a single-page PDF sized to the image itself,
// entirely in the browser. This is the ONLY place that needs to know about
// non-PDF uploads - once this runs, the resulting File is a completely
// normal PDF, so the backend, the print agent, and countPdfPages above all
// keep working exactly as they already do, with zero changes anywhere else
// in the pipeline. Deliberately scoped to JPEG/PNG only: those are what
// pdf-lib can embed directly. Some phone cameras (iPhone default) save as
// HEIC instead of JPEG - HEIC isn't supported here, so a student on iOS
// may need to pick "Most Compatible" format in their camera settings, or
// take a screenshot of the photo instead (screenshots are always PNG).
async function imageFileToPdfFile(file) {
  const bytes = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.create();
  const image = file.type === "image/png" ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
  const page = pdfDoc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  const pdfBytes = await pdfDoc.save();
  const pdfName = file.name.replace(/\.[^.]+$/, "") + ".pdf";
  return new File([pdfBytes], pdfName, { type: "application/pdf" });
}

/*
  ============================================================================
  MODULE 1 — STUDENT-FACING APP
  ============================================================================
  Integration notes for Module 3 (backend):

    POST /api/shops/:shopId/jobs
      body (LOCKED CONTRACT): { fileUrl, pages, copies, colorMode, studentPhone }
      returns: { jobId, amountDue, status: "uploaded" }

    POST /api/jobs/:jobId/payment
      body: { paymentRef }
      returns: { jobId, status: "paid", tokenNumber }

    GET /api/jobs/:jobId
      returns: { jobId, status, tokenNumber, shopName, amountDue, createdAt }

  ⚠️ CONTRACT DEVIATION — NEEDS CROSS-TEAM SIGN-OFF BEFORE MERGE ⚠️
  Per the new requirements (single/double-sided printing + custom color-page
  selection), the job-creation payload now sends THREE fields beyond the
  locked contract:

    sides:      "single" | "double"
    colorMode:  "bw" | "color" | "mixed"   (was only "bw" | "color")
    colorPages: string, e.g. "3,5,8-10"    (ONLY present when colorMode is "mixed" —
                the specific pages to print in color; all other pages print bw)

  I have NOT changed the contract myself — I'm flagging it here so whoever
  owns Module 3 can decide how to store/validate these (extra columns vs a
  JSON "options" blob) and so Module 2's dashboard knows to render them.
  Until that's agreed, the mock backend below just accepts and echoes them
  back so Module 1 isn't blocked. If the field names above change, only
  this file's `createJob` call site needs updating.

  File upload: still assuming a pre-signed upload URL flow. There's no
  endpoint for that in the locked contract text — flagged in the previous
  pass too. Fully mocked below.

  Status state machine (progress track UI):
    uploaded -> paid -> queued -> printing -> ready -> collected
    (also: cancelled, from any state before "printing")

  URL params this app reads:
    ?shopId=xxx   — required to start a new job (from the shop's QR code)
    ?jobId=xxx    — if present, app goes straight to the status/token page
  ============================================================================
*/

// Same pattern as Module 2's src/api.js: flip VITE_USE_MOCK=false in .env once
// Module 3 is running locally/deployed. Defaults to mock so this still runs
// standalone with zero backend dependency.
const MOCK_MODE = import.meta.env.VITE_USE_MOCK !== "false";
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

const RATE_PER_PAGE = { bw: 2, color: 8 }; // INR — client-side ESTIMATE only.
// The authoritative amountDue always comes back from POST /jobs and is what
// we actually charge at the review step.

const STATUS_STEPS = ["uploaded", "paid", "queued", "printing", "ready", "collected"];
const FLOW_STEPS = ["Order details", "Review & pay", "Track order"];

// ---------------------------------------------------------------------------
// Page-range parsing, e.g. "1-3,5,8-10" -> Set{1,2,3,5,8,9,10}
// ---------------------------------------------------------------------------
function parsePageRange(input, maxPages) {
  const trimmed = input.trim();
  if (!trimmed) return { pages: new Set(), error: "Enter at least one page number." };
  const pages = new Set();
  const parts = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < 1 || end > maxPages || start > end) {
        return { pages: new Set(), error: `"${part}" is outside 1–${maxPages}.` };
      }
      for (let i = start; i <= end; i++) pages.add(i);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n < 1 || n > maxPages) {
        return { pages: new Set(), error: `Page ${n} is outside 1–${maxPages}.` };
      }
      pages.add(n);
    } else {
      return { pages: new Set(), error: `Couldn't read "${part}". Use e.g. 1-3,5,8-10.` };
    }
  }
  return { pages, error: null };
}

function computeEstimate({ pages, copies, colorMode, colorPageCount, rates }) {
  const r = rates || RATE_PER_PAGE;
  if (colorMode === "mixed") {
    const bwPages = Math.max(0, pages - colorPageCount);
    return (colorPageCount * r.color + bwPages * r.bw) * copies;
  }
  return pages * copies * r[colorMode];
}

// ---------------------------------------------------------------------------
// Mock backend (MOCK_MODE = true). Simulates network delay and auto-advances
// status over time so the polling UI is demoable before Module 3 is live.
// ---------------------------------------------------------------------------
const mockDb = new Map();
let mockJobCounter = 1000;
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const MOCK_LANDMARKS = [{ id: "lm_anurag_university", name: "Anurag University" }];
const MOCK_SHOPS_BY_LANDMARK = {
  lm_anurag_university: [
    { shopId: "demo-shop", name: "Sharma Xerox & Print Center" },
    { shopId: "demo-shop-2", name: "Campus Copy Point" },
  ],
};
const MOCK_SHOP_PUBLIC_INFO = {
  "demo-shop": {
    shopId: "demo-shop",
    name: "Sharma Xerox & Print Center",
    priceBw: 2,
    priceColor: 10,
    maxPagesPerHour: 500,
  },
  "demo-shop-2": {
    shopId: "demo-shop-2",
    name: "Campus Copy Point",
    priceBw: 3,
    priceColor: 12,
    maxPagesPerHour: null,
  },
};

const mockApi = {
  async getLandmarks() {
    await delay(250);
    return MOCK_LANDMARKS;
  },
  async getShopsByLandmark(landmarkId) {
    await delay(300);
    return MOCK_SHOPS_BY_LANDMARK[landmarkId] || [];
  },
  async getShopPublicInfo(shopId) {
    await delay(200);
    return (
      MOCK_SHOP_PUBLIC_INFO[shopId] || {
        shopId,
        name: "This shop",
        priceBw: RATE_PER_PAGE.bw,
        priceColor: RATE_PER_PAGE.color,
        maxPagesPerHour: null,
      }
    );
  },
  async uploadFile(file) {
    await delay(400);
    return { fileUrl: `mock://files/${Date.now()}-${file?.name || "file.pdf"}` };
  },
  async convertDocxToPdf(file) {
    await delay(500);
    // Mock mode has no LibreOffice to actually convert with, so just wrap
    // the bytes as-is with a PDF content type - good enough for exercising
    // the UI flow (loading state, error handling, downstream page count)
    // without a backend. Real conversion only happens via realApi.
    return new File([await file.arrayBuffer()], file.name.replace(/\.docx$/i, ".pdf"), {
      type: "application/pdf",
    });
  },
  async createJob(shopId, body) {
    await delay(600);
    const jobId = `job_${mockJobCounter++}`;
    const job = {
      jobId,
      shopId,
      shopName: "Sharma Xerox & Print Center",
      status: "uploaded",
      amountDue: body.amountDueEstimate,
      tokenNumber: null,
      createdAt: new Date().toISOString(),
      ...body,
    };
    mockDb.set(jobId, job);
    return { jobId, amountDue: job.amountDue, status: "uploaded" };
  },
  async payJob(jobId) {
    await delay(700);
    const job = mockDb.get(jobId);
    if (!job) throw new Error("Job not found");
    job.status = "paid";
    job.tokenNumber = String(Math.floor(100 + Math.random() * 800));
    job.paidAt = Date.now();
    mockDb.set(jobId, job);
    return { jobId, status: "paid", tokenNumber: job.tokenNumber };
  },
  async getJob(jobId) {
    await delay(350);
    const job = mockDb.get(jobId);
    if (!job) throw new Error("Job not found");
    if (job.paidAt) {
      const s = (Date.now() - job.paidAt) / 1000;
      if (s > 24) job.status = "ready";
      else if (s > 14) job.status = "printing";
      else if (s > 5) job.status = "queued";
    }
    return {
      jobId: job.jobId,
      status: job.status,
      tokenNumber: job.tokenNumber,
      shopName: job.shopName,
      amountDue: job.amountDue,
      createdAt: job.createdAt,
    };
  },
  // Item #3 — order history by phone, no OTP. Mock version just filters
  // the same in-memory mockDb every createJob() call already writes to, so
  // anything ordered earlier in this session actually shows up here too.
  async getOrderHistory(phone) {
    await delay(300);
    return Array.from(mockDb.values())
      .filter((j) => j.studentPhone === phone)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 20)
      .map((j) => ({
        jobId: j.jobId,
        shopId: j.shopId,
        shopName: j.shopName,
        status: j.status,
        tokenNumber: j.tokenNumber,
        amountDue: j.amountDue,
        pages: j.pages,
        copies: j.copies,
        colorMode: j.colorMode,
        createdAt: j.createdAt,
      }));
  },
};

const realApi = {
  async getLandmarks() {
    const res = await fetch(`${API_BASE_URL}/api/landmarks`);
    if (!res.ok) throw new Error("Could not load landmarks");
    return res.json();
  },
  async getShopsByLandmark(landmarkId) {
    const res = await fetch(`${API_BASE_URL}/api/shops?landmarkId=${encodeURIComponent(landmarkId)}`);
    if (!res.ok) throw new Error("Could not load shops");
    return res.json();
  },
  async getShopPublicInfo(shopId) {
    const res = await fetch(`${API_BASE_URL}/api/shops/${shopId}/public`);
    if (!res.ok) throw new Error("Could not load this shop's pricing");
    return res.json(); // { shopId, name, priceBw, priceColor, maxPagesPerHour }
  },
  // Module 3 (src/routes/uploads.js) expects multipart/form-data with a
  // "file" field, not a pre-signed URL flow - this sends the PDF directly.
  async uploadFile(file) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE_URL}/api/uploads`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "File upload failed");
    }
    return res.json(); // { fileUrl }
  },
  // Hits the isolated /api/convert/docx-to-pdf endpoint (LibreOffice
  // headless server-side - see module3-backend/src/routes/convert.js) and
  // returns a real PDF File so the rest of the upload flow never has to
  // know the original was a .docx.
  async convertDocxToPdf(file) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE_URL}/api/convert/docx-to-pdf`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not convert that document to PDF");
    }
    const pdfBlob = await res.blob();
    const pdfName = file.name.replace(/\.docx$/i, "") + ".pdf";
    return new File([pdfBlob], pdfName, { type: "application/pdf" });
  },
  async createJob(shopId, body) {
    const res = await fetch(`${API_BASE_URL}/api/shops/${shopId}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("Could not create job");
    return res.json();
  },
  async payJob(jobId, paymentRef) {
    const res = await fetch(`${API_BASE_URL}/api/jobs/${jobId}/payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentRef }),
    });
    if (!res.ok) throw new Error("Payment failed");
    return res.json();
  },
  async getJob(jobId) {
    const res = await fetch(`${API_BASE_URL}/api/jobs/${jobId}`);
    if (!res.ok) throw new Error("Could not fetch job");
    return res.json();
  },
  // Item #3 — order history by phone, no OTP (see src/routes/students.js).
  async getOrderHistory(phone) {
    const res = await fetch(`${API_BASE_URL}/api/students/${encodeURIComponent(phone)}/jobs`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not load order history");
    }
    return res.json();
  },
};

const api = MOCK_MODE ? mockApi : realApi;

// ---------------------------------------------------------------------------
// URL + local storage helpers
// ---------------------------------------------------------------------------
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}
// Pushes a real history entry per phase (home / upload / review / status) so
// the browser or a phone's hardware Back button pops one in-app screen at a
// time via popstate (handled in App below), instead of exiting the SPA -
// which is what was showing up as "back reloads the page".
function pushPhase(phase, { shopId, jobId } = {}) {
  const url = new URL(window.location.href);
  shopId ? url.searchParams.set("shopId", shopId) : url.searchParams.delete("shopId");
  jobId ? url.searchParams.set("jobId", jobId) : url.searchParams.delete("jobId");
  window.history.pushState({ phase, shopId: shopId || null, jobId: jobId || null }, "", url.toString());
}
function rememberJob(jobId, shopId, label) {
  try {
    const raw = window.localStorage.getItem("printq_jobs");
    const jobs = raw ? JSON.parse(raw) : [];
    const filtered = jobs.filter((j) => j.jobId !== jobId);
    filtered.unshift({ jobId, shopId, label, savedAt: Date.now() });
    window.localStorage.setItem("printq_jobs", JSON.stringify(filtered.slice(0, 6)));
  } catch (e) {
    // localStorage unavailable — non-fatal
  }
}
function getRecentJobs() {
  try {
    const raw = window.localStorage.getItem("printq_jobs");
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
// "Login" is just remembering the phone number the student last looked up
// their order history with — there's no password, so there's nothing to
// verify, only something to save so they don't retype it every visit.
function getSavedPhone() {
  try {
    return window.localStorage.getItem("printq_phone") || "";
  } catch (e) {
    return "";
  }
}
function savePhone(phone) {
  try {
    window.localStorage.setItem("printq_phone", phone);
  } catch (e) {
    // localStorage unavailable — non-fatal, just won't be remembered
  }
}
function clearSavedPhone() {
  try {
    window.localStorage.removeItem("printq_phone");
  } catch (e) {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// Small UI primitives
// ---------------------------------------------------------------------------
function Spinner({ label }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-stone-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-700" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

function ErrorBanner({ message, onRetry }) {
  return (
    <div className="rounded-lg border border-red-800/25 bg-red-800/5 px-4 py-3 text-sm text-red-900">
      <p className="font-semibold">Something went wrong</p>
      <p className="mt-0.5 text-red-800/80">{message}</p>
      {onRetry && (
        <button type="button"
          onClick={onRetry}
          className="mt-2.5 rounded-md border border-red-800/30 px-3 py-1.5 text-xs font-medium hover:bg-red-800/10"
        >
          Try again
        </button>
      )}
    </div>
  );
}

function Header({ shopName }) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#A63A2C]">
          PrintNow
        </p>
        <h1 className="mt-0.5 font-mono text-[19px] font-bold leading-tight text-stone-900">
          {shopName || "Loading shop\u2026"}
        </h1>
      </div>
      <div className="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-[11px] font-medium text-stone-600">
        No app needed
      </div>
    </div>
  );
}

function Stepper({ currentStep }) {
  return (
    <div className="mb-6 flex items-center">
      {FLOW_STEPS.map((label, i) => {
        const idx = i + 1;
        const done = idx < currentStep;
        const active = idx === currentStep;
        return (
          <React.Fragment key={label}>
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-mono font-semibold transition-colors ${
                  done
                    ? "bg-[#2F6E68] text-white"
                    : active
                    ? "bg-[#A63A2C] text-white"
                    : "bg-stone-200 text-stone-500"
                }`}
              >
                {done ? "\u2713" : idx}
              </div>
              <span
                className={`text-center text-[10px] leading-tight ${
                  active ? "font-semibold text-stone-800" : "text-stone-400"
                }`}
                style={{ width: 66 }}
              >
                {label}
              </span>
            </div>
            {idx < FLOW_STEPS.length && (
              <div className={`mx-1 h-px flex-1 ${done ? "bg-[#2F6E68]" : "bg-stone-200"}`} style={{ marginBottom: 16 }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function RecentOrders({ onOpen }) {
  const [jobs, setJobs] = useState([]);
  useEffect(() => setJobs(getRecentJobs()), []);
  if (jobs.length === 0) return null;
  return (
    <div className="mb-6">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">
        Your recent orders
      </p>
      <div className="flex flex-wrap gap-2">
        {jobs.map((j) => (
          <button type="button"
            key={j.jobId}
            onClick={() => onOpen(j.jobId)}
            className="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 active:bg-stone-50"
          >
            {j.label || j.jobId}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Upload + print settings + estimate
// ---------------------------------------------------------------------------
function UploadStep({ shopId, order, setOrder, onJobCreated, onOpenRecent, onBack }) {
  const { file, pages, copies, sides, colorMode, colorPages, phone, detectedPages } = order;
  const [detecting, setDetecting] = useState(false);
  const [converting, setConverting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [shopInfo, setShopInfo] = useState(null);
  const fileInputRef = useRef(null);

  // Every shop sets its own per-page pricing and (optionally) an hourly
  // print cap from its Settings page - fetch it once the student's landed
  // here so the running estimate below is real, not a guessed flat rate,
  // and so they can see up front if this shop limits pages per hour.
  useEffect(() => {
    if (!shopId) return;
    let cancelled = false;
    api
      .getShopPublicInfo(shopId)
      .then((info) => {
        if (!cancelled) setShopInfo(info);
      })
      .catch(() => {
        // Non-fatal: computeEstimate() falls back to a default rate below,
        // and the price/cap info card just doesn't render.
      });
    return () => {
      cancelled = true;
    };
  }, [shopId]);

  function patch(fields) {
    setOrder((prev) => ({ ...prev, ...fields }));
  }

  async function handleFileChosen(chosenFile) {
    if (!chosenFile) return;
    let fileToUse = chosenFile;
    const isDocx =
      chosenFile.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      /\.docx$/i.test(chosenFile.name);
    const isImage = chosenFile.type === "image/jpeg" || chosenFile.type === "image/png";

    if (isDocx) {
      setConverting(true);
      setError(null);
      try {
        fileToUse = await api.convertDocxToPdf(chosenFile);
      } catch (err) {
        setConverting(false);
        setError(err.message || "Could not convert that document. Try saving it as a PDF instead.");
        return;
      }
      setConverting(false);
    } else if (isImage) {
      setDetecting(true);
      try {
        fileToUse = await imageFileToPdfFile(chosenFile);
      } catch (err) {
        setDetecting(false);
        setError("Could not process that photo. Try a different photo, or choose a PDF instead.");
        return;
      }
    }

    patch({ file: fileToUse, detectedPages: null });
    setDetecting(true);
    const count = await countPdfPages(fileToUse);
    setDetecting(false);
    if (count) {
      // Default the page count to the PDF's real page count, and cap manual
      // entry at that same number - a student can print FEWER pages (e.g.
      // just a couple of pages from a longer document) but can't
      // accidentally under- or over-state how long their own file is.
      patch({ detectedPages: count, pages: String(count) });
    }
    // count === null: not a well-formed PDF we could parse, or parsing
    // failed for some other reason - fall back to manual entry with no cap
    // (handled below via detectedPages staying null) rather than blocking
    // the order over it.
  }

  const pagesNum = parseInt(pages, 10) || 0;
  const rangeResult =
    colorMode === "mixed" && pagesNum > 0 ? parsePageRange(colorPages, pagesNum) : null;
  const colorPageCount = rangeResult ? rangeResult.pages.size : 0;
  const rangeError = colorMode === "mixed" && colorPages.trim() ? rangeResult?.error : null;

  const estimate =
    pagesNum > 0
      ? computeEstimate({
          pages: pagesNum,
          copies,
          colorMode,
          colorPageCount,
          rates: shopInfo ? { bw: shopInfo.priceBw, color: shopInfo.priceColor } : null,
        })
      : 0;

  const canSubmit =
    file &&
    pagesNum > 0 &&
    copies > 0 &&
    /^[6-9]\d{9}$/.test(phone.trim()) &&
    !uploading &&
    !converting &&
    (colorMode !== "mixed" || (colorPages.trim() && !rangeError));

  function handlePagesChange(e) {
    let n = parseInt(e.target.value, 10) || 0;
    // Cap at the PDF's real page count when we know it - a student can
    // reduce it (print only the first N pages) but can't type in more
    // pages than the document actually has.
    if (detectedPages && n > detectedPages) n = detectedPages;
    patch({ pages: n ? String(n) : "" });
  }

  async function handleSubmit() {
    setError(null);
    setUploading(true);
    try {
      const { fileUrl } = await api.uploadFile(file);

      const payload = {
        fileUrl,
        pages: pagesNum,
        copies,
        colorMode,
        studentPhone: phone.trim(),
        sides, // ⚠️ beyond locked contract — see file header
        amountDueEstimate: estimate,
      };
      if (colorMode === "mixed") {
        payload.colorPages = colorPages.trim(); // ⚠️ beyond locked contract — see file header
      }

      const job = await api.createJob(shopId, payload);
      onJobCreated(job.jobId, {
        fileName: file.name,
        pages: pagesNum,
        copies,
        sides,
        colorMode,
        colorPages: colorMode === "mixed" ? colorPages.trim() : null,
      });
    } catch (e) {
      setError(e.message || "Upload failed. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-5">
      {onBack && (
        <button type="button"
          onClick={onBack}
          className="-mt-1 mb-1 flex items-center gap-1 text-xs font-medium text-stone-500 hover:text-stone-700"
        >
          ← Back
        </button>
      )}

      <RecentOrders onOpen={onOpenRecent} />

      {shopInfo && (
        <div className="rounded-lg border border-stone-300 bg-stone-50 px-3.5 py-3 text-xs text-stone-600">
          <p>
            <span className="font-medium text-stone-800">₹{shopInfo.priceBw}/page</span> black &amp;
            white · <span className="font-medium text-stone-800">₹{shopInfo.priceColor}/page</span> color
          </p>
          {shopInfo.maxPagesPerHour && (
            <p className="mt-1 text-stone-500">
              This shop prints up to {shopInfo.maxPagesPerHour} pages/hour. If it's busy, your
              order still queues automatically — no need to re-submit.
            </p>
          )}
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Document (PDF, Word, or photo)
        </label>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={converting}
          className="flex w-full items-center justify-between rounded-lg border border-stone-300 bg-white px-3.5 py-3.5 text-left text-sm shadow-sm shadow-stone-900/[0.03] active:bg-stone-50 disabled:opacity-60"
        >
          <span className={file ? "font-medium text-stone-900" : "text-stone-400"}>
            {converting ? "Converting to PDF…" : file ? file.name : "Choose a PDF, Word doc, or photo"}
          </span>
          <span className="ml-3 shrink-0 rounded-md bg-stone-900 px-2.5 py-1.5 text-[11px] font-medium text-stone-50">
            {converting ? "…" : "Browse"}
          </span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx"
          className="hidden"
          disabled={converting}
          onChange={(e) => handleFileChosen(e.target.files?.[0] || null)}
        />
        {converting && (
          <p className="mt-1 text-[11px] text-stone-500">
            Converting your Word document to PDF — usually just a few seconds…
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
            Pages
          </label>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={detectedPages || undefined}
            value={pages}
            onChange={handlePagesChange}
            placeholder={detecting ? "Reading PDF…" : "e.g. 12"}
            disabled={detecting || converting}
            className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm shadow-sm shadow-stone-900/[0.03] focus:border-stone-500 focus:outline-none disabled:bg-stone-100"
          />
          <p className="mt-1 text-[11px] text-stone-500">
            {detecting
              ? "Detecting page count…"
              : detectedPages
              ? `Detected ${detectedPages} page${detectedPages > 1 ? "s" : ""} — reduce if you only need some.`
              : file
              ? "Couldn't auto-detect page count — enter it manually."
              : ""}
          </p>
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
            Copies
          </label>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={copies}
            onChange={(e) => patch({ copies: Math.max(1, parseInt(e.target.value, 10) || 1) })}
            className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm shadow-sm shadow-stone-900/[0.03] focus:border-stone-500 focus:outline-none"
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Sides
        </label>
        <div className="grid grid-cols-2 gap-2">
          {[
            { v: "single", label: "One-sided" },
            { v: "double", label: "Double-sided" },
          ].map((opt) => (
            <button
              key={opt.v}
              type="button"
              onClick={() => patch({ sides: opt.v })}
              className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                sides === opt.v
                  ? "border-stone-900 bg-stone-900 text-stone-50"
                  : "border-stone-300 bg-white text-stone-600"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Print type
        </label>
        <div className="grid grid-cols-3 gap-2">
          {[
            { v: "bw", label: "B & W" },
            { v: "color", label: "Color" },
            { v: "mixed", label: "Custom" },
          ].map((opt) => (
            <button
              key={opt.v}
              type="button"
              onClick={() => patch({ colorMode: opt.v })}
              className={`rounded-lg border px-2 py-2.5 text-[13px] font-medium transition ${
                colorMode === opt.v
                  ? "border-stone-900 bg-stone-900 text-stone-50"
                  : "border-stone-300 bg-white text-stone-600"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {colorMode === "mixed" && (
          <div className="mt-2.5 rounded-lg border border-dashed border-[#2F6E68]/40 bg-[#2F6E68]/5 px-3.5 py-3">
            <label className="mb-1 block text-xs font-medium text-stone-600">
              Which pages should print in color?
            </label>
            <input
              type="text"
              value={colorPages}
              onChange={(e) => patch({ colorPages: e.target.value })}
              placeholder="e.g. 1-3,7,10"
              disabled={pagesNum === 0}
              className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm focus:border-stone-500 focus:outline-none disabled:bg-stone-100"
            />
            <p className="mt-1 text-[11px] text-stone-500">
              {pagesNum === 0
                ? "Enter the page count above first."
                : rangeError
                ? rangeError
                : colorPageCount > 0
                ? `${colorPageCount} page${colorPageCount > 1 ? "s" : ""} in color, ${
                    pagesNum - colorPageCount
                  } in black & white.`
                : "All other pages print in black & white."}
            </p>
          </div>
        )}
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Your phone number
        </label>
        <input
          type="tel"
          inputMode="numeric"
          value={phone}
          onChange={(e) => patch({ phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
          placeholder="10-digit mobile number"
          className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm shadow-sm shadow-stone-900/[0.03] focus:border-stone-500 focus:outline-none"
        />
        <p className="mt-1 text-xs text-stone-500">We'll text you when it's ready to collect.</p>
      </div>

      {pagesNum > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-dashed border-stone-300 px-4 py-3">
          <span className="text-sm text-stone-600">Estimated price</span>
          <span className="font-mono text-base font-semibold text-stone-900">₹{estimate}</span>
        </div>
      )}

      {error && <ErrorBanner message={error} onRetry={handleSubmit} />}

      <button type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-full rounded-lg bg-[#A63A2C] py-3.5 text-sm font-semibold text-white shadow-sm shadow-[#A63A2C]/20 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-stone-300 disabled:shadow-none"
      >
        {uploading ? "Uploading\u2026" : "Review order"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Order review (receipt preview) + payment
// ---------------------------------------------------------------------------
function ReviewPaymentStep({ jobId, amountDue, order, onPaid, onBack }) {
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState(null);

  async function handlePay() {
    setError(null);
    setPaying(true);
    try {
      const paymentRef = `simulated_${Date.now()}`;
      const result = await api.payJob(jobId, paymentRef);
      onPaid(result.tokenNumber);
    } catch (e) {
      setError(e.message || "Payment failed. Please try again.");
    } finally {
      setPaying(false);
    }
  }

  const rows = [
    ["Document", order?.fileName],
    ["Pages", order?.pages],
    ["Copies", order?.copies],
    ["Sides", order?.sides === "double" ? "Double-sided" : "One-sided"],
    [
      "Color",
      order?.colorMode === "mixed"
        ? `Custom (pages ${order.colorPages})`
        : order?.colorMode === "color"
        ? "Full color"
        : "Black & white",
    ],
  ];

  return (
    <div className="space-y-5">
      {onBack && (
        <button type="button"
          onClick={onBack}
          disabled={paying}
          className="-mt-1 mb-1 flex items-center gap-1 text-xs font-medium text-stone-500 hover:text-stone-700 disabled:opacity-50"
        >
          ← Back to edit order
        </button>
      )}

      <div className="rounded-xl border border-stone-300 bg-white px-4 py-4 shadow-sm shadow-stone-900/[0.03]">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-stone-500">
          Order summary
        </p>
        <dl className="space-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between text-sm">
              <dt className="text-stone-500">{label}</dt>
              <dd className="max-w-[60%] truncate text-right font-medium text-stone-800">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="my-3 border-t border-dashed border-stone-300" />
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-stone-700">Amount due</span>
          <span className="font-mono text-2xl font-bold text-stone-900">₹{amountDue}</span>
        </div>
      </div>

      <p className="text-center text-xs text-stone-500">
        UPI payment integration is coming soon — this button simulates a successful payment for
        now.
      </p>

      {error && <ErrorBanner message={error} onRetry={handlePay} />}

      <button type="button"
        onClick={handlePay}
        disabled={paying}
        className="w-full rounded-lg bg-[#2F6E68] py-3.5 text-sm font-semibold text-white shadow-sm shadow-[#2F6E68]/20 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-stone-300 disabled:shadow-none"
      >
        {paying ? "Confirming payment\u2026" : "Pay now"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Token + status page (polls GET /jobs/:jobId)
// ---------------------------------------------------------------------------
function StatusStep({ jobId, onBack }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.getJob(jobId);
      setJob(data);
      setError(null);
    } catch (e) {
      setError(e.message || "Could not refresh status.");
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 4000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  async function handleShare() {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: "My print order", url });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch (e) {
      // user cancelled share sheet — no-op
    }
  }

  if (loading && !job) return <Spinner label="Loading your token\u2026" />;
  if (error && !job) return <ErrorBanner message={error} onRetry={fetchStatus} />;
  if (!job) return null;

  const isCancelled = job.status === "cancelled";
  const currentIndex = STATUS_STEPS.indexOf(job.status);

  return (
    <div>
      {onBack && (
        <button type="button"
          onClick={onBack}
          className="-mt-1 mb-3 flex items-center gap-1 text-xs font-medium text-stone-500 hover:text-stone-700"
        >
          ← Back to home
        </button>
      )}
      <div className="relative overflow-hidden rounded-xl border border-stone-300 bg-white px-5 py-6 shadow-sm shadow-stone-900/[0.04]">
        <div
          className="absolute -top-2 left-0 right-0 h-4 bg-[repeating-linear-gradient(90deg,transparent,transparent_6px,#DCD5C3_6px,#DCD5C3_8px)]"
          aria-hidden="true"
        />

        <div className="text-center">
        <p className="text-xs uppercase tracking-widest text-stone-500">Your token</p>
        <p className="mt-1 font-mono text-5xl font-bold tracking-wider text-stone-900">
          {job.tokenNumber || "\u2014"}
        </p>
        <p className="mt-1 text-sm text-stone-500">{job.shopName}</p>
      </div>

      <div className="my-6 border-t border-dashed border-stone-300" />

      {isCancelled ? (
        <div className="rounded-lg border border-red-800/25 bg-red-800/5 px-4 py-3 text-center text-sm text-red-900">
          This order was cancelled.
        </div>
      ) : (
        <ol className="space-y-3">
          {STATUS_STEPS.map((step, i) => {
            const done = i < currentIndex;
            const active = i === currentIndex;
            return (
              <li key={step} className="flex items-center gap-3">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-mono ${
                    done
                      ? "border-[#2F6E68] bg-[#2F6E68] text-white"
                      : active
                      ? "animate-pulse border-[#A63A2C] bg-[#A63A2C] text-white"
                      : "border-stone-300 text-stone-400"
                  }`}
                >
                  {done ? "\u2713" : i + 1}
                </span>
                <span
                  className={`text-sm capitalize ${
                    active ? "font-semibold text-stone-900" : done ? "text-stone-600" : "text-stone-400"
                  }`}
                >
                  {step}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mt-6 flex items-center justify-between text-xs text-stone-500">
        <span>Amount paid: ₹{job.amountDue}</span>
        <div className="flex items-center gap-3">
          <button type="button" onClick={handleShare} className="font-medium text-stone-700 underline">
            {copied ? "Link copied" : "Share status"}
          </button>
          <button type="button" onClick={fetchStatus} className="font-medium text-stone-700 underline">
            Refresh
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item #3 — "My Orders": no-OTP login by phone number + order history
// ---------------------------------------------------------------------------
const HISTORY_STATUS_LABEL = {
  uploaded: "Awaiting payment",
  paid: "Paid",
  queued: "In queue",
  printing: "Printing",
  ready: "Ready for pickup",
  collected: "Collected",
  cancelled: "Cancelled",
};

function HistoryStatusBadge({ status }) {
  const styles =
    status === "ready"
      ? "bg-[#2F6E68]/10 text-[#2F6E68]"
      : status === "collected"
      ? "bg-stone-200 text-stone-500"
      : status === "cancelled"
      ? "bg-red-800/10 text-red-800"
      : "bg-[#A63A2C]/10 text-[#A63A2C]";
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${styles}`}>
      {HISTORY_STATUS_LABEL[status] || status}
    </span>
  );
}

// Working/pending = still moving through the queue; "spent" only counts
// orders actually paid for (everything except "uploaded", which means the
// student never completed payment - same rule Module 3 uses for revenue).
const PENDING_STATUSES = ["paid", "queued", "printing"];

function MyOrdersSummary({ jobs }) {
  const pending = jobs.filter((j) => PENDING_STATUSES.includes(j.status)).length;
  const ready = jobs.filter((j) => j.status === "ready").length;
  const totalSpent = jobs
    .filter((j) => j.status !== "uploaded")
    .reduce((sum, j) => sum + (j.amountDue || 0), 0);

  return (
    <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-center">
        <p className="font-mono text-lg font-bold text-stone-900">{jobs.length}</p>
        <p className="text-[11px] text-stone-500">Total orders</p>
      </div>
      <div className="rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-center">
        <p className="font-mono text-lg font-bold text-[#A63A2C]">{pending}</p>
        <p className="text-[11px] text-stone-500">In progress</p>
      </div>
      <div className="rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-center">
        <p className="font-mono text-lg font-bold text-[#2F6E68]">{ready}</p>
        <p className="text-[11px] text-stone-500">Ready for pickup</p>
      </div>
      <div className="rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-center">
        <p className="font-mono text-lg font-bold text-stone-900">₹{totalSpent}</p>
        <p className="text-[11px] text-stone-500">Total spent</p>
      </div>
    </div>
  );
}

function MyOrdersStep({ onOpenJob, onBack }) {
  const [phone, setPhone] = useState(() => getSavedPhone());
  const [editing, setEditing] = useState(() => !getSavedPhone());
  const [jobs, setJobs] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchHistory = useCallback(async (p) => {
    setLoading(true);
    setError(null);
    try {
      const rows = await api.getOrderHistory(p);
      setJobs(rows);
    } catch (e) {
      setError(e.message || "Could not load your orders.");
      setJobs(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const saved = getSavedPhone();
    if (saved) fetchHistory(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleLookup(e) {
    e.preventDefault();
    const trimmed = phone.trim();
    if (!/^[6-9]\d{9}$/.test(trimmed)) {
      setError("Enter a valid 10-digit mobile number.");
      return;
    }
    savePhone(trimmed);
    setEditing(false);
    fetchHistory(trimmed);
  }

  function handleUseDifferentNumber() {
    clearSavedPhone();
    setPhone("");
    setJobs(null);
    setError(null);
    setEditing(true);
  }

  return (
    <div>
      {onBack && (
        <button type="button"
          onClick={onBack}
          className="-mt-1 mb-3 flex items-center gap-1 text-xs font-medium text-stone-500 hover:text-stone-700"
        >
          ← Back to home
        </button>
      )}
      <div className="mb-5 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#A63A2C]">
          PrintNow
        </p>
        <h1 className="mt-1 font-mono text-xl font-bold text-stone-900">My Orders</h1>
        <p className="mt-1 text-sm text-stone-500">
          Enter your phone number to see your past orders. No OTP — just the
          number you ordered with.
        </p>
      </div>

      {editing ? (
        <form onSubmit={handleLookup} className="mb-2">
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
            Mobile number
          </label>
          <input
            type="tel"
            inputMode="numeric"
            maxLength={10}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
            placeholder="9876543210"
            className="mb-3 w-full rounded-lg border border-stone-300 bg-white px-3.5 py-3 text-sm shadow-sm"
          />
          {error && <p className="mb-3 text-sm text-red-800">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#A63A2C] px-4 py-3.5 text-sm font-semibold text-white shadow-sm active:bg-[#8f3125] disabled:opacity-60"
          >
            {loading ? "Looking up\u2026" : "View my orders"}
          </button>
        </form>
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between rounded-lg border border-stone-300 bg-white px-3.5 py-2.5">
            <span className="text-sm text-stone-600">{phone}</span>
            <button type="button"
              onClick={handleUseDifferentNumber}
              className="text-xs font-medium text-stone-500 underline"
            >
              Use a different number
            </button>
          </div>

          {loading && <Spinner label="Loading your orders\u2026" />}
          {error && !loading && <ErrorBanner message={error} onRetry={() => fetchHistory(phone)} />}

          {!loading && !error && jobs && jobs.length === 0 && (
            <p className="py-6 text-center text-sm text-stone-500">
              No orders found for this number yet.
            </p>
          )}

          {!loading && !error && jobs && jobs.length > 0 && (
            <>
              <MyOrdersSummary jobs={jobs} />
              <div className="space-y-2">
                {jobs.map((j) => (
                  <button type="button"
                    key={j.jobId}
                    onClick={() => onOpenJob(j.jobId, j.shopId)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-stone-300 bg-white px-3.5 py-3.5 text-left shadow-sm active:bg-stone-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-800">{j.shopName}</p>
                      <p className="mt-0.5 text-xs text-stone-500">
                        {j.pages ? `${j.pages} pg × ${j.copies}` : ""}
                        {j.amountDue != null ? ` · ₹${j.amountDue}` : ""}
                        {j.tokenNumber ? ` · Token ${j.tokenNumber}` : ""}
                      </p>
                    </div>
                    <HistoryStatusBadge status={j.status} />
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home — landing screen: scan a shop's QR code, or browse shops by landmark.
// Beta note: "location-based" here means landmark-based (e.g. a college),
// not GPS. Landmarks are admin-created; for beta there's only one seeded by
// the backend ("Anurag University" - see module3-backend/src/db.js).
// ---------------------------------------------------------------------------
function extractShopIdFromScan(text) {
  try {
    const url = new URL(text);
    const fromParam = url.searchParams.get("shopId");
    if (fromParam) return fromParam;
  } catch {
    // Not a URL - treat the raw scanned text as the shopId itself, so shops
    // can also just print a QR code containing their bare shopId.
  }
  return text.trim();
}

function QrScanner({ onScan, onClose }) {
  const containerId = "qr-reader";
  const scannerRef = useRef(null);
  const hasScannedRef = useRef(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    hasScannedRef.current = false;
    const scanner = new Html5Qrcode(containerId);
    scannerRef.current = scanner;
    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText) => {
          // fps:10 keeps feeding frames while stop() is still resolving, so
          // a successful decode can fire again for the same code before the
          // camera actually stops. Without this guard that second callback
          // re-triggers onScan and races the screen transition, which is
          // what made live scanning look like it "did nothing" - hand off
          // on the first hit only, and don't block the transition on stop()
          // resolving.
          if (hasScannedRef.current) return;
          hasScannedRef.current = true;
          onScan(decodedText);
          scanner.stop().catch(() => {});
        },
        () => {} // per-frame decode misses are normal while aiming - ignore
      )
      .catch((err) => setError(err?.message || "Could not access camera"));

    return () => {
      scannerRef.current?.stop().catch(() => {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mb-6 rounded-xl border border-stone-300 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Point at the shop's QR code
        </p>
        <button type="button" onClick={onClose} className="text-xs font-medium text-stone-500 underline">
          Cancel
        </button>
      </div>
      {error ? (
        <p className="rounded-lg border border-red-800/25 bg-red-800/5 px-3 py-2 text-xs text-red-900">
          {error}. Check camera permissions, or use "choose by location" below instead.
        </p>
      ) : (
        <div id={containerId} className="overflow-hidden rounded-lg" />
      )}
    </div>
  );
}

// Cache survives HomeStep unmount/remount (e.g. navigating Upload -> Back
// to Home) but resets on an actual page reload, same lifetime as the rest
// of this module's in-memory state. Landmarks rarely change and a given
// landmark's shop list doesn't change mid-session either, so re-fetching
// both from scratch every time the student presses "Back" was producing a
// loading-spinner flash that read as "the page reloaded" even though it
// never actually did.
const homeStepCache = {
  landmarks: null,
  landmarkId: "",
  shops: null,
  shopsForLandmarkId: null,
};

function HomeStep({ onShopSelected, onMyOrders }) {
  const [scanning, setScanning] = useState(false);
  const [decodingFile, setDecodingFile] = useState(false);
  const [landmarks, setLandmarks] = useState(homeStepCache.landmarks || []);
  const [landmarkId, setLandmarkIdState] = useState(homeStepCache.landmarkId);
  const [shops, setShops] = useState(homeStepCache.shops || []);
  const [loadingShops, setLoadingShops] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  function setLandmarkId(id) {
    homeStepCache.landmarkId = id;
    setLandmarkIdState(id);
  }

  useEffect(() => {
    if (homeStepCache.landmarks) return; // already fetched earlier this session
    api
      .getLandmarks()
      .then((data) => {
        homeStepCache.landmarks = data;
        setLandmarks(data);
      })
      .catch(() => setError("Could not load landmarks."));
  }, []);

  useEffect(() => {
    if (!landmarkId) {
      setShops([]);
      return;
    }
    // Same landmark as last time (e.g. came right back to Home and picked
    // the same one) - reuse instantly instead of a network round trip.
    if (homeStepCache.shopsForLandmarkId === landmarkId && homeStepCache.shops) {
      setShops(homeStepCache.shops);
      return;
    }
    setLoadingShops(true);
    setError(null);
    api
      .getShopsByLandmark(landmarkId)
      .then((data) => {
        homeStepCache.shops = data;
        homeStepCache.shopsForLandmarkId = landmarkId;
        setShops(data);
      })
      .catch(() => setError("Could not load shops for this landmark."))
      .finally(() => setLoadingShops(false));
  }, [landmarkId]);

  function handleScan(decodedText) {
    setScanning(false);
    try {
      const id = extractShopIdFromScan(decodedText);
      if (!id) {
        setError("Scanned code didn't contain a shop ID. Try again or use \"choose by location\" below.");
        return;
      }
      onShopSelected(id);
    } catch (err) {
      // Whatever went wrong here was previously invisible - the screen just
      // stayed put with no clue why. Surface it so we can actually see the
      // failure instead of guessing at it blind.
      console.error("QR scan handling failed:", err);
      setError(`Could not process that code: ${err?.message || "unknown error"}. Please screenshot this and send it over.`);
    }
  }

  async function handleFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setDecodingFile(true);
    setError(null);
    try {
      // Reuses the same library as live scanning, just pointed at a static
      // image instead of the camera feed - for a QR code saved to the
      // phone's gallery (e.g. a screenshot, or a shop's printed code photographed earlier).
      const html5QrCode = new Html5Qrcode("qr-file-reader");
      const decodedText = await html5QrCode.scanFile(file, false);
      onShopSelected(extractShopIdFromScan(decodedText));
    } catch (err) {
      setError("Could not find a QR code in that image. Try a clearer photo, or scan live instead.");
    } finally {
      setDecodingFile(false);
      e.target.value = ""; // allow re-selecting the same file if they try again
    }
  }

  return (
    <div>
      <div className="mb-8 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#A63A2C]">
          PrintNow
        </p>
        <h1 className="mt-1 font-mono text-2xl font-bold leading-tight text-stone-900">
          Print from your phone,
          <br />
          skip the counter queue
        </h1>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-800/25 bg-red-800/5 px-4 py-3 text-sm text-red-900">
          {error}
        </div>
      )}

      {scanning ? (
        <QrScanner onScan={handleScan} onClose={() => setScanning(false)} />
      ) : (
        <>
          <button type="button"
            onClick={() => setScanning(true)}
            className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg bg-[#A63A2C] px-4 py-3.5 text-sm font-semibold text-white shadow-sm active:bg-[#8f3125]"
          >
            Scan shop QR code
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelected}
            className="hidden"
          />
          <button type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={decodingFile}
            className="mb-6 flex w-full items-center justify-center gap-2 rounded-lg border border-stone-300 bg-white px-4 py-3 text-sm font-medium text-stone-700 shadow-sm active:bg-stone-50 disabled:opacity-60"
          >
            {decodingFile ? "Reading QR code…" : "Upload a saved QR image"}
          </button>
          <div id="qr-file-reader" className="hidden" />
        </>
      )}

      <div className="mb-3 flex items-center gap-3">
        <div className="h-px flex-1 bg-stone-200" />
        <span className="text-xs font-medium uppercase tracking-wide text-stone-400">
          or choose by location
        </span>
        <div className="h-px flex-1 bg-stone-200" />
      </div>

      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
        Landmark
      </label>
      <select
        value={landmarkId}
        onChange={(e) => setLandmarkId(e.target.value)}
        className="mb-4 w-full rounded-lg border border-stone-300 bg-white px-3.5 py-3 text-sm shadow-sm"
      >
        <option value="">Select a landmark…</option>
        {landmarks.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>

      {loadingShops && <p className="text-sm text-stone-500">Loading shops…</p>}

      {!loadingShops && landmarkId && shops.length === 0 && (
        <p className="text-sm text-stone-500">No shops registered near this landmark yet.</p>
      )}

      <div className="space-y-2">
        {shops.map((s) => (
          <button type="button"
            key={s.shopId}
            onClick={() => onShopSelected(s.shopId)}
            className="flex w-full items-center justify-between rounded-lg border border-stone-300 bg-white px-3.5 py-3.5 text-left text-sm shadow-sm active:bg-stone-50"
          >
            <span className="font-medium text-stone-800">{s.name}</span>
            <span className="text-stone-400">→</span>
          </button>
        ))}
      </div>

      <button type="button"
        onClick={onMyOrders}
        className="mt-6 flex w-full items-center justify-center gap-1.5 text-sm font-medium text-stone-500 underline decoration-stone-300 underline-offset-2"
      >
        📋 My Orders
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root app
// ---------------------------------------------------------------------------
function makeDefaultOrderForm() {
  return {
    file: null,
    pages: "",
    detectedPages: null,
    copies: 1,
    sides: "single",
    colorMode: "bw",
    colorPages: "",
    phone: "",
  };
}

export default function App() {
  const shopIdParam = getParam("shopId");
  const initialJobId = getParam("jobId");

  const [shopId, setShopId] = useState(shopIdParam);
  const [phase, setPhase] = useState(
    initialJobId ? "status" : shopIdParam ? "upload" : "home"
  );
  const [jobId, setJobId] = useState(initialJobId);
  const [amountDue, setAmountDue] = useState(null);
  const [shopName, setShopName] = useState(null);
  const [order, setOrder] = useState(null);
  // The live upload form's own state, lifted up here (rather than kept
  // inside UploadStep) specifically so "← Back to edit order" from the
  // Review step doesn't lose what the student already filled in - the
  // chosen file, page count, copies, etc. all survive the round trip.
  const [orderForm, setOrderForm] = useState(makeDefaultOrderForm);

  useEffect(() => {
    if (initialJobId) {
      api.getJob(initialJobId).then((j) => setShopName(j.shopName)).catch(() => {});
    }
  }, [initialJobId]);

  // Header reads shopName from here, but until now nothing set it when a
  // shop was chosen via scan/upload/list/direct link - it only got set
  // later, after a job existed. That's why the header was stuck on
  // "Loading shop..." right after picking a shop. UploadStep already
  // fetches shop info separately for its own pricing display; this just
  // makes sure the header's copy of the name gets filled in too.
  useEffect(() => {
    if (!shopId) return;
    let cancelled = false;
    api
      .getShopPublicInfo(shopId)
      .then((info) => {
        if (!cancelled && info?.name) setShopName(info.name);
      })
      .catch(() => {
        // Non-fatal: header just keeps showing "Loading shop..." if this fails.
      });
    return () => {
      cancelled = true;
    };
  }, [shopId]);

  // Give the very first screen a history entry to land on. Without this,
  // the first Back press (before any phase change ever pushed an entry)
  // still walks the browser out of the app instead of back to "home".
  useEffect(() => {
    window.history.replaceState(
      { phase, shopId: shopIdParam, jobId: initialJobId },
      "",
      window.location.href
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser / hardware Back button: restore whichever phase was pushed,
  // entirely in React state - no network round trip, no page reload.
  useEffect(() => {
    function handlePopState(e) {
      const s = e.state || {};
      setPhase(s.phase || "home");
      setShopId(s.shopId || null);
      setJobId(s.jobId || null);
      if (!s.shopId) setShopName(null);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function handleShopSelected(id) {
    setShopId(id);
    setPhase("upload");
    pushPhase("upload", { shopId: id });
  }

  // Item #3 — "My Orders" entry point from the home screen.
  function handleOpenMyOrders() {
    setPhase("myorders");
    pushPhase("myorders", {});
  }

  // Opening a job from order history: unlike handleOpenRecent (same shop
  // the student is already ordering from), this can jump to a job that
  // belongs to a completely different shop, so shopId/shopName both need
  // to be set fresh here.
  function handleOpenHistoryJob(id, historyShopId) {
    setShopId(historyShopId || null);
    setJobId(id);
    setPhase("status");
    pushPhase("status", { shopId: historyShopId, jobId: id });
    api.getJob(id).then((j) => setShopName(j.shopName)).catch(() => {});
  }

  function handleChangeShop() {
    setShopId(null);
    setShopName(null);
    setOrderForm(makeDefaultOrderForm()); // starting over with a different shop - clear the form too
    setPhase("home");
    pushPhase("home", {});
  }

  function handleJobCreated(newJobId, orderSummary) {
    setJobId(newJobId);
    setOrder(orderSummary);
    rememberJob(newJobId, shopId, orderSummary.fileName);
    setPhase("review");
    pushPhase("review", { shopId, jobId: newJobId });
    api.getJob(newJobId).then((j) => {
      setAmountDue(j.amountDue);
      setShopName(j.shopName);
    });
  }

  // Going back from Review re-opens Upload with everything the student
  // already entered still in place (orderForm is untouched). Known gap,
  // flagged rather than hidden: the job created just before Review was
  // shown already exists server-side in "uploaded" status - going back
  // doesn't cancel it, it's simply left unpaid and never queued. Same
  // category as an abandoned cart; nothing prints or charges from it.
  function handleBackFromReview() {
    setPhase("upload");
    pushPhase("upload", { shopId });
  }

  function handlePaid() {
    setPhase("status");
    pushPhase("status", { shopId, jobId });
  }

  function handleOpenRecent(id) {
    setJobId(id);
    setPhase("status");
    pushPhase("status", { shopId, jobId: id });
  }

  // New: the status page previously had no way back at all except leaving
  // the SPA. This resets everything and returns cleanly to "home".
  function handleBackToHome() {
    setShopId(null);
    setShopName(null);
    setJobId(null);
    setOrder(null);
    setAmountDue(null);
    setOrderForm(makeDefaultOrderForm());
    setPhase("home");
    pushPhase("home", {});
  }

  const stepNumber = phase === "upload" ? 1 : phase === "review" ? 2 : 3;

  return (
    <div
      className="mx-auto min-h-screen max-w-md px-4 py-6 font-sans sm:max-w-lg"
      style={{
        background:
          "#FAF6EE radial-gradient(circle, #EDE6D6 1px, transparent 1px) 0 0/16px 16px",
      }}
    >
      {phase === "home" && (
        <HomeStep onShopSelected={handleShopSelected} onMyOrders={handleOpenMyOrders} />
      )}
      {phase === "myorders" && <MyOrdersStep onOpenJob={handleOpenHistoryJob} onBack={handleBackToHome} />}
      {phase !== "home" && phase !== "myorders" && <Header shopName={shopName} />}
      {phase !== "home" && phase !== "myorders" && <Stepper currentStep={stepNumber} />}
      {phase === "upload" && (
        <UploadStep
          shopId={shopId}
          order={orderForm}
          setOrder={setOrderForm}
          onJobCreated={handleJobCreated}
          onOpenRecent={handleOpenRecent}
          onBack={handleChangeShop}
        />
      )}
      {phase === "review" && jobId && (
        <ReviewPaymentStep
          jobId={jobId}
          amountDue={amountDue}
          order={order}
          onPaid={handlePaid}
          onBack={handleBackFromReview}
        />
      )}
      {phase === "status" && jobId && <StatusStep jobId={jobId} onBack={handleBackToHome} />}
      <p className="mt-8 text-center text-[11px] text-stone-400">
        {MOCK_MODE ? "Running in mock mode — no real backend connected yet." : ""}
      </p>
    </div>
  );
}
