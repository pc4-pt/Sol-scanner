// ─── TradingPanel.jsx ─────────────────────────────────────────────────────────
import { useState, useEffect } from "react";
import { isGraduated } from "./launchScore.js";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { QUEUE_SORT_OPTIONS, SIGNAL_PRIORITY } from "./useTrading.js";
import {
  requestBrowserPermission, browserPermissionStatus,
  playSound, sendTelegram, fetchTelegramChatId,
} from "./notifications.js";

const C = {
  bg:"#0e1117",surface:"#13171f",surface2:"#161b24",surface3:"#1b2130",
  border:"#1f2937",hover:"#1a2030",
  text:"#e2e8f0",text2:"#94a3b8",muted:"#475569",muted2:"#64748b",
  accent:"#00e5c3",green:"#22c55e",red:"#ef4444",warn:"#f0a500",info:"#7c83ff",
  mono:"'IBM Plex Mono','Courier New',monospace",
  sans:"'IBM Plex Sans',system-ui,sans-serif",
};

// ── Micro components ──────────────────────────────────────────────────────────
function Mono({ children, color, size="0.75rem", weight=500 }) {
  return <span style={{fontFamily:C.mono,fontSize:size,color:color||C.text2,fontWeight:weight}}>{children}</span>;
}

function Badge({ children, color=C.muted2 }) {
  return (
    <span style={{fontSize:"0.6rem",fontFamily:C.mono,fontWeight:600,color,
      background:color+"18",padding:"2px 7px",borderRadius:3,letterSpacing:"0.05em",whiteSpace:"nowrap"}}>
      {children}
    </span>
  );
}

function Btn({ children, onClick, disabled, variant="default", size="md", fullWidth=false }) {
  const V = {
    default:{bg:"transparent",  border:C.border,  color:C.text2},
    primary:{bg:C.accent+"18",  border:C.accent,  color:C.accent},
    success:{bg:C.green+"18",   border:C.green,   color:C.green},
    danger: {bg:C.red+"15",     border:C.red,     color:C.red},
    warn:   {bg:C.warn+"15",    border:C.warn,    color:C.warn},
    ghost:  {bg:"transparent",  border:"transparent",color:C.muted2},
  };
  const v = V[variant]||V.default;
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding:size==="sm"?"4px 10px":size==="lg"?"9px 22px":"5px 14px",
      background:disabled?"transparent":v.bg,
      border:`1px solid ${disabled?C.border:v.border}`,
      borderRadius:5,color:disabled?C.muted:v.color,
      fontSize:size==="sm"?"0.62rem":"0.68rem",
      fontFamily:C.mono,fontWeight:600,letterSpacing:"0.06em",
      cursor:disabled?"not-allowed":"pointer",transition:"all 0.15s",
      opacity:disabled?0.5:1,width:fullWidth?"100%":"auto",
    }}>{children}</button>
  );
}

function PnlBadge({ pct, sol }) {
  const pos = (pct||0)>=0;
  const color = pos?C.green:C.red;
  return (
    <div style={{textAlign:"right"}}>
      <div style={{fontSize:"0.82rem",fontFamily:C.mono,fontWeight:700,color}}>
        {pos?"+":""}{pct?.toFixed(2)}%
      </div>
      <div style={{fontSize:"0.65rem",fontFamily:C.mono,color:color+"bb"}}>
        {pos?"+":""}{sol?.toFixed(4)} SOL
      </div>
    </div>
  );
}

// ── Wallet bar ────────────────────────────────────────────────────────────────
function WalletBar({ connected, walletAddress, solBalance, burner }) {
  const { setVisible } = useWalletModal();
  const short = walletAddress
    ? walletAddress.slice(0,4)+"…"+walletAddress.slice(-4)
    : null;
  const burnerActive = burner?.active;
  const burnerShort = burner?.address
    ? burner.address.slice(0,4)+"…"+burner.address.slice(-4) : null;
  return (
    <div style={{display:"flex",flexDirection:"column",gap:0}}>
    {burnerActive && (
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"7px 14px",
        background:"#7c5cff18",borderBottom:`1px solid ${C.border}`}}>
        <span style={{fontSize:"0.62rem",color:"#b8a5ff",fontFamily:C.mono,fontWeight:700}}>⚡ BURNER (trades sign here)</span>
        <Mono color={C.text} size="0.68rem">{burnerShort}</Mono>
        <div style={{width:1,height:12,background:C.border}}/>
        <Mono color={C.accent} size="0.68rem" weight={600}>
          {burner.balance!=null?`${burner.balance.toFixed(4)} SOL`:"…"}
        </Mono>
      </div>
    )}
    <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",
      background:C.surface2,borderBottom:`1px solid ${C.border}`}}>
      <div style={{width:7,height:7,borderRadius:"50%",
        background:connected?C.green:C.muted,
        boxShadow:connected?`0 0 6px ${C.green}`:"none",flexShrink:0}}/>
      {connected ? (
        <>
          <Mono color={C.text} size="0.72rem">{short}</Mono>
          <div style={{width:1,height:14,background:C.border}}/>
          <Mono color={C.accent} size="0.72rem" weight={600}>
            {solBalance!==null?`${solBalance?.toFixed(4)} SOL`:"…"}
          </Mono>
          <div style={{flex:1}}/>
          <Btn size="sm" onClick={()=>setVisible(true)}>CHANGE</Btn>
        </>
      ) : (
        <>
          <span style={{fontSize:"0.68rem",color:C.muted2,flex:1}}>
            {burnerActive ? "Phantom not connected (burner will trade)" : "No wallet connected"}</span>
          <Btn size="sm" variant="primary" onClick={()=>setVisible(true)}>CONNECT WALLET</Btn>
        </>
      )}
    </div>
    </div>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────────────────
function StatsBar({ stats }) {
  const pnlColor = (stats.totalPnlSol||0)>=0?C.green:C.red;
  const winColor = stats.winRate>=50?C.green:stats.winRate>0?C.warn:C.muted;
  return (
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",
      background:C.surface2,borderBottom:`1px solid ${C.border}`}}>
      {[
        {l:"OPEN",    v:stats.openCount,                                        c:stats.openCount>0?C.accent:C.muted},
        {l:"QUEUED",  v:stats.queueCount,                                       c:stats.queueCount>0?C.warn:C.muted},
        {l:"PnL",     v:(stats.totalPnlSol>=0?"+":"")+stats.totalPnlSol?.toFixed(4)+" SOL", c:pnlColor},
        {l:"WIN RATE",v:stats.tradeCount>0?stats.winRate?.toFixed(0)+"%":"—",  c:winColor},
      ].map(s=>(
        <div key={s.l} style={{padding:"8px 0",borderRight:`1px solid ${C.border}`,textAlign:"center"}}>
          <div style={{fontSize:"0.82rem",fontFamily:C.mono,fontWeight:700,color:s.c}}>{s.v}</div>
          <div style={{fontSize:"0.55rem",color:C.muted,fontFamily:C.mono,letterSpacing:"0.08em",marginTop:2}}>{s.l}</div>
        </div>
      ))}
    </div>
  );
}

