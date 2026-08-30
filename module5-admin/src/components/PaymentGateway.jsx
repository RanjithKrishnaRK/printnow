import { useEffect, useState } from "react";
import { getActiveGateway, setActiveGateway } from "../api";

const GATEWAYS = [
  {
    value: "razorpay",
    label: "Razorpay",
    description: "Live now. Individual shops can also connect their own Razorpay account (Settings, in their dashboard) so payments go straight to them.",
  },
  {
    value: "cashfree",
    label: "Cashfree",
    description: "Easy Split, auto-divides each payment between the shop and PrintNow. Switch to this once the Cashfree merchant account finishes activating.",
  },
];

// Controls which gateway the student app's checkout screen actually
// offers (GET /api/settings/active-gateway) - not which ones WORK. Both
// gateways' routes keep working regardless of this toggle, so flipping
// back and forth (e.g. once Cashfree's merchant account activates) is
// just this, no redeploy needed.
export default function PaymentGateway({ token }) {
  const [activeGateway, setLocalGateway] = useState("razorpay");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getActiveGateway(token)
      .then((res) => {
        if (!cancelled) setLocalGateway(res.activeGateway);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Could not load the current gateway setting.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleChange(gateway) {
    if (gateway === activeGateway) return;
    setError("");
    setSuccess(false);
    const previous = activeGateway;
    setLocalGateway(gateway); // optimistic
    setSaving(true);
    try {
      const res = await setActiveGateway(token, gateway);
      setLocalGateway(res.activeGateway);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 1500);
    } catch (err) {
      setLocalGateway(previous);
      setError(err.message || "Could not save that change.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-card rounded-xl shadow-sm border border-black/5 p-6 max-w-md">
      <h2 className="font-display font-bold text-lg text-ink mb-1">Payment gateway</h2>
      <p className="text-sm text-collected mb-4">
        Which gateway the student app's checkout offers right now.
      </p>

      {loading ? (
        <p className="text-sm text-collected">Loading…</p>
      ) : (
        <div className="space-y-3">
          {GATEWAYS.map((g) => (
            <label
              key={g.value}
              className="flex items-start gap-3 rounded-lg border border-black/10 p-3 cursor-pointer"
            >
              <input
                type="radio"
                name="active-gateway"
                checked={activeGateway === g.value}
                onChange={() => handleChange(g.value)}
                disabled={saving}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                <span className="block text-sm font-medium text-ink">{g.label}</span>
                <span className="block text-xs text-collected mt-0.5">{g.description}</span>
              </span>
            </label>
          ))}
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
