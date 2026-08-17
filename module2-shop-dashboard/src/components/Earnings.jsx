import { useEffect, useState } from "react";
import { getEarnings, getEarningsHistory, getSettlements } from "../api";

const MODE_LABELS = {
  bank_transfer: "Bank transfer",
  upi: "UPI",
  cash: "Cash",
  cheque: "Cheque",
  other: "Other",
};

function formatPeriod(period, groupBy) {
  const d = new Date(period);
  if (groupBy === "year") return String(d.getUTCFullYear());
  if (groupBy === "month") return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function MoneyCard({ label, value, sub, highlight }) {
  return (
    <div className={`rounded-xl border px-4 py-3 shadow-sm ${highlight ? "border-teal/30 bg-teal/5" : "border-black/5 bg-card"}`}>
      <p className="text-xs uppercase tracking-wide text-collected">{label}</p>
      <p className="mt-1 font-display text-xl font-bold text-ink">
        ₹{value?.toLocaleString?.("en-IN") ?? value}
      </p>
      {sub && <p className="text-xs text-collected mt-0.5">{sub}</p>}
    </div>
  );
}

// This page is mainly for monitoring settlements: earnings are one thing,
// but the money that actually matters day-to-day for a shop owner is
// "how much has the platform actually paid me for online orders, and how
// much is still owed". Cash never appears in a settlement - the shop owner
// already has that cash in hand the moment a student pays over the counter.
export default function Earnings({ shopId, token, onBack }) {
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState("");
  const [groupBy, setGroupBy] = useState("day"); // "day" | "month" | "year"
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [settlements, setSettlements] = useState([]);
  const [settlementsError, setSettlementsError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getEarnings(shopId, token).then(setSummary).catch((e) => setSummaryError(e.message || "Could not load earnings.")),
      getSettlements(shopId, token).then(setSettlements).catch((e) => setSettlementsError(e.message || "Could not load settlement history.")),
    ]).finally(() => setLoading(false));
  }, [shopId, token]);

  useEffect(() => {
    setHistoryLoading(true);
    setHistoryError("");
    getEarningsHistory(shopId, token, groupBy)
      .then((data) => setHistory(data.history))
      .catch((e) => setHistoryError(e.message || "Could not load earnings history."))
      .finally(() => setHistoryLoading(false));
  }, [shopId, token, groupBy]);

  return (
    <div className="min-h-screen bg-paper">
      <header className="bg-ink text-white px-4 sm:px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-teal flex items-center justify-center shrink-0">
            <span className="font-mono font-bold text-white text-xs">P</span>
          </div>
          <span className="font-display font-bold text-xl tracking-tight">Earnings</span>
        </div>
        <button onClick={onBack} className="text-sm text-white/70 hover:text-white transition-colors">
          ← Back to dashboard
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-8">
        {loading ? (
          <div className="text-center text-collected py-16">Loading…</div>
        ) : (
          <>
            {summaryError && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                {summaryError}
              </div>
            )}

            {summary && (
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wide text-collected mb-2">
                  All-time
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <MoneyCard label="Total earnings" value={summary.totalEarnings} sub={`${summary.totalJobs} jobs`} />
                  <MoneyCard label="Cash at counter" value={summary.totalByMethod.cash} />
                  <MoneyCard label="Online payments" value={summary.totalByMethod.online} />
                  <MoneyCard
                    label="Owed to you"
                    value={summary.unsettledOnline}
                    sub={`of ₹${summary.totalByMethod.online} online, ₹${summary.settledTotal} settled`}
                    highlight={summary.unsettledOnline > 0}
                  />
                </div>
              </section>
            )}

            {/* Earnings history */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-medium uppercase tracking-wide text-collected">
                  Earnings history
                </h2>
                <div className="flex gap-1 rounded-lg bg-black/5 p-0.5">
                  {["day", "month", "year"].map((g) => (
                    <button
                      key={g}
                      onClick={() => setGroupBy(g)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                        groupBy === g ? "bg-card text-ink shadow-sm" : "text-collected hover:text-ink"
                      }`}
                    >
                      {g === "day" ? "Daily" : g === "month" ? "Monthly" : "Yearly"}
                    </button>
                  ))}
                </div>
              </div>

              {historyError ? (
                <p className="text-sm text-red-600">{historyError}</p>
              ) : historyLoading ? (
                <p className="text-sm text-collected py-6 text-center">Loading…</p>
              ) : history.length === 0 ? (
                <p className="text-sm text-collected py-6 text-center border border-dashed border-black/10 rounded-xl">
                  No confirmed earnings yet.
                </p>
              ) : (
                <div className="bg-card rounded-xl shadow-sm border border-black/5 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-paper text-collected text-xs uppercase tracking-wide">
                        <tr>
                          <th className="text-left px-4 py-2.5 font-medium">Period</th>
                          <th className="text-right px-4 py-2.5 font-medium">Cash</th>
                          <th className="text-right px-4 py-2.5 font-medium">Online</th>
                          <th className="text-right px-4 py-2.5 font-medium">Total</th>
                          <th className="text-right px-4 py-2.5 font-medium">Jobs</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-black/5">
                        {history.map((row) => (
                          <tr key={row.period}>
                            <td className="px-4 py-2.5 text-ink font-medium">{formatPeriod(row.period, groupBy)}</td>
                            <td className="px-4 py-2.5 text-right text-collected">₹{row.cash}</td>
                            <td className="px-4 py-2.5 text-right text-collected">₹{row.online}</td>
                            <td className="px-4 py-2.5 text-right text-ink font-medium">₹{row.total}</td>
                            <td className="px-4 py-2.5 text-right text-collected">{row.jobs}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>

            {/* Settlement history - read-only here, admin-managed */}
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wide text-collected mb-2">
                Settlement history
              </h2>
              <p className="text-xs text-collected mb-3">
                Payouts of your online earnings, recorded by PrintNow. Cash you collect yourself
                never appears here since it's already in your hand.
              </p>

              {settlementsError ? (
                <p className="text-sm text-red-600">{settlementsError}</p>
              ) : settlements.length === 0 ? (
                <p className="text-sm text-collected py-6 text-center border border-dashed border-black/10 rounded-xl">
                  No settlements recorded yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {settlements.map((s) => (
                    <div
                      key={s.id}
                      className="rounded-lg border border-black/5 bg-card px-4 py-3 flex items-center justify-between gap-3"
                    >
                      <div>
                        <p className="text-ink font-medium">₹{s.amount.toLocaleString("en-IN")}</p>
                        <p className="text-xs text-collected">
                          {new Date(s.settledDate).toLocaleDateString()} · {MODE_LABELS[s.mode] || s.mode}
                          {s.note && <> · {s.note}</>}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
