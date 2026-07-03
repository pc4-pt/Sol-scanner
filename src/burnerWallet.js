// burnerWallet.js — optional low-friction signing for a dedicated BURNER wallet.
//
// Phantom's multi-click confirm flow is too slow for launch entries. A burner
// keypair held in memory signs transactions locally with NO popup, so a queued
// buy fires on one click. Trade-offs, stated plainly:
//   • Use a THROWAWAY wallet with only a little SOL — never your main wallet.
//   • The key lives in memory only (this tab). It is NOT persisted; a refresh
//     clears it and you re-enter it. That's deliberate — nothing is written to disk.
//   • Signing happens locally, exactly like Phantom would; the key never leaves
//     the browser. But any in-browser key is higher-risk than a hardware/extension
//     wallet, which is why this is opt-in and burner-only.
import { useState, useRef, useCallback, useEffect } from "react";
import { Keypair } from "@solana/web3.js";

// Minimal base58 decode (Bitcoin alphabet) so we don't add a dependency.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(str) {
  const map = {}; for (let i = 0; i < B58.length; i++) map[B58[i]] = i;
  const bytes = [];
  for (const ch of str) {
    const val = map[ch];
    if (val === undefined) throw new Error("invalid base58 character");
    let carry = val;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < str.length && str[k] === "1"; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

// Accept a Phantom-style base58 secret key OR a Solana-CLI JSON byte array.
function parseSecretKey(input) {
  const s = (input || "").trim();
  if (!s) throw new Error("empty key");
  const secret = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : b58decode(s);
  return Keypair.fromSecretKey(secret);
}

export function useBurner(connection) {
  const [active, setActive]   = useState(false);
  const [address, setAddress] = useState(null);
  const [balance, setBalance] = useState(null);
  const [error, setError]     = useState(null);
  const kpRef = useRef(null);

  const setKey = useCallback((input) => {
    try {
      const kp = parseSecretKey(input);
      kpRef.current = kp;
      setAddress(kp.publicKey.toBase58());
      setActive(true); setError(null);
    } catch {
      kpRef.current = null; setAddress(null); setActive(false);
      setError("Invalid private key (expected base58 or JSON byte array)");
    }
  }, []);

  const clear = useCallback(() => {
    kpRef.current = null; setActive(false); setAddress(null); setBalance(null); setError(null);
  }, []);

  // Signs a VersionedTransaction locally — no wallet popup.
  const signTransaction = useCallback(async (tx) => {
    if (!kpRef.current) throw new Error("no burner key loaded");
    tx.sign([kpRef.current]);
    return tx;
  }, []);

  useEffect(() => {
    if (!active || !kpRef.current || !connection) return;
    let live = true;
    const poll = async () => {
      try { const b = await connection.getBalance(kpRef.current.publicKey);
            if (live) setBalance(b / 1e9); } catch { /* ignore */ }
    };
    poll();
    const iv = setInterval(poll, 15000);
    return () => { live = false; clearInterval(iv); };
  }, [active, connection]);

  return {
    active, address, balance, error, setKey, clear, signTransaction,
    publicKey: active && kpRef.current ? kpRef.current.publicKey : null,
  };
}
