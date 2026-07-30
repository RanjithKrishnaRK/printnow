import { useEffect, useState } from "react";
import { getLandmarks, createLandmark } from "../api";

export default function Landmarks({ token }) {
  const [landmarks, setLandmarks] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  function load() {
    setLoading(true);
    getLandmarks(token)
      .then(setLandmarks)
      .catch((err) => setError(err.message || "Could not load landmarks."))
      .finally(() => setLoading(false));
  }

  useEffect(load, [token]);

  async function handleAdd(e) {
    e.preventDefault();
    setAddError("");
    if (!name.trim()) return;
    setAdding(true);
    try {
      await createLandmark(token, name.trim());
      setName("");
      load();
    } catch (err) {
      setAddError(err.message || "Could not add landmark.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={handleAdd}
        className="bg-card rounded-xl shadow-sm border border-black/5 p-4 flex flex-col sm:flex-row gap-2 sm:items-end"
      >
        <div className="flex-1">
          <label className="block text-sm font-medium text-ink mb-1">Add a landmark</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. KPHB Colony"
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink"
          />
        </div>
        <button
          type="submit"
          disabled={adding || !name.trim()}
          className="bg-ink hover:bg-ink/90 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
        >
          {adding ? "Adding…" : "Add landmark"}
        </button>
      </form>
      {addError && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          {addError}
        </div>
      )}

      {loading ? (
        <div className="text-collected py-12 text-center">Loading landmarks…</div>
      ) : error ? (
        <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          {error}
        </div>
      ) : (
        <div className="bg-card rounded-xl shadow-sm border border-black/5 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-paper text-collected text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-right px-4 py-3 font-medium">Shops</th>
                <th className="text-left px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {landmarks.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-3 text-ink font-medium">{l.name}</td>
                  <td className="px-4 py-3 text-right text-ink">{l.shopCount}</td>
                  <td className="px-4 py-3 text-collected">
                    {new Date(l.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
