import React, { useState, useEffect, useCallback, useRef } from "react";
import { Html5Qrcode } from "html5-qrcode";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocument } from "pdf-lib";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// Reads a PDF's actual page count client-side (no server round trip) so the
// "Pages" field can default to - and be capped at - the real number instead
// of trusting whatever the student happens to type, and renders a small
// preview image of the first page so a document card shows roughly what's
// about to print rather than just a filename. One parse does both, since
// pdfjs only needs to load the file once for either. If the file turns out
// not to be a well-formed PDF (or parsing/rendering fails for any other
// reason), page count and/or thumbnail come back null rather than
// throwing - the caller falls back to manual page entry and no preview
// image, so a slightly unusual PDF never blocks someone from ordering a
// print.
async function analyzePdf(file) {
  try {
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const numPages = pdf.numPages;

    let thumbnailUrl = null;
    try {
      const page = await pdf.getPage(1);
      const unscaledViewport = page.getViewport({ scale: 1 });
      // A thumbnail, not a full-resolution page - 320px wide is plenty to
      // recognize "yes, that's my assignment" at a glance.
      const targetWidth = 320;
      const viewport = page.getViewport({ scale: targetWidth / unscaledViewport.width });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      thumbnailUrl = canvas.toDataURL("image/png");
    } catch (err) {
      // Page count above still succeeded even if the render step failed -
      // keep going with no thumbnail rather than losing the count too.
    }

    return { numPages, thumbnailUrl };
  } catch (err) {
    return { numPages: null, thumbnailUrl: null };
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

// Runs the same docx-conversion / image-to-PDF / page-detection pipeline
// UploadStep always ran for its single file, but as a standalone function so
// it can be called once per document when a student adds several files at
// once. Throws with a user-facing message on failure; caller decides how to
// surface it (which document card gets the error).
// Matches the server's own limit (see module3-backend/src/routes/uploads.js
// and routes/convert.js MAX_*_BYTES) - checked here too so an oversized
// file is rejected instantly with a clear message, instead of only being
// discovered after a slow upload attempt fails with a confusing raw
// network error.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

async function processChosenFile(chosenFile, uploadFlags) {
  if (chosenFile.size > MAX_UPLOAD_BYTES) {
    const sizeMb = (chosenFile.size / (1024 * 1024)).toFixed(1);
    throw new Error(`That file is ${sizeMb}MB - please choose a file under 50MB.`);
  }

  let fileToUse = chosenFile;
  const isDocx =
    chosenFile.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/i.test(chosenFile.name);
  const isImage = chosenFile.type === "image/jpeg" || chosenFile.type === "image/png";

  // Enforced here too (not just via the file input's `accept` attribute),
  // since accept is only a picker hint - drag-and-drop, a stale cached
  // page, or just renaming a file's extension can all still hand this
  // function a type the admin has turned off.
  if (isDocx && !uploadFlags?.docxConversionEnabled) {
    throw new Error("Word document upload is currently unavailable. Please upload a PDF instead.");
  }
  if (isImage && !uploadFlags?.imageConversionEnabled) {
    throw new Error("Photo upload is currently unavailable. Please upload a PDF instead.");
  }

  if (isDocx) {
    try {
      fileToUse = await api.convertDocxToPdf(chosenFile);
    } catch (err) {
      throw new Error(err.message || "Could not convert that document. Try saving it as a PDF instead.");
    }
  } else if (isImage) {
    try {
      fileToUse = await imageFileToPdfFile(chosenFile);
    } catch (err) {
      throw new Error("Could not process that photo. Try a different photo, or choose a PDF instead.");
    }
  }

  const { numPages: detectedPages, thumbnailUrl } = await analyzePdf(fileToUse);
  return { file: fileToUse, detectedPages, thumbnailUrl };
}

let docIdCounter = 0;
function makeDocId() {
  docIdCounter += 1;
  return `doc_${Date.now()}_${docIdCounter}`;
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

// Loaded lazily (not a static <script> tag in index.html) since most
// sessions won't necessarily use online payment - no reason to pull this
// in on every single page load. Cached as a module-level promise so
// picking "Pay online" twice in one session doesn't inject the script twice.
let razorpayScriptPromise = null;
function loadRazorpayScript() {
  if (window.Razorpay) return Promise.resolve();
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve();
      script.onerror = () => {
        razorpayScriptPromise = null; // allow retry on a later attempt
        reject(new Error("Could not load the payment gateway. Check your connection and try again."));
      };
      document.body.appendChild(script);
    });
  }
  return razorpayScriptPromise;
}

const RATE_PER_PAGE = { bw: 2, color: 8 }; // INR — client-side ESTIMATE only.
// The authoritative amountDue always comes back from POST /jobs and is what
// we actually charge at the review step.

const STATUS_STEPS = ["uploaded", "payment_pending", "queued", "printing", "ready", "collected"];
const STATUS_STEP_LABELS = {
  uploaded: "Uploaded",
  payment_pending: "Payment pending",
  queued: "Queued",
  printing: "Printing",
  ready: "Ready",
  collected: "Collected",
};
// How long a live QR scan counts as proof the student is physically at the
// shop, for gating the cash-at-counter payment option in ReviewPaymentStep -
// long enough to walk through upload/settings, short enough that the same
// scan can't be reused across a later, remote order.
const QR_SCAN_FRESHNESS_MS = 20 * 60 * 1000;
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
const mockStudents = new Map(); // phone -> name, mirrors the backend's `students` table
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Mirrors module3-backend/src/studentName.js: first order for a phone
// number requires a name and remembers it; every order after that reuses
// the name on file regardless of what's passed in.
function resolveMockStudentName(phone, providedName) {
  if (mockStudents.has(phone)) return mockStudents.get(phone);
  const trimmed = typeof providedName === "string" ? providedName.trim() : "";
  if (!trimmed) {
    const err = new Error("This is your first order — please provide your name");
    err.code = "STUDENT_NAME_REQUIRED";
    throw err;
  }
  mockStudents.set(phone, trimmed);
  return trimmed;
}

