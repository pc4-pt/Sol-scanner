// pumpStream.js — live PumpPortal feed (free, no key): token creations + migrations.
//
// Maintains the creator track record in the browser (persisted), scores every new
// launch at t=0, and exposes a ranked live feed. Migrations (graduations) flow back
// into the creator history so the track-record signal sharpens over time.
//
// Free stream gives subscribeNewToken + subscribeMigration. Trades (subscribeTokenTrade)
// require a funded key and are NOT needed for the launch-score signal.

import { useEffect, useRef, useState, useCallback } from "react";
import { CreatorHistory, launchScore } from "./launchScore.js";

const URL = "wss://pumpportal.fun/api/data";

// Framework-agnostic engine: connect, score, callback. UI subscribes via the hook.
export function createPumpStream({ onLaunch, onMigration, onStatus }) {
  let ws = null, stop = false, retry = 0;
  const history = new CreatorHistory();

  function connect() {
    if (stop) return;
    onStatus?.("connecting");
    ws = new WebSocket(URL);

    ws.onopen = () => {
      retry = 0;
      onStatus?.("live");
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
    };

    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.message) return;                       // subscription ack / notice
      const tx = (m.txType || m.type || "").toLowerCase();

      if (tx === "create" && m.mint && m.traderPublicKey) {
        const prior = history.priorFor(m.traderPublicKey); // BEFORE recording (leak-free)
        const scored = launchScore(m, prior);
        history.recordCreate(m.mint, m.traderPublicKey);
        onLaunch?.({
          mint: m.mint,
          creator: m.traderPublicKey,
          symbol: m.symbol || "?",
          name: m.name || "",
          devSol: Number(m.solAmount) || 0,
          marketCapSol: Number(m.marketCapSol) || 0,
          vSol: Number(m.vSolInBondingCurve) || 0,
          vTokens: Number(m.vTokensInBondingCurve) || 0,
          // bonding-curve price at creation, in SOL per token (reserves ratio)
          priceSol: Number(m.vTokensInBondingCurve) > 0
            ? Number(m.vSolInBondingCurve) / Number(m.vTokensInBondingCurve) : 0,
          isMayhem: !!m.is_mayhem_mode,
          pool: m.pool || "pump",
          ts: Date.now(),
          ...scored,
        });
      } else if (tx.includes("migrat") && m.mint) {
        history.recordMigration(m.mint);
        onMigration?.({ mint: m.mint, ts: Date.now() });
      }
    };

    ws.onclose = () => {
      if (stop) return;
      onStatus?.("reconnecting");
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 1000 * retry);           // backoff up to 6s
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  connect();
  return {
    history,
    close() { stop = true; try { ws && ws.close(); } catch {} },
  };
}

// React hook: returns the ranked live launch feed + connection status + history stats.
// minScore filters the feed; keep caps the list length.
export function useLaunchStream({ enabled = true, minScore = 0, keep = 60 } = {}) {
  const [launches, setLaunches] = useState([]);
  const [status, setStatus]     = useState("idle");
  const [stats, setStats]       = useState({ creators: 0, grads: 0, mints: 0 });
  const [migrations, setMigrations] = useState(0);
  const engineRef = useRef(null);
  const minRef = useRef(minScore);
  useEffect(() => { minRef.current = minScore; }, [minScore]);

  useEffect(() => {
    if (!enabled) { setStatus("off"); return; }
    const engine = createPumpStream({
      onLaunch: (l) => {
        if (l.score < minRef.current) return;
        setLaunches((prev) => [l, ...prev].slice(0, keep));
        setStats(engine.history.stats());
      },
      onMigration: () => {
        setMigrations((n) => n + 1);
        setStats(engine.history.stats());
        // mark any visible launch for this mint as graduated
      },
      onStatus: setStatus,
    });
    engineRef.current = engine;
    setStats(engine.history.stats());
    return () => engine.close();
  }, [enabled, keep]);

  const clear = useCallback(() => setLaunches([]), []);
  return { launches, status, stats, migrations, clear };
}
