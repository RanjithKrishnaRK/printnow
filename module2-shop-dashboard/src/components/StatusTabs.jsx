const TABS = [
  { key: "queued", label: "Queued", dot: "bg-queued" },
  { key: "printing", label: "Printing", dot: "bg-printing" },
  { key: "ready", label: "Ready", dot: "bg-ready" },
  { key: "history", label: "History", dot: "bg-collected" },
];

export default function StatusTabs({ active, onChange, counts }) {
  return (
    <div className="flex gap-1 bg-black/5 rounded-lg p-1 w-fit">
      {TABS.map((tab) => {
        const isActive = active === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              isActive ? "bg-card text-ink shadow-sm" : "text-collected hover:text-ink"
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${tab.dot}`} />
            {tab.label}
            {tab.key !== "history" && counts[tab.key] !== undefined && (
              <span
                className={`text-xs font-mono px-1.5 rounded ${
                  isActive ? "bg-ink/10" : "bg-black/5"
                }`}
              >
                {counts[tab.key]}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
