import { useEffect, useState } from "react";
import { getUsers, getUserDetail } from "../api";

const STATUS_LABELS = {
  uploaded: "Uploaded (unpaid)",
  payment_pending: "Payment pending review",
  queued: "Queued",
  printing: "Printing",
  ready: "Ready for pickup",
  collected: "Collected",
};

const METHOD_LABELS = { cash: "Cash", razorpay: "Online", upi: "Online (legacy UPI)" };

function formatDate(d) {
  return new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// Every student/customer who's ever placed an order anywhere on the
// platform, one row per phone number - not scoped to a single shop, since
// the admin's job is seeing the whole platform. Clicking a row drills into
// that customer's full order history (which shop, how much, when).
export default function Users({ token }) {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedPhone, setSelectedPhone] = useState(null);

  function load(q) {
    setLoading(true);
    setError("");
    getUsers(token, q)
      .then(setUsers)
      .catch((err) => setError(err.message || "Could not load customers."))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    const handle = setTimeout(() => load(query), 300); // debounce as they type
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-display font-bold text-2xl text-ink">Customers</h1>
        <input
          type="text"
          placeholder="Search name or phone…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-56 rounded-lg border border-black/10 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink"
        />
      </div>

      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : loading ? (
        <p className="text-sm text-collected py-8 text-center">Loading…</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-collected py-8 text-center border border-dashed border-black/10 rounded-xl">
          {query ? "No customers match that search." : "No customers yet."}
        </p>
      ) : (
        <div className="bg-card rounded-xl shadow-sm border border-black/5 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper text-collected text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium">Name</th>
                  <th className="text-left px-4 py-2.5 font-medium">Phone</th>
                  <th className="text-right px-4 py-2.5 font-medium">Jobs</th>
                  <th className="text-right px-4 py-2.5 font-medium">Total spent</th>
                  <th className="text-right px-4 py-2.5 font-medium">Shops used</th>
                  <th className="text-right px-4 py-2.5 font-medium">Last order</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {users.map((u) => (
                  <tr
                    key={u.phone}
                    onClick={() => setSelectedPhone(u.phone)}
                    className="cursor-pointer hover:bg-paper transition-colors"
                  >
                    <td className="px-4 py-2.5 text-ink font-medium">{u.name || "—"}</td>
                    <td className="px-4 py-2.5 text-collected font-mono">{u.phone}</td>
                    <td className="px-4 py-2.5 text-right text-collected">{u.totalJobs}</td>
                    <td className="px-4 py-2.5 text-right text-ink font-medium">
                      ₹{u.totalSpent.toLocaleString("en-IN")}
                    </td>
                    <td className="px-4 py-2.5 text-right text-collected">{u.shopsUsed}</td>
                    <td className="px-4 py-2.5 text-right text-collected">{formatDate(u.lastOrderAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedPhone && (
        <UserDetailModal token={token} phone={selectedPhone} onClose={() => setSelectedPhone(null)} />
      )}
    </div>
  );
}

function UserDetailModal({ token, phone, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getUserDetail(token, phone)
      .then(setDetail)
      .catch((err) => setError(err.message || "Could not load this customer's history."))
      .finally(() => setLoading(false));
  }, [token, phone]);

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 p-3 sm:p-6">
      <div className="bg-card rounded-xl shadow-xl border border-black/5 w-full max-w-2xl my-6 max-h-[90vh] flex flex-col">
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-black/5">
          <div>
            <h2 className="text-lg font-semibold text-ink">{detail?.name || "Customer"}</h2>
            <p className="text-xs text-collected font-mono">{phone}</p>
          </div>
          <button onClick={onClose} className="text-collected hover:text-ink text-sm font-medium shrink-0">
            Close
          </button>
        </div>

        <div className="px-5 py-4 space-y-6 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-collected py-8 text-center">Loading…</p>
          ) : error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : (
            <>
              <section>
                <h3 className="text-xs font-medium uppercase tracking-wide text-collected mb-2">
                  Spend by shop
                </h3>
                <div className="space-y-1.5">
                  {detail.byShop.map((s) => (
                    <div
                      key={s.shopId}
                      className="flex items-center justify-between rounded-lg border border-black/5 bg-paper px-3 py-2 text-sm"
                    >
                      <span className="text-ink font-medium">{s.shopName}</span>
                      <span className="text-collected">
                        {s.totalJobs} jobs · <span className="text-ink font-medium">₹{s.totalSpent}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="text-xs font-medium uppercase tracking-wide text-collected mb-2">
                  Order history
                </h3>
                <div className="overflow-x-auto rounded-lg border border-black/5">
                  <table className="w-full text-sm">
                    <thead className="bg-paper text-collected text-xs uppercase tracking-wide">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Date</th>
                        <th className="text-left px-3 py-2 font-medium">Shop</th>
                        <th className="text-left px-3 py-2 font-medium">Status</th>
                        <th className="text-left px-3 py-2 font-medium">Paid via</th>
                        <th className="text-right px-3 py-2 font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-black/5">
                      {detail.orders.map((o) => (
                        <tr key={o.jobId}>
                          <td className="px-3 py-2 text-collected whitespace-nowrap">{formatDate(o.createdAt)}</td>
                          <td className="px-3 py-2 text-ink">{o.shopName}</td>
                          <td className="px-3 py-2 text-collected">{STATUS_LABELS[o.status] || o.status}</td>
                          <td className="px-3 py-2 text-collected">
                            {o.paymentMethod ? METHOD_LABELS[o.paymentMethod] || o.paymentMethod : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-ink font-medium">₹{o.amountDue}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
