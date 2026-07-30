import { useState } from "react";
import { changePassword } from "../api";

export default function ChangePassword({ token }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess(false);

    if (newPassword !== confirmPassword) {
      setError("New password and confirmation don't match.");
      return;
    }
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    try {
      await changePassword(token, currentPassword, newPassword);
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err.message || "Could not change password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-card rounded-xl shadow-sm border border-black/5 p-6 max-w-md">
      <h2 className="font-display font-bold text-lg text-ink mb-1">Change password</h2>
      <p className="text-sm text-collected mb-4">
        Change your admin password any time. You'll need your current password.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="mb-3">
          <label className="block text-sm font-medium text-ink mb-1">Current password</label>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink"
          />
        </div>

        <div className="mb-3">
          <label className="block text-sm font-medium text-ink mb-1">New password</label>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 8 characters"
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink"
          />
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium text-ink mb-1">
            Confirm new password
          </label>
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-ink/40 focus:border-ink"
          />
        </div>

        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        {success && (
          <div className="mb-4 text-sm text-ready bg-ready/10 border border-ready/20 rounded-lg px-3 py-2">
            Password changed.
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="bg-ink hover:bg-ink/90 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
        >
          {loading ? "Saving…" : "Change password"}
        </button>
      </form>
    </div>
  );
}
