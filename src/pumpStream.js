// pumpStream.js — live PumpPortal feed (free, no key): token creations + migrations.
//
// Maintains the creator track record in the browser (persisted), scores every new
// launch at t=0, and exposes a ranked live feed. Migrations (graduations) flow back
// into the creator history so the track-record signal sharpens over time.
//
// Free stream gives subscribeNewToken + subscribeMigration. Trades (subscribeTokenTrade)
// require a funded key and are NOT needed for the launch-score signal.

import { useEffect, useRef, useState, useCallback } from "react";
import { CreatorHistory, launchScore, markGraduated } from "./launchScore.js";
import { simulateRoundTrip, fetchCurrentPrice } from "./tradingEngine.js";

const URL = "wss://pumpportal.fun/api/data";

// Framework-agnostic engine: connect, score, callback. UI subscribes via the hook.
export function createPumpStream({ onLaunch, onMigration, onStatus }) {
  let ws = null, stop = false, retry = 0;
  const history = new CreatorHistory();

  function connect() {
    if (stop) return;
    onStatus?.("connecting");
    ws = new WebSocket(URL);

    ws.onopen = () => {
      retry = 0;
      onStatus?.("live");
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
    };

    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.message) return;                       // subscription ack / notice
      const tx = (m.txType || m.type || "").toLowerCase();

      if (tx === "create" && m.mint && m.traderPublicKey) {
        const prior = history.priorFor(m.traderPublicKey); // BEFORE recording (leak-free)
        const scored = launchScore(m, prior);
        history.recordCreate(m.mint, m.traderPublicKey);
        onLaunch?.({
          mint: m.mint,
          creator: m.traderPublicKey,
          symbol: m.symbol || "?",
          name: m.name || "",
          devSol: Number(m.solAmount) || 0,
          marketCapSol: Number(m.marketCapSol) || 0,
          vSol: Number(m.vSolInBondingCurve) || 0,
          vTokens: Number(m.vTokensInBondingCurve) || 0,
          // bonding-curve price at creation, in SOL per token (reserves ratio)
          priceSol: Number(m.vTokensInBondingCurve) > 0
            ? Number(m.vSolInBondingCurve) / Number(m.vTokensInBondingCurve) : 0,
          isMayhem: !!m.is_mayhem_mode,
          pool: m.pool || "pump",
          ts: Date.now(),
          ...scored,
        });
      } else if (tx.includes("migrat") && m.mint) {
        history.recordMigration(m.mint);
        markGraduated(m.mint);                        // for live badges in feed/queue/positions
        onMigration?.({ mint: m.mint, ts: Date.now() });
      }
    };

    ws.onclose = () => {
      if (stop) return;
      onStatus?.("reconnecting");
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 1000 * retry);           // backoff up to 6s
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  connect();
  return {
    history,
    close() { stop = true; try { ws && ws.close(); } catch {} },
  };
}

// ── Survival validation: at T+window, confirm the token is still alive & sellable ──
// Uses the same round-trip probe as the pre-buy guard. A token that died in the
// first minutes will have drained liquidity → no/poor sell route → not eligible.
// States: pending → checking → eligible | collapsed | no_exit | no_route
async function validateLaunch(mint, { probeSol = 0.05, slippageBps = 200, minRecovery = 0.7 }) {
  const lamports = Math.round(probeSol * 1e9);
  const rt = await simulateRoundTrip({ tokenMint: mint, amountLamports: lamports, slippageBps });
  if (!rt.sellable) {
    const noBuy = (rt.reason || "").toLowerCase().includes("buy route");
    return { state: noBuy ? "no_route" : "no_exit", recovered: 0, at: Date.now() };
  }
  if (rt.recovered < minRecovery) {
    return { state: "collapsed", recovered: rt.recovered, at: Date.now() };
  }
  return { state: "eligible", recovered: rt.recovered, at: Date.now() };
}

// React hook: ranked live launch feed + connection status + creator-history stats.
// Runs survival validation at confirmWindowSec and tags each launch's eligibility.
export function useLaunchStream({
  enabled = true, keep = 80,
  confirmWindowSec = 90, probeSol = 0.05, minRecovery = 0.7,
  validateMinScore = 40,           // only spend quote calls on launches worth showing
} = {}) {
  const [launches, setLaunches] = useState([]);
  const [status, setStatus]     = useState("idle");
  const [stats, setStats]       = useState({ creators: 0, grads: 0, mints: 0 });
  const [migrations, setMigrations] = useState(0);
  const engineRef = useRef(null);
  const validatedRef = useRef(new Set());   // mints already validated (or in-flight)
  const cfgRef = useRef({ confirmWindowSec, probeSol, minRecovery, validateMinScore });
  useEffect(() => {
    cfgRef.current = { confirmWindowSec, probeSol, minRecovery, validateMinScore };
  }, [confirmWindowSec, probeSol, minRecovery, validateMinScore]);

  useEffect(() => {
    if (!enabled) { setStatus("off"); return; }
    const engine = createPumpStream({
      onLaunch: (l) => {
        setLaunches((prev) => [{ ...l, eligibility: { state: "pending" } }, ...prev].slice(0, keep));
        setStats(engine.history.stats());
      },
      onMigration: (mg) => {
        setMigrations((n) => n + 1);
        setStats(engine.history.stats());
        // tag any visible launch for this mint as graduated
        setLaunches((prev) => prev.map((x) =>
          x.mint === mg.mint ? { ...x, graduated: true } : x));
      },
      onStatus: setStatus,
    });
    engineRef.current = engine;
    setStats(engine.history.stats());
    return () => engine.close();
  }, [enabled, keep]);

  // Validation loop: every few seconds, validate launches that are past the
  // confirmation window and not yet checked (bounded per tick to limit API calls).
  useEffect(() => {
    if (!enabled) return;
    const iv = setInterval(async () => {
      const { confirmWindowSec, probeSol, minRecovery, validateMinScore } = cfgRef.current;
      const now = Date.now();
      const due = [];
      setLaunches((prev) => {
        for (const l of prev) {
          if (l.graduated) continue;
          if ((l.score ?? 0) < validateMinScore) continue;
          if (validatedRef.current.has(l.mint)) continue;
          if (now - l.ts >= confirmWindowSec * 1000) due.push(l.mint);
        }
        return prev;
      });
      const batch = due.slice(0, 3);                 // cap concurrency per tick
      for (const mint of batch) {
        validatedRef.current.add(mint);
        setLaunches((prev) => prev.map((x) =>
          x.mint === mint ? { ...x, eligibility: { state: "checking" } } : x));
        validateLaunch(mint, { probeSol, minRecovery }).then((res) => {
          setLaunches((prev) => prev.map((x) =>
            x.mint === mint ? { ...x, eligibility: res } : x));
        }).catch(() => {
          setLaunches((prev) => prev.map((x) =>
            x.mint === mint ? { ...x, eligibility: { state: "no_route" } } : x));
        });
      }
    }, 4000);
    return () => clearInterval(iv);
  }, [enabled]);

  const clear = useCallback(() => setLaunches([]), []);
  return { launches, status, stats, migrations, clear };
}
