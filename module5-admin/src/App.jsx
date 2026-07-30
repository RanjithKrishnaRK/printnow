import { useState } from "react";
import Login from "./components/Login";
import Dashboard from "./components/Dashboard";
import { loadSession, saveSession } from "./auth";

export default function App() {
  const [session, setSession] = useState(() => loadSession());

  function handleLogin(token, email) {
    saveSession(token, email);
    setSession({ token, email });
  }

  function handleLogout() {
    setSession(null);
  }

  if (!session) {
    return <Login onLogin={handleLogin} />;
  }

  return <Dashboard token={session.token} email={session.email} onLogout={handleLogout} />;
}
