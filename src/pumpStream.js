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
import { fetchTokenActivity, computeTiming } from "./tradingEngine.js";
import { logMilestone, recordPeak, recordFeatures } from "./lifecycleLog.js";
import { recordGraduation, recordGradSnapshot, recordCreatorEvent,
         recordTrajectoryStart, recordTrajectorySnapshot } from "./discoveryLog.js";

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
//   no_route  — not listed on DexScreener yet (keeps polling, NOT terminal)
// `full` runs the round-trip (sellability); refreshes skip it and reuse `sellable`.
// ── Assess a launch: is it alive and actually MOVING? ─────────────────────────
// NOTE: this used to probe Jupiter (simulateRoundTrip) to decide "sellable". That was
// left over from Jupiter execution and is now WRONG: fresh bonding-curve tokens aren't
// routable on Jupiter, so every token failed as no_route and nothing ever reached
// eligible — starving the whole pipeline. We now execute on the curve via PumpPortal,
// where sellability is inherent, so eligibility is judged purely on live activity.
// States: eligible | stagnant | collapsed | no_route (not listed yet)
async function assessLaunch(mint, opts) {
  const { minTrades5m, minLiqUsd, collapseDropPct } = opts;
  const act = await fetchTokenActivity(mint);
  if (!act) {
    // Not on DexScreener yet — no observable activity, keep checking.
    return { state: "no_route", sellable: true, at: Date.now() };
  }
  const base = { sellable: true, at: Date.now(), ...act };
  if (act.liq > 0 && act.liq < minLiqUsd)      return { state: "collapsed", ...base };
  if (act.priceChange5m <= -collapseDropPct)   return { state: "collapsed", ...base };
  if (act.trades5m < minTrades5m)              return { state: "stagnant",  ...base };
  return { state: "eligible", ...base };
}

