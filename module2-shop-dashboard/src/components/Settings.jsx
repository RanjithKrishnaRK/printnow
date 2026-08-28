import { useEffect, useState } from "react";
import { getSettings, updateSettings, changePassword } from "../api";
import PayoutSettings from "./PayoutSettings";

// Shown two ways: (1) mandatory first screen right after signup, via
// `firstTime`, so a shop can't start receiving orders priced at nothing;
// (2) anytime after, from the dashboard header's "Settings" button. Both
// cases render the same form - `firstTime` only changes the framing copy
// and swaps "Cancel" for nothing (there's nothing to cancel back to yet).
export default function Settings({ shopId, token, firstTime = false, mustChangePassword = false, onDone }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const [priceBw, setPriceBw] = useState("");
  const [priceColor, setPriceColor] = useState("");
  const [hourlyLimitEnabled, setHourlyLimitEnabled] = useState(false);
  const [maxPagesPerHour, setMaxPagesPerHour] = useState("");
  const [upiId, setUpiId] = useState("");

  useEffect(() => {
    getSettings(shopId, token)
      .then((s) => {
        setPriceBw(String(s.priceBw ?? ""));
        setPriceColor(String(s.priceColor ?? ""));
        setUpiId(s.upiId ?? "");
        if (s.maxPagesPerHour) {
          setHourlyLimitEnabled(true);
          setMaxPagesPerHour(String(s.maxPagesPerHour));
        }
      })
      .catch((err) => setError(err.message || "Could not load your current settings."))
      .finally(() => setLoading(false));
  }, [shopId, token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    const bw = parseInt(priceBw, 10);
    const color = parseInt(priceColor, 10);
    if (!Number.isInteger(bw) || bw < 1) {
      return setError("Black & white price must be a whole number of at least ₹1.");
    }
    if (!Number.isInteger(color) || color < 1) {
      return setError("Color price must be a whole number of at least ₹1.");
    }
    let cap = null;
    if (hourlyLimitEnabled) {
      cap = parseInt(maxPagesPerHour, 10);
      if (!Number.isInteger(cap) || cap < 1) {
        return setError("Max pages per hour must be a whole number of at least 1, or turn the limit off.");
      }
    }
    const trimmedUpi = upiId.trim();
    if (trimmedUpi && !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,64}$/.test(trimmedUpi)) {
      return setError('UPI ID should look like "shopname@okhdfcbank" - check it against your PhonePe/Paytm/GPay app.');
    }

    setSaving(true);
    try {
      await updateSettings(shopId, token, {
        priceBw: bw,
        priceColor: color,
        maxPagesPerHour: cap,
        upiId: trimmedUpi || null,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      onDone?.();
    } catch (err) {
      setError(err.message || "Could not save settings. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const formCard = (
    <form
      onSubmit={handleSubmit}
      className="bg-card rounded-xl shadow-sm border border-black/5 p-6"
    >
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-collected">
        Per-page pricing
      </p>
      <p className="mb-4 text-xs text-collected">
        What students pay per page at your shop. You can change this anytime.
      </p>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="priceBw" className="block text-sm font-medium text-ink mb-1">
            Black &amp; white (₹/page)
          </label>
          <input
            id="priceBw"
            type="number"
            min="1"
            step="1"
            required
            value={priceBw}
            onChange={(e) => setPriceBw(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-ink focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
          />
        </div>
        <div>
          <label htmlFor="priceColor" className="block text-sm font-medium text-ink mb-1">
            Color (₹/page)
          </label>
          <input
            id="priceColor"
            type="number"
            min="1"
            step="1"
            required
            value={priceColor}
            onChange={(e) => setPriceColor(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-ink focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
          />
        </div>
      </div>

      <div className="mb-2 border-t border-black/5 pt-4">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-collected">
          UPI ID for student payments
        </p>
        <p className="mb-3 text-xs text-collected">
          The same UPI ID already linked to your PhonePe/Paytm/GPay soundbox or QR code.
          Students get redirected here to pay directly — no new setup on your end, and no
          transaction fees. Leave blank to only accept cash at the counter.
        </p>
        <label htmlFor="upiId" className="block text-sm font-medium text-ink mb-1">
          UPI ID
        </label>
        <input
          id="upiId"
          type="text"
          value={upiId}
          onChange={(e) => setUpiId(e.target.value)}
          placeholder="e.g. shopname@okhdfcbank"
          className="w-full max-w-xs rounded-lg border border-black/10 px-3 py-2.5 text-ink focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
        />
      </div>

      <div className="mb-2 border-t border-black/5 pt-4">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-medium uppercase tracking-wide text-collected">
            Hourly print limit
          </p>
          <label className="flex items-center gap-2 text-xs text-ink cursor-pointer">
            <input
              type="checkbox"
              checked={hourlyLimitEnabled}
              onChange={(e) => setHourlyLimitEnabled(e.target.checked)}
              className="rounded border-black/20 text-teal focus:ring-teal"
            />
            Limit pages per hour
          </label>
        </div>
        <p className="mb-3 text-xs text-collected">
          Caps total pages printed (across all jobs) per clock hour, so your printer
          isn't overwhelmed during rush. New orders past the cap wait and print
          automatically once the next hour opens - nothing for you to do.
        </p>
        {hourlyLimitEnabled && (
          <div>
            <label htmlFor="maxPagesPerHour" className="block text-sm font-medium text-ink mb-1">
              Max pages per hour
            </label>
            <input
              id="maxPagesPerHour"
              type="number"
              min="1"
              step="1"
              required={hourlyLimitEnabled}
              value={maxPagesPerHour}
              onChange={(e) => setMaxPagesPerHour(e.target.value)}
              placeholder="e.g. 500"
              className="w-full max-w-[160px] rounded-lg border border-black/10 px-3 py-2.5 text-ink focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
            />
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="bg-teal hover:bg-teal-dark disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg px-5 py-2.5 transition-colors"
        >
          {saving ? "Saving…" : firstTime ? "Save and continue" : "Save changes"}
        </button>
        {!firstTime && (
          <button
            type="button"
            onClick={onDone}
            className="text-sm text-collected hover:text-ink"
          >
            Cancel
          </button>
        )}
        {saved && <span className="text-sm text-ready font-medium">Saved ✓</span>}
      </div>
    </form>
  );

  if (firstTime) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper px-4 py-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <div className="inline-flex items-center gap-2 mb-2">
              <div className="w-9 h-9 rounded-md bg-teal flex items-center justify-center">
                <span className="font-mono font-bold text-white text-sm">P</span>
              </div>
              <span className="font-display font-bold text-2xl tracking-tight text-ink">
                PrintNow
              </span>
            </div>
            <p className="text-sm text-collected">
              One last step - set your prices before students can order
            </p>
          </div>
          {loading ? (
            <div className="text-center text-collected py-16">Loading…</div>
          ) : (
            formCard
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper">
      <header className="bg-ink text-white px-4 sm:px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-teal flex items-center justify-center shrink-0">
            <span className="font-mono font-bold text-white text-xs">P</span>
          </div>
          <span className="font-display font-bold text-xl tracking-tight">Settings</span>
        </div>
        <button onClick={onDone} className="text-sm text-white/70 hover:text-white transition-colors">
          ← Back to dashboard
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {loading ? (
          <div className="text-center text-collected py-16">Loading…</div>
        ) : (
          <div className="space-y-6">
            {formCard}
            <PayoutSettings shopId={shopId} token={token} />
            <ChangePasswordCard shopId={shopId} token={token} startOpen={mustChangePassword} />
          </div>
        )}
      </main>
    </div>
  );
}

// Self-contained: owns its own form state, separate from the pricing form
// above (different save action, different validation, no reason to share
// state). startOpen is true right after logging in with a temporary
// password (see App.jsx/Dashboard.jsx) - not required, but skips a click
// for the one moment this is most likely to be exactly what someone
// clicked "Settings" to do.
function ChangePasswordCard({ shopId, token, startOpen = false }) {
  const [open, setOpen] = useState(startOpen);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (newPassword.length < 8) {
      return setError("New password must be at least 8 characters.");
    }
    if (newPassword !== confirmPassword) {
      return setError("New password and confirmation don't match.");
    }
    setSaving(true);
    try {
      await changePassword(shopId, token, currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(err.message || "Could not change your password. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="bg-card rounded-xl shadow-sm border border-black/5 p-6">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-sm font-medium text-teal hover:text-teal-dark"
        >
          Change password
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-card rounded-xl shadow-sm border border-black/5 p-6">
      <p className="mb-4 text-xs font-medium uppercase tracking-wide text-collected">
        Change password
      </p>

      {!startOpen && (
        <div className="mb-4">
          <label htmlFor="currentPassword" className="block text-sm font-medium text-ink mb-1">
            Current password
          </label>
          <input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="w-full max-w-xs rounded-lg border border-black/10 px-3 py-2.5 text-ink focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
          />
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl">
        <div>
          <label htmlFor="newPassword" className="block text-sm font-medium text-ink mb-1">
            New password
          </label>
          <input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 8 characters"
            className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-ink focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
          />
        </div>
        <div>
          <label htmlFor="confirmPassword" className="block text-sm font-medium text-ink mb-1">
            Confirm new password
          </label>
          <input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-ink focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
          />
        </div>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 max-w-xl">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="bg-teal hover:bg-teal-dark disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg px-5 py-2.5 transition-colors"
        >
          {saving ? "Saving…" : "Update password"}
        </button>
        {!startOpen && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setError("");
            }}
            className="text-sm text-collected hover:text-ink"
          >
            Cancel
          </button>
        )}
        {saved && <span className="text-sm text-ready font-medium">Saved ✓</span>}
      </div>
    </form>
  );
}
