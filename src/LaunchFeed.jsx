// LaunchFeed.jsx — live t=0 launch-score feed (the new entry brain).
// Streams pump.fun creations via PumpPortal, scores each at second zero, ranks them,
// and lets you queue high-score launches (which then run through the existing safety,
// execution, and trailing-exit plumbing). Paper-first: queueing is manual unless you
// turn on auto-queue, and buys are manual unless autoExecute is on.

import { useEffect, useRef, useState, useMemo } from "react";
import { useLaunchStream } from "./pumpStream.js";
import { MODEL_INFO } from "./launchScore.js";

const scoreColor = (s) =>
  s >= 70 ? "#00e5c3" : s >= 55 ? "#b8f542" : s >= 40 ? "#f0a500" : "#64748b";

function StatusPill({ status }) {
  const map = {
    live: ["#00e5c3", "LIVE"], connecting: ["#f0a500", "CONNECTING"],
    reconnecting: ["#f0a500", "RECONNECTING"], off: ["#64748b", "OFF"], idle: ["#64748b", "IDLE"],
  };
  const [c, label] = map[status] || map.idle;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "0.6rem",
      fontFamily: "var(--font-mono)", color: c, letterSpacing: "0.1em" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: c,
        boxShadow: status === "live" ? `0 0 6px ${c}` : "none" }} />{label}
    </span>
  );
}

export function LaunchFeed({ trading }) {
  const s = trading.settings;
  const minScore = s.minLaunchScore ?? 55;
  const { launches, status, stats, migrations } = useLaunchStream({
    enabled: (s.entrySource ?? "launch") !== "off",
    minScore: 0, keep: 80,
  });

  const ranked = useMemo(
    () => [...launches].sort((a, b) => b.score - a.score), [launches]);
  const isPlaceholder = !!MODEL_INFO._note;

  // Auto-queue newly-arrived launches that clear the QUALITY gates (deduped) when enabled.
  // These gates factor the creator score to avoid tokens likely to die on/after creation:
  //   minExecScore — a higher bar than the display filter
  //   minDevSol    — tiny dev buys dominate the tokens that instantly die
  //   token mills  — creators with many prior launches and zero graduations (spam)
  const seen = useRef(new Set());
  useEffect(() => {
    if (!s.launchAutoQueue) return;
    const minExec = s.minExecScore ?? 68;
    const minDev  = s.minDevSol ?? 1.0;
    const millN   = s.millMinLaunches ?? 5;
    for (const l of launches) {
      if (seen.current.has(l.mint)) continue;
      if (l.score < minExec) continue;
      if ((l.devSol ?? 0) < minDev) continue;
      if (s.blockTokenMills && l.priorCount >= millN && (l.priorGrads ?? 0) === 0) continue;
      seen.current.add(l.mint);
      trading.addLaunchToQueue(l);
    }
  }, [launches, s.launchAutoQueue, s.minExecScore, s.minDevSol, s.blockTokenMills, s.millMinLaunches, trading]);

  const set = (patch) => trading.updateSettings(patch);

  return (
    <div style={{ paddingTop: 16, animation: "fadeIn 0.2s ease" }}>
      {isPlaceholder && (
        <div style={{ background: "#f0a50012", border: "1px solid #f0a50040", borderRadius: 8,
          padding: "10px 12px", marginBottom: 14, fontSize: "0.66rem", color: "#f0a500", lineHeight: 1.6 }}>
          ⚠ Using PLACEHOLDER model coefficients. Run <code>launch_score.py</code> on your real
          creator_dataset.csv and replace <code>src/launchModel.json</code> with the export to
          calibrate scores to your data.
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14, flexWrap: "wrap" }}>
        <StatusPill status={status} />
        <span style={{ fontSize: "0.62rem", color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
          creators tracked {stats.creators.toLocaleString()} · graduations seen {stats.grads.toLocaleString()}
          {migrations > 0 ? ` · +${migrations} this session` : ""}
        </span>
      </div>

      <p style={{ fontSize: "0.68rem", color: "var(--muted2)", marginBottom: 14, lineHeight: 1.6 }}>
        Scored at the moment of creation from the dev's initial buy and the creator's track record —
        the leading signal validated in research. The creator history builds as the stream runs
        (graduations feed back in), so scores sharpen over time. Queueing is manual unless you enable
        auto-queue; buys stay manual unless <code>autoExecute</code> is on.
      </p>

      {/* controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 16, flexWrap: "wrap" }}>
        <label style={{ fontSize: "0.64rem", color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
          MIN SCORE {minScore}
          <input type="range" min={0} max={90} value={minScore}
            onChange={(e) => set({ minLaunchScore: Number(e.target.value) })}
            style={{ verticalAlign: "middle", marginLeft: 8, width: 120 }} />
        </label>
        <label style={{ fontSize: "0.64rem", color: "var(--muted)", fontFamily: "var(--font-mono)",
          display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={!!s.launchAutoQueue}
            onChange={(e) => set({ launchAutoQueue: e.target.checked })} />
          AUTO-QUEUE ≥ MIN
        </label>
        <span style={{ fontSize: "0.6rem", color: s.autoExecute ? "#ff3860" : "var(--muted)",
          fontFamily: "var(--font-mono)" }}>
          {s.autoExecute ? "● AUTO-EXECUTE ON (real buys)" : "○ manual buy (paper-safe)"}
        </span>
      </div>

      {/* feed */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {ranked.filter(l => l.score >= minScore).length === 0 && (
          <p style={{ textAlign: "center", padding: 40, color: "var(--muted)", fontSize: "0.75rem" }}>
            {status === "live" ? "Waiting for launches above the score threshold…"
              : "Stream not connected."}
          </p>
        )}
        {ranked.filter(l => l.score >= minScore).map((l) => (
          <div key={l.mint} style={{ display: "grid",
            gridTemplateColumns: "44px 1fr auto auto auto", alignItems: "center", gap: 12,
            padding: "9px 12px", background: "var(--panel, #13171f)",
            border: "1px solid var(--border)", borderRadius: 8 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "0.9rem",
              color: scoreColor(l.score), textAlign: "center" }}>{l.score}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: "0.74rem", color: "var(--text, #e2e8f0)", fontWeight: 600,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {l.symbol} {l.isMayhem && <span style={{ color: "#ff3860", fontSize: "0.58rem" }}>⚡MAYHEM</span>}
              </div>
              <div style={{ fontSize: "0.58rem", color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                {l.lift ? `${l.lift.toFixed(1)}× base` : ""} · {new Date(l.ts).toLocaleTimeString()}
              </div>
            </div>
            <div style={{ fontSize: "0.62rem", color: "var(--muted2)", fontFamily: "var(--font-mono)", textAlign: "right" }}>
              dev {l.devSol.toFixed(2)} SOL
            </div>
            <div style={{ fontSize: "0.62rem", color: l.priorGrads > 0 ? "#b8f542" : "var(--muted)",
              fontFamily: "var(--font-mono)", textAlign: "right" }}>
              creator {l.priorGrads}/{l.priorCount}
            </div>
            <button onClick={() => trading.addLaunchToQueue(l)} style={{
              background: "var(--accent, #00e5c3)", color: "#06121a", border: "none", borderRadius: 6,
              padding: "5px 12px", fontSize: "0.62rem", fontWeight: 700, fontFamily: "var(--font-mono)",
              cursor: "pointer", letterSpacing: "0.05em" }}>QUEUE</button>
          </div>
        ))}
      </div>
    </div>
  );
}
