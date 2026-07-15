// BurnerWallet.jsx — low-friction local signing for a throwaway wallet.
// Renders as a compact pill in the controls row; details open in a dropdown so
// the row layout stays intact.
import { useState, useRef, useEffect } from "react";

export function BurnerWallet({ trading }) {
  const b = trading.burner;
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // close the dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pill = {
    display: "inline-flex", alignItems: "center", gap: 6,
    background: b.active ? "#00e5c314" : "transparent",
    border: `1px solid ${b.active ? "#00e5c3" : "var(--border)"}`,
    color: b.active ? "#00e5c3" : "var(--muted)",
    borderRadius: 6, padding: "5px 10px", fontSize: "0.6rem",
    fontFamily: "var(--font-mono)", cursor: "pointer", letterSpacing: "0.04em",
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button onClick={() => setOpen(o => !o)} style={pill}>
        {b.active
          ? <>● BURNER {b.balance != null ? `${b.balance.toFixed(3)}◎` : ""}</>
          : <>⚡ BURNER</>}
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 50,
          width: 320, background: "var(--panel, #13171f)",
          border: "1px solid var(--border)", borderRadius: 8, padding: 12,
          boxShadow: "0 8px 28px rgba(0,0,0,0.45)", fontFamily: "var(--font-mono)" }}>

          <div style={{ fontSize: "0.62rem", color: "var(--text, #e2e8f0)", fontWeight: 600,
            marginBottom: 6, letterSpacing: "0.04em" }}>BURNER WALLET</div>
          <p style={{ fontSize: "0.58rem", color: "var(--muted)", lineHeight: 1.5, margin: "0 0 10px" }}>
            Signs locally with no wallet popup for fast entries. Throwaway wallet only —
            never your main. Held in memory this tab, never saved, cleared on refresh.
          </p>

          {b.active ? (
            <>
              <div style={{ fontSize: "0.58rem", color: "#00e5c3", marginBottom: 6 }}>● active — trades sign locally</div>
              <div style={{ fontSize: "0.56rem", color: "var(--muted2)", wordBreak: "break-all",
                background: "#0a0e14", border: "1px solid var(--border)", borderRadius: 5,
                padding: "6px 8px", marginBottom: 6 }}>{b.address}</div>
              <div style={{ fontSize: "0.6rem", color: "var(--muted2)", marginBottom: 10 }}>
                balance <span style={{ color: "var(--accent, #00e5c3)" }}>
                  {b.balance != null ? `${b.balance.toFixed(4)} SOL` : "…"}</span>
              </div>
              <button onClick={() => { b.clear(); setOpen(false); }} style={{
                width: "100%", background: "#ff38601a", border: "1px solid #ff3860", color: "#ff3860",
                borderRadius: 6, padding: "6px 12px", fontSize: "0.6rem", fontFamily: "var(--font-mono)",
                cursor: "pointer" }}>CLEAR KEY</button>
            </>
          ) : (
            <>
              <input type="password" value={input} onChange={(e) => setInput(e.target.value)}
                placeholder="private key (base58 or [1,2,…])"
                style={{ width: "100%", boxSizing: "border-box", background: "#0a0e14",
                  border: "1px solid var(--border)", borderRadius: 6, padding: "7px 9px",
                  color: "var(--text, #e2e8f0)", fontSize: "0.6rem", fontFamily: "var(--font-mono)" }} />
              {b.error && <div style={{ color: "#ff3860", fontSize: "0.56rem", marginTop: 6 }}>{b.error}</div>}
              <button onClick={() => { b.setKey(input); setInput(""); }} style={{
                width: "100%", marginTop: 8, background: "var(--accent, #00e5c3)", color: "#06121a",
                border: "none", borderRadius: 6, padding: "7px 12px", fontSize: "0.62rem",
                fontWeight: 700, fontFamily: "var(--font-mono)", cursor: "pointer" }}>LOAD KEY</button>
            </>
          )}

          <div style={{ marginTop: 10, paddingTop: 9, borderTop: "1px solid var(--border)",
            fontSize: "0.54rem", color: "var(--muted)", lineHeight: 1.5 }}>
            Note: the PumpPortal trading wallet (coming next) is a <b style={{ color: "var(--muted2)" }}>separate</b> wallet —
            fund it separately from this burner and don't mix the two.
          </div>
        </div>
      )}
    </div>
  );
}
