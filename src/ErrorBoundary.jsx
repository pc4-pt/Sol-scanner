// ErrorBoundary.jsx — a render error must NEVER white-screen the app while real
// positions are open. Catches the error, shows what happened, and offers recovery.
// Positions/queue/history live in localStorage, so state survives a reload.
import { Component } from "react";

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info);
    this.setState({ info });
  }
  render() {
    if (!this.state.error) return this.props.children;
    const msg = this.state.error?.message || String(this.state.error);
    return (
      <div style={{ padding: 24, fontFamily: "'IBM Plex Mono', monospace",
        color: "#e2e8f0", background: "#0a0e14", minHeight: "100vh" }}>
        <div style={{ maxWidth: 640, margin: "40px auto",
          border: "1px solid #ff3860", borderRadius: 10, padding: 20, background: "#13171f" }}>
          <div style={{ color: "#ff3860", fontSize: "0.9rem", fontWeight: 700, marginBottom: 10 }}>
            ⚠ INTERFACE ERROR — trading halted
          </div>
          <p style={{ fontSize: "0.72rem", lineHeight: 1.6, color: "#94a3b8" }}>
            The dashboard hit a rendering error. Your positions, queue and history are
            saved locally and will still be here after reloading.
          </p>
          <p style={{ fontSize: "0.72rem", lineHeight: 1.6, color: "#f0a500" }}>
            If you hold an open position, check your wallet and consider selling
            manually (pump.fun or the app after reload) before resuming.
          </p>
          <pre style={{ fontSize: "0.62rem", color: "#ff6b8a", background: "#0a0e14",
            border: "1px solid #1e2633", borderRadius: 6, padding: 10, overflowX: "auto",
            whiteSpace: "pre-wrap" }}>{msg}</pre>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => window.location.reload()} style={{
              background: "#00e5c3", color: "#06121a", border: "none", borderRadius: 6,
              padding: "8px 16px", fontSize: "0.68rem", fontWeight: 700,
              fontFamily: "inherit", cursor: "pointer" }}>RELOAD DASHBOARD</button>
            <button onClick={() => this.setState({ error: null, info: null })} style={{
              background: "transparent", border: "1px solid #1e2633", color: "#94a3b8",
              borderRadius: 6, padding: "8px 16px", fontSize: "0.68rem",
              fontFamily: "inherit", cursor: "pointer" }}>TRY TO CONTINUE</button>
          </div>
          <p style={{ fontSize: "0.6rem", color: "#64748b", marginTop: 12, marginBottom: 0 }}>
            Note: the burner key is memory-only and clears on reload — re-enter it to resume trading.
          </p>
        </div>
      </div>
    );
  }
}
