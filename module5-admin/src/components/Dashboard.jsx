import { useState } from "react";
import { clearSession } from "../auth";
import Overview from "./Overview";
import Shops from "./Shops";
import Landmarks from "./Landmarks";
import ChangePassword from "./ChangePassword";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "shops", label: "Shops" },
  { id: "landmarks", label: "Landmarks" },
  { id: "settings", label: "Settings" },
];

export default function Dashboard({ token, email, onLogout }) {
  const [activeTab, setActiveTab] = useState("overview");

  return (
    <div className="min-h-screen bg-paper">
      <header className="bg-ink text-white px-4 sm:px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-teal flex items-center justify-center shrink-0">
            <span className="font-mono font-bold text-white text-xs">P</span>
          </div>
          <span className="font-display font-bold text-xl tracking-tight">
            PrintNow <span className="text-white/50 font-body text-sm font-normal">Admin</span>
          </span>
        </div>
        <div className="flex items-center gap-4">
          {email && <span className="text-sm text-white/60 hidden sm:inline">{email}</span>}
          <button
            onClick={() => {
              clearSession();
              onLogout();
            }}
            className="text-sm text-white/70 hover:text-white transition-colors"
          >
            Log out
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="mb-6 overflow-x-auto -mx-1 px-1">
          <div className="inline-flex gap-1 bg-black/5 rounded-lg p-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3.5 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? "bg-white text-ink shadow-sm"
                    : "text-collected hover:text-ink"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {activeTab === "overview" && <Overview token={token} />}
        {activeTab === "shops" && <Shops token={token} />}
        {activeTab === "landmarks" && <Landmarks token={token} />}
        {activeTab === "settings" && <ChangePassword token={token} />}
      </main>
    </div>
  );
}
