import { useEffect, useState } from "react";
import { getPriceRanges, createPriceRange, updatePriceRange, deletePriceRange } from "../api";

// Shop-customizable pricing tiers by TOTAL printable pages across a
// document's copies (pages x copies) - e.g. 2 copies of a 5-page document
// (10 total pages) can be priced differently than a single 5-page copy.
// A matching range's rate REPLACES the shop's normal per-page rate
// entirely for that job - it's not an add-on. Single-sided only: a
// double-sided job always uses the double-sided pricing from the section
// above, completely unaffected by anything set here.
export default function VolumePricing({ shopId, token }) {
  const [ranges, setRanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editingId, setEditingId] = useState(null); // null = not editing, "new" = adding

  const [minPages, setMinPages] = useState("");
  const [maxPages, setMaxPages] = useState("");
  const [priceBw, setPriceBw] = useState("");
  const [priceColor, setPriceColor] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  function load() {
    setLoading(true);
    getPriceRanges(shopId, token)
      .then(setRanges)
      .catch((err) => setLoadError(err.message || "Could not load your volume pricing."))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId, token]);

  function resetForm() {
    setMinPages("");
    setMaxPages("");
    setPriceBw("");
    setPriceColor("");
    setFormError("");
  }

  function startAdd() {
    resetForm();
    // Suggest starting right after the current highest range, so ranges a
    // shop adds one at a time naturally chain without gaps or overlaps.
    const highest = ranges.reduce((max, r) => Math.max(max, r.maxPages), 0);
    setMinPages(String(highest + 1));
    setEditingId("new");
  }

  function startEdit(r) {
    setMinPages(String(r.minPages));
    setMaxPages(String(r.maxPages));
    setPriceBw(String(r.priceBw));
    setPriceColor(String(r.priceColor));
    setFormError("");
    setEditingId(r.id);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError("");
    const min = parseInt(minPages, 10);
    const max = parseInt(maxPages, 10);
    const bw = parseInt(priceBw, 10);
    const color = parseInt(priceColor, 10);
    if (!Number.isInteger(min) || min < 1) {
      return setFormError("Minimum pages must be a whole number of at least 1.");
    }
    if (!Number.isInteger(max) || max < min) {
      return setFormError("Maximum pages must be a whole number greater than or equal to the minimum.");
    }
    if (!Number.isInteger(bw) || bw < 1) {
      return setFormError("B&W price must be a whole number of at least ₹1.");
    }
    if (!Number.isInteger(color) || color < 1) {
      return setFormError("Color price must be a whole number of at least ₹1.");
    }

    setSaving(true);
    try {
      const range = { minPages: min, maxPages: max, priceBw: bw, priceColor: color };
      if (editingId === "new") {
        await createPriceRange(shopId, token, range);
      } else {
        await updatePriceRange(shopId, token, editingId, range);
      }
      setEditingId(null);
      resetForm();
      load();
    } catch (err) {
      setFormError(err.message || "Could not save that price range.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(r) {
    if (!window.confirm(`Remove the ${r.minPages}-${r.maxPages} page range? Orders in that range will go back to your normal pricing.`)) {
      return;
    }
    setBusyId(r.id);
    try {
      await deletePriceRange(shopId, token, r.id);
      setRanges((prev) => prev.filter((row) => row.id !== r.id));
    } catch (err) {
      setLoadError(err.message || "Could not remove that price range.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="bg-card rounded-xl shadow-sm border border-black/5 p-6 max-w-xl">
      <h2 className="font-display font-bold text-lg text-ink mb-1">Volume pricing</h2>
      <p className="text-sm text-collected mb-4">
        Price by total pages printed (pages × copies) - e.g. 2 copies of a 5-page document counts
        as 10 total pages. A matching range replaces your normal per-page price for that order.
        Single-sided only; double-sided pricing above is unaffected. Orders outside every range
        below use your normal pricing.
      </p>

      {loading ? (
        <p className="text-sm text-collected">Loading…</p>
      ) : (
        <>
          {loadError && (
            <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              {loadError}
            </div>
          )}

          {ranges.length === 0 && editingId !== "new" && (
            <p className="text-sm text-collected mb-3">No volume pricing set - every order uses your normal rate.</p>
          )}

          <div className="space-y-2 mb-3">
            {ranges.map((r) => (
              <div
                key={r.id}
                className="rounded-lg border border-black/10 bg-paper px-4 py-3 flex items-center justify-between gap-3"
              >
                <div>
                  <p className="text-sm font-medium text-ink">{r.minPages}-{r.maxPages} total pages</p>
                  <p className="text-xs text-collected">₹{r.priceBw}/page b&amp;w · ₹{r.priceColor}/page color</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={() => startEdit(r)}
                    className="text-xs font-medium text-teal hover:text-teal-dark"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(r)}
                    disabled={busyId === r.id}
                    className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          {editingId !== null ? (
            <form onSubmit={handleSubmit} className="rounded-lg border border-black/10 bg-paper p-4">
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-medium text-ink mb-1">Min. total pages</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    required
                    value={minPages}
                    onChange={(e) => setMinPages(e.target.value)}
                    className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-teal"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink mb-1">Max. total pages</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    required
                    value={maxPages}
                    onChange={(e) => setMaxPages(e.target.value)}
                    className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-teal"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-medium text-ink mb-1">₹/page, B&amp;W</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    required
                    value={priceBw}
                    onChange={(e) => setPriceBw(e.target.value)}
                    className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-teal"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink mb-1">₹/page, color</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    required
                    value={priceColor}
                    onChange={(e) => setPriceColor(e.target.value)}
                    className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-teal"
                  />
                </div>
              </div>

              {formError && <p className="text-xs text-red-600 mb-3">{formError}</p>}

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={saving}
                  className="bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  {saving ? "Saving…" : editingId === "new" ? "Add range" : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(null);
                    resetForm();
                  }}
                  className="text-sm text-collected hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={startAdd}
              className="text-sm font-medium text-teal hover:text-teal-dark"
            >
              + Add a price range
            </button>
          )}
        </>
      )}
    </div>
  );
}
