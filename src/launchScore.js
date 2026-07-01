// launchScore.js — t=0 graduation-likelihood score from the PumpPortal create event.
//
// This is the LEADING signal validated in the sol-early-signal research thread:
// the dev's own initial buy plus the creator's track record predict graduation,
// and they're known at second zero — before any trading. It replaces the
// DexScreener momentum signals, which that research falsified as entry alpha
// (they fire on the second wave, after the move).
//
// The model coefficients live in launchModel.json — regenerate that file with
// launch_score.py on your real data and the scores update automatically.

import MODEL from "./launchModel.json";

const CREATOR_KEY = "solscanner_creator_history"; // creator -> { c: launches, g: graduations }
const MINT_KEY    = "solscanner_mint_creator";    // recent mint -> creator (for migration attribution)
const MAX_CREATORS = 100000;
const MAX_MINTS    = 30000;

function loadMap(key) {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(key) || "{}"))); }
  catch { return new Map(); }
}
function saveMap(key, map, cap) {
  let entries = [...map.entries()];
  if (entries.length > cap) entries = entries.slice(entries.length - cap); // keep most recent
  try { localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries))); } catch {}
}

// ── Persistent creator track record, built live from the stream ───────────────
export class CreatorHistory {
  constructor() {
    this.creators = loadMap(CREATOR_KEY); // creator -> {c,g}
    this.mints    = loadMap(MINT_KEY);    // mint -> creator
  }
  // history BEFORE this launch (leak-free: call before recording the create)
  priorFor(creator) {
    const r = this.creators.get(creator);
    return r ? { priorCount: r.c | 0, priorGrads: r.g | 0 } : { priorCount: 0, priorGrads: 0 };
  }
  recordCreate(mint, creator) {
    const r = this.creators.get(creator) || { c: 0, g: 0 };
    r.c += 1;
    this.creators.set(creator, r);
    this.mints.set(mint, creator);
    saveMap(CREATOR_KEY, this.creators, MAX_CREATORS);
    saveMap(MINT_KEY, this.mints, MAX_MINTS);
  }
  recordMigration(mint) {
    const creator = this.mints.get(mint);
    if (!creator) return false;
    const r = this.creators.get(creator) || { c: 0, g: 0 };
    r.g += 1;
    this.creators.set(creator, r);
    saveMap(CREATOR_KEY, this.creators, MAX_CREATORS);
    return true;
  }
  stats() {
    let creators = this.creators.size, grads = 0;
    for (const r of this.creators.values()) grads += r.g | 0;
    return { creators, grads, mints: this.mints.size };
  }
}

// ── The score: logistic on [log1p(dev_sol), prior_rate, log1p(prior_count), mayhem] ──
export function launchScore(ev, prior = { priorCount: 0, priorGrads: 0 }) {
  const priorRate = prior.priorCount > 0 ? prior.priorGrads / prior.priorCount : 0;
  const raw = [
    Math.log1p(Math.max(0, Number(ev.solAmount) || 0)),
    priorRate,
    Math.log1p(prior.priorCount || 0),
    ev.is_mayhem_mode ? 1 : 0,
  ];
  let z = MODEL.intercept;
  for (let i = 0; i < raw.length; i++) {
    z += MODEL.coef[i] * (raw[i] - MODEL.mean[i]) / MODEL.scale[i];
  }
  const prob = 1 / (1 + Math.exp(-z));      // calibrated graduation likelihood
  return {
    prob,                                    // 0..1
    score: Math.round(prob * 100),           // 0..100 for the queue's _score / conf
    lift: MODEL.base_rate > 0 ? prob / MODEL.base_rate : 0,
    devSol: Number(ev.solAmount) || 0,
    priorCount: prior.priorCount,
    priorGrads: prior.priorGrads,
    priorRate,
  };
}

export const MODEL_INFO = MODEL;
