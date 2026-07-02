import { useState, useEffect, useCallback, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { TradingPanel } from "./TradingPanel.jsx";
import { LaunchFeed } from "./LaunchFeed.jsx";
import { useTrading } from "./useTrading.js";

const IS_DEV = import.meta.env?.DEV ?? false;
const API = IS_DEV ? "/api" : "https://api.dexscreener.com";
const REFRESH_INTERVAL = 90000;
const MAX_TOKENS_PER_BATCH = 30;

// ─── SCORING ENGINE ───────────────────────────────────────────────────────────
function scoreToken(token, metaBonus = 0, boostData = null) {
  const liq = parseFloat(token.liquidity?.usd || 0);
  const vol24 = parseFloat(token.volume?.h24 || 0);
  const vol1h = parseFloat(token.volume?.h1 || 0);
  const vol5m = parseFloat(token.volume?.m5 || 0);
  const buys1h = token.txns?.h1?.buys || 0;
  const sells1h = token.txns?.h1?.sells || 0;
  const buys5m = token.txns?.m5?.buys || 0;
  const sells5m = token.txns?.m5?.sells || 0;
  const buys24 = token.txns?.h24?.buys || 0;
  const sells24 = token.txns?.h24?.sells || 0;
  const mcap = parseFloat(token.marketCap || token.fdv || 0);
  const pc5m = parseFloat(token.priceChange?.m5 || 0);
  const pc1h = parseFloat(token.priceChange?.h1 || 0);
  const pc6h = parseFloat(token.priceChange?.h6 || 0);
  const pc24h = parseFloat(token.priceChange?.h24 || 0);
  const activeBoosts = token.boosts?.active || 0;
  const scores = {};
  if (liq < 5000) scores.liquidity = 0;
  else if (liq < 10000) scores.liquidity = 15;
  else if (liq < 20000) scores.liquidity = 40;
  else if (liq < 50000) scores.liquidity = 65;
  else if (liq < 150000) scores.liquidity = 88;
  else if (liq < 500000) scores.liquidity = 100;
  else if (liq < 2000000) scores.liquidity = 90;
  else scores.liquidity = 75;
  const liqRatio = mcap > 0 ? liq / mcap : 0;
  if (liqRatio === 0) scores.whaleSafety = 30;
  else if (liqRatio < 0.003) scores.whaleSafety = 10;
  else if (liqRatio < 0.01) scores.whaleSafety = 35;
  else if (liqRatio < 0.03) scores.whaleSafety = 60;
  else if (liqRatio < 0.08) scores.whaleSafety = 85;
  else if (liqRatio < 0.2) scores.whaleSafety = 100;
  else scores.whaleSafety = 90;
  const vlRatio = liq > 0 ? vol24 / liq : 0;
  if (vlRatio < 0.3) scores.momentum = 15;
  else if (vlRatio < 1) scores.momentum = 45;
  else if (vlRatio < 3) scores.momentum = 75;
  else if (vlRatio < 8) scores.momentum = 100;
  else if (vlRatio < 25) scores.momentum = 80;
  else scores.momentum = 40;
  const tx1h = buys1h + sells1h;
  const buyRatio1h = tx1h > 0 ? buys1h / tx1h : 0.5;
  if (buyRatio1h < 0.25) scores.buyPressure = 5;
  else if (buyRatio1h < 0.4) scores.buyPressure = 30;
  else if (buyRatio1h < 0.5) scores.buyPressure = 55;
  else if (buyRatio1h < 0.62) scores.buyPressure = 80;
  else if (buyRatio1h < 0.75) scores.buyPressure = 100;
  else scores.buyPressure = 85;
  const recentVelocity = vol1h > 0 ? (vol5m * 12) / vol1h : 0;
  if (recentVelocity < 0.3) scores.acceleration = 20;
  else if (recentVelocity < 0.7) scores.acceleration = 50;
  else if (recentVelocity < 1.5) scores.acceleration = 80;
  else if (recentVelocity < 3) scores.acceleration = 100;
  else scores.acceleration = 65;
  const ms = pc5m * 0.4 + pc1h * 0.35 + pc6h * 0.15 + pc24h * 0.1;
  if (ms < -30) scores.priceAction = 5;
  else if (ms < -10) scores.priceAction = 25;
  else if (ms < 0) scores.priceAction = 50;
  else if (ms < 20) scores.priceAction = 85;
  else if (ms < 60) scores.priceAction = 100;
  else if (ms < 150) scores.priceAction = 65;
  else scores.priceAction = 20;
  const ageMs = token.pairCreatedAt ? Date.now() - token.pairCreatedAt : 0;
  const ageH = ageMs / 3600000;
  if (ageH < 0.25) scores.age = 20;
  else if (ageH < 1) scores.age = 55;
  else if (ageH < 6) scores.age = 100;
  else if (ageH < 24) scores.age = 90;
  else if (ageH < 72) scores.age = 75;
  else if (ageH < 168) scores.age = 55;
  else scores.age = 35;
  const tx24 = buys24 + sells24;
  if (tx24 < 15) scores.activity = 10;
  else if (tx24 < 60) scores.activity = 40;
  else if (tx24 < 250) scores.activity = 70;
  else if (tx24 < 1000) scores.activity = 90;
  else scores.activity = 100;
  const weights = { liquidity: 0.25, whaleSafety: 0.18, momentum: 0.15, buyPressure: 0.12, acceleration: 0.10, priceAction: 0.10, age: 0.05, activity: 0.05 };
  let total = Object.entries(weights).reduce((s, [k, w]) => s + (scores[k] || 0) * w, 0);
  total = Math.min(100, total + metaBonus);
  if (activeBoosts > 0) total = Math.min(100, total + Math.min(activeBoosts * 1.5, 6));
  if (boostData) { const ratio = boostData.amount / Math.max(boostData.totalAmount, 1); if (ratio > 0.3 && ratio < 0.9) total = Math.min(100, total + 3); }
  return { total: Math.round(total), breakdown: scores, activeBoosts };
}

function getRating(score) {
  if (score >= 82) return { label: "APEX",   color: "#00e5c3", bg: "#00e5c318" };
  if (score >= 70) return { label: "PRIME",  color: "#2ecc40", bg: "#2ecc4018" };
  if (score >= 58) return { label: "STRONG", color: "#b8f542", bg: "#b8f54218" };
  if (score >= 44) return { label: "WATCH",  color: "#f0a500", bg: "#f0a50018" };
  return               { label: "RISKY",  color: "#ff3860", bg: "#ff386018" };
}

function classifyMomentum(token) {
  const m5 = parseFloat(token.priceChange?.m5 || 0);
  const h1 = parseFloat(token.priceChange?.h1 || 0);
  const h6 = parseFloat(token.priceChange?.h6 || 0);
  const h24 = parseFloat(token.priceChange?.h24 || 0);
  const buys1h = token.txns?.h1?.buys || 0; const sells1h = token.txns?.h1?.sells || 0;
  const buys5m = token.txns?.m5?.buys || 0; const sells5m = token.txns?.m5?.sells || 0;
  const vol1h = parseFloat(token.volume?.h1 || 0); const vol5m = parseFloat(token.volume?.m5 || 0);
  const vol24 = parseFloat(token.volume?.h24 || 0);
  const liq = parseFloat(token.liquidity?.usd || 0);
  const tx1h = buys1h + sells1h; const tx5m = buys5m + sells5m;
  const buyRatio1h = tx1h > 0 ? buys1h / tx1h : 0.5;
  const buyRatio5m = tx5m > 0 ? buys5m / tx5m : 0.5;
  const velocityRatio = vol1h > 0 ? (vol5m * 12) / vol1h : 1;

  // ── Quality gate: volume must justify liquidity ─────────────────────────────
  const vlRatio = liq > 0 ? vol24 / liq : 0;
  if (vlRatio < 0.5) return null;
  if (liq < 10000)   return null;

  // ── Volatility measure: max abs price change across timeframes ─────────────
  // This is attached to the signal so the trading engine can size SL appropriately.
  // High volatility tokens get wider stops; quiet tokens get tighter stops.
  const volatility = Math.max(Math.abs(m5), Math.abs(h1) * 0.5, Math.abs(h6) * 0.2);

  // ── Pressure thresholds ─────────────────────────────────────────────────────
  const strongBuyingNow   = buyRatio5m >= 0.6;
  const moderateBuyingNow = buyRatio5m >= 0.55;
  const buyingPressure    = buyRatio1h > 0.55 && buyRatio5m > 0.55;
  const accelerating      = velocityRatio > 1.2;
  const shortUp = m5 > 0 && h1 > 0;
  const longFlat = Math.abs(h6) < 15 && Math.abs(h24) < 20;
  const longNeg = h6 < -5 || h24 < -5;

  // ── Momentum quality gate ───────────────────────────────────────────────────
  // A high buy ratio means nothing if it's based on tiny volume. Require the
  // 5m volume to be meaningful relative to the pool: at least $5k absolute, AND
  // at least 1% of the pool's liquidity in the last 5 minutes.
  // This filters out signals from a handful of small buys that look like momentum.
  const sufficientVolume = vol5m >= 5000 && (liq > 0 ? vol5m / liq >= 0.01 : true);
  const sufficientTxns   = tx5m >= 8;     // raised from 5 — need real participation

  // ── Late-entry rejection ───────────────────────────────────────────────────
  // If h6 is already up >25%, the move has matured — buying now is buying the top.
  // EARLY MOMENTUM requires h6 to be flat or recovering, not already running.
  const tooLateForEarly = h6 > 25;

  // EARLY MOMENTUM — strongest signal. Rejects late entries + low-quality momentum.
  if (shortUp && (longFlat || longNeg) && strongBuyingNow && sufficientTxns && sufficientVolume && !tooLateForEarly) {
    let conf = Math.min(99, Math.round(
      Math.min(30, m5*1.5) +
      Math.min(20, h1*0.5) +
      (longNeg ? 15 : 5) +
      (accelerating ? 20 : 5) +
      Math.min(15, (buyRatio5m - 0.5) * 100)
    ));
    const strength = conf>=75?"STRONG":conf>=50?"MODERATE":"WEAK";
    return { type:"EARLY MOMENTUM", strength, conf, color:"#00e5c3", icon:"▲", volatility,
      detail:`5m/1h rising, 6h/24h flat — move just starting. ${(buyRatio5m*100).toFixed(0)}% buys (5m).${accelerating?" Vol accelerating.":""}` };
  }

  // LATE RECOVERY — bounce off a dump. Requires moderate 5m buying.
  const wasDown = h24 < -10 && h6 < -5;
  const turning = h1 > 2 && m5 > 0;
  if (wasDown && turning && moderateBuyingNow && buyRatio1h > 0.52) {
    let conf = Math.min(99, Math.round(
      Math.min(30, Math.abs(h24)*0.6) +
      Math.min(20, h1*0.8) +
      Math.min(15, m5*1.2) +
      20 +
      (accelerating ? 15 : 0)
    ));
    const strength = conf>=70?"STRONG":conf>=45?"MODERATE":"WEAK";
    return { type:"LATE RECOVERY", strength, conf, color:"#b8f542", icon:"↩", volatility,
      detail:`Down ${Math.abs(h24).toFixed(0)}% on 24h, bouncing ${h1.toFixed(1)}% on 1h. ${(buyRatio5m*100).toFixed(0)}% buys (5m).` };
  }

  // TOPPING OUT — pumped and now selling pressure dominates.
  if (h24>40 && (m5 < 0 || buyRatio5m < 0.5) && buyRatio1h < 0.5) {
    let conf = Math.min(99, Math.round(
      Math.min(40, h24*0.3) +
      Math.min(30, Math.abs(h1)*2) +
      20 +
      Math.min(10, (0.5 - buyRatio5m) * 100)
    ));
    const strength = conf>=65?"STRONG":conf>=40?"MODERATE":"WEAK";
    return { type:"TOPPING OUT", strength, conf, color:"#ff3860", icon:"▼", volatility,
      detail:`Up ${h24.toFixed(0)}% in 24h but reversing. Only ${(buyRatio5m*100).toFixed(0)}% buys (5m) — sell pressure building.` };
  }

  // UPTREND — all timeframes positive. Reject very late entries (h6 > 40%).
  const tooLateForUptrend = h6 > 40;
  if (m5>0 && h1>0 && h6>0 && h24>10 && moderateBuyingNow && !tooLateForUptrend) {
    const consistent = Math.abs(h1-h6/6)<10;
    let conf = Math.min(99, Math.round(
      Math.min(35, h24*0.5) +
      Math.min(25, h1*1.5) +
      (consistent ? 25 : 10) +
      (buyingPressure ? 15 : 5)
    ));
    const strength = conf>=70?"STRONG":conf>=45?"MODERATE":"WEAK";
    return { type:"UPTREND", strength, conf, color:"#2ecc40", icon:"↑", volatility,
      detail:`All timeframes positive.${consistent?" Consistent grind.":" Accelerating."} ${(buyRatio5m*100).toFixed(0)}% buys (5m).` };
  }

  if (Math.abs(h1)<3 && Math.abs(h6)<8) return { type:"CONSOLIDATING", strength:"NEUTRAL", conf:50, color:"#666e7a", icon:"–", volatility, detail:"Tight range — potential breakout setup." };
  return null;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmt(n, dec = 1) {
  if (!n && n !== 0) return "—"; const v = parseFloat(n); if (isNaN(v)) return "—";
  if (Math.abs(v) >= 1e9) return (v/1e9).toFixed(dec)+"B";
  if (Math.abs(v) >= 1e6) return (v/1e6).toFixed(dec)+"M";
  if (Math.abs(v) >= 1e3) return (v/1e3).toFixed(dec)+"K";
  return v.toFixed(dec);
}
function fmtAge(ts) {
  if (!ts) return "?"; const ms = Date.now()-ts; const m=Math.floor(ms/60000); const h=Math.floor(m/60); const d=Math.floor(h/24);
  if (d>0) return `${d}d ${h%24}h`; if (h>0) return `${h}h ${m%60}m`; return `${m}m`;
}
function fmtPrice(p) {
  const v = parseFloat(p||0); if (v===0) return "—";
  if (v<0.000001) return v.toExponential(2); if (v<0.001) return v.toFixed(7); if (v<1) return v.toFixed(5); return v.toFixed(4);
}

// ─── MICRO COMPONENTS ─────────────────────────────────────────────────────────
function Pct({ val, size = "md" }) {
  const v = parseFloat(val || 0);
  const pos = v > 0, neg = v < 0;
  const color = pos ? "var(--green)" : neg ? "var(--red)" : "var(--muted)";
  const sizes = { sm: "0.72rem", md: "0.82rem", lg: "0.95rem" };
  return (
    <span style={{ color, fontSize: sizes[size], fontFamily: "var(--font-mono)", fontWeight: 500, letterSpacing: "-0.01em" }}>
      {pos ? "+" : ""}{v.toFixed(2)}%
    </span>
  );
}

function ScoreRing({ score, rating }) {
  const r = 18, circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <div style={{ position: "relative", width: 44, height: 44, flexShrink: 0 }}>
      <svg width="44" height="44" style={{ transform: "rotate(-90deg)", position: "absolute", inset: 0 }}>
        <circle cx="22" cy="22" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={rating.color} strokeWidth="2.5"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.8s ease", filter: `drop-shadow(0 0 3px ${rating.color}99)` }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: "0.7rem", fontWeight: 700, color: rating.color, fontFamily: "var(--font-mono)" }}>{score}</span>
      </div>
    </div>
  );
}

function ConfBars({ conf, color }) {
  const filled = Math.round(conf / 20);
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "flex-end" }}>
      {[1,2,3,4,5].map(i => (
        <div key={i} style={{ width: 3, height: 4 + i * 2, borderRadius: 1,
          background: i <= filled ? color : "var(--border)",
          boxShadow: i <= filled ? `0 0 3px ${color}88` : "none",
          transition: "background 0.3s" }} />
      ))}
    </div>
  );
}

