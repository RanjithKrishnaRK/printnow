import { useEffect, useState } from "react";
import { getSettings } from "../api";

// Read-only account facts - email, when the shop joined, which campus/area
// it's listed under. Reuses the same getSettings() call Settings.jsx
// already makes on load (the backend's GET /:shopId/settings route
// includes these fields alongside the editable ones), so this doesn't add
// a second endpoint or a second round trip for data that's already right
// there. Nothing on this screen is editable - changing your password
// lives in Settings, and email isn't changeable at all in this version.
export default function Profile({ shopId, token, onBack }) {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSettings(shopId, token)
      .then(setSettings)
      .catch((err) => setError(err.message || "Could not load your account details."))
      .finally(() => setLoading(false));
  }, [shopId, token]);

  const joined = settings?.createdAt
    ? new Date(settings.createdAt).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })
    : null;

  const rows = settings
    ? [
        { label: "Shop name", value: settings.name },
        { label: "Registered email", value: settings.email },
        { label: "Campus / area", value: settings.landmarkName || "—" },
        { label: "Shop ID", value: shopId, mono: true },
        { label: "Member since", value: joined || "—" },
      ]
    : [];

  return (
    <div className="min-h-screen bg-paper">
      <header className="bg-ink text-white px-4 sm:px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded bg-teal flex items-center justify-center shrink-0">
            <span className="font-mono font-bold text-white text-xs">P</span>
          </div>
          <span className="font-display font-bold text-xl tracking-tight">PrintNow</span>
        </div>
        <button onClick={onBack} className="text-sm text-white/70 hover:text-white transition-colors">
          ← Back
        </button>
      </header>

      <main className="max-w-xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="font-display font-bold text-2xl text-ink mb-1">Profile</h1>
        <p className="text-sm text-collected mb-6">Your shop's registered account details.</p>

        {loading ? (
          <p className="text-sm text-collected">Loading…</p>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : (
          <div className="bg-card rounded-xl shadow-sm border border-black/5 divide-y divide-black/5">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-4 px-5 py-4">
                <span className="text-sm text-collected">{r.label}</span>
                <span className={`text-sm text-ink text-right ${r.mono ? "font-mono text-xs" : "font-medium"}`}>
                  {r.value}
                </span>
              </div>
            ))}
          </div>
        )}

        <p className="mt-4 text-xs text-collected">
          Need to change your registered email, or something here looks wrong? Contact the
          PrintNow team for help.
        </p>
      </main>
    </div>
  );
}
