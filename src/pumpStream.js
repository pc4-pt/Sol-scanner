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
import { simulateRoundTrip, fetchTokenActivity, computeTiming } from "./tradingEngine.js";

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

// ── Assess a launch: is it alive, SELLABLE, and actually MOVING? ──────────────
// Combines the round-trip sellability probe with DexScreener 5-minute activity.
// States:
//   eligible  — sellable + active (>= minTrades5m) + not collapsed   → queueable
//   stagnant  — sellable but little/no activity (e.g. a single trade) → NOT queueable
//   collapsed — price down hard, liquidity drained, or can't recover  → NOT queueable
//   no_exit   — no sell route (honeypot)      no_route — not tradeable yet
// `full` runs the round-trip (sellability); refreshes skip it and reuse `sellable`.
async function assessLaunch(mint, opts, full, prevSellable) {
  const { probeSol, minRecovery, minTrades5m, minLiqUsd, collapseDropPct } = opts;
  const act = await fetchTokenActivity(mint);

  let sellable = prevSellable, recovered = undefined;
  if (full || prevSellable == null) {
    const rt = await simulateRoundTrip({
      tokenMint: mint, amountLamports: Math.round(probeSol * 1e9), slippageBps: 200,
    });
    sellable = rt.sellable; recovered = rt.recovered;
    if (!rt.sellable) {
      const noBuy = (rt.reason || "").toLowerCase().includes("buy route");
      return { state: noBuy ? "no_route" : "no_exit", sellable: false, at: Date.now(),
               ...(act || {}) };
    }
    if (rt.recovered < minRecovery) {
      return { state: "collapsed", sellable: true, recovered, at: Date.now(), ...(act || {}) };
    }
  }

  const base = { sellable, recovered, at: Date.now(), ...(act || {}) };
  if (act) {
    if (act.liq > 0 && act.liq < minLiqUsd) return { state: "collapsed", ...base };
    if (act.priceChange5m <= -collapseDropPct) return { state: "collapsed", ...base };
    if (act.trades5m < minTrades5m)           return { state: "stagnant",  ...base };
    return { state: "eligible", ...base };
  }
  // sellable but not yet listed on DexScreener → no observable activity yet
  return { state: "stagnant", ...base };
}

// React hook: ranked live feed + connection status + creator-history stats.
// Polls activity/eligibility so momentum stays live and stagnant→active transitions surface.
export function useLaunchStream({
  enabled = true, keep = 80,
  confirmWindowSec = 90, probeSol = 0.05, minRecovery = 0.7,
  minTrades5m = 4, minLiqUsd = 400, collapseDropPct = 40,
  sustainSec = 90, minSamples = 4,
  validateMinScore = 40,
} = {}) {
  const [launches, setLaunches] = useState([]);
  const [status, setStatus]     = useState("idle");
  const [stats, setStats]       = useState({ creators: 0, grads: 0, mints: 0 });
  const [migrations, setMigrations] = useState(0);
  const engineRef = useRef(null);
  const launchesRef = useRef([]);
  useEffect(() => { launchesRef.current = launches; }, [launches]);
  const cfgRef = useRef({});
  useEffect(() => {
    cfgRef.current = { confirmWindowSec, probeSol, minRecovery, minTrades5m,
                       minLiqUsd, collapseDropPct, sustainSec, minSamples, validateMinScore };
  }, [confirmWindowSec, probeSol, minRecovery, minTrades5m, minLiqUsd, collapseDropPct, sustainSec, minSamples, validateMinScore]);

  useEffect(() => {
    if (!enabled) { setStatus("off"); return; }
    const engine = createPumpStream({
      onLaunch: (l) => {
        setLaunches((prev) => {
          if (prev.some((x) => x.mint === l.mint)) return prev;   // dedupe by mint
          return [{ ...l, eligibility: { state: "pending" } }, ...prev].slice(0, keep);
        });
        setStats(engine.history.stats());
      },
      onMigration: (mg) => {
        setMigrations((n) => n + 1);
        setStats(engine.history.stats());
        setLaunches((prev) => prev.map((x) => x.mint === mg.mint ? { ...x, graduated: true } : x));
      },
      onStatus: setStatus,
    });
    engineRef.current = engine;
    setStats(engine.history.stats());
    return () => engine.close();
  }, [enabled, keep]);

  // Polling loop: refresh activity + eligibility for eligible/stagnant/pending
  // launches past the confirmation window (terminal dead states are left alone).
  useEffect(() => {
    if (!enabled) return;
    const TERMINAL = new Set(["no_exit", "no_route", "collapsed"]);
    const iv = setInterval(() => {
      const c = cfgRef.current;
      const now = Date.now();
      const pool = launchesRef.current;
      const due = pool
        .filter((l) => !l.graduated
          && (l.score ?? 0) >= c.validateMinScore
          && now - l.ts >= c.confirmWindowSec * 1000
          && !TERMINAL.has(l.eligibility?.state))
        .sort((a, b) => (a.eligibility?.at || 0) - (b.eligibility?.at || 0)); // stalest first
      const batch = due.slice(0, 4);
      for (const l of batch) {
        const first = !l.eligibility?.at;
        if (first) {
          setLaunches((prev) => prev.map((x) =>
            x.mint === l.mint ? { ...x, eligibility: { ...x.eligibility, state: "checking" } } : x));
        }
        assessLaunch(l.mint, c, first, l.eligibility?.sellable)
          .then((res) => setLaunches((prev) => prev.map((x) => {
            if (x.mint !== l.mint) return x;
            // maintain a trend buffer (last ~20 samples ≈ 2 min at 6s polls)
            const bp = res.trades5m > 0 ? res.buys5m / res.trades5m : 0.5;
            const sample = { ts: Date.now(), price: res.priceUsd ?? 0,
                             trades: res.trades5m ?? 0, buys: res.buys5m ?? 0, sells: res.sells5m ?? 0 };
            const trend = [...(x.trend || []), sample].slice(-20);
            const timing = res.trades5m != null
              ? computeTiming(trend, { sustainSec: c.sustainSec, minSamples: c.minSamples })
              : "building";
            return { ...x, trend, eligibility: { ...res, timing, buyPressure: bp } };
          })))
          .catch(() => {});
      }
    }, 6000);
    return () => clearInterval(iv);
  }, [enabled]);

  const clear = useCallback(() => setLaunches([]), []);
  return { launches, status, stats, migrations, clear };
}
