// PumpPortalProbe.jsx — Step 1 validation: a single manual buy + sell round-trip
// through PumpPortal's native bonding-curve execution, to confirm the stuck-sell
// problem is fixed before any of this is wired into automatic trading.
import { useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { pumpPortalTrade } from "./pumpPortal.js";

export function PumpPortalProbe({ trading }) {
  const b = trading.burner;
  const { connection } = useConnection();
  const [open, setOpen] = useState(false);
  const [mint, setMint] = useState("");
  const [buySol, setBuySol] = useState("0.01");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);

  const push = (kind, text, sig) => setLog(l => [{ kind, text, sig, t: Date.now() }, ...l].slice(0, 8));

  const run = async (action) => {
    if (!b.active) { push("err", "Load your PumpPortal wallet key in the burner first."); return; }
    if (!mint.trim()) { push("err", "Enter a token mint address."); return; }
    setBusy(true);
    push("info", `${action === "buy" ? "Buying" : "Selling"} ${action === "buy" ? buySol + " SOL of" : "100% of"} ${mint.slice(0, 6)}…`);
    try {
      const sig = await pumpPortalTrade({
        publicKey: b.publicKey.toBase58(),
        action, mint: mint.trim(),
        amount: action === "buy" ? Number(buySol) : "100%",
        denominatedInSol: action === "buy",
        signTransaction: b.signTransaction,
        connection,
      });
      push("ok", `${action.toUpperCase()} sent`, sig);
    } catch (e) {
      push("err", e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const pill = {
    display: "inline-flex", alignItems: "center", gap: 6,
    background: "transparent", border: "1px solid var(--border)", color: "var(--muted)",
    borderRadius: 6, padding: "5px 10px", fontSize: "0.6rem",
    fontFamily: "var(--font-mono)", cursor: "pointer", letterSpacing: "0.04em",
  };
  const btn = (bg, col) => ({
    flex: 1, background: bg, color: col, border: "none", borderRadius: 6,
    padding: "7px 12px", fontSize: "0.62rem", fontWeight: 700,
    fontFamily: "var(--font-mono)", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
  });
  const inp = {
    width: "100%", boxSizing: "border-box", background: "#0a0e14",
    border: "1px solid var(--border)", borderRadius: 6, padding: "7px 9px",
    color: "var(--text, #e2e8f0)", fontSize: "0.6rem", fontFamily: "var(--font-mono)",
  };

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button onClick={() => setOpen(o => !o)} style={pill}>⚡ NATIVE TEST</button>

      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 50,
          width: 340, background: "var(--panel, #13171f)", border: "1px solid var(--border)",
          borderRadius: 8, padding: 12, boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
          fontFamily: "var(--font-mono)" }}>

          <div style={{ fontSize: "0.62rem", color: "var(--text, #e2e8f0)", fontWeight: 600,
            marginBottom: 6 }}>NATIVE EXECUTION TEST (PumpPortal)</div>
          <p style={{ fontSize: "0.56rem", color: "var(--muted)", lineHeight: 1.5, margin: "0 0 10px" }}>
            One manual buy + sell round-trip on the bonding curve, to confirm sells don't
            get stuck. Uses the wallet loaded in the burner. Start tiny.
          </p>

          {!b.active && (
            <div style={{ fontSize: "0.56rem", color: "#f0a500", marginBottom: 8 }}>
              ⚠ Load your PumpPortal wallet's private key in the ⚡ BURNER panel first.
            </div>
          )}

          <input value={mint} onChange={e => setMint(e.target.value)}
            placeholder="token mint address" style={{ ...inp, marginBottom: 6 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: "0.56rem", color: "var(--muted)" }}>buy amount (SOL)</span>
            <input value={buySol} onChange={e => setBuySol(e.target.value)}
              style={{ ...inp, width: 80 }} />
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button disabled={busy} onClick={() => run("buy")} style={btn("var(--accent, #00e5c3)", "#06121a")}>TEST BUY</button>
            <button disabled={busy} onClick={() => run("sell")} style={btn("#ff386022", "#ff3860")}>TEST SELL 100%</button>
          </div>

          <div style={{ maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5 }}>
            {log.map((e, i) => (
              <div key={i} style={{ fontSize: "0.54rem", lineHeight: 1.4,
                color: e.kind === "ok" ? "#00e5c3" : e.kind === "err" ? "#ff3860" : "var(--muted2)" }}>
                {e.text}
                {e.sig && <> · <a href={`https://solscan.io/tx/${e.sig}`} target="_blank" rel="noreferrer"
                  style={{ color: "var(--accent, #00e5c3)" }}>{e.sig.slice(0, 8)}…</a></>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
