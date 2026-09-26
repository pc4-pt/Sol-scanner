// ── FREE-CARRY RESIDUAL CAPTURE ────────────────────────────────────────────────
// Answers one question: had we kept a slice of each TAKE_PROFIT position instead of
// selling 100%, what would that slice have been worth over the next 24h, relative to
// the price we actually sold at?  (Research response 2026-09-26, Q5: free-carry beats
// the current rule on a trade only if the residual's realised value / TP price > 1.)
//
// Replaces the earlier ladder that lived inside the pumpStream peak tracker. That one
// had three defects that would all have biased the test TOWARDS free-carry:
//   1. rungs were measured from the READY price, not the TP price — "2x" there was
//      only ~1.74x from where we actually sold;
//   2. it was feed-priced, so a single DexScreener spike print could register a rung;
//   3. it lived in an in-memory map, so any page reload or laptop sleep during the
//      24h window silently ended the observation — and it only recorded tokens that
//      HIT a rung, saying nothing about the majority that decay.
//
// This module is self-contained and persisted (survives reloads), prices from the
// bonding curve while the token is on it (chain truth, cannot spike), follows it to
// PumpSwap via the feed after graduation (rungs then need two consecutive samples),
// and records the whole path summary — min, max, terminal, graduation, coverage —
// not just ladder hits. Measurement only: it never trades.

const KEY = "freecarry_v1";
const HORIZON_S = 86400;
const RUNGS = [2, 5, 10];
const CENSOR_GAP_S = 600;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}
function save(db) {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* quota — best effort */ }
}

// Called on a successful TAKE_PROFIT sell. tpCurve is the curve price (SOL/token) at
// the trigger — the on-chain-verified TP price. solUsd converts it for post-graduation
// feed samples, which are USD-denominated.
export function startFreeCarry({ mint, symbol, tpCurve, tpFeedUsd, solUsd, tpRealSol }) {
  if (!mint) return null;
  const db = load();
  if (db[mint]) return db[mint];              // one observation per mint
  const baseUsd = (tpCurve > 0 && solUsd > 0) ? tpCurve * solUsd : (tpFeedUsd || null);
  if (!(tpCurve > 0) && !(baseUsd > 0)) return null;
  db[mint] = {
    mint, symbol: symbol || "?", t0: Date.now(),
    tpCurve: tpCurve > 0 ? tpCurve : null,
    baseUsd,
    base: tpCurve > 0 ? "curve" : "feed",     // feed base = weaker observation, flagged
    samples: 0, curveSamples: 0, feedSamples: 0,
    lastAt: null, maxGapS: 0,
    maxMult: null, maxAtS: null, minMult: null, minAtS: null,
    lastMult: null, lastSrc: null, prevFeedMult: null,
    rung: {}, rungSrc: {},
    gradAtS: null,
    // curve liveness at +5m: did realSolReserves move between the TP trigger and +5m?
    // (research 2026-09-26b — the clean version of what the volMult artefact detected)
    tpRealSol: tpRealSol > 0 ? tpRealSol : null, live5m: null,
    // censoring: gap between SWEEPS, not samples — a sleeping laptop or closed tab
    lastSweepAt: null, maxSweepGapS: 0,
  };
  save(db);
  return db[mint];
}

export function freeCarryCount() { return Object.keys(load()).length; }

function fields(r, status) {
  const f = (v, d = 3) => (v == null ? "" : +v.toFixed(d));
  return {
    fc_status: status,                    // running | done
    fc_base: r.base,                      // curve (clean) | feed (flag: spike-exposed)
    fc_tp_curve_price: r.tpCurve ?? "",
    fc_span_s: Math.round(((r.lastAt || r.t0) - r.t0) / 1000),
    fc_samples: r.samples,
    fc_curve_samples: r.curveSamples,
    fc_max_gap_s: Math.round(r.maxGapS),  // coverage: large gaps = laptop asleep / tab closed
    fc_max_mult: f(r.maxMult), fc_max_s: r.maxAtS ?? "",
    fc_min_mult: f(r.minMult), fc_min_s: r.minAtS ?? "",
    fc_terminal_mult: f(r.lastMult),      // multiple of TP price at 24h (or last sample)
    fc_terminal_src: r.lastSrc ?? "",
    fc_x2_s: r.rung.x2 ?? "", fc_x5_s: r.rung.x5 ?? "", fc_x10_s: r.rung.x10 ?? "",
    fc_x2_src: r.rungSrc.x2 ?? "",
    fc_graduated_s: r.gradAtS ?? "",
    fc_live_5m: r.live5m ?? "",           // 1 = curve still trading at +5m, 0 = frozen
    fc_max_sweep_gap_s: Math.round(r.maxSweepGapS || 0),
    // Censor, don't score: any unobserved stretch > 10 min means a rung, the min or the
    // terminal could have been missed. Raw gaps are exported for re-banding.
    fc_censored: Math.max(r.maxSweepGapS || 0, r.maxGapS || 0) > CENSOR_GAP_S ? 1 : 0,
  };
}

