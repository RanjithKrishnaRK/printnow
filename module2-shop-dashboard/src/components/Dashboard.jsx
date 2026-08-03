import { useCallback, useEffect, useRef, useState } from "react";
import { getJobs, updateJobStatus, getSettings, setAutoPrint, getEarnings } from "../api";
import { clearSession } from "../auth";
import { triggerBuzzer, isMuted, setMuted } from "../buzzer";
import { openFileAndPrint } from "../printHelper";
import StatusTabs from "./StatusTabs";
import JobCard from "./JobCard";
import BatchCard from "./BatchCard";
import ShopQrCode from "./ShopQrCode";

const POLL_MS = 15000;

// Groups an already-sorted job list into { batchId, jobs } entries: jobs
// sharing a batchId collapse into one entry (rendered as BatchCard), jobs
// with no batchId (the single-document flow, unchanged) each get their own
// entry (batchId: null, rendered as JobCard). Preserves the original sort
// order by using each group's first-seen position.
function groupByBatch(jobs) {
  const entries = [];
  const batchIndex = new Map(); // batchId -> index into entries[]
  for (const job of jobs) {
    if (!job.batchId) {
      entries.push({ batchId: null, jobs: [job] });
      continue;
    }
    if (batchIndex.has(job.batchId)) {
      entries[batchIndex.get(job.batchId)].jobs.push(job);
    } else {
      batchIndex.set(job.batchId, entries.length);
      entries.push({ batchId: job.batchId, jobs: [job] });
    }
  }
  return entries;
}

// NOTE on the contract: GET /api/jobs?status=queued is documented with one
// example status. This dashboard needs queued+printing+ready counts visible
// at once (so a shop owner can see the whole counter without tab-hopping),
// so we call getJobs() with no status filter and filter client-side. This
// assumes the real endpoint returns ALL jobs when `status` is omitted.
// FLAG FOR MODULE 3: if the real API requires `status` on every call, tell
// me and I'll switch this to three parallel calls instead - it's an easy
// change, isolated to loadJobs() below.

