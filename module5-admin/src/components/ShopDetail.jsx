import { useEffect, useState } from "react";
import {
  getShopStats,
  getShopReviews,
  createFakeReview,
  setReviewVisibility,
  deleteReview,
} from "../api";

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
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 p-3 sm:p-6 overflow-y-auto">
      <div className="bg-card rounded-xl shadow-xl border border-black/5 w-full max-w-2xl my-6">
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/5">
          <div>
            <h2 className="text-lg font-semibold text-ink">{shop.name}</h2>
            <p className="text-xs text-collected">{shop.email}</p>
          </div>
          <button onClick={onClose} className="text-collected hover:text-ink text-sm font-medium">
            Close
          </button>
        </div>

        <div className="px-5 py-4 space-y-6">
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
                        <MoneyRow label="UPI" total={stats.todayByMethod.upi} />
                      </div>
                    </div>
                    <div className="rounded-lg border border-black/5 bg-paper px-4 py-3">
                      <p className="text-xs text-collected mb-1">All time</p>
                      <p className="text-xl font-semibold text-ink font-mono mb-2">
                        ₹{stats.totalEarnings?.toLocaleString?.("en-IN") ?? stats.totalEarnings}
                      </p>
                      <div className="border-t border-black/5 pt-1.5">
                        <MoneyRow label="Cash" total={stats.totalByMethod.cash} />
                        <MoneyRow label="UPI" total={stats.totalByMethod.upi} />
                      </div>
                    </div>
                  </div>
                )}
              </section>

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