// One sweep over every tracked residual. deps are injected so this file has no
// imports and stays trivially testable.
export async function pollFreeCarry({ connection, getBondingCurveState, fetchTokenActivity, logMilestone }) {
  const db = load();
  const mints = Object.keys(db);
  if (!mints.length) return;
  const now = Date.now();

  for (const mint of mints) {
    const r = db[mint];
    const ageS = (now - r.t0) / 1000;
    if (r.lastSweepAt) r.maxSweepGapS = Math.max(r.maxSweepGapS || 0, (now - r.lastSweepAt) / 1000);
    r.lastSweepAt = now;

    if (ageS >= HORIZON_S) {
      logMilestone(mint, r.symbol, "freecarry_done", fields(r, "done"));
      console.warn(`[freecarry] ${r.symbol} done — terminal ${r.lastMult?.toFixed(2) ?? "?"}x TP, `
        + `max ${r.maxMult?.toFixed(2) ?? "?"}x, min ${r.minMult?.toFixed(2) ?? "?"}x, `
        + `${r.samples} samples, worst gap ${Math.round(r.maxGapS)}s`);
      delete db[mint];
      continue;
    }

    let mult = null, src = null;
    // 1) curve — authoritative while the token is still on it
    if (r.tpCurve > 0) {
      try {
        const cs = await getBondingCurveState(connection, mint);
        if (cs?.complete && r.gradAtS == null) {
          r.gradAtS = Math.round(ageS);
          console.warn(`[freecarry] ${r.symbol} graduated at +${r.gradAtS}s — following on feed`);
        }
        // liveness: first curve read at or after +5m. A graduated curve counts as live.
        if (r.live5m == null && ageS >= 300 && r.tpRealSol > 0 && cs) {
          r.live5m = (cs.complete || Math.abs(cs.realSolReserves - r.tpRealSol) > 1e-6) ? 1 : 0;
        }
        if (cs && !cs.complete && cs.virtualTokenReserves > 0) {
          mult = (cs.virtualSolReserves / cs.virtualTokenReserves) / r.tpCurve;
          src = "curve";
        }
      } catch { /* fall through to feed */ }
    }
    // 2) feed — after graduation (PumpSwap) or if the curve read failed
    if (mult == null && r.baseUsd > 0) {
      try {
        const act = await fetchTokenActivity(mint);
        if (act?.priceUsd > 0) { mult = act.priceUsd / r.baseUsd; src = "feed"; }
      } catch { /* no sample this sweep */ }
    }
    if (mult == null) continue;

    if (r.lastAt) r.maxGapS = Math.max(r.maxGapS, (now - r.lastAt) / 1000);
    r.lastAt = now; r.samples++;
    if (src === "curve") r.curveSamples++; else r.feedSamples++;

    if (r.maxMult == null || mult > r.maxMult) { r.maxMult = mult; r.maxAtS = Math.round(ageS); }
    if (r.minMult == null || mult < r.minMult) { r.minMult = mult; r.minAtS = Math.round(ageS); }

    // Rungs: a curve sample is chain truth and counts at once. A feed sample must be
    // confirmed by the PREVIOUS feed sample also clearing the rung — the feed prints
    // prices that never traded, and one print must not register a 2x.
    for (const k of RUNGS) {
      const key = `x${k}`;
      if (r.rung[key] != null || mult < k) continue;
      if (src === "curve" || (r.prevFeedMult != null && r.prevFeedMult >= k)) {
        r.rung[key] = Math.round(ageS); r.rungSrc[key] = src;
        console.warn(`[freecarry] ${r.symbol} ${k}x of TP at +${r.rung[key]}s (${src})`);
      }
    }
    r.prevFeedMult = src === "feed" ? mult : null;
    r.lastMult = mult; r.lastSrc = src;

    // Snapshot into the lifecycle row every ~10 samples so an export mid-window still
    // shows progress (fc_status=running) — the row is only final at fc_status=done.
    if (r.samples % 10 === 1) logMilestone(mint, r.symbol, "freecarry_start", fields(r, "running"));
  }
  save(db);
}