// React hook: ranked live feed + connection status + creator-history stats.
// Polls activity/eligibility so momentum stays live and stagnant→active transitions surface.
export function useLaunchStream({
  enabled = true, keep = 80,
  confirmWindowSec = 90, probeSol = 0.05, minRecovery = 0.7,
  minTrades5m = 4, minLiqUsd = 400, collapseDropPct = 40,
  sustainSec = 90, minSamples = 4,
  minSustainScore = 60,
  minSustainedAgeSec = 75,
  minSustainPcH1 = 40, maxSustainPcH1 = 120, minSustainVolH1 = 1500,
  validateMinScore = 40,
} = {}) {
  const [launches, setLaunches] = useState([]);
  const [status, setStatus]     = useState("idle");
  const [stats, setStats]       = useState({ creators: 0, grads: 0, mints: 0 });
  const [migrations, setMigrations] = useState(0);
  const engineRef = useRef(null);
  const launchesRef = useRef([]);
  const trackRef = useRef(new Map());   // mint -> passive peak-tracking state
  const gradTrackRef = useRef(new Map());       // mint -> post-graduation path tracking
  const trajTrackRef = useRef(new Map());       // mint -> post-READY trajectory tracking
  const discoveryEnabledRef = useRef(true);     // passive; on by default, cheap
  useEffect(() => { launchesRef.current = launches; }, [launches]);
  const cfgRef = useRef({});
  useEffect(() => {
    cfgRef.current = { confirmWindowSec, probeSol, minRecovery, minTrades5m,
                       minLiqUsd, collapseDropPct, sustainSec, minSamples, minSustainScore,
                       minSustainPcH1, maxSustainPcH1, minSustainVolH1, validateMinScore };
  }, [confirmWindowSec, probeSol, minRecovery, minTrades5m, minLiqUsd, collapseDropPct, sustainSec, minSamples, minSustainScore, minSustainPcH1, maxSustainPcH1, minSustainVolH1, validateMinScore]);

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
        setLaunches((prev) => prev.map((x) => {
          if (x.mint !== mg.mint) return x;
          // DISCOVERY (passive): record the graduation event + seed post-grad tracking.
          // Wrapped so any failure here can never affect the live feed / trading.
          try {
            if (discoveryEnabledRef.current) {
              recordGraduation(x.mint, x.symbol, {
                creator: x.creator || "",
                venue: (mg.pool || mg.venue || "").toString(),
                launchToGradSec: x.ts ? Math.round((Date.now() - x.ts) / 1000) : "",
                priceAtGrad: x.eligibility?.priceUsd ?? "",
                mcapAtGrad: x.eligibility?.marketCap ?? "",
                peakBeforeGrad: x.peakPct ?? "",
                f_devSol: x.f_devSol ?? x.devSol ?? "",
                f_priorGrads: x.f_priorGrads ?? x.priorGrads ?? "",
                f_priorCount: x.f_priorCount ?? x.priorCount ?? "",
                f_buyRatio: x.eligibility?.buyRatio ?? "",
              });
              if (x.creator) recordCreatorEvent(x.creator, "graduated");
              gradTrackRef.current.set(x.mint, { symbol: x.symbol, creator: x.creator || "", gradAt: Date.now(), done: {} });
            }
          } catch { /* discovery must never break the feed */ }
          return { ...x, graduated: true };
        }));
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
    // Only "collapsed" is genuinely dead. "no_route" just means not listed on
    // DexScreener yet — it MUST stay pollable or tokens get written off permanently
    // before they ever list (which zeroed the pipeline).
    const TERMINAL = new Set(["collapsed"]);
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
        assessLaunch(l.mint, c)
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
            // Continuous sustained clock: set when sustained begins, cleared the moment
            // it stops being sustained. Auto-queue requires this to reach minSustainedAgeSec,
            // so brief flashes (which the data shows are mostly duds) never get queued.
            const prevSince = x.eligibility?.sustainedSince ?? null;
            const sustainedSince = timing === "sustained" ? (prevSince || Date.now()) : null;
            if (timing === "sustained") {
              logMilestone(x.mint, x.symbol, "sustained", { price: res.priceUsd });
              // DISCOVERY (passive): tally this creator's sustained count once per token,
              // so the creator ledger has a denominator for graduation rate.
              try {
                if (discoveryEnabledRef.current && x.creator && !x._discSustained) {
                  x._discSustained = true;
                  recordCreatorEvent(x.creator, "sustained");
                }
                // DISCOVERY (passive): begin trajectory capture at the READY point, so we
                // learn the SHAPE of the move (accelerating vs stalling) rather than one
                // 3-minute snapshot. Never read by the trading path.
                if (discoveryEnabledRef.current && !x._trajStarted && res.priceUsd > 0) {
                  x._trajStarted = true;
                  recordTrajectoryStart(x.mint, x.symbol, {
                    creator: x.creator || "", price: res.priceUsd, vol: res.volH1,
                    bp: res.trades5m > 0 ? +(res.buys5m / res.trades5m).toFixed(3) : "",
                    liq: res.liqSol, score: x.score, pc: res.priceChangeH1,
                  });
                  trajTrackRef.current.set(x.mint, { symbol: x.symbol, readyAt: Date.now(), done: {} });
                }
              } catch {}
              // liquidity: DexScreener usd is often empty for fresh pump pairs — fall
              // back to the SOL side of the pool as the liquidity measure.
              const liqUsd = res.liq || 0;
              const liqSol = res.liqSol || 0;
              const liqMeasure = liqUsd || liqSol;   // prefer usd, else SOL-denominated
              // ACTIONABLE FILTER (from the optimiser): non-mayhem + pcH1 in [floor, ceiling]
              // + volH1>=floor. The pcH1 CEILING is new (08-06 data): losers had HIGHER
              // median pcH1 (165%) than winners (109%) — tokens already up huge on the hour
              // are late-stage exhausted pumps that rarely go green from entry. Skipping the
              // over-extended ones should cut the "never went green" losers.
              const pcH1 = res.priceChangeH1 ?? 0;
              const passedFilter =
                (x.isMayhem ? 0 : 1) &&
                (pcH1 >= c.minSustainPcH1) &&
                (pcH1 <= (c.maxSustainPcH1 ?? 120)) &&
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
              passedFilter: res._passedFilter ?? x.eligibility?.passedFilter,
              sustainedSince } };
          })))
          .catch(() => {});
      }
    }, 6000);
    return () => clearInterval(iv);
  }, [enabled]);

  usePeakTracker(trackRef, enabled, minSustainedAgeSec);
  useGradTracker(gradTrackRef, enabled);
  useTrajectoryTracker(trajTrackRef, enabled);

  const clear = useCallback(() => setLaunches([]), []);
  return { launches, status, stats, migrations, clear };
}

