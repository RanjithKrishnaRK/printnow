import { useCallback, useEffect, useState } from "react";
import { getShops, deleteShop } from "../api";
import ShopDetail from "./ShopDetail";

const POLL_MS = 15000;

// Cashfree Easy Split onboarding state, at a glance across every shop -
// null/undefined means the shop hasn't started (their online payments
// still settle fully into this platform's own account, unsplit, exactly
// like before this feature existed).
function VendorStatusBadge({ status }) {
  if (!status) {
    return <span className="text-xs text-collected">Not set up</span>;
  }
  const styles = {
    ACTIVE: "bg-ready/10 text-ready border-ready/20",
    PENDING: "bg-amber-50 text-amber-700 border-amber-200",
    IN_BENE_CREATION: "bg-amber-50 text-amber-700 border-amber-200",
    REJECTED: "bg-red-50 text-red-700 border-red-200",
  };
  const labels = {
    ACTIVE: "Active",
    PENDING: "Verifying",
    IN_BENE_CREATION: "Verifying",
    REJECTED: "Rejected",
  };
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${
        styles[status] || "bg-black/5 text-collected border-black/10"
      }`}
    >
      {labels[status] || status}
    </span>
  );
}

export default function Shops({ token }) {
  const [shops, setShops] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const [detailShop, setDetailShop] = useState(null);

  const loadShops = useCallback(async () => {
    try {
      const rows = await getShops(token);
      setShops(rows);
      setError("");
    } catch (err) {
      setError(err.message || "Could not load shops.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Auto-refresh, same pattern as Module 2's shop dashboard, so newly
  // signed-up (or removed) shops show up here without a manual reload.
  useEffect(() => {
    loadShops();
    const interval = setInterval(loadShops, POLL_MS);
    return () => clearInterval(interval);
  }, [loadShops]);

  async function handleDelete(shop) {
    const confirmed = window.confirm(
      `Delete "${shop.name}"? This permanently removes the shop and all its print job history. This cannot be undone.`
    );
    if (!confirmed) return;

    setDeletingId(shop.shopId);
    // Optimistic removal, rolled back on failure below.
    const prevShops = shops;
    setShops((prev) => prev.filter((s) => s.shopId !== shop.shopId));
    try {
      await deleteShop(token, shop.shopId);
    } catch (err) {
      setError(err.message || "Could not delete shop.");
      setShops(prevShops);
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) return <div className="text-collected py-12 text-center">Loading shops…</div>;

  return (
    <div>
      <div className="flex items-center justify-end mb-3">
        <button
          onClick={loadShops}
          className="text-sm text-collected hover:text-ink flex items-center gap-1.5"
        >
          ↻ Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="bg-card rounded-xl shadow-sm border border-black/5 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-paper text-collected text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Shop</th>
                <th className="text-left px-4 py-3 font-medium">Email</th>
                <th className="text-left px-4 py-3 font-medium">Landmark</th>
                <th className="text-left px-4 py-3 font-medium">Payouts</th>
                <th className="text-right px-4 py-3 font-medium">Total jobs</th>
                <th className="text-right px-4 py-3 font-medium">Revenue</th>
                <th className="text-left px-4 py-3 font-medium">Registered</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {shops.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center text-collected py-10">
                    No shops registered yet.
                  </td>
                </tr>
              ) : (
                shops.map((s) => (
                  <tr key={s.shopId}>
                    <td className="px-4 py-3 text-ink font-medium">
                      <button
                        onClick={() => setDetailShop(s)}
                        className="hover:underline text-left"
                        title="View earnings, payment breakdown, and reviews"
                      >
                        {s.name}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-collected">{s.email}</td>
                    <td className="px-4 py-3 text-collected">{s.landmarkName || "—"}</td>
                    <td className="px-4 py-3">
                      <VendorStatusBadge status={s.vendorStatus} />
                    </td>
                    <td className="px-4 py-3 text-right text-ink">{s.totalJobs}</td>
                    <td className="px-4 py-3 text-right text-ink font-medium">
                      ₹{s.totalRevenue?.toLocaleString?.("en-IN") ?? s.totalRevenue}
                    </td>
                    <td className="px-4 py-3 text-collected">
                      {new Date(s.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleDelete(s)}
                        disabled={deletingId === s.shopId}
                        className="text-xs text-red-600 hover:text-red-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {deletingId === s.shopId ? "Deleting…" : "Delete"}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detailShop && (
        <ShopDetail token={token} shop={detailShop} onClose={() => setDetailShop(null)} />
      )}
    </div>
  );
}
