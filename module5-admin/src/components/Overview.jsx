import { useCallback, useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { getStats } from "../api";

const COLORS = ["#0F6B62", "#2F6FED", "#E8A33D", "#8A94A3"];
const POLL_MS = 15000;

function StatCard({ label, value }) {
  return (
    <div className="bg-card rounded-xl shadow-sm border border-black/5 p-4">
      <p className="text-xs text-collected uppercase tracking-wide mb-1">{label}</p>
      <p className="font-display font-bold text-3xl text-ink">{value}</p>
    </div>
  );
}

export default function Overview({ token }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(async () => {
    try {
      const data = await getStats(token);
      setStats(data);
      setError("");
    } catch (err) {
      setError(err.message || "Could not load stats.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Auto-refresh so the dashboard's numbers/charts stay live without
  // needing a manual page reload - same polling pattern used elsewhere
  // (Module 2's queue, and the admin Shops tab).
  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, POLL_MS);
    return () => clearInterval(interval);
  }, [loadStats]);

  if (loading) return <div className="text-collected py-12 text-center">Loading stats…</div>;
  if (error)
    return (
      <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
        {error}
      </div>
    );
  if (!stats) return null;

  const statusOrder = ["uploaded", "paid", "queued", "printing", "ready", "collected"];
  const jobsByStatus = statusOrder
    .map((status) => {
      const found = stats.jobsByStatus.find((s) => s.status === status);
      return { status, count: found ? found.count : 0 };
    })
    .filter((s) => s.count > 0 || statusOrder.indexOf(s.status) < 3);

  const colorMixData = stats.colorMix.map((c) => ({
    name: c.colorMode,
    value: c.count,
  }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Shops" value={stats.totalShops} />
        <StatCard label="Landmarks" value={stats.totalLandmarks} />
        <StatCard label="Total jobs" value={stats.totalJobs} />
        <StatCard label="Revenue (₹)" value={stats.totalRevenue} />
      </div>

      <div className="bg-card rounded-xl shadow-sm border border-black/5 p-4">
        <h3 className="font-display font-bold text-base text-ink mb-3">
          Job volume — last 14 days
        </h3>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={stats.dailyVolume}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E8EAED" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Line type="monotone" dataKey="count" stroke="#0F6B62" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="bg-card rounded-xl shadow-sm border border-black/5 p-4">
          <h3 className="font-display font-bold text-base text-ink mb-3">Jobs by status</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={jobsByStatus}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E8EAED" />
              <XAxis dataKey="status" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#2F6FED" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-card rounded-xl shadow-sm border border-black/5 p-4">
          <h3 className="font-display font-bold text-base text-ink mb-3">
            Color mode mix
          </h3>
          {colorMixData.length === 0 ? (
            <p className="text-sm text-collected py-16 text-center">No jobs yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={colorMixData} dataKey="value" nameKey="name" outerRadius={80} label>
                  {colorMixData.map((entry, i) => (
                    <Cell key={entry.name} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="bg-card rounded-xl shadow-sm border border-black/5 p-4">
        <h3 className="font-display font-bold text-base text-ink mb-3">Top 5 shops by jobs</h3>
        {stats.topShops.length === 0 ? (
          <p className="text-sm text-collected py-8 text-center">No shops yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={stats.topShops} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#E8EAED" />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="jobCount" fill="#E8A33D" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
