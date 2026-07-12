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
import { logMilestone, recordPeak, recordFeatures } from "./lifecycleLog.js";

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
  minSustainScore = 60,
  minSustainPcH1 = 40, minSustainVolH1 = 1500,
  validateMinScore = 40,
} = {}) {
  const [launches, setLaunches] = useState([]);
  const [status, setStatus]     = useState("idle");
  const [stats, setStats]       = useState({ creators: 0, grads: 0, mints: 0 });
  const [migrations, setMigrations] = useState(0);
  const engineRef = useRef(null);
  const launchesRef = useRef([]);
  const trackRef = useRef(new Map());   // mint -> passive peak-tracking state
  useEffect(() => { launchesRef.current = launches; }, [launches]);
  const cfgRef = useRef({});
  useEffect(() => {
    cfgRef.current = { confirmWindowSec, probeSol, minRecovery, minTrades5m,
                       minLiqUsd, collapseDropPct, sustainSec, minSamples, minSustainScore,
                       minSustainPcH1, minSustainVolH1, validateMinScore };
  }, [confirmWindowSec, probeSol, minRecovery, minTrades5m, minLiqUsd, collapseDropPct, sustainSec, minSamples, minSustainScore, minSustainPcH1, minSustainVolH1, validateMinScore]);

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
            // lifecycle logging (first occurrence of each milestone is recorded)
            if (res.state === "eligible")  logMilestone(x.mint, x.symbol, "eligible", { score: x.score, devSol: x.devSol, price: res.priceUsd });
            if (res.state === "collapsed") logMilestone(x.mint, x.symbol, "collapsed", { price: res.priceUsd });
            if (timing === "sustained") {
              logMilestone(x.mint, x.symbol, "sustained", { price: res.priceUsd });
              // liquidity: DexScreener usd is often empty for fresh pump pairs — fall
              // back to the SOL side of the pool as the liquidity measure.
              const liqUsd = res.liq || 0;
              const liqSol = res.liqSol || 0;
              const liqMeasure = liqUsd || liqSol;   // prefer usd, else SOL-denominated
              // ACTIONABLE FILTER (from the optimiser): non-mayhem + pcH1>=floor + volH1>=floor.
              // This is a FLAG, not a tracking gate — we still paper-track failing tokens as
              // a control group so we can confirm the filter's edge holds.
              const passedFilter =
                (x.isMayhem ? 0 : 1) &&
                ((res.priceChangeH1 ?? 0) >= c.minSustainPcH1) &&
                ((res.volH1 ?? 0) >= c.minSustainVolH1) ? 1 : 0;
              recordFeatures(x.mint, x.symbol, {
                f_devSol: x.devSol, f_launchMcapSol: x.marketCapSol,
                f_isMayhem: x.isMayhem ? 1 : 0,
                f_priorCount: x.priorCount, f_priorGrads: x.priorGrads,
                f_liq: liqUsd, f_liqSol: liqSol, f_fdv: res.fdv, f_ageMin: res.ageMin,
                f_vol5m: res.vol5m, f_volH1: res.volH1,
                f_buyRatio5m: res.trades5m ? +(res.buys5m / res.trades5m).toFixed(3) : null,
                f_buyRatioH1: res.tradesH1 ? +(res.buysH1 / res.tradesH1).toFixed(3) : null,
                f_pcH1: res.priceChangeH1,
                f_volLiq: liqMeasure ? +(res.vol5m / liqMeasure).toFixed(3) : null,
                f_hasSocials: res.hasSocials, f_hasWebsite: res.hasWebsite,
                f_nPairs: res.nPairs, f_boosts: res.boosts,
                f_passedFilter: passedFilter,
              });
              // passive peak tracking — track ALL score-qualified sustained tokens
              // (control group included); the passedFilter flag lets us compare.
              if (res.priceUsd > 0 && (x.score ?? 0) >= c.minSustainScore
                  && !trackRef.current.has(x.mint) && trackRef.current.size < 60) {
                trackRef.current.set(x.mint, {
                  symbol: x.symbol, sustainedPrice: res.priceUsd, sustainedTime: Date.now(),
                  peakPrice: res.priceUsd, peakTime: Date.now(),
                  lastPrice: res.priceUsd, startedAt: Date.now(),
                });
              }
              // expose the filter result on the launch for feed display + auto-queue
              res._passedFilter = passedFilter;
            }
            if (timing === "fading")       logMilestone(x.mint, x.symbol, "fading", { price: res.priceUsd });
            return { ...x, trend, eligibility: { ...res, timing, buyPressure: bp,
              passedFilter: res._passedFilter ?? x.eligibility?.passedFilter } };
          })))
          .catch(() => {});
      }
    }, 6000);
    return () => clearInterval(iv);
  }, [enabled]);

  usePeakTracker(trackRef, enabled);

  const clear = useCallback(() => setLaunches([]), []);
  return { launches, status, stats, migrations, clear };
}

// Passive peak-tracking loop: follows every sustained token's price (bought or not)
// to record the max upside that followed — a paper-trade dataset for whether the
// opportunity is real. Uses DexScreener only (no Jupiter load). Defined as a hook
// helper so it shares the trackRef populated when tokens hit sustained.
function usePeakTracker(trackRef, enabled) {
  useEffect(() => {
    if (!enabled) return;
    const MAX_TRACK_S = 900;        // follow each token up to 15 min after sustained
    const COLLAPSE_FRAC = 0.3;      // finalize early if price falls below 30% of sustained
    const iv = setInterval(async () => {
      const map = trackRef.current;
      if (!map.size) return;
      const now = Date.now();
      // poll the stalest few each tick to bound API load
      const entries = [...map.entries()].sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
      for (const [mint, t] of entries.slice(0, 6)) {
        t.lastSeen = now;
        let price = null;
        try { const act = await fetchTokenActivity(mint); price = act?.priceUsd || null; } catch {}
        if (price && price > t.peakPrice) { t.peakPrice = price; t.peakTime = now; }
        if (price) t.lastPrice = price;
        const agedOut = now - t.startedAt > MAX_TRACK_S * 1000;
        const collapsed = price && price < t.sustainedPrice * COLLAPSE_FRAC;
        if (agedOut || collapsed) {
          const peakPct = t.sustainedPrice > 0 ? ((t.peakPrice - t.sustainedPrice) / t.sustainedPrice) * 100 : 0;
          const ddAfterPeak = t.peakPrice > 0 ? ((t.lastPrice - t.peakPrice) / t.peakPrice) * 100 : 0;
          recordPeak(mint, t.symbol, {
            peakPct: +peakPct.toFixed(1),
            timeToPeakS: Math.round((t.peakTime - t.sustainedTime) / 1000),
            trackedS: Math.round((now - t.startedAt) / 1000),
            drawdownAfterPeak: +ddAfterPeak.toFixed(1),
          });
          map.delete(mint);
        }
      }
    }, 10000);
    return () => clearInterval(iv);
  }, [enabled, trackRef]);
}
