import { useState, useEffect } from "react";
import { signup, getLandmarks } from "../api";
import { primeAudio } from "../buzzer";

export default function Signup({ onSignedUp, onBackToLogin }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [landmarks, setLandmarks] = useState([]);
  const [landmarkId, setLandmarkId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getLandmarks()
      .then((rows) => {
        setLandmarks(rows);
        if (rows.length > 0) setLandmarkId(rows[0].id);
      })
      .catch(() => setError("Could not load landmarks. Refresh and try again."));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    primeAudio();
    try {
      const { shopId, token } = await signup(name, email, password, landmarkId);
      onSignedUp(shopId, token, name);
    } catch (err) {
      setError(err.message || "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper px-4 py-8">
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
          <p className="text-sm text-collected">Register your shop</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-card rounded-xl shadow-sm border border-black/5 p-6"
        >
          <div className="mb-4">
            <label htmlFor="name" className="block text-sm font-medium text-ink mb-1">
              Shop name
            </label>
            <input
              id="name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sharma Xerox & Print Center"
              className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-ink placeholder:text-collected/70 focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal"
            />
          </div>

          <div className="mb-4">
            <label htmlFor="landmark" className="block text-sm font-medium text-ink mb-1">
              Nearest landmark
            </label>
            <select
              id="landmark"
              required
              value={landmarkId}
              onChange={(e) => setLandmarkId(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-ink focus:outline-none focus:ring-2 focus:ring-teal focus:border-teal bg-white"
            >
              {landmarks.length === 0 && <option value="">Loading…</option>}
              {landmarks.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-collected">
              Students browsing near this landmark will see your shop. More landmarks are added by
              PrintNow admins — contact support if yours isn't listed yet.
            </p>
          </div>

          <div className="mb-4">
            <label htmlFor="signup-email" className="block text-sm font-medium text-ink mb-1">
              Email
            </label>
            <input
              id="signup-email"
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
            <label htmlFor="signup-password" className="block text-sm font-medium text-ink mb-1">
              Password
            </label>
            <input
              id="signup-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
            disabled={loading || !landmarkId}
            className="w-full bg-teal hover:bg-teal-dark disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg py-2.5 transition-colors"
          >
            {loading ? "Creating your shop…" : "Create shop account"}
          </button>
        </form>

        <p className="mt-4 text-sm text-center text-collected">
          Already registered?{" "}
          <button onClick={onBackToLogin} className="text-teal font-medium underline">
            Log in
          </button>
        </p>
      </div>
    </div>
  );
}
