// LifecycleLog.jsx — the measured view of the buy window.
import { useState, useEffect } from "react";
import { getLog, deriveRow, summary, clearLog, downloadCSV } from "./lifecycleLog.js";

const fmtS = (v) => (v == null || v === "" ? "—" : `${Number(v).toFixed(0)}s`);
const fmtPct = (v) => (v == null || v === "" ? "—" : `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(0)}%`);

function Stat({ label, value, sub }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px",
      background: "var(--panel,#13171f)", minWidth: 110 }}>
      <div style={{ fontSize: "0.56rem", color: "var(--muted)", fontFamily: "var(--font-mono,monospace)",
        letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: "1.05rem", color: "var(--text,#e2e8f0)", fontWeight: 700, marginTop: 3 }}>{value}</div>
      {sub && <div style={{ fontSize: "0.54rem", color: "var(--muted2)" }}>{sub}</div>}
    </div>
  );
}

export function LifecycleLog() {
  const [, tick] = useState(0);
  useEffect(() => { const iv = setInterval(() => tick(n => n + 1), 4000); return () => clearInterval(iv); }, []);

  const rows = getLog().map(deriveRow).sort((a, b) =>
    (b.t_eligible || "").localeCompare(a.t_eligible || ""));
  const s = summary();

  return (
    <div style={{ paddingTop: 16, animation: "fadeIn 0.2s ease" }}>
      <p style={{ fontSize: "0.68rem", color: "var(--muted2)", marginBottom: 14, lineHeight: 1.6 }}>
        Every token's lifecycle, timestamped. <b>window</b> = how long sustained momentum lasted
        (the opportunity). <b>react</b> = queued→bought (is manual fast enough?). <b>in-time</b> =
        did you buy before it faded. Export to analyse whether the window is tradeable and where to tune.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <Stat label="tracked" value={s.tracked} sub={`${s.sustained} sustained`} />
        <Stat label="avg window" value={fmtS(s.avgWindowS)} sub="sustained→fading" />
        <Stat label="window move" value={fmtPct(s.avgWindowMove)} sub="price across window" />
        <Stat label="avg react" value={fmtS(s.avgReactionS)} sub="queued→bought" />
        <Stat label="run-up to buy" value={fmtPct(s.avgSlipToBuy)} sub="moved before entry" />
        <Stat label="upside at entry" value={fmtPct(s.avgAfterBuy)} sub="entry→fade" />
        <Stat label="bought in time" value={s.boughtInTime == null ? "—" : `${Math.round(s.boughtInTime * 100)}%`} sub={`of ${s.bought} buys`} />
        <Stat label="win rate" value={s.winRate == null ? "—" : `${Math.round(s.winRate * 100)}%`} sub={`${s.sold} closed`} />
        <Stat label="avg P&L" value={fmtPct(s.avgPnl)} sub="per closed trade" />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={downloadCSV} style={{ background: "var(--accent,#00e5c3)", color: "#06121a",
          border: "none", borderRadius: 6, padding: "6px 14px", fontSize: "0.62rem", fontWeight: 700,
          fontFamily: "var(--font-mono,monospace)", cursor: "pointer" }}>⬇ DOWNLOAD CSV</button>
        <button onClick={() => { if (confirm("Clear all lifecycle data?")) { clearLog(); tick(n => n + 1); } }}
          style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--muted)",
          borderRadius: 6, padding: "6px 14px", fontSize: "0.62rem", fontFamily: "var(--font-mono,monospace)",
          cursor: "pointer" }}>CLEAR</button>
      </div>

      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono,monospace)",
          fontSize: "0.6rem" }}>
          <thead>
            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
              {["token", "score", "src", "window", "w.move", "react", "run-up", "after-buy", "in-time", "hold", "P&L", "peak", "exit"].map(h =>
                <th key={h} style={{ padding: "7px 9px", borderBottom: "1px solid var(--border)",
                  whiteSpace: "nowrap" }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((r) => (
              <tr key={r.mint} style={{ color: "var(--muted2)" }}>
                <td style={{ padding: "6px 9px", color: "var(--text,#e2e8f0)" }}>{r.symbol}</td>
                <td style={{ padding: "6px 9px" }}>{r.score}</td>
                <td style={{ padding: "6px 9px", color: r.source === "auto" ? "#7c5cff" : "var(--muted2)" }}>{r.source || "—"}</td>
                <td style={{ padding: "6px 9px" }}>{fmtS(r.window_s)}</td>
                <td style={{ padding: "6px 9px", color: r.move_window_pct === null ? "var(--muted)" : Number(r.move_window_pct) >= 0 ? "#00e5c3" : "#ff3860" }}>{fmtPct(r.move_window_pct)}</td>
                <td style={{ padding: "6px 9px" }}>{fmtS(r.reaction_s)}</td>
                <td style={{ padding: "6px 9px", color: "#f0a500" }}>{fmtPct(r.slip_to_buy_pct)}</td>
                <td style={{ padding: "6px 9px", color: r.after_buy_pct === null ? "var(--muted)" : Number(r.after_buy_pct) >= 0 ? "#00e5c3" : "#ff3860" }}>{fmtPct(r.after_buy_pct)}</td>
                <td style={{ padding: "6px 9px", color: r.inTime === "LATE" ? "#ff3860" : r.inTime === "yes" ? "#00e5c3" : "var(--muted)" }}>{r.inTime || "—"}</td>
                <td style={{ padding: "6px 9px" }}>{fmtS(r.hold_s)}</td>
                <td style={{ padding: "6px 9px", color: r.pnlPct === "" ? "var(--muted)" : Number(r.pnlPct) >= 0 ? "#00e5c3" : "#ff3860" }}>{fmtPct(r.pnlPct)}</td>
                <td style={{ padding: "6px 9px" }}>{fmtPct(r.peakPnlPct)}</td>
                <td style={{ padding: "6px 9px" }}>{r.exitReason || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p style={{ textAlign: "center", padding: 30, color: "var(--muted)", fontSize: "0.72rem" }}>
            No lifecycle data yet — it records as tokens pass through eligibility, queue, buy, and sell.
          </p>
        )}
      </div>
    </div>
  );
}