// Passive peak-tracking loop: follows every sustained token's price (bought or not)
// to record the max upside that followed — a paper-trade dataset for whether the
// opportunity is real. Uses DexScreener only (no Jupiter load). Defined as a hook
// helper so it shares the trackRef populated when tokens hit sustained.
// Post-graduation path tracker: after a token graduates, snapshot its price/pressure at
// fixed offsets (t+1/5/15/30/60m) so we can later ask "what do graduated tokens DO?".
// Fully passive research capture; bounded concurrency to respect the DexScreener limit.
// Trajectory tracker: after a token hits READY, snapshot it at +1/3/5 min so we can see
// whether the move is accelerating or stalling AT THE MOMENT WE'D BUY. Bounded
// concurrency, short-lived (drops each token after 5 min), fully passive.
function useTrajectoryTracker(trajTrackRef, enabled) {
  useEffect(() => {
    if (!enabled) return;
    const OFFSETS = [
      { label: "t+1m", ms: 60_000 },
      { label: "t+3m", ms: 180_000 },
      { label: "t+5m", ms: 300_000 },
    ];
    const iv = setInterval(async () => {
      const map = trajTrackRef.current;
      if (!map.size) return;
      const now = Date.now();
      const entries = [...map.entries()].sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
      for (const [mint, t] of entries.slice(0, 4)) {
        t.lastSeen = now;
        const age = now - t.readyAt;
        const due = OFFSETS.filter(o => age >= o.ms && !t.done[o.label]);
        if (!due.length) {
          if (age > 300_000 + 60_000) map.delete(mint);   // done after the last offset
          continue;
        }
        try {
          const act = await fetchTokenActivity(mint);
          if (act) {
            const bp = act.trades5m > 0 ? +(act.buys5m / act.trades5m).toFixed(3) : "";
            for (const o of due) {
              recordTrajectorySnapshot(mint, o.label,
                { price: act.priceUsd, vol: act.volH1, bp });
              t.done[o.label] = true;
            }
          }
        } catch { /* passive — skip this tick */ }
      }
    }, 10000);
    return () => clearInterval(iv);
  }, [enabled, trajTrackRef]);
}

