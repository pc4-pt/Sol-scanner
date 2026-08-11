// discoveryLog.js — passive research instrumentation, fully separate from live trading.
//
// Captures three things the existing lifecycle log doesn't, to answer the open questions:
//   1. GRADUATION events + the post-graduation price PATH (does a graduated token
//      continue, mean-revert, or bleed out?) — the post-grad edge investigation.
//   2. A CREATOR LEDGER keyed by wallet: graduation rate AND post-grad dump rate, so we
//      can build both a "reliable graduator" and a "known dumper" view.
//   3. TIME structure: UTC hour, day-of-week, and session tag on every event, so any
//      slice (hour / weekday / session) can be measured against clean outcomes.
//
// Everything writes to its OWN localStorage keys and its OWN CSV export. Nothing here is
// read by the trading path — it's measurement only, safe to run continuously.

const GRAD_KEY = "discovery_graduations_v1";
const CREATOR_KEY = "discovery_creators_v1";
const MAX_GRAD = 4000;

function loadGrad() { try { return JSON.parse(localStorage.getItem(GRAD_KEY) || "{}"); } catch { return {}; } }
function saveGrad(d) { try { localStorage.setItem(GRAD_KEY, JSON.stringify(d)); } catch {} }
function loadCreators() { try { return JSON.parse(localStorage.getItem(CREATOR_KEY) || "{}"); } catch { return {}; } }
function saveCreators(d) { try { localStorage.setItem(CREATOR_KEY, JSON.stringify(d)); } catch {} }

// ── time tagging ───────────────────────────────────────────────────────────
export function timeTags(ts = Date.now()) {
  const d = new Date(ts);
  const hour = d.getUTCHours();
  const dow = d.getUTCDay(); // 0=Sun
  // rough trading sessions by UTC hour (memecoin flow skews US/EU)
  const session =
    hour >= 0 && hour < 7  ? "asia"       :
    hour >= 7 && hour < 13 ? "eu"         :
    hour >= 13 && hour < 21 ? "us"        : "late";
  const weekend = dow === 0 || dow === 6;
  return { utcHour: hour, dow, session, weekend };
}

// ── graduation events + post-grad path ──────────────────────────────────────
// Called when a tracked token graduates. Seeds the record; the path is filled in
// by recordGradSnapshot at fixed offsets.
export function recordGraduation(mint, symbol, info = {}) {
  if (!mint) return;
  const db = loadGrad();
  if (db[mint]) return; // first graduation only
  const now = Date.now();
  db[mint] = {
    mint, symbol: symbol || "?",
    gradAt: now,
    ...timeTags(now),
    creator: info.creator || "",
    venue: info.venue || "",                // pump-amm / raydium / unknown
    launchToGradSec: info.launchToGradSec ?? "",
    priceAtGrad: info.priceAtGrad ?? "",
    mcapAtGrad: info.mcapAtGrad ?? "",
    // launch-feature snapshot carried over, so grad predictors can be mined
    f_devSol: info.f_devSol ?? "", f_priorGrads: info.f_priorGrads ?? "",
    f_priorCount: info.f_priorCount ?? "", f_buyRatio: info.f_buyRatio ?? "",
    peakBeforeGrad: info.peakBeforeGrad ?? "",
    path: {},                               // offsetLabel -> {price,volH1,bp,liq}
  };
  // prune oldest if over cap
  const keys = Object.keys(db);
  if (keys.length > MAX_GRAD) {
    keys.sort((a, b) => (db[a].gradAt || 0) - (db[b].gradAt || 0));
    for (let i = 0; i < keys.length - MAX_GRAD; i++) delete db[keys[i]];
  }
  saveGrad(db);
}

// One post-grad snapshot at a fixed offset (e.g. "t+5m").
export function recordGradSnapshot(mint, label, snap) {
  const db = loadGrad();
  if (!db[mint]) return;
  if (db[mint].path[label] != null) return; // first value at each offset
  db[mint].path[label] = {
    price: snap.price ?? "", volH1: snap.volH1 ?? "", bp: snap.bp ?? "",
    liq: snap.liq ?? "", pcFromGrad: snap.pcFromGrad ?? "",
  };
  saveGrad(db);
}

// ── creator ledger ───────────────────────────────────────────────────────────
// Tallies per-wallet outcomes. dumpedPostGrad = graduated then fell hard within window.
export function recordCreatorEvent(creator, kind) {
  if (!creator) return;
  const db = loadCreators();
  const c = db[creator] || { creator, seen: 0, sustained: 0, graduated: 0, dumpedPostGrad: 0, survivedPostGrad: 0 };
  if (kind === "seen") c.seen++;
  else if (kind === "sustained") c.sustained++;
  else if (kind === "graduated") c.graduated++;
  else if (kind === "dumped") c.dumpedPostGrad++;
  else if (kind === "survived") c.survivedPostGrad++;
  db[creator] = c;
  saveCreators(db);
}

export function getGraduations() { return Object.values(loadGrad()); }
export function getCreators() { return Object.values(loadCreators()); }

// ── CSV exports ──────────────────────────────────────────────────────────────
function csv(rows, cols) {
  const head = cols.join(",");
  const body = rows.map(r => cols.map(c => {
    const v = r[c] == null ? "" : String(r[c]);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(",")).join("\n");
  return head + "\n" + body;
}
function download(name, text) {
  try {
    const blob = new Blob([text], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {}
}

export function downloadGraduationsCSV() {
  const offsets = ["t+1m", "t+5m", "t+15m", "t+30m", "t+60m"];
  const rows = getGraduations().map(g => {
    const flat = { ...g };
    delete flat.path;
    flat.gradAtISO = new Date(g.gradAt).toISOString();
    for (const off of offsets) {
      const p = g.path?.[off] || {};
      flat[`${off}_pcFromGrad`] = p.pcFromGrad ?? "";
      flat[`${off}_bp`] = p.bp ?? "";
      flat[`${off}_volH1`] = p.volH1 ?? "";
    }
    return flat;
  });
  const base = ["mint", "symbol", "gradAtISO", "utcHour", "dow", "session", "weekend",
    "creator", "venue", "launchToGradSec", "priceAtGrad", "mcapAtGrad", "peakBeforeGrad",
    "f_devSol", "f_priorGrads", "f_priorCount", "f_buyRatio"];
  const pathCols = offsets.flatMap(o => [`${o}_pcFromGrad`, `${o}_bp`, `${o}_volH1`]);
  download(`discovery-graduations-${new Date().toISOString().slice(0, 10)}.csv`, csv(rows, [...base, ...pathCols]));
}

export function downloadCreatorsCSV() {
  const rows = getCreators().map(c => ({
    ...c,
    gradRate: c.sustained ? (c.graduated / c.sustained).toFixed(3) : "",
    dumpRate: c.graduated ? (c.dumpedPostGrad / c.graduated).toFixed(3) : "",
  }));
  download(`discovery-creators-${new Date().toISOString().slice(0, 10)}.csv`,
    csv(rows, ["creator", "seen", "sustained", "graduated", "dumpedPostGrad", "survivedPostGrad", "gradRate", "dumpRate"]));
}