function Tag({ children, color, bg }) {
  return (
    <span style={{ fontSize: "0.62rem", fontFamily: "var(--font-mono)", fontWeight: 600,
      color: color || "var(--muted2)", background: bg || "var(--surface2)",
      padding: "2px 6px", borderRadius: 3, letterSpacing: "0.04em", whiteSpace: "nowrap", lineHeight: 1.5 }}>
      {children}
    </span>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "var(--border)", margin: "0 -1px" }} />;
}

// ─── MOMENTUM PILL ────────────────────────────────────────────────────────────
function MomentumPill({ token }) {
  const sig = classifyMomentum(token);
  if (!sig) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
      background: sig.color + "0e", borderTop: `1px solid var(--border)`,
      borderBottom: `1px solid var(--border)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ fontSize: "0.7rem", fontWeight: 700, color: sig.color,
          fontFamily: "var(--font-mono)", letterSpacing: "0.06em" }}>
          {sig.icon} {sig.type}
        </span>
        <Tag color={sig.color} bg={sig.color + "18"}>{sig.strength}</Tag>
      </div>
      <span style={{ fontSize: "0.68rem", color: "var(--muted2)", flex: 1 }}>{sig.detail}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
        <ConfBars conf={sig.conf} color={sig.color} />
        <span style={{ fontSize: "0.65rem", color: sig.color, fontFamily: "var(--font-mono)", fontWeight: 600 }}>{sig.conf}%</span>
      </div>
    </div>
  );
}

// ─── TOKEN ROW (collapsed) ────────────────────────────────────────────────────
function TokenRow({ token, index, onSelect, selected }) {
  const scored = scoreToken(token, token._metaBonus || 0, token._boostData);
  const rating = getRating(scored.total);
  const base = token.baseToken || {};
  const liq = parseFloat(token.liquidity?.usd || 0);
  const vol24 = parseFloat(token.volume?.h24 || 0);
  const mcap = parseFloat(token.marketCap || token.fdv || 0);
  const buys1h = token.txns?.h1?.buys || 0, sells1h = token.txns?.h1?.sells || 0;
  const tx1h = buys1h + sells1h;
  const buyPct = tx1h > 0 ? Math.round((buys1h / tx1h) * 100) : 50;
  const sig = classifyMomentum(token);
  const isOpen = selected === token.pairAddress;
  const tokenMetas = token._metas || [];
  const hasProfile = !!(token.info?.imageUrl || token.info?.websites?.length || token.info?.socials?.length);
  const dexUrl = `https://dexscreener.com/solana/${token.pairAddress}`;

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: isOpen ? "var(--surface2)" : "transparent",
      transition: "background 0.15s" }}>
      {/* MAIN ROW */}
      <div onClick={() => onSelect(isOpen ? null : token.pairAddress)}
        style={{ display: "grid", gridTemplateColumns: "28px 44px 1fr 90px 80px 80px 80px 80px 90px",
          alignItems: "center", gap: 0, padding: "0 12px", height: 52, cursor: "pointer",
          transition: "background 0.1s" }}
        onMouseEnter={e => e.currentTarget.style.background = "var(--hover)"}
        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>

        {/* Rank */}
        <span style={{ fontSize: "0.68rem", color: "var(--muted)", fontFamily: "var(--font-mono)", textAlign: "center" }}>
          {index + 1}
        </span>

        {/* Score ring */}
        <div style={{ display: "flex", justifyContent: "center" }}>
          <ScoreRing score={scored.total} rating={rating} />
        </div>

        {/* Name + tags */}
        <div style={{ paddingLeft: 10, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <div style={{ width: 3, height: 14, borderRadius: 1, background: rating.color, flexShrink: 0, boxShadow: `0 0 6px ${rating.color}` }} />
            <span style={{ fontSize: "0.88rem", fontWeight: 700, color: "var(--text)", letterSpacing: "0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {base.symbol || "?"}
            </span>
            <span style={{ fontSize: "0.7rem", color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 100 }}>
              {base.name || ""}
            </span>
            {scored.activeBoosts > 0 && <Tag color="#f0a500">⚡ {scored.activeBoosts}</Tag>}
            {hasProfile && <Tag color="var(--green)">✓</Tag>}
            {sig && <Tag color={sig.color} bg={sig.color + "15"}>{sig.icon} {sig.type}</Tag>}
          </div>
          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
            <span style={{ fontSize: "0.65rem", color: "var(--muted)" }}>{fmtAge(token.pairCreatedAt)} ago</span>
            {tokenMetas.slice(0,2).map(m => (
              <span key={m.slug} style={{ fontSize: "0.6rem", color: "var(--muted2)", background: "var(--surface3)", padding: "1px 5px", borderRadius: 2, fontFamily: "var(--font-mono)" }}>
                {m.name}
              </span>
            ))}
          </div>
        </div>

        {/* Price */}
        <div style={{ textAlign: "right", paddingRight: 8 }}>
          <div style={{ fontSize: "0.82rem", fontFamily: "var(--font-mono)", color: "var(--text)", fontWeight: 500 }}>
            ${fmtPrice(token.priceUsd)}
          </div>
        </div>

        {/* 5m */}
        <div style={{ textAlign: "right", paddingRight: 8 }}><Pct val={token.priceChange?.m5} /></div>
        {/* 1h */}
        <div style={{ textAlign: "right", paddingRight: 8 }}><Pct val={token.priceChange?.h1} /></div>
        {/* 6h */}
        <div style={{ textAlign: "right", paddingRight: 8 }}><Pct val={token.priceChange?.h6} /></div>
        {/* 24h */}
        <div style={{ textAlign: "right", paddingRight: 8 }}><Pct val={token.priceChange?.h24} /></div>

        {/* Liquidity + volume */}
        <div style={{ textAlign: "right", paddingRight: 4 }}>
          <div style={{ fontSize: "0.78rem", fontFamily: "var(--font-mono)", color: liq < 15000 ? "var(--red)" : "var(--text2)" }}>
            ${fmt(liq)}
          </div>
          <div style={{ fontSize: "0.65rem", fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
            ${fmt(vol24)}
          </div>
        </div>
      </div>

      {/* MOMENTUM PILL — always visible when signal exists */}
      {sig && <MomentumPill token={token} />}

      {/* EXPANDED PANEL */}
      {isOpen && (
        <div style={{ padding: "14px 16px", background: "var(--surface2)", borderTop: "1px solid var(--border)", animation: "expandIn 0.18s ease" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>

            {/* Score breakdown */}
            <div style={{ background: "var(--surface3)", borderRadius: 6, padding: 12, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: "0.62rem", color: "var(--muted)", letterSpacing: "0.1em", marginBottom: 10, fontFamily: "var(--font-mono)" }}>SCORE BREAKDOWN</div>
              {[
                { k: "liquidity",    l: "Liquidity Safety", c: rating.color },
                { k: "whaleSafety",  l: "Whale Safety",     c: "#00e5c3" },
                { k: "momentum",     l: "Momentum",         c: "#2ecc40" },
                { k: "buyPressure",  l: "Buy Pressure",     c: "#b8f542" },
                { k: "acceleration", l: "Acceleration",     c: "#f0a500" },
                { k: "priceAction",  l: "Price Action",     c: "#ff9f1c" },
                { k: "age",          l: "Pair Age",         c: "#7c83ff" },
                { k: "activity",     l: "Activity",         c: "#d67cff" },
              ].map(({ k, l, c }) => (
                <div key={k} style={{ marginBottom: 7 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ fontSize: "0.65rem", color: "var(--muted2)" }}>{l}</span>
                    <span style={{ fontSize: "0.65rem", color: c, fontFamily: "var(--font-mono)", fontWeight: 600 }}>{scored.breakdown[k] || 0}</span>
                  </div>
                  <div style={{ height: 3, background: "var(--border)", borderRadius: 2 }}>
                    <div style={{ height: "100%", width: `${scored.breakdown[k]||0}%`, background: c, borderRadius: 2, boxShadow: `0 0 4px ${c}66`, transition: "width 0.8s ease" }} />
                  </div>
                </div>
              ))}
            </div>

            {/* Risk flags */}
            <div style={{ background: "var(--surface3)", borderRadius: 6, padding: 12, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: "0.62rem", color: "var(--muted)", letterSpacing: "0.1em", marginBottom: 10, fontFamily: "var(--font-mono)" }}>SIGNALS & FLAGS</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {scored.total >= 80 && <Flag type="pos" text="High-conviction opportunity" />}
                {scored.activeBoosts > 0 && <Flag type="warn" text={`${scored.activeBoosts} active DexScreener boost(s)`} />}
                {hasProfile && <Flag type="pos" text="Verified profile / socials" />}
                {buyPct >= 65 && <Flag type="pos" text={`Strong buy pressure — ${buyPct}% buys (1h)`} />}
                {token._metas?.length > 0 && <Flag type="info" text={`Meta: ${token._metas.map(m=>m.name).join(", ")}`} />}
                {parseFloat(token.priceChange?.m5||0) > 5 && <Flag type="info" text="5m price accelerating" />}
                {liq < 10000 && <Flag type="danger" text="Critical liquidity — rug risk" />}
                {liq < 25000 && liq >= 10000 && <Flag type="warn" text="Low liquidity — expect slippage" />}
                {mcap > 0 && liq/mcap < 0.005 && <Flag type="danger" text="Whale concentration detected" />}
                {parseFloat(token.priceChange?.h1||0) > 120 && <Flag type="warn" text="Parabolic 1h move — may be late" />}
                {parseFloat(token.priceChange?.h24||0) > 600 && <Flag type="danger" text="600%+ in 24h — likely exhausted" />}
                {tx1h < 10 && <Flag type="warn" text="Very low activity (1h)" />}
                {!hasProfile && <Flag type="neutral" text="No token profile / socials" />}
              </div>
            </div>

            {/* Stats + links */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Price changes table */}
              <div style={{ background: "var(--surface3)", borderRadius: 6, padding: 12, border: "1px solid var(--border)" }}>
                <div style={{ fontSize: "0.62rem", color: "var(--muted)", letterSpacing: "0.1em", marginBottom: 8, fontFamily: "var(--font-mono)" }}>PRICE CHANGES</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
                  {[["5m", token.priceChange?.m5], ["1h", token.priceChange?.h1], ["6h", token.priceChange?.h6], ["24h", token.priceChange?.h24]].map(([l,v]) => (
                    <div key={l} style={{ textAlign: "center", background: "var(--surface2)", borderRadius: 4, padding: "6px 4px" }}>
                      <div style={{ fontSize: "0.58rem", color: "var(--muted)", marginBottom: 3, fontFamily: "var(--font-mono)" }}>{l}</div>
                      <Pct val={v} size="sm" />
                    </div>
                  ))}
                </div>
              </div>

              {/* Key metrics */}
              <div style={{ background: "var(--surface3)", borderRadius: 6, padding: 12, border: "1px solid var(--border)" }}>
                <div style={{ fontSize: "0.62rem", color: "var(--muted)", letterSpacing: "0.1em", marginBottom: 8, fontFamily: "var(--font-mono)" }}>KEY METRICS</div>
                {[
                  ["Liquidity", "$"+fmt(liq), liq < 15000 ? "var(--red)" : "var(--text2)"],
                  ["Volume 24h", "$"+fmt(vol24), "var(--text2)"],
                  ["Market Cap", mcap ? "$"+fmt(mcap) : "—", "var(--text2)"],
                  ["Buy Ratio 1h", buyPct+"%", buyPct>=60?"var(--green)":buyPct<=40?"var(--red)":"var(--text2)"],
                  ["Pair Age", fmtAge(token.pairCreatedAt), "var(--text2)"],
                ].map(([k,v,c]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                    <span style={{ fontSize: "0.67rem", color: "var(--muted2)" }}>{k}</span>
                    <span style={{ fontSize: "0.72rem", fontFamily: "var(--font-mono)", color: c, fontWeight: 500 }}>{v}</span>
                  </div>
                ))}
              </div>

              {/* Socials + CTA */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(token.info?.websites?.length > 0 || token.info?.socials?.length > 0) && (
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {token.info.websites?.slice(0,1).map((w,i) => (
                      <a key={i} href={w.url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: "0.65rem", color: "#7c83ff", background: "#7c83ff18",
                          border: "1px solid #7c83ff33", borderRadius: 4, padding: "3px 8px", textDecoration: "none" }}>
                        🌐 Website
                      </a>
                    ))}
                    {token.info.socials?.slice(0,2).map((s,i) => (
                      <span key={i} style={{ fontSize: "0.65rem", color: "var(--muted2)", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 4, padding: "3px 8px" }}>
                        {s.platform}
                      </span>
                    ))}
                  </div>
                )}
                <a href={dexUrl} target="_blank" rel="noopener noreferrer"
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                    padding: "8px", background: rating.bg, border: `1px solid ${rating.color}44`,
                    borderRadius: 6, color: rating.color, textDecoration: "none",
                    fontSize: "0.72rem", fontFamily: "var(--font-mono)", fontWeight: 700, letterSpacing: "0.06em",
                    transition: "all 0.15s" }}>
                  VIEW ON DEXSCREENER ↗
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Flag({ type, text }) {
  const styles = {
    pos:     { color: "var(--green)",   bg: "#2ecc4012" },
    warn:    { color: "#f0a500",         bg: "#f0a50012" },
    danger:  { color: "var(--red)",      bg: "#ff386012" },
    info:    { color: "#7c83ff",         bg: "#7c83ff12" },
    neutral: { color: "var(--muted)",    bg: "var(--surface2)" },
  };
  const s = styles[type] || styles.neutral;
  const icons = { pos: "●", warn: "◆", danger: "▲", info: "◈", neutral: "○" };
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "4px 7px",
      background: s.bg, borderRadius: 4, border: `1px solid ${s.color}22` }}>
      <span style={{ fontSize: "0.6rem", color: s.color, marginTop: 1, flexShrink: 0 }}>{icons[type]}</span>
      <span style={{ fontSize: "0.67rem", color: "var(--text2)", lineHeight: 1.4 }}>{text}</span>
    </div>
  );
}

// ─── TABLE HEADER ─────────────────────────────────────────────────────────────
function TableHeader({ sortBy, setSortBy }) {
  const cols = [
    { key: null,        label: "#",       style: { width: 28 } },
    { key: null,        label: "SCORE",   style: { width: 44 } },
    { key: null,        label: "TOKEN",   style: { flex: 1, paddingLeft: 20 } },
    { key: null,        label: "PRICE",   style: { width: 90, textAlign: "right", paddingRight: 8 } },
    { key: "momentum5m",label: "5M",      style: { width: 80, textAlign: "right", paddingRight: 8 } },
    { key: "momentum",  label: "1H",      style: { width: 80, textAlign: "right", paddingRight: 8 } },
    { key: null,        label: "6H",      style: { width: 80, textAlign: "right", paddingRight: 8 } },
    { key: null,        label: "24H",     style: { width: 80, textAlign: "right", paddingRight: 8 } },
    { key: "liquidity", label: "LIQ / VOL", style: { width: 90, textAlign: "right", paddingRight: 4 } },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "28px 44px 1fr 90px 80px 80px 80px 80px 90px",
      alignItems: "center", gap: 0, padding: "0 12px", height: 32,
      borderBottom: "1px solid var(--border)", background: "var(--surface2)" }}>
      {cols.map((col, i) => (
        <div key={i} onClick={() => col.key && setSortBy(col.key)}
          style={{ ...col.style, fontSize: "0.62rem", color: sortBy === col.key ? "var(--accent)" : "var(--muted)",
            fontFamily: "var(--font-mono)", fontWeight: 600, letterSpacing: "0.08em",
            cursor: col.key ? "pointer" : "default",
            transition: "color 0.15s" }}>
          {col.label}{sortBy === col.key && " ↓"}
        </div>
      ))}
    </div>
  );
}

// ─── META CARD ────────────────────────────────────────────────────────────────
function MetaCard({ meta, onSelect, selected }) {
  const ch1 = parseFloat(meta.marketCapChange?.h1 || 0);
  const ch24 = parseFloat(meta.marketCapChange?.h24 || 0);
  const hot = ch1 > 5;
  const isSel = selected === meta.slug;
  return (
    <div onClick={() => onSelect(isSel ? null : meta.slug)} style={{
      background: isSel ? "var(--surface3)" : "var(--surface2)",
      border: `1px solid ${isSel ? "var(--accent)" : hot ? "#2ecc4033" : "var(--border)"}`,
      borderRadius: 6, padding: "10px 12px", cursor: "pointer", transition: "all 0.15s",
    }}>
      <div style={{ fontSize: "0.75rem", fontWeight: 600, color: hot ? "var(--green)" : "var(--text2)", marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}>
        {hot && <span style={{ fontSize: "0.6rem" }}>🔥</span>} {meta.name}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
        {[["1H", ch1], ["24H", ch24]].map(([l,v]) => (
          <div key={l}>
            <div style={{ fontSize: "0.55rem", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 1 }}>{l}</div>
            <Pct val={v} size="sm" />
          </div>
        ))}
        <div>
          <div style={{ fontSize: "0.55rem", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 1 }}>TOKENS</div>
          <span style={{ fontSize: "0.72rem", color: "var(--text2)", fontFamily: "var(--font-mono)" }}>{meta.tokenCount}</span>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function SolScanner() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const trading = useTrading();
  const [solBalance, setSolBalance] = useState(null);
  const [tradingOpen, setTradingOpen] = useState(true);

  // Fetch SOL balance whenever wallet connects or changes
  useEffect(() => {
    if (!publicKey || !connection) { setSolBalance(null); return; }
    const fetchBal = async () => {
      try {
        const lamports = await connection.getBalance(publicKey);
        setSolBalance(lamports / 1_000_000_000);
      } catch { setSolBalance(null); }
    };
    fetchBal();
    const id = setInterval(fetchBal, 30000);
    return () => clearInterval(id);
  }, [publicKey, connection]);
  const [tokens, setTokens] = useState([]);
  const [metas, setMetas] = useState([]);
  const [selectedMeta, setSelectedMeta] = useState(null);
  const [selectedToken, setSelectedToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scanLog, setScanLog] = useState([]);
  const [lastScan, setLastScan] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [sortBy, setSortBy] = useState("score");
  const [minScore, setMinScore] = useState(70);
  const [minLiq, setMinLiq] = useState(10000);
  const [maxAgeH, setMaxAgeH] = useState(72);
  const [activeTab, setActiveTab] = useState("launches");
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  const log = (msg, type = "info") => setScanLog(p => [...p.slice(-7), { msg, type, t: new Date().toLocaleTimeString() }]);

  const scan = useCallback(async () => {
    setLoading(true); setError(null); setScanLog([]);
    const allAddresses = new Set();
    const boostMap = {}, profileMap = {}, metaTokenMap = {};
    let metaData = [];
    try {
      log("Fetching trending metas…");
      try {
        const r = await fetch(`${API}/metas/trending/v1`);
        if (r.ok) {
          metaData = await r.json();
          if (!Array.isArray(metaData)) metaData = [];
          setMetas(metaData);
          log(`${metaData.length} metas`, "ok");
          const hot = [...metaData].sort((a,b)=>(b.marketCapChange?.h1||0)-(a.marketCapChange?.h1||0)).slice(0,6);
          for (const meta of hot) {
            try {
              const mr = await fetch(`${API}/metas/meta/v1/${meta.slug}`);
              if (mr.ok) {
                const md = await mr.json();
                (md.pairs||[]).filter(p=>p.chainId==="solana").forEach(p=>{
                  if (p.baseToken?.address) {
                    allAddresses.add(p.baseToken.address);
                    if (!metaTokenMap[p.baseToken.address]) metaTokenMap[p.baseToken.address]=[];
                    metaTokenMap[p.baseToken.address].push(meta);
                  }
                });
              }
            } catch {}
          }
          log("Meta pairs loaded","ok");
        }
      } catch { log("Metas failed","warn"); }

      log("Fetching boosts…");
      for (const endpoint of ["token-boosts/latest/v1","token-boosts/top/v1"]) {
        try {
          const r = await fetch(`${API}/${endpoint}`);
          if (r.ok) {
            const data = await r.json();
            const items = Array.isArray(data)?data:(data.data||[]);
            items.filter(t=>t.chainId==="solana").forEach(t=>{ allAddresses.add(t.tokenAddress); if (!boostMap[t.tokenAddress]) boostMap[t.tokenAddress]={amount:t.amount,totalAmount:t.totalAmount}; });
          }
        } catch {}
      }
      log(`${Object.keys(boostMap).length} boosted tokens`,"ok");

      log("Fetching profiles…");
      for (const endpoint of ["token-profiles/latest/v1","token-profiles/recent-updates/v1"]) {
        try {
          const r = await fetch(`${API}/${endpoint}`);
          if (r.ok) {
            const data = await r.json();
            const items = Array.isArray(data)?data:(data.data||[]);
            items.filter(t=>t.chainId==="solana").forEach(t=>{ allAddresses.add(t.tokenAddress); if (!profileMap[t.tokenAddress]) profileMap[t.tokenAddress]=t; });
          }
        } catch {}
      }
      log(`${Object.keys(profileMap).length} profiles`,"ok");

      try {
        const r = await fetch(`${API}/latest/dex/search?q=solana`);
        if (r.ok) { const data = await r.json(); (data.pairs||[]).filter(p=>p.chainId==="solana").forEach(p=>p.baseToken?.address&&allAddresses.add(p.baseToken.address)); }
      } catch {}

      const addrs = [...allAddresses].filter(Boolean);
      log(`Fetching ${addrs.length} token pairs…`);
      const batches = []; for (let i=0;i<addrs.length;i+=MAX_TOKENS_PER_BATCH) batches.push(addrs.slice(i,i+MAX_TOKENS_PER_BATCH));
      const allPairs = [];
      for (let i=0;i<batches.length;i++) {
        try {
          const r = await fetch(`${API}/tokens/v1/solana/${batches[i].join(",")}`);
          if (r.ok) { const data = await r.json(); allPairs.push(...(Array.isArray(data)?data:[])); }
          if (i<batches.length-1) await new Promise(res=>setTimeout(res,250));
        } catch {}
      }
      log(`${allPairs.length} pairs loaded`,"ok");

      const seen = new Set();
      const enriched = allPairs.filter(p=>{ if (!p.pairAddress||seen.has(p.pairAddress)||p.chainId!=="solana") return false; seen.add(p.pairAddress); return true; }).map(p=>{
        const addr = p.baseToken?.address;
        const tokenMetas = addr?(metaTokenMap[addr]||[]):[];
        const boostData = addr?boostMap[addr]:null;
        const profile = addr?profileMap[addr]:null;
        let metaBonus = 0;
        if (tokenMetas.length>0) { const best=tokenMetas.reduce((b,m)=>(m.marketCapChange?.h1||0)>(b.marketCapChange?.h1||0)?m:b,tokenMetas[0]); metaBonus=Math.min(10,Math.max(0,parseFloat(best.marketCapChange?.h1||0)*0.4)); }
        const enrichedInfo = {...p.info};
        if (profile?.links) {
          const websites=profile.links.filter(l=>!l.type&&l.url).map(l=>({url:l.url}));
          const socials=profile.links.filter(l=>l.type).map(l=>({platform:l.type,handle:l.label}));
          if (websites.length) enrichedInfo.websites=[...(enrichedInfo.websites||[]),...websites];
          if (socials.length) enrichedInfo.socials=[...(enrichedInfo.socials||[]),...socials];
        }
        return {...p,info:enrichedInfo,_metas:tokenMetas,_metaBonus:metaBonus,_boostData:boostData};
      });

      const now = Date.now();
      const filtered = enriched.filter(p=>{
        const liq=parseFloat(p.liquidity?.usd||0); const vol=parseFloat(p.volume?.h24||0);
        const ageH=p.pairCreatedAt?(now-p.pairCreatedAt)/3600000:9999;
        const sc=scoreToken(p,p._metaBonus||0,p._boostData).total;
        return liq>=minLiq&&liq<=3000000&&vol>=3000&&ageH>=0.25&&ageH<=maxAgeH&&sc>=minScore;
      });

      const scored = filtered.map(p=>({...p,_score:scoreToken(p,p._metaBonus||0,p._boostData).total}));
      scored.sort((a,b)=>{
        if (sortBy==="score") return b._score-a._score;
        if (sortBy==="newest") return (b.pairCreatedAt||0)-(a.pairCreatedAt||0);
        if (sortBy==="volume") return parseFloat(b.volume?.h24||0)-parseFloat(a.volume?.h24||0);
        if (sortBy==="liquidity") return parseFloat(b.liquidity?.usd||0)-parseFloat(a.liquidity?.usd||0);
        if (sortBy==="momentum") return parseFloat(b.priceChange?.h1||0)-parseFloat(a.priceChange?.h1||0);
        return b._score-a._score;
      });
      setTokens(scored.slice(0,40)); setLastScan(new Date());
      // Feed scored tokens into trade queue evaluator
      trading.checkAndQueue(scored.slice(0,40), classifyMomentum);
      log(`Done — ${scored.length} tokens`,"done");
    } catch (err) { setError(err.message); log("Scan failed","error"); }
    finally { setLoading(false); }
  }, [sortBy, minScore, minLiq, maxAgeH]);

  // The DexScreener trending scan only powers the legacy PAIRS/NARRATIVES market
  // view and the deprecated momentum entry. With launch-score entry it's dead weight,
  // so only run it when entrySource is "momentum" (or the user opens the PAIRS tab).
  const marketScanOn = (trading.settings.entrySource ?? "launch") === "momentum"
    || activeTab === "tokens" || activeTab === "metas";

  useEffect(() => { if (marketScanOn) scan(); }, [marketScanOn]);
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoRefresh && marketScanOn) timerRef.current = setInterval(scan, REFRESH_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [autoRefresh, scan, marketScanOn]);

  const displayTokens = selectedMeta ? tokens.filter(t=>(t._metas||[]).some(m=>m.slug===selectedMeta)) : tokens;
  const apexCount = tokens.filter(t=>t._score>=82).length;
  const primeCount = tokens.filter(t=>t._score>=70&&t._score<82).length;
  const avgScore = tokens.length ? Math.round(tokens.reduce((a,t)=>a+t._score,0)/tokens.length) : 0;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-sans)" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');

        :root {
          --bg:        #0e1117;
          --surface:   #13171f;
          --surface2:  #161b24;
          --surface3:  #1b2130;
          --border:    #1f2937;
          --hover:     #1a2030;
          --text:      #e2e8f0;
          --text2:     #94a3b8;
          --muted:     #475569;
          --muted2:    #64748b;
          --accent:    #00e5c3;
          --green:     #22c55e;
          --red:       #ef4444;
          --font-mono: 'IBM Plex Mono', 'Courier New', monospace;
          --font-sans: 'IBM Plex Sans', system-ui, sans-serif;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: var(--bg); }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
        a { color: inherit; text-decoration: none; }
        input[type=range] { accent-color: var(--accent); width: 100%; }
        select { font-family: var(--font-sans); outline: none; cursor: pointer; }
        button { font-family: var(--font-sans); cursor: pointer; }
        @keyframes expandIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
        @keyframes fadeIn   { from { opacity:0; } to { opacity:1; } }
        @keyframes spin     { to { transform:rotate(360deg); } }
        @keyframes pulse    { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
        @keyframes slideIn  { from{opacity:0;transform:translateX(-8px);} to{opacity:1;transform:none;} }
      `}</style>

      {/* ── TOP NAV ── */}
      <div style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 16px", height: 52,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>

          {/* Logo */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ position: "relative" }}>
              <div style={{ width: 30, height: 30, borderRadius: "50%",
                background: "linear-gradient(135deg, var(--accent), var(--green))",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "0.95em", fontWeight: 700, color: "#0e1117" }}>◎</div>
              {loading && <div style={{ position: "absolute", inset: -3, borderRadius: "50%",
                border: "2px solid var(--accent)", borderTopColor: "transparent",
                animation: "spin 0.7s linear infinite" }} />}
            </div>
            <div>
              <span style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--text)",
                fontFamily: "var(--font-mono)", letterSpacing: "0.12em" }}>SOL</span>
              <span style={{ fontSize: "0.9rem", fontWeight: 400, color: "var(--accent)",
                fontFamily: "var(--font-mono)", letterSpacing: "0.12em" }}>SCANNER</span>
            </div>
            {lastScan && !loading && (
              <span style={{ fontSize: "0.62rem", color: "var(--muted)", fontFamily: "var(--font-mono)",
                background: "var(--surface2)", padding: "3px 8px", borderRadius: 4,
                border: "1px solid var(--border)" }}>
                {lastScan.toLocaleTimeString()}
              </span>
            )}
            {loading && (
              <span style={{ fontSize: "0.62rem", color: "var(--accent)", fontFamily: "var(--font-mono)",
                animation: "pulse 1s infinite" }}>SCANNING…</span>
            )}
          </div>

          {/* Controls */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button onClick={() => setAutoRefresh(!autoRefresh)} style={{
              padding: "5px 10px", background: autoRefresh ? "#00e5c318" : "transparent",
              border: `1px solid ${autoRefresh ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 5, color: autoRefresh ? "var(--accent)" : "var(--muted)",
              fontSize: "0.65rem", fontFamily: "var(--font-mono)", letterSpacing: "0.06em",
            }}>{autoRefresh ? "● AUTO" : "○ AUTO"}</button>
            <button onClick={scan} disabled={loading} style={{
              padding: "5px 14px", background: loading ? "transparent" : "#00e5c318",
              border: `1px solid ${loading ? "var(--border)" : "var(--accent)"}`,
              borderRadius: 5, color: loading ? "var(--muted)" : "var(--accent)",
              fontSize: "0.65rem", fontFamily: "var(--font-mono)", fontWeight: 700, letterSpacing: "0.08em",
            }}>{loading ? "SCANNING" : "↺ SCAN"}</button>
            {trading.stats.queueCount > 0 && (
              <div style={{ display:"flex", alignItems:"center", gap:5, padding:"5px 10px",
                background:"#f0a50018", border:"1px solid #f0a50044", borderRadius:5 }}>
                <div style={{ width:6, height:6, borderRadius:"50%", background:"#f0a500",
                  boxShadow:"0 0 6px #f0a500", animation:"pulse 1s infinite" }}/>
                <span style={{ fontSize:"0.62rem", color:"#f0a500", fontFamily:"var(--font-mono)", fontWeight:700 }}>
                  {trading.stats.queueCount} QUEUED
                </span>
              </div>
            )}
            {trading.stats.openCount > 0 && (
              <div style={{ display:"flex", alignItems:"center", gap:5, padding:"5px 10px",
                background:"#00e5c318", border:"1px solid #00e5c344", borderRadius:5 }}>
                <div style={{ width:6, height:6, borderRadius:"50%", background:"#00e5c3",
                  boxShadow:"0 0 6px #00e5c3" }}/>
                <span style={{ fontSize:"0.62rem", color:"#00e5c3", fontFamily:"var(--font-mono)", fontWeight:700 }}>
                  {trading.stats.openCount} OPEN
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Scan log strip */}
        {scanLog.length > 0 && (
          <div style={{ borderTop: "1px solid var(--border)", padding: "4px 16px",
            display: "flex", gap: 4, flexWrap: "wrap", background: "var(--surface2)" }}>
            {scanLog.map((l,i) => (
              <span key={i} style={{ fontSize: "0.58rem", fontFamily: "var(--font-mono)",
                padding: "1px 6px", borderRadius: 3, border: "1px solid var(--border)",
                color: l.type==="ok"?"var(--green)":l.type==="done"?"var(--accent)":l.type==="warn"?"#f0a500":l.type==="error"?"var(--red)":"var(--muted)" }}>
                {l.t} {l.msg}
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "16px", display: "grid", gridTemplateColumns: "1fr 340px", gap: 16, alignItems: "start" }}>

        {/* ── LEFT: SCANNER ── */}
        <div>

        {/* ── STATS STRIP ── */}
        {tokens.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 16 }}>
            {[
              { l: "TOKENS FOUND",    v: tokens.length,   c: "var(--text2)" },
              { l: "APEX",            v: apexCount,        c: "#00e5c3" },
              { l: "PRIME",           v: primeCount,       c: "var(--green)" },
              { l: "AVG SCORE",       v: avgScore,         c: "#f0a500" },
              { l: "WITH SIGNAL",     v: tokens.filter(t=>classifyMomentum(t)).length, c: "#b8f542" },
              { l: "EARLY MOMENTUM",  v: tokens.filter(t=>classifyMomentum(t)?.type==="EARLY MOMENTUM").length, c: "#00e5c3" },
            ].map(s => (
              <div key={s.l} style={{ background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: 6, padding: "10px 14px", textAlign: "center" }}>
                <div style={{ fontSize: "1.25rem", fontWeight: 700, color: s.c,
                  fontFamily: "var(--font-mono)", lineHeight: 1 }}>{s.v}</div>
                <div style={{ fontSize: "0.58rem", color: "var(--muted)", letterSpacing: "0.08em",
                  marginTop: 4, fontFamily: "var(--font-mono)" }}>{s.l}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── TABS ── */}
        <div style={{ display: "flex", gap: 0, marginBottom: 0, borderBottom: "1px solid var(--border)" }}>
          {[["launches","◆ LAUNCHES (t=0)"],["tokens",`PAIRS (${displayTokens.length})`],["metas",`NARRATIVES (${metas.length})`],["filters","FILTERS"]].map(([id,label]) => (
            <button key={id} onClick={() => setActiveTab(id)} style={{
              padding: "9px 16px", background: "none", border: "none",
              borderBottom: `2px solid ${activeTab===id?"var(--accent)":"transparent"}`,
              color: activeTab===id?"var(--accent)":"var(--muted)",
              fontSize: "0.65rem", fontFamily: "var(--font-mono)", fontWeight: 600,
              letterSpacing: "0.1em", marginBottom: -1,
            }}>{label}</button>
          ))}
          {selectedMeta && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", paddingRight: 4 }}>
              <span style={{ fontSize: "0.65rem", color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
                FILTER: {metas.find(m=>m.slug===selectedMeta)?.name}
              </span>
              <button onClick={() => setSelectedMeta(null)} style={{
                background: "none", border: "none", color: "var(--muted)", fontSize: "0.8rem", padding: "0 4px" }}>✕</button>
            </div>
          )}
        </div>

        {/* ── LAUNCHES TAB (t=0 launch-score feed — the leading-signal entry brain) ── */}
        {activeTab === "launches" && <LaunchFeed trading={trading} />}

        {/* ── NARRATIVES TAB ── */}
        {activeTab === "metas" && (
          <div style={{ paddingTop: 16, animation: "fadeIn 0.2s ease" }}>
            <p style={{ fontSize: "0.68rem", color: "var(--muted2)", marginBottom: 14, lineHeight: 1.6 }}>
              Trending narrative categories from DexScreener. Click any to filter the pairs list. Hot narratives add bonus score to tokens within them.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px,1fr))", gap: 8 }}>
              {[...metas].sort((a,b)=>(b.marketCapChange?.h1||0)-(a.marketCapChange?.h1||0)).map(meta=>(
                <MetaCard key={meta.slug} meta={meta} onSelect={setSelectedMeta} selected={selectedMeta} />
              ))}
            </div>
            {metas.length===0&&!loading&&(
              <p style={{ textAlign:"center", padding:40, color:"var(--muted)", fontSize:"0.75rem" }}>No meta data — run a scan first</p>
            )}
          </div>
        )}

        {/* ── FILTERS TAB ── */}
        {activeTab === "filters" && (
          <div style={{ paddingTop: 16, animation: "fadeIn 0.2s ease" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12, maxWidth: 640 }}>
              {[
                { label: "Min Score", val: minScore, min:0, max:90, step:5, set:setMinScore, display: minScore },
                { label: "Min Liquidity", val: minLiq, min:5000, max:250000, step:5000, set:setMinLiq, display:"$"+fmt(minLiq) },
                { label: "Max Pair Age", val: maxAgeH, min:1, max:168, step:1, set:setMaxAgeH, display:maxAgeH+"h" },
              ].map(f=>(
                <div key={f.label} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:6, padding:14 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                    <span style={{ fontSize:"0.65rem", color:"var(--muted2)", fontFamily:"var(--font-mono)" }}>{f.label}</span>
                    <span style={{ fontSize:"0.65rem", color:"var(--accent)", fontFamily:"var(--font-mono)", fontWeight:600 }}>{f.display}</span>
                  </div>
                  <input type="range" min={f.min} max={f.max} step={f.step} value={f.val} onChange={e=>f.set(Number(e.target.value))} />
                </div>
              ))}
              <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:6, padding:14 }}>
                <div style={{ fontSize:"0.65rem", color:"var(--muted2)", fontFamily:"var(--font-mono)", marginBottom:8 }}>SORT BY</div>
                <select value={sortBy} onChange={e=>setSortBy(e.target.value)} style={{
                  width:"100%", background:"var(--surface2)", border:"1px solid var(--border)",
                  borderRadius:4, color:"var(--text2)", padding:"6px 8px", fontSize:"0.72rem" }}>
                  <option value="score">Opportunity Score</option>
                  <option value="newest">Newest Pairs</option>
                  <option value="volume">Volume 24h</option>
                  <option value="liquidity">Liquidity</option>
                  <option value="momentum">Price Change 1h</option>
                </select>
              </div>
            </div>
            <div style={{ marginTop:16, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:6, padding:14, maxWidth:640 }}>
              <div style={{ fontSize:"0.62rem", color:"var(--muted)", fontFamily:"var(--font-mono)", marginBottom:8, letterSpacing:"0.08em" }}>SCORE TIERS</div>
              <div style={{ display:"flex", gap:16, flexWrap:"wrap" }}>
                {[["APEX 82+","#00e5c3"],["PRIME 70+","#22c55e"],["STRONG 58+","#b8f542"],["WATCH 44+","#f0a500"],["RISKY <44","#ef4444"]].map(([l,c])=>(
                  <div key={l} style={{ display:"flex", alignItems:"center", gap:5 }}>
                    <div style={{ width:8, height:8, borderRadius:"50%", background:c, boxShadow:`0 0 5px ${c}` }} />
                    <span style={{ fontSize:"0.65rem", color:c, fontFamily:"var(--font-mono)" }}>{l}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── PAIRS TAB ── */}
        {activeTab === "tokens" && (
          <div style={{ animation: "fadeIn 0.2s ease" }}>
            {/* Quick sort */}
            <div style={{ display:"flex", alignItems:"center", gap:6, padding:"8px 0", borderBottom:"1px solid var(--border)" }}>
              {[["score","SCORE"],["newest","NEWEST"],["volume","VOL 24H"],["momentum","1H %"]].map(([v,l])=>(
                <button key={v} onClick={()=>setSortBy(v)} style={{
                  padding:"4px 10px", background:sortBy===v?"var(--surface3)":"transparent",
                  border:`1px solid ${sortBy===v?"var(--accent)":"var(--border)"}`,
                  borderRadius:4, color:sortBy===v?"var(--accent)":"var(--muted)",
                  fontSize:"0.62rem", fontFamily:"var(--font-mono)", letterSpacing:"0.06em",
                }}>{l}</button>
              ))}
              <span style={{ marginLeft:"auto", fontSize:"0.62rem", color:"var(--muted)", fontFamily:"var(--font-mono)" }}>
                {displayTokens.length} results
              </span>
            </div>

            {error && (
              <div style={{ margin:"12px 0", padding:12, background:"#ef444411", border:"1px solid #ef444433",
                borderRadius:6, fontSize:"0.72rem", color:"#ef9999" }}>⚠ {error}</div>
            )}

            {/* Table */}
            {displayTokens.length > 0 && (
              <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, overflow:"hidden", marginTop:12 }}>
                <TableHeader sortBy={sortBy} setSortBy={setSortBy} />
                {displayTokens.map((token,i) => (
                  <TokenRow key={token.pairAddress} token={token} index={i}
                    onSelect={setSelectedToken} selected={selectedToken} />
                ))}
              </div>
            )}

            {displayTokens.length===0&&!loading&&(
              <div style={{ textAlign:"center", padding:"60px 20px", color:"var(--muted)" }}>
                <div style={{ fontSize:"2rem", marginBottom:12, opacity:0.3 }}>◎</div>
                <div style={{ fontSize:"0.75rem", fontFamily:"var(--font-mono)" }}>
                  {tokens.length===0?"Press SCAN to load pairs":"No pairs match current filters"}
                </div>
              </div>
            )}

            {loading&&displayTokens.length===0&&(
              <div style={{ textAlign:"center", padding:"60px 20px" }}>
                <div style={{ fontSize:"2rem", color:"var(--accent)", animation:"pulse 1s infinite", marginBottom:12 }}>◎</div>
                <div style={{ fontSize:"0.72rem", color:"var(--muted)", fontFamily:"var(--font-mono)" }}>Scanning all feeds…</div>
              </div>
            )}

            {displayTokens.length > 0 && (
              <div style={{ textAlign:"center", fontSize:"0.58rem", color:"var(--border)",
                marginTop:20, fontFamily:"var(--font-mono)", letterSpacing:"0.06em" }}>
                DATA: DEXSCREENER PUBLIC API · NOT FINANCIAL ADVICE · DYOR
              </div>
            )}
          </div>
        )}
        </div>{/* end left scanner column */}

        {/* ── RIGHT: TRADING PANEL ── */}
        <div style={{ position: "sticky", top: 70 }}>
          <TradingPanel trading={trading} solBalance={solBalance} />
        </div>

      </div>
    </div>
  );
}
