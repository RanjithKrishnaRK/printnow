import { useEffect, useState } from "react";
import { getPaymentFees, updatePaymentFees } from "../api";

// Lets the admin tune the two surcharges layered on top of the print cost
// for online (Razorpay) payments only - UPI/cash are untouched by these.
// Each fee has its own on/off switch, independent of its percentage value -
// turning a fee off always means it charges nothing, whatever percentage
// happens to be saved for it. Both start off ("no fee for the first few
// weeks") and can be switched on later without a code change or redeploy.
// Students see the exact same breakdown shown here, on the payment screen,
// before they tap "Pay online" - never a silent surprise inside checkout.
export default function PaymentFees({ token }) {
  const [serviceFeePercent, setServiceFeePercent] = useState("0");
  const [serviceFeeEnabled, setServiceFeeEnabled] = useState(false);
  const [gatewayFeePercent, setGatewayFeePercent] = useState("0");
  const [gatewayFeeEnabled, setGatewayFeeEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPaymentFees(token)
      .then((fees) => {
        if (cancelled) return;
        setServiceFeePercent(String(fees.serviceFeePercent));
        setServiceFeeEnabled(fees.serviceFeeEnabled);
        setGatewayFeePercent(String(fees.gatewayFeePercent));
        setGatewayFeeEnabled(fees.gatewayFeeEnabled);
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

    const serviceFeePercentNum = Number(serviceFeePercent);
    const gatewayFeePercentNum = Number(gatewayFeePercent);
    if (!Number.isFinite(serviceFeePercentNum) || serviceFeePercentNum < 0 || serviceFeePercentNum > 100) {
      setError("Service fee % must be a number between 0 and 100.");
      return;
    }
    if (!Number.isFinite(gatewayFeePercentNum) || gatewayFeePercentNum < 0 || gatewayFeePercentNum > 100) {
      setError("Gateway fee % must be a number between 0 and 100.");
      return;
    }

    setSaving(true);
    try {
      const updated = await updatePaymentFees(token, {
        serviceFeePercent: serviceFeePercentNum,
        serviceFeeEnabled,
        gatewayFeePercent: gatewayFeePercentNum,
        gatewayFeeEnabled,
      });
      setServiceFeePercent(String(updated.serviceFeePercent));
      setServiceFeeEnabled(updated.serviceFeeEnabled);
      setGatewayFeePercent(String(updated.gatewayFeePercent));
      setGatewayFeeEnabled(updated.gatewayFeeEnabled);
      setSuccess(true);
    } catch (err) {
      setError(err.message || "Could not save payment fee settings.");
    } finally {
      setSaving(false);
    }
  }

  // Live preview on a ₹50 order, so the admin can see the effect of a
  // change - including a fee that's toggled off contributing nothing, even
  // if a nonzero percentage is still sitting in the field - before saving.
  const previewBase = 50;
  const serviceFeePercentNum = Number(serviceFeePercent) || 0;
  const gatewayFeePercentNum = Number(gatewayFeePercent) || 0;
  const previewServiceFee = serviceFeeEnabled ? Math.round((previewBase * serviceFeePercentNum) / 100) : 0;
  const previewGatewayFee = gatewayFeeEnabled ? Math.round((previewBase * gatewayFeePercentNum) / 100) : 0;
  const previewTotal = previewBase + previewServiceFee + previewGatewayFee;

  return (
    <div className="bg-card rounded-xl shadow-sm border border-black/5 p-6 max-w-md">
      <h2 className="font-display font-bold text-lg text-ink mb-1">Online payment fees</h2>
      <p className="text-sm text-collected mb-4">
        Added on top of the print cost for online (card/UPI/wallet) payments only — students
        paying cash at the counter are never charged these. Each fee has its own on/off switch:
        turning one off hides it from students entirely, regardless of its saved percentage.
      </p>

      {loading ? (
        <p className="text-sm text-collected">Loading…</p>
      ) : (
        <form onSubmit={handleSubmit}>
          <fieldset className="mb-4 rounded-lg border border-black/10 p-3">
            <div className="mb-2 flex items-center justify-between">
              <label htmlFor="service-fee-enabled" className="text-sm font-medium text-ink">
                Service fee
              </label>
              <input
                id="service-fee-enabled"
                type="checkbox"
                checked={serviceFeeEnabled}
                onChange={(e) => setServiceFeeEnabled(e.target.checked)}
                className="h-4 w-4"
              />
            </div>
            <label className="block text-xs text-collected mb-1">Percentage of print cost</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                required
                disabled={!serviceFeeEnabled}
                value={serviceFeePercent}
                onChange={(e) => setServiceFeePercent(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink disabled:bg-black/5 disabled:text-collected"
              />
              <span className="text-sm text-collected">%</span>
            </div>
          </fieldset>

          <fieldset className="mb-4 rounded-lg border border-black/10 p-3">
            <div className="mb-2 flex items-center justify-between">
              <label htmlFor="gateway-fee-enabled" className="text-sm font-medium text-ink">
                Payment gateway fee
              </label>
              <input
                id="gateway-fee-enabled"
                type="checkbox"
                checked={gatewayFeeEnabled}
                onChange={(e) => setGatewayFeeEnabled(e.target.checked)}
                className="h-4 w-4"
              />
            </div>
            <label className="block text-xs text-collected mb-1">Percentage of print cost</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                required
                disabled={!gatewayFeeEnabled}
                value={gatewayFeePercent}
                onChange={(e) => setGatewayFeePercent(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink disabled:bg-black/5 disabled:text-collected"
              />
              <span className="text-sm text-collected">%</span>
            </div>
          </fieldset>

          <div className="mb-4 text-xs text-collected bg-black/[0.03] border border-black/5 rounded-lg px-3 py-2">
            Example: a ₹{previewBase} order → student pays{" "}
            <span className="font-medium text-ink">₹{previewTotal}</span> online
            {previewTotal > previewBase && (
              <>
                {" "}
                (₹{previewBase} print
                {previewServiceFee > 0 && <> + ₹{previewServiceFee} service</>}
                {previewGatewayFee > 0 && <> + ₹{previewGatewayFee} gateway</>})
              </>
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
