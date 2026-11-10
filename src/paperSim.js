// ── PAPER EXECUTION ──────────────────────────────────────────────────────────────
// Paper mode runs the WHOLE live pipeline — queue, auto-buy rails, entry gates,
// monitor, TP verification, exits, lifecycle logging — and replaces only the two
// on-chain transactions with a fill simulated against the real bonding curve.
//
// Design rules, so paper results are comparable with live ones:
//  1. Fills are priced from an on-chain curve read taken AFTER a simulated landing
//     delay, not from the decision price. Price moves between decision and fill are
//     therefore paid, as they are live.
//  2. Fees match what live trades actually paid (09-17: sol_over_stake median 0.00343 =
//     1.25% curve fee + 0.00204 rent + ~0.00014 network/priority).
//  3. A buy whose fill would exceed the slippage tolerance FAILS, as live does. A buy on
//     a graduated curve fails (live sells/buys there are a different venue).
//  4. Sells on a graduated token are priced from the feed with a PumpSwap fee and are
//     flagged sim_venue=feed — weaker than a curve fill and reported separately.
//  5. Nothing here signs, sends or reads the wallet.
//
// What paper CANNOT capture, and why live trading is still the final test:
//  - transactions that never land / land late under congestion (~20% fail rate on
//    Solana overall), and the priority-fee auction;
//  - our own price impact feeding back into other bots' behaviour;
//  - MEV / sandwiching (Jito bundles) on the buy;
//  - wallet- and RPC-specific failures.

export const PAPER_CFG = {
  curveFeePct:   1.25,         // pump.fun bonding curve, per side (protocol + creator)
  ammFeePct:     1.0,          // PumpSwap after graduation (approximate, conservative)
  rentSol:       0.00203928,   // ATA rent deposit, paid on buy, refunded after sell
  netFeeSol:     0.00014,      // base + priority fee per tx, as measured live
  // decision → landed. Drawn per fill from the exit latencies actually measured on the
  // 16 live trades of 2026-10-07/08 (exit_latency_ms), so paper pays the same delay
  // spread live did — including the ~3-4s tail where fast reversals cost the most.
  latencySampleMs: [960, 980, 1056, 1158, 1254, 1328, 1333, 1553, 2210, 2362, 2385, 2615, 2768, 2775, 2904, 3927],
  latencyMs: null,             // set a number to force a fixed delay (tests)
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function latency() {
  if (PAPER_CFG.latencyMs != null) return PAPER_CFG.latencyMs;
  const a = PAPER_CFG.latencySampleMs;
  return a[Math.floor(Math.random() * a.length)];
}
const TOKEN_DECIMALS = 1e6;    // pump.fun mints: 6 decimals; curve reserves are raw units

// tokens (whole) bought for solIn going INTO the curve
export function curveTokensOut(cs, solIn) {
  const x = cs.virtualSolReserves, y = cs.virtualTokenReserves;
  if (!(x > 0) || !(y > 0) || !(solIn > 0)) return 0;
  return (y - (x * y) / (x + solIn)) / TOKEN_DECIMALS;
}
// SOL out (before fee) for selling `tokens` (whole) back to the curve
export function curveSolOut(cs, tokens) {
  const x = cs.virtualSolReserves, y = cs.virtualTokenReserves;
  const dy = tokens * TOKEN_DECIMALS;
  if (!(x > 0) || !(y > 0) || !(dy > 0)) return 0;
  return x - (x * y) / (y + dy);
}
export const curvePrice = (cs) => cs.virtualSolReserves / cs.virtualTokenReserves; // SOL per raw unit

// Simulated buy. decisionCurve = SOL-per-raw-unit price at the decision (pre-buy read).
export async function simulateBuy({ connection, getBondingCurveState, mint, stakeSOL, slippagePct, decisionCurve }) {
  const lat = latency(); await sleep(lat);
  let cs = null;
  try { cs = await getBondingCurveState(connection, mint); } catch { /* handled below */ }
  if (!cs || !(cs.virtualTokenReserves > 0)) return { confirmed: false, err: "paper: curve unreadable" };
  if (cs.complete) return { confirmed: false, err: "paper: curve complete (graduated)" };
  const tokens = curveTokensOut(cs, stakeSOL);
  const avgFill = (stakeSOL / (tokens * TOKEN_DECIMALS));              // SOL per raw unit, incl. impact
  const fillMovePct = decisionCurve > 0 ? ((avgFill - decisionCurve) / decisionCurve) * 100 : 0;
  if (decisionCurve > 0 && fillMovePct > (slippagePct ?? 5)) {
    return { confirmed: false, err: `paper: slippage exceeded (+${fillMovePct.toFixed(1)}% > ${slippagePct}%)`,
             sim_fill_move_pct: fillMovePct };
  }
  const spent = stakeSOL * (1 + PAPER_CFG.curveFeePct / 100) + PAPER_CFG.rentSol + PAPER_CFG.netFeeSol;
  return {
    confirmed: true, sig: `PAPER-${Date.now().toString(36)}`,
    tokensReceived: tokens, actualSolSpent: spent,
    sim_venue: "curve", sim_fill_move_pct: +fillMovePct.toFixed(3), sim_latency_ms: lat, fillCurve: cs,
  };
}

// Simulated sell of `fraction` of `tokensHeld`. solUsd needed only for the feed path.
export async function simulateSell({ connection, getBondingCurveState, fetchTokenActivity, mint,
                                     tokensHeld, fraction = 1, solUsd }) {
  const lat = latency(); await sleep(lat);
  const tokens = (tokensHeld || 0) * fraction;
  if (!(tokens > 0)) return { confirmed: false, err: "paper: no tokens held" };
  let cs = null;
  try { cs = await getBondingCurveState(connection, mint); } catch { /* fall through */ }
  if (cs && !cs.complete && cs.virtualTokenReserves > 0) {
    const gross = curveSolOut(cs, tokens);
    const net = gross * (1 - PAPER_CFG.curveFeePct / 100) - PAPER_CFG.netFeeSol;
    return { confirmed: true, sig: `PAPER-${Date.now().toString(36)}`, solReceived: Math.max(net, 0),
             sim_venue: "curve", sim_latency_ms: lat, slippageUsed: 0, attempts: "paper:curve" };
  }
  // graduated (or curve unreadable): price from the feed, PumpSwap fee
  let act = null;
  try { act = await fetchTokenActivity(mint); } catch { /* none */ }
  if (act?.priceUsd > 0 && solUsd > 0) {
    const gross = (tokens * act.priceUsd) / solUsd;
    const net = gross * (1 - PAPER_CFG.ammFeePct / 100) - PAPER_CFG.netFeeSol;
    return { confirmed: true, sig: `PAPER-${Date.now().toString(36)}`, solReceived: Math.max(net, 0),
             sim_venue: "feed", sim_latency_ms: lat, slippageUsed: 0, attempts: "paper:feed" };
  }
  return { confirmed: false, err: "paper: no price to fill sell", attempts: "paper:none" };
}
