// ─── tradingEngine.js ─────────────────────────────────────────────────────────
// Jupiter Swap API v1  (api.jup.ag/swap/v1)
// Routed through /api/quote and /api/swap (Vercel serverless)
// Uses Phantom-recommended signAndSendTransaction flow to minimise warnings.

import { VersionedTransaction, PublicKey } from "@solana/web3.js";

export const SOL_MINT      = "So11111111111111111111111111111111111111112";
export const PRICE_POLL_MS = 2000;   // 2s position polling (from 4s) — cuts reaction time on
                                     // fast collapses. Still bounded by DexScreener's own feed
                                     // lag; the real fix for that is the PumpPortal trade stream.

// ── Fetch actual on-chain token balance ────────────────────────────────────
// Critical for sells: the buy's quote.outAmount may differ from what actually
// landed in your wallet (transfer taxes, slippage on the buy, rounding).
// Always sell what you actually hold, not what you expected to receive.
export async function getTokenBalance(connection, ownerPubkey, tokenMint) {
  try {
    const owner = typeof ownerPubkey === "string" ? new PublicKey(ownerPubkey) : ownerPubkey;
    const mint  = typeof tokenMint   === "string" ? new PublicKey(tokenMint)   : tokenMint;

    // Find ALL token accounts owned by wallet for this mint (covers both
    // standard SPL and Token-2022 accounts, since they live in different programs)
    const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const token2022    = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

    let accounts = [];
    try {
      const r1 = await connection.getParsedTokenAccountsByOwner(owner, { mint, programId: tokenProgram });
      accounts = r1.value || [];
    } catch {}
    if (!accounts.length) {
      try {
        const r2 = await connection.getParsedTokenAccountsByOwner(owner, { mint, programId: token2022 });
        accounts = r2.value || [];
      } catch {}
    }

    if (!accounts.length) return 0;

    // Sum all account balances (usually just one, but defensive)
    let total = 0;
    for (const acc of accounts) {
      const amt = acc.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (amt) total += parseInt(amt, 10);
    }
    return total;
  } catch (err) {
    console.warn("[tradingEngine] getTokenBalance failed:", err.message);
    return null; // null = could not determine, caller should fall back
  }
}

// ── Step 1: GET /api/quote ────────────────────────────────────────────────────
// swapMode: "ExactIn" (default) is more forgiving on volatile tokens than ExactOut.
// For sells we always want ExactIn so we can specify "sell this many tokens" and
// accept whatever SOL we get back, rather than locking a target SOL amount.
// ── Jupiter quote rate limiter + priority queue ───────────────────────────────
// All quotes funnel through here so background probing (survival checks, pre-buy,
// queue activity) can't starve trade execution and trip 429s. Execution quotes are
// HIGH priority (jump the queue, retry hard through rate limits); background probes
// are LOW priority, yield to execution, and are dropped if the backlog gets large.
const _jupQ = { high: [], low: [] };
let _jupBusy = false, _jupLast = 0;
const JUP_MIN_INTERVAL = 400;   // ms between Jupiter calls (~2.5/s)
const JUP_LOW_CAP = 25;         // max queued background probes; oldest dropped beyond this

function _drainJup() {
  if (_jupBusy) return;
  const job = _jupQ.high.shift() || _jupQ.low.shift();
  if (!job) return;
  _jupBusy = true;
  const wait = Math.max(0, JUP_MIN_INTERVAL - (Date.now() - _jupLast));
  setTimeout(async () => {
    _jupLast = Date.now();
    try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
    finally { _jupBusy = false; _drainJup(); }
  }, wait);
}
function _enqueueJup(fn, priority) {
  return new Promise((resolve, reject) => {
    const q = _jupQ[priority];
    q.push({ fn, resolve, reject });
    if (priority === "low" && q.length > JUP_LOW_CAP) {
      const dropped = q.shift();
      dropped.reject(new Error("dropped (rate-limit backlog)"));
    }
    _drainJup();
  });
}
async function _rawQuote(params, retries) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`/api/quote?${params.toString()}`);
    if (res.status === 429) {
      if (attempt >= retries) throw new Error(`Jupiter quote failed (429): rate limited`);
      await new Promise(r => setTimeout(r, 500 * (2 ** attempt)));
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(`Jupiter quote failed (${res.status}): ${data?.error || JSON.stringify(data)}`);
    if (data.error) throw new Error(`Jupiter quote error: ${data.error}`);
    return data;
  }
}