export default function Dashboard({
  shopId,
  token,
  shopName,
  showQrOnMount = false,
  onQrShown,
  onLogout,
  onOpenSettings,
}) {
  const [activeTab, setActiveTab] = useState("queued");
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatingJobId, setUpdatingJobId] = useState(null);
  const [showQr, setShowQr] = useState(showQrOnMount);
  const [muted, setMutedState] = useState(() => isMuted());
  const [autoPrintEnabled, setAutoPrintEnabled] = useState(false);
  const [autoPrintBusy, setAutoPrintBusy] = useState(false);
  const [earnings, setEarnings] = useState(null);

  // Tracks which job IDs we've already seen, so the buzzer only fires for
  // jobs that are genuinely new since the last poll - not for the shop's
  // whole existing queue on first login, and not repeatedly for the same
  // job across every 15s poll.
  const seenJobIdsRef = useRef(null);

  function closeQr() {
    setShowQr(false);
    onQrShown?.();
  }

  function toggleMuted() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  }

  const loadJobs = useCallback(async () => {
    try {
      const all = await getJobs(shopId, token);

      if (seenJobIdsRef.current === null) {
        // First load for this session: just record what's already there,
        // don't buzz for a pre-existing queue the shop owner already knows about.
        seenJobIdsRef.current = new Set(all.map((j) => j.jobId));
      } else {
        const newQueuedJobs = all.filter(
          (j) => j.status === "queued" && !seenJobIdsRef.current.has(j.jobId)
        );
        if (newQueuedJobs.length > 0) {
          triggerBuzzer();
        }
        seenJobIdsRef.current = new Set(all.map((j) => j.jobId));
      }

      setJobs(all);
      setError("");
    } catch (err) {
      setError(err.message || "Could not load jobs.");
    } finally {
      setLoading(false);
    }
  }, [shopId, token]);

  const loadEarnings = useCallback(async () => {
    try {
      const data = await getEarnings(shopId, token);
      setEarnings(data);
    } catch (err) {
      // Non-fatal: the header just doesn't show earnings until the next
      // successful poll, same treatment as the auto-print toggle above.
    }
  }, [shopId, token]);

  useEffect(() => {
    loadJobs();
    loadEarnings();
    const interval = setInterval(() => {
      loadJobs();
      loadEarnings();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [loadJobs, loadEarnings]);

  useEffect(() => {
    getSettings(shopId, token)
      .then((s) => setAutoPrintEnabled(!!s.autoPrintEnabled))
      .catch(() => {
        // Non-fatal - the toggle just starts showing "Off" until the next
        // successful load. Not worth surfacing as a page-level error since
        // the rest of the dashboard works fine without it.
      });
  }, [shopId, token]);

  async function toggleAutoPrint() {
    const next = !autoPrintEnabled;
    setAutoPrintBusy(true);
    setAutoPrintEnabled(next); // optimistic
    try {
      await setAutoPrint(shopId, token, next);
    } catch (err) {
      setAutoPrintEnabled(!next); // roll back
      setError(err.message || "Could not update auto-print setting.");
    } finally {
      setAutoPrintBusy(false);
    }
  }

  async function handleAdvance(job, nextStatus) {
    const { jobId } = job;
    setUpdatingJobId(jobId);
    // Optimistic update so the counter feels instant during rush hour;
    // reconciled against the server response right after.
    setJobs((prev) =>
      prev.map((j) => (j.jobId === jobId ? { ...j, status: nextStatus } : j))
    );

    // "Send to printer" (queued -> printing) is the one transition that
    // needs to actually DO something with the file, not just flip a status -
    // open it and trigger the print dialog automatically, so the shop
    // owner doesn't have to separately click "View file" then Ctrl+P. See
    // printHelper.js for why this can't be fully silent (no browser allows
    // a webpage to print without that final dialog) and for shops that want
    // truly zero-click printing, that's what the Module 6 agent is for.
    if (nextStatus === "printing") {
      try {
        await openFileAndPrint(job.fileUrl);
      } catch (err) {
        // Don't block the status update over a print-dialog hiccup (e.g. a
        // blocked pop-up) - just surface it so the shop owner knows to open
        // the file manually this once.
        setError(err.message || "Could not open the print dialog automatically.");
      }
    }

    try {
      await updateJobStatus(jobId, token, nextStatus);
    } catch (err) {
      setError(err.message || "Could not update job status.");
      loadJobs(); // roll back to server truth on failure
    } finally {
      setUpdatingJobId(null);
    }
  }

  // Bulk-advance every document in a batch together. No new backend
  // endpoint needed - PATCH /api/jobs/:jobId/status already works per-job,
  // so this just loops it client-side (same call handleAdvance makes),
  // rather than adding a batch-status-cascade endpoint for one button.
  async function handleAdvanceAll(jobsInBatch, nextStatus) {
    const batchId = jobsInBatch[0].batchId;
    setUpdatingJobId(batchId); // reuse the same busy-state field, keyed by batchId here

    setJobs((prev) =>
      prev.map((j) => (j.batchId === batchId ? { ...j, status: nextStatus } : j))
    );

    if (nextStatus === "printing") {
      for (const job of jobsInBatch) {
        try {
          await openFileAndPrint(job.fileUrl);
        } catch (err) {
          setError(err.message || "Could not open the print dialog automatically for one of the files.");
        }
      }
    }

    try {
      await Promise.all(jobsInBatch.map((job) => updateJobStatus(job.jobId, token, nextStatus)));
    } catch (err) {
      setError(err.message || "Could not update all documents in this order.");
      loadJobs(); // roll back to server truth on failure
    } finally {
      setUpdatingJobId(null);
    }
  }

  const counts = {
    queued: jobs.filter((j) => j.status === "queued").length,
    printing: jobs.filter((j) => j.status === "printing").length,
    ready: jobs.filter((j) => j.status === "ready").length,
  };

  const visibleStatus = activeTab === "history" ? "collected" : activeTab;
  const visibleJobs = jobs
    .filter((j) => j.status === visibleStatus)
    .sort((a, b) =>
      activeTab === "history"
        ? new Date(b.createdAt) - new Date(a.createdAt) // newest first in history
        : new Date(a.createdAt) - new Date(b.createdAt) // oldest first in queue
    );

  return (
    <div className="min-h-screen bg-paper">
      <header className="bg-ink text-white px-4 sm:px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-teal flex items-center justify-center shrink-0">
            <span className="font-mono font-bold text-white text-xs">P</span>
          </div>
          <span className="font-display font-bold text-xl tracking-tight">PrintNow</span>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={toggleAutoPrint}
            disabled={autoPrintBusy}
            title={
              autoPrintEnabled
                ? "Auto-print is on — your print agent will print queued jobs automatically. Click to turn off."
                : "Auto-print is off — click to turn on (requires the local print agent running on this shop's computer)."
            }
            className="text-sm text-white/70 hover:text-white transition-colors disabled:opacity-60"
          >
            {autoPrintEnabled ? "🖨️ Auto-print: On" : "🖨️ Auto-print: Off"}
          </button>
          <button
            onClick={toggleMuted}
            title={muted ? "Buzzer muted — click to unmute" : "Buzzer on — click to mute"}
            className="text-sm text-white/70 hover:text-white transition-colors"
          >
            {muted ? "🔕 Muted" : "🔔 Buzzer on"}
          </button>
          <button
            onClick={onOpenSettings}
            className="text-sm text-white/70 hover:text-white transition-colors"
          >
            ⚙️ Settings
          </button>
          <button
            onClick={() => setShowQr(true)}
            className="text-sm text-white/70 hover:text-white transition-colors"
          >
            Shop QR code
          </button>
          <button
            onClick={() => {
              clearSession();
              onLogout();
            }}
            className="text-sm text-white/70 hover:text-white transition-colors"
          >
            Log out
          </button>
        </div>
      </header>

      {showQr && <ShopQrCode shopId={shopId} shopName={shopName} onClose={closeQr} />}

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {earnings && (
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-black/5 bg-card px-4 py-3 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-collected">Today's earnings</p>
              <p className="mt-1 font-display text-xl font-bold text-ink">
                ₹{earnings.todayEarnings} <span className="text-xs font-normal text-collected">({earnings.todayJobs} jobs)</span>
              </p>
            </div>
            <div className="rounded-xl border border-black/5 bg-card px-4 py-3 shadow-sm">
              <p className="text-xs uppercase tracking-wide text-collected">All-time earnings</p>
              <p className="mt-1 font-display text-xl font-bold text-ink">
                ₹{earnings.totalEarnings} <span className="text-xs font-normal text-collected">({earnings.totalJobs} jobs)</span>
              </p>
            </div>
            <div className="col-span-2 rounded-xl border border-black/5 bg-card px-4 py-3 shadow-sm sm:col-span-1">
              <p className="text-xs uppercase tracking-wide text-collected">Right now</p>
              <p className="mt-1 font-display text-xl font-bold text-ink">
                {counts.queued + counts.printing + counts.ready} <span className="text-xs font-normal text-collected">active jobs</span>
              </p>
            </div>
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
          <div className="overflow-x-auto -mx-1 px-1">
            <StatusTabs active={activeTab} onChange={setActiveTab} counts={counts} />
          </div>
          <button
            onClick={loadJobs}
            className="text-sm text-collected hover:text-ink flex items-center gap-1.5 self-start sm:self-auto"
          >
            ↻ Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-center text-collected py-16">Loading jobs…</div>
        ) : visibleJobs.length === 0 ? (
          <div className="text-center text-collected py-16 border border-dashed border-black/10 rounded-xl">
            {activeTab === "history"
              ? "No collected jobs yet today."
              : `No jobs ${activeTab === "queued" ? "in the queue" : `in "${activeTab}"`} right now.`}
          </div>
        ) : (
          <div className="space-y-3">
            {groupByBatch(visibleJobs).map((entry) =>
              entry.batchId ? (
                <BatchCard
                  key={entry.batchId}
                  jobs={entry.jobs}
                  onAdvanceAll={handleAdvanceAll}
                  busy={updatingJobId === entry.batchId}
                />
              ) : (
                <JobCard
                  key={entry.jobs[0].jobId}
                  job={entry.jobs[0]}
                  onAdvance={handleAdvance}
                  busy={updatingJobId === entry.jobs[0].jobId}
                />
              )
            )}
          </div>
        )}
      </main>
    </div>
  );
}
