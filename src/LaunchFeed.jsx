// LaunchFeed.jsx — live t=0 launch-score feed (the new entry brain).
// Streams pump.fun creations via PumpPortal, scores each at second zero, ranks them,
// and lets you queue high-score launches (which then run through the existing safety,
// execution, and trailing-exit plumbing). Paper-first: queueing is manual unless you
// turn on auto-queue, and buys are manual unless autoExecute is on.

import { useEffect, useRef, useState, useMemo } from "react";
import { useLaunchStream } from "./pumpStream.js";
import { MODEL_INFO } from "./launchScore.js";
import { BurnerWallet } from "./BurnerWallet.jsx";

const scoreColor = (s) =>
  s >= 70 ? "#00e5c3" : s >= 55 ? "#b8f542" : s >= 40 ? "#f0a500" : "#64748b";

// eligibility state -> { label, color, canQueue }
const ELIG = {
  pending:   { label: "…WAITING",   color: "#64748b", canQueue: false },
  checking:  { label: "…CHECKING",  color: "#f0a500", canQueue: false },
  eligible:  { label: "✓ ELIGIBLE", color: "#00e5c3", canQueue: true  },
  stagnant:  { label: "◷ STAGNANT", color: "#f0a500", canQueue: false },
  collapsed: { label: "✗ COLLAPSED", color: "#ff3860", canQueue: false },
  no_exit:   { label: "✗ NO EXIT",  color: "#ff3860", canQueue: false },
  no_route:  { label: "… NO ROUTE", color: "#64748b", canQueue: false },
};
const eligOf = (l) => ELIG[l.eligibility?.state || "pending"] || ELIG.pending;
const fmtPct = (v) => (v > 0 ? "+" : "") + (v ?? 0).toFixed(0) + "%";

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
    keep: 80,
    confirmWindowSec: s.confirmWindowSec ?? 90,
    probeSol: s.probeSol ?? 0.05,
    minRecovery: s.minRoundTripRecovery ?? 0.7,
    minTrades5m: s.minTrades5m ?? 4,
    minLiqUsd: s.minLiqUsd ?? 400,
    collapseDropPct: s.collapseDropPct ?? 40,
    sustainSec: s.sustainWindowSec ?? 90,
    minSamples: s.minMomentumSamples ?? 4,
    validateMinScore: Math.min(minScore, s.minExecScore ?? 68),
  });

  const ranked = useMemo(
    () => [...launches].sort((a, b) => b.score - a.score), [launches]);
  const isPlaceholder = !!MODEL_INFO._note;
  const [expanded, setExpanded] = useState(null);   // mint whose inline chart is open

  // Auto-queue newly-eligible launches that clear the QUALITY gates (deduped) when enabled.
  // Only ELIGIBLE launches (survived the confirmation window, still sellable) are queued —
  // this is what stops unvalidated/collapsed tokens from ever being auto-bought.
  const seen = useRef(new Set());
  useEffect(() => {
    if (!s.launchAutoQueue) return;
    const minExec = s.minExecScore ?? 68;
    const minDev  = s.minDevSol ?? 1.0;
    const millN   = s.millMinLaunches ?? 5;
    for (const l of launches) {
      if (seen.current.has(l.mint)) continue;
      if (l.eligibility?.state !== "eligible") continue;         // survival gate
      if (l.eligibility?.timing !== "sustained") continue;       // sustained-momentum gate
      if (l.score < minExec) continue;
      if ((l.devSol ?? 0) < minDev) continue;
      if (s.blockTokenMills && l.priorCount >= millN && (l.priorGrads ?? 0) === 0) continue;
      seen.current.add(l.mint);
      trading.addLaunchToQueue(l, "auto");
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
        <BurnerWallet trading={trading} />
      </div>

      {/* feed */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {ranked.filter(l => l.score >= minScore).length === 0 && (
          <p style={{ textAlign: "center", padding: 40, color: "var(--muted)", fontSize: "0.75rem" }}>
            {status === "live" ? "Waiting for launches above the score threshold…"
              : "Stream not connected."}
          </p>
        )}
        {ranked.filter(l => l.score >= minScore).map((l) => {
          const e = eligOf(l);
          const canQueue = l.graduated || e.canQueue;   // graduated = definitively alive
          const el = l.eligibility || {};
          const hasAct = el.trades5m != null;
          const pc = el.priceChange5m ?? 0;
          const pcColor = pc > 0 ? "#00e5c3" : pc < 0 ? "#ff3860" : "var(--muted)";
          const isOpen = expanded === l.mint;
          return (
          <div key={l.mint}>
          <div style={{ display: "grid",
            gridTemplateColumns: "40px 1fr auto auto auto 26px auto", alignItems: "center", gap: 10,
            padding: "9px 12px", background: "var(--panel, #13171f)",
            border: "1px solid var(--border)", borderRadius: 8,
            borderBottomLeftRadius: isOpen ? 0 : 8, borderBottomRightRadius: isOpen ? 0 : 8 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "0.9rem",
              color: scoreColor(l.score), textAlign: "center" }}>{l.score}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: "0.74rem", color: "var(--text, #e2e8f0)", fontWeight: 600,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {l.symbol} {l.isMayhem && <span style={{ color: "#ff3860", fontSize: "0.58rem" }}>⚡</span>}
              </div>
              <div style={{ fontSize: "0.58rem", fontFamily: "var(--font-mono)" }}>
                {hasAct
                  ? <><span style={{ color: pcColor }}>{fmtPct(pc)} 5m</span>
                      <span style={{ color: "var(--muted)" }}> · {el.trades5m}tx</span>
                      {el.buyPressure != null && <span style={{
                        color: el.buyPressure >= 0.55 ? "#00e5c3" : el.buyPressure < 0.45 ? "#ff3860" : "var(--muted)" }}>
                        {" · "}{Math.round(el.buyPressure*100)}%buys</span>}
                      {el.state === "eligible" && el.timing && el.timing !== "building" && (() => {
                        const map = {
                          sustained: ["#00e5c3", "▲SUSTAINED"], steady: ["#b8f542", "•STEADY"],
                          cooling: ["#f0a500", "•COOLING"], fading: ["#ff3860", "▼FADING"],
                        };
                        const [c2, lbl] = map[el.timing] || ["var(--muted)", ""];
                        return lbl ? <span style={{ color: c2, fontWeight: 700 }}>{" · "}{lbl}</span> : null;
                      })()}
                    </>
                  : <span style={{ color: "var(--muted)" }}>{new Date(l.ts).toLocaleTimeString()}</span>}
              </div>
            </div>
            <div style={{ fontSize: "0.62rem", color: "var(--muted2)", fontFamily: "var(--font-mono)", textAlign: "right" }}>
              dev {l.devSol.toFixed(2)}
            </div>
            <div style={{ fontSize: "0.62rem", color: l.priorGrads > 0 ? "#b8f542" : "var(--muted)",
              fontFamily: "var(--font-mono)", textAlign: "right" }}>
              {l.priorGrads}/{l.priorCount}
            </div>
            <div style={{ fontSize: "0.56rem", fontFamily: "var(--font-mono)", textAlign: "right",
              color: l.graduated ? "#00e5c3" : e.color, minWidth: 74 }}>
              {l.graduated ? "◆ GRAD" : e.label}
              {el.state === "collapsed" && el.recovered != null &&
                <span style={{ color: "var(--muted)" }}> {Math.round(el.recovered*100)}%</span>}
            </div>
            <button onClick={() => setExpanded(isOpen ? null : l.mint)}
              title={el.pairAddress ? "Toggle chart" : "Chart available once listed"}
              disabled={!el.pairAddress}
              style={{ background: "transparent", border: "none",
                color: el.pairAddress ? "var(--muted2)" : "var(--border)",
                cursor: el.pairAddress ? "pointer" : "default", fontSize: "0.7rem", padding: 2 }}>
              {isOpen ? "▲" : "▼"}
            </button>
            <button onClick={() => canQueue && trading.addLaunchToQueue(l)}
              disabled={!canQueue}
              title={canQueue ? "Queue for buy" : `Not queueable (${e.label.trim()})`}
              style={{
              background: canQueue ? "var(--accent, #00e5c3)" : "var(--border)",
              color: canQueue ? "#06121a" : "var(--muted)", border: "none", borderRadius: 6,
              padding: "5px 11px", fontSize: "0.62rem", fontWeight: 700, fontFamily: "var(--font-mono)",
              cursor: canQueue ? "pointer" : "not-allowed", letterSpacing: "0.05em",
              opacity: canQueue ? 1 : 0.5 }}>QUEUE</button>
          </div>
          {isOpen && el.pairAddress && (
            <iframe title={`chart-${l.mint}`} loading="lazy"
              src={`https://dexscreener.com/solana/${el.pairAddress}?embed=1&theme=dark&info=0&trades=0`}
              style={{ width: "100%", height: 320, border: "1px solid var(--border)",
                borderTop: "none", borderBottomLeftRadius: 8, borderBottomRightRadius: 8,
                background: "#0a0e14" }} />
          )}
          </div>
          );
        })}
      </div>
    </div>
  );
}
