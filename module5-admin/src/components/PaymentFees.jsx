import { useEffect, useState } from "react";
import { getPaymentFees, updatePaymentFees } from "../api";

const FIELD_DEFAULTS = {
  serviceFeePercent: "0",
  serviceFeeEnabled: false,
  serviceFeeTier1Flat: "1",
  serviceFeeTier2Flat: "1.5",
  gatewayFeePercent: "0",
  gatewayFeeEnabled: false,
  gatewayFeeTier1Flat: "1",
  gatewayFeeTier2Flat: "1.5",
};

// One fee (service or gateway) as a self-contained block: an on/off switch,
// a percentage for orders over ₹20, and two flat rupee amounts for orders
// ₹20 and under - a percentage of a ₹5 print job rounds to ₹0, so small
// orders need a flat floor instead, stepped up once between ₹0-10 and
// ₹11-20 rather than one flat number for every small order.
function FeeFieldset({ title, values, onChange }) {
  const { enabled, percent, tier1Flat, tier2Flat } = values;
  return (
    <fieldset className="mb-4 rounded-lg border border-black/10 p-3">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-ink">{title}</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ ...values, enabled: e.target.checked })}
          className="h-4 w-4"
        />
      </div>

      <label className="block text-xs text-collected mb-1">Orders over ₹20 — percentage of print cost</label>
      <div className="mb-3 flex items-center gap-2">
        <input
          type="number"
          min="0"
          max="100"
          step="0.1"
          required
          disabled={!enabled}
          value={percent}
          onChange={(e) => onChange({ ...values, percent: e.target.value })}
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink disabled:bg-black/5 disabled:text-collected"
        />
        <span className="text-sm text-collected">%</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-collected mb-1">₹0–10 orders — flat ₹</label>
          <input
            type="number"
            min="0"
            step="0.5"
            required
            disabled={!enabled}
            value={tier1Flat}
            onChange={(e) => onChange({ ...values, tier1Flat: e.target.value })}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink disabled:bg-black/5 disabled:text-collected"
          />
        </div>
        <div>
          <label className="block text-xs text-collected mb-1">₹11–20 orders — flat ₹</label>
          <input
            type="number"
            min="0"
            step="0.5"
            required
            disabled={!enabled}
            value={tier2Flat}
            onChange={(e) => onChange({ ...values, tier2Flat: e.target.value })}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink disabled:bg-black/5 disabled:text-collected"
          />
        </div>
      </div>
    </fieldset>
  );
}

function feeForAmount(baseAmount, { enabled, percent, tier1Flat, tier2Flat }) {
  if (!enabled) return 0;
  if (baseAmount <= 10) return Number(tier1Flat) || 0;
  if (baseAmount <= 20) return Number(tier2Flat) || 0;
  return Math.round((baseAmount * (Number(percent) || 0)) / 100);
}

