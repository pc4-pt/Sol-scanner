// ─── useTrading.js ────────────────────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  executeBuySwap, executeSellSwap,
  fetchCurrentPrice, calcPnl, shouldTriggerExit, getSolUsd, simulateRoundTrip, fetchTokenActivity,
  computeAdaptiveStopLoss,
  DEFAULT_TRADE_SETTINGS, SOL_MINT, PRICE_POLL_MS,
} from "./tradingEngine.js";
import { checkTokenSafety } from "./safety.js";
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

  const [settings,      setSettings]  = useState(() => load(KEYS.settings,  DEFAULT_TRADE_SETTINGS));
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
    if (!connected || !publicKey || !signTransaction) {
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
      const lamports = Math.round(queueItem.stakeSOL * 1_000_000_000);

      // ── Honeypot / dead-liquidity guard ──────────────────────────────────
      // Confirm the token can actually be SOLD before we buy it. This is the
      // guard against getting stuck in an unsellable position.
      if (settings.preBuySellCheck ?? true) {
        notify(`Checking ${queueItem.symbol} is sellable…`, "info");
        const rt = await simulateRoundTrip({
          tokenMint: queueItem.tokenAddress, amountLamports: lamports,
          slippageBps: settings.slippageBps,
        });
        const minRec = settings.minRoundTripRecovery ?? 0.7;
        if (!rt.sellable) {
          notify(`✕ ${queueItem.symbol} blocked — ${rt.reason}`, "warn");
          setExecuting(prev => ({ ...prev, [queueItem.id]: false }));
          buyFiringRef.current.delete(queueItem.id);
          return;
        }
        if (rt.recovered < minRec) {
          notify(`✕ ${queueItem.symbol} blocked — round-trip recovers only `
            + `${(rt.recovered * 100).toFixed(0)}% (transfer tax or thin liquidity)`, "warn");
          setExecuting(prev => ({ ...prev, [queueItem.id]: false }));
          buyFiringRef.current.delete(queueItem.id);
          return;
        }
      }

      const { sig, outAmount, priceImpact, inAmountSol } = await executeBuySwap({
        inputMint:      SOL_MINT,
        outputMint:     queueItem.tokenAddress,
        amountLamports: lamports,
        slippageBps:    settings.slippageBps,
        publicKey,
        signTransaction,
        connection,
      });

      // Compute adaptive stop loss based on the entry signal's volatility.
      // The user's configured SL is treated as a FLOOR — we only widen for volatile tokens.
      const entryVol = queueItem.signal?.volatility || 0;
      const adaptiveSL = settings.adaptiveStopLoss
        ? computeAdaptiveStopLoss(entryVol, queueItem.stopLossPct)
        : queueItem.stopLossPct;

      // Entry price: prefer a fresh market price at fill time (unit-consistent with
      // the monitor's fetchCurrentPrice); fall back to the queued/seeded price. For
      // launch tokens not yet listed this stays the reserve-based estimate.
      let entryPrice = queueItem.priceUsd || 0;
      try {
        const live = await fetchCurrentPrice(queueItem.tokenAddress);
        if (live) entryPrice = live;
      } catch { /* keep seeded price */ }

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

      const slNote = adaptiveSL !== queueItem.stopLossPct
        ? ` · SL widened to ${adaptiveSL}% (volatility ${entryVol.toFixed(0)})`
        : "";
      notify(`✓ Bought ${queueItem.symbol} · impact ${priceImpact.toFixed(2)}%${slNote} · tx ${sig.slice(0,8)}…`, "success");
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
  }, [connected, publicKey, signTransaction, connection, positions, settings, notify]);

  // ── Execute sell ──────────────────────────────────────────────────────────
  const executeSell = useCallback(async (position, reason = "MANUAL") => {
    if (!connected || !publicKey || !signTransaction) {
      notify("Wallet not connected", "error");
      return;
    }
    if (!position.tokensReceived || position.tokensReceived <= 0) {
      notify(`Cannot sell ${position.symbol}: no token amount recorded`, "error");
      return;
    }

    // Synchronous double-fire guard
    if (sellFiringRef.current.has(position.id)) {
      console.warn("[executeSell] already firing for", position.id);
      return;
    }
    sellFiringRef.current.add(position.id);

    setExecuting(prev => ({ ...prev, [position.id]: true }));
    notify(`Selling ${position.symbol} (${reason})…`, "info");

    try {
      const { sig, solReceived } = await executeSellSwap({
        tokenMint:      position.tokenAddress,
        tokenAmount:    position.tokensReceived,
        slippageBps:    settings.slippageBps,
        publicKey,
        signTransaction,
        connection,
      });

      const pnlSol = solReceived - position.solSpent;
      const pnlPct = (pnlSol / position.solSpent) * 100;
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
  }, [connected, publicKey, signTransaction, connection, settings, notify]);

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
        trailingActivateAt: settings.trailingActivateAt ?? 30,
        trailDrawdownPct:   settings.trailDrawdownPct ?? 15,
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
          const exit = shouldTriggerExit(posForExit, price, exitOpts);

          setPositions(prev => prev.map(p =>
            p.id === pos.id
              ? {
                  ...p,
                  currentPrice: price,
                  pnlPct:       pnl?.pct ?? p.pnlPct,
                  pnlSol:       pnl?.solPnl ?? p.pnlSol,
                  peakPnlPct:   Math.max(p.peakPnlPct || 0, pnl?.pct ?? 0),
                }
              : p
          ));

          if (exit && !autoSellFiringRef.current.has(pos.id)) {
            const freshPos = positionsRef.current.find(p => p.id === pos.id);
            if (!freshPos || freshPos.status !== "open") continue;
            if (!freshPos.tokensReceived || freshPos.tokensReceived <= 0) continue;
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
  }, [executeSell, settings.graceSec, settings.breakEvenAtPct,
      settings.trailingEnabled, settings.trailingActivateAt, settings.trailDrawdownPct]);

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
  const addLaunchToQueue = useCallback(async (launch) => {
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
          const trend = [...(q.trend || []), sample].slice(-6);
          // timing signal from the last two samples + buy pressure
          const bp = act.trades5m > 0 ? act.buys5m / act.trades5m : 0.5;
          let timing = "flat";
          if (trend.length >= 2) {
            const prev2 = trend[trend.length - 2];
            const dTrades = sample.trades - prev2.trades;
            const dPrice  = prev2.price > 0 ? (sample.price - prev2.price) / prev2.price : 0;
            if (dPrice < -0.05 || bp < 0.45)                 timing = "fading";
            else if (dTrades > 0 && bp >= 0.55 && dPrice >= 0) timing = "hot";
            else if (dTrades < 0)                             timing = "cooling";
          }
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
    retryPosition, abandonPosition,
    positions, history,
    executing,
    notifications, dismissNotif,
    executeBuy, executeSell,
    checkAndQueue,
    stats,
    connected,
    walletAddress: publicKey?.toString(),
  };
}
