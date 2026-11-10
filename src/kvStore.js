// ── kvStore: IndexedDB-backed store for research capture ───────────────────────
// 2026-11-10. localStorage is capped at ~5 MB per site. Between 10-09 and 11-10 the
// research stores repeatedly hit that cap, and the storage guard (correctly, for
// trading safety) trimmed them by halves to make room — the 11-10 export arrived with
// 750 lifecycle rows covering 12 hours, 70 graduations and 10 trajectory rows. The
// largest single consumer was the creator ledger (up to 100,000 entries), which was
// itself marked critical and so triggered the trims.
//
// IndexedDB gives this origin hundreds of MB to GBs. Design:
//  - kvInit() runs once before the app renders: opens the DB, loads every key into an
//    in-memory cache, and migrates the research keys out of localStorage (then deletes
//    them there, freeing space for trading state).
//  - kvGet() is synchronous, from the cache, so existing call sites keep their shape.
//    It returns the LIVE cached object: callers mutate it, then call kvSet.
//  - kvSet() updates the cache and schedules a debounced write per key (structured
//    clone of a large object on every milestone would be wasteful). Pending writes are
//    flushed when the tab is hidden or closed.
//  - If IndexedDB is unavailable (private mode in some browsers), everything falls back
//    to localStorage through the guard, i.e. the previous behaviour.
//
// Trading-critical state (positions, history, settings) deliberately stays in
// localStorage: it is small, synchronous, and must survive even if IDB is cleared.

import { safeSetItem } from "./storageGuard.js";

const DB_NAME = "solscanner";
const STORE = "kv";
const DEBOUNCE_MS = 3000;
export const RESEARCH_KEYS = [
  "solscanner_lifecycle",
  "discovery_graduations_v1",
  "discovery_creators_v1",
  "discovery_trajectory_v1",
  "solscanner_creator_history",
  "solscanner_mint_creator",
  "solscanner_graduated",
  "freecarry_v1",
];

const cache = new Map();
const timers = new Map();
let db = null;
let idbOk = false;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no indexedDB"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGetAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const st = tx.objectStore(STORE);
    const out = new Map();
    const req = st.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { out.set(c.key, c.value); c.continue(); } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}
function idbPut(key, value) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => { console.error(`[kv] write failed for ${key}:`, tx.error?.message); resolve(false); };
    } catch (e) { console.error(`[kv] write threw for ${key}:`, e?.message); resolve(false); }
  });
}

export async function kvInit() {
  try {
    db = await openDb();
    const all = await idbGetAll();
    for (const [k, v] of all) cache.set(k, v);
    idbOk = true;
    // migrate anything still in localStorage
    let migrated = 0;
    for (const k of RESEARCH_KEYS) {
      const raw = localStorage.getItem(k);
      if (raw == null) continue;
      if (!cache.has(k)) {
        try { const v = JSON.parse(raw); cache.set(k, v); await idbPut(k, v); migrated++; } catch { /* corrupt — drop */ }
      }
      localStorage.removeItem(k);
    }
    if (migrated) console.warn(`[kv] migrated ${migrated} research store(s) from localStorage to IndexedDB`);
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) console.warn(`[kv] IndexedDB ready — ${(est.usage / 1048576).toFixed(1)} MB used of ~${(est.quota / 1048576).toFixed(0)} MB available`);
      navigator.storage?.persist?.().catch(() => {});   // ask the browser not to evict
    } catch { /* informational */ }
  } catch (e) {
    idbOk = false;
    console.error("[kv] IndexedDB unavailable — falling back to localStorage (5 MB cap):", e?.message || e);
    for (const k of RESEARCH_KEYS) {
      try { const raw = localStorage.getItem(k); if (raw != null) cache.set(k, JSON.parse(raw)); } catch { /* skip */ }
    }
  }
  const flush = () => kvFlushAll();
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
}

export function kvGet(key, fallback) {
  return cache.has(key) ? cache.get(key) : fallback;
}

export function kvSet(key, value) {
  cache.set(key, value);
  if (timers.has(key)) return;              // a write is already scheduled; it will pick up this value
  timers.set(key, setTimeout(() => { timers.delete(key); writeNow(key); }, DEBOUNCE_MS));
}

function writeNow(key) {
  const v = cache.get(key);
  if (idbOk) return idbPut(key, v);
  try { safeSetItem(key, JSON.stringify(v)); } catch { /* guard logs */ }
}

export function kvFlushAll() {
  for (const [k, t] of timers) { clearTimeout(t); timers.delete(k); writeNow(k); }
}

export function kvBackend() { return idbOk ? "indexeddb" : "localStorage"; }
