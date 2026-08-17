import { useEffect, useState } from "react";
import Login from "./components/Login";
import Signup from "./components/Signup";
import Dashboard from "./components/Dashboard";
import Settings from "./components/Settings";
import Earnings from "./components/Earnings";
import { loadSession, saveSession } from "./auth";
import { stopFlashOnFocus } from "./buzzer";

export default function App() {
  const [session, setSession] = useState(() => loadSession());
  const [view, setView] = useState("login"); // "login" | "signup"
  const [justSignedUp, setJustSignedUp] = useState(false);
  // "onboarding" forces Settings first after signup (no pricing set yet -
  // students can't be shown a price of nothing). "dashboard" is normal use;
  // the dashboard header's "Settings" button can jump back to "settings"
  // anytime after that, unrelated to onboarding.
  const [screen, setScreen] = useState("dashboard"); // "onboarding" | "dashboard" | "settings" | "earnings"

  useEffect(() => {
    stopFlashOnFocus();
  }, []);

  function handleLogin(shopId, token) {
    saveSession(shopId, token);
    setSession({ shopId, token });
    setScreen("dashboard");
  }

  function handleSignedUp(shopId, token, name) {
    saveSession(shopId, token);
    setSession({ shopId, token, shopName: name });
    setJustSignedUp(true);
    setScreen("onboarding");
  }

  function handleLogout() {
    setSession(null);
    setView("login");
  }

  if (!session) {
    return view === "signup" ? (
      <Signup onSignedUp={handleSignedUp} onBackToLogin={() => setView("login")} />
    ) : (
      <Login onLogin={handleLogin} onGoToSignup={() => setView("signup")} />
    );
  }

  if (screen === "onboarding") {
    return (
      <Settings
        shopId={session.shopId}
        token={session.token}
        firstTime
        onDone={() => setScreen("dashboard")}
      />
    );
  }

  if (screen === "settings") {
    return (
      <Settings
        shopId={session.shopId}
        token={session.token}
        onDone={() => setScreen("dashboard")}
      />
    );
  }

  if (screen === "earnings") {
    return <Earnings shopId={session.shopId} token={session.token} onBack={() => setScreen("dashboard")} />;
  }

  return (
    <Dashboard
      shopId={session.shopId}
      token={session.token}
      shopName={session.shopName}
      showQrOnMount={justSignedUp}
      onQrShown={() => setJustSignedUp(false)}
      onLogout={handleLogout}
      onOpenSettings={() => setScreen("settings")}
      onOpenEarnings={() => setScreen("earnings")}
    />
  );
}
