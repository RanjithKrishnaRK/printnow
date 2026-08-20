import { useState } from "react";
import { login } from "../api";
import { primeAudio } from "../buzzer";

export default function Login({ onLogin, onGoToSignup }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    // The buzzer's chime needs a user gesture before browsers will let audio
    // play at all - this click is that gesture. Priming here (rather than
    // waiting for the first job to arrive) means the sound is ready well
    // before it's ever actually needed.
    primeAudio();
    try {
      const { shopId, token, mustChangePassword } = await login(email, password);
      onLogin(shopId, token, mustChangePassword);
    } catch (err) {
      setError(err.message || "Something went wrong. Try again.");
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
            <span className="font-display font-bold text-2xl tracking-tight text-ink">
              PrintNow
            </span>
          </div>
          <p className="text-sm text-collected">Shop owner dashboard</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-card rounded-xl shadow-sm border border-black/5 p-6"
        >
          <div className="mb-4">
            <label htmlFor="email" className="block text-sm font-medium text-ink mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@yourshop.in"
              className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-ink placeholder:text-collected/70 focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
            />
          </div>

          <div className="mb-5">
            <label htmlFor="password" className="block text-sm font-medium text-ink mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-ink placeholder:text-collected/70 focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
            />
          </div>

          {error && (
            <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <p className="mb-4 text-xs text-collected">
            Lost your password? Contact PrintNow support and we'll get you a temporary one.
          </p>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-teal hover:bg-teal-dark disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg py-2.5 transition-colors"
          >
            {loading ? "Logging in…" : "Log in"}
          </button>
        </form>

        <p className="mt-3 text-sm text-center text-collected">
          New shop?{" "}
          <button onClick={onGoToSignup} className="text-teal font-medium underline">
            Register here
          </button>
        </p>
      </div>
    </div>
  );
}