// ── Sustained-momentum timing ─────────────────────────────────────────────────
// The first-seconds HOT flash is bot churn and un-catchable by a human. This judges
// momentum SUSTAINED across a window of samples instead of an instantaneous spike,
// so a "sustained" tag means the token has held buy pressure and price for long
// enough that a manual entry a few seconds later still lands in the move.
//   building — not enough history yet
//   sustained — held buy pressure + non-negative price across the window (ACTIONABLE)
//   steady   — positive but not strongly sustained
//   cooling  — activity tailing off
//   fading   — buy pressure gone or price rolling over
export function computeTiming(trend, {
  sustainSec = 90, minSamples = 4, upBP = 0.55, downBP = 0.45,
} = {}) {
  if (!trend || trend.length < minSamples) return "building";
  const last = trend[trend.length - 1];
  const recent = trend.filter((s) => last.ts - s.ts <= sustainSec * 1000);
  const w = recent.length >= minSamples ? recent : trend.slice(-minSamples);
  const bpOf = (s) => (s.trades > 0 ? s.buys / s.trades : 0.5);
  const avgBP = w.reduce((a, s) => a + bpOf(s), 0) / w.length;
  const priceChg = w[0].price > 0 ? (last.price - w[0].price) / w[0].price : 0;
  const tradesTrend = last.trades - w[0].trades;
  const span = last.ts - w[0].ts;
  if (avgBP < downBP || priceChg < -0.05) return "fading";
  if (avgBP >= upBP && priceChg >= 0 && span >= sustainSec * 1000 * 0.6) return "sustained";
  if (tradesTrend < 0) return "cooling";
  return "steady";
}



