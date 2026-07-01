# Launch-score integration — what changed and why

This wires the **t=0 launch-score** signal (validated in the sol-early-signal research)
into the scanner as the new entry brain, and demotes the DexScreener momentum signals
that the same research falsified. Safety, execution, exits, and notifications are
unchanged.

## TL;DR workflow
1. Run `launch_score.py` on your real `creator_dataset.csv`, then replace
   `src/launchModel.json` with the produced `data/launch_score_model.json`.
   (Ships with placeholder, direction-correct coefficients so it works immediately,
   but it's not calibrated to your data until you swap the file.)
2. `npm install && npm run dev`. Open the **◆ LAUNCHES (t=0)** tab (now the default).
3. Let it stream. The creator track record builds live (persisted to localStorage) and
   graduations feed back in, so scores sharpen over time.
4. Leave `launchAutoQueue` OFF and `autoExecute` OFF at first — queue a few by hand,
   watch them through the existing position/exit flow, and confirm they actually make
   money on *your* entry before letting it size real trades.

## New files
- `src/launchModel.json` — model coefficients (replace with your real export).
- `src/launchScore.js` — the scoring function + a persistent `CreatorHistory` store
  (creator → launches/graduations, and recent mint → creator for attributing migrations).
- `src/pumpStream.js` — free PumpPortal WebSocket client (creations + migrations, no
  key, no Helius) and the `useLaunchStream` React hook. Auto-reconnects.
- `src/LaunchFeed.jsx` — the LAUNCHES tab: ranked live launches, score/dev-buy/creator
  columns, min-score slider, auto-queue toggle, and a per-row QUEUE button.

## Changed files
- `tradingEngine.js` → `DEFAULT_TRADE_SETTINGS`: added `entrySource` ("launch" default),
  `minLaunchScore`, `launchAutoQueue`; annotated the legacy momentum gates as deprecated.
- `useTrading.js`: launch items are excluded from the momentum prune; the momentum
  auto-queue now only runs when `entrySource === "momentum"`; added `addLaunchToQueue`
  (builds a queue-compatible token from a launch event and runs the same RugCheck gate).
- `App.jsx`: imports + renders `LaunchFeed`; LAUNCHES is the default tab.

## What this thread's testing kept / demoted / stripped

**Kept (not alpha, or never falsified):**
- RugCheck safety (`safety.js`) — protection against scams/honeypots. Still gates every
  launch entry.
- Trailing take-profit, adaptive stop-loss, break-even (`tradingEngine.js` exits) — exit
  logic was never part of what got falsified, and matters more than ever.
- Jupiter execution, position management, sizing/cooldown, notifications.

**Demoted to "market view only" (no leading edge as entry alpha):**
- `scoreToken` / `classifyMomentum` (vol/liq ratio, buy pressure, acceleration, price
  action) — research showed ~0.5 AUC for predicting a price move from entry, and for
  graduation they collapse to early volume, which is mechanical and late. They still
  render on the PAIRS tab as a market view, but no longer drive entries by default.

**Stripped from the entry path:**
- The two-scan confirmation (`confirmScans`) — waiting for a second sighting *is* the
  too-late mechanism. The launch path acts at t=0, so it bypasses this entirely.
- The momentum auto-queue — off unless you set `entrySource: "momentum"`.

## Honest caveats (read before going live)
- **The score predicts GRADUATION, not your P&L.** Graduation means the bonding curve
  completed, not that you profit entering at launch — and a dev can fund a big initial
  buy to fake commitment then dump. Validate that high-score launches actually return on
  a realistic entry/exit before trusting the score with size. That's the paper-first step.
- **Execution at t=0 is a different mechanism.** A brand-new bonding-curve token may not
  be routable via Jupiter until it has some liquidity, so a QUEUE'd launch buy can fail to
  route if fired too early. This is still far earlier than the old "second wave" entries.
  True instant t=0 execution would need pump.fun's program / PumpPortal's trade API
  (a key funded with ≥0.02 SOL) — a separate execution path, not wired here yet.
- **Placeholder model.** Until you swap in `launch_score_model.json` from your data, the
  scores rank sensibly but aren't calibrated; the LAUNCHES tab shows a warning banner.

## To revert
Set `entrySource: "momentum"` in settings to restore the old entry behaviour. All the
original momentum code is intact.

## Security note
`.env.example` contains what looks like a real Jupiter API key — rotate it and replace
with a placeholder before committing publicly.
