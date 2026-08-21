import { useEffect, useState } from "react";
import { getUploadFlags, updateUploadFlags } from "../api";

// Controls whether the student app offers .docx / photo uploads at all.
// docx-to-pdf conversion needs LibreOffice on PATH, which only exists on a
// Docker-based backend deploy - it silently fails on the current native
// Node runtime. Rather than remove the feature from the codebase, it's
// gated behind this toggle (off by default) so it can be switched back on
// with zero code changes once the backend actually moves to Docker.
export default function UploadFlags({ token }) {
  const [docxConversionEnabled, setDocxConversionEnabled] = useState(false);
  const [imageConversionEnabled, setImageConversionEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getUploadFlags(token)
      .then((flags) => {
        if (cancelled) return;
        setDocxConversionEnabled(flags.docxConversionEnabled);
        setImageConversionEnabled(flags.imageConversionEnabled);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Could not load upload settings.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleToggle(field, value) {
    setError("");
    setSuccess(false);
    const previous = { docxConversionEnabled, imageConversionEnabled };
    const next = {
      docxConversionEnabled: field === "docx" ? value : docxConversionEnabled,
      imageConversionEnabled: field === "image" ? value : imageConversionEnabled,
    };
    // Optimistic - flips immediately, rolls back to `previous` below only
    // if the save fails.
    setDocxConversionEnabled(next.docxConversionEnabled);
    setImageConversionEnabled(next.imageConversionEnabled);
    setSaving(true);
    try {
      const updated = await updateUploadFlags(token, next);
      setDocxConversionEnabled(updated.docxConversionEnabled);
      setImageConversionEnabled(updated.imageConversionEnabled);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 1500);
    } catch (err) {
      setDocxConversionEnabled(previous.docxConversionEnabled);
      setImageConversionEnabled(previous.imageConversionEnabled);
      setError(err.message || "Could not save that change.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-card rounded-xl shadow-sm border border-black/5 p-6 max-w-md">
      <h2 className="font-display font-bold text-lg text-ink mb-1">Upload conversions</h2>
      <p className="text-sm text-collected mb-4">
        Controls what file types the student app offers for upload. Turning one off doesn't
        remove the feature - just hides it until you turn it back on.
      </p>

      {loading ? (
        <p className="text-sm text-collected">Loading…</p>
      ) : (
        <div className="space-y-3">
          <label className="flex items-start gap-3 rounded-lg border border-black/10 p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={docxConversionEnabled}
              onChange={(e) => handleToggle("docx", e.target.checked)}
              disabled={saving}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              <span className="block text-sm font-medium text-ink">
                Word document (.docx) upload
              </span>
              <span className="block text-xs text-collected mt-0.5">
                Needs LibreOffice on the server (Docker deploy only) - leave off unless you've
                confirmed that's set up, or students will see conversion errors.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 rounded-lg border border-black/10 p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={imageConversionEnabled}
              onChange={(e) => handleToggle("image", e.target.checked)}
              disabled={saving}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              <span className="block text-sm font-medium text-ink">Photo (JPEG/PNG) upload</span>
              <span className="block text-xs text-collected mt-0.5">
                Converts entirely in the student's browser - works regardless of hosting.
              </span>
            </span>
          </label>
        </div>
      )}

      {error && (
        <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      {success && <p className="mt-3 text-sm text-ready font-medium">Saved.</p>}
    </div>
  );
}
