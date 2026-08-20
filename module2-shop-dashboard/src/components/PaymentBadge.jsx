// Shown on every status tab once payment is confirmed (queued, printing,
// ready, and the history/collected tab) - not just during the
// payment_pending review step, where PaymentReview already covers this.
// Cash gets its own distinct highlight color: unlike an online payment,
// cash hasn't actually reached the shop owner's hand yet at the counter,
// so it's worth a visual reminder every time this order is looked at,
// right up until it's marked collected.
export default function PaymentBadge({ paymentMethod, amountDue }) {
  if (!paymentMethod || amountDue == null) return null;

  if (paymentMethod === "cash") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
        💵 Cash · ₹{amountDue}
      </span>
    );
  }

  const label = paymentMethod === "upi" ? "Paid via UPI" : "Paid online";
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-teal/20 bg-teal/10 px-2.5 py-1 text-xs font-medium text-teal">
      {label} · ₹{amountDue}
    </span>
  );
}
