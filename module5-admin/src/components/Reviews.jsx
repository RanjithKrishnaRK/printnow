import { useEffect, useState } from "react";
import {
  getShops,
  getAllReviews,
  createReviewForShop,
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

// This feeds two places students see it: each shop's own rating in the
// browse list (GET /api/shops?landmarkId=), and the platform-wide "What
// students are saying" feed on the student app's front page
// (GET /api/reviews, module1's HomeStep) - one visible/hidden switch here
// controls both, there's no separate toggle for the front-page feed.
export default function Reviews({ token }) {
  const [shops, setShops] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [filterShopId, setFilterShopId] = useState("");

  // Add-review form
  const [formShopId, setFormShopId] = useState("");
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  function loadReviews() {
    return getAllReviews(token)
      .then(setReviews)
      .catch((err) => setError(err.message || "Could not load reviews."));
  }

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getShops(token).then(setShops).catch(() => {}),
      loadReviews(),
    ]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function handleAdd(e) {
    e.preventDefault();
    setAddError("");
    if (!formShopId) {
      setAddError("Choose a shop.");
      return;
    }
    if (!authorName.trim()) {
      setAddError("Author name is required.");
      return;
    }
    setAdding(true);
    try {
      await createReviewForShop(token, {
        shopId: formShopId,
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
    setBusyId(review.id);
    const prev = reviews;
    setReviews((rs) => rs.map((r) => (r.id === review.id ? { ...r, visible: !r.visible } : r)));
    try {
      await setReviewVisibility(token, review.id, !review.visible);
    } catch (err) {
      setError(err.message || "Could not update review.");
      setReviews(prev);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(review) {
    if (!window.confirm("Delete this review? This cannot be undone.")) return;
    setBusyId(review.id);
    const prev = reviews;
    setReviews((rs) => rs.filter((r) => r.id !== review.id));
    try {
      await deleteReview(token, review.id);
    } catch (err) {
      setError(err.message || "Could not delete review.");
      setReviews(prev);
    } finally {
      setBusyId(null);
    }
  }

  const visibleList = filterShopId ? reviews.filter((r) => r.shopId === filterShopId) : reviews;

  if (loading) return <div className="text-collected py-12 text-center text-sm">Loading…</div>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-ink mb-1">Reviews</h2>
        <p className="text-sm text-collected">
          Shown on each shop's own page and in the "What students are saying" feed on the student
          app's front page. Hiding a review here removes it from both places.
        </p>
      </div>

      <form onSubmit={handleAdd} className="rounded-lg border border-dashed border-black/15 bg-card px-4 py-4 space-y-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-collected mb-1">
          Add a review
        </p>
        <div className="flex flex-wrap gap-2">
          <select
            value={formShopId}
            onChange={(e) => setFormShopId(e.target.value)}
            className="rounded-lg border border-black/10 px-2.5 py-2 text-sm bg-paper min-w-[160px]"
          >
            <option value="">Choose a shop…</option>
            {shops.map((s) => (
              <option key={s.shopId} value={s.shopId}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            value={rating}
            onChange={(e) => setRating(Number(e.target.value))}
            className="rounded-lg border border-black/10 px-2.5 py-2 text-sm bg-paper"
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
            className="flex-1 min-w-[140px] rounded-lg border border-black/10 px-3 py-2 text-sm bg-paper"
          />
        </div>
        <input
          type="text"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Comment (optional)"
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm bg-paper"
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

      <div className="flex items-center gap-2">
        <label className="text-xs text-collected">Filter by shop:</label>
        <select
          value={filterShopId}
          onChange={(e) => setFilterShopId(e.target.value)}
          className="rounded-lg border border-black/10 px-2.5 py-1.5 text-sm bg-card"
        >
          <option value="">All shops</option>
          {shops.map((s) => (
            <option key={s.shopId} value={s.shopId}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {visibleList.length === 0 ? (
        <p className="text-sm text-collected py-8 text-center">No reviews yet.</p>
      ) : (
        <div className="space-y-2">
          {visibleList.map((r) => (
            <div
              key={r.id}
              className={`rounded-lg border px-4 py-3 text-sm ${
                r.visible ? "border-black/5 bg-card" : "border-black/5 bg-paper opacity-60"
              }`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <Stars rating={r.rating} />
                  <span className="font-medium text-ink">{r.authorName}</span>
                  <span className="text-xs text-collected">· {r.shopName}</span>
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
                    disabled={busyId === r.id}
                    className="text-collected hover:text-ink font-medium disabled:opacity-50"
                  >
                    {r.visible ? "Hide" : "Show"}
                  </button>
                  <button
                    onClick={() => handleDelete(r)}
                    disabled={busyId === r.id}
                    className="text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {r.comment && <p className="text-ink mt-1.5">{r.comment}</p>}
              <p className="text-collected text-xs mt-1">{new Date(r.createdAt).toLocaleDateString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