const MOCK_LANDMARKS = [{ id: "lm_anurag_university", name: "Anurag University" }];
const MOCK_SHOPS_BY_LANDMARK = {
  lm_anurag_university: [
    { shopId: "demo-shop", name: "Sharma Xerox & Print Center", avgRating: 4.6, reviewCount: 28 },
    { shopId: "demo-shop-2", name: "Campus Copy Point", avgRating: 0, reviewCount: 0 },
  ],
};
const MOCK_SHOP_PUBLIC_INFO = {
  "demo-shop": {
    shopId: "demo-shop",
    name: "Sharma Xerox & Print Center",
    priceBw: 2,
    priceColor: 10,
    maxPagesPerHour: 500,
    upiId: "sharmaxerox@okhdfcbank",
  },
  "demo-shop-2": {
    shopId: "demo-shop-2",
    name: "Campus Copy Point",
    priceBw: 3,
    priceColor: 12,
    maxPagesPerHour: null,
    upiId: null,
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
  async checkStudent(phone) {
    await delay(200);
    return mockStudents.has(phone) ? { phone, name: mockStudents.get(phone) } : null;
  },
  async getPlatformReviews() {
    await delay(300);
    return {
      reviews: [
        { id: "r1", rating: 5, comment: "Super fast, no queue at all.", authorName: "Priya S.", shopName: "Sharma Xerox & Print Center", createdAt: new Date(Date.now() - 86400000).toISOString() },
        { id: "r2", rating: 4, comment: "Good pricing for color prints.", authorName: "Arjun K.", shopName: "Sharma Xerox & Print Center", createdAt: new Date(Date.now() - 3 * 86400000).toISOString() },
        { id: "r3", rating: 5, comment: null, authorName: "Meena R.", shopName: "Campus Copy Point", createdAt: new Date(Date.now() - 5 * 86400000).toISOString() },
      ],
    };
  },
  async submitReview(shopId, { jobId, rating, comment }) {
    await delay(500);
    const job = mockDb.get(jobId);
    if (!job) throw new Error("Job not found");
    if (job.status === "uploaded" || job.status === "payment_pending") {
      throw new Error("This order needs to be paid and confirmed before it can be reviewed");
    }
    return {
      id: `review_${Date.now()}`,
      rating,
      comment: comment || null,
      authorName: job.studentName || "A student",
      createdAt: new Date().toISOString(),
    };
  },
  async createJob(shopId, body) {
    await delay(600);
    const studentName = resolveMockStudentName(body.studentPhone, body.studentName);
    const jobId = `job_${mockJobCounter++}`;
    const job = {
      jobId,
      shopId,
      shopName: MOCK_SHOP_PUBLIC_INFO[shopId]?.name || "Sharma Xerox & Print Center",
      shopUpiId: MOCK_SHOP_PUBLIC_INFO[shopId]?.upiId ?? null,
      status: "uploaded",
      amountDue: body.amountDueEstimate,
      tokenNumber: null,
      createdAt: new Date().toISOString(),
      ...body,
      studentName,
    };
    mockDb.set(jobId, job);
    return { jobId, amountDue: job.amountDue, status: "uploaded" };
  },
  // Real payment flow: student submits proof (UPI screenshot, or picks
  // cash-at-counter), status goes to "payment_pending" - no token minted
  // here. Mock mode has no separate shop-dashboard process to actually
  // press "confirm", so it simulates that confirmation happening ~5s later
  // (see getJob/getBatch below) - matches the old auto-progression timing
  // this replaced, just with an extra "payment_pending" stage up front.
  async submitPayment(kind, id, { method, screenshotUrl }) {
    await delay(600);
    const obj = mockDb.get(id);
    if (!obj) throw new Error("Order not found");
    obj.status = "payment_pending";
    obj.paymentMethod = method;
    obj.paymentScreenshotUrl = method === "upi" ? screenshotUrl : null;
    obj.paymentRejectionReason = null;
    obj.submittedAt = Date.now();
    if (obj.isBatch) {
      for (const jobId of obj.documentJobIds) {
        const job = mockDb.get(jobId);
        if (job) {
          job.status = "payment_pending";
          job.paymentMethod = method;
          job.paymentScreenshotUrl = obj.paymentScreenshotUrl;
        }
      }
    }
    return { [kind === "batch" ? "batchId" : "jobId"]: id, status: "payment_pending" };
  },
  async uploadPaymentScreenshot(file) {
    await delay(500);
    // No real storage in mock mode - a local blob URL is enough to preview
    // the exact image the student picked, right there in the same tab.
    return { screenshotUrl: URL.createObjectURL(file) };
  },
  // Mock mode has no real Razorpay account, so this returns a fake order id
  // rather than actually calling out - the UI still opens the real
  // Razorpay Checkout widget in test-friendly fashion since keyId is empty,
  // but treat this purely as a UI smoke test, not a real payment demo.
  async createRazorpayOrder(kind, id) {
    await delay(400);
    const obj = mockDb.get(id);
    if (!obj) throw new Error("Order not found");
    return {
      orderId: `order_mock_${Date.now()}`,
      amount: obj.amountDue * 100,
      currency: "INR",
      keyId: "",
      [kind === "batch" ? "batchId" : "jobId"]: id,
    };
  },
  async verifyRazorpayPayment(kind, id) {
    await delay(500);
    const obj = mockDb.get(id);
    if (!obj) throw new Error("Order not found");
    obj.status = "queued";
    obj.paymentMethod = "razorpay";
    obj.tokenNumber = obj.tokenNumber || String(Math.floor(100 + Math.random() * 800));
    if (obj.isBatch) {
      for (const jobId of obj.documentJobIds) {
        const job = mockDb.get(jobId);
        if (job) {
          job.status = "queued";
          job.paymentMethod = "razorpay";
          job.tokenNumber = obj.tokenNumber;
        }
      }
    }
    return { [kind === "batch" ? "batchId" : "jobId"]: id, status: "queued", tokenNumber: obj.tokenNumber };
  },
  // Mock mode has no admin panel writing real settings - always "no fee",
  // matching the platform's actual default.
  async getPaymentFees() {
    await delay(150);
    return {
      serviceFeePercent: 0,
      serviceFeeEnabled: false,
      serviceFeeTier1Flat: 1,
      serviceFeeTier2Flat: 1.5,
      gatewayFeePercent: 0,
      gatewayFeeEnabled: false,
      gatewayFeeTier1Flat: 1,
      gatewayFeeTier2Flat: 1.5,
    };
  },
  // Mock mode has no admin panel writing real settings, and no server-side
  // LibreOffice constraint to worry about either - both on, so the mock
  // demo shows every upload path working.
  async getUploadFlags() {
    await delay(150);
    return { docxConversionEnabled: true, imageConversionEnabled: true };
  },
  async getJob(jobId) {
    await delay(350);
    const job = mockDb.get(jobId);
    if (!job) throw new Error("Job not found");
    if (job.submittedAt) {
      const s = (Date.now() - job.submittedAt) / 1000;
      if (s > 5) {
        if (!job.tokenNumber) job.tokenNumber = String(Math.floor(100 + Math.random() * 800));
        job.status = s > 24 ? "ready" : s > 14 ? "printing" : "queued";
      }
    }
    return {
      jobId: job.jobId,
      status: job.status,
      tokenNumber: job.tokenNumber,
      shopName: job.shopName,
      shopUpiId: job.shopUpiId,
      amountDue: job.amountDue,
      createdAt: job.createdAt,
      paymentMethod: job.paymentMethod,
      paymentScreenshotUrl: job.paymentScreenshotUrl,
      paymentRejectionReason: job.paymentRejectionReason,
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
  // Multi-document upload: one combined payment/token for several documents,
  // each keeping its own pages/copies/color/sides. Mirrors createJob/submitPayment/
  // getJob's shape but for a batch - see the real backend's
  // routes/batches.js for the authoritative version this stands in for.
  async createBatch(shopId, body) {
    await delay(700);
    const studentName = resolveMockStudentName(body.studentPhone, body.studentName);
    const batchId = `batch_${mockJobCounter++}`;
    const shopUpiId = MOCK_SHOP_PUBLIC_INFO[shopId]?.upiId ?? null;
    const shopName = MOCK_SHOP_PUBLIC_INFO[shopId]?.name || "Sharma Xerox & Print Center";
    const documents = body.documents.map((doc) => {
      const jobId = `job_${mockJobCounter++}`;
      const job = {
        jobId,
        shopId,
        batchId,
        shopName,
        shopUpiId,
        status: "uploaded",
        amountDue: doc.amountDueEstimate,
        tokenNumber: null,
        createdAt: new Date().toISOString(),
        studentPhone: body.studentPhone,
        studentName,
        ...doc,
      };
      mockDb.set(jobId, job);
      return { jobId, fileName: doc.fileName, amountDue: job.amountDue };
    });
    const amountDue = documents.reduce((sum, d) => sum + d.amountDue, 0);
    mockDb.set(batchId, {
      batchId,
      isBatch: true,
      shopId,
      shopName,
      shopUpiId,
      status: "uploaded",
      amountDue,
      tokenNumber: null,
      documentJobIds: documents.map((d) => d.jobId),
      studentPhone: body.studentPhone,
      createdAt: new Date().toISOString(),
    });
    return { batchId, amountDue, status: "uploaded", documents };
  },
  async getBatch(batchId) {
    await delay(350);
    const batch = mockDb.get(batchId);
    if (!batch || !batch.isBatch) throw new Error("Batch not found");
    if (batch.submittedAt) {
      const s = (Date.now() - batch.submittedAt) / 1000;
      if (s > 5) {
        if (!batch.tokenNumber) batch.tokenNumber = String(Math.floor(100 + Math.random() * 800));
        batch.status = s > 24 ? "ready" : s > 14 ? "printing" : "queued";
        for (const jobId of batch.documentJobIds) {
          const job = mockDb.get(jobId);
          if (job) {
            job.status = batch.status;
            job.tokenNumber = batch.tokenNumber;
          }
        }
      }
    }
    const documents = batch.documentJobIds
      .map((jobId) => {
        const job = mockDb.get(jobId);
        return (
          job && {
            jobId: job.jobId,
            fileName: job.fileName,
            pages: job.pages,
            copies: job.copies,
            colorMode: job.colorMode,
            colorPages: job.colorPages,
            sides: job.sides,
            amountDue: job.amountDue,
            status: job.status,
          }
        );
      })
      .filter(Boolean);
    return {
      batchId: batch.batchId,
      status: batch.status,
      tokenNumber: batch.tokenNumber,
      shopName: batch.shopName,
      shopUpiId: batch.shopUpiId,
      amountDue: batch.amountDue,
      createdAt: batch.createdAt,
      paymentMethod: batch.paymentMethod,
      paymentScreenshotUrl: batch.paymentScreenshotUrl,
      paymentRejectionReason: batch.paymentRejectionReason,
      documents,
    };
  },
};

const realApi = {
  async getLandmarks() {
    const res = await fetch(`${API_BASE_URL}/api/landmarks`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not load landmarks");
    }
    return res.json();
  },
  async getShopsByLandmark(landmarkId) {
    const res = await fetch(`${API_BASE_URL}/api/shops?landmarkId=${encodeURIComponent(landmarkId)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not load shops");
    }
    return res.json();
  },
  async getShopPublicInfo(shopId) {
    const res = await fetch(`${API_BASE_URL}/api/shops/${shopId}/public`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not load this shop's pricing");
    }
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
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || "Could not create job");
    }
    return res.json();
  },
  // kind: "job" | "batch". Records the student's payment claim (UPI
  // screenshot, or cash-at-counter) - status moves to "payment_pending" but
  // no token is minted here. See routes/jobs.js and routes/batches.js'
  // submit-payment/confirm-payment/reject-payment for the full flow.
  async submitPayment(kind, id, { method, screenshotUrl }) {
    const path = kind === "batch" ? `/api/batches/${id}/submit-payment` : `/api/jobs/${id}/submit-payment`;
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, screenshotUrl }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not submit payment");
    }
    return res.json(); // { jobId/batchId, status: "payment_pending" }
  },
  async uploadPaymentScreenshot(file) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE_URL}/api/uploads/payment-screenshot`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not upload that screenshot");
    }
    return res.json(); // { screenshotUrl }
  },
  // kind: "job" | "batch". Opens a Razorpay order for the order's own
  // amount_due (server decides the amount, never the client). This is the
  // gateway-payment path: unlike submitPayment above it never touches
  // "payment_pending" - a verified Razorpay payment goes straight to
  // "queued" via verifyRazorpayPayment below.
  async createRazorpayOrder(kind, id) {
    const path = kind === "batch" ? `/api/batches/${id}/razorpay/create-order` : `/api/jobs/${id}/razorpay/create-order`;
    const res = await fetch(`${API_BASE_URL}${path}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not start online payment");
    }
    return res.json(); // { orderId, amount, currency, keyId, jobId/batchId }
  },
  async verifyRazorpayPayment(kind, id, { razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
    const path = kind === "batch" ? `/api/batches/${id}/razorpay/verify` : `/api/jobs/${id}/razorpay/verify`;
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ razorpayOrderId, razorpayPaymentId, razorpaySignature }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Payment could not be verified");
    }
    return res.json(); // { jobId/batchId, status: "queued", tokenNumber }
  },
  // Public, no auth - admin-editable fee settings (see admin panel's
  // Settings tab). Read before opening checkout so the "Pay online" button
  // can show the real total, rather than surprising the student mid-payment.
  async getPaymentFees() {
    const res = await fetch(`${API_BASE_URL}/api/settings/payment-fees`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not load payment fee settings");
    }
    return res.json(); // { serviceFeePercent, serviceFeeEnabled, gatewayFeePercent, gatewayFeeEnabled }
  },
  // Public, no auth - admin-editable (see admin panel's Settings tab).
  // Controls whether the upload picker offers .docx / photo files at all -
  // read once when the upload screen loads.
  async getUploadFlags() {
    const res = await fetch(`${API_BASE_URL}/api/settings/upload-flags`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not load upload settings");
    }
    return res.json(); // { docxConversionEnabled, imageConversionEnabled }
  },
  async getJob(jobId) {
    const res = await fetch(`${API_BASE_URL}/api/jobs/${jobId}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not fetch job");
    }
    return res.json();
  },
  // Whether this phone number has ordered before anywhere - determines if
  // UploadStep needs to ask for a name (see src/routes/students.js).
  // Returns null for a brand-new number rather than throwing, since "not
  // found" is an expected, normal outcome here (most first-time phone
  // numbers), not an error condition.
  async checkStudent(phone) {
    const res = await fetch(`${API_BASE_URL}/api/students/${encodeURIComponent(phone)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not check phone number");
    }
    return res.json(); // { phone, name }
  },
  // Optional review after an order is confirmed - see routes/shops.js
  // POST /:shopId/reviews. jobId can be any one document's job id even for
  // a batch order (see that route's comment).
  async submitReview(shopId, { jobId, rating, comment }) {
    const res = await fetch(`${API_BASE_URL}/api/shops/${shopId}/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, rating, comment }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not submit your review");
    }
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
  // Platform-wide review feed for the front page ("What students are
  // saying") - see routes/reviews.js. Distinct from a single shop's own
  // reviews, which power its star rating in the browse list.
  async getPlatformReviews() {
    const res = await fetch(`${API_BASE_URL}/api/reviews`);
    if (!res.ok) throw new Error("Could not load reviews");
    return res.json(); // { reviews: [...] }
  },
  // Multi-document upload — see module3-backend/src/routes/batches.js.
  async createBatch(shopId, body) {
    const res = await fetch(`${API_BASE_URL}/api/shops/${shopId}/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || "Could not create order");
    }
    return res.json(); // { batchId, amountDue, status, documents }
  },
  async getBatch(batchId) {
    const res = await fetch(`${API_BASE_URL}/api/batches/${batchId}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not fetch order");
    }
    return res.json(); // { batchId, status, tokenNumber, shopName, shopUpiId, amountDue, createdAt, paymentMethod, paymentScreenshotUrl, paymentRejectionReason, documents }
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
function pushPhase(phase, { shopId, jobId, batchId } = {}) {
  const url = new URL(window.location.href);
  shopId ? url.searchParams.set("shopId", shopId) : url.searchParams.delete("shopId");
  jobId ? url.searchParams.set("jobId", jobId) : url.searchParams.delete("jobId");
  batchId ? url.searchParams.set("batchId", batchId) : url.searchParams.delete("batchId");
  window.history.pushState(
    { phase, shopId: shopId || null, jobId: jobId || null, batchId: batchId || null },
    "",
    url.toString()
  );
}
// kind: "job" | "batch" — a batch is a multi-document order, id is its
// batchId. Stored under the same localStorage key as before (back-compat:
// old entries have `jobId` but no `kind`/`id`; getRecentJobs() below
// normalizes both shapes to { id, kind }).
function rememberOrder(id, shopId, label, kind = "job") {
  try {
    const raw = window.localStorage.getItem("printq_jobs");
    const jobs = raw ? JSON.parse(raw) : [];
    const filtered = jobs.filter((j) => (j.id || j.jobId) !== id);
    filtered.unshift({ id, shopId, label, kind, savedAt: Date.now() });
    window.localStorage.setItem("printq_jobs", JSON.stringify(filtered.slice(0, 6)));
  } catch (e) {
    // localStorage unavailable — non-fatal
  }
}
function getRecentJobs() {
  try {
    const raw = window.localStorage.getItem("printq_jobs");
    const jobs = raw ? JSON.parse(raw) : [];
    return jobs.map((j) => ({
      id: j.id || j.jobId,
      shopId: j.shopId,
      label: j.label,
      kind: j.kind || "job",
    }));
  } catch (e) {
    return [];
  }
}
// There's no backend "has this order already been reviewed" check exposed
// to the student app (the backend does still enforce one-review-per-job
// itself, so this is just about not showing the prompt again locally, not
// the actual duplicate guard) - a small localStorage set of order ids is
// enough for that.
function hasReviewedLocally(orderId) {
  try {
    const raw = window.localStorage.getItem("printq_reviewed");
    const ids = raw ? JSON.parse(raw) : [];
    return ids.includes(orderId);
  } catch (e) {
    return false;
  }
}
function markReviewedLocally(orderId) {
  try {
    const raw = window.localStorage.getItem("printq_reviewed");
    const ids = raw ? JSON.parse(raw) : [];
    if (!ids.includes(orderId)) {
      window.localStorage.setItem("printq_reviewed", JSON.stringify([...ids, orderId].slice(-50)));
    }
  } catch (e) {
    // non-fatal
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
            key={j.id}
            onClick={() => onOpen(j.id, j.kind, j.shopId)}
            className="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 active:bg-stone-50"
          >
            {j.label || j.id}
          </button>
        ))}
      </div>
    </div>
  );
}

function makeDefaultDocument() {
  return {
    id: makeDocId(),
    file: null,
    fileName: "",
    pages: "",
    detectedPages: null,
    copies: 1,
    sides: "single",
    colorMode: "bw",
    colorPages: "",
    thumbnailUrl: null, // small first-page preview image (data URL) for PDFs
    previewUrl: null, // object URL of the actual file, for the full preview modal
  };
}

// Derives pagesNum/colorPageCount/rangeError/estimate for one document -
// shared between DocumentSettingsCard (per-doc display) and UploadStep
// (total estimate, submit validation).
function deriveDocument(doc, rates) {
  const pagesNum = parseInt(doc.pages, 10) || 0;
  const rangeResult =
    doc.colorMode === "mixed" && pagesNum > 0 ? parsePageRange(doc.colorPages, pagesNum) : null;
  const colorPageCount = rangeResult ? rangeResult.pages.size : 0;
  const rangeError = doc.colorMode === "mixed" && doc.colorPages.trim() ? rangeResult?.error : null;
  const estimate =
    pagesNum > 0
      ? computeEstimate({ pages: pagesNum, copies: doc.copies, colorMode: doc.colorMode, colorPageCount, rates })
      : 0;
  return { pagesNum, colorPageCount, rangeError, estimate };
}

// One document's settings card within the multi-file upload flow - pages,
// copies, sides, color mode/pages, plus a per-document price and a remove
// button. Identical field set to what UploadStep used to render once for
// its single file; now rendered once per document. Also shows a thumbnail
// of the first page (tap to open a full preview) so a student can confirm
// "yes, that's the right file" before paying, not just read a filename.
function DocumentSettingsCard({ doc, index, shopInfo, onChange, onRemove, showRemove }) {
  const { pagesNum, colorPageCount, rangeError, estimate } = deriveDocument(
    doc,
    shopInfo ? { bw: shopInfo.priceBw, color: shopInfo.priceColor } : null
  );
  const [previewOpen, setPreviewOpen] = useState(false);

  function handlePagesChange(e) {
    let n = parseInt(e.target.value, 10) || 0;
    if (doc.detectedPages && n > doc.detectedPages) n = doc.detectedPages;
    onChange({ pages: n ? String(n) : "" });
  }

  return (
    <div className="rounded-lg border border-stone-300 bg-white px-3.5 py-3.5 shadow-sm shadow-stone-900/[0.03]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {doc.thumbnailUrl ? (
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              className="shrink-0 overflow-hidden rounded-md border border-stone-200 active:opacity-80"
              aria-label={`Preview ${doc.fileName}`}
            >
              <img
                src={doc.thumbnailUrl}
                alt=""
                className="h-16 w-12 object-cover object-top"
              />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => doc.previewUrl && setPreviewOpen(true)}
              disabled={!doc.previewUrl}
              className="flex h-16 w-12 shrink-0 items-center justify-center rounded-md border border-stone-200 bg-stone-50 text-[9px] font-medium uppercase tracking-wide text-stone-400"
              aria-label={`Preview ${doc.fileName}`}
            >
              PDF
            </button>
          )}
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
              Document {index + 1}
            </p>
            <p className="truncate text-sm font-medium text-stone-900">{doc.fileName}</p>
            {doc.previewUrl && (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="mt-0.5 text-[11px] font-medium text-[#2F6E68] underline"
              >
                Preview
              </button>
            )}
          </div>
        </div>
        {showRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-stone-500 hover:bg-stone-100 hover:text-red-700"
          >
            Remove
          </button>
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
            max={doc.detectedPages || undefined}
            value={doc.pages}
            onChange={handlePagesChange}
            placeholder="e.g. 12"
            className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm shadow-sm shadow-stone-900/[0.03] focus:border-stone-500 focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-stone-500">
            {doc.detectedPages
              ? `Detected ${doc.detectedPages} page${doc.detectedPages > 1 ? "s" : ""} — reduce if you only need some.`
              : "Couldn't auto-detect page count — enter it manually."}
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
            value={doc.copies}
            onChange={(e) => onChange({ copies: Math.max(1, parseInt(e.target.value, 10) || 1) })}
            className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm shadow-sm shadow-stone-900/[0.03] focus:border-stone-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="mt-3">
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
              onClick={() => onChange({ sides: opt.v })}
              className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                doc.sides === opt.v
                  ? "border-stone-900 bg-stone-900 text-stone-50"
                  : "border-stone-300 bg-white text-stone-600"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
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
              onClick={() => onChange({ colorMode: opt.v })}
              className={`rounded-lg border px-2 py-2.5 text-[13px] font-medium transition ${
                doc.colorMode === opt.v
                  ? "border-stone-900 bg-stone-900 text-stone-50"
                  : "border-stone-300 bg-white text-stone-600"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {doc.colorMode === "mixed" && (
          <div className="mt-2.5 rounded-lg border border-dashed border-[#2F6E68]/40 bg-[#2F6E68]/5 px-3.5 py-3">
            <label className="mb-1 block text-xs font-medium text-stone-600">
              Which pages should print in color?
            </label>
            <input
              type="text"
              value={doc.colorPages}
              onChange={(e) => onChange({ colorPages: e.target.value })}
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

      {pagesNum > 0 && (
        <div className="mt-3 flex items-center justify-between border-t border-dashed border-stone-200 pt-2.5 text-sm">
          <span className="text-stone-500">This document</span>
          <span className="font-mono font-semibold text-stone-900">₹{estimate}</span>
        </div>
      )}

      {previewOpen && doc.previewUrl && (
        <DocumentPreviewModal
          fileUrl={doc.previewUrl}
          fileName={doc.fileName}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}

// Full-size look at the actual PDF being ordered - opened by tapping a
// document's thumbnail or "Preview" link. Renders via <iframe> pointed at
// the file's own object URL: every mobile and desktop browser already has
// a built-in PDF viewer for this (pinch-zoom, scroll through every page,
// etc.), so this needs no PDF-rendering logic of its own - just get out of
// the way and let the browser do what it already does well.
function DocumentPreviewModal({ fileUrl, fileName, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/60"
      onClick={onClose}
    >
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <p className="min-w-0 truncate text-sm font-medium">{fileName}</p>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium active:bg-white/20"
        >
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1 px-2 pb-2 sm:px-6 sm:pb-6" onClick={(e) => e.stopPropagation()}>
        <iframe
          src={fileUrl}
          title={fileName}
          className="h-full w-full rounded-lg bg-white"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Upload + print settings + estimate
// ---------------------------------------------------------------------------
function UploadStep({ shopId, order, setOrder, onOrderCreated, onOpenRecent, onBack }) {
  const { documents, phone, name } = order;
  const [addingFile, setAddingFile] = useState(false);
  // Files that were selected but couldn't be added (wrong type currently
  // disabled by the admin, too large, corrupt, etc.) - kept separate from
  // `documents` (which only ever holds successfully processed files, so
  // handleSubmit/deriveDocument never need to special-case a broken entry)
  // and shown as their own small dismissible cards, so a mistaken
  // selection is visible and removable rather than vanishing into a
  // single top-of-form error message.
  const [failedFiles, setFailedFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [shopInfo, setShopInfo] = useState(null);
  const [uploadFlags, setUploadFlags] = useState({
    docxConversionEnabled: false,
    imageConversionEnabled: true,
  });
  const fileInputRef = useRef(null);

  // Admin-editable (see admin panel's Settings tab) - controls whether this
  // screen offers .docx / photo uploads. Fetched once on load; falls back
  // to "docx off, image on" (the platform's real defaults) if this fails,
  // rather than blocking the upload screen over a settings-read error.
  useEffect(() => {
    let cancelled = false;
    api
      .getUploadFlags()
      .then((flags) => {
        if (!cancelled) setUploadFlags(flags);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  // Name capture: once the phone number is a valid 10 digits, check whether
  // it's ordered before anywhere (see api.checkStudent / GET
  // /api/students/:phone) - a known number shows a friendly "welcome back"
  // note and skips asking for a name entirely; a new number requires one
  // before it can submit. checkedPhone tracks which phone number the result
  // below actually belongs to, so a fast typist can't slip past the check
  // with a stale result from a previous number still cached in state.
  const [checkingPhone, setCheckingPhone] = useState(false);
  const [checkedPhone, setCheckedPhone] = useState(null);
  const [knownName, setKnownName] = useState(null); // string | null - null means "checked, and it's new"

  useEffect(() => {
    const trimmed = phone.trim();
    if (!/^[6-9]\d{9}$/.test(trimmed)) {
      setCheckedPhone(null);
      setKnownName(null);
      return;
    }
    let cancelled = false;
    setCheckingPhone(true);
    const t = setTimeout(() => {
      api
        .checkStudent(trimmed)
        .then((result) => {
          if (cancelled) return;
          setKnownName(result?.name || null);
          setCheckedPhone(trimmed);
        })
        .catch(() => {
          if (!cancelled) {
            // Couldn't check - fail safe by treating as "new", so the name
            // field appears rather than silently letting a nameless order
            // through.
            setKnownName(null);
            setCheckedPhone(trimmed);
          }
        })
        .finally(() => {
          if (!cancelled) setCheckingPhone(false);
        });
    }, 400); // debounce - avoid a request per keystroke while typing the number
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [phone]);

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

  function patchDoc(id, fields) {
    setOrder((prev) => ({
      ...prev,
      documents: prev.documents.map((d) => (d.id === id ? { ...d, ...fields } : d)),
    }));
  }

  function removeDoc(id) {
    setOrder((prev) => {
      const removed = prev.documents.find((d) => d.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return { ...prev, documents: prev.documents.filter((d) => d.id !== id) };
    });
  }

  // Adds one or more documents to the order in one go - each file gets
  // processed (docx/photo -> PDF, page count + thumbnail detected), then
  // joins the list with its own default settings. Runs sequentially rather
  // than in parallel: pdfjs rendering is memory-heavy enough that firing
  // off many at once on a budget phone risks stalling or crashing the tab,
  // and sequential also means documents appear in the card list in the
  // same order the student picked them, one by one, rather than in
  // whatever order finished processing first.
  async function handleFilesChosen(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setAddingFile(true);
    try {
      for (const chosenFile of files) {
        try {
          const { file, detectedPages, thumbnailUrl } = await processChosenFile(chosenFile, uploadFlags);
          const newDoc = {
            ...makeDefaultDocument(),
            file,
            fileName: file.name,
            detectedPages,
            pages: detectedPages ? String(detectedPages) : "",
            thumbnailUrl,
            // Object URL of the actual (post-conversion) PDF - used for the
            // "view full document" preview modal. Kept alongside the file
            // itself for the whole document's lifetime in this order; see
            // the cleanup effect below that revokes these on unmount.
            previewUrl: URL.createObjectURL(file),
          };
          setOrder((prev) => ({ ...prev, documents: [...prev.documents, newDoc] }));
        } catch (err) {
          // One bad file (wrong type currently disabled, too large,
          // corrupt, etc.) shouldn't stop the rest of a multi-file
          // selection from being added - it becomes its own dismissible
          // card instead (see failedFiles below), and the rest continue.
          setFailedFiles((prev) => [
            ...prev,
            {
              id: makeDocId(),
              fileName: chosenFile.name,
              error: err.message || "Could not process that file.",
            },
          ]);
        }
      }
    } finally {
      setAddingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeFailedFile(id) {
    setFailedFiles((prev) => prev.filter((f) => f.id !== id));
  }

  const rates = shopInfo ? { bw: shopInfo.priceBw, color: shopInfo.priceColor } : null;
  const derivedDocs = documents.map((d) => deriveDocument(d, rates));
  const totalEstimate = derivedDocs.reduce((sum, d) => sum + d.estimate, 0);

  const allDocsValid =
    documents.length > 0 &&
    documents.every((d, i) => {
      const { pagesNum, rangeError } = derivedDocs[i];
      return d.file && pagesNum > 0 && d.copies > 0 && (d.colorMode !== "mixed" || (d.colorPages.trim() && !rangeError));
    });

  const phoneValid = /^[6-9]\d{9}$/.test(phone.trim());
  const phoneChecked = phoneValid && checkedPhone === phone.trim();
  const isNewNumber = phoneChecked && !knownName;
  const resolvedName = knownName || name.trim();

  const canSubmit =
    allDocsValid &&
    phoneValid &&
    phoneChecked &&
    !checkingPhone &&
    (!isNewNumber || name.trim()) &&
    !submitting &&
    !addingFile;

  async function handleSubmit() {
    setSubmitError(null);
    setSubmitting(true);
    try {
      // Upload every document's file first, keeping each one's own settings
      // alongside the fileUrl it gets back.
      const uploaded = [];
      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        const { pagesNum, estimate } = derivedDocs[i];
        const { fileUrl } = await api.uploadFile(doc.file);
        uploaded.push({
          fileUrl,
          fileName: doc.fileName,
          pages: pagesNum,
          copies: doc.copies,
          colorMode: doc.colorMode,
          sides: doc.sides, // ⚠️ beyond locked contract — see file header
          amountDueEstimate: estimate,
          ...(doc.colorMode === "mixed" ? { colorPages: doc.colorPages.trim() } : {}), // ⚠️ beyond locked contract
        });
      }

      const summaryDocs = uploaded.map((u) => ({
        fileName: u.fileName,
        pages: u.pages,
        copies: u.copies,
        sides: u.sides,
        colorMode: u.colorMode,
        colorPages: u.colorPages || null,
      }));

      if (uploaded.length === 1) {
        const single = uploaded[0];
        const job = await api.createJob(shopId, {
          ...single,
          studentPhone: phone.trim(),
          studentName: resolvedName,
        });
        onOrderCreated("job", job.jobId, { documents: summaryDocs, phone: phone.trim() });
      } else {
        const result = await api.createBatch(shopId, {
          studentPhone: phone.trim(),
          studentName: resolvedName,
          documents: uploaded,
        });
        onOrderCreated("batch", result.batchId, { documents: summaryDocs, phone: phone.trim() });
      }
    } catch (e) {
      setSubmitError(e.message || "Upload failed. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // What the file picker actually offers, driven by the admin's upload
  // flags (see admin panel's Settings tab) - PDF is always available since
  // it needs no conversion at all. docx defaults off (needs LibreOffice on
  // the server, Docker-only - see routes/convert.js); photos default on
  // (converted entirely client-side, works regardless of hosting).
  const acceptedMimeTypes = ["application/pdf"];
  const acceptedLabelParts = ["PDF"];
  if (uploadFlags.docxConversionEnabled) {
    acceptedMimeTypes.push(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".docx"
    );
    acceptedLabelParts.push("Word doc");
  }
  if (uploadFlags.imageConversionEnabled) {
    acceptedMimeTypes.push("image/jpeg", "image/png");
    acceptedLabelParts.push("photo");
  }
  const acceptedFileTypes = acceptedMimeTypes.join(",");
  const acceptedTypesLabel =
    acceptedLabelParts.length === 1
      ? `${acceptedLabelParts[0]}s`
      : acceptedLabelParts.length === 2
      ? `${acceptedLabelParts[0]}s or ${acceptedLabelParts[1]}s`
      : `${acceptedLabelParts.slice(0, -1).join("s, ")}s, or ${acceptedLabelParts[acceptedLabelParts.length - 1]}s`;

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

      {documents.length > 0 && (
        <div className="space-y-3">
          {documents.map((doc, i) => (
            <DocumentSettingsCard
              key={doc.id}
              doc={doc}
              index={i}
              shopInfo={shopInfo}
              onChange={(fields) => patchDoc(doc.id, fields)}
              onRemove={() => removeDoc(doc.id)}
              showRemove
            />
          ))}
        </div>
      )}

      {failedFiles.length > 0 && (
        <div className="space-y-2">
          {failedFiles.map((f) => (
            <div
              key={f.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-red-900">{f.fileName}</p>
                <p className="mt-0.5 text-xs text-red-700">{f.error}</p>
              </div>
              <button
                type="button"
                onClick={() => removeFailedFile(f.id)}
                className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div>
        {documents.length === 0 && (
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
            Document ({acceptedTypesLabel})
          </label>
        )}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={addingFile}
          className="flex w-full items-center justify-between rounded-lg border border-stone-300 bg-white px-3.5 py-3.5 text-left text-sm shadow-sm shadow-stone-900/[0.03] active:bg-stone-50 disabled:opacity-60"
        >
          <span className={documents.length > 0 ? "font-medium text-stone-700" : "text-stone-400"}>
            {addingFile
              ? "Processing…"
              : documents.length > 0
              ? "+ Add more documents"
              : `Choose ${acceptedTypesLabel}`}
          </span>
          <span className="ml-3 shrink-0 rounded-md bg-stone-900 px-2.5 py-1.5 text-[11px] font-medium text-stone-50">
            {addingFile ? "…" : "Browse"}
          </span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={acceptedFileTypes}
          className="hidden"
          disabled={addingFile}
          onChange={(e) => handleFilesChosen(e.target.files)}
        />
        {documents.length === 0 && (
          <p className="mt-1 text-[11px] text-stone-500">
            Select multiple files at once if you're printing more than one document.
          </p>
        )}
        {addingFile && (
          <p className="mt-1 text-[11px] text-stone-500">
            Reading your files and detecting pages — usually just a few seconds…
          </p>
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
          onChange={(e) =>
            setOrder((prev) => ({ ...prev, phone: e.target.value.replace(/\D/g, "").slice(0, 10) }))
          }
          placeholder="10-digit mobile number"
          className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm shadow-sm shadow-stone-900/[0.03] focus:border-stone-500 focus:outline-none"
        />
        <p className="mt-1 text-xs text-stone-500">We'll text you when it's ready to collect.</p>

        {phoneValid && checkingPhone && (
          <p className="mt-2 text-xs text-stone-500">Checking…</p>
        )}
        {phoneValid && phoneChecked && knownName && (
          <p className="mt-2 text-xs text-[#2F6E68]">Welcome back, {knownName}!</p>
        )}
        {isNewNumber && (
          <div className="mt-3">
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-stone-500">
              Your name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setOrder((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="So the shop knows who to look out for"
              className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm shadow-sm shadow-stone-900/[0.03] focus:border-stone-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-stone-500">
              First time ordering with this number — we'll remember it next time.
            </p>
          </div>
        )}
      </div>

      {documents.length > 0 && totalEstimate > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-dashed border-stone-300 px-4 py-3">
          <span className="text-sm text-stone-600">
            Estimated total{documents.length > 1 ? ` (${documents.length} documents)` : ""}
          </span>
          <span className="font-mono text-base font-semibold text-stone-900">₹{totalEstimate}</span>
        </div>
      )}

      {submitError && <ErrorBanner message={submitError} onRetry={handleSubmit} />}

      <button type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-full rounded-lg bg-[#A63A2C] py-3.5 text-sm font-semibold text-white shadow-sm shadow-[#A63A2C]/20 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-stone-300 disabled:shadow-none"
      >
        {submitting ? "Uploading\u2026" : "Review order"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Order review (receipt preview) + payment
// ---------------------------------------------------------------------------
// kind: "job" | "batch". orderId is the jobId or batchId respectively. order
// always carries a `documents` array now (length 1 for the plain single-file
// flow), so this renders a summary per document plus one combined total.
//
// Payment itself: a student pays the shop's own UPI ID directly (the same
// soundbox/QR the shop already uses for every other customer) - there's no
// gateway signature IS the confirmation, no shop owner review needed - see
// verifyRazorpayPayment). Cash is the other option, but only shown when
// isNearShop is true (a live QR scan just happened) - otherwise a remote
// student could select "pay cash" and never show up, leaving the shop
// owner with a phantom job. Manual UPI-screenshot payment has been removed
// from this screen entirely: it required the shop owner to manually review
// and confirm every payment, which was the slowest path for everyone - a
// remote student (came in via the website, not a QR scan) now only sees
// "Pay online", since cash isn't an option for them either.
function ReviewPaymentStep({ kind, orderId, amountDue, order, shopId, isNearShop, onSubmitted, onBack }) {
  const [method, setMethod] = useState(null); // null | "cash"
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [fees, setFees] = useState({
    serviceFeePercent: 0,
    serviceFeeEnabled: false,
    serviceFeeTier1Flat: 1,
    serviceFeeTier2Flat: 1.5,
    gatewayFeePercent: 0,
    gatewayFeeEnabled: false,
    gatewayFeeTier1Flat: 1,
    gatewayFeeTier2Flat: 1.5,
  });
  const documents = order?.documents || [];

  // Fee settings are public and admin-editable (see admin panel's Settings
  // tab) and apply only to the online path - fetched once so the order
  // summary can show the real total up front instead of surprising the
  // student inside the Razorpay popup. Silently falls back to "no fee" on
  // error rather than blocking checkout over a settings-read failure.
  useEffect(() => {
    let cancelled = false;
    api
      .getPaymentFees()
      .then((f) => {
        if (!cancelled) setFees(f);
      })
      .catch((e) => {
        // Not shown to the student (a fee-settings hiccup shouldn't block
        // checkout) but logged so it's diagnosable from browser DevTools -
        // this silently defaulting to "no fee" was hard to tell apart from
        // "fees are genuinely off" without this.
        if (!cancelled) console.error('Could not load payment fee settings:', e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Mirrors settings.js computeFeeBreakdown exactly, so this preview can
  // never show a different total than what create-order actually charges.
  // A percentage of a small order rounds to ₹0, so ₹20-and-under orders use
  // a flat rupee amount instead (two tiers - ₹0-10 and ₹11-20 - since a
  // flat ₹1 isn't really the same proportion on both); above ₹20 uses the
  // percentage. A disabled fee is always 0 regardless of any of its stored
  // numbers.
  function feeFor(baseAmount, enabled, percent, tier1Flat, tier2Flat) {
    if (!enabled) return 0;
    if (baseAmount <= 10) return tier1Flat;
    if (baseAmount <= 20) return tier2Flat;
    return Math.round((baseAmount * percent) / 100);
  }
  const serviceFee = feeFor(
    amountDue,
    fees.serviceFeeEnabled,
    fees.serviceFeePercent,
    fees.serviceFeeTier1Flat,
    fees.serviceFeeTier2Flat
  );
  const gatewayFee = feeFor(
    amountDue,
    fees.gatewayFeeEnabled,
    fees.gatewayFeePercent,
    fees.gatewayFeeTier1Flat,
    fees.gatewayFeeTier2Flat
  );
  const onlineTotal = amountDue + serviceFee + gatewayFee;

  function describeColor(doc) {
    return doc.colorMode === "mixed"
      ? `Custom (pages ${doc.colorPages})`
      : doc.colorMode === "color"
      ? "Full color"
      : "Black & white";
  }

  async function handleSubmitCash() {
    setError(null);
    setSubmitting(true);
    try {
      await api.submitPayment(kind, orderId, { method: "cash" });
      onSubmitted();
    } catch (e) {
      setError(e.message || "Could not submit your order. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Online payment via Razorpay Checkout - the one path that skips the
  // shop owner's manual confirm step entirely, since the gateway's
  // signature (verified server-side in verifyRazorpayPayment) IS the
  // confirmation. setSubmitting stays true for the whole modal lifetime so
  // the rest of this screen can't be interacted with mid-payment; every
  // exit (success, failure, or the student just closing the popup) clears it.
  async function handlePayOnline() {
    setError(null);
    setSubmitting(true);
    try {
      await loadRazorpayScript();
      const order = await api.createRazorpayOrder(kind, orderId);

      const rzp = new window.Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: "PrintNow",
        description: `Order ${orderId}`,
        order_id: order.orderId,
        theme: { color: "#2F6E68" },
        handler: async (response) => {
          try {
            await api.verifyRazorpayPayment(kind, orderId, {
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
            });
            onSubmitted();
          } catch (e) {
            setError(
              e.message ||
                "Payment went through but we couldn't verify it. Please show the shop your payment confirmation."
            );
            setSubmitting(false);
          }
        },
        modal: {
          // Student closed the popup without paying - not an error, just
          // back to a normal, retryable state.
          ondismiss: () => setSubmitting(false),
        },
      });
      rzp.on("payment.failed", (resp) => {
        setError(resp.error?.description || "Payment failed. Please try again.");
        setSubmitting(false);
      });
      rzp.open();
    } catch (e) {
      setError(e.message || "Could not start online payment. Please try again.");
      setSubmitting(false);
    }
  }

  const orderSummaryCard = (
    <div className="rounded-xl border border-stone-300 bg-white px-4 py-4 shadow-sm shadow-stone-900/[0.03]">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-stone-500">
        Order summary{documents.length > 1 ? ` — ${documents.length} documents` : ""}
      </p>

      <div className="space-y-3">
        {documents.map((doc, i) => (
          <div key={i} className={i > 0 ? "border-t border-dashed border-stone-200 pt-3" : ""}>
            <p className="truncate text-sm font-medium text-stone-800">{doc.fileName}</p>
            <dl className="mt-1.5 space-y-1">
              {[
                ["Pages", doc.pages],
                ["Copies", doc.copies],
                ["Sides", doc.sides === "double" ? "Double-sided" : "One-sided"],
                ["Color", describeColor(doc)],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between text-xs">
                  <dt className="text-stone-500">{label}</dt>
                  <dd className="max-w-[60%] truncate text-right font-medium text-stone-700">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      <div className="my-3 border-t border-dashed border-stone-300" />
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-stone-700">Print cost</span>
        <span className="font-mono text-2xl font-bold text-stone-900">₹{amountDue}</span>
      </div>

      {(serviceFee > 0 || gatewayFee > 0) && (
        <div className="mt-3 space-y-1 border-t border-dashed border-stone-200 pt-3 text-xs">
          {serviceFee > 0 && (
            <div className="flex items-center justify-between text-stone-500">
              <span>Service fee (online payment only)</span>
              <span>₹{serviceFee}</span>
            </div>
          )}
          {gatewayFee > 0 && (
            <div className="flex items-center justify-between text-stone-500">
              <span>Payment gateway fee (online payment only)</span>
              <span>₹{gatewayFee}</span>
            </div>
          )}
          <div className="flex items-center justify-between pt-1 font-medium text-stone-700">
            <span>Total if paying online</span>
            <span className="font-mono">₹{onlineTotal}</span>
          </div>
        </div>
      )}
    </div>
  );

  const backButton = onBack && (
    <button type="button"
      onClick={method ? () => setMethod(null) : onBack}
      disabled={submitting}
      className="-mt-1 mb-1 flex items-center gap-1 text-xs font-medium text-stone-500 hover:text-stone-700 disabled:opacity-50"
    >
      ← {method ? "Choose a different way to pay" : "Back to edit order"}
    </button>
  );

  // Method chosen: cash - just a confirmation, no screenshot needed.
  if (method === "cash") {
    return (
      <div className="space-y-5">
        {backButton}
        {orderSummaryCard}

        <div className="rounded-xl border border-stone-300 bg-white px-4 py-4 text-center">
          <p className="mb-1 text-sm font-medium text-stone-800">Pay ₹{amountDue} in cash</p>
          <p className="mb-4 text-xs text-stone-500">
            Hand over ₹{amountDue} in cash to the shop when you collect your prints.
          </p>

          {error && <ErrorBanner message={error} onRetry={handleSubmitCash} />}

          <button type="button"
            onClick={handleSubmitCash}
            disabled={submitting}
            className="w-full rounded-lg bg-[#A63A2C] py-3.5 text-sm font-semibold text-white shadow-sm shadow-[#A63A2C]/20 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-stone-300 disabled:shadow-none"
          >
            {submitting ? "Confirming\u2026" : "Confirm — I'll pay cash"}
          </button>
        </div>
      </div>
    );
  }

  // No method chosen yet. Scanned the shop's QR in person (isNearShop):
  // online + cash. Came in through the website instead: online only - no
  // cash (they're not standing at the counter to hand it over) and no
  // manual UPI (removed entirely, see comment above the component).
  return (
    <div className="space-y-5">
      {backButton}
      {orderSummaryCard}

      {error && <ErrorBanner message={error} onRetry={handlePayOnline} />}

      <div className="space-y-2.5">
        <button type="button"
          onClick={handlePayOnline}
          disabled={submitting}
          className="flex w-full items-center justify-between rounded-lg border border-[#2F6E68] bg-[#2F6E68]/5 px-4 py-3.5 text-left shadow-sm active:bg-[#2F6E68]/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span>
            <span className="block text-sm font-medium text-[#2F6E68]">
              {submitting ? "Opening secure payment\u2026" : "Pay online — Card / UPI / Wallet"}
            </span>
            {onlineTotal > amountDue && (
              <span className="mt-0.5 block text-xs text-[#2F6E68]/70">Total ₹{onlineTotal}, fees included above</span>
            )}
          </span>
          <span className="text-[#2F6E68]">→</span>
        </button>

        {isNearShop && (
          <button type="button"
            onClick={() => setMethod("cash")}
            disabled={submitting}
            className="flex w-full items-center justify-between rounded-lg border border-stone-300 bg-white px-4 py-3.5 text-left shadow-sm active:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-sm font-medium text-stone-800">Pay cash at counter</span>
            <span className="text-stone-400">→</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Token + status page (polls GET /jobs/:jobId)
// ---------------------------------------------------------------------------
function StatusStep({ kind, orderId, shopId, onBack, onRetryPayment }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const isBatch = kind === "batch";

  // Optional review, offered once the order is past payment review (queued
  // or later - see routes/shops.js POST /:shopId/reviews for why). For a
  // batch there's no single "job" of its own to attach it to, so the first
  // document's job id stands in for the whole order - one review per order
  // reads more naturally than one per document anyway.
  const [reviewSubmitted, setReviewSubmitted] = useState(() => hasReviewedLocally(orderId));
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewComment, setReviewComment] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewError, setReviewError] = useState(null);

  async function handleSubmitReview() {
    if (!reviewRating) return;
    setReviewError(null);
    setSubmittingReview(true);
    try {
      const targetJobId = isBatch ? job.documents?.[0]?.jobId : orderId;
      await api.submitReview(shopId, {
        jobId: targetJobId,
        rating: reviewRating,
        comment: reviewComment.trim() || undefined,
      });
      markReviewedLocally(orderId);
      setReviewSubmitted(true);
    } catch (e) {
      setReviewError(e.message || "Could not submit your review. Please try again.");
    } finally {
      setSubmittingReview(false);
    }
  }

  const fetchStatus = useCallback(async () => {
    try {
      const data = isBatch ? await api.getBatch(orderId) : await api.getJob(orderId);
      setJob(data);
      setError(null);
    } catch (e) {
      setError(e.message || "Could not refresh status.");
    } finally {
      setLoading(false);
    }
  }, [orderId, isBatch]);

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

      {isBatch && job.documents?.length > 0 && (
        <>
          <div className="mb-4 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
              {job.documents.length} documents in this order
            </p>
            {job.documents.map((doc) => (
              <div
                key={doc.jobId}
                className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs"
              >
                <span className="truncate font-medium text-stone-700">{doc.fileName}</span>
                <span className="shrink-0 font-mono text-stone-500">
                  {doc.pages}p × {doc.copies}
                </span>
              </div>
            ))}
          </div>
          <div className="mb-6 border-t border-dashed border-stone-300" />
        </>
      )}

      {job.status === "uploaded" && job.paymentRejectionReason && (
        <div className="mb-6 rounded-lg border border-red-800/25 bg-red-800/5 px-4 py-3 text-sm text-red-900">
          <p className="font-medium">The shop couldn't verify your payment</p>
          <p className="mt-0.5 text-xs">{job.paymentRejectionReason}</p>
          {onRetryPayment && (
            <button type="button"
              onClick={onRetryPayment}
              className="mt-2 rounded-lg bg-red-800 px-3 py-1.5 text-xs font-semibold text-white"
            >
              Try payment again
            </button>
          )}
        </div>
      )}

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
                  {STATUS_STEP_LABELS[step] || step}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mt-6 flex items-center justify-between text-xs text-stone-500">
        <span>
          {["uploaded", "payment_pending"].includes(job.status) ? "Amount due" : "Amount paid"}: ₹{job.amountDue}
        </span>
        <div className="flex items-center gap-3">
          <button type="button" onClick={handleShare} className="font-medium text-stone-700 underline">
            {copied ? "Link copied" : "Share status"}
          </button>
          <button type="button" onClick={fetchStatus} className="font-medium text-stone-700 underline">
            Refresh
          </button>
        </div>
      </div>

      {!isCancelled && !["uploaded", "payment_pending"].includes(job.status) && (
        <div className="mt-6 border-t border-dashed border-stone-300 pt-5">
          {reviewSubmitted ? (
            <p className="text-center text-sm text-[#2F6E68]">Thanks for the review!</p>
          ) : (
            <div>
              <p className="mb-2 text-center text-xs font-medium uppercase tracking-wide text-stone-500">
                How was it? (optional)
              </p>
              <div className="flex justify-center gap-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button type="button"
                    key={n}
                    onClick={() => setReviewRating(n)}
                    className={`text-2xl leading-none transition ${
                      n <= reviewRating ? "text-amber-500" : "text-stone-300"
                    }`}
                    aria-label={`${n} star${n > 1 ? "s" : ""}`}
                  >
                    ★
                  </button>
                ))}
              </div>

              {reviewRating > 0 && (
                <div className="mt-3">
                  <input
                    type="text"
                    value={reviewComment}
                    onChange={(e) => setReviewComment(e.target.value)}
                    placeholder="Anything you'd like to add? (optional)"
                    className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm shadow-sm focus:border-stone-500 focus:outline-none"
                  />
                  {reviewError && <p className="mt-1.5 text-xs text-red-700">{reviewError}</p>}
                  <button type="button"
                    onClick={handleSubmitReview}
                    disabled={submittingReview}
                    className="mt-2 w-full rounded-lg bg-[#2F6E68] py-2.5 text-sm font-semibold text-white shadow-sm transition active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-stone-300"
                  >
                    {submittingReview ? "Submitting\u2026" : "Submit review"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
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
  const stoppingRef = useRef(false); // true once stop() has been initiated, from either the decode handler or unmount
  const [error, setError] = useState(null);
  const [startedAt, setStartedAt] = useState(null);

  useEffect(() => {
    hasScannedRef.current = false;
    stoppingRef.current = false;
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
          // on the first hit only.
          if (hasScannedRef.current) return;
          hasScannedRef.current = true;
          // Stop the camera FIRST and wait for it to finish tearing down its
          // video element, THEN call onScan. Calling onScan immediately let
          // the parent's state update unmount this component - removing the
          // #qr-reader container and triggering the cleanup below - while
          // html5-qrcode's own stop() here was still mid-flight tearing down
          // that same video element. stoppingRef stops the cleanup effect
          // from calling stop() a second time on top of that; html5-qrcode
          // can throw SYNCHRONOUSLY (not just reject) when stop() runs twice
          // or the container's already gone, which a bare .catch() doesn't
          // protect against and was crashing straight into React's unmount
          // lifecycle - this is what actually produced the blank page /
          // error-boundary trip after a successful in-app scan. Third-party
          // scanners never run this library or this teardown at all, which
          // is why only our own scanner ever hit it.
          stoppingRef.current = true;
          try {
            scanner
              .stop()
              .catch(() => {})
              .finally(() => onScan(decodedText));
          } catch {
            onScan(decodedText); // stop() itself threw synchronously - still hand off the scan result
          }
        },
        () => {} // per-frame decode misses are normal while aiming - ignore
      )
      .then(() => setStartedAt(Date.now()))
      .catch((err) => {
        // getUserMedia (and therefore html5-qrcode) silently refuses to even
        // ask for camera access on a non-HTTPS origin (except localhost) -
        // that shows up here as a rejected promise, not as a live video feed,
        // so it's worth naming explicitly rather than a generic message.
        const insecure = typeof window !== "undefined" && window.location.protocol !== "https:" &&
          !["localhost", "127.0.0.1"].includes(window.location.hostname);
        setError(
          insecure
            ? "Camera access needs a secure (https://) connection - this page was opened over plain http."
            : err?.message || "Could not access camera"
        );
      });

    return () => {
      if (stoppingRef.current) return; // already stopped (or being stopped) by the decode handler above
      stoppingRef.current = true;
      try {
        scannerRef.current?.stop().catch(() => {});
      } catch {
        // Unmounting anyway - nothing useful to do with a synchronous throw here.
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // If the camera opened successfully but nothing has decoded after a
  // while, the feed itself is fine - it's aim/lighting/glare, or a QR
  // encoding it genuinely can't parse. Surface an escape hatch instead of
  // leaving someone staring at a live camera feed indefinitely.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!startedAt) return;
    const t = setTimeout(() => setStuck(true), 12000);
    return () => clearTimeout(t);
  }, [startedAt]);

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
          {error}. Check camera permissions, or use "upload a saved QR image" / "choose by
          location" below instead.
        </p>
      ) : (
        <>
          <div id={containerId} className="overflow-hidden rounded-lg" />
          {stuck && (
            <p className="mt-2 rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-xs text-stone-600">
              Not picking it up? Try moving closer, reducing glare, or use "upload a saved QR
              image" / "choose by location" below instead.
            </p>
          )}
        </>
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
  platformReviews: null,
};

function HomeStep({ onShopSelected, onMyOrders }) {
  const [scanning, setScanning] = useState(false);
  const [decodingFile, setDecodingFile] = useState(false);
  const [landmarks, setLandmarks] = useState(homeStepCache.landmarks || []);
  const [landmarkId, setLandmarkIdState] = useState(homeStepCache.landmarkId);
  const [shops, setShops] = useState(homeStepCache.shops || []);
  const [loadingShops, setLoadingShops] = useState(false);
  const [error, setError] = useState(null);
  const [platformReviews, setPlatformReviews] = useState(homeStepCache.platformReviews || []);
  const [showAllReviews, setShowAllReviews] = useState(false);
  const REVIEWS_COLLAPSED_COUNT = 3;
  const fileInputRef = useRef(null);

  const [manualCode, setManualCode] = useState("");

  function handleManualCode(e) {
    e.preventDefault();
    const id = extractShopIdFromScan(manualCode.trim());
    if (!id) return;
    onShopSelected(id); // no viaQrScan flag - typing a code isn't proof of being at the shop
  }

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
    if (homeStepCache.platformReviews) return; // already fetched earlier this session
    api
      .getPlatformReviews()
      .then((data) => {
        homeStepCache.platformReviews = data.reviews;
        setPlatformReviews(data.reviews);
      })
      .catch(() => {
        // Non-fatal - the section just doesn't render if this fails (see
        // below), same "fail quiet" treatment as other optional content.
      });
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
      onShopSelected(id, true); // true: this came from a live QR scan, proof of being at the shop right now
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

          <form onSubmit={handleManualCode} className="mb-6 flex gap-2">
            <input
              type="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="Or type the shop's code"
              className="flex-1 rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm shadow-sm focus:border-stone-500 focus:outline-none"
            />
            <button type="submit"
              disabled={!manualCode.trim()}
              className="shrink-0 rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm font-medium text-stone-700 shadow-sm active:bg-stone-50 disabled:opacity-50"
            >
              Go
            </button>
          </form>
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
            <span>
              <span className="font-medium text-stone-800">{s.name}</span>
              {s.reviewCount > 0 && (
                <span className="ml-2 text-xs text-amber-600">
                  ★ {s.avgRating} <span className="text-stone-400">({s.reviewCount})</span>
                </span>
              )}
            </span>
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

      {platformReviews.length > 0 && (
        <div className="mt-10 border-t border-dashed border-stone-300 pt-6">
          <p className="mb-3 text-center text-xs font-medium uppercase tracking-wide text-stone-500">
            What students are saying
          </p>
          <div className="space-y-2.5">
            {(showAllReviews ? platformReviews : platformReviews.slice(0, REVIEWS_COLLAPSED_COUNT)).map((r) => (
              <div key={r.id} className="rounded-lg border border-stone-200 bg-white px-3.5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-amber-500 text-sm tracking-tight">
                    {"★".repeat(r.rating)}
                    <span className="text-stone-200">{"★".repeat(5 - r.rating)}</span>
                  </span>
                  <span className="text-xs text-stone-400">{r.shopName}</span>
                </div>
                {r.comment && <p className="mt-1.5 text-sm text-stone-700">{r.comment}</p>}
                <p className="mt-1 text-xs text-stone-400">— {r.authorName}</p>
              </div>
            ))}
          </div>
          {!showAllReviews && platformReviews.length > REVIEWS_COLLAPSED_COUNT && (
            <button type="button"
              onClick={() => setShowAllReviews(true)}
              className="mt-3 flex w-full items-center justify-center text-xs font-medium text-stone-500 underline decoration-stone-300 underline-offset-2"
            >
              Show {platformReviews.length - REVIEWS_COLLAPSED_COUNT} more review
              {platformReviews.length - REVIEWS_COLLAPSED_COUNT > 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root app
// ---------------------------------------------------------------------------
function makeDefaultOrderForm() {
  return {
    documents: [],
    phone: "",
    name: "",
  };
}

export default function App() {
  const shopIdParam = getParam("shopId");
  const initialJobId = getParam("jobId");
  const initialBatchId = getParam("batchId");

  const [shopId, setShopId] = useState(shopIdParam);
  const [phase, setPhase] = useState(
    initialJobId || initialBatchId ? "status" : shopIdParam ? "upload" : "home"
  );
  // kind: "job" | "batch" — which endpoint family orderId belongs to.
  const [orderKind, setOrderKind] = useState(initialBatchId ? "batch" : "job");
  const [orderId, setOrderId] = useState(initialBatchId || initialJobId);
  const [amountDue, setAmountDue] = useState(null);
  const [shopName, setShopName] = useState(null);
  const [order, setOrder] = useState(null);
  // Proof the student is physically at this shop right now, for gating the
  // cash-at-counter payment option (see ReviewPaymentStep).
  //
  // In practice almost nobody opens the PrintNow site first and then uses
  // our in-app camera scanner - they point their phone's regular camera (or
  // WhatsApp/Google Lens/any QR app) at the shop's printed sticker, which
  // opens this page directly at "?shopId=X". That's why the very first
  // render below counts too, not just handleScan()'s in-app path: a page
  // load carrying a bare shopId param (no jobId/batchId - i.e. not someone
  // resuming an existing order via a link) is exactly what scanning the
  // physical sticker produces, from any scanner.
  //
  // Known accepted gap: someone COULD bookmark or forward that same
  // "?shopId=X" link and reopen it later, away from the shop, which would
  // also read as "just scanned". This is the same trust tradeoff as the
  // in-app scanner already had (nothing stops re-scanning a screenshot of
  // the code either) - the real backstop stays the shop owner, who only
  // taps "confirm" once cash is actually in hand.
  const [qrScanInfo, setQrScanInfo] = useState(
    shopIdParam && !initialJobId && !initialBatchId
      ? { shopId: shopIdParam, scannedAt: Date.now() }
      : null
  ); // { shopId, scannedAt } | null
  // The live upload form's own state, lifted up here (rather than kept
  // inside UploadStep) specifically so "← Back to edit order" from the
  // Review step doesn't lose what the student already filled in - the
  // documents added, their settings, etc. all survive the round trip.
  const [orderForm, setOrderForm] = useState(makeDefaultOrderForm);

  useEffect(() => {
    if (initialBatchId) {
      api.getBatch(initialBatchId).then((b) => setShopName(b.shopName)).catch(() => {});
    } else if (initialJobId) {
      api.getJob(initialJobId).then((j) => setShopName(j.shopName)).catch(() => {});
    }
  }, [initialJobId, initialBatchId]);

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
      { phase, shopId: shopIdParam, jobId: initialJobId, batchId: initialBatchId },
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
      setOrderKind(s.batchId ? "batch" : "job");
      setOrderId(s.batchId || s.jobId || null);
      if (!s.shopId) setShopName(null);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function handleShopSelected(id, viaQrScan = false) {
    setShopId(id);
    setQrScanInfo(viaQrScan ? { shopId: id, scannedAt: Date.now() } : null);
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
  // to be set fresh here. Order history rows are always individual
  // print_jobs (even documents that were part of a batch keep their own
  // status/token via the batch payment), so this always opens as kind "job".
  function handleOpenHistoryJob(id, historyShopId) {
    setShopId(historyShopId || null);
    setQrScanInfo(null); // opening a past order isn't proof of being at the shop right now
    setOrderKind("job");
    setOrderId(id);
    setPhase("status");
    pushPhase("status", { shopId: historyShopId, jobId: id });
    api.getJob(id).then((j) => setShopName(j.shopName)).catch(() => {});
  }

  function handleChangeShop() {
    setShopId(null);
    setShopName(null);
    setQrScanInfo(null);
    setOrderForm(makeDefaultOrderForm()); // starting over with a different shop - clear the form too
    setPhase("home");
    pushPhase("home", {});
  }

  // kind: "job" (single document, unchanged flow) or "batch" (multiple
  // documents, one combined payment) - UploadStep decides which based on
  // how many documents were added, and calls the matching create endpoint
  // itself before handing back the resulting id here.
  function handleOrderCreated(kind, id, orderSummary) {
    setOrderKind(kind);
    setOrderId(id);
    setOrder(orderSummary);
    const label =
      orderSummary.documents.length > 1
        ? `${orderSummary.documents.length} documents`
        : orderSummary.documents[0]?.fileName;
    rememberOrder(id, shopId, label, kind);
    setPhase("review");
    if (kind === "batch") {
      pushPhase("review", { shopId, batchId: id });
      api.getBatch(id).then((b) => {
        setAmountDue(b.amountDue);
        setShopName(b.shopName);
      });
    } else {
      pushPhase("review", { shopId, jobId: id });
      api.getJob(id).then((j) => {
        setAmountDue(j.amountDue);
        setShopName(j.shopName);
      });
    }
  }

  // Going back from Review re-opens Upload with everything the student
  // already entered still in place (orderForm is untouched). Known gap,
  // flagged rather than hidden: the job/batch created just before Review
  // was shown already exists server-side in "uploaded" status - going back
  // doesn't cancel it, it's simply left unpaid and never queued. Same
  // category as an abandoned cart; nothing prints or charges from it.
  function handleBackFromReview() {
    setPhase("upload");
    pushPhase("upload", { shopId });
  }

  // Payment is now a two-step handoff, not a single confirm: this fires
  // once the student has submitted their proof (UPI screenshot or cash
  // choice) - the order sits in "payment_pending" until the shop owner
  // actually reviews and confirms it, which is what mints the token. So
  // this moves to the status screen same as before, just without a token
  // in hand yet - StatusStep polls and shows it once the shop confirms.
  function handleSubmitted() {
    setPhase("status");
    pushPhase("status", orderKind === "batch" ? { shopId, batchId: orderId } : { shopId, jobId: orderId });
  }

  // If the shop owner rejects what was submitted (bad screenshot, cash
  // never handed over), StatusStep offers a way back here to try again -
  // order/amountDue are still the same values from the original submission,
  // nothing needs re-fetching.
  function handleRetryPayment() {
    setPhase("review");
    pushPhase("review", orderKind === "batch" ? { shopId, batchId: orderId } : { shopId, jobId: orderId });
  }

  function handleOpenRecent(id, kind = "job", entryShopId) {
    setOrderKind(kind);
    setOrderId(id);
    if (entryShopId) setShopId(entryShopId);
    setQrScanInfo(null); // reopening a saved order isn't proof of being at the shop right now
    setPhase("status");
    pushPhase("status", kind === "batch" ? { shopId: entryShopId || shopId, batchId: id } : { shopId: entryShopId || shopId, jobId: id });
  }

  // New: the status page previously had no way back at all except leaving
  // the SPA. This resets everything and returns cleanly to "home".
  function handleBackToHome() {
    setShopId(null);
    setShopName(null);
    setQrScanInfo(null);
    setOrderId(null);
    setOrderKind("job");
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
          onOrderCreated={handleOrderCreated}
          onOpenRecent={handleOpenRecent}
          onBack={handleChangeShop}
        />
      )}
      {phase === "review" && orderId && (
        <ReviewPaymentStep
          kind={orderKind}
          orderId={orderId}
          amountDue={amountDue}
          order={order}
          shopId={shopId}
          isNearShop={qrScanInfo?.shopId === shopId && Date.now() - qrScanInfo?.scannedAt < QR_SCAN_FRESHNESS_MS}
          onSubmitted={handleSubmitted}
          onBack={handleBackFromReview}
        />
      )}
      {phase === "status" && orderId && (
        <StatusStep
          kind={orderKind}
          orderId={orderId}
          shopId={shopId}
          onBack={handleBackToHome}
          onRetryPayment={handleRetryPayment}
        />
      )}
      <p className="mt-8 text-center text-[11px] text-stone-400">
        {MOCK_MODE ? "Running in mock mode — no real backend connected yet." : ""}
      </p>
    </div>
  );
}