// ── Step 3: Simulate, then sign+send via Phantom ──────────────────────────────
// Uses Phantom's recommended signAndSendTransaction for best simulation support.
// Falls back to manual sendRawTransaction if provider method unavailable.
export async function signAndSend({ swapTransactionBase64, signTransaction, connection }) {
  // Decode base64 → VersionedTransaction (browser-safe, no Buffer)
  const binary = atob(swapTransactionBase64);
  const bytes  = Uint8Array.from(binary, c => c.charCodeAt(0));
  const tx     = VersionedTransaction.deserialize(bytes);

  // ── Pre-flight simulation (sigVerify: false as Phantom docs recommend) ──────
  // This catches failures before Phantom opens, preventing simulation warnings.
  try {
    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    if (sim.value.err) {
      const logs    = sim.value.logs?.join("\n") || "";
      const errStr  = JSON.stringify(sim.value.err);

      // Jupiter V6 aggregator error codes (from IDL):
      //   6001 (0x1771) — slippage tolerance exceeded
      //   6017          — exact-in amount not matched
      //   6024          — slippage tolerance exceeded (newer)
      //   6025          — exact-out amount not matched / not enough output
      // All are recoverable by widening slippage or fetching a fresh quote.
      const isSlippageCustom = /"Custom":(6001|6017|6024|6025|6026)/.test(errStr);
      const isSlippageLog    = logs.includes("SlippageToleranceExceeded") ||
                               logs.includes("Slippage tolerance") ||
                               logs.includes("ExactOutAmountNotMatched") ||
                               logs.includes("0x1771") ||
                               logs.includes("0x1779");

      if (logs.includes("insufficient funds") || logs.includes("insufficient lamports")) {
        throw new Error("Insufficient SOL balance for this trade (including fees).");
      }
      // Insufficient token balance — sell amount > what you actually hold
      if (logs.includes("Error: insufficient funds") ||
          logs.includes("0x1") && logs.includes("TokenAccount")) {
        throw new Error("INSUFFICIENT_TOKEN_BALANCE");
      }
      if (isSlippageCustom || isSlippageLog) {
        throw new Error("SLIPPAGE_EXCEEDED");
      }
      throw new Error(`Transaction simulation failed: ${errStr}\n${logs.slice(0, 200)}`);
    }
  } catch (err) {
    // Re-throw recognised errors so the caller can react
    if (err.message === "SLIPPAGE_EXCEEDED" ||
        err.message === "INSUFFICIENT_TOKEN_BALANCE" ||
        err.message.includes("Insufficient") ||
        err.message.includes("simulation failed")) {
      throw err;
    }
    // Simulation infra error (RPC issue etc) — log and proceed anyway
    console.warn("[tradingEngine] simulation skipped:", err.message);
  }

  // ── Sign and send ─────────────────────────────────────────────────────────
  // Phantom's signAndSendTransaction is preferred (better UX, fewer warnings).
  // Critical: if signAndSendTransaction returns a signature, we MUST NOT fall
  // back to manual sending — even if confirmation fails — or the same
  // transaction will be submitted twice and trigger "already processed" errors.
  const provider = window?.phantom?.solana || window?.solana;

  if (provider?.signAndSendTransaction) {
    let signature = null;
    try {
      const result = await provider.signAndSendTransaction(tx);
      signature = result.signature;
    } catch (err) {
      // User rejected — propagate immediately, don't fall through
      if (err.message?.includes("User rejected") ||
          err.message?.includes("rejected") ||
          err.code === 4001) {
        throw new Error("Transaction cancelled by user.");
      }
      // signAndSendTransaction itself failed before submission — safe to fall through
      console.warn("[tradingEngine] signAndSendTransaction failed before send, trying manual:", err.message);
    }

    // If we got a signature, the tx was submitted — do NOT fall through under any circumstances
    if (signature) {
      try {
        const latest = await connection.getLatestBlockhash("confirmed");
        const conf = await connection.confirmTransaction(
          { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
          "confirmed"
        );
        if (conf.value.err) {
          throw new Error(`Transaction failed on-chain: ${JSON.stringify(conf.value.err)}`);
        }
      } catch (confErr) {
        // Confirmation step failed but tx was submitted — check chain directly
        // before giving up, since the tx may have actually landed.
        console.warn("[tradingEngine] confirmation step failed, checking on-chain:", confErr.message);
        try {
          const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
          if (status?.value?.confirmationStatus === "confirmed" ||
              status?.value?.confirmationStatus === "finalized") {
            // Transaction did land — success
            return signature;
          }
        } catch {}
        // Genuinely failed — but DON'T re-submit, just report
        throw new Error(`Transaction sent but confirmation timed out (sig: ${signature.slice(0,8)}…). Check Solscan to see if it landed.`);
      }
      return signature;
    }
  }

  // ── Fallback: signTransaction + sendRawTransaction ─────────────────────────
  // Only reached if provider.signAndSendTransaction is unavailable OR it threw
  // before submitting the transaction.
  const signed = await signTransaction(tx);
  const rawTx  = signed.serialize();

  const sig = await connection.sendRawTransaction(rawTx, {
    skipPreflight:       false,
    maxRetries:          3,
    preflightCommitment: "confirmed",
  });

  const latest2 = await connection.getLatestBlockhash("confirmed");
  const result2 = await connection.confirmTransaction(
    { signature: sig, blockhash: latest2.blockhash, lastValidBlockHeight: latest2.lastValidBlockHeight },
    "confirmed"
  );
  if (result2.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(result2.value.err)}`);
  }
  return sig;
}



// ── Fetch current price from DexScreener ─────────────────────────────────────
export async function fetchCurrentPrice(tokenAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`);
    if (!res.ok) return null;
    const pairs = await res.json();
    if (!Array.isArray(pairs) || !pairs.length) return null;
    const best = pairs.sort(
      (a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0)
    )[0];
    return parseFloat(best.priceUsd || 0) || null;
  } catch { return null; }
}

// Cached SOL/USD (5 min). Used to price brand-new launch tokens in USD so their
// entry price is unit-consistent with the DexScreener USD prices used everywhere else.
let _solUsd = { v: 0, ts: 0 };
export async function getSolUsd() {
  if (_solUsd.v && Date.now() - _solUsd.ts < 300000) return _solUsd.v;
  const p = await fetchCurrentPrice(SOL_MINT);
  if (p) _solUsd = { v: p, ts: Date.now() };
  return _solUsd.v || 0;
}

