// Shared "highlighted" print-details badges: pages×copies, color/b&w/mixed,
// 2-sided. Pulled out of JobCard so BatchCard's per-document rows can show
// the exact same at-a-glance treatment without duplicating the markup.
export default function PrintDetails({ job }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink font-medium flex-wrap">
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
  );
}
