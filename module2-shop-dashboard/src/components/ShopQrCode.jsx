import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

// If set, QR codes encode a full link into Module 1 (student app) so
// scanning with ANY app - your phone's regular camera, WhatsApp, Google
// Lens, a dedicated QR scanner, not just this dashboard's own live-scan
// feature - opens the order page directly. This is the only thing that
// makes a printed QR code actually work as a QR code in the real world: a
// scanner only shows an "Open" action for a real URL, not for plain text.
//
// If left blank, QR codes fall back to encoding the bare shopId as plain
// text. That still works with THIS APP'S OWN in-app scanner (it can read
// raw text fine), but every other scanner - which is how virtually all real
// students will actually scan a sticker taped to a counter - will just show
// the text with no way to open anything. Set this before printing any QR
// codes for real use.
const STUDENT_APP_URL = import.meta.env.VITE_STUDENT_APP_URL || "";

function buildQrValue(shopId) {
  if (!STUDENT_APP_URL) return shopId;
  const sep = STUDENT_APP_URL.includes("?") ? "&" : "?";
  return `${STUDENT_APP_URL}${sep}shopId=${encodeURIComponent(shopId)}`;
}

export default function ShopQrCode({ shopId, shopName, onClose }) {
  const canvasRef = useRef(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCode.toCanvas(
      canvasRef.current,
      buildQrValue(shopId),
      { width: 280, margin: 2 },
      (err) => {
        if (err) setError("Could not generate QR code. Try closing and reopening this.");
      }
    );
  }, [shopId]);

  function handleDownload() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const safeName = (shopName || "printnow-shop").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const link = document.createElement("a");
    link.download = `${safeName}-qr-code.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
      <div className="bg-card rounded-xl shadow-lg border border-black/5 p-6 w-full max-w-sm text-center">
        <h2 className="font-display font-bold text-lg text-ink mb-1">Your shop's QR code</h2>
        <p className="text-sm text-collected mb-4">
          Print this and paste it near the counter. Students scan it to start an order at your
          shop.
        </p>

        {error ? (
          <p className="text-sm text-red-600 py-8">{error}</p>
        ) : (
          <canvas ref={canvasRef} className="mx-auto rounded-lg border border-black/10" />
        )}

        {!STUDENT_APP_URL && !error && (
          <div className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2.5 text-left text-xs text-amber-900">
            <p className="font-medium">This QR code won't work if scanned outside PrintNow</p>
            <p className="mt-1">
              A phone's regular camera, WhatsApp, or Google Lens can only open a QR code that
              contains a real link — right now it only contains this shop's raw ID as plain
              text. Set <code className="rounded bg-black/10 px-1 py-0.5">VITE_STUDENT_APP_URL</code>{" "}
              to your deployed student app's URL and rebuild this dashboard before printing this
              code for real use.
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-col gap-2">
          <button
            onClick={handleDownload}
            disabled={!!error}
            className="w-full bg-teal hover:bg-teal-dark disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg py-2.5 transition-colors"
          >
            Download QR code
          </button>
          <button
            onClick={onClose}
            className="w-full text-sm text-collected hover:text-ink py-2"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
