// ── localStorage guard ──────────────────────────────────────────────────────────
// 2026-10-27: the trajectory and graduation stores stopped growing on 10-09 while the
// app kept running for weeks. Every setItem in the app swallowed its error, so a full
// localStorage (~5 MB per origin) failed silently — including, potentially, the writes
// that persist OPEN POSITIONS. A reload with a full store would then lose a live
// position record. This module makes failures loud and, for trading-critical keys,
// frees space by trimming the research stores (oldest half first) and retrying.

const RESEARCH_KEYS = [            // trimmed in this order, oldest entries first
  "discovery_trajectory_v1",
  "discovery_graduations_v1",
  "discovery_creators_v1",
  "solscanner_lifecycle",
];
const lastWarn = {};

function warnOnce(key, msg) {
  const now = Date.now();
  if (lastWarn[key] && now - lastWarn[key] < 60000) return;
  lastWarn[key] = now;
  console.error(`[storage] ${msg}`);
}

function trimOldestHalf(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const obj = JSON.parse(raw);
    const keys = Object.keys(obj);            // insertion order ≈ age order
    if (keys.length < 10) return 0;
    for (const k of keys.slice(0, Math.floor(keys.length / 2))) delete obj[k];
    const next = JSON.stringify(obj);
    localStorage.setItem(key, next);
    return raw.length - next.length;
  } catch { return 0; }
}

// Returns true if the value was stored.
export function safeSetItem(key, value, { critical = false } = {}) {
  try { localStorage.setItem(key, value); return true; }
  catch (e) {
    const kb = Math.round(value.length / 1024);
    if (!critical) {
      warnOnce(key, `FULL — could not save ${key} (${kb} KB). Research capture for this store has STOPPED. `
        + `Export your CSVs, then trims will free space for trading state.`);
      return false;
    }
    for (const rk of RESEARCH_KEYS) {
      if (rk === key) continue;
      const freed = trimOldestHalf(rk);
      if (freed > 0) {
        console.error(`[storage] FULL — trimmed oldest half of ${rk} (${Math.round(freed / 1024)} KB) to save ${key}`);
        try { localStorage.setItem(key, value); return true; } catch { /* keep trimming */ }
      }
    }
    warnOnce(key, `FULL — could not save CRITICAL key ${key} (${kb} KB) even after trimming. `
      + `Do NOT reload with open positions. ${e?.message || e}`);
    return false;
  }
}

export function storageReport() {
  const rows = [];
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const n = (localStorage.getItem(k) || "").length;
      total += n; rows.push([k, n]);
    }
  } catch { /* ignore */ }
  rows.sort((a, b) => b[1] - a[1]);
  // JS strings are UTF-16, but browsers count the 5 MB quota in characters-ish;
  // treat ~5,000 K characters as the ceiling.
  return { totalKB: Math.round(total / 1024), pctOf5MB: Math.round((total / (5 * 1024 * 1024)) * 100),
    top: rows.slice(0, 6).map(([k, n]) => `${k} ${Math.round(n / 1024)}KB`) };
}