function useGradTracker(gradTrackRef, enabled) {
  useEffect(() => {
    if (!enabled) return;
    const OFFSETS = [
      { label: "t+1m", ms: 60_000 }, { label: "t+5m", ms: 300_000 },
      { label: "t+15m", ms: 900_000 }, { label: "t+30m", ms: 1_800_000 },
      { label: "t+60m", ms: 3_600_000 },
    ];
    const iv = setInterval(async () => {
      const map = gradTrackRef.current;
      if (!map.size) return;
      const now = Date.now();
      // poll only a bounded number per tick, stalest first
      const entries = [...map.entries()].sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
      for (const [mint, t] of entries.slice(0, 4)) {
        t.lastSeen = now;
        const age = now - t.gradAt;
        // which offsets are due and not yet captured?
        const due = OFFSETS.filter(o => age >= o.ms && !t.done[o.label]);
        if (!due.length) {
          if (age > 3_600_000 + 120_000) map.delete(mint); // done after last offset
          continue;
        }
        try {
          const act = await fetchTokenActivity(mint);
          if (act) {
            const bp = act.trades5m > 0 ? act.buys5m / act.trades5m : "";
            const g = getGradPrice(mint);
            const pcFromGrad = (g && act.priceUsd) ? ((act.priceUsd - g) / g) * 100 : "";
            for (const o of due) {
              recordGradSnapshot(mint, o.label, {
                price: act.priceUsd, volH1: act.volH1, bp,
                liq: act.liq, pcFromGrad: pcFromGrad === "" ? "" : +pcFromGrad.toFixed(1),
              });
              t.done[o.label] = true;
              // creator dump/survive verdict at the 15m mark
              if (o.label === "t+15m" && t.creator) {
                recordCreatorEvent(t.creator, (pcFromGrad !== "" && pcFromGrad <= -50) ? "dumped" : "survived");
              }
            }
          }
        } catch { /* passive — skip this tick */ }
      }
    }, 8000);
    return () => clearInterval(iv);
  }, [enabled, gradTrackRef]);
}

// price at graduation, read back from the discovery store
function getGradPrice(mint) {
  try {
    const db = JSON.parse(localStorage.getItem("discovery_graduations_v1") || "{}");
    const p = db[mint]?.priceAtGrad;
    return (typeof p === "number" && p > 0) ? p : null;
  } catch { return null; }
}

function usePeakTracker(trackRef, enabled, minReadySec = 75) {
  const readyRef = useRef(minReadySec);
  useEffect(() => { readyRef.current = minReadySec; }, [minReadySec]);
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

        // ── READY-POINT instrumentation ──────────────────────────────────
        // Capture price at the moment the persistence gate would let us buy, and
        // track the peak from THAT point. This is what sets the real drag threshold:
        // drag_at_ready = how far it ran before we could act;
        // upside_from_ready = what was actually still capturable at entry.
        if (price && !t.readyPrice && now - t.sustainedTime >= readyRef.current * 1000) {
          t.readyPrice = price; t.readyTime = now; t.peakAfterReady = price;
        }
        if (price && t.readyPrice && price > (t.peakAfterReady || 0)) t.peakAfterReady = price;

        const agedOut = now - t.startedAt > MAX_TRACK_S * 1000;
        const collapsed = price && price < t.sustainedPrice * COLLAPSE_FRAC;
        if (agedOut || collapsed) {
          const peakPct = t.sustainedPrice > 0 ? ((t.peakPrice - t.sustainedPrice) / t.sustainedPrice) * 100 : 0;
          const ddAfterPeak = t.peakPrice > 0 ? ((t.lastPrice - t.peakPrice) / t.peakPrice) * 100 : 0;
          const dragAtReady = (t.readyPrice && t.sustainedPrice > 0)
            ? ((t.readyPrice - t.sustainedPrice) / t.sustainedPrice) * 100 : null;
          const upsideFromReady = (t.readyPrice > 0 && t.peakAfterReady)
            ? ((t.peakAfterReady - t.readyPrice) / t.readyPrice) * 100 : null;
          recordPeak(mint, t.symbol, {
            peakPct: +peakPct.toFixed(1),
            timeToPeakS: Math.round((t.peakTime - t.sustainedTime) / 1000),
            trackedS: Math.round((now - t.startedAt) / 1000),
            drawdownAfterPeak: +ddAfterPeak.toFixed(1),
            dragAtReady: dragAtReady == null ? null : +dragAtReady.toFixed(1),
            upsideFromReady: upsideFromReady == null ? null : +upsideFromReady.toFixed(1),
          });
          map.delete(mint);
        }
      }
    }, 10000);
    return () => clearInterval(iv);
  }, [enabled, trackRef]);
}