// ── Settings panel ────────────────────────────────────────────────────────────
function SettingsPanel({ settings, updateSettings }) {
  const NumField = ({ label, field, min, max, step, suffix, description }) => (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
      padding:"7px 0",borderBottom:`1px solid ${C.border}`}}>
      <div>
        <div style={{fontSize:"0.67rem",color:C.muted2}}>{label}</div>
        {description&&<div style={{fontSize:"0.6rem",color:C.muted,marginTop:1}}>{description}</div>}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <input type="number" value={settings[field]} min={min} max={max} step={step}
          onChange={e=>updateSettings({[field]:parseFloat(e.target.value)})}
          style={{width:72,background:C.surface3,border:`1px solid ${C.border}`,
            borderRadius:4,color:C.text,padding:"3px 8px",
            fontSize:"0.72rem",fontFamily:C.mono,textAlign:"right",outline:"none"}}/>
        {suffix&&<span style={{fontSize:"0.62rem",color:C.muted,minWidth:24}}>{suffix}</span>}
      </div>
    </div>
  );
  const Toggle = ({ label, field, description }) => (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
      padding:"9px 0",borderBottom:`1px solid ${C.border}`}}>
      <div>
        <div style={{fontSize:"0.67rem",color:C.muted2}}>{label}</div>
        {description&&<div style={{fontSize:"0.6rem",color:C.muted,marginTop:1}}>{description}</div>}
      </div>
      <div onClick={()=>updateSettings({[field]:!settings[field]})}
        style={{width:38,height:21,borderRadius:11,cursor:"pointer",transition:"background 0.2s",
          background:settings[field]?C.accent:C.border,position:"relative",flexShrink:0}}>
        <div style={{width:15,height:15,borderRadius:"50%",background:C.text,
          position:"absolute",top:3,transition:"left 0.2s",
          left:settings[field]?20:3}}/>
      </div>
    </div>
  );

  return (
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
      <div style={{padding:"10px 14px",background:C.surface2,borderBottom:`1px solid ${C.border}`}}>
        <span style={{fontSize:"0.65rem",fontFamily:C.mono,fontWeight:700,color:C.text,letterSpacing:"0.1em"}}>
          TRADE SETTINGS
        </span>
      </div>
      <div style={{padding:"0 14px 10px"}}>
        <div style={{paddingTop:4}}>
          <NumField label="Stake per trade"       field="stakeSOL"        min={0.01} max={10}   step={0.01} suffix="SOL"/>
          <NumField label="Take profit"            field="takeProfitPct"   min={5}    max={500}  step={5}    suffix="%"/>
          <NumField label="Stop loss"              field="stopLossPct"     min={5}    max={50}   step={1}    suffix="%"/>
          <NumField label="Slippage tolerance"     field="slippageBps"     min={50}   max={1000} step={50}   suffix="bps"/>
          <NumField label="Max open positions"     field="maxPositions"    min={1}    max={20}   step={1}/>
          <NumField label="Min score to queue"     field="minScore"        min={40}   max={95}   step={5}/>
          <NumField label="Min signal confidence"  field="minConfidence"   min={30}   max={95}   step={5}    suffix="%"/>
          <NumField label="Min vol/liq ratio"      field="minVolLiqRatio"  min={0}    max={20}   step={0.5}  suffix="x"/>
          <NumField label="Cooldown per token"     field="cooldownMinutes" min={5}    max={240}  step={5}    suffix="min"/>
        </div>

        <div style={{paddingTop:4}}>
          <div style={{fontSize:"0.6rem",fontFamily:C.mono,fontWeight:700,color:C.muted,
            letterSpacing:"0.08em",padding:"10px 0 2px"}}>NATIVE EXECUTION &amp; EXIT STACK</div>
          <NumField label="Sustained gate" field="minSustainedAgeSec" min={0} max={180} step={5} suffix="s"
            description="Hold sustained continuously this long before a token is queueable"/>
          <Toggle label="Entry headroom gate" field="entryHeadroomEnabled"
            description="Skip buys that already ran past the sustained trigger"/>
          <NumField label="Max entry drag" field="maxEntryDragPct" min={5} max={100} step={5} suffix="%"
            description="Skip if run-up above trigger exceeds this"/>
          <Toggle label="Partial take-profit" field="partialTpEnabled"
            description="Bank a fraction early, trail the rest"/>
          <NumField label="Partial TP trigger" field="partialTpPct" min={10} max={200} step={5} suffix="%"/>
          <NumField label="Partial TP fraction" field="partialTpFraction" min={0.1} max={1} step={0.05}
            description="0.5 = sell half at the trigger"/>
          <NumField label="Curve slippage" field="pumpSlippage" min={5} max={50} step={1} suffix="%"
            description="Base slippage for native buys/sells"/>
          <Toggle label="Momentum-reversal exit" field="momentumReversalExit"
            description="Sell when sell-pressure spikes, ahead of the price stop"/>
          <NumField label="Reversal buy-pressure" field="reversalBpThreshold" min={0.1} max={0.5} step={0.05}
            description="Exit if buy-pressure drops to/below this (0.30 = 70% sells)"/>
          <NumField label="Reversal price drop" field="reversalPcThreshold" min={-30} max={-2} step={1} suffix="%"
            description="…and 5m price change at/below this"/>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
            padding:"7px 0",borderBottom:`1px solid ${C.border}`}}>
            <div>
              <div style={{fontSize:"0.67rem",color:C.muted2}}>Sell slippage ladder</div>
              <div style={{fontSize:"0.6rem",color:C.muted,marginTop:1}}>Exits escalate through these % (comma-separated)</div>
            </div>
            <input type="text" defaultValue={(settings.sellSlippageLadder||[]).join(", ")}
              key={(settings.sellSlippageLadder||[]).join(",")}
              onBlur={e=>{
                const arr=e.target.value.split(",").map(x=>parseFloat(x.trim())).filter(x=>!isNaN(x)&&x>0);
                if(arr.length) updateSettings({sellSlippageLadder:arr});
              }}
              style={{width:90,background:C.surface3,border:`1px solid ${C.border}`,borderRadius:4,
                color:C.text,padding:"3px 8px",fontSize:"0.72rem",fontFamily:C.mono,textAlign:"right",outline:"none"}}/>
          </div>
        </div>
        <div style={{paddingTop:4}}>
          <Toggle label="Require momentum signal" field="requireMomentum"
            description="Only queue EARLY MOMENTUM and UPTREND signals"/>
          <Toggle label="Scale stake by confidence" field="scaleByConfidence"
            description="Higher confidence → larger position (50%-100% of base stake)"/>
          <Toggle label="Auto-execute trades" field="autoExecute"
            description="⚠ Buys automatically when criteria met"/>
        </div>

        {/* ── Token safety (RugCheck) ───────────────────────────────────── */}
        <div style={{marginTop:14,paddingTop:10,borderTop:`1px solid ${C.border}`}}>
          <div style={{fontSize:"0.6rem",color:C.muted,fontFamily:C.mono,
            letterSpacing:"0.08em",marginBottom:6}}>TOKEN SAFETY (RUGCHECK)</div>
          <Toggle label="Enable safety check" field="enableSafetyCheck"
            description="Filter tokens via RugCheck before queueing — adds ~200ms per token"/>
          {settings.enableSafetyCheck && (
            <>
              <NumField label="Max risk score" field="maxRiskScore" min={0} max={100} step={5} suffix="/100"/>
              <Toggle label="Block hard fails" field="blockHardFails"
                description="Reject mint authority, freeze authority, honeypots, rugged tokens"/>
              <Toggle label="Block high ownership" field="blockHighOwnership"
                description="Reject tokens with top-10 holder concentration danger flag"/>
              <Toggle label="Allow unprofiled tokens" field="allowUnprofiled"
                description="⚠ Allow tokens RugCheck hasn't analysed yet (risky)"/>
            </>
          )}
        </div>

        {/* ── Position management (Stages A + B) ───────────────────────── */}
        <div style={{marginTop:14,paddingTop:10,borderTop:`1px solid ${C.border}`}}>
          <div style={{fontSize:"0.6rem",color:C.muted,fontFamily:C.mono,
            letterSpacing:"0.08em",marginBottom:6}}>POSITION MANAGEMENT</div>
          <Toggle label="Adaptive stop loss" field="adaptiveStopLoss"
            description="Widen SL for high-volatility tokens (uses configured SL as floor)"/>
          <NumField label="Grace period" field="graceSec" min={0} max={300} step={15} suffix="s"
            description="No SL trigger in first N seconds — protects against buy-impact wicks"/>
          <NumField label="Break-even at" field="breakEvenAtPct" min={0} max={50} step={1} suffix="%"
            description="Once up X%, move SL to entry price (0 disables)"/>
        </div>

        {/* ── Entry confirmation ───────────────────────────────────────── */}
        <div style={{marginTop:14,paddingTop:10,borderTop:`1px solid ${C.border}`}}>
          <div style={{fontSize:"0.6rem",color:C.muted,fontFamily:C.mono,
            letterSpacing:"0.08em",marginBottom:6}}>ENTRY CONFIRMATION</div>
          <NumField label="Required scan sightings" field="confirmScans" min={1} max={5} step={1}
            description="Token must show signal in N consecutive scans before queueing (filters one-cycle pumps)"/>
        </div>

        {/* ── Trailing take-profit ─────────────────────────────────────── */}
        <div style={{marginTop:14,paddingTop:10,borderTop:`1px solid ${C.border}`}}>
          <div style={{fontSize:"0.6rem",color:C.muted,fontFamily:C.mono,
            letterSpacing:"0.08em",marginBottom:6}}>TRAILING TAKE-PROFIT</div>
          <Toggle label="Enable trailing TP" field="trailingEnabled"
            description="Let winners run beyond fixed TP — exit only on drawdown from peak"/>
          {settings.trailingEnabled && (
            <>
              <NumField label="Activate at" field="trailingActivateAt" min={10} max={200} step={5} suffix="%"
                description="Start trailing once position is up this much (fixed TP disabled above this)"/>
              <NumField label="Trail drawdown" field="trailDrawdownPct" min={5} max={50} step={1} suffix="%"
                description="Exit when price drops this much from peak"/>
            </>
          )}
        </div>

        {/* ── Notifications ────────────────────────────────────────────── */}
        <NotificationSettings settings={settings} updateSettings={updateSettings}/>

        {settings.autoExecute&&(
          <div style={{marginTop:10,padding:"8px 10px",background:C.surface3,
            borderRadius:5,border:`1px solid ${C.warn}33`}}>
            <div style={{fontSize:"0.6rem",color:C.warn,lineHeight:1.7}}>
              ⚠ Auto-execute is active. Trades will fire without approval when a token meets all criteria. Use a dedicated wallet with a capped balance. Never store more SOL than you are willing to lose.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Notification settings (interactive — permission + test buttons) ──────────
function NotificationSettings({ settings, updateSettings }) {
  const [permStatus, setPermStatus] = useState(browserPermissionStatus());
  const [tgStatus,   setTgStatus]   = useState("");
  const [lookingUpChat, setLookingUpChat] = useState(false);

  const requestPerm = async () => {
    const result = await requestBrowserPermission();
    setPermStatus(result);
    if (result === "granted") {
      // Welcome ping so the user knows it worked
      try {
        new Notification("Notifications enabled ✓", {
          body: "You'll be pinged when tokens queue and trades fill.",
          icon: "/favicon.ico",
        });
      } catch {}
    }
  };

  const lookupChatId = async () => {
    if (!settings.telegramBotToken) {
      setTgStatus("Enter bot token first.");
      return;
    }
    setLookingUpChat(true);
    setTgStatus("Looking up — send any message to your bot now…");
    const id = await fetchTelegramChatId(settings.telegramBotToken);
    setLookingUpChat(false);
    if (id) {
      updateSettings({ telegramChatId: String(id) });
      setTgStatus(`✓ Chat ID found: ${id}`);
    } else {
      setTgStatus("✗ No messages found. Send a message to your bot, then try again.");
    }
  };

  const testTelegram = async () => {
    if (!settings.telegramBotToken || !settings.telegramChatId) {
      setTgStatus("Bot token and chat ID both required.");
      return;
    }
    const ok = await sendTelegram({
      botToken: settings.telegramBotToken,
      chatId:   settings.telegramChatId,
      message:  "*🧪 Test message*\nYour Sol Scanner notifications are working.",
    });
    setTgStatus(ok ? "✓ Sent — check Telegram." : "✗ Failed. Check token and chat ID.");
  };

  const Toggle = ({ label, field, description }) => (
    <div style={{display:"flex",alignItems:"flex-start",gap:10,
      padding:"8px 0",borderBottom:`1px solid ${C.border}`}}>
      <div style={{flex:1}}>
        <div style={{fontSize:"0.67rem",color:C.muted2}}>{label}</div>
        {description&&<div style={{fontSize:"0.6rem",color:C.muted,marginTop:1}}>{description}</div>}
      </div>
      <input type="checkbox" checked={!!settings[field]}
        onChange={e=>updateSettings({[field]:e.target.checked})}
        style={{width:14,height:14,accentColor:C.accent,marginTop:2}}/>
    </div>
  );

  return (
    <div style={{marginTop:14,paddingTop:10,borderTop:`1px solid ${C.border}`}}>
      <div style={{fontSize:"0.6rem",color:C.muted,fontFamily:C.mono,
        letterSpacing:"0.08em",marginBottom:6}}>NOTIFICATIONS</div>

      {/* Browser permission section */}
      <div style={{padding:"7px 0",borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:"0.67rem",color:C.muted2}}>Browser permission</div>
            <div style={{fontSize:"0.6rem",color:C.muted,marginTop:1}}>
              {permStatus === "granted" && "✓ Granted — notifications will fire"}
              {permStatus === "denied"  && "✗ Denied in browser settings — unblock to use"}
              {permStatus === "default" && "Not requested yet"}
              {permStatus === "unsupported" && "Not supported in this browser"}
            </div>
          </div>
          {permStatus !== "granted" && permStatus !== "unsupported" && (
            <Btn size="sm" variant="default" onClick={requestPerm}>Enable</Btn>
          )}
        </div>
      </div>

      <Toggle label="Browser push notifications" field="notifyBrowser"
        description="Show OS-level notifications when the tab is backgrounded"/>
      <Toggle label="Sound alerts" field="notifySound"
        description="Play distinct tones for queue, fill, exit, error events"/>

      <div style={{padding:"7px 0",borderBottom:`1px solid ${C.border}`,
        display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:"0.67rem",color:C.muted2}}>Test sound</div>
          <div style={{fontSize:"0.6rem",color:C.muted,marginTop:1}}>Hear the queue chime</div>
        </div>
        <Btn size="sm" variant="ghost" onClick={()=>playSound("queue")}>🔊 Test</Btn>
      </div>

      <NumFieldExt label="Min confidence to notify" field="notifyMinConf" min={50} max={99} step={5} suffix="%"
        description="Only ping for queue events at or above this confidence"
        settings={settings} updateSettings={updateSettings}/>

      <div style={{marginTop:10,fontSize:"0.6rem",color:C.muted,fontFamily:C.mono,
        letterSpacing:"0.08em",marginBottom:4}}>EVENT TYPES</div>
      <Toggle label="Token queued"          field="notifyOnQueue" description="When a new token enters the queue"/>
      <Toggle label="Trade filled"          field="notifyOnFill"  description="When a buy or manual sell completes"/>
      <Toggle label="Auto-exit (TP/SL)"     field="notifyOnExit"  description="When TP, SL, trail, or break-even fires"/>
      <Toggle label="Errors"                field="notifyOnError" description="When a buy or sell fails"/>

      {/* Telegram section */}
      <div style={{marginTop:14,paddingTop:8,borderTop:`1px solid ${C.border}`}}>
        <div style={{fontSize:"0.6rem",color:C.muted,fontFamily:C.mono,
          letterSpacing:"0.08em",marginBottom:4}}>TELEGRAM (OPTIONAL)</div>
        <div style={{fontSize:"0.6rem",color:C.muted2,lineHeight:1.6,marginBottom:8}}>
          For notifications when away from your device:
          <br/>1. Open Telegram, message @BotFather, send /newbot, follow prompts
          <br/>2. Paste the bot token below
          <br/>3. Open the bot in Telegram and send it any message (e.g. /start)
          <br/>4. Click "Get my chat ID" to auto-fill
        </div>

        <Toggle label="Enable Telegram" field="notifyTelegram"
          description="Send events to your personal Telegram bot"/>

        {settings.notifyTelegram && (
          <>
            <div style={{padding:"7px 0",borderBottom:`1px solid ${C.border}`}}>
              <div style={{fontSize:"0.67rem",color:C.muted2,marginBottom:4}}>Bot token</div>
              <input type="text" value={settings.telegramBotToken || ""}
                onChange={e=>updateSettings({telegramBotToken:e.target.value})}
                placeholder="123456:ABC-DEF..."
                style={{width:"100%",background:C.surface3,border:`1px solid ${C.border}`,
                  borderRadius:4,color:C.text,padding:"5px 8px",
                  fontSize:"0.68rem",fontFamily:C.mono,outline:"none"}}/>
            </div>
            <div style={{padding:"7px 0",borderBottom:`1px solid ${C.border}`,
              display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
              <div style={{flex:1}}>
                <div style={{fontSize:"0.67rem",color:C.muted2,marginBottom:4}}>Chat ID</div>
                <input type="text" value={settings.telegramChatId || ""}
                  onChange={e=>updateSettings({telegramChatId:e.target.value})}
                  placeholder="(auto-fill or paste)"
                  style={{width:"100%",background:C.surface3,border:`1px solid ${C.border}`,
                    borderRadius:4,color:C.text,padding:"5px 8px",
                    fontSize:"0.68rem",fontFamily:C.mono,outline:"none"}}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <Btn size="sm" variant="default" onClick={lookupChatId} disabled={lookingUpChat}>
                  {lookingUpChat ? "…" : "Get ID"}
                </Btn>
                <Btn size="sm" variant="ghost" onClick={testTelegram}>Test</Btn>
              </div>
            </div>
            {tgStatus && (
              <div style={{padding:"6px 0",fontSize:"0.6rem",color:C.muted2}}>{tgStatus}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Reusable NumField (used inside NotificationSettings) ─────────────────────
function NumFieldExt({ label, field, min, max, step, suffix, description, settings, updateSettings }) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
      padding:"7px 0",borderBottom:`1px solid ${C.border}`}}>
      <div>
        <div style={{fontSize:"0.67rem",color:C.muted2}}>{label}</div>
        {description&&<div style={{fontSize:"0.6rem",color:C.muted,marginTop:1}}>{description}</div>}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <input type="number" value={settings[field]} min={min} max={max} step={step}
          onChange={e=>updateSettings({[field]:parseFloat(e.target.value)})}
          style={{width:72,background:C.surface3,border:`1px solid ${C.border}`,
            borderRadius:4,color:C.text,padding:"3px 8px",
            fontSize:"0.72rem",fontFamily:C.mono,textAlign:"right",outline:"none"}}/>
        {suffix&&<span style={{fontSize:"0.62rem",color:C.muted,minWidth:24}}>{suffix}</span>}
      </div>
    </div>
  );
}

// ── Queue item ────────────────────────────────────────────────────────────────
function QueueItem({ item, onApprove, onDismiss, executing, connected }) {
  const [localStake, setLocalStake] = useState(item.stakeSOL);
  const [localTP,    setLocalTP]    = useState(item.takeProfitPct);
  const [localSL,    setLocalSL]    = useState(item.stopLossPct);
  const [editing,    setEditing]    = useState(false);
  const [now,        setNow]        = useState(Date.now());

  // Tick every 30s so staleness badge stays live without hammering renders
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const isExec    = executing[item.id];
  const queuedAge = Math.floor((now - item.queuedAt) / 60000);
  const lastSeen  = Math.floor((now - (item.lastUpdated || item.queuedAt)) / 60000);
  const sigColor  = item.signal?.color || C.muted2;

  // Staleness: warn if not refreshed in last 3 scan cycles (~3 min).
  // LAUNCH items come from the t=0 stream, not the DexScreener scan, so they are
  // never "seen in a scan" and staleness does not apply to them.
  const isLaunch  = item.signal?.type === "LAUNCH";
  const isStale   = !isLaunch && lastSeen >= 3;
  const staleColor = lastSeen >= 7 ? C.red : C.warn;

  // Price change since first queued
  const initPrice   = item.initPriceUsd || item.priceUsd;
  const priceDelta  = initPrice > 0 ? ((item.priceUsd - initPrice) / initPrice) * 100 : 0;
  const deltaColor  = priceDelta > 0 ? C.green : priceDelta < 0 ? C.red : C.muted;

  return (
    <div style={{borderBottom:`1px solid ${C.border}`,
      opacity: isStale ? 0.75 : 1,
      transition: "opacity 0.3s",
    }}>
      {/* Staleness warning bar */}
      {isStale && (
        <div style={{padding:"3px 14px",background:staleColor+"18",
          borderBottom:`1px solid ${staleColor}33`,
          display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:"0.58rem",color:staleColor,fontFamily:C.mono}}>
            ⚠ Signal not seen in last {lastSeen}m — may have left scanner
          </span>
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:10,
        padding:"11px 14px",alignItems:"start"}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5,flexWrap:"wrap"}}>
            <Mono color={C.text} size="0.88rem" weight={700}>{item.symbol}</Mono>
            {isGraduated(item.tokenAddress) && <Badge color="#00e5c3">◆ GRADUATED</Badge>}
            <Badge color={C.accent}>{item.score}</Badge>
            {item.signal&&<Badge color={sigColor}>{item.signal.icon} {item.signal.type}</Badge>}
            {item.signal&&<Badge color={sigColor}>{item.signal.conf}% conf</Badge>}
            {/* RugCheck safety badge */}
            {item.safety && (() => {
              const s = item.safety.scoreNorm ?? 0;
              const col = s < 20 ? C.green : s < 40 ? "#b8f542" : s < 60 ? C.warn : C.red;
              return <Badge color={col}>🛡 {s}/100</Badge>;
            })()}
            {/* Degradation warning — signal weakened on last scan */}
            {item.degradeCount > 0 && (
              <Badge color={C.warn}>⚠ fading</Badge>
            )}
            {/* Queued age */}
            <Badge color={C.muted}>{queuedAge}m in queue</Badge>
            {/* Last refreshed */}
            {lastSeen > 0 && (
              <Badge color={isStale ? staleColor : C.muted2}>
                {isStale ? `⚠ ${lastSeen}m stale` : `↻ ${lastSeen}m ago`}
              </Badge>
            )}
          </div>

          {item.signal?.type === "LAUNCH" && item.activity && (() => {
            const a = item.activity;
            const bp = item.buyPressure != null ? Math.round(item.buyPressure * 100) : null;
            const dSince = item.initPriceUsd > 0
              ? ((item.priceUsd - item.initPriceUsd) / item.initPriceUsd) * 100 : null;
            const t = item.trend || [];
            const arrow = t.length < 2 ? "→"
              : (t[t.length-1].price > t[t.length-2].price ? "↑"
              :  t[t.length-1].price < t[t.length-2].price ? "↓" : "→");
            const tim = item.timing || "building";
            const timMap = {
              sustained: [C.green, "SUSTAINED"], steady: ["#b8f542", "STEADY"],
              cooling: [C.warn, "COOLING"], fading: [C.red, "FADING"], building: [C.muted, "BUILDING"],
            };
            const [timCol, timLbl] = timMap[tim] || [C.muted, "BUILDING"];
            return (
              <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap",
                margin:"5px 0 3px",fontFamily:"var(--font-mono,monospace)",fontSize:"0.62rem"}}>
                <Badge color={timCol}>{timLbl} {arrow}</Badge>
                {dSince != null && <span style={{color: dSince >= 0 ? C.green : C.red}}>
                  {dSince >= 0 ? "+" : ""}{dSince.toFixed(0)}% since queued</span>}
                <span style={{color:C.muted2}}>5m {a.trades5m}tx</span>
                {bp != null && <span style={{color: bp >= 55 ? C.green : bp < 45 ? C.red : C.muted2}}>
                  {bp}% buys</span>}
                {a.vol5m ? <span style={{color:C.muted}}>${a.vol5m.toFixed(0)} vol</span> : null}
                {a.liq ? <span style={{color:C.muted}}>${(a.liq/1000).toFixed(1)}k liq</span> : null}
              </div>
            );
          })()}

          {!editing ? (
            <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
              {[
                {l:"BUY", v:localStake+" SOL", c:C.text},
                {l:"TP",  v:"+"+localTP+"%",  c:C.green},
                {l:"SL",  v:"-"+localSL+"%",  c:C.red},
              ].map(s=>(
                <div key={s.l} style={{display:"flex",gap:4,alignItems:"center"}}>
                  <span style={{fontSize:"0.58rem",color:C.muted,fontFamily:C.mono}}>{s.l}</span>
                  <Mono color={s.c} size="0.72rem" weight={600}>{s.v}</Mono>
                </div>
              ))}
              <button onClick={()=>setEditing(true)}
                style={{fontSize:"0.58rem",color:C.muted,background:"none",border:"none",cursor:"pointer",fontFamily:C.mono}}>
                edit ✎
              </button>
            </div>
          ) : (
            <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
              {[
                {l:"SOL", val:localStake, set:setLocalStake, min:0.01, step:0.01},
                {l:"TP%", val:localTP,    set:setLocalTP,    min:5,    step:5},
                {l:"SL%", val:localSL,    set:setLocalSL,    min:5,    step:1},
              ].map(f=>(
                <div key={f.l} style={{display:"flex",alignItems:"center",gap:4}}>
                  <span style={{fontSize:"0.58rem",color:C.muted,fontFamily:C.mono}}>{f.l}</span>
                  <input type="number" value={f.val} min={f.min} step={f.step}
                    onChange={e=>f.set(parseFloat(e.target.value))}
                    style={{width:58,background:C.surface3,border:`1px solid ${C.border}`,
                      borderRadius:3,color:C.text,padding:"2px 6px",
                      fontSize:"0.68rem",fontFamily:C.mono,outline:"none"}}/>
                </div>
              ))}
              <button onClick={()=>setEditing(false)}
                style={{fontSize:"0.58rem",color:C.accent,background:"none",border:"none",cursor:"pointer",fontFamily:C.mono}}>
                done ✓
              </button>
            </div>
          )}

          {item.signal?.detail&&(
            <div style={{fontSize:"0.62rem",color:C.muted2,marginTop:5,lineHeight:1.5}}>
              {item.signal.detail}
            </div>
          )}
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end"}}>
          {/* Current price + delta since queued */}
          <div style={{textAlign:"right"}}>
            <Mono color={C.text} size="0.78rem" weight={600}>${item.priceUsd?.toFixed(6)}</Mono>
            {Math.abs(priceDelta) >= 0.01 && (
              <div style={{fontSize:"0.6rem",fontFamily:C.mono,color:deltaColor,marginTop:1}}>
                {priceDelta > 0 ? "▲" : "▼"}{Math.abs(priceDelta).toFixed(2)}% since queued
              </div>
            )}
          </div>
          <div style={{display:"flex",gap:5}}>
            <Btn size="sm" variant="ghost" onClick={()=>onDismiss(item.id)}>✕</Btn>
            <Btn size="sm" variant="success" disabled={isExec||!connected}
              onClick={()=>onApprove({...item,stakeSOL:localStake,takeProfitPct:localTP,stopLossPct:localSL})}>
              {isExec?"BUYING…":"▶ BUY"}
            </Btn>
          </div>
          <a href={item.dexUrl} target="_blank" rel="noopener noreferrer"
            style={{fontSize:"0.58rem",color:C.muted,fontFamily:C.mono,textDecoration:"none"}}>
            chart ↗
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Position card ─────────────────────────────────────────────────────────────
function PositionCard({ position, onSell, onRetry, onAbandon, executing, connected }) {
  const isExec = executing[position.id];
  const pnl = position.pnlPct||0;
  const pnlColor = pnl>=0?C.green:C.red;
  const tpPct = position.takeProfitPct||50;
  const slPct = position.stopLossPct||20;
  const cfgSL = position.configuredSL ?? slPct;
  const upProg = Math.min(100,Math.max(0,(pnl/tpPct)*100));
  const dnProg = Math.min(100,Math.max(0,(-pnl/slPct)*100));
  const age = Math.floor((Date.now()-position.openedAt)/60000);
  const ageSec = Math.floor((Date.now()-position.openedAt)/1000);
  const inGrace = ageSec < 60;
  const peak = position.peakPnlPct || 0;
  const breakEven = peak >= 5;
  const adaptiveActive = slPct > cfgSL;
  const trailingActive = peak >= 30;
  const trailDrop = trailingActive ? (peak - pnl) : 0;
  const isStuck = !!position.stuck;

  return (
    <div style={{borderBottom:`1px solid ${C.border}`,padding:"12px 14px",
      background: isStuck ? `${C.red}08` : "transparent"}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:10}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:7,flexWrap:"wrap"}}>
            <div style={{width:3,height:14,borderRadius:1,background:pnlColor,boxShadow:`0 0 5px ${pnlColor}`}}/>
            <Mono color={C.text} size="0.88rem" weight={700}>{position.symbol}</Mono>
            {isGraduated(position.tokenAddress) && <Badge color="#00e5c3">◆ GRADUATED</Badge>}
            {position.partialTaken && <Badge color="#b8f542">½ BANKED +{Math.round(position.partialPct || 0)}%</Badge>}
            {position.momentum && (() => {
              const m = position.momentum;
              const col = m.signal === "FADING" ? C.red : m.signal === "STRONG" ? C.green : C.muted;
              const tag = m.signal === "FADING" ? "▼ FADING — buyers gone"
                : m.signal === "STRONG" ? "▲ buyers strong" : "• steady";
              return <Badge color={col} title={`5m ${m.trades5m}tx · ${Math.round((m.buyPressure||0)*100)}% buys`}>{tag}</Badge>;
            })()}
            <Badge color={C.muted}>{age}m open</Badge>
            {position.entrySignal&&<Badge color={position.entrySignal.color}>{position.entrySignal.type}</Badge>}
            {isStuck && <Badge color={C.red}>🚫 STUCK</Badge>}
            {!isStuck && inGrace && <Badge color="#888">⏱ grace {60-ageSec}s</Badge>}
            {!isStuck && (trailingActive
              ? <Badge color={C.green}>📈 trailing · peak {peak.toFixed(0)}% · -{trailDrop.toFixed(1)}%</Badge>
              : breakEven && <Badge color={C.green}>🔒 BE locked</Badge>)}
            {adaptiveActive && <Badge color={C.warn}>SL widened {slPct}%</Badge>}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:10}}>
            {[
              {l:"ENTRY",  v:"$"+position.entryPrice?.toFixed(6),         c:C.muted2},
              {l:"NOW",    v:"$"+(position.currentPrice||position.entryPrice)?.toFixed(6), c:C.text},
              {l:"STAKED", v:position.solSpent?.toFixed(4)+" SOL",         c:C.muted2},
            ].map(s=>(
              <div key={s.l}>
                <div style={{fontSize:"0.55rem",color:C.muted,fontFamily:C.mono,marginBottom:2}}>{s.l}</div>
                <Mono color={s.c} size="0.7rem">{s.v}</Mono>
              </div>
            ))}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[
              {label:`TP +${tpPct}%`, prog:upProg,  color:C.green},
              {label:`SL -${slPct}%`, prog:dnProg,  color:C.red},
            ].map(bar=>(
              <div key={bar.label}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <span style={{fontSize:"0.55rem",color:bar.color,fontFamily:C.mono}}>{bar.label}</span>
                  <span style={{fontSize:"0.55rem",color:C.muted,fontFamily:C.mono}}>{bar.prog.toFixed(0)}%</span>
                </div>
                <div style={{height:3,background:C.border,borderRadius:2}}>
                  <div style={{height:"100%",width:`${bar.prog}%`,background:bar.color,
                    borderRadius:2,boxShadow:`0 0 4px ${bar.color}66`,transition:"width 0.5s"}}/>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8,justifyContent:"space-between"}}>
          <PnlBadge pct={position.pnlPct} sol={position.pnlSol}/>
          <div style={{display:"flex",gap:5,flexWrap:"wrap",justifyContent:"flex-end"}}>
            <a href={`https://dexscreener.com/solana/${position.pairAddress}`} target="_blank" rel="noopener noreferrer">
              <Btn size="sm">CHART ↗</Btn>
            </a>
            <a href={`https://jup.ag/swap/${position.tokenAddress}-SOL`} target="_blank" rel="noopener noreferrer">
              <Btn size="sm" variant="ghost">JUP ↗</Btn>
            </a>
            <Btn size="sm" variant="danger" disabled={isExec||!connected}
              onClick={()=>onSell(position,"MANUAL")}>
              {isExec?"SELLING…":"SELL"}
            </Btn>
          </div>
          {isStuck && (
            <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end",
              padding:"6px 8px",background:`${C.red}15`,borderRadius:4,
              border:`1px solid ${C.red}33`,marginTop:4}}>
              <div style={{fontSize:"0.58rem",color:C.red,fontFamily:C.mono,textAlign:"right"}}>
                ⚠ {position.stuckReason || "auto-sell failed"}
              </div>
              <div style={{display:"flex",gap:4}}>
                <Btn size="sm" variant="ghost" onClick={()=>onRetry(position.id)}>↻ RETRY</Btn>
                <Btn size="sm" variant="danger"
                  onClick={()=>{
                    if (confirm(`Abandon ${position.symbol}? This marks it as -100% loss in history without an on-chain sell. Only do this after trying to sell manually via jup.ag.`)) {
                      onAbandon(position.id);
                    }
                  }}>✕ ABANDON</Btn>
              </div>
            </div>
          )}
          {position.entryTx&&(
            <a href={`https://solscan.io/tx/${position.entryTx}`} target="_blank" rel="noopener noreferrer"
              style={{fontSize:"0.58rem",color:C.muted,fontFamily:C.mono,textDecoration:"none"}}>
              tx {position.entryTx.slice(0,6)}… ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ── History row ───────────────────────────────────────────────────────────────
function HistoryRow({ trade }) {
  const win = (trade.pnlSol||0)>=0;
  const color = win?C.green:C.red;
  const rColors = {TAKE_PROFIT:C.green,TRAIL_STOP:C.green,STOP_LOSS:C.red,BREAK_EVEN_SL:"#888",MANUAL:C.muted2,ABANDONED:C.red};
  const dt = new Date(trade.closedAt);
  const dateStr = dt.toLocaleDateString("en-GB",{day:"2-digit",month:"short"})+" "+dt.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});

  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr auto auto auto",gap:8,
      alignItems:"center",padding:"8px 14px",borderBottom:`1px solid ${C.border}`}}>
      <div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div style={{width:2,height:12,borderRadius:1,background:color}}/>
          <Mono color={C.text} size="0.8rem" weight={700}>{trade.symbol}</Mono>
          <Badge color={rColors[trade.exitReason]||C.muted2}>{trade.exitReason}</Badge>
        </div>
        <div style={{marginLeft:8,marginTop:2,fontSize:"0.6rem",color:C.muted,fontFamily:C.mono}}>
          {dateStr} · {trade.solSpent?.toFixed(4)} SOL in
        </div>
      </div>
      <div style={{textAlign:"right"}}>
        <div style={{fontSize:"0.58rem",color:C.muted,fontFamily:C.mono}}>ENTRY</div>
        <Mono color={C.muted2} size="0.65rem">${trade.entryPrice?.toFixed(6)}</Mono>
      </div>
      <div style={{textAlign:"right"}}>
        <div style={{fontSize:"0.58rem",color:C.muted,fontFamily:C.mono}}>EXIT</div>
        <Mono color={C.muted2} size="0.65rem">${trade.exitPrice?.toFixed(6)}</Mono>
      </div>
      <PnlBadge pct={trade.pnlPct} sol={trade.pnlSol}/>
    </div>
  );
}

