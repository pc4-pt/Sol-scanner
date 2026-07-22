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

function PeakHistogram({ rows }) {
  const peaks = rows.map(r => r.upside_pct).filter(v => v !== "" && v != null).map(Number);
  if (peaks.length < 5) return null;
  const buckets = [
    { label: "≤0%", lo: -1e9, hi: 0.0001, color: "#ff3860" },
    { label: "0–10", lo: 0.0001, hi: 10, color: "#f0a500" },
    { label: "10–20", lo: 10, hi: 20, color: "#b8f542" },
    { label: "20–30", lo: 20, hi: 30, color: "#8ee642" },
    { label: "30–50", lo: 30, hi: 50, color: "#00e5c3" },
    { label: "50–100", lo: 50, hi: 100, color: "#00c3e5" },
    { label: "100+", lo: 100, hi: 1e9, color: "#7c5cff" },
  ].map(b => ({ ...b, n: peaks.filter(p => p >= b.lo && p < b.hi).length }));
  const max = Math.max(...buckets.map(b => b.n), 1);
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: "0.6rem", color: "var(--muted)", fontFamily: "var(--font-mono,monospace)",
        letterSpacing: "0.1em", marginBottom: 8 }}>PEAK DISTRIBUTION — max gain after sustained (n={peaks.length})</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120,
        borderBottom: "1px solid var(--border)", paddingBottom: 2 }}>
        {buckets.map(b => (
          <div key={b.label} style={{ flex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
            <div style={{ fontSize: "0.56rem", color: "var(--muted2)", fontFamily: "var(--font-mono,monospace)" }}>{b.n}</div>
            <div style={{ width: "100%", height: `${(b.n / max) * 90}%`, background: b.color,
              borderRadius: "3px 3px 0 0", minHeight: b.n ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        {buckets.map(b => (
          <div key={b.label} style={{ flex: 1, textAlign: "center", fontSize: "0.5rem",
            color: "var(--muted)", fontFamily: "var(--font-mono,monospace)" }}>{b.label}</div>
        ))}
      </div>
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

      <div style={{ fontSize: "0.6rem", color: "var(--muted)", fontFamily: "var(--font-mono,monospace)",
        letterSpacing: "0.1em", marginBottom: 6 }}>OPPORTUNITY — passive paper result of every sustained token</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <Stat label="tracked (paper)" value={s.opp_n} sub="sustained + followed" />
        <Stat label="median peak" value={fmtPct(s.opp_medianPeak)} sub="sustained→max" />
        <Stat label="reached +20%" value={s.opp_over20 == null ? "—" : `${Math.round(s.opp_over20 * 100)}%`} sub="of tracked" />
        <Stat label="reached +50%" value={s.opp_over50 == null ? "—" : `${Math.round(s.opp_over50 * 100)}%`} sub="of tracked" />
        <Stat label="reached +100%" value={s.opp_over100 == null ? "—" : `${Math.round(s.opp_over100 * 100)}%`} sub="of tracked" />
        <Stat label="median time-to-peak" value={fmtS(s.opp_medianTimeToPeak)} sub="how fast to act" />
      </div>

      <PeakHistogram rows={rows} />

      <div style={{ fontSize: "0.6rem", color: "var(--muted)", fontFamily: "var(--font-mono,monospace)",
        letterSpacing: "0.1em", marginBottom: 6 }}>ACTIONABLE FILTER vs CONTROL — does non-mayhem + pcH1 + volH1 beat the rest?</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
        <Stat label="★ passed filter" value={s.filt_pass_n} sub="tracked" />
        <Stat label="passed hit +20%" value={s.filt_pass_hit20 == null ? "—" : `${Math.round(s.filt_pass_hit20 * 100)}%`} sub={`median ${fmtPct(s.filt_pass_med)}`} />
        <Stat label="control (failed)" value={s.filt_fail_n} sub="tracked" />
        <Stat label="control hit +20%" value={s.filt_fail_hit20 == null ? "—" : `${Math.round(s.filt_fail_hit20 * 100)}%`} sub={`median ${fmtPct(s.filt_fail_med)}`} />
      </div>

      <div style={{ fontSize: "0.6rem", color: "var(--muted)", fontFamily: "var(--font-mono,monospace)",
        letterSpacing: "0.1em", marginBottom: 6 }}>REALISED vs PAPER — execution efficiency on your actual trades</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <Stat label="trades" value={s.rvp_n} sub="closed" />
        <Stat label="paper peak" value={fmtPct(s.rvp_paperPeak)} sub="offered from sustained" />
        <Stat label="entry drag" value={fmtPct(s.rvp_entryDrag)} sub="run-up before you bought" />
        <Stat label="your peak" value={fmtPct(s.rvp_yourPeak)} sub="max up from entry" />
        <Stat label="realised" value={fmtPct(s.rvp_realised)} sub="what you kept" />
        <Stat label="capture" value={s.rvp_capture == null ? "—" : `${Math.round(s.rvp_capture * 100)}%`} sub="realised ÷ your peak" />
        <Stat label="peaked after exit" value={s.exitedEarly == null ? "—" : `${Math.round(s.exitedEarly * 100)}%`} sub="exited too early" />
      </div>
      <p style={{ fontSize: "0.58rem", color: "var(--muted)", marginBottom: 16, lineHeight: 1.5 }}>
        paper peak → your peak gap = entry timing cost · your peak → realised gap = exit efficiency.
        Low capture % means exiting too late; large entry drag means the run-up is eating the move.
      </p>

      <div style={{ fontSize: "0.6rem", color: "var(--muted)", fontFamily: "var(--font-mono,monospace)",
        letterSpacing: "0.1em", marginBottom: 6 }}>EXECUTION — your actual trades</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <Stat label="tracked" value={s.tracked} sub={`${s.sustained} sustained`} />
        <Stat label="avg window" value={fmtS(s.avgWindowS)} sub="sustained→fading" />
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
              {["token", "score", "src", "upside", "→pk", "window", "react", "run-up", "after-buy", "in-time", "P&L", "peak", "exit"].map(h =>
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
                <td style={{ padding: "6px 9px", fontWeight: 700, color: r.upside_pct === "" ? "var(--muted)" : Number(r.upside_pct) >= 20 ? "#00e5c3" : Number(r.upside_pct) > 0 ? "#b8f542" : "#ff3860" }}>{fmtPct(r.upside_pct)}</td>
                <td style={{ padding: "6px 9px", color: "var(--muted2)" }}>{fmtS(r.time_to_peak_s)}</td>
                <td style={{ padding: "6px 9px" }}>{fmtS(r.window_s)}</td>
                <td style={{ padding: "6px 9px" }}>{fmtS(r.reaction_s)}</td>
                <td style={{ padding: "6px 9px", color: "#f0a500" }}>{fmtPct(r.slip_to_buy_pct)}</td>
                <td style={{ padding: "6px 9px", color: r.after_buy_pct === null ? "var(--muted)" : Number(r.after_buy_pct) >= 0 ? "#00e5c3" : "#ff3860" }}>{fmtPct(r.after_buy_pct)}</td>
                <td style={{ padding: "6px 9px", color: r.inTime === "LATE" ? "#ff3860" : r.inTime === "yes" ? "#00e5c3" : "var(--muted)" }}>{r.inTime || "—"}</td>
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
