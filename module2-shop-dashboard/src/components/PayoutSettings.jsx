import { useEffect, useState } from "react";
import { getVendorStatus, submitVendorDetails } from "../api";

const STATUS_LABELS = {
  ACTIVE: { label: "Active — payments settle to this account", tone: "text-ready" },
  PENDING: { label: "Verifying your bank account…", tone: "text-collected" },
  IN_BENE_CREATION: { label: "Verifying your bank account…", tone: "text-collected" },
  REJECTED: { label: "Verification failed — check your details and resubmit", tone: "text-red-600" },
};

// One-time setup: once this is filled in and verified, your share of every
// online payment settles straight to this bank account (Cashfree's normal
// schedule, usually the next working day) instead of sitting in
// PrintNow's own account until it's paid out to you separately. Cash and
// UPI-screenshot payments are unaffected either way - this only changes
// how online (card/UPI/wallet) payments get settled.
export default function PayoutSettings({ shopId, token }) {
  const [vendorStatus, setVendorStatus] = useState(null);
  const [bankAccountLast4, setBankAccountLast4] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [confirmAccountNumber, setConfirmAccountNumber] = useState("");
  const [bankIfsc, setBankIfsc] = useState("");
  const [bankAccountHolder, setBankAccountHolder] = useState("");
  const [pan, setPan] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  function load() {
    setLoading(true);
    getVendorStatus(shopId, token)
      .then((data) => {
        setVendorStatus(data.vendorStatus);
        setBankAccountLast4(data.bankAccountLast4);
        setBankIfsc(data.bankIfsc || "");
        setBankAccountHolder(data.bankAccountHolder || "");
        setPan(data.pan || "");
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
    if (bankAccountNumber !== confirmAccountNumber) {
      setError("Account numbers don't match.");
      return;
    }
    setSaving(true);
    try {
      const result = await submitVendorDetails(shopId, token, {
        bankAccountNumber,
        bankIfsc: bankIfsc.trim().toUpperCase(),
        bankAccountHolder: bankAccountHolder.trim(),
        pan: pan.trim().toUpperCase(),
      });
      setVendorStatus(result.vendorStatus);
      setBankAccountLast4(bankAccountNumber.slice(-4));
      setEditing(false);
      setBankAccountNumber("");
      setConfirmAccountNumber("");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2500);
    } catch (err) {
      setError(err.message || "Could not save your bank details. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const statusInfo = vendorStatus ? STATUS_LABELS[vendorStatus] : null;

  return (
    <div className="bg-card rounded-xl shadow-sm border border-black/5 p-6 max-w-xl">
      <h2 className="font-display font-bold text-lg text-ink mb-1">Payout account</h2>
      <p className="text-sm text-collected mb-4">
        Add your bank account once, and your share of every online payment settles here directly —
        no more waiting on manual payouts.
      </p>

      {loading ? (
        <p className="text-sm text-collected">Loading…</p>
      ) : !editing ? (
        <div>
          {vendorStatus ? (
            <div className="rounded-lg border border-black/10 bg-paper px-4 py-3 mb-3">
              <p className="text-sm text-ink font-medium">Account ending in {bankAccountLast4}</p>
              {statusInfo && <p className={`text-xs mt-0.5 ${statusInfo.tone}`}>{statusInfo.label}</p>}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-black/10 px-4 py-3 mb-3 text-sm text-collected">
              No payout account on file yet. Add one to start receiving online payments directly.
            </div>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-sm font-medium text-teal hover:text-teal-dark"
          >
            {vendorStatus ? "Update bank details" : "Add bank account"}
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <div className="mb-3">
            <label className="block text-sm font-medium text-ink mb-1">Account holder name</label>
            <input
              type="text"
              required
              value={bankAccountHolder}
              onChange={(e) => setBankAccountHolder(e.target.value)}
              placeholder="As it appears on the bank account"
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-teal"
            />
          </div>

          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-ink mb-1">Account number</label>
              <input
                type="text"
                inputMode="numeric"
                required
                value={bankAccountNumber}
                onChange={(e) => setBankAccountNumber(e.target.value.replace(/\D/g, ""))}
                className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-teal"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink mb-1">Confirm account number</label>
              <input
                type="text"
                inputMode="numeric"
                required
                value={confirmAccountNumber}
                onChange={(e) => setConfirmAccountNumber(e.target.value.replace(/\D/g, ""))}
                className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-teal"
              />
            </div>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-ink mb-1">IFSC code</label>
              <input
                type="text"
                required
                value={bankIfsc}
                onChange={(e) => setBankIfsc(e.target.value.toUpperCase())}
                placeholder="HDFC0001234"
                maxLength={11}
                className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-ink font-mono uppercase focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-teal"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink mb-1">PAN</label>
              <input
                type="text"
                required
                value={pan}
                onChange={(e) => setPan(e.target.value.toUpperCase())}
                placeholder="ABCDE1234F"
                maxLength={10}
                className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-ink font-mono uppercase focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-teal"
              />
            </div>
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
              {saving ? "Saving…" : "Save bank details"}
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

      {success && <p className="mt-3 text-sm text-ready font-medium">Bank details saved.</p>}
    </div>
  );
}
