// A single job rendered as a "ticket stub" - the colored left edge mirrors
// the physical colored paper stubs shops already use, so status is readable
// at a glance from across the counter.
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
          <PrintDetails job={job} />
          {job.fileName && (
            <div className="text-xs text-ink/70 truncate mt-0.5" title={job.fileName}>
              {job.fileName}
            </div>
          )}
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
