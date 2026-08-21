// pumpPortal.js — native pump.fun bonding-curve execution via PumpPortal's Local API.
//
// Fixes the stuck-sell problem: Jupiter routes bonding-curve tokens unreliably, so
// sells on fresh pre-migration tokens fail. PumpPortal trades directly on the curve
// (pool "auto" picks the right venue), so buy and sell always use the same venue and
// positions can't get orphaned. We fetch an UNSIGNED transaction, sign it locally with
// the loaded keypair (no custody handover), and broadcast it ourselves.
import { VersionedTransaction, PublicKey } from "@solana/web3.js";

// Real SOL balance (for measuring actual spend/receive on the curve, incl. slippage+fees)
export async function getSolBalance(connection, pubkey) {
  try { return (await connection.getBalance(pubkey)) / 1e9; } catch { return null; }
}
// Net SOL change for a wallet from a CONFIRMED transaction (positive = received).
// Read from the tx's pre/post balances — the ground truth, incl. fees — instead of
// racing live balance snapshots (which mis-measured and produced phantom -100% P&L).
export async function getTxSolDelta(connection, sig, pubkey) {
  if (!connection || !sig || !pubkey) return null;
  const target = pubkey.toString();
  for (let i = 0; i < 15; i++) {   // ~15s — reads the confirmed tx's balance delta; the
                                   // partial/final P&L depends on this, so give it more time
    try {
      const tx = await connection.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0, commitment: "confirmed",
      });
      if (tx?.meta) {
        const keys = tx.transaction.message.accountKeys.map(k => (k.pubkey || k).toString());
        const idx = keys.indexOf(target);
        if (idx >= 0) return (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
      }
    } catch { /* not indexed yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;   // caller falls back to an estimate
}

// Tokens actually received in THIS transaction, read from the tx's own token-balance
// meta. This is authoritative and settlement-safe, unlike a post-hoc wallet balance
// read: getTokenBalance() is a single RPC call fired the instant the buy confirms, and
// the token account frequently hasn't propagated yet. A low/zero read there inflates
// entryPrice (= solSpent x solUsd / tokensReceived), which then biases EVERY live P&L
// reading downward — trades look instantly red, peak never registers above 0, and the
// early stop fires on healthy positions. Read the delta from the tx instead.
export async function getTxTokenDelta(connection, sig, pubkey, mint) {
  if (!connection || !sig || !pubkey || !mint) return null;
  const owner = pubkey.toString();
  for (let i = 0; i < 15; i++) {
    try {
      const tx = await connection.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0, commitment: "confirmed",
      });
      if (tx?.meta) {
        const sum = (arr) => (arr || [])
          .filter(b => b.mint === mint && b.owner === owner)
          .reduce((a, b) => a + (b.uiTokenAmount?.uiAmount || 0), 0);
        const delta = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
        if (delta > 0) return delta;
      }
    } catch { /* not indexed yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;   // caller falls back to the balance read
}

// Total UI token balance held for a mint (to derive the real fill price)
export async function getTokenBalance(connection, pubkey, mint) {
  try {
    const res = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: new PublicKey(mint) });
    let total = 0;
    for (const acc of res.value) total += acc.account.data.parsed.info.tokenAmount.uiAmount || 0;
    return total;
  } catch { return 0; }
}

// Solana errors are often objects ({InstructionError:[1,{Custom:6002}]}). Stringify
// them or they surface as "[object Object]" and hide the real cause.
export function fmtErr(e) {
  if (e == null) return null;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ]);
}

// action: "buy" | "sell"
// amount: for buy, SOL amount (denominatedInSol=true); for sell, "100%" or token count
// onSig: called with the signature the instant it's broadcast, before confirmation
export async function pumpPortalTrade({
  publicKey, action, mint, amount, denominatedInSol,
  slippage = 15, priorityFee = 0.0001, pool = "auto",
  signTransaction, connection, onSig,
}) {
  const res = await fetch("/api/pump", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey, action, mint,
      amount, denominatedInSol: String(denominatedInSol),
      slippage, priorityFee, pool,
    }),
  });
  if (!res.ok) {
    let msg;
    try { msg = (await res.json()).error; } catch { msg = res.statusText; }
    throw new Error(`PumpPortal ${res.status}: ${msg}`);
  }
  const buf = await res.arrayBuffer();
  if (!buf || buf.byteLength === 0) throw new Error("PumpPortal returned an empty transaction");

  const tx = VersionedTransaction.deserialize(new Uint8Array(buf));
  const signed = await signTransaction(tx);            // local keypair signs — no popup, no custody

  // Broadcast WITHOUT preflight — PumpPortal already built a valid tx, and preflight
  // simulation against a slow RPC is what hangs. Get the signature out fast.
  const sig = await withTimeout(
    connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 3 }),
    20000, "broadcast",
  );
  onSig?.(sig);   // surface the link immediately, before we wait on confirmation

  // Confirm with a bounded wait so this never hangs the UI. A timeout here does NOT
  // mean the trade failed — the signature is live; check it on solscan.
  let confirmed = false, err = null;
  try {
    const latest = await connection.getLatestBlockhash();
    const r = await withTimeout(
      connection.confirmTransaction({ signature: sig, ...latest }, "confirmed"),
      35000, "confirmation",
    );
    err = fmtErr(r?.value?.err);   // on-chain errors are objects — stringify or they log as [object Object]
    confirmed = !err;
  } catch (e) {
    err = fmtErr(e?.message || e);   // timed out or RPC hiccup — sig may still be valid
  }
  return { sig, confirmed, err };
}