// ── Live activity / momentum for a token (DexScreener) ────────────────────────
// Returns 5-minute trade count, price change, volume, liquidity, and the pair
// address (for inline charts). null until the token is listed with a pool.
export async function fetchTokenActivity(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
    if (!res.ok) return null;
    const pairs = await res.json();
    if (!Array.isArray(pairs) || !pairs.length) return null;
    const p = pairs.sort(
      (a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0)
    )[0];
    const t5 = p.txns?.m5 || {};
    const th1 = p.txns?.h1 || {};
    const buys5m  = parseInt(t5.buys  || 0) || 0;
    const sells5m = parseInt(t5.sells || 0) || 0;
    const buysH1  = parseInt(th1.buys  || 0) || 0;
    const sellsH1 = parseInt(th1.sells || 0) || 0;
    const socials  = p.info?.socials || [];
    const websites = p.info?.websites || [];
    return {
      pairAddress:   p.pairAddress || null,
      priceUsd:      parseFloat(p.priceUsd || 0) || 0,
      priceChange5m: parseFloat(p.priceChange?.m5 ?? 0) || 0,
      priceChangeH1: parseFloat(p.priceChange?.h1 ?? 0) || 0,
      buys5m, sells5m, trades5m: buys5m + sells5m,
      buysH1, sellsH1, tradesH1: buysH1 + sellsH1,
      vol5m:         parseFloat(p.volume?.m5 || 0) || 0,
      volH1:         parseFloat(p.volume?.h1 || 0) || 0,
      liq:           parseFloat(p.liquidity?.usd || 0) || 0,
      liqSol:        parseFloat(p.liquidity?.quote || 0) || 0,   // SOL side of the pool (usd is often empty for fresh pump pairs)
      liqBase:       parseFloat(p.liquidity?.base || 0) || 0,
      fdv:           parseFloat(p.fdv || 0) || 0,
      marketCap:     parseFloat(p.marketCap || 0) || 0,
      ageMin:        p.pairCreatedAt ? Math.round((Date.now() - p.pairCreatedAt) / 60000) : null,
      nPairs:        pairs.length,
      hasSocials:    socials.length > 0 ? 1 : 0,
      hasWebsite:    websites.length > 0 ? 1 : 0,
      boosts:        p.boosts?.active || 0,
    };
  } catch { return null; }
}

// ── PnL helpers ───────────────────────────────────────────────────────────────
export function calcPnl(position, currentPrice) {
  if (!position.entryPrice || !currentPrice) return null;
  const pct    = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  const solPnl = (position.solSpent || 0) * (pct / 100);
  return { pct: parseFloat(pct.toFixed(2)), solPnl: parseFloat(solPnl.toFixed(6)) };
}

// ── Volatility-aware stop loss ────────────────────────────────────────────────
// Maps the volatility metric from classifyMomentum to an SL percentage.
// Quiet token (vol < 5)   → use configured SL (e.g. 20%)
// Active token (vol 5-15) → SL = max(configured, 25%)
// Volatile (vol 15-30)    → SL = max(configured, 35%)
// Wild (vol > 30)         → SL = max(configured, 45%) - capped to avoid huge losses
// The user's configured SL acts as a FLOOR. We only widen it for volatile tokens,
// never tighten it, so the user's risk preference is always respected.
export function computeAdaptiveStopLoss(volatility, configuredSlPct) {
  const base = Math.abs(configuredSlPct || 20);
  if (!volatility || volatility < 5)  return base;
  if (volatility < 15) return Math.max(base, 25);
  if (volatility < 30) return Math.max(base, 35);
  return Math.max(base, 45);
}

