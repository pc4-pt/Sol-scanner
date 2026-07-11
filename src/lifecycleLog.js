// lifecycleLog.js — timestamps every milestone in a token's lifecycle so the buy
// window can be MEASURED, not eyeballed. Persists to localStorage; exports to CSV.
//
// Milestones (first occurrence each, per mint):
//   eligible  — first passed survival + activity checks
//   sustained — first reached sustained momentum (the actionable window opens)
//   queued    — added to queue (data.source = "manual" | "auto")
//   bought    — buy executed (data.entryPrice)
//   fading    — momentum first rolled over (the window closes)
//   collapsed — price/liquidity died
//   sold      — position closed (data.exitPrice, pnlPct, peakPnlPct, reason)
//
// The gaps between these are the whole point:
//   window   = fading − sustained   (how long the opportunity stayed open)
//   decision = queued − sustained   (how long you took to decide)
//   reaction = bought − queued      (execution speed — is manual fast enough?)
//   inTime   = bought < fading?     (did you get in before it rolled over)
//   hold     = sold − bought

const KEY = "solscanner_lifecycle";
let cache = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { cache = {}; }
  return cache;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {} }

export function logMilestone(mint, symbol, milestone, data = {}) {
  if (!mint) return;
  const db = load();
  if (!db[mint]) db[mint] = { mint, symbol: symbol || "?", events: {}, prices: {}, data: {} };
  if (!db[mint].prices) db[mint].prices = {};
  if (symbol && db[mint].symbol === "?") db[mint].symbol = symbol;
  // "fading" is only meaningful AFTER "sustained" — guard against a fade that was
  // logged before the token ever sustained (which produced negative windows).
  if (milestone === "fading" && db[mint].events.sustained == null) return;
  // record the FIRST time each milestone happens, with the price at that moment
  if (db[mint].events[milestone] == null) {
    db[mint].events[milestone] = Date.now();
    if (data.price != null && db[mint].prices[milestone] == null) db[mint].prices[milestone] = data.price;
  }
  Object.assign(db[mint].data, data);
  // cap total tracked tokens
  const keys = Object.keys(db);
  if (keys.length > 3000) delete db[keys[0]];
  save();
}

// Feature snapshot AT THE SUSTAINED MOMENT — combines t=0 launch data with the live
// market state, so we can later correlate which features separate runners from duds.
export function recordFeatures(mint, symbol, features) {
  if (!mint) return;
  const db = load();
  if (!db[mint]) db[mint] = { mint, symbol: symbol || "?", events: {}, prices: {}, data: {} };
  if (db[mint].data.f_captured) return;    // snapshot once, at first sustained
  Object.assign(db[mint].data, features, { f_captured: 1 });
  save();
}

// Passive paper result: the max a token reached AFTER hitting sustained, whether or
// not it was bought. This is the opportunity distribution — does upside actually follow?
export function recordPeak(mint, symbol, { peakPct, timeToPeakS, trackedS, drawdownAfterPeak }) {
  if (!mint) return;
  const db = load();
  if (!db[mint]) db[mint] = { mint, symbol: symbol || "?", events: {}, prices: {}, data: {} };
  db[mint].data.peakPct = peakPct;
  db[mint].data.timeToPeakS = timeToPeakS;
  db[mint].data.trackedS = trackedS;
  if (drawdownAfterPeak != null) db[mint].data.drawdownAfterPeak = drawdownAfterPeak;
  save();
}

export function getLog() { return Object.values(load()); }
export function clearLog() { cache = {}; save(); }

