// Shown in place of the normal "advance" button whenever a job/batch's
// status is "payment_pending" - shared between JobCard and BatchCard so the
// review UI (screenshot preview + confirm/reject) looks identical whether
// it's a single job or a whole batch order.
export default function PaymentReview({ paymentMethod, paymentScreenshotUrl, amountDue, onConfirm, onReject, busy }) {
  function handleReject() {
    const reason = window.prompt(
      "Why are you rejecting this payment? (shown to the student, e.g. \"Screenshot doesn't match the amount\")",
      ""
    );
    if (reason === null) return; // cancelled
    onReject(reason.trim() || "Payment could not be verified");
  }

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 w-full sm:w-auto">
      <div className="flex items-center gap-3">
        {paymentMethod === "upi" && paymentScreenshotUrl ? (
          <a href={paymentScreenshotUrl} target="_blank" rel="noreferrer" className="shrink-0">
            <img
              src={paymentScreenshotUrl}
              alt="Payment screenshot"
              className="w-14 h-14 rounded-md object-cover border border-black/10"
            />
          </a>
        ) : (
          <div className="shrink-0 w-14 h-14 rounded-md border border-dashed border-black/20 flex items-center justify-center text-xl">
            💵
          </div>
        )}
        <div className="text-xs text-collected">
          <div className="font-medium text-ink">
            {paymentMethod === "upi" ? "Paid via UPI" : "Will pay cash at counter"}
          </div>
          <div>₹{amountDue} due</div>
          {paymentMethod === "upi" && <div className="text-teal">Tap photo to zoom</div>}
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={handleReject}
          disabled={busy}
          className="text-sm font-medium rounded-lg px-3 py-2.5 border border-black/10 text-collected hover:text-red-700 hover:border-red-200 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          Reject
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className="text-sm font-medium rounded-lg px-4 py-2.5 bg-ready hover:bg-emerald-700 text-white disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? "Confirming…" : "Confirm & queue"}
        </button>
      </div>
    </div>
  );
}