// ── Should the position exit? ────────────────────────────────────────────────
// Exit logic priority order:
//   1. TAKE_PROFIT hit (fixed target) — unless trailing is active
//   2. TRAIL_STOP — if peak ≥ trailingActivateAt, exit when current is trailDrawdown% below peak
//   3. BREAK_EVEN_SL — if peak ≥ breakEvenAt, exit at scratch if back at entry
//   4. STOP_LOSS — standard SL, respects grace period
//
// When trailing is ENABLED and active (peak ≥ activate threshold), the fixed
// TAKE_PROFIT is disabled — we let winners run and only exit on the trailing rule.
// This is the asymmetric returns mechanic that makes memecoin trading profitable:
// one +200% trade pays for many -20% losses.
export function shouldTriggerExit(position, currentPrice, opts = {}) {
  const {
    gracePeriodMs        = 60000,
    breakEvenAt          = 5,
    trailingEnabled      = true,
    trailingActivateAt   = 18,    // start trailing once up this much
    trailDrawdownPct     = 10,    // exit when peak drops by this much (tightened from 15 —
                                  // 15 gave back far too much on volatile tokens)
  } = opts;

  if (!currentPrice || !position.entryPrice) return null;
  const pct    = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  const ageMs  = Date.now() - (position.openedAt || Date.now());
  const peak   = position.peakPnlPct || 0;
  const sl     = Math.abs(position.stopLossPct);
  const tp     = Math.abs(position.takeProfitPct);

  // Trailing take-profit
  const trailingActive = trailingEnabled && peak >= trailingActivateAt;
  if (trailingActive) {
    const dropFromPeak = peak - pct;
    if (dropFromPeak >= trailDrawdownPct) {
      return { reason: "TRAIL_STOP", pct, peak, dropFromPeak };
    }
    // While trailing is active, do NOT exit on fixed TP — let it run
    // But still allow break-even/SL to fire as risk floor
  } else {
    // Fixed TP only when trailing is not active (or disabled)
    if (pct >= tp) return { reason: "TAKE_PROFIT", pct };
  }

  // Break-even SL: once we've been up breakEvenAt%, treat entry as the SL floor.
  const breakEvenActive = peak >= breakEvenAt;

  // ── EARLY STOP for trades that NEVER went green ──────────────────────────
  // 08-06 data: STOP_LOSS trades averaged -40.7% (worst -77%) because a token that
  // dumps from entry rides the full grace window unprotected, then the -20% stop fills
  // into the crater. Those never-green trades are the account-killers (16/17 losers
  // never reached +20%). So if a trade has NOT been up to break-even AND is already
  // down past a tighter early-stop level, exit now — even inside grace. Winners (which
  // go green first, arming break-even) are untouched.
  const earlyStopPct     = Math.abs(opts.earlyStopPct ?? 12);
  const earlyStopGraceMs = (opts.earlyStopGraceSec ?? 8) * 1000;
  if (!breakEvenActive && ageMs >= earlyStopGraceMs && pct <= -earlyStopPct) {
    return { reason: "EARLY_STOP", pct };
  }

  // Grace period: skip SL if too new (but break-even can still trigger sooner)
  if (ageMs < gracePeriodMs && !breakEvenActive) return null;

  // Standard SL
  if (pct <= -sl) return { reason: "STOP_LOSS", pct };

  // Break-even SL
  if (breakEvenActive && pct <= 0) return { reason: "BREAK_EVEN_SL", pct };

  return null;
}

