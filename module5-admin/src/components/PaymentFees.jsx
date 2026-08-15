import { useEffect, useState } from "react";
import { getPaymentFees, updatePaymentFees } from "../api";

// Lets the admin tune the two surcharges layered on top of the print cost
// for online (Razorpay) payments only - UPI/cash are untouched by these.
// Both start at 0 ("no fee for the first few weeks") and can be raised
// later without a code change or redeploy.
export default function PaymentFees({ token }) {
  const [serviceFee, setServiceFee] = useState("");
  const [gatewayFeePercent, setGatewayFeePercent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPaymentFees(token)
      .then((fees) => {
        if (cancelled) return;
        setServiceFee(String(fees.serviceFee));
        setGatewayFeePercent(String(fees.gatewayFeePercent));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Could not load payment fee settings.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess(false);

    const serviceFeeNum = Number(serviceFee);
    const gatewayFeePercentNum = Number(gatewayFeePercent);
    if (!Number.isFinite(serviceFeeNum) || serviceFeeNum < 0) {
      setError("Service fee must be a non-negative number.");
      return;
    }
    if (!Number.isFinite(gatewayFeePercentNum) || gatewayFeePercentNum < 0 || gatewayFeePercentNum > 100) {
      setError("Gateway fee % must be a number between 0 and 100.");
      return;
    }

    setSaving(true);
    try {
      const updated = await updatePaymentFees(token, {
        serviceFee: serviceFeeNum,
        gatewayFeePercent: gatewayFeePercentNum,
      });
      setServiceFee(String(updated.serviceFee));
      setGatewayFeePercent(String(updated.gatewayFeePercent));
      setSuccess(true);
    } catch (err) {
      setError(err.message || "Could not save payment fee settings.");
    } finally {
      setSaving(false);
    }
  }

  // Live preview on a ₹50 order, so the admin can see the effect of a
  // change before saving it, not just the raw numbers.
  const previewBase = 50;
  const previewGatewayFee = Number.isFinite(Number(gatewayFeePercent))
    ? Math.round((previewBase * Number(gatewayFeePercent)) / 100)
    : 0;
  const previewServiceFee = Number.isFinite(Number(serviceFee)) ? Number(serviceFee) : 0;
  const previewTotal = previewBase + previewServiceFee + previewGatewayFee;

  return (
    <div className="bg-card rounded-xl shadow-sm border border-black/5 p-6 max-w-md">
      <h2 className="font-display font-bold text-lg text-ink mb-1">Online payment fees</h2>
      <p className="text-sm text-collected mb-4">
        Added on top of the print cost for online (card/UPI/wallet) payments only — students
        paying cash or via manual UPI screenshot are never charged these. Both are 0 by default.
      </p>

      {loading ? (
        <p className="text-sm text-collected">Loading…</p>
      ) : (
        <form onSubmit={handleSubmit}>
          <div className="mb-3">
            <label className="block text-sm font-medium text-ink mb-1">Service fee (flat, ₹)</label>
            <input
              type="number"
              min="0"
              step="1"
              required
              value={serviceFee}
              onChange={(e) => setServiceFee(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink"
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-ink mb-1">Payment gateway fee (%)</label>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              required
              value={gatewayFeePercent}
              onChange={(e) => setGatewayFeePercent(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink"
            />
          </div>

          <div className="mb-4 text-xs text-collected bg-black/[0.03] border border-black/5 rounded-lg px-3 py-2">
            Example: a ₹{previewBase} order → student pays{" "}
            <span className="font-medium text-ink">₹{previewTotal}</span> online
            {previewTotal > previewBase && (
              <> (₹{previewBase} print + ₹{previewServiceFee} service + ₹{previewGatewayFee} gateway)</>
            )}
            .
          </div>

          {error && (
            <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          {success && (
            <div className="mb-4 text-sm text-ready bg-ready/10 border border-ready/20 rounded-lg px-3 py-2">
              Saved. New fees apply to payments started from now on.
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="bg-ink hover:bg-ink/90 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
          >
            {saving ? "Saving…" : "Save fees"}
          </button>
        </form>
      )}
    </div>
  );
}