// Derived per-token row (seconds between milestones + price moves between them)
export function deriveRow(t) {
  const e = t.events || {};
  const p = t.prices || {};
  const s = (a, b) => (e[a] != null && e[b] != null ? (e[b] - e[a]) / 1000 : null);
  const mv = (a, b) => (p[a] > 0 && p[b] != null ? ((p[b] - p[a]) / p[a]) * 100 : null);
  return {
    symbol: t.symbol, mint: t.mint,
    score: t.data?.score ?? "", devSol: t.data?.devSol ?? "",
    source: t.data?.source ?? "",
    window_s:   s("sustained", "fading"),   // how long the window stayed open
    decision_s: s("sustained", "queued"),   // your decision time
    reaction_s: s("queued", "bought"),      // execution speed
    hold_s:     s("bought", "sold"),
    inTime:     e.bought != null && e.fading != null ? (e.bought < e.fading ? "yes" : "LATE")
                : (e.bought != null ? "n/a" : ""),
    // PASSIVE PAPER RESULT — max upside after sustained, whether or not bought
    upside_pct:      t.data?.peakPct ?? "",           // sustained → peak (the opportunity)
    time_to_peak_s:  t.data?.timeToPeakS ?? "",
    dd_after_peak:   t.data?.drawdownAfterPeak ?? "", // how fast it gave back after peak
    tracked_s:       t.data?.trackedS ?? "",
    // ── feature snapshot at the sustained moment (for runner-vs-dud analysis) ──
    f_devSol:        t.data?.f_devSol ?? "",
    f_priorGrads:    t.data?.f_priorGrads ?? "",
    f_priorCount:    t.data?.f_priorCount ?? "",
    f_isMayhem:      t.data?.f_isMayhem ?? "",
    f_liq:           t.data?.f_liq ?? "",
    f_fdv:           t.data?.f_fdv ?? "",
    f_ageMin:        t.data?.f_ageMin ?? "",
    f_vol5m:         t.data?.f_vol5m ?? "",
    f_volH1:         t.data?.f_volH1 ?? "",
    f_buyRatio5m:    t.data?.f_buyRatio5m ?? "",
    f_buyRatioH1:    t.data?.f_buyRatioH1 ?? "",
    f_pcH1:          t.data?.f_pcH1 ?? "",
    f_volLiq:        t.data?.f_volLiq ?? "",
    f_hasSocials:    t.data?.f_hasSocials ?? "",
    f_hasWebsite:    t.data?.f_hasWebsite ?? "",
    f_nPairs:        t.data?.f_nPairs ?? "",
    f_boosts:        t.data?.f_boosts ?? "",
    // price moves between milestones (the trajectory)
    move_window_pct:    mv("sustained", "fading"),   // total move across the sustained window
    slip_to_buy_pct:    mv("sustained", "bought"),   // how much it ran before you got in
    after_buy_pct:      mv("bought", "fading"),       // upside still available at your entry
    pnlPct:     t.data?.pnlPct ?? "",
    peakPnlPct: t.data?.peakPnlPct ?? "",
    exitReason: t.data?.exitReason ?? "",
    // absolute prices at each milestone
    price_eligible:  p.eligible  ?? "", price_sustained: p.sustained ?? "",
    price_queued:    p.queued    ?? "", price_bought:    p.bought    ?? "",
    price_fading:    p.fading    ?? "", price_sold:      p.sold      ?? "",
    price_collapsed: p.collapsed ?? "",
    t_eligible:  e.eligible  ? new Date(e.eligible).toISOString()  : "",
    t_sustained: e.sustained ? new Date(e.sustained).toISOString() : "",
    t_queued:    e.queued    ? new Date(e.queued).toISOString()    : "",
    t_bought:    e.bought    ? new Date(e.bought).toISOString()    : "",
    t_fading:    e.fading    ? new Date(e.fading).toISOString()    : "",
    t_collapsed: e.collapsed ? new Date(e.collapsed).toISOString() : "",
    t_sold:      e.sold      ? new Date(e.sold).toISOString()      : "",
  };
}

export function toCSV() {
  const rows = getLog().map(deriveRow);
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
}

export function summary() {
  const rows = getLog().map(deriveRow);
  const bought = rows.filter(r => r.t_bought);
  const sold = rows.filter(r => r.pnlPct !== "" && r.pnlPct != null);
  const avg = (arr, k) => {
    const v = arr.map(r => r[k]).filter(x => x != null && x !== "");
    return v.length ? v.reduce((a, b) => a + Number(b), 0) / v.length : null;
  };
  const wins = sold.filter(r => Number(r.pnlPct) > 0).length;
  // Opportunity distribution: of sustained tokens passively tracked, how much upside
  // actually followed — the answer to "is the profit even there?"
  const withPeak = rows.filter(r => r.upside_pct !== "" && r.upside_pct != null);
  const peaks = withPeak.map(r => Number(r.upside_pct));
  const med = (a) => { if (!a.length) return null; const b=[...a].sort((x,y)=>x-y); const m=b.length>>1; return b.length%2?b[m]:(b[m-1]+b[m])/2; };
  const pctReaching = (thr) => peaks.length ? peaks.filter(p => p >= thr).length / peaks.length : null;
  return {
    tracked: rows.length,
    eligible: rows.filter(r => r.t_eligible).length,
    sustained: rows.filter(r => r.t_sustained).length,
    bought: bought.length,
    sold: sold.length,
    avgWindowS:   avg(rows, "window_s"),
    avgDecisionS: avg(bought, "decision_s"),
    avgReactionS: avg(bought, "reaction_s"),
    avgWindowMove: avg(rows, "move_window_pct"),   // avg price move across the window
    avgSlipToBuy:  avg(bought, "slip_to_buy_pct"), // avg run-up before you got in
    avgAfterBuy:   avg(bought, "after_buy_pct"),   // avg upside left at your entry
    boughtInTime: bought.length ? bought.filter(r => r.inTime === "yes").length / bought.length : null,
    winRate: sold.length ? wins / sold.length : null,
    avgPnl: avg(sold, "pnlPct"),
    opp_n: withPeak.length,
    opp_medianPeak: med(peaks),
    opp_over20: pctReaching(20),
    opp_over50: pctReaching(50),
    opp_over100: pctReaching(100),
    opp_medianTimeToPeak: med(withPeak.map(r => Number(r.time_to_peak_s)).filter(x => !isNaN(x))),
  };
}

export function downloadCSV() {
  const csv = toCSV();
  if (!csv) return;
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `token-lifecycle-${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}
