import { useEffect, useState } from "react";
import {
  getShopStats,
  getShopReviews,
  createFakeReview,
  setReviewVisibility,
  deleteReview,
  getShopSettlements,
  createSettlement,
  updateSettlement,
  deleteSettlement,
  generateShopTempPassword,
} from "../api";

const SETTLEMENT_MODES = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "upi", label: "UPI" },
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
  { value: "other", label: "Other" },
];

const STAR = "★";

function Stars({ rating }) {
  return (
    <span className="text-amber-500 tracking-tight">
      {STAR.repeat(rating)}
      <span className="text-black/15">{STAR.repeat(5 - rating)}</span>
    </span>
  );
}

function MoneyRow({ label, total, count }) {
  return (
    <div className="flex items-center justify-between text-sm py-1.5">
      <span className="text-collected">
        {label}
        {typeof count === "number" && <span className="text-collected/70"> · {count} jobs</span>}
      </span>
      <span className="font-mono font-medium text-ink">₹{total?.toLocaleString?.("en-IN") ?? total}</span>
    </div>
  );
}

export default function ShopDetail({ token, shop, onClose }) {
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState("");
  const [reviews, setReviews] = useState([]);
  const [reviewsError, setReviewsError] = useState("");
  const [loading, setLoading] = useState(true);

  // Fake-review form
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [busyReviewId, setBusyReviewId] = useState(null);

  function loadReviews() {
    return getShopReviews(token, shop.shopId)
      .then(setReviews)
      .catch((err) => setReviewsError(err.message || "Could not load reviews."));
  }

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getShopStats(token, shop.shopId).then(setStats).catch((err) => setStatsError(err.message || "Could not load stats.")),
      loadReviews(),
    ]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, shop.shopId]);

  async function handleAddReview(e) {
    e.preventDefault();
    setAddError("");
    if (!authorName.trim()) {
      setAddError("Author name is required.");
      return;
    }
    setAdding(true);
    try {
      await createFakeReview(token, shop.shopId, {
        rating,
        comment: comment.trim() || undefined,
        authorName: authorName.trim(),
      });
      setComment("");
      setAuthorName("");
      setRating(5);
      await loadReviews();
    } catch (err) {
      setAddError(err.message || "Could not add review.");
    } finally {
      setAdding(false);
    }
  }

  async function handleToggleVisible(review) {
    setBusyReviewId(review.id);
    const prev = reviews;
    setReviews((rs) => rs.map((r) => (r.id === review.id ? { ...r, visible: !r.visible } : r)));
    try {
      await setReviewVisibility(token, review.id, !review.visible);
    } catch (err) {
      setReviewsError(err.message || "Could not update review.");
      setReviews(prev);
    } finally {
      setBusyReviewId(null);
    }
  }

  async function handleDeleteReview(review) {
    if (!window.confirm("Delete this review? This cannot be undone.")) return;
    setBusyReviewId(review.id);
    const prev = reviews;
    setReviews((rs) => rs.filter((r) => r.id !== review.id));
    try {
      await deleteReview(token, review.id);
    } catch (err) {
      setReviewsError(err.message || "Could not delete review.");
      setReviews(prev);
    } finally {
      setBusyReviewId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 p-3 sm:p-6">
      <div className="bg-card rounded-xl shadow-xl border border-black/5 w-full max-w-2xl my-6 max-h-[90vh] flex flex-col">
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-black/5">
          <div>
            <h2 className="text-lg font-semibold text-ink">{shop.name}</h2>
            <p className="text-xs text-collected">{shop.email}</p>
          </div>
          <button onClick={onClose} className="text-collected hover:text-ink text-sm font-medium shrink-0">
            Close
          </button>
        </div>

        <div className="px-5 py-4 space-y-6 overflow-y-auto">
          {loading ? (
            <div className="text-collected py-8 text-center text-sm">Loading…</div>
          ) : (
            <>
              {/* Financial breakdown */}
              <section>
                <h3 className="text-xs font-medium uppercase tracking-wide text-collected mb-2">
                  Earnings
                </h3>
                {statsError ? (
                  <p className="text-sm text-red-600">{statsError}</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="rounded-lg border border-black/5 bg-paper px-4 py-3">
                      <p className="text-xs text-collected mb-1">Today</p>
                      <p className="text-xl font-semibold text-ink font-mono mb-2">
                        ₹{stats.todayEarnings?.toLocaleString?.("en-IN") ?? stats.todayEarnings}
                      </p>
                      <div className="border-t border-black/5 pt-1.5">
                        <MoneyRow label="Cash" total={stats.todayByMethod.cash} />
                        <MoneyRow label="Online" total={stats.todayByMethod.online} />
                      </div>
                    </div>
                    <div className="rounded-lg border border-black/5 bg-paper px-4 py-3">
                      <p className="text-xs text-collected mb-1">All time</p>
                      <p className="text-xl font-semibold text-ink font-mono mb-2">
                        ₹{stats.totalEarnings?.toLocaleString?.("en-IN") ?? stats.totalEarnings}
                      </p>
                      <div className="border-t border-black/5 pt-1.5">
                        <MoneyRow label="Cash" total={stats.totalByMethod.cash} />
                        <MoneyRow label="Online" total={stats.totalByMethod.online} />
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {/* Temporary password - the whole "forgot password" flow for shops */}
              <TempPasswordSection token={token} shop={shop} />

              {/* Settlements - payouts of this shop's online earnings */}
              <SettlementsSection token={token} shop={shop} stats={stats} statsError={statsError} />

              {/* Reviews */}
              <section>
                <h3 className="text-xs font-medium uppercase tracking-wide text-collected mb-2">
                  Reviews
                </h3>

                <form
                  onSubmit={handleAddReview}
                  className="rounded-lg border border-dashed border-black/15 bg-paper px-4 py-3 mb-3 space-y-2"
                >
                  <p className="text-xs text-collected mb-1">
                    Add a review as this shop — shows to students identically to a real one. Use
                    this to seed early social proof; phase these out as real reviews come in.
                  </p>
                  <div className="flex flex-wrap gap-2 items-center">
                    <select
                      value={rating}
                      onChange={(e) => setRating(Number(e.target.value))}
                      className="rounded-lg border border-black/10 px-2.5 py-2 text-sm bg-card"
                    >
                      {[5, 4, 3, 2, 1].map((n) => (
                        <option key={n} value={n}>
                          {n} star{n > 1 ? "s" : ""}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={authorName}
                      onChange={(e) => setAuthorName(e.target.value)}
                      placeholder="Author name (e.g. Priya S.)"
                      className="flex-1 min-w-[140px] rounded-lg border border-black/10 px-3 py-2 text-sm bg-card"
                    />
                  </div>
                  <input
                    type="text"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Comment (optional)"
                    className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm bg-card"
                  />
                  {addError && <p className="text-xs text-red-600">{addError}</p>}
                  <button
                    type="submit"
                    disabled={adding}
                    className="bg-ink hover:bg-ink/90 disabled:opacity-60 text-white text-sm font-medium rounded-lg px-3.5 py-2 transition-colors"
                  >
                    {adding ? "Adding…" : "Add review"}
                  </button>
                </form>

                {reviewsError && <p className="text-sm text-red-600 mb-2">{reviewsError}</p>}

                {reviews.length === 0 ? (
                  <p className="text-sm text-collected py-4 text-center">No reviews yet.</p>
                ) : (
                  <div className="space-y-2">
                    {reviews.map((r) => (
                      <div
                        key={r.id}
                        className={`rounded-lg border px-3.5 py-2.5 text-sm ${
                          r.visible ? "border-black/5 bg-card" : "border-black/5 bg-paper opacity-60"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <Stars rating={r.rating} />
                            <span className="font-medium text-ink">{r.authorName}</span>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide ${
                                r.source === "fake" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
                              }`}
                            >
                              {r.source === "fake" ? "Added by admin" : "Real order"}
                            </span>
                            {!r.visible && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide bg-black/5 text-collected">
                                Hidden
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs">
                            <button
                              onClick={() => handleToggleVisible(r)}
                              disabled={busyReviewId === r.id}
                              className="text-collected hover:text-ink font-medium disabled:opacity-50"
                            >
                              {r.visible ? "Hide" : "Show"}
                            </button>
                            <button
                              onClick={() => handleDeleteReview(r)}
                              disabled={busyReviewId === r.id}
                              className="text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        {r.comment && <p className="text-ink mt-1">{r.comment}</p>}
                        <p className="text-collected text-xs mt-1">
                          {new Date(r.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Self-contained: loads its own settlement list and owns the add/edit form,
// so ShopDetail's already-large state doesn't have to grow just for this.
// Settlements are only ever recorded against ONLINE earnings - cash never
// needs settling since the shop owner already has it in hand.
// Self-contained: this IS the whole "forgot password" flow for shops - no
// email, no self-service. The admin generates a 6-digit numeric password
// valid for 10 minutes, relays it to the shop owner directly (phone call,
// in person), and they log in with it via the normal shop login form. It's
// shown here once, right after generating it, and never retrievable again
// after this component's state resets (only the hash is stored server-side).
function TempPasswordSection({ token, shop }) {
  const [result, setResult] = useState(null); // { tempPassword, expiresAt } | null
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);

  async function handleGenerate() {
    setError("");
    setGenerating(true);
    try {
      const res = await generateShopTempPassword(token, shop.shopId);
      setResult(res);
    } catch (err) {
      setError(err.message || "Could not generate a temporary password.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section>
      <h3 className="text-xs font-medium uppercase tracking-wide text-collected mb-2">
        Shop owner locked out?
      </h3>
      <p className="text-xs text-collected mb-3">
        Generates a 6-digit temporary password, valid for 10 minutes. Tell it to the shop owner
        directly (phone/in person) - they log in with it on the normal login screen, then set a
        real password from Settings.
      </p>

      {result ? (
        <div className="rounded-lg border border-teal/30 bg-teal/5 px-4 py-3">
          <p className="text-xs text-collected mb-1">Temporary password (valid 10 minutes)</p>
          <p className="font-mono text-2xl font-bold tracking-[0.2em] text-ink mb-2">
            {result.tempPassword}
          </p>
          <p className="text-xs text-collected mb-3">
            Expires at {new Date(result.expiresAt).toLocaleTimeString()}. This won't be shown
            again after you leave this page.
          </p>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="text-xs font-medium text-teal hover:text-teal/80 disabled:opacity-50"
          >
            {generating ? "Generating…" : "Generate a new one"}
          </button>
        </div>
      ) : (
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="rounded-lg border border-black/10 bg-paper px-4 py-2 text-sm font-medium text-ink hover:bg-black/5 disabled:opacity-50 transition-colors"
        >
          {generating ? "Generating…" : "Generate temporary password"}
        </button>
      )}

      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
    </section>
  );
}


function SettlementsSection({ token, shop, stats, statsError }) {
  const [settlements, setSettlements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState(null); // null = not editing, "new" = adding
  const [amount, setAmount] = useState("");
  const [settledDate, setSettledDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState("bank_transfer");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [busyId, setBusyId] = useState(null);

  function load() {
    setLoading(true);
    getShopSettlements(token, shop.shopId)
      .then(setSettlements)
      .catch((err) => setError(err.message || "Could not load settlements."))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, shop.shopId]);

  function resetForm() {
    setAmount("");
    setSettledDate(new Date().toISOString().slice(0, 10));
    setMode("bank_transfer");
    setNote("");
    setFormError("");
  }

  function startAdd() {
    resetForm();
    // Pre-fill with the current unsettled amount, if known - the admin's
    // most common action is "pay out whatever's owed right now", so this
    // saves re-typing a number they can already see above.
    if (stats?.unsettledOnline > 0) setAmount(String(stats.unsettledOnline));
    setEditingId("new");
  }

  function startEdit(s) {
    setAmount(String(s.amount));
    setSettledDate(s.settledDate.slice(0, 10));
    setMode(s.mode);
    setNote(s.note || "");
    setFormError("");
    setEditingId(s.id);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError("");
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setFormError("Amount must be a positive number.");
      return;
    }
    if (!settledDate) {
      setFormError("Settlement date is required.");
      return;
    }
    setSaving(true);
    try {
      if (editingId === "new") {
        await createSettlement(token, shop.shopId, { amount: amountNum, settledDate, mode, note: note.trim() || undefined });
      } else {
        await updateSettlement(token, editingId, { amount: amountNum, settledDate, mode, note: note.trim() || undefined });
      }
      setEditingId(null);
      resetForm();
      load();
    } catch (err) {
      setFormError(err.message || "Could not save settlement.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(s) {
    if (!window.confirm(`Delete this ₹${s.amount} settlement? This cannot be undone.`)) return;
    setBusyId(s.id);
    try {
      await deleteSettlement(token, s.id);
      setSettlements((rows) => rows.filter((r) => r.id !== s.id));
    } catch (err) {
      setError(err.message || "Could not delete settlement.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-collected">Settlements</h3>
        {editingId === null && (
          <button
            onClick={startAdd}
            className="text-xs font-medium text-teal hover:text-teal/80"
          >
            + Record settlement
          </button>
        )}
      </div>

      {!statsError && stats && (
        <p className="text-xs text-collected mb-3">
          ₹{stats.settledTotal} settled so far · ₹{stats.unsettledOnline} still owed from online payments
        </p>
      )}

      {editingId !== null && (
        <form onSubmit={handleSubmit} className="rounded-lg border border-black/10 bg-paper px-4 py-3 mb-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs text-collected mb-1">Amount (₹)</label>
              <input
                type="number"
                min="0"
                step="1"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink"
              />
            </div>
            <div>
              <label className="block text-xs text-collected mb-1">Date</label>
              <input
                type="date"
                required
                value={settledDate}
                onChange={(e) => setSettledDate(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-collected mb-1">Mode of settlement</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink"
            >
              {SETTLEMENT_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-collected mb-1">Note (optional)</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. reference number, week covered"
              className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink"
            />
          </div>

          {formError && <p className="text-xs text-red-600">{formError}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="bg-ink hover:bg-ink/90 disabled:opacity-60 text-white text-sm font-medium rounded-lg px-3 py-1.5 transition-colors"
            >
              {saving ? "Saving…" : editingId === "new" ? "Add settlement" : "Save changes"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                resetForm();
              }}
              className="text-sm text-collected hover:text-ink px-3 py-1.5"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-collected py-3 text-center">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : settlements.length === 0 ? (
        <p className="text-sm text-collected py-3 text-center border border-dashed border-black/10 rounded-lg">
          No settlements recorded yet.
        </p>
      ) : (
        <div className="space-y-1.5">
          {settlements.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between rounded-lg border border-black/5 bg-paper px-3 py-2 text-sm"
            >
              <div>
                <span className="font-medium text-ink">₹{s.amount.toLocaleString("en-IN")}</span>
                <span className="text-collected">
                  {" "}
                  · {new Date(s.settledDate).toLocaleDateString()} ·{" "}
                  {SETTLEMENT_MODES.find((m) => m.value === s.mode)?.label || s.mode}
                  {s.note && <> · {s.note}</>}
                </span>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => startEdit(s)} className="text-xs text-collected hover:text-ink">
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(s)}
                  disabled={busyId === s.id}
                  className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
