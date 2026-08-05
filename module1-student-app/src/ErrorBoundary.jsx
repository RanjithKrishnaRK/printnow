import { Component } from "react";

// Wraps the whole app. Without this, any uncaught error during render -
// anywhere, not just in QR scanning - unmounts everything React was
// managing and leaves a blank white page with no clue what happened. This
// turns that into a visible, recoverable screen instead.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("PrintNow crashed:", error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
            fontFamily: "system-ui, sans-serif",
            background: "#FAF6EE",
          }}
        >
          <div style={{ maxWidth: 380, textAlign: "center" }}>
            <p style={{ fontSize: 15, fontWeight: 600, color: "#1c1917", marginBottom: 8 }}>
              Something went wrong
            </p>
            <p style={{ fontSize: 13, color: "#78716c", marginBottom: 20 }}>
              Sorry about that. Reloading usually fixes it - if it keeps happening, let us know
              what you were doing right before this screen showed up.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: "#A63A2C",
                color: "white",
                fontWeight: 600,
                fontSize: 14,
                borderRadius: 8,
                padding: "12px 20px",
                border: "none",
              }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
