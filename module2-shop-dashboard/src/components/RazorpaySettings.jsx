import { useEffect, useState } from "react";
import { getSettings, updateSettings } from "../api";

// While Cashfree's merchant account is pending activation, online payments
// run through Razorpay - PayoutSettings.jsx (Cashfree Easy Split) is the
// long-term plan, but shops don't have to wait for that to receive money
// directly: connect your OWN Razorpay account here (create one free at
// razorpay.com, then Settings -> API Keys in their dashboard) and every
// online payment - the print cost AND PrintNow's service fee both - goes
// straight to your account instead of sitting with PrintNow. Since
// PrintNow's fee then never actually reaches PrintNow this way, whatever
// accrues shows up on the Earnings page as "Service charge you owe" - pay
// that back whenever suits you, no fixed schedule.
export default function RazorpaySettings({ shopId, token }) {
  const [keyId, setKeyId] = useState(null);
  const [secretConfigured, setSecretConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  const [newKeyId, setNewKeyId] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  function load() {
    setLoading(true);
    getSettings(shopId, token)
      .then((s) => {
        setKeyId(s.razorpayKeyId || null);
        setSecretConfigured(!!s.razorpaySecretConfigured);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId, token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const result = await updateSettings(shopId, token, {
        razorpayKeyId: newKeyId.trim(),
        razorpaySecret: newSecret.trim(),
      });
      setKeyId(result.razorpayKeyId);
      setSecretConfigured(!!result.razorpaySecretConfigured);
      setEditing(false);
      setNewKeyId("");
      setNewSecret("");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2500);
    } catch (err) {
      setError(err.message || "Could not save your Razorpay keys. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    setError("");
    setSaving(true);
    try {
      await updateSettings(shopId, token, { razorpayKeyId: null });
      setKeyId(null);
      setSecretConfigured(false);
    } catch (err) {
      setError(err.message || "Could not disconnect. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const connected = keyId && secretConfigured;

  return (
    <div className="bg-card rounded-xl shadow-sm border border-black/5 p-6 max-w-xl">
      <h2 className="font-display font-bold text-lg text-ink mb-1">Your own Razorpay account</h2>
      <p className="text-sm text-collected mb-4">
        Connect your own Razorpay account and online payments go straight to you - no waiting on
        PrintNow to pay it out. PrintNow's service charge on those payments becomes something you
        owe us back, shown on your Earnings page - pay it weekly, monthly, whenever works for you.
      </p>

      {loading ? (
        <p className="text-sm text-collected">Loading…</p>
      ) : !editing ? (
        <div>
          {connected ? (
            <div className="rounded-lg border border-black/10 bg-paper px-4 py-3 mb-3">
              <p className="text-sm text-ink font-medium">Connected</p>
              <p className="text-xs mt-0.5 text-collected font-mono">Key ID: {keyId}</p>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-black/10 px-4 py-3 mb-3 text-sm text-collected">
              Not connected yet - payments currently go through PrintNow's own account.
            </div>
          )}
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-sm font-medium text-teal hover:text-teal-dark"
            >
              {connected ? "Update keys" : "Connect Razorpay account"}
            </button>
            {connected && (
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={saving}
                className="text-sm text-collected hover:text-red-600 disabled:opacity-60"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <div className="mb-3">
            <label className="block text-sm font-medium text-ink mb-1">Key ID</label>
            <input
              type="text"
              required
              value={newKeyId}
              onChange={(e) => setNewKeyId(e.target.value)}
              placeholder="rzp_live_xxxxxxxxxxxxxx"
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-ink font-mono focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-teal"
            />
          </div>
          <div className="mb-3">
            <label className="block text-sm font-medium text-ink mb-1">Key secret</label>
            <input
              type="password"
              required
              value={newSecret}
              onChange={(e) => setNewSecret(e.target.value)}
              placeholder="From Razorpay Dashboard -> Settings -> API Keys"
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-ink font-mono focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-teal"
            />
            <p className="text-xs text-collected mt-1">
              Never shown again once saved - only the Key ID is displayed after this.
            </p>
          </div>

          {error && (
            <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
            >
              {saving ? "Saving…" : "Save keys"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError("");
              }}
              className="text-sm text-collected hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {success && <p className="mt-3 text-sm text-ready font-medium">Razorpay keys saved.</p>}
    </div>
  );
}