// ── Notification toast ────────────────────────────────────────────────────────
function NotifToast({ notif, onDismiss }) {
  const colors = {success:C.green,error:C.red,warn:C.warn,queue:C.accent,info:C.info};
  const color = colors[notif.type]||C.muted2;
  return (
    <div style={{display:"flex",alignItems:"flex-start",gap:8,padding:"7px 9px",
      background:C.surface,border:`1px solid ${color}33`,
      borderLeft:`3px solid ${color}`,borderRadius:4,
      animation:"slideInRight 0.2s ease",marginBottom:4}}>
      <div style={{flex:1}}>
        <div style={{fontSize:"0.67rem",color:C.text,lineHeight:1.5}}>{notif.msg}</div>
        <div style={{fontSize:"0.57rem",color:C.muted,fontFamily:C.mono,marginTop:1}}>{notif.ts}</div>
      </div>
      <button onClick={()=>onDismiss(notif.id)}
        style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:"0.7rem",padding:"0 2px"}}>✕</button>
    </div>
  );
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────
export function TradingPanel({ trading, solBalance }) {
  const [activeTab, setActiveTab] = useState("queue");
  const {
    settings, updateSettings,
    queue, queueSort, setQueueSort,
    positions, history,
    executing, notifications, dismissNotif,
    executeBuy, executeSell,
    removeFromQueue, clearQueue,
    retryPosition, abandonPosition,
    stats, connected, canTrade, tradingAddress, walletAddress,
  } = trading;

  const tabs = [
    {id:"queue",    label:"QUEUE",     count:queue.length},
    {id:"positions",label:"POSITIONS", count:positions.length},
    {id:"history",  label:"HISTORY",   count:history.length},
    {id:"settings", label:"SETTINGS"},
  ];

  return (
    <div style={{display:"flex",flexDirection:"column",background:C.surface,
      border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden",fontFamily:C.sans}}>

      <style>{`
        @keyframes expandIn    {from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
        @keyframes slideInRight{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}
        @keyframes pulse       {0%,100%{opacity:1}50%{opacity:0.4}}
        input[type=number]::-webkit-inner-spin-button{opacity:0.4}
        input:focus{outline:none}
      `}</style>

      {!canTrade && positions.length > 0 && (
        <div style={{ margin: "10px 0", padding: "9px 12px", borderRadius: 8,
          background: "#ff386014", border: "1px solid #ff3860", color: "#ff8fa6",
          fontSize: "0.66rem", fontFamily: C.mono, lineHeight: 1.5 }}>
          ⚠ WALLET NOT CONNECTED — {positions.length} open position{positions.length > 1 ? "s" : ""} cannot
          be auto-sold. Reconnect (or reload the burner key) to resume exits, or sell manually.
        </div>
      )}
      <WalletBar connected={connected} walletAddress={walletAddress} solBalance={solBalance} burner={trading.burner}/>
      <StatsBar stats={stats}/>

      {/* Tab bar */}
      <div style={{display:"flex",background:C.surface2,borderBottom:`1px solid ${C.border}`}}>
        {tabs.map(tab=>(
          <button key={tab.id} onClick={()=>setActiveTab(tab.id)} style={{
            flex:1,padding:"8px 4px",background:"none",border:"none",
            borderBottom:`2px solid ${activeTab===tab.id?C.accent:"transparent"}`,
            color:activeTab===tab.id?C.accent:C.muted,
            fontSize:"0.58rem",fontFamily:C.mono,fontWeight:700,
            letterSpacing:"0.08em",cursor:"pointer",transition:"all 0.15s",marginBottom:-1,
          }}>
            {tab.label}
            {tab.count>0&&(
              <span style={{marginLeft:4,
                background:activeTab===tab.id?C.accent+"33":C.border,
                color:activeTab===tab.id?C.accent:C.muted2,
                padding:"1px 5px",borderRadius:8,fontSize:"0.55rem"}}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{flex:1,overflowY:"auto",maxHeight:560}}>

        {activeTab==="queue"&&(
          queue.length===0 ? (
            <div style={{padding:"44px 20px",textAlign:"center"}}>
              <div style={{fontSize:"1.8rem",opacity:0.1,marginBottom:10}}>◎</div>
              <Mono color={C.muted} size="0.72rem">No tokens in queue</Mono>
              <div style={{fontSize:"0.62rem",color:C.muted,marginTop:8,lineHeight:1.8}}>
                Tokens meeting your criteria will appear here.<br/>Run a scan to populate the queue.
              </div>
            </div>
          ) : (
            <>
              {/* Sort bar */}
              <div style={{padding:"8px 14px",background:C.surface2,borderBottom:`1px solid ${C.border}`,
                display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <span style={{fontSize:"0.58rem",color:C.muted,fontFamily:C.mono,letterSpacing:"0.06em",flexShrink:0}}>
                  SORT
                </span>
                <div style={{display:"flex",gap:4,flexWrap:"wrap",flex:1}}>
                  {QUEUE_SORT_OPTIONS.map(opt=>(
                    <button key={opt.value} onClick={()=>setQueueSort(opt.value)} style={{
                      padding:"3px 8px",background:queueSort===opt.value?C.accent+"18":"transparent",
                      border:`1px solid ${queueSort===opt.value?C.accent:C.border}`,
                      borderRadius:4,color:queueSort===opt.value?C.accent:C.muted,
                      fontSize:"0.58rem",fontFamily:C.mono,cursor:"pointer",
                      transition:"all 0.15s",whiteSpace:"nowrap",
                    }}>{opt.label}</button>
                  ))}
                </div>
                {settings.autoExecute&&(
                  <span style={{fontSize:"0.58rem",color:C.warn,fontFamily:C.mono,flexShrink:0}}>
                    ⚠ AUTO ON
                  </span>
                )}
                <button onClick={()=>{
                  if (queue.length === 0) return;
                  if (confirm(`Clear all ${queue.length} tokens from the queue?`)) clearQueue();
                }} style={{
                  padding:"3px 8px",background:"transparent",
                  border:`1px solid ${C.border}`,borderRadius:4,
                  color:C.muted,fontSize:"0.58rem",fontFamily:C.mono,cursor:"pointer",
                  flexShrink:0,
                }} title="Clear all queued tokens">
                  ✕ CLEAR
                </button>
              </div>

              {/* Signal priority legend */}
              <div style={{padding:"5px 14px",background:C.surface3,borderBottom:`1px solid ${C.border}`,
                display:"flex",gap:10,flexWrap:"wrap"}}>
                {[
                  {label:"EARLY MOMENTUM", color:C.accent},
                  {label:"UPTREND",        color:C.green},
                  {label:"LATE RECOVERY",  color:"#b8f542"},
                  {label:"CONSOLIDATING",  color:C.muted},
                  {label:"TOPPING OUT",    color:C.red},
                ].map(s=>(
                  <div key={s.label} style={{display:"flex",alignItems:"center",gap:4}}>
                    <div style={{width:5,height:5,borderRadius:"50%",background:s.color,
                      boxShadow:`0 0 4px ${s.color}`}}/>
                    <span style={{fontSize:"0.55rem",color:s.color,fontFamily:C.mono,
                      letterSpacing:"0.04em"}}>{s.label}</span>
                  </div>
                ))}
              </div>

              {queue.map(item=>(
                <QueueItem key={item.id} item={item}
                  onApprove={executeBuy} onDismiss={removeFromQueue}
                  executing={executing} connected={canTrade}/>
              ))}
            </>
          )
        )}

        {activeTab==="positions"&&(
          positions.length===0 ? (
            <div style={{padding:"44px 20px",textAlign:"center"}}>
              <div style={{fontSize:"1.8rem",opacity:0.1,marginBottom:10}}>◎</div>
              <Mono color={C.muted} size="0.72rem">No open positions</Mono>
            </div>
          ) : (
            <>
              <div style={{padding:"6px 14px",background:C.surface2,borderBottom:`1px solid ${C.border}`}}>
                <div style={{fontSize:"0.6rem",color:C.muted2}}>Prices refresh every 15s · TP/SL fires automatically</div>
              </div>
              {positions.map(pos=>(
                <PositionCard key={pos.id} position={pos}
                  onSell={executeSell}
                  onRetry={retryPosition}
                  onAbandon={abandonPosition}
                  executing={executing} connected={canTrade}/>
              ))}
            </>
          )
        )}

        {activeTab==="history"&&(
          history.length===0 ? (
            <div style={{padding:"44px 20px",textAlign:"center"}}>
              <div style={{fontSize:"1.8rem",opacity:0.1,marginBottom:10}}>◎</div>
              <Mono color={C.muted} size="0.72rem">No closed trades yet</Mono>
            </div>
          ) : (
            <>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",
                padding:"10px 14px",gap:10,background:C.surface2,borderBottom:`1px solid ${C.border}`}}>
                {[
                  {l:"TRADES",  v:stats.tradeCount,                                        c:C.text2},
                  {l:"WIN RATE",v:stats.winRate?.toFixed(0)+"%",                           c:stats.winRate>=50?C.green:C.red},
                  {l:"AVG PnL", v:(stats.totalPnlPct>=0?"+":"")+stats.totalPnlPct?.toFixed(1)+"%", c:stats.totalPnlPct>=0?C.green:C.red},
                ].map(s=>(
                  <div key={s.l} style={{textAlign:"center"}}>
                    <Mono color={s.c} size="0.9rem" weight={700}>{s.v}</Mono>
                    <div style={{fontSize:"0.55rem",color:C.muted,fontFamily:C.mono,letterSpacing:"0.08em",marginTop:2}}>{s.l}</div>
                  </div>
                ))}
              </div>
              {history.map(trade=><HistoryRow key={trade.id} trade={trade}/>)}
            </>
          )
        )}

        {activeTab==="settings"&&(
          <div style={{padding:14}}>
            <SettingsPanel settings={settings} updateSettings={updateSettings}/>
            <div style={{marginTop:12,background:C.surface2,border:`1px solid ${C.border}`,
              borderRadius:6,padding:12}}>
              <div style={{fontSize:"0.62rem",color:C.muted,fontFamily:C.mono,
                letterSpacing:"0.08em",marginBottom:8}}>ACTIVE CRITERIA SUMMARY</div>
              {[
                ["Min score",        settings.minScore+"+ / 100"],
                ["Min confidence",   settings.minConfidence+"%"],
                ["Min vol/liq ratio",(settings.minVolLiqRatio ?? 2.0)+"x"],
                ["Entry confirmation", `${settings.confirmScans ?? 2} scan sightings required`],
                ["Safety check",     settings.enableSafetyCheck
                  ? `RugCheck on (max risk ${settings.maxRiskScore ?? 60}/100)`
                  : "OFF"],
                ["Momentum filter",  settings.requireMomentum?"EARLY MOMENTUM / UPTREND":"Any signal"],
                ["Position sizing",  settings.scaleByConfidence?"Scaled by confidence (50-100%)":"Fixed stake"],
                ["Trailing TP",      settings.trailingEnabled
                  ? `Active above +${settings.trailingActivateAt ?? 18}%, -${settings.trailDrawdownPct ?? 10}% drawdown`
                  : "OFF (fixed TP only)"],
                ["Max positions",    settings.maxPositions],
                ["Cooldown",         settings.cooldownMinutes+"min per token"],
                ["Slippage",         (settings.slippageBps/100).toFixed(1)+"%"],
                ["Auto-execute",     settings.autoExecute?"⚠ ENABLED":"OFF — manual approval"],
              ].map(([k,v])=>(
                <div key={k} style={{display:"flex",justifyContent:"space-between",
                  padding:"5px 0",borderBottom:`1px solid ${C.border}`}}>
                  <span style={{fontSize:"0.65rem",color:C.muted2}}>{k}</span>
                  <Mono color={k==="Auto-execute"&&settings.autoExecute?C.warn:C.accent}
                    size="0.65rem" weight={600}>{v}</Mono>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Activity log */}
      {notifications.length>0&&(
        <div style={{padding:"8px 10px",borderTop:`1px solid ${C.border}`,
          background:C.surface2,maxHeight:180,overflowY:"auto"}}>
          <div style={{fontSize:"0.57rem",color:C.muted,fontFamily:C.mono,
            letterSpacing:"0.08em",marginBottom:5}}>ACTIVITY LOG</div>
          {notifications.slice(0,5).map(n=>(
            <NotifToast key={n.id} notif={n} onDismiss={dismissNotif}/>
          ))}
        </div>
      )}
    </div>
  );
}