export const DEFAULT_TRADE_SETTINGS = {
  stakeSOL:           0.1,
  // ── Native execution (PumpPortal, sole path for launch trades) ───────────
  pumpSlippage:       5,          // 15 -> 5. With a +15% target, authorising fills up to 15%
                                  // worse than quote lets slippage eat the ENTIRE edge before
                                  // the trade starts. A missed buy costs nothing; a 15% overpay
                                  // costs the whole trade. Expect some buys to fail — that is
                                  // the point, and failures are now cheap information.         // percent slippage allowed on the bonding curve
  // Exit slippage ladder — capped at 25%. The old [15,25,40,60] ladder DID complete
  // exits, but filled so badly that a 20% stop realised −50 to −60%. Better to fail
  // an exit and retry than to dump at 60% slippage.
  sellSlippageLadder: [5, 10],    // was [15,25]. Exits were authorised to give up 15-25% — on a
                                  // +15% target that hands back the entire gain at the door.
                                  // Escalates 5% then 10%; graduated-token routing still falls
                                  // through pools, so a genuinely illiquid exit still completes.
  gradSellMaxRetries: 20,         // graduated tokens 400 transiently while migrating to
                                  // PumpSwap; keep auto-retrying the exit this many polls
                                  // before marking stuck (other failures give up after 3)
  pumpPriorityFee:    0.0001,     // SOL priority fee per trade
  // ── Entry headroom gate ──────────────────────────────────────────────────
  // Refuse buys where price has already run this far above the sustained trigger.
  entryHeadroomEnabled: true,
  maxEntryDragPct:      40,       // effectively inert at 30s (drag_at_ready median 0%, p90
                                  // 2.6% in the 233-row test) — set loose so it never
                                  // false-blocks a valid entry; kept only as a runaway guard
  // ── Sustained persistence gate ───────────────────────────────────────────
  // Token must hold sustained CONTINUOUSLY this long before it can be queued.
  // Data: fading inside 90s → 17-30% hit +20%; holding 90-300s → 60%.
  minSustainedAgeSec:   75,       // REVERTED 25 -> 75. The 25s change rested on a +0.87
                                  // correlation between entry slip and drag — but BOTH metrics
                                  // are computed from entryPrice, so an inflated entryPrice
                                  // moves them together automatically. Spurious by construction.
                                  // Clean paper data points the other way: tokens that had run
                                  // 20-50% before ready hit +15% at 50% vs 13% for 0-20%.
                                  // Held at 75 so the entry-price fix is the only changed variable.       // 75s gate (middle path). Persistence data: 90-180s tokens
                                  // hit +20% at 47% vs 11-27% under 90s. But 90s + the narrow
                                  // pcH1 band only passed 0.8% of tokens (zero flow for 24h), so
                                  // 75s trades a little persistence edge for workable flow.
  tpConfirmPolls:     2,          // require the TP target to hold for this many consecutive
                                  // polls (~2s each) before selling. Exit data showed profit
                                  // exits losing a median 11.5% to spike prints that vanished
                                  // before the tx was built. Loss cuts are NOT delayed by this.
  takeProfitPct:      15,         // HARD MODEST TARGET. 58% of filtered tokens reach +15% from
                                  // ready (median time-to-peak 322s, so minutes not seconds).
                                  // Take the reliable gain instead of holding for the tail.
                                  // fat tail (+100–325%) isn't capped; a low fixed TP would
                                  // clip the rare runners that carry the strategy's EV
  // ── Partial profit-taking — bank a chunk early, let the rest run ─────────
  // Latency-robust: a fixed target fires whenever ANY poll sees price above it, so you
  // lock in gains on the way UP instead of chasing the top on the way down.
  partialTpEnabled:   false,      // OFF for the modest-target test: the +35% partial trigger sits
                                  // above the +15% hard TP, so it can never fire. Kept off to keep
                                  // the experiment unambiguous — one exit mechanism, one reading.
  partialTpPct:       35,         // take partial profit once up this %
  partialTpFraction:  0.5,        // sell this fraction; trail the remainder
  stopLossPct:        15,         // tightened 20->15. Breakeven for this strategy is an AVERAGE
                                  // loss of -20.7%; live STOP_LOSS fills averaged -40% and would
                                  // sink it. Loss control is now the make-or-break variable.
  slippageBps:        200,
  maxPositions:       3,          // aligned with maxConcurrentPositions (was 5 vs 3 — two
                                  // different caps on the same thing, manual and auto paths
                                  // disagreeing). Same number now, whichever path opens it.
  // ── Entry source ────────────────────────────────────────────────────────
  // "launch"   = t=0 launch-score stream (PumpPortal). The validated LEADING signal.
  // "momentum" = legacy DexScreener momentum (DEPRECATED — no leading edge; fires
  //              on the second wave). Kept for reference/market-view only.
  // "off"      = no auto-entry; manual only.
  entrySource:        "launch",
  minLaunchScore:     55,         // show launches scoring >= this in the feed
  launchAutoQueue:    false,      // false = alert/watchlist only; you click to queue (paper-first)
  // ── Launch entry-quality gates (auto-queue path) — improve confidence, avoid dying tokens ──
  minExecScore:       68,         // auto-queue only launches scoring >= this (higher bar than display)
  minDevSol:          1.0,        // require the dev's own initial buy >= this many SOL (tiny buys die)
  blockTokenMills:    true,       // skip creators who've launched a lot and never graduated (spam factories)
  millMinLaunches:    5,          // "a lot" = this many prior launches with zero graduations
  // ── Honeypot / dead-liquidity guard (all buys) — KEPT ────────────────────
  preBuySellCheck:    true,       // simulate a sell-back before buying; block if unsellable
  minRoundTripRecovery: 0.7,      // block if a round trip recovers less than this fraction (tax/illiquid)
  // ── Survival-confirmation window (launch feed eligibility) ────────────────
  // Don't treat a launch as buyable at t=0. Wait this long, then re-check it's
  // still alive & sellable (same round-trip probe). Tokens that die in the first
  // minutes fail this and are flagged, not queued. Later than t=0, but still far
  // ahead of graduation.
  confirmWindowSec:   90,         // seconds after creation before eligibility is checked
  probeSol:           0.05,       // nominal SOL size used for the sellability probe
  // ── Momentum / activity gate — a token must be MOVING, not just sellable ──
  // Prevents single-trade "eligible" tokens with no real activity. Uses DexScreener
  // 5-minute trade count / price change. Tokens that are sellable but inactive are
  // flagged STAGNANT (not queueable); tokens down hard or drained are COLLAPSED.
  minTrades5m:        4,          // require at least this many trades in the last 5 min
  minLiqUsd:          400,        // liquidity floor; below this = collapsed/dead
  collapseDropPct:    40,         // 5-min price drop >= this% = collapsed
  // ── Legacy momentum gates (only used when entrySource === "momentum") ─────
  // DEPRECATED as entry alpha by the sol-early-signal research. Left in place so the
  // momentum view still renders, but they no longer drive entries by default.
  minScore:           70,
  minConfidence:      75,
  minVolLiqRatio:     2.0,
  requireMomentum:    true,
  confirmScans:       2,          // the "wait for a second sighting" gate = the too-late mechanism
  // ── Sizing ──────────────────────────────────────────────────────────────
  scaleByConfidence:  false,      // OFF for the test. Varying stake per trade makes per-trade
                                  // expectancy noisy and hard to attribute. Fixed stake = clean
                                  // reading of whether the edge is net-positive.
  cooldownMinutes:    30,
  autoExecute:        false,      // MASTER auto-buy toggle. When on, a newly-queued token
                                  // is bought automatically (subject to all rails below).
                                  // OFF by default — enable only with a small capped burner.
  // ── Auto-buy safety rails (only apply when autoExecute is on) ────────────
  autoBuyMinBurnerSOL: 0.05,      // never auto-buy if it would leave the burner below this —
                                  // bounds max spend to (balance - floor)
  maxConcurrentPositions: 3,      // never hold more than this many open auto-bought positions
  reclaimAccountRent: true,       // close the emptied token account after each sell to recover
                                  // its ~0.00204 SOL rent deposit (~87% of the per-trade fee).
                                  // Fires after the sell settles; never blocks the trade.
  autoBuySessionCapSOL: 2.0,      // 0.5 -> 2.0. At the old 0.01 stake this was 50 trades; at
                                  // 0.1 it was only 5, so the session halted every day or two
                                  // and looked like a fault. Sized for ~20 trades at 0.1 SOL.      // stop auto-buying after this much SOL spent this session
  autoBuyDailyLossKillSOL: 0.3,   // unchanged: at 0.1 SOL and ~12% typical losses this is
                                  // ~25 losing trades — a real circuit breaker, not a nuisance.   // halt auto-buy if today's realised loss exceeds this (kill switch)
  // ── Token safety (RugCheck) — KEPT: protection, not alpha ────────────────
  enableSafetyCheck:  true,
  maxRiskScore:       60,
  allowUnprofiled:    true,        // brand-new launches are often unprofiled on RugCheck
  blockHardFails:     true,
  blockHighOwnership: true,
  // ── Position management (Stage A + B) — KEPT ────────────────────────────
  adaptiveStopLoss:   false,      // OFF. computeAdaptiveStopLoss WIDENS the stop to 25/35/45%
                                  // for volatile tokens — and memecoins are always volatile, so
                                  // the effective stop was never 15%. Strategy breakeven is an
                                  // AVERAGE loss of -20.7%, so a 25-45% stop sinks it outright.
                                  // The configured stop must mean what it says.
  graceSec:           30,         // suppress the -20% price stop this long after entry, to
                                  // avoid getting stopped out by entry noise. Lowered from 60:
                                  // we now enter at the 30s sustained gate (more established
                                  // tokens), so a full minute unprotected is too long.
  reversalGraceSec:   12,         // the momentum-REVERSAL exit is a real dump signal, not
                                  // noise, so it gets a much shorter grace — it must be able
                                  // to catch a fast collapse inside the first minute
  // ── Early stop for trades that never go green (08-06 data) ───────────────
  earlyStopPct:       12,         // exit a red-from-entry trade at this loss, even in grace,
                                  // if it's never been up to break-even (caps the -40/-77% killers)
  earlyStopGraceSec:  8,          // …but give it this many seconds first, to avoid entry noise
  // ── Actionable-filter pcH1 ceiling — skip exhausted pumps ────────────────
  maxSustainPcH1:     999,        // ceiling effectively OFF. Re-ranked against the +15% target,
                                  // high pcH1 is NOT harmful: 150-250 hits 39% (2.04x) and 250+
                                  // still 32%. The old ceiling was cutting good candidates.
                                  // higher pcH1 isn't harmful; widening restores flow lost to
                                  // the 90s hold gate. Set high rather than removed as a guard.
  breakEvenAtPct:     5,
  // ── Trailing take-profit — KEPT: exit logic, never falsified ─────────────
  trailingEnabled:    false,      // OFF for the modest-target test. Trailing arms at +18%, above
                                  // the +15% TP; if a token GAPPED past 18% in one poll, trailing
                                  // would take over and suppress the TP. Off = TP always wins.
  trailingActivateAt: 18,         // start trailing at +18% — the paper median winner peaks
                                  // at +26%, so the old +30% activation missed most winners
                                  // (they peaked and faded before trailing ever engaged)
  trailDrawdownPct:   10,         // exit when peak drops by this % (tightened from 15 — real
                                  // trades gave back most of the peak at 15)
  // ── Fast momentum-reversal exit — beats the price stop on fast collapses ──
  momentumReversalExit: false,    // OFF for the test. It is a THIRD exit path competing with
                                  // the +15% TP and the early stop; if it fires first we can't
                                  // attribute the result. Re-enable once TP/SL is measured.
  reversalBpThreshold: 0.30,      // exit if buy-pressure ≤ this (≥70% of recent txns are sells)
  reversalPcThreshold: -8,        // …AND 5m price change ≤ this %
  reversalMinTrades:   8,         // require this many 5m trades so buy-pressure is meaningful
  // ── Momentum-fade sell signal (first-minutes rollover) ───────────────────
  momentumAutoExit:       false,  // false = show the FADING signal only; true = auto-sell on sustained fade
  momentumFadeBuyPressure: 0.42,  // buy pressure below this (with rollover) = fading
  // ── Sustained-momentum timing (not the un-catchable first-seconds flash) ──
  // Momentum must HOLD across this window to read "sustained" — the human-actionable
  // signal, since a manual entry a few seconds late still lands in a sustained move.
  sustainWindowSec:   90,         // momentum must hold this long to count as sustained
  minMomentumSamples: 4,          // minimum activity samples before judging timing
  minSustainScore:    60,         // only paper-track sustained tokens at/above this score (data showed <60 ≈ 5% hit the tail); set 0 to track all
  // Actionable filter (from the optimiser: non-mayhem + pcH1>=40 + volH1>=1500 → ~60%
  // hit-rate vs 17% baseline). Applied as a flag for auto-queue + feed marker; failing
  // tokens are still paper-tracked as a control group.
  minSustainPcH1:     75,         // floor 50->75: below 75 the hit rate sits at base (19-22%);
                                  // at 75+ it steps up sharply. Combined with vol>=15k this
                                  // gives 58% hit15 at ~17 candidates/day (flow verified).
                                  // 0.8% of tokens; 50/180/75s lands ~4-6/day. 70-150 remains the
                                  // sweet spot, so revisit tightening the floor if flow allows.
  minSustainVolH1:    15000,      // VOLUME IS THE DOMINANT SIGNAL for a modest-target strategy.
                                  // Pooled 4,096-token analysis vs "hits +15% from ready":
                                  //   volH1 <1.5k -> 10% hit (0.51x lift, 60% of the pool)
                                  //   volH1 5-15k -> 41% hit (2.14x)
                                  //   volH1 15-50k -> 57% hit (2.98x)
                                  // The old 1500 floor let through the bulk of dead tokens.
  // ── Notifications — KEPT ─────────────────────────────────────────────────
  notifyBrowser:      true,       // push notifications when tab is backgrounded
  notifySound:        true,       // play tone for queue/fill/exit/error events
  notifyTelegram:     false,      // route events to a personal Telegram bot
  telegramBotToken:   "",         // create via @BotFather on Telegram
  telegramChatId:     "",         // run "Get my chat ID" after messaging bot
  notifyOnQueue:      true,       // ping when token added to queue
  notifyOnFill:       true,       // ping when buy/sell completes
  notifyOnExit:       true,       // ping on auto-sell (TP/SL/trail)
  notifyOnError:      true,       // ping on trade failures
  notifyMinConf:      55,         // only ping for queue events at this score/conf or above
};
