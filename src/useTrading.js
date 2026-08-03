// ─── useTrading.js ────────────────────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  fetchCurrentPrice, calcPnl, shouldTriggerExit, getSolUsd, fetchTokenActivity, computeTiming,
  computeAdaptiveStopLoss,
  DEFAULT_TRADE_SETTINGS, PRICE_POLL_MS,
} from "./tradingEngine.js";
import { checkTokenSafety } from "./safety.js";
import { pumpPortalTrade, getTokenBalance, getTxSolDelta } from "./pumpPortal.js";
import { useBurner } from "./burnerWallet.js";
import { logMilestone, getMilestonePrice } from "./lifecycleLog.js";
import { fireNotification } from "./notifications.js";

// ── Storage ───────────────────────────────────────────────────────────────────
const KEYS = {
  positions: "solscanner_positions",
  history:   "solscanner_history",
  settings:  "solscanner_settings",
};
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
// Settings need special handling: a stored blob from an older build is MISSING every
// field added since, and can hold STALE values for fields whose defaults we've changed
// (e.g. an old uncapped sell ladder). Merge defaults under the stored values so new
// fields appear, then a version gate re-applies the current defaults for the
// exit/entry-stack fields that must not be overridden by stale storage.
const SETTINGS_VERSION = 3;
function loadSettings() {
  const stored = load(KEYS.settings, null);
  if (!stored) return { ...DEFAULT_TRADE_SETTINGS, _v: SETTINGS_VERSION };
  let s = { ...DEFAULT_TRADE_SETTINGS, ...stored };
  if ((stored._v ?? 0) < SETTINGS_VERSION) {
    // migrate: force the safety-critical exit/entry fields back to current defaults,
    // since stale stored values here caused real losses (e.g. -84% fills on the old ladder)
    const forced = ["sellSlippageLadder", "pumpSlippage", "pumpPriorityFee",
      "partialTpEnabled", "partialTpPct", "partialTpFraction",
      "takeProfitPct", "stopLossPct", "trailingActivateAt", "trailDrawdownPct",
      "entryHeadroomEnabled", "maxEntryDragPct", "minSustainedAgeSec"];
    for (const k of forced) s[k] = DEFAULT_TRADE_SETTINGS[k];
    s._v = SETTINGS_VERSION;
  }
  return s;
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ── Queue staleness threshold (10 minutes) ────────────────────────────────────
const QUEUE_STALE_MS = 10 * 60 * 1000;

// ── Queue sort ────────────────────────────────────────────────────────────────
const SIGNAL_PRIORITY = {
  "EARLY MOMENTUM": 5,
  "UPTREND":        4,
  "LATE RECOVERY":  3,
  "CONSOLIDATING":  2,
  "TOPPING OUT":    1,
};

export const QUEUE_SORT_OPTIONS = [
  { value: "priority",   label: "Signal Priority" },
  { value: "score",      label: "Score"           },
  { value: "confidence", label: "Confidence"      },
  { value: "newest",     label: "Newest First"    },
  { value: "oldest",     label: "Oldest First"    },
];

export function sortQueue(queue, sortBy) {
  return [...queue].sort((a, b) => {
    const aSig  = SIGNAL_PRIORITY[a.signal?.type] || 0;
    const bSig  = SIGNAL_PRIORITY[b.signal?.type] || 0;
    const aConf = a.signal?.conf || 0;
    const bConf = b.signal?.conf || 0;

    switch (sortBy) {
      case "priority":
        if (bSig !== aSig) return bSig - aSig;
        return (bConf * b.score) - (aConf * a.score);
      case "score":
        return b.score - a.score;
      case "confidence":
        return bConf - aConf;
      case "newest":
        return b.queuedAt - a.queuedAt;
      case "oldest":
        return a.queuedAt - b.queuedAt;
      default:
        return 0;
    }
  });
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useTrading() {
  const { publicKey, signTransaction, connected } = useWallet();
  const { connection } = useConnection();

  // Optional burner wallet: when active, it signs locally (no popup) and becomes
  // the effective signer for all trades. Falls back to the connected Phantom wallet.
  const burner = useBurner(connection);
  const effPublicKey     = burner.active ? burner.publicKey     : publicKey;
  const effSignTransaction = burner.active ? burner.signTransaction : signTransaction;
  const effConnected     = burner.active ? !!burner.publicKey   : connected;

  const [settings,      setSettings]  = useState(loadSettings);
  const [queue,         setQueue]     = useState([]);
  const [queueSort,     setQueueSort] = useState("priority");
  const [positions,     setPositions] = useState(() => load(KEYS.positions, []));
  const [history,       setHistory]   = useState(() => load(KEYS.history,   []));
  const [executing,     setExecuting] = useState({});
  const [notifications, setNotifs]   = useState([]);

  const priceMonitorRef   = useRef(null);
  const cooldownRef       = useRef({});
  const queuedAddrsRef    = useRef(new Set());
  const positionAddrsRef  = useRef(new Set(
    positions.filter(p => p.status === "open").map(p => p.tokenAddress)
  ));
  // Always-current refs used inside intervals to avoid stale closures
  const positionsRef      = useRef(positions);
  const autoSellFiringRef = useRef(new Set());
  const partialFiringRef  = useRef(new Set());
  // Synchronous guards against double-fire (state setters are async)
  const buyFiringRef      = useRef(new Set());
  const sellFiringRef     = useRef(new Set());
  // Track consecutive auto-sell failures per position. After 3 failures the
  // position is marked "stuck" and auto-sell stops retrying until user intervenes.
  const sellFailCountRef  = useRef(new Map());
  // Two-scan confirmation: track tokens that showed valid signals on previous scans.
  const candidatesRef     = useRef(new Map());
  // Always-current settings reference (for use in async/interval callbacks)
  const settingsRef       = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Keep positionsRef current on every render
  useEffect(() => { positionsRef.current = positions; }, [positions]);

  // Persist to localStorage
  useEffect(() => { save(KEYS.positions, positions); }, [positions]);
  useEffect(() => { save(KEYS.history,   history);   }, [history]);
  useEffect(() => { save(KEYS.settings,  settings);  }, [settings]);

  const updateSettings = useCallback((patch) => {
    setSettings(prev => ({ ...prev, ...patch }));
  }, []);

  // ── Notifications ─────────────────────────────────────────────────────────
  const notify = useCallback((msg, type = "info") => {
    const n = { id: Date.now() + Math.random(), msg, type, ts: new Date().toLocaleTimeString() };
    setNotifs(prev => [n, ...prev].slice(0, 20));
  }, []);

  const dismissNotif = useCallback((id) => {
    setNotifs(prev => prev.filter(n => n.id !== id));
  }, []);

  // ── Queue: add ────────────────────────────────────────────────────────────
  // Compute confidence-scaled stake. Confidence 50 → 75% of base, 100 → 100%.
  // Floor 50%, so even lowest-confidence trades get half stake.
  const scaledStake = useCallback((conf) => {
    if (!settings.scaleByConfidence) return settings.stakeSOL;
    const mult = 0.5 + Math.min(1, (conf || 0) / 100) * 0.5;
    return Math.round(settings.stakeSOL * mult * 1000) / 1000;
  }, [settings.scaleByConfidence, settings.stakeSOL]);

  const addToQueue = useCallback((token, signal, safetyReport = null) => {
    const addr     = token.baseToken?.address;
    const pairAddr = token.pairAddress;
    if (!addr || !pairAddr) return;

    const last = cooldownRef.current[addr];
    if (last && Date.now() - last < settings.cooldownMinutes * 60000) return;

    if (queuedAddrsRef.current.has(pairAddr)) return;
    if (positionAddrsRef.current.has(addr))   return;

    queuedAddrsRef.current.add(pairAddr);

    const stake = scaledStake(signal?.conf);

    const entry = {
      id:            `q_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      pairAddress:   pairAddr,
      tokenAddress:  addr,
      symbol:        token.baseToken?.symbol || "?",
      name:          token.baseToken?.name   || "",
      priceUsd:      parseFloat(token.priceUsd || 0),
      initPriceUsd:  parseFloat(token.priceUsd || 0),
      score:         token._score || 0,
      signal,
      safety:        safetyReport,                       // RugCheck summary (may be null)
      dexUrl:        `https://dexscreener.com/solana/${pairAddr}`,
      pairAddressReal: token._pairAddress || null,   // real DEX pair for charts/activity
      activity:      token._activity || null,        // live 5m activity (launch items)
      trend:         [],                             // ring buffer of recent samples for trend
      queuedAt:      Date.now(),
      lastUpdated:   Date.now(),
      degradeCount:  0,
      stakeSOL:      stake,
      baseStakeSOL:  settings.stakeSOL,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct:   settings.stopLossPct,
    };

    setQueue(prev => {
      if (prev.some(q => q.pairAddress === pairAddr)) {
        queuedAddrsRef.current.delete(pairAddr);
        return prev;
      }
      const stakeNote = settings.scaleByConfidence && stake !== settings.stakeSOL
        ? ` · ${stake} SOL (${signal?.conf || 0}% conf scaled)`
        : "";
      const safetyNote = safetyReport
        ? ` · risk ${safetyReport.scoreNorm}/100`
        : "";
      notify(`${entry.symbol} added to queue (score ${entry.score})${stakeNote}${safetyNote}`, "queue");

      // ── External notification (browser push / sound / Telegram) ──────────
      // Only fire for signals at or above the user's minimum notification confidence,
      // so low-quality signals don't generate noise.
      const minConf = settingsRef.current.notifyMinConf ?? 75;
      if ((signal?.conf || 0) >= minConf) {
        fireNotification({
          kind: "queue",
          title: `🎯 ${entry.symbol} queued`,
          body:  `${signal?.type} · ${signal?.conf}% conf · score ${entry.score}${safetyNote}`,
          settings: settingsRef.current,
        });
      }

      return [entry, ...prev].slice(0, 20);
    });
  }, [settings, notify, scaledStake]);

  // ── Queue: remove ─────────────────────────────────────────────────────────
  const removeFromQueue = useCallback((id) => {
    setQueue(prev => {
      const item = prev.find(q => q.id === id);
      if (item) queuedAddrsRef.current.delete(item.pairAddress);
      return prev.filter(q => q.id !== id);
    });
  }, []);

  const updateQueueItem = useCallback((id, patch) => {
    setQueue(prev => prev.map(q => q.id === id ? { ...q, ...patch } : q));
  }, []);

  // ── Clear entire queue ────────────────────────────────────────────────────
  const clearQueue = useCallback(() => {
    queuedAddrsRef.current.clear();
    candidatesRef.current.clear();
    setQueue([]);
    notify("Queue cleared", "info");
  }, [notify]);

  // ── Retry a stuck position (clears the stuck flag, resets fail counter) ───
  const retryPosition = useCallback((positionId) => {
    sellFailCountRef.current.delete(positionId);
    setPositions(prev => prev.map(p =>
      p.id === positionId ? { ...p, stuck: false, stuckReason: null } : p
    ));
    notify("Position un-stuck — auto-sell will retry on next exit signal", "info");
  }, [notify]);

  // ── Abandon a stuck position (mark closed locally without on-chain sell) ──
  // Use this when the token genuinely can't be sold (honeypot, dead liquidity).
  // The position moves to history with exitReason "ABANDONED" and pnl = -100%
  // (full loss assumed, since you can't extract the tokens). If you later sell
  // the tokens manually via Jupiter, the history won't auto-update.
  const abandonPosition = useCallback((positionId) => {
    const pos = positionsRef.current.find(p => p.id === positionId);
    if (!pos) return;
    sellFailCountRef.current.delete(positionId);
    autoSellFiringRef.current.delete(positionId);
    positionAddrsRef.current.delete(pos.tokenAddress);

    const closed = {
      ...pos,
      status:     "closed",
      exitReason: "ABANDONED",
      exitPrice:  pos.currentPrice || pos.entryPrice,
      exitTx:     null,
      closedAt:   Date.now(),
      solReceived: 0,
      pnlSol:     -Math.abs(pos.solSpent || 0),
      pnlPct:     -100,
    };

    setPositions(prev => prev.filter(p => p.id !== positionId));
    setHistory(prev => [closed, ...prev].slice(0, 100));
    notify(`${pos.symbol} abandoned — marked as -100% loss. Sell manually via jup.ag if possible.`, "warn");
  }, [notify]);

  // ── Execute buy ───────────────────────────────────────────────────────────
  const executeBuy = useCallback(async (queueItem) => {
    if (!effConnected || !effPublicKey || !effSignTransaction) {
      notify("Wallet not connected — please connect Phantom or Solflare", "error");
      return;
    }

    // Synchronous double-fire guard — state setters are async and won't block
    // a second invocation within the same tick.
    if (buyFiringRef.current.has(queueItem.id)) {
      console.warn("[executeBuy] already firing for", queueItem.id);
      return;
    }
    buyFiringRef.current.add(queueItem.id);

    const openCount = positions.filter(p => p.status === "open").length;
    if (openCount >= settings.maxPositions) {
      notify(`Max positions (${settings.maxPositions}) reached`, "warn");
      buyFiringRef.current.delete(queueItem.id);
      return;
    }

    setExecuting(prev => ({ ...prev, [queueItem.id]: true }));

    notify(`Getting quote for ${queueItem.symbol}…`, "info");

    try {
      // ── Native bonding-curve execution via PumpPortal (sole path) ─────────
      // The old Jupiter round-trip guard is gone: it checked Jupiter routability,
      // which we no longer use, and would false-block curve tokens. Pump.fun curve
      // tokens are inherently sellable back to the curve, so the exit is the guard.
      const solUsd    = await getSolUsd();

      // ── ENTRY HEADROOM GATE ──────────────────────────────────────────────
      // The 07-20 data showed the losing trades were bought AT or ABOVE the peak:
      // entries with <20% headroom went 0/6 (−233%), entries with >20% headroom went
      // 2/4 (+43%). The filter finds tokens that run ~24% median FROM THE SUSTAINED
      // TRIGGER — so if price has already run past that, the remaining upside is gone.
      // Refuse the buy when the run-up above the sustained price is too large.
      if (settings.entryHeadroomEnabled ?? true) {
        const sustainedPrice = getMilestonePrice(queueItem.tokenAddress, "sustained");
        let livePrice = null;
        try { livePrice = await fetchCurrentPrice(queueItem.tokenAddress); } catch { /* ignore */ }
        if (sustainedPrice > 0 && livePrice > 0) {
          const dragPct = ((livePrice - sustainedPrice) / sustainedPrice) * 100;
          const maxDrag = settings.maxEntryDragPct ?? 40;
          if (dragPct > maxDrag) {
            notify(`✕ ${queueItem.symbol} skipped — already ran +${dragPct.toFixed(0)}% `
              + `above trigger (max ${maxDrag}%); no headroom left`, "warn");
            logMilestone(queueItem.tokenAddress, queueItem.symbol, "skipped_drag", { price: livePrice });
            setQueue(prev => prev.filter(q => q.id !== queueItem.id));
            setExecuting(prev => ({ ...prev, [queueItem.id]: false }));
            buyFiringRef.current.delete(queueItem.id);
            return;
          }
        }
      }

      const { sig, confirmed, err } = await pumpPortalTrade({
        publicKey:       effPublicKey.toBase58(),
        action:          "buy",
        mint:            queueItem.tokenAddress,
        amount:          queueItem.stakeSOL,
        denominatedInSol: true,
        slippage:        settings.pumpSlippage ?? 15,
        priorityFee:     settings.pumpPriorityFee ?? 0.0001,
        pool:            "auto",
        signTransaction: effSignTransaction,
        connection,
      });
      if (!confirmed) {
        notify(`✕ ${queueItem.symbol} buy not confirmed (${err || "timeout"}) — check wallet before retrying`, "warn");
        setExecuting(prev => ({ ...prev, [queueItem.id]: false }));
        buyFiringRef.current.delete(queueItem.id);
        return;
      }

      // Measure the ACTUAL fill from the confirmed tx (captures curve slippage + fees)
      const tokensReceived = await getTokenBalance(connection, effPublicKey, queueItem.tokenAddress);
      const solDelta       = await getTxSolDelta(connection, sig, effPublicKey);   // negative on a buy
      const actualSolSpent = (solDelta != null && solDelta < 0) ? -solDelta : queueItem.stakeSOL;
      const inAmountSol = actualSolSpent;
      const outAmount   = tokensReceived;
      const priceImpact = 0;

      // Compute adaptive stop loss based on the entry signal's volatility.
      // The user's configured SL is treated as a FLOOR — we only widen for volatile tokens.
      const entryVol = queueItem.signal?.volatility || 0;
      const adaptiveSL = settings.adaptiveStopLoss
        ? computeAdaptiveStopLoss(entryVol, queueItem.stopLossPct)
        : queueItem.stopLossPct;

      // Entry price from the ACTUAL fill: SOL spent × SOL/USD ÷ tokens received.
      // This is the true average curve price (incl. slippage), so realised P&L is
      // measured against what you actually paid — the point of Step 2. Falls back to
      // the DexScreener/seeded price if the balance reads didn't return.
      let entryPrice = queueItem.priceUsd || 0;
      if (outAmount > 0 && solUsd > 0) {
        entryPrice = (actualSolSpent * solUsd) / outAmount;
      } else {
        try { const live = await fetchCurrentPrice(queueItem.tokenAddress); if (live) entryPrice = live; }
        catch { /* keep seeded price */ }
      }

      const position = {
        id:             `pos_${Date.now()}`,
        pairAddress:    queueItem.pairAddress,
        tokenAddress:   queueItem.tokenAddress,
        symbol:         queueItem.symbol,
        name:           queueItem.name,
        entryPrice:     entryPrice,
        currentPrice:   entryPrice,
        solSpent:       inAmountSol,
        tokensReceived: outAmount,
        takeProfitPct:  queueItem.takeProfitPct,
        stopLossPct:    adaptiveSL,
        configuredSL:   queueItem.stopLossPct,    // original setting for reference
        entryVolatility:entryVol,                  // for display
        status:         "open",
        entryTx:        sig,
        entrySignal:    queueItem.signal,
        score:          queueItem.score,
        dexUrl:         queueItem.dexUrl,
        openedAt:       Date.now(),
        pnlPct:         0,
        pnlSol:         0,
        peakPnlPct:     0,                         // tracked over time for break-even SL
      };

      positionAddrsRef.current.add(queueItem.tokenAddress);
      queuedAddrsRef.current.delete(queueItem.pairAddress);
      cooldownRef.current[queueItem.tokenAddress] = Date.now();

      setPositions(prev => [position, ...prev]);
      setQueue(prev => prev.filter(q => q.id !== queueItem.id));
      logMilestone(queueItem.tokenAddress, queueItem.symbol, "bought", { entryPrice, price: entryPrice });

      const slNote = adaptiveSL !== queueItem.stopLossPct
        ? ` · SL widened to ${adaptiveSL}% (volatility ${entryVol.toFixed(0)})`
        : "";
      notify(`✓ Bought ${queueItem.symbol} · ${inAmountSol.toFixed(4)} SOL${slNote} · tx ${sig.slice(0,8)}…`, "success");
      fireNotification({
        kind: "fill",
        title: `✓ Bought ${queueItem.symbol}`,
        body:  `${inAmountSol} SOL · impact ${priceImpact.toFixed(2)}% · TP ${queueItem.takeProfitPct}% / SL ${adaptiveSL}%`,
        settings: settingsRef.current,
      });

    } catch (err) {
      const msg = err?.message || String(err);
      notify(`Buy failed: ${msg}`, "error");
      console.error("[executeBuy]", err);
      fireNotification({
        kind: "error",
        title: `✗ Buy failed: ${queueItem.symbol}`,
        body:  msg.slice(0, 200),
        settings: settingsRef.current,
      });
    } finally {
      setExecuting(prev => ({ ...prev, [queueItem.id]: false }));
      buyFiringRef.current.delete(queueItem.id);
    }
  }, [effConnected, effPublicKey, effSignTransaction, connection, positions, settings, notify]);

  // ── Execute sell ──────────────────────────────────────────────────────────
  // ── Native sell with escalating slippage ──────────────────────────────────
  // These tokens move fast; a fixed 15% slippage fails on-chain mid-drop. Escalate
  // like the old Jupiter path did, so an exit isn't abandoned because price moved.
  const nativeSell = useCallback(async (mint, amountStr) => {
    const ladder = settings.sellSlippageLadder ?? [15, 25];
    // Try pools in order. "auto" normally picks the right venue, but at the moment a
    // token GRADUATES its liquidity moves to Raydium and the curve rejects sells with
    // Custom:6005 ("bonding curve complete"). When we see that, retry explicitly on
    // Raydium — the token is fully liquid there, just not on the curve any more.
    const isCurveComplete = (err) => typeof err === "string" && err.includes("6005");
    let last = null;
    for (const pool of ["auto", "raydium"]) {
      for (const slip of ladder) {
        const r = await pumpPortalTrade({
          publicKey:        effPublicKey.toBase58(),
          action:           "sell",
          mint,
          amount:           amountStr,
          denominatedInSol: false,
          slippage:         slip,
          priorityFee:      settings.pumpPriorityFee ?? 0.0001,
          pool,
          signTransaction:  effSignTransaction,
          connection,
        });
        last = { ...r, slippageUsed: slip, poolUsed: pool };
        if (r.confirmed) return last;
        // if the curve is complete, don't keep escalating slippage on the curve —
        // break straight to the Raydium pass
        if (isCurveComplete(r.err)) break;
      }
      // only advance to the Raydium pass if the failure was curve-complete
      if (!isCurveComplete(last?.err)) break;
    }
    return last || { confirmed: false, err: "no attempt made" };
  }, [effPublicKey, effSignTransaction, connection, settings]);

  const executeSell = useCallback(async (position, reason = "MANUAL") => {
    if (!effConnected || !effPublicKey || !effSignTransaction) {
      notify("Wallet not connected", "error");
      return;
    }
    // Native sell is "100% of holdings" — no recorded token amount needed.

    // Synchronous double-fire guard
    if (sellFiringRef.current.has(position.id)) {
      console.warn("[executeSell] already firing for", position.id);
      return;
    }
    sellFiringRef.current.add(position.id);

    setExecuting(prev => ({ ...prev, [position.id]: true }));
    notify(`Selling ${position.symbol} (${reason})…`, "info");

    try {
      const { sig, confirmed, err, slippageUsed } = await nativeSell(position.tokenAddress, "100%");
      if (!confirmed) {
        // Exit didn't confirm (likely slippage at the capped ladder). Count it and
        // let the monitor retry on the next poll; only mark stuck after repeated
        // failures, so one bad fill attempt doesn't strand the position.
        const c = (sellFailCountRef.current.get(position.id) || 0) + 1;
        sellFailCountRef.current.set(position.id, c);
        const giveUp = c >= 3;
        notify(`Sell attempt ${c} failed for ${position.symbol}: ${err || "unconfirmed"}`
          + (giveUp ? " — marked stuck" : " — retrying"), "warn");
        if (giveUp) {
          setPositions(prev => prev.map(p => p.id === position.id
            ? { ...p, stuck: true, stuckReason: String(err || "sell not confirmed").slice(0, 140) } : p));
        }
        setExecuting(prev => ({ ...prev, [position.id]: false }));
        sellFiringRef.current.delete(position.id);
        return;
      }
      // True SOL received from the confirmed tx (fixes the phantom -100% from racing snapshots)
      const solDelta    = await getTxSolDelta(connection, sig, effPublicKey);
      const finalProceeds = (solDelta != null && solDelta > 0) ? solDelta
        : Math.max((position.currentPrice / (position.entryPrice || position.currentPrice)) * position.solSpent, 0);
      // total proceeds include any earlier partial take-profit
      const solReceived = finalProceeds + (position.partialProceeds || 0);

      const pnlSol = solReceived - position.solSpent;
      const pnlPct = position.solSpent > 0 ? (pnlSol / position.solSpent) * 100 : 0;
      const sign   = pnlSol >= 0 ? "+" : "";

      const closed = {
        ...position,
        status:     "closed",
        exitReason: reason,
        exitPrice:  position.currentPrice,
        exitTx:     sig,
        closedAt:   Date.now(),
        solReceived,
        pnlSol:     parseFloat(pnlSol.toFixed(6)),
        pnlPct:     parseFloat(pnlPct.toFixed(2)),
      };

      positionAddrsRef.current.delete(position.tokenAddress);
      sellFailCountRef.current.delete(position.id);  // success — reset fail counter
      setPositions(prev => prev.filter(p => p.id !== position.id));
      setHistory(prev => [closed, ...prev].slice(0, 100));
      logMilestone(position.tokenAddress, position.symbol, "sold", {
        exitPrice: position.currentPrice, price: position.currentPrice,
        pnlPct: parseFloat(pnlPct.toFixed(2)),
        peakPnlPct: position.peakPnlPct ?? null, exitReason: reason,
      });

      notify(
        `${pnlSol >= 0 ? "✓" : "✗"} ${position.symbol} closed (${reason}) — ${sign}${pnlPct.toFixed(1)}% / ${sign}${pnlSol.toFixed(4)} SOL`,
        pnlSol >= 0 ? "success" : "warn"
      );
      // Manual sells fire as "fill", auto-sells (TP/SL/trail/BE) fire as "exit"
      const isAutoExit = reason !== "MANUAL";
      fireNotification({
        kind: isAutoExit ? "exit" : "fill",
        title: `${pnlSol >= 0 ? "✓" : "✗"} ${position.symbol} ${reason}`,
        body:  `${sign}${pnlPct.toFixed(1)}% · ${sign}${pnlSol.toFixed(4)} SOL · ${solReceived.toFixed(4)} SOL received`,
        settings: settingsRef.current,
      });

    } catch (err) {
      const msg = err?.message || String(err);
      notify(`Sell failed: ${msg}`, "error");
      console.error("[executeSell]", err);
      // Flag the position as stuck so the RETRY / ABANDON controls appear in the UI.
      // (Previously only auto-sells set this, leaving manually-sold-then-failed
      // positions with no escape hatch.)
      setPositions(prev => prev.map(p =>
        p.id === position.id
          ? { ...p, stuck: true, stuckReason: msg.slice(0, 120) }
          : p));
      fireNotification({
        kind: "error",
        title: `✗ Sell failed: ${position.symbol}`,
        body:  msg.slice(0, 200),
        settings: settingsRef.current,
      });
    } finally {
      setExecuting(prev => ({ ...prev, [position.id]: false }));
      sellFiringRef.current.delete(position.id);
    }
  }, [effConnected, effPublicKey, effSignTransaction, connection, settings, notify]);

  // ── Partial profit-take: sell a fraction, keep the position open ───────────
  // Banks realised SOL early (latency-robust), then the remainder trails for the tail.
  const executePartialSell = useCallback(async (position, fraction, atPct) => {
    console.warn(`[partialTP] executePartialSell ENTER ${position.symbol} frac=${fraction} conn=${effConnected} pk=${!!effPublicKey} sign=${!!effSignTransaction}`);
    // Signer guard — same as executeBuy/executeSell. Without this, a dropped wallet
    // made effPublicKey null and .toBase58() threw mid-trade.
    if (!effConnected || !effPublicKey || !effSignTransaction) {
      notify(`Partial TP skipped for ${position.symbol} — wallet not connected`, "warn");
      return;
    }
    if (partialFiringRef.current.has(position.id)) return;
    partialFiringRef.current.add(position.id);
    try {
      const pctStr = `${Math.round(fraction * 100)}%`;
      const { sig, confirmed, err, slippageUsed } = await nativeSell(position.tokenAddress, pctStr);
      if (!confirmed) {
        notify(`Partial TP failed for ${position.symbol}: ${err || "unconfirmed"}`, "warn");
        return;
      }
      const solDelta = await getTxSolDelta(connection, sig, effPublicKey);
      const proceeds = (solDelta != null && solDelta > 0) ? solDelta : 0;
      setPositions(prev => prev.map(p => p.id === position.id
        ? { ...p, partialTaken: true, partialProceeds: (p.partialProceeds || 0) + proceeds,
            partialPct: atPct }
        : p));
      logMilestone(position.tokenAddress, position.symbol, "partial_tp", { price: position.currentPrice });
      notify(`✓ ${position.symbol} — banked ${pctStr} at +${atPct.toFixed(0)}% (${proceeds.toFixed(4)} SOL)`, "success");
    } catch (e) {
      notify(`Partial TP error for ${position.symbol}: ${e.message || e}`, "warn");
    } finally {
      partialFiringRef.current.delete(position.id);
    }
  }, [effConnected, effPublicKey, effSignTransaction, connection, settings, notify]);

  // ── Price monitor (15s interval) ──────────────────────────────────────────
  // Uses positionsRef (not positions state) to avoid stale closures and
  // re-creating the interval on every position update.
  // autoSellFiringRef prevents duplicate auto-sells for the same position.
  useEffect(() => {
    if (priceMonitorRef.current) clearInterval(priceMonitorRef.current);
    priceMonitorRef.current = setInterval(async () => {
      const open = positionsRef.current.filter(p => p.status === "open");
      if (!open.length) return;

      // Exit options come from settings (Stages A + B)
      const exitOpts = {
        gracePeriodMs:      (settings.graceSec ?? 60) * 1000,
        breakEvenAt:        settings.breakEvenAtPct ?? 5,
        trailingEnabled:    settings.trailingEnabled ?? true,
        trailingActivateAt: settings.trailingActivateAt ?? 18,
        trailDrawdownPct:   settings.trailDrawdownPct ?? 10,
      };

      for (const pos of open) {
        try {
          const price = await fetchCurrentPrice(pos.tokenAddress);
          if (!price) continue;
          const pnl  = calcPnl(pos, price);
          // Update peakPnlPct — used by break-even SL logic
          const newPeak = Math.max(pos.peakPnlPct || 0, pnl?.pct ?? 0);
          // Build the version of the position used for exit decisions, including fresh peak
          const posForExit = { ...pos, peakPnlPct: newPeak };
          let exit = shouldTriggerExit(posForExit, price, exitOpts);

          // ── Momentum-fade sell signal (first-minutes rollover) ─────────────
          // Fetch live 5m activity; a collapse in buy pressure / trades ahead of
          // price is the earliest exit tell. Always shown; auto-exits only if enabled.
          let mom = null;
          let momTrend = pos.momTrend || [];
          try {
            const act = await fetchTokenActivity(pos.tokenAddress);
            if (act) {
              const bp = act.trades5m > 0 ? act.buys5m / act.trades5m : 0.5;
              momTrend = [...momTrend, { ts: Date.now(), price: act.priceUsd,
                trades: act.trades5m, buys: act.buys5m, sells: act.sells5m }].slice(-20);
              const timing = computeTiming(momTrend, {
                sustainSec: settings.sustainWindowSec ?? 90,
                minSamples: settings.minMomentumSamples ?? 4,
              });
              const past = Date.now() - (pos.openedAt || Date.now()) > (settings.graceSec ?? 60) * 1000;
              mom = {
                buyPressure: bp, trades5m: act.trades5m, priceChange5m: act.priceChange5m, timing,
                signal: timing === "fading" ? "FADING" : bp >= 0.55 ? "STRONG" : "OK",
              };
              // capture the fade moment (price + time) for the held token's trajectory
              if (timing === "fading") {
                logMilestone(pos.tokenAddress, pos.symbol, "fading", { price });
              }
              // Auto-exit only on SUSTAINED fade (windowed), never a single dip.
              if (timing === "fading" && past && (settings.momentumAutoExit ?? false) && !exit) {
                exit = { reason: "MOMENTUM_FADE" };
              }
            }
          } catch { /* activity is best-effort */ }

          setPositions(prev => prev.map(p =>
            p.id === pos.id
              ? {
                  ...p,
                  currentPrice: price,
                  pnlPct:       pnl?.pct ?? p.pnlPct,
                  pnlSol:       pnl?.solPnl ?? p.pnlSol,
                  peakPnlPct:   Math.max(p.peakPnlPct || 0, pnl?.pct ?? 0),
                  momentum:     mom || p.momentum,
                  momTrend,
                }
              : p
          ));

          // ── Partial profit-take: bank a fraction once up partialTpPct, then trail rest ──
          const sref = settingsRef.current;
          const ptEnabled = sref.partialTpEnabled ?? true;
          const ptPct = sref.partialTpPct ?? 35;
          const curPct = pnl?.pct ?? 0;
          if (ptEnabled && curPct >= ptPct) {
            // arithmetic condition met — log WHY it does or doesn't proceed, so a
            // silent non-fire becomes visible instead of guessed at
            const freshP = positionsRef.current.find(p => p.id === pos.id);
            const block =
              !effConnected ? "no effConnected"
              : !effPublicKey ? "no effPublicKey"
              : partialFiringRef.current.has(pos.id) ? "already firing"
              : !freshP ? "no freshP"
              : freshP.status !== "open" ? "not open"
              : freshP.stuck ? "stuck"
              : freshP.partialTaken ? "already partialTaken"
              : null;
            if (block) {
              console.warn(`[partialTP] ${pos.symbol} at +${curPct.toFixed(0)}% NOT firing — ${block}`);
            } else {
              console.warn(`[partialTP] ${pos.symbol} FIRING at +${curPct.toFixed(0)}% (sell ${Math.round((sref.partialTpFraction ?? 0.5)*100)}%)`);
              executePartialSell({ ...freshP, currentPrice: price },
                sref.partialTpFraction ?? 0.5, curPct);
            }
          }

          if (exit && effConnected && effPublicKey
              && !autoSellFiringRef.current.has(pos.id)
              && !partialFiringRef.current.has(pos.id)) {   // don't collide with an in-flight partial
            const freshPos = positionsRef.current.find(p => p.id === pos.id);
            if (!freshPos || freshPos.status !== "open") continue;
            // (native sells 100% of remaining holdings — no token-amount precondition)
            // Stuck position: skip auto-sell if it's failed too many times.
            // User must manually retry or abandon via the UI.
            if (freshPos.stuck) continue;
            const failCount = sellFailCountRef.current.get(pos.id) || 0;
            if (failCount >= 3) {
              // Mark as stuck — UI will show button to retry or abandon
              setPositions(prev => prev.map(p =>
                p.id === pos.id ? { ...p, stuck: true, stuckReason: "auto-sell failed 3 times" } : p
              ));
              notify(`⚠ ${freshPos.symbol} marked stuck — manual action required`, "warn");
              continue;
            }
            autoSellFiringRef.current.add(pos.id);
            executeSell({ ...freshPos, currentPrice: price, peakPnlPct: newPeak }, exit.reason)
              .then(() => {
                // Success — reset fail counter
                sellFailCountRef.current.delete(pos.id);
              })
              .catch(() => {
                // Failure — increment counter
                const c = (sellFailCountRef.current.get(pos.id) || 0) + 1;
                sellFailCountRef.current.set(pos.id, c);
              })
              .finally(() => autoSellFiringRef.current.delete(pos.id));
          }
        } catch {}
      }
    }, PRICE_POLL_MS);
    return () => clearInterval(priceMonitorRef.current);
    // settings is included so grace/breakEven changes apply on next tick
  }, [executeSell, executePartialSell, settings.graceSec, settings.breakEvenAtPct,
      settings.trailingEnabled, settings.trailingActivateAt, settings.trailDrawdownPct,
      settings.partialTpEnabled, settings.partialTpPct, effConnected, effPublicKey]);

  // ── Auto-queue + refresh + prune from scanner ─────────────────────────────
  // Called on every scan pass from App.jsx with the latest token list.
  // 1. New tokens meeting all criteria (including V/L ratio) → addToQueue
  // 2. Existing queue tokens seen in scan → refresh price/score/signal
  // 3. Tokens that degrade for 2+ consecutive scans → auto-remove
  // 4. Tokens that no longer meet hard criteria → auto-remove
  // 5. Tokens stale >10 min (not seen in scan) → auto-remove
  const checkAndQueue = useCallback((tokens, classifyMomentum) => {
    const openCount = positions.filter(p => p.status === "open").length;

    // Build a lookup map of this scan's tokens by pairAddress for O(1) access
    const scanMap = new Map(tokens.map(t => [t.pairAddress, t]));
    const now     = Date.now();

    // Helper to check V/L ratio quality gate
    const passesVolLiq = (token) => {
      const liq   = parseFloat(token.liquidity?.usd || 0);
      const vol24 = parseFloat(token.volume?.h24    || 0);
      if (liq <= 0) return false;
      return (vol24 / liq) >= (settings.minVolLiqRatio || 0);
    };

    setQueue(prev => {
      let updated = [...prev];
      const toRemove = new Set();

      // ── Refresh / prune existing queue items ────────────────────────────
      updated = updated.map(item => {
        // LAUNCH items come from the t=0 PumpPortal stream, not the DexScreener
        // scan, so the momentum-degradation prune must not touch them.
        if (item.signal?.type === "LAUNCH") return item;

        const fresh = scanMap.get(item.pairAddress);

        // Not seen in this scan at all
        if (!fresh) {
          if (now - (item.lastUpdated || item.queuedAt) > QUEUE_STALE_MS) {
            toRemove.add(item.id);
            notify(`${item.symbol} removed from queue (signal gone)`, "warn");
          }
          return item;
        }

        // Token is in the scan — re-evaluate everything
        const signal    = classifyMomentum(fresh);
        const score     = fresh._score || 0;
        const meetsMin  = score >= settings.minScore;
        const meetsConf = signal && signal.conf >= settings.minConfidence;
        const meetsVL   = passesVolLiq(fresh);

        // Hard fails — remove immediately (regardless of degradation count)
        if (!signal || !meetsMin || !meetsConf || !meetsVL) {
          toRemove.add(item.id);
          const reason = !meetsVL ? "low volume" :
                         !meetsMin ? "score dropped" :
                         !signal ? "signal lost" :
                         "low confidence";
          notify(`${item.symbol} removed (${reason})`, "warn");
          return item;
        }

        // Signal degradation tracking — soft removal after 2 consecutive bad scans
        const isStrongSig = ["EARLY MOMENTUM","UPTREND","LATE RECOVERY"].includes(signal.type);
        const newDegrade  = isStrongSig ? 0 : (item.degradeCount || 0) + 1;

        if (settings.requireMomentum && newDegrade >= 2) {
          toRemove.add(item.id);
          notify(`${item.symbol} removed (momentum faded — ${signal.type})`, "warn");
          return item;
        }

        // Still qualifies — refresh
        return {
          ...item,
          priceUsd:     parseFloat(fresh.priceUsd || 0),
          score,
          signal,
          lastUpdated:  now,
          degradeCount: newDegrade,
        };
      });

      if (toRemove.size > 0) {
        updated = updated.filter(item => {
          if (toRemove.has(item.id)) {
            queuedAddrsRef.current.delete(item.pairAddress);
            return false;
          }
          return true;
        });
      }

      return updated;
    });

    // ── Add new qualifying tokens (with two-scan confirmation + safety check) ─
    // The DexScreener momentum path is DEPRECATED as entry alpha: the sol-early-signal
    // research found these signals (vol/liq, buy-pressure, acceleration, price action)
    // have no leading edge — they fire on the second wave, after the move. Entries now
    // come from the t=0 launch-score stream (see addLaunchToQueue). This block only runs
    // if you explicitly set entrySource back to "momentum".
    const entrySource = settings.entrySource ?? "launch";
    if (entrySource === "momentum" && openCount < settings.maxPositions) {
      const confirmScans  = settings.confirmScans ?? 2;     // require this many sightings
      const candidateTTL  = 5 * 60 * 1000;                  // forget after 5 min of no sighting

      // First: filter through all sync gates to get candidates
      const candidates = [];
      const seenThisScan = new Set();
      for (const token of tokens) {
        if ((token._score || 0) < settings.minScore) continue;
        if (!passesVolLiq(token)) continue;
        const signal = classifyMomentum(token);
        if (!signal) continue;
        if (signal.conf < settings.minConfidence) continue;
        if (settings.requireMomentum && !["EARLY MOMENTUM","UPTREND"].includes(signal.type)) continue;
        // Dedup early — no need to safety-check tokens we won't queue
        const addr = token.baseToken?.address;
        if (queuedAddrsRef.current.has(token.pairAddress)) continue;
        if (positionAddrsRef.current.has(addr)) continue;
        const last = cooldownRef.current[addr];
        if (last && Date.now() - last < settings.cooldownMinutes * 60000) continue;

        seenThisScan.add(token.pairAddress);

        // ── Two-scan confirmation gate ──────────────────────────────────────
        // First sighting: add to candidates map, do NOT queue yet.
        // Nth sighting (N >= confirmScans): promote to safety check + queue.
        if (confirmScans > 1) {
          const existing = candidatesRef.current.get(token.pairAddress);
          if (!existing) {
            // First time we've seen this with a valid signal — start tracking
            candidatesRef.current.set(token.pairAddress, {
              firstSeen: now,
              count:     1,
              lastSig:   signal.type,
            });
            continue; // skip queue for this scan
          }
          // Already tracked — increment and check if confirmed
          existing.count += 1;
          existing.lastSig = signal.type;
          if (existing.count < confirmScans) {
            continue; // need more sightings
          }
          // Confirmed — falls through to queue, candidate record can be cleared
          candidatesRef.current.delete(token.pairAddress);
        }

        candidates.push({ token, signal });
      }

      // Garbage-collect stale candidate records (not seen this scan, older than TTL)
      for (const [pairAddr, info] of candidatesRef.current.entries()) {
        if (!seenThisScan.has(pairAddr) && now - info.firstSeen > candidateTTL) {
          candidatesRef.current.delete(pairAddr);
        }
      }

      // Then: run safety checks in parallel and queue only safe ones.
      if (settings.enableSafetyCheck === false) {
        candidates.forEach(({ token, signal }) => addToQueue(token, signal));
      } else {
        const safetyOpts = {
          maxRiskScore:       settings.maxRiskScore       ?? 60,
          allowUnprofiled:    settings.allowUnprofiled    ?? false,
          blockHardFails:     settings.blockHardFails     ?? true,
          blockHighOwnership: settings.blockHighOwnership ?? true,
        };

        candidates.forEach(async ({ token, signal }) => {
          try {
            const safety = await checkTokenSafety(token.baseToken?.address, safetyOpts);
            if (!safety.safe) {
              if (safety.severity === "hard") {
                notify(`✕ ${token.baseToken?.symbol || "?"} blocked: ${safety.reason}`, "warn");
              }
              return;
            }
            addToQueue(token, signal, safety.report);
          } catch (err) {
            console.warn("[safety] check failed:", err.message);
          }
        });
      }
    }
  }, [settings, positions, addToQueue, notify]);

  // ── Launch-score entry path (t=0 PumpPortal stream) ─────────────────────────
  // Brand-new tokens are not yet on RugCheck (they'd 404), and firing a RugCheck
  // call per auto-queued launch floods the API to 429s. So we do NOT gate launch
  // queueing on RugCheck — it can't assess a token this young. Safety is advisory
  // here; enforce it at buy time if desired. We seed an initial USD price from the
  // bonding-curve reserves so the queue shows a real price (not 0) and P&L has a basis.
  const addLaunchToQueue = useCallback(async (launch, source = "manual") => {
    logMilestone(launch.mint, launch.symbol, "queued", {
      source, score: launch.score, devSol: launch.devSol,
      price: launch.eligibility?.priceUsd,
    });
    let priceUsd = 0;
    try {
      const solUsd = await getSolUsd();
      if (launch.priceSol > 0 && solUsd > 0) priceUsd = launch.priceSol * solUsd;
    } catch { /* leave 0 — display falls back gracefully */ }

    const token = {
      baseToken:   { address: launch.mint, symbol: launch.symbol, name: launch.name },
      pairAddress: launch.mint,              // mint as the unique key (no DEX pair yet)
      priceUsd,
      _score:      launch.score,
      _mint:       launch.mint,
      _activity:   launch.eligibility || null,   // trades5m, priceChange5m, buys/sells, vol, liq, pairAddress
      _pairAddress: launch.eligibility?.pairAddress || null,
    };
    const signal = {
      type: "LAUNCH",
      strength: launch.score >= 70 ? "STRONG" : launch.score >= 55 ? "MODERATE" : "WEAK",
      conf: launch.score, color: "#7c5cff", icon: "✦", volatility: 0,
      detail: `t=0 score ${launch.score} · dev ${Number(launch.devSol).toFixed(2)} SOL · `
            + `creator ${launch.priorGrads}/${launch.priorCount} grads`,
    };
    addToQueue(token, signal);
  }, [addToQueue]);

  // ── Live queue activity for LAUNCH items ────────────────────────────────────
  // Keeps queued launch tokens updating with live 5m activity + a short trend, so
  // you can time the buy inside the narrow window instead of buying blind or late.
  // Computes a timing signal: hot (accelerating + buy pressure) → fading (rolling over).
  const queueRef = useRef([]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => {
    const iv = setInterval(async () => {
      const launchItems = queueRef.current.filter(q => q.signal?.type === "LAUNCH");
      for (const item of launchItems.slice(0, 8)) {
        const act = await fetchTokenActivity(item.tokenAddress);
        if (!act) continue;
        setQueue(prev => prev.map(q => {
          if (q.id !== item.id) return q;
          const sample = { ts: Date.now(), price: act.priceUsd, trades: act.trades5m,
                           buys: act.buys5m, sells: act.sells5m };
          const trend = [...(q.trend || []), sample].slice(-20);
          const bp = act.trades5m > 0 ? act.buys5m / act.trades5m : 0.5;
          const timing = computeTiming(trend, {
            sustainSec: settingsRef.current.sustainWindowSec ?? 90,
            minSamples: settingsRef.current.minMomentumSamples ?? 4,
          });
          return { ...q, activity: act, trend, buyPressure: bp, timing,
                   priceUsd: act.priceUsd || q.priceUsd, lastUpdated: Date.now(),
                   pairAddressReal: act.pairAddress || q.pairAddressReal };
        }));
      }
    }, 6000);
    return () => clearInterval(iv);
  }, []);
  const stats = {
    openCount:   positions.filter(p => p.status === "open").length,
    queueCount:  queue.length,
    totalPnlSol: history.reduce((s, p) => s + (p.pnlSol || 0), 0),
    totalPnlPct: history.length
      ? history.reduce((s, p) => s + (p.pnlPct || 0), 0) / history.length
      : 0,
    winRate:     history.length
      ? (history.filter(p => p.pnlSol > 0).length / history.length) * 100
      : 0,
    tradeCount: history.length,
  };

  return {
    settings, updateSettings,
    queue: sortQueue(queue, queueSort),
    queueSort, setQueueSort,
    addToQueue, removeFromQueue, updateQueueItem, clearQueue,
    addLaunchToQueue,
    burner,
    retryPosition, abandonPosition,
    positions, history,
    executing,
    notifications, dismissNotif,
    executeBuy, executeSell,
    checkAndQueue,
    stats,
    connected,
    canTrade: effConnected,
    tradingAddress: effPublicKey?.toString?.() || null,
    walletAddress: publicKey?.toString(),
  };
}
