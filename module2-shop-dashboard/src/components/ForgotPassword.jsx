import { useState } from "react";
import { forgotPassword, resetPassword } from "../api";

// Two steps: request a code by email, then submit that code alongside a
// new password. Deliberately never tells the person whether their email
// is registered - the request step always looks the same either way (see
// the backend's forgot-password route) so this can't be used to probe
// which emails have a shop account.
export default function ForgotPassword({ onBackToLogin, onReset }) {
  const [step, setStep] = useState("request"); // "request" | "reset"
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  async function handleRequest(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await forgotPassword(email);
      setInfo(`If ${email} is registered, we've sent a 6-digit code to it.`);
      setStep("reset");
    } catch (err) {
      setError(err.message || "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await resetPassword(email, otp, newPassword);
      onReset();
    } catch (err) {
      setError(err.message || "Could not reset your password. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-9 h-9 rounded-md bg-teal flex items-center justify-center">
              <span className="font-mono font-bold text-white text-sm">P</span>
            </div>
            <span className="font-display font-bold text-2xl tracking-tight text-ink">PrintNow</span>
          </div>
          <p className="text-sm text-collected">Reset your password</p>
        </div>

        {step === "request" ? (
          <form onSubmit={handleRequest} className="bg-card rounded-xl shadow-sm border border-black/5 p-6">
            <div className="mb-5">
              <label htmlFor="fp-email" className="block text-sm font-medium text-ink mb-1">
                Email
              </label>
              <input
                id="fp-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@yourshop.in"
                className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-ink placeholder:text-collected/70 focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
              />
            </div>

            {error && (
              <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-teal hover:bg-teal-dark disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg py-2.5 transition-colors"
            >
              {loading ? "Sending code…" : "Send reset code"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleReset} className="bg-card rounded-xl shadow-sm border border-black/5 p-6">
            {info && (
              <div className="mb-4 text-sm text-ink bg-teal/5 border border-teal/20 rounded-lg px-3 py-2">
                {info}
              </div>
            )}

            <div className="mb-4">
              <label htmlFor="fp-otp" className="block text-sm font-medium text-ink mb-1">
                Verification code
              </label>
              <input
                id="fp-otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
                className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-center text-2xl tracking-[0.5em] text-ink placeholder:text-collected/40 focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
              />
            </div>

            <div className="mb-5">
              <label htmlFor="fp-new-password" className="block text-sm font-medium text-ink mb-1">
                New password
              </label>
              <input
                id="fp-new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-ink placeholder:text-collected/70 focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
              />
            </div>

            {error && (
              <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || otp.length !== 6}
              className="w-full bg-teal hover:bg-teal-dark disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg py-2.5 transition-colors"
            >
              {loading ? "Resetting…" : "Reset password"}
            </button>

            <button
              type="button"
              onClick={() => setStep("request")}
              className="w-full mt-3 text-sm text-collected hover:text-ink"
            >
              Use a different email
            </button>
          </form>
        )}

        <p className="mt-4 text-sm text-center text-collected">
          <button onClick={onBackToLogin} className="text-teal font-medium underline">
            Back to login
          </button>
        </p>
      </div>
    </div>
  );
}
