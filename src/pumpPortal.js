// pumpPortal.js — native pump.fun bonding-curve execution via PumpPortal's Local API.
//
// Fixes the stuck-sell problem: Jupiter routes bonding-curve tokens unreliably, so
// sells on fresh pre-migration tokens fail. PumpPortal trades directly on the curve
// (pool "auto" picks the right venue), so buy and sell always use the same venue and
// positions can't get orphaned. We fetch an UNSIGNED transaction, sign it locally with
// the loaded keypair (no custody handover), and broadcast it ourselves.
import { VersionedTransaction } from "@solana/web3.js";

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
    err = r?.value?.err || null;
    confirmed = !err;
  } catch (e) {
    err = e.message;   // timed out or RPC hiccup — sig may still be valid
  }
  return { sig, confirmed, err };
}
