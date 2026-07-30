import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

// If set, QR codes encode a full link into Module 1 (student app) so
// scanning opens the app directly. If left blank, QR codes encode the bare
// shopId instead - Module 1's scanner already accepts a raw shopId as a
// valid scan (see StudentApp.jsx: extractShopIdFromScan), so this works
// either way and needs no cross-team coordination to ship today.
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