// Lets the admin tune the two surcharges layered on top of the print cost
// for online (Razorpay) payments only - UPI/cash are untouched by these.
// Each fee has its own on/off switch, independent of its numbers - turning
// a fee off always means it charges nothing. Everything starts off/at the
// defaults above ("no fee for the first few weeks") and can be changed any
// time without a code change or redeploy. Students see the exact same
// breakdown shown here, on the payment screen, before they tap "Pay
// online" - never a silent surprise inside checkout.
export default function PaymentFees({ token }) {
  const [service, setService] = useState({
    enabled: FIELD_DEFAULTS.serviceFeeEnabled,
    percent: FIELD_DEFAULTS.serviceFeePercent,
    tier1Flat: FIELD_DEFAULTS.serviceFeeTier1Flat,
    tier2Flat: FIELD_DEFAULTS.serviceFeeTier2Flat,
  });
  const [gateway, setGateway] = useState({
    enabled: FIELD_DEFAULTS.gatewayFeeEnabled,
    percent: FIELD_DEFAULTS.gatewayFeePercent,
    tier1Flat: FIELD_DEFAULTS.gatewayFeeTier1Flat,
    tier2Flat: FIELD_DEFAULTS.gatewayFeeTier2Flat,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPaymentFees(token)
      .then((fees) => {
        if (cancelled) return;
        setService({
          enabled: fees.serviceFeeEnabled,
          percent: String(fees.serviceFeePercent),
          tier1Flat: String(fees.serviceFeeTier1Flat),
          tier2Flat: String(fees.serviceFeeTier2Flat),
        });
        setGateway({
          enabled: fees.gatewayFeeEnabled,
          percent: String(fees.gatewayFeePercent),
          tier1Flat: String(fees.gatewayFeeTier1Flat),
          tier2Flat: String(fees.gatewayFeeTier2Flat),
        });
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

  function validateBlock(values, label) {
    const percent = Number(values.percent);
    const tier1 = Number(values.tier1Flat);
    const tier2 = Number(values.tier2Flat);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return `${label} percentage must be a number between 0 and 100.`;
    }
    if (!Number.isFinite(tier1) || tier1 < 0 || !Number.isFinite(tier2) || tier2 < 0) {
      return `${label} flat amounts must be non-negative numbers.`;
    }
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess(false);

    const serviceError = validateBlock(service, "Service fee");
    if (serviceError) {
      setError(serviceError);
      return;
    }
    const gatewayError = validateBlock(gateway, "Payment gateway fee");
    if (gatewayError) {
      setError(gatewayError);
      return;
    }

    setSaving(true);
    try {
      const updated = await updatePaymentFees(token, {
        serviceFeePercent: Number(service.percent),
        serviceFeeEnabled: service.enabled,
        serviceFeeTier1Flat: Number(service.tier1Flat),
        serviceFeeTier2Flat: Number(service.tier2Flat),
        gatewayFeePercent: Number(gateway.percent),
        gatewayFeeEnabled: gateway.enabled,
        gatewayFeeTier1Flat: Number(gateway.tier1Flat),
        gatewayFeeTier2Flat: Number(gateway.tier2Flat),
      });
      setService({
        enabled: updated.serviceFeeEnabled,
        percent: String(updated.serviceFeePercent),
        tier1Flat: String(updated.serviceFeeTier1Flat),
        tier2Flat: String(updated.serviceFeeTier2Flat),
      });
      setGateway({
        enabled: updated.gatewayFeeEnabled,
        percent: String(updated.gatewayFeePercent),
        tier1Flat: String(updated.gatewayFeeTier1Flat),
        tier2Flat: String(updated.gatewayFeeTier2Flat),
      });
      setSuccess(true);
    } catch (err) {
      setError(err.message || "Could not save payment fee settings.");
    } finally {
      setSaving(false);
    }
  }

  // Three live previews so the tier boundaries are actually visible before
  // saving, not just numbers in isolated boxes.
  const previews = [5, 15, 50].map((amount) => {
    const s = feeForAmount(amount, service);
    const g = feeForAmount(amount, gateway);
    return { amount, serviceFee: s, gatewayFee: g, total: amount + s + g };
  });

  return (
    <div className="bg-card rounded-xl shadow-sm border border-black/5 p-6 max-w-md">
      <h2 className="font-display font-bold text-lg text-ink mb-1">Online payment fees</h2>
      <p className="text-sm text-collected mb-4">
        Added on top of the print cost for online (card/UPI/wallet) payments only — students
        paying cash at the counter are never charged these. Each fee has its own on/off switch.
        A percentage of a small order rounds to ₹0, so orders ₹20 and under use a flat amount
        instead — orders over ₹20 use the percentage.
      </p>

      {loading ? (
        <p className="text-sm text-collected">Loading…</p>
      ) : (
        <form onSubmit={handleSubmit}>
          <FeeFieldset title="Service fee" values={service} onChange={setService} />
          <FeeFieldset title="Payment gateway fee" values={gateway} onChange={setGateway} />

          <div className="mb-4 space-y-1 text-xs text-collected bg-black/[0.03] border border-black/5 rounded-lg px-3 py-2">
            {previews.map((p) => (
              <div key={p.amount} className="flex items-center justify-between">
                <span>₹{p.amount} order</span>
                <span className={p.total > p.amount ? "font-medium text-ink" : ""}>
                  → ₹{p.total} online
                  {p.total > p.amount && (
                    <>
                      {" "}
                      ({p.serviceFee > 0 && `+₹${p.serviceFee} service`}
                      {p.serviceFee > 0 && p.gatewayFee > 0 && ", "}
                      {p.gatewayFee > 0 && `+₹${p.gatewayFee} gateway`})
                    </>
                  )}
                </span>
              </div>
            ))}
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
