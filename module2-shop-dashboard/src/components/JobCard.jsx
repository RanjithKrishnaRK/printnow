// A single job rendered as a "ticket stub" - the colored left edge mirrors
// the physical colored paper stubs shops already use, so status is readable
// at a glance from across the counter.

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

// The single next action available per status. Cancelling isn't in Module
// 2's v1 scope, so there's no action rendered for it - flagged in README.
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

export default function JobCard({ job, onAdvance, busy }) {
  const action = NEXT_ACTION[job.status];

  return (
    <div
      className={`bg-card rounded-lg border-l-4 ${STATUS_EDGE[job.status]} border-y border-r border-black/5 shadow-sm p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4`}
    >
      <div className="flex items-center gap-4 min-w-0">
        <div className="font-mono font-bold text-2xl text-ink tracking-tight w-20 shrink-0">
          {job.tokenNumber}
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-ink font-medium">
            <span className="font-mono">
              {job.pages}p × {job.copies}
            </span>
            <span
              className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                job.colorMode === "color" || job.colorMode === "mixed"
                  ? "bg-printing/10 text-printing"
                  : "bg-ink/10 text-ink"
              }`}
            >
              {job.colorMode === "color"
                ? "Color"
                : job.colorMode === "mixed"
                ? `Mixed (pg ${job.colorPages})`
                : "B&W"}
            </span>
            {job.sides === "double" && (
              <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-ink/10 text-ink">
                2-sided
              </span>
            )}
          </div>
          <div className="text-xs text-collected mt-0.5">
            {STATUS_LABEL[job.status]} · {timeAgo(job.createdAt)}
          </div>
          {job.studentPhone && (
            <a
              href={`tel:${job.studentPhone}`}
              className="text-xs text-ink hover:underline inline-block mt-0.5"
              title="Tap to call the student"
            >
              📞 {job.studentPhone}
            </a>
          )}
          <a
            href={job.fileUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-teal hover:underline inline-block mt-1"
          >
            View file ↗
          </a>
        </div>
      </div>

      {action && (
        <button
          onClick={() => onAdvance(job, action.nextStatus)}
          disabled={busy}
          className={`w-full sm:w-auto shrink-0 text-white text-sm font-medium rounded-lg px-4 py-2.5 disabled:opacity-60 disabled:cursor-not-allowed transition-colors ${ACTION_BUTTON_COLOR[job.status]}`}
        >
          {busy ? "Updating…" : action.label}
        </button>
      )}
    </div>
  );
}
