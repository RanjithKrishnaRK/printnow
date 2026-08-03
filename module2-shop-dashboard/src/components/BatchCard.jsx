// A multi-document order rendered as one card: shared token number up top,
// then one row per document (each with its own PrintDetails + filename +
// per-doc "Send to printer" etc), plus a bulk action to advance every
// document in the batch at once. All documents in a batch always share the
// same status here because Dashboard only ever calls handleAdvanceAll (see
// Dashboard.jsx) - there's no per-doc advance button, matching how they were
// paid for and queued together in the first place.
import PrintDetails from "./PrintDetails";

const STATUS_EDGE = {
  queued: "border-l-queued",
  printing: "border-l-printing",
  ready: "border-l-ready",
  collected: "border-l-collected",
};

const STATUS_LABEL = {
  queued: "Queued",
  printing: "Printing",
  ready: "Ready for pickup",
  collected: "Collected",
};

const NEXT_ACTION = {
  queued: { label: "Send to printer", nextStatus: "printing" },
  printing: { label: "Mark ready", nextStatus: "ready" },
  ready: { label: "Mark collected", nextStatus: "collected" },
};

const ACTION_BUTTON_COLOR = {
  queued: "bg-printing hover:bg-blue-700",
  printing: "bg-ready hover:bg-emerald-700",
  ready: "bg-collected hover:bg-slate-600",
};

function timeAgo(iso) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

// jobs: all print_jobs rows sharing one batchId, already filtered to the
// currently visible status tab (so job.status is the same across the array).
export default function BatchCard({ jobs, onAdvanceAll, busy }) {
  const status = jobs[0].status;
  const tokenNumber = jobs[0].tokenNumber;
  const oldestCreatedAt = jobs.reduce(
    (min, j) => (new Date(j.createdAt) < new Date(min) ? j.createdAt : min),
    jobs[0].createdAt
  );
  const action = NEXT_ACTION[status];

  return (
    <div
      className={`bg-card rounded-lg border-l-4 ${STATUS_EDGE[status]} border-y border-r border-black/5 shadow-sm p-4 flex flex-col gap-3`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-4 min-w-0">
          <div className="font-mono font-bold text-2xl text-ink tracking-tight w-20 shrink-0">
            {tokenNumber}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">
              {jobs.length} documents · one order
            </div>
            <div className="text-xs text-collected mt-0.5">
              {STATUS_LABEL[status]} · {timeAgo(oldestCreatedAt)}
            </div>
            {jobs[0].studentPhone && (
              <a
                href={`tel:${jobs[0].studentPhone}`}
                className="text-xs text-ink hover:underline inline-block mt-0.5"
                title="Tap to call the student"
              >
                📞 {jobs[0].studentPhone}
              </a>
            )}
          </div>
        </div>

        {action && (
          <button
            onClick={() => onAdvanceAll(jobs, action.nextStatus)}
            disabled={busy}
            className={`w-full sm:w-auto shrink-0 text-white text-sm font-medium rounded-lg px-4 py-2.5 disabled:opacity-60 disabled:cursor-not-allowed transition-colors ${ACTION_BUTTON_COLOR[status]}`}
          >
            {busy ? "Updating…" : `${action.label} (all ${jobs.length})`}
          </button>
        )}
      </div>

      <div className="border-t border-black/5 pt-3 flex flex-col gap-2.5">
        {jobs.map((job) => (
          <div key={job.jobId} className="flex items-center justify-between gap-3 min-w-0">
            <div className="min-w-0">
              <PrintDetails job={job} />
              {job.fileName && (
                <div className="text-xs text-ink/70 truncate mt-0.5" title={job.fileName}>
                  {job.fileName}
                </div>
              )}
            </div>
            <a
              href={job.fileUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-teal hover:underline shrink-0"
            >
              View file ↗
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
