// BurnerWallet.jsx — enable low-friction local signing for a throwaway wallet.
import { useState } from "react";

export function BurnerWallet({ trading }) {
  const b = trading.burner;
  const [input, setInput] = useState("");
  const [show, setShow] = useState(false);

  if (!show && !b.active) {
    return (
      <button onClick={() => setShow(true)} style={{
        background: "transparent", border: "1px solid var(--border)", color: "var(--muted)",
        borderRadius: 6, padding: "5px 10px", fontSize: "0.6rem", fontFamily: "var(--font-mono,monospace)",
        cursor: "pointer", letterSpacing: "0.05em" }}>
        ⚡ ENABLE BURNER (1-CLICK BUYS)
      </button>
    );
  }

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12,
      background: "var(--panel,#13171f)", maxWidth: 460, fontFamily: "var(--font-mono,monospace)" }}>
      <div style={{ fontSize: "0.66rem", color: "#f0a500", marginBottom: 8, lineHeight: 1.5 }}>
        ⚠ Burner wallet — signs locally with no popup for fast entries. Use a THROWAWAY
        wallet with a little SOL only, never your main. Key stays in memory (this tab),
        is never saved, and clears on refresh.
      </div>

      {b.active ? (
        <div style={{ fontSize: "0.62rem", color: "var(--muted2)" }}>
          <div style={{ color: "#00e5c3" }}>● ACTIVE — trades sign locally</div>
          <div style={{ marginTop: 4, wordBreak: "break-all" }}>{b.address}</div>
          <div style={{ marginTop: 2 }}>balance: {b.balance != null ? `${b.balance.toFixed(4)} SOL` : "…"}</div>
          <button onClick={b.clear} style={{ marginTop: 8, background: "#ff386022",
            border: "1px solid #ff3860", color: "#ff3860", borderRadius: 6, padding: "5px 12px",
            fontSize: "0.6rem", cursor: "pointer" }}>CLEAR KEY</button>
        </div>
      ) : (
        <div>
          <input type="password" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="burner private key (base58 or [1,2,…])"
            style={{ width: "100%", boxSizing: "border-box", background: "#0a0e14",
              border: "1px solid var(--border)", borderRadius: 6, padding: "7px 9px",
              color: "var(--text,#e2e8f0)", fontSize: "0.62rem", fontFamily: "var(--font-mono,monospace)" }} />
          {b.error && <div style={{ color: "#ff3860", fontSize: "0.58rem", marginTop: 5 }}>{b.error}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={() => { b.setKey(input); setInput(""); }} style={{
              background: "var(--accent,#00e5c3)", color: "#06121a", border: "none", borderRadius: 6,
              padding: "6px 14px", fontSize: "0.62rem", fontWeight: 700, cursor: "pointer" }}>
              LOAD KEY
            </button>
            <button onClick={() => setShow(false)} style={{ background: "transparent",
              border: "1px solid var(--border)", color: "var(--muted)", borderRadius: 6,
              padding: "6px 14px", fontSize: "0.62rem", cursor: "pointer" }}>CANCEL</button>
          </div>
        </div>
      )}
    </div>
  );
}
