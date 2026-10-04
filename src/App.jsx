const TEST_MODE = false; // LIVE — Seamless Africa 2026: real IMPI-#### invoices

import { useState, useEffect, useCallback } from "react";
import { SUPABASE_CONFIGURED } from "./supabase.js";
import {
  fetchAllData, subscribeRealtime, addProduct as addProductAPI,
  applyAdjustmentRPC, setStockTakeRPC, completeSaleRPC, wipeAllDataRPC,
  createLoanRPC, returnLoanRPC, invoiceLoanRPC, fetchEvents, createEvent,
  archiveEvent, unarchiveEvent, deleteEventPermanentlyRPC,
  isStockError, loadQueue, pushToQueue, removeFromQueue,
} from "./sync.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const VAT_RATE = 0; // IMPI does not charge VAT on PPE sales
const BASE = import.meta.env.BASE_URL; // correct logo path whether run locally or under a GitHub Pages subfolder

// ─── Last-used event (which event this device was last working on) ────────────
// Tiny and safe to read before any event is chosen — just an id + name, not
// any actual stock/sales data.
const LAST_EVENT_KEY = "impi_pos_last_event_v1";
const loadLastEvent = () => {
  try { return JSON.parse(localStorage.getItem(LAST_EVENT_KEY)); } catch { return null; }
};
const saveLastEvent = ev => {
  try { localStorage.setItem(LAST_EVENT_KEY, JSON.stringify(ev)); } catch {}
};

// ─── Local cache (fallback only, scoped per event) ─────────────────────────────
// The shared Supabase backend is the source of truth for every device. This
// local cache exists purely so the app still shows last-known data if it's
// opened while offline — it is overwritten by the server every time a fetch
// succeeds, and is never treated as authoritative when online. Keyed by event
// id so one event's cached data can never bleed into another's.
const cacheKey = eventId => `impi_pos_cache_v2_${eventId}`;
const loadCache = eventId => {
  try { return JSON.parse(localStorage.getItem(cacheKey(eventId))) || {}; }
  catch { return {}; }
};
const saveCache = (eventId, stock, sales, adjLog, loans) => {
  try { localStorage.setItem(cacheKey(eventId), JSON.stringify({ stock, sales, adjLog, loans, savedAt: new Date().toISOString() })); }
  catch (e) { console.error("Cache save failed", e); }
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(()=>fn(...a), ms); }; };

const fmt = n => `R ${Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const dateStr = () => new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
const timeStr = () => new Date().toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });

const ADMINS = [
  { username: "admin",  password: "Impi@Admin2024" },
];

const INITIAL_STOCK = [];
// Add your real products via the app's Stock → Add Product screen, per event.


// ─── Global CSS ───────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@300;400;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --black:#0a0a0a;--charcoal:#141414;--steel:#222222;--border:#2a2a2a;
  --gold:#c9a84c;--gold-bright:#FFD700;--red-brand:#CC0000;--red-ui:#c0392b;
  --green:#27ae60;--orange:#e67e22;--muted:#666666;--text:#d0d0c8;--white:#f5f5f0;
}
html,body{min-height:100%;background:var(--black);color:var(--text);font-family:'Barlow Condensed',sans-serif;font-size:16px;}
input,select,textarea,button{font-family:'Barlow Condensed',sans-serif;}
button{cursor:pointer;}
.mono{font-family:'JetBrains Mono',monospace;}

@keyframes heroFadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
@keyframes heroScaleIn{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:scale(1)}}
@keyframes heroFadeIn{from{opacity:0}to{opacity:1}}
@keyframes glowPulse{0%,100%{transform:scale(1);opacity:.6}50%{transform:scale(1.15);opacity:1}}
@keyframes toastIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
@keyframes drawerUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}

.field-input{background:var(--steel);border:1px solid var(--border);border-radius:4px;color:var(--white);
  padding:11px 14px;font-size:15px;width:100%;outline:none;transition:border-color .15s;}
.field-input:focus{border-color:var(--gold);}
.field-input::placeholder{color:var(--muted);}
select.field-input{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%23666' d='M6 8L0 0h12z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;}

.sec-label{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:5px;display:block;}

.badge{display:inline-block;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 8px;border-radius:3px;}
.badge-green{background:rgba(39,174,96,.15);color:#27ae60;border:1px solid rgba(39,174,96,.3);}
.badge-orange{background:rgba(230,126,34,.15);color:#e67e22;border:1px solid rgba(230,126,34,.3);}
.badge-red{background:rgba(192,57,43,.15);color:#c0392b;border:1px solid rgba(192,57,43,.3);}
.badge-gold{background:rgba(201,168,76,.15);color:#c9a84c;border:1px solid rgba(201,168,76,.4);}
.badge-blue{background:rgba(59,157,214,.15);color:#3b9dd6;border:1px solid rgba(59,157,214,.4);}

.size-chip{background:var(--steel);border:2px solid var(--border);border-radius:6px;padding:8px 14px;
  font-size:14px;font-weight:700;color:var(--text);cursor:pointer;transition:all .15s;min-width:64px;
  text-align:center;user-select:none;}
.size-chip:hover:not(.out){border-color:var(--gold);}
.size-chip.selected{background:rgba(201,168,76,.15);border-color:var(--gold);color:var(--gold);}
.size-chip.out{opacity:.35;cursor:not-allowed;text-decoration:line-through;}
.chip-stock{font-size:10px;font-weight:400;color:#666;display:block;}

.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.85);backdrop-filter:blur(4px);
  z-index:150;display:flex;align-items:center;justify-content:center;padding:16px;animation:fadeIn .2s ease;}
.modal-card{background:var(--charcoal);border:1px solid #333;border-top:3px solid var(--gold);
  border-radius:8px;padding:24px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;}

.tbl{width:100%;border-collapse:collapse;}
.tbl th{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);
  padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);}
.tbl td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:14px;}
.tbl tr:hover td{background:rgba(255,255,255,.02);}

.pill-btn{padding:8px 16px;border-radius:20px;border:1.5px solid var(--border);font-size:13px;font-weight:700;
  letter-spacing:1px;background:var(--steel);color:var(--muted);transition:all .15s;}
.pill-btn.active{background:var(--gold);color:#000;border-color:var(--gold);}
.pill-btn:hover:not(.active){border-color:var(--gold);color:var(--text);}

.st-input{background:var(--steel);border:1px solid var(--border);border-radius:4px;color:var(--white);
  padding:6px 10px;font-family:'JetBrains Mono';font-size:13px;width:80px;outline:none;text-align:center;}
.st-input:focus{border-color:var(--gold);}

@media(max-width:700px){
  .hdr-logo-text{display:none!important;}
  .nav-label{display:none!important;}
  .pos-layout{display:block!important;}
  .cart-panel{display:none!important;}
  .mobile-fab{display:flex!important;}
  .pos-grid{grid-template-columns:1fr 1fr!important;}
  .client-grid{grid-template-columns:1fr!important;}
  .stats-grid{grid-template-columns:1fr!important;}
  .adj-grid{grid-template-columns:1fr!important;}
}
@media print{.no-print{display:none!important;}body{background:#fff!important;}}
`;

// ─── Logo ─────────────────────────────────────────────────────────────────────
function LogoMark({ px }) {
  return (
    <div style={{width:px,height:px,background:"linear-gradient(135deg,#FFD700,#c9a84c)",borderRadius:"50%",
      border:"3px solid #CC0000",display:"flex",flexDirection:"column",alignItems:"center",
      justifyContent:"center",boxShadow:"0 0 20px #FFD70044",flexShrink:0}}>
      <span style={{fontSize:px*.28,fontWeight:900,color:"#000",letterSpacing:1}}>IMPI</span>
      <span style={{fontSize:Math.max(px*.10,7),fontWeight:700,color:"#CC0000",letterSpacing:2,textTransform:"uppercase"}}>Protection</span>
    </div>
  );
}

function Logo({ h = 44, glow = false, center = false }) {
  const [err, setErr] = useState(false);
  if (err) return <LogoMark px={h} />;
  return (
    <img src={`${BASE}impi-logo.svg`} alt="IMPI RMS (Pty) Ltd"
      onError={() => setErr(true)}
      style={{height:h,width:"auto",objectFit:"contain",flexShrink:0,
        ...(glow ? {filter:"drop-shadow(0 0 24px #FFD70066)"} : {}),
        ...(center ? {display:"block",margin:"0 auto"} : {}),
      }} />
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function useToast() {
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((msg, type = "info") => {
    const id = Date.now() + Math.random();
    setToasts(p => [...p.slice(-2), { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3200);
  }, []);
  const dismiss = useCallback(id => setToasts(p => p.filter(t => t.id !== id)), []);
  return { toasts, toast, dismiss };
}

function Toasts({ toasts, dismiss }) {
  const cols = { success:"#27ae60", error:"#c0392b", info:"#c9a84c" };
  const icons = { success:"✓", error:"✗", info:"ℹ" };
  return (
    <div style={{position:"fixed",top:72,right:16,zIndex:9999,display:"flex",flexDirection:"column",gap:8,pointerEvents:"none"}}>
      {toasts.map(t => (
        <div key={t.id} onClick={() => dismiss(t.id)}
          style={{background:"#1a1a1a",border:"1px solid #333",borderLeft:`4px solid ${cols[t.type]||cols.info}`,
            borderRadius:4,padding:"12px 16px",fontSize:14,color:"#f5f5f0",
            boxShadow:"0 4px 20px rgba(0,0,0,.5)",minWidth:280,maxWidth:360,
            cursor:"pointer",animation:"toastIn .25s ease",display:"flex",gap:10,
            alignItems:"flex-start",pointerEvents:"auto"}}>
          <span style={{color:cols[t.type],fontWeight:900,fontSize:16,lineHeight:1.2}}>{icons[t.type]}</span>
          <span style={{flex:1}}>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Test Banner ──────────────────────────────────────────────────────────────
const TestBanner = () => TEST_MODE ? (
  <div style={{background:"#5c2800",color:"#FFD700",textAlign:"center",padding:"6px 16px",
    fontSize:12,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>
    ⚠ TEST MODE — Documents are not valid tax invoices
  </div>
) : null;

// ─── Hero ─────────────────────────────────────────────────────────────────────
function HeroScreen({ onEnter }) {
  const [fading, setFading] = useState(false);
  const go = () => { setFading(true); setTimeout(onEnter, 420); };
  const anim = (name, dur, delay) => ({ animation:`${name} ${dur}s ease-out ${delay}s forwards`, opacity:0 });

  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",
      justifyContent:"center",position:"relative",overflow:"hidden",padding:"40px 24px",
      transition:"opacity .42s ease",opacity:fading?0:1,
      background:`repeating-linear-gradient(-45deg,transparent,transparent 40px,rgba(255,215,0,.015) 40px,rgba(255,215,0,.015) 41px),
        repeating-linear-gradient(45deg,transparent,transparent 40px,rgba(204,0,0,.01) 40px,rgba(204,0,0,.01) 41px),#0a0a0a`}}>

      {/* Glow orb */}
      <div style={{position:"absolute",width:400,height:400,borderRadius:"50%",pointerEvents:"none",
        top:"50%",left:"50%",transform:"translate(-50%,-50%)",
        background:"radial-gradient(ellipse at center,rgba(255,215,0,.18) 0%,rgba(201,168,76,.08) 40%,transparent 70%)",
        animation:"glowPulse 3s ease-in-out infinite"}} />

      <div style={{position:"relative",textAlign:"center",maxWidth:640,width:"100%"}}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:12,...anim("heroScaleIn",.6,.1)}}>
          <Logo h={200} glow />
        </div>
        <div style={{width:60,height:2,background:"#CC0000",margin:"0 auto 28px",...anim("heroFadeIn",.4,.3)}} />
        <h1 style={{fontFamily:"'Barlow Condensed'",fontWeight:900,color:"#FFD700",lineHeight:1,
          fontSize:"clamp(40px,8vw,92px)",letterSpacing:2,textTransform:"uppercase",marginBottom:12,
          ...anim("heroFadeUp",.6,.4)}}>
          IMPI RMS<br/>(Pty) Ltd
        </h1>
        <p style={{fontFamily:"'Barlow Condensed'",fontSize:18,fontWeight:600,color:"#666",
          letterSpacing:3,textTransform:"uppercase",marginBottom:16,...anim("heroFadeUp",.5,.7)}}>
          PPE Mobile Shop · Point of Sale
        </p>
        <p style={{fontFamily:"'Barlow Condensed'",fontSize:20,fontWeight:300,color:"#d0d0c8",
          fontStyle:"italic",marginBottom:40,...anim("heroFadeIn",.5,.9)}}>
          "Protecting People. Powering Events."
        </p>
        <div style={{display:"flex",justifyContent:"center",marginBottom:48,...anim("heroFadeUp",.5,1.1)}}>
          <button onClick={go}
            onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow="0 8px 32px rgba(255,215,0,.45)";}}
            onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow="0 4px 24px rgba(255,215,0,.3)";}}
            style={{background:"linear-gradient(135deg,#FFD700,#c9a84c)",color:"#000",fontWeight:900,
              fontSize:18,letterSpacing:3,textTransform:"uppercase",padding:"16px 48px",border:"none",
              borderRadius:4,boxShadow:"0 4px 24px rgba(255,215,0,.3)",transition:"all .2s ease",
              width:"100%",maxWidth:320}}>
            Enter System →
          </button>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12,justifyContent:"center",marginBottom:20,...anim("heroFadeIn",.5,1.4)}}>
          <div style={{flex:1,height:1,background:"#CC0000",opacity:.5}} />
          <span style={{color:"#CC0000",fontWeight:700,fontSize:13,letterSpacing:4,textTransform:"uppercase"}}>
            HONESTY · INTEGRITY · LOYALTY
          </span>
          <div style={{flex:1,height:1,background:"#CC0000",opacity:.5}} />
        </div>
        <p style={{color:"#444",fontSize:12,letterSpacing:2,...anim("heroFadeIn",.4,1.7)}}>
          v1.0 · {TEST_MODE ? "TEST MODE" : "LIVE"}
        </p>
      </div>
    </div>
  );
}

// ─── Login ────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState("staff"); // "staff" | "admin"
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submitStaff = () => {
    const n = name.trim();
    if (!n) { setError("Please enter your name."); return; }
    onLogin({ username: n, role: "user" });
  };

  const submitAdmin = () => {
    const u = ADMINS.find(a => a.username === username.trim() && a.password === password);
    if (u) onLogin({ username: u.username, role: "admin" });
    else setError("Invalid admin username or password.");
  };

  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",
      background:"#0a0a0a",padding:"24px 16px",animation:"fadeIn .4s ease"}}>
      <div style={{background:"#141414",border:"2px solid #c9a84c",borderRadius:8,padding:"36px 32px",
        maxWidth:380,width:"100%",boxShadow:"0 0 60px rgba(201,168,76,.1)"}}>
        <div style={{textAlign:"center",marginBottom:20}}>
          <Logo h={110} center />
          <h2 style={{fontWeight:800,fontSize:18,color:"#f5f5f0",textTransform:"uppercase",letterSpacing:1}}>
            IMPI RMS (Pty) Ltd
          </h2>
          <div style={{height:1,background:"#c9a84c",margin:"12px 0"}} />
          <p style={{fontSize:13,fontWeight:700,color:"#666",letterSpacing:2,textTransform:"uppercase"}}>
            Point of Sale System
          </p>
        </div>

        {mode === "staff" ? (
          <>
            <div style={{marginBottom:8}}>
              <label className="sec-label">Your Name</label>
              <input className="field-input" value={name} autoFocus
                placeholder="e.g. Thabo Mokoena"
                onChange={e=>{setName(e.target.value);setError("");}}
                onKeyDown={e=>e.key==="Enter"&&submitStaff()} autoComplete="name" />
              <p style={{fontSize:12,color:"#666",marginTop:6}}>
                Used on invoices and sales records — so we know who to check with if anything's short.
              </p>
            </div>
            {error && <p style={{color:"#c0392b",fontSize:13,marginBottom:10}}>{error}</p>}
            <button onClick={submitStaff}
              style={{width:"100%",background:"linear-gradient(135deg,#FFD700,#c9a84c)",color:"#000",
                fontWeight:900,fontSize:16,letterSpacing:3,textTransform:"uppercase",
                padding:"13px 0",border:"none",borderRadius:4,marginTop:8}}>
              Sign In
            </button>
            <button onClick={()=>{setMode("admin");setError("");}}
              style={{width:"100%",background:"none",border:"none",color:"#555",fontSize:12,
                letterSpacing:1,marginTop:16,textDecoration:"underline",cursor:"pointer"}}>
              Admin login →
            </button>
          </>
        ) : (
          <>
            <div style={{marginBottom:14}}>
              <label className="sec-label">Admin Username</label>
              <input className="field-input" value={username}
                onChange={e=>{setUsername(e.target.value);setError("");}}
                onKeyDown={e=>e.key==="Enter"&&submitAdmin()} autoComplete="username" />
            </div>
            <div style={{marginBottom:8}}>
              <label className="sec-label">Admin Password</label>
              <input className="field-input" type="password" value={password}
                onChange={e=>{setPassword(e.target.value);setError("");}}
                onKeyDown={e=>e.key==="Enter"&&submitAdmin()} autoComplete="current-password" />
            </div>
            {error && <p style={{color:"#c0392b",fontSize:13,marginBottom:10}}>{error}</p>}
            <button onClick={submitAdmin}
              style={{width:"100%",background:"linear-gradient(135deg,#FFD700,#c9a84c)",color:"#000",
                fontWeight:900,fontSize:16,letterSpacing:3,textTransform:"uppercase",
                padding:"13px 0",border:"none",borderRadius:4,marginTop:8}}>
              Sign In
            </button>
            <button onClick={()=>{setMode("staff");setError("");}}
              style={{width:"100%",background:"none",border:"none",color:"#555",fontSize:12,
                letterSpacing:1,marginTop:16,textDecoration:"underline",cursor:"pointer"}}>
              ← Back to staff sign in
            </button>
          </>
        )}

        {TEST_MODE && mode === "admin" && (
          <div style={{marginTop:20,background:"rgba(230,126,34,.12)",border:"1px solid #e67e22",
            borderRadius:4,padding:"12px 14px",fontSize:13,color:"#e67e22"}}>
            <strong>🧪 DEMO ADMIN LOGIN</strong><br/>
            admin / Impi@Admin2024
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Event Selector ─────────────────────────────────────────────────────────
// Every event is a logically separate workspace on the same shared backend —
// its own stock, sales, adjustments and loans, walled off from every other
// event. This is what runs before anything else loads, so the right one gets
// picked before any data is fetched.
function EventSelector({ user, onSelect, toast }) {
  const [events, setEvents] = useState(null); // null = loading
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = (includeArchived) => {
    fetchEvents(includeArchived).then(setEvents).catch(err => { setError(err.message||"Couldn't load events"); setEvents([]); });
  };

  useEffect(() => { load(showArchived); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [showArchived]);

  const create = async () => {
    if (!newName.trim()) { toast("✗ Give the event a name","error"); return; }
    setCreating(true);
    try {
      const ev = await createEvent(newName.trim(), user.username);
      onSelect(ev);
    } catch (err) {
      toast(`✗ Couldn't create event — ${err.message||"unknown error"}`,"error");
      setCreating(false);
    }
  };

  const doArchive = async (ev) => {
    if (!window.confirm(`Archive "${ev.name}"? It'll disappear from this list, but all its data stays safe — you can unarchive it any time.`)) return;
    setBusyId(ev.id);
    try {
      await archiveEvent(ev.id);
      toast(`✓ "${ev.name}" archived`,"success");
      load(showArchived);
    } catch (err) {
      toast(`✗ Couldn't archive — ${err.message||"unknown error"}`,"error");
    }
    setBusyId(null);
  };

  const doUnarchive = async (ev) => {
    setBusyId(ev.id);
    try {
      await unarchiveEvent(ev.id);
      toast(`✓ "${ev.name}" restored`,"success");
      load(showArchived);
    } catch (err) {
      toast(`✗ Couldn't restore — ${err.message||"unknown error"}`,"error");
    }
    setBusyId(null);
  };

  const doDelete = async (ev) => {
    const typed = window.prompt(
      `This PERMANENTLY deletes "${ev.name}" and every product, sale, adjustment and loan in it. ` +
      `This cannot be undone — not even by Claude. A full backup downloads automatically first.\n\n` +
      `Type the event name exactly to confirm:`
    );
    if (typed === null) return;
    if (typed !== ev.name) { toast("✗ Name didn't match — nothing deleted","error"); return; }
    setBusyId(ev.id);
    try {
      const data = await fetchAllData(ev.id);
      downloadBackup(data.stock, data.sales, data.adjLog, data.loans, ev);
      await deleteEventPermanentlyRPC(ev.id);
      toast(`✓ "${ev.name}" permanently deleted — backup downloaded first`,"success");
      load(showArchived);
    } catch (err) {
      toast(`✗ Couldn't delete — ${err.message||"unknown error"}`,"error");
    }
    setBusyId(null);
  };

  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",
      background:"#0a0a0a",padding:"24px 16px"}}>
      <div style={{background:"#141414",border:"2px solid #c9a84c",borderRadius:8,padding:"36px 32px",
        maxWidth:520,width:"100%"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <Logo h={80} center />
          <h2 style={{fontWeight:800,fontSize:17,color:"#f5f5f0",textTransform:"uppercase",letterSpacing:1,marginTop:12}}>
            Select Event
          </h2>
          <p style={{fontSize:12,color:"#666",marginTop:6}}>
            Each event has its own stock and sales — pick yours, or start a new one.
          </p>
        </div>

        {events===null && <p style={{color:"#666",textAlign:"center",padding:20}}>Loading events…</p>}
        {error && <p style={{color:"#c0392b",fontSize:13,marginBottom:12}}>{error}</p>}

        {events && events.length>0 && (
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16,maxHeight:300,overflowY:"auto"}}>
            {events.map(ev=>(
              <div key={ev.id} style={{background:"#1a1a1a",border:`1px solid ${ev.active?"#333":"#555"}`,borderRadius:6,
                padding:"12px 14px",opacity:ev.active?1:0.6}}>
                <button onClick={()=>onSelect(ev)} disabled={busyId===ev.id}
                  style={{display:"block",width:"100%",textAlign:"left",background:"none",border:"none",color:"#f5f5f0",cursor:"pointer",padding:0}}>
                  <div style={{fontWeight:700,fontSize:15}}>{ev.name}{!ev.active && <span style={{color:"#888",fontWeight:400}}> (archived)</span>}</div>
                  <div style={{fontSize:11,color:"#666",marginTop:2}}>
                    Created by {ev.createdBy} · {new Date(ev.createdAt).toLocaleDateString("en-ZA")}
                  </div>
                </button>
                {user.role==="admin" && (
                  <div style={{display:"flex",gap:6,marginTop:8}}>
                    {ev.active
                      ? <button onClick={()=>doArchive(ev)} disabled={busyId===ev.id}
                          style={{background:"none",border:"1px solid #666",borderRadius:4,color:"#888",fontSize:11,fontWeight:700,padding:"4px 10px"}}>
                          📦 Archive
                        </button>
                      : <button onClick={()=>doUnarchive(ev)} disabled={busyId===ev.id}
                          style={{background:"none",border:"1px solid #27ae60",borderRadius:4,color:"#27ae60",fontSize:11,fontWeight:700,padding:"4px 10px"}}>
                          ↩ Unarchive
                        </button>
                    }
                    <button onClick={()=>doDelete(ev)} disabled={busyId===ev.id}
                      style={{background:"none",border:"1px solid #c0392b",borderRadius:4,color:"#c0392b",fontSize:11,fontWeight:700,padding:"4px 10px"}}>
                      🗑 Delete Permanently
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {events && events.length===0 && !error && (
          <p style={{color:"#444",fontSize:14,textAlign:"center",marginBottom:16}}>
            {showArchived ? "No archived events." : "No events yet — create the first one below."}
          </p>
        )}

        {user.role==="admin" && (
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"#888",marginBottom:20,cursor:"pointer"}}>
            <input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)} />
            Show archived events
          </label>
        )}

        <div style={{borderTop:"1px solid #333",paddingTop:20}}>
          <label className="sec-label">New Event Name</label>
          <input className="field-input" placeholder="e.g. Seamless Africa 2026" value={newName}
            onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&create()} style={{marginBottom:10}} />
          <button onClick={create} disabled={creating}
            style={{width:"100%",background:creating?"#555":"linear-gradient(135deg,#FFD700,#c9a84c)",
              color:creating?"#999":"#000",fontWeight:900,fontSize:15,letterSpacing:2,textTransform:"uppercase",
              padding:"12px 0",border:"none",borderRadius:4}}>
            {creating?"Creating…":"+ Create & Use This Event"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────
function downloadBackup(stock, sales, adjLog, loans, event) {
  const blob = new Blob([JSON.stringify({
    stock, sales, adjLog, loans, eventId: event?.id, eventName: event?.name, exportedAt: new Date().toISOString(),
  }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName = (event?.name||"event").replace(/[^a-z0-9]+/gi,"-").toLowerCase();
  a.download = `impi-pos-backup-${safeName}-${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function Header({ user, screen, setScreen, onLogout, stock, sales, adjLog, loans, onResetAll, online, queueCount, syncIssuesCount, event, onSwitchEvent }) {
  const navItems = [
    { key:"pos",   icon:"⚡", label:"POS" },
    { key:"stock", icon:"📦", label:"Stock", admin:true },
    { key:"sales", icon:"📋", label:"Sales" },
    { key:"reconcile", icon:"🔍", label:"Reconcile", admin:true },
  ].filter(n => !n.admin || user.role === "admin");

  return (
    <div style={{position:"sticky",top:0,zIndex:50,background:"#0a0a0a",borderBottom:"2px solid #c9a84c",
      display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 16px",height:60,gap:12}}>
      <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}>
        <Logo h={56} />
        <div className="hdr-logo-text" style={{lineHeight:1.2}}>
          <div style={{fontWeight:800,fontSize:15,color:"#f5f5f0",textTransform:"uppercase",letterSpacing:1}}>IMPI RMS (Pty) Ltd</div>
          <div style={{fontSize:11,color:"#666",letterSpacing:1}}>PPE Mobile Shop · POS</div>
        </div>
        {user.role==="admin"
          ? <button onClick={onSwitchEvent} title="Switch to a different event"
              style={{background:"#1a1a1a",border:"1px solid #c9a84c",borderRadius:20,padding:"5px 12px",
                color:"#c9a84c",fontSize:12,fontWeight:700,marginLeft:4,whiteSpace:"nowrap"}}>
              📅 {event?.name||"No event"} ▾
            </button>
          : <span style={{background:"#1a1a1a",border:"1px solid #333",borderRadius:20,padding:"5px 12px",
                color:"#888",fontSize:12,fontWeight:700,marginLeft:4,whiteSpace:"nowrap"}}>
              📅 {event?.name||"No event"}
            </span>
        }
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
        <span title={online?"Connected — every device sees this data live":"No connection — sales are being saved locally and will sync automatically"}
          style={{display:"flex",alignItems:"center",gap:6,fontSize:12,fontWeight:700,color:online?"#27ae60":"#e67e22",
            border:`1px solid ${online?"#27ae60":"#e67e22"}`,borderRadius:20,padding:"5px 12px"}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:online?"#27ae60":"#e67e22",display:"inline-block"}}/>
          {online ? "LIVE" : `OFFLINE${queueCount?` · ${queueCount} PENDING`:""}`}
        </span>
        {syncIssuesCount>0 && (
          <span title="Sales that couldn't sync due to a stock conflict — needs manual review"
            style={{fontSize:12,fontWeight:700,color:"#c0392b",border:"1px solid #c0392b",borderRadius:20,padding:"5px 12px"}}>
            ⚠ {syncIssuesCount} SYNC ISSUE{syncIssuesCount>1?"S":""}
          </span>
        )}
        {navItems.map(n => (
          <button key={n.key}
            onClick={() => setScreen(n.key)}
            style={{display:"flex",alignItems:"center",gap:6,padding:"8px 14px",borderRadius:4,border:"none",
              fontSize:14,fontWeight:700,letterSpacing:1,textTransform:"uppercase",
              background:screen===n.key?"#c9a84c":"#222",
              color:screen===n.key?"#000":"#888",transition:"all .15s"}}>
            <span>{n.icon}</span><span className="nav-label">{n.label}</span>
          </button>
        ))}
        <span className={`badge ${user.role==="admin"?"badge-gold":"badge-green"}`} style={{marginLeft:4}}>
          {user.role==="admin"?"ADMIN":"STAFF"}
        </span>
        {user.role==="admin" && (
          <button onClick={()=>downloadBackup(stock, sales, adjLog, loans, event)} title="Download a backup of all stock and sales data"
            style={{background:"#222",color:"#c9a84c",border:"1px solid #333",borderRadius:4,
              padding:"8px 12px",fontWeight:700,fontSize:13,letterSpacing:1}}>
            ⬇ BACKUP
          </button>
        )}
        {user.role==="admin" && (
          <button onClick={onResetAll} title="Wipe the SHARED stock, sales and adjustment history for every connected device (auto-backs-up first)"
            style={{background:"#222",color:"#c0392b",border:"1px solid #c0392b",borderRadius:4,
              padding:"8px 12px",fontWeight:700,fontSize:13,letterSpacing:1}}>
            🗑 RESET
          </button>
        )}
        <button onClick={onLogout}
          style={{background:"#c0392b",color:"#fff",border:"none",borderRadius:4,
            padding:"8px 12px",fontWeight:700,fontSize:13,letterSpacing:1}}>
          OUT
        </button>
      </div>
    </div>
  );
}

// ─── Product Modal ────────────────────────────────────────────────────────────
function ProductModal({ product, stock, onClose, onAdd }) {
  const prod = stock.find(p => p.id === product.id) || product;
  const [sel, setSel] = useState({});

  const toggle = (size, maxQty) => {
    if (maxQty === 0) return;
    setSel(p => { const n={...p}; if(n[size]) delete n[size]; else n[size]=1; return n; });
  };
  const adj = (size, d, maxQty) => {
    setSel(p => ({...p, [size]: Math.max(1, Math.min(maxQty, (p[size]||1)+d))}));
  };

  const entries = Object.entries(sel);
  const totalUnits = entries.reduce((s,[,q])=>s+q,0);
  const totalVal = entries.reduce((s,[sz,q])=>{
    const v = prod.variants.find(v=>v.size===sz);
    return s+(v?v.price*q:0);
  },0);

  const handleAdd = () => {
    if (!entries.length) return;
    onAdd(entries.map(([size,qty])=>{
      const v = prod.variants.find(vv=>vv.size===size);
      return {productId:prod.id,variantId:v.id,category:prod.category,sku:prod.sku,size,qty,price:v.price};
    }), totalUnits);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal-card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
          <div>
            <h3 style={{fontWeight:800,fontSize:22,color:"#f5f5f0"}}>{prod.category}</h3>
            <span className="mono" style={{fontSize:12,color:"#666"}}>SKU: {prod.sku}</span>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#666",fontSize:22,padding:4}}>✕</button>
        </div>
        <div style={{height:1,background:"#333",margin:"12px 0 16px"}} />
        <p className="sec-label">Select Sizes &amp; Quantities</p>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {prod.variants.map(v => {
            const out = v.qty===0;
            const isSel = !!sel[v.size];
            return (
              <div key={v.size} style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <button className={`size-chip${isSel?" selected":""}${out?" out":""}`}
                  onClick={()=>toggle(v.size,v.qty)} disabled={out} style={{minWidth:72}}>
                  {v.size}
                  <span className="chip-stock">{v.qty} in stock</span>
                </button>
                {isSel && (
                  <div style={{display:"flex",alignItems:"center",gap:6,flex:1,flexWrap:"wrap"}}>
                    <div style={{display:"flex",alignItems:"center",gap:2}}>
                      <button onClick={()=>adj(v.size,-1,v.qty)}
                        style={{width:30,height:30,background:"#333",border:"1px solid #444",borderRadius:4,color:"#f5f5f0",fontSize:16,fontWeight:700}}>−</button>
                      <span className="mono" style={{minWidth:28,textAlign:"center",fontSize:15,color:"#FFD700"}}>{sel[v.size]}</span>
                      <button onClick={()=>adj(v.size,+1,v.qty)}
                        style={{width:30,height:30,background:"#333",border:"1px solid #444",borderRadius:4,color:"#f5f5f0",fontSize:16,fontWeight:700}}>+</button>
                    </div>
                    <span style={{color:"#666",fontSize:13,marginLeft:4}}>{fmt(v.price)} each</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{marginTop:16,padding:"10px 0",borderTop:"1px solid #333",fontSize:14,color:"#c9a84c"}}>
          {entries.length>0
            ? `${entries.length} size${entries.length>1?"s":""} selected · ${totalUnits} unit${totalUnits>1?"s":""} · ${fmt(totalVal)}`
            : "Select sizes above"}
        </div>
        <button onClick={handleAdd} disabled={!entries.length}
          style={{width:"100%",background:entries.length?"linear-gradient(135deg,#FFD700,#c9a84c)":"#333",
            color:entries.length?"#000":"#555",fontWeight:900,fontSize:16,letterSpacing:2,
            textTransform:"uppercase",padding:"13px 0",border:"none",borderRadius:4,marginTop:4}}>
          {entries.length?`Add All to Cart (${totalUnits} unit${totalUnits>1?"s":""})`:"Select sizes first"}
        </button>
      </div>
    </div>
  );
}

// ─── Cart Panel Content ───────────────────────────────────────────────────────
function CartContent({ cart, updateQty, removeItem, client, setClient, paymentMethod, setPaymentMethod, onComplete }) {
  const total = cart.reduce((s,i)=>s+i.price*i.qty,0);

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <span style={{fontWeight:800,fontSize:16,textTransform:"uppercase",letterSpacing:1,color:"#f5f5f0"}}>Current Sale</span>
        <span className="mono badge badge-gold">{cart.length} item{cart.length!==1?"s":""}</span>
      </div>
      {cart.length===0
        ? <p style={{color:"#444",fontSize:14,textAlign:"center",padding:"24px 0"}}>Cart is empty</p>
        : <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:12}}>
            {cart.map(item=>(
              <div key={item.cartId} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 0",borderBottom:"1px solid #2a2a2a"}}>
                <span style={{flex:1,fontSize:13,color:"#d0d0c8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.category}</span>
                <span className="badge badge-gold" style={{fontSize:10,flexShrink:0}}>{item.size}</span>
                <button onClick={()=>updateQty(item.cartId,-1)} style={{width:28,height:28,background:"#333",border:"1px solid #444",borderRadius:3,color:"#f5f5f0",fontSize:14,flexShrink:0}}>−</button>
                <span className="mono" style={{minWidth:20,textAlign:"center",fontSize:14}}>{item.qty}</span>
                <button onClick={()=>updateQty(item.cartId,+1)} style={{width:28,height:28,background:"#333",border:"1px solid #444",borderRadius:3,color:"#f5f5f0",fontSize:14,flexShrink:0}}>+</button>
                <button onClick={()=>removeItem(item.cartId)} style={{width:28,height:28,background:"rgba(192,57,43,.2)",border:"1px solid #c0392b",borderRadius:3,color:"#c0392b",fontSize:14,flexShrink:0}}>✕</button>
                <span className="mono" style={{minWidth:72,textAlign:"right",fontSize:13,color:"#c9a84c"}}>{fmt(item.price*item.qty)}</span>
              </div>
            ))}
          </div>
      }
      <div style={{borderTop:"1px solid #333",paddingTop:10,marginBottom:16}}>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:20,fontWeight:900,color:"#c9a84c"}}>
          <span>TOTAL</span><span className="mono">{fmt(total)}</span>
        </div>
      </div>
      <p className="sec-label" style={{marginBottom:8}}>Payment Method</p>
      <div style={{display:"flex",gap:8,marginBottom:16}}>
        {[["cash","💵 Cash"],["card","💳 Card"]].map(([key,label])=>(
          <button key={key} onClick={()=>setPaymentMethod(key)}
            style={{flex:1,padding:"12px 0",borderRadius:4,fontWeight:800,fontSize:14,letterSpacing:1,
              border:`2px solid ${paymentMethod===key?"#c9a84c":"#333"}`,
              background:paymentMethod===key?"#c9a84c":"#181818",
              color:paymentMethod===key?"#000":"#888"}}>
            {label}
          </button>
        ))}
      </div>
      <p className="sec-label" style={{marginBottom:8}}>Client Details</p>
      <div className="client-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
        {[["name","Name *","text"],["company","Company","text"],["email","Email","email"],["phone","Phone","tel"]].map(([k,lbl,t])=>(
          <div key={k}>
            <label className="sec-label">{lbl}</label>
            <input className="field-input" type={t} placeholder={lbl.replace(" *","")} value={client[k]}
              onChange={e=>setClient(p=>({...p,[k]:e.target.value}))} />
          </div>
        ))}
      </div>
      <button onClick={onComplete}
        onMouseEnter={e=>e.currentTarget.style.background="#2ecc71"}
        onMouseLeave={e=>e.currentTarget.style.background="#27ae60"}
        style={{width:"100%",background:"#27ae60",color:"#fff",fontWeight:900,fontSize:17,
          letterSpacing:2,textTransform:"uppercase",padding:"15px 0",border:"none",borderRadius:4}}>
        ✓ Complete Sale &amp; Invoice
      </button>
    </div>
  );
}

// ─── POS Screen ───────────────────────────────────────────────────────────────
function POSScreen({ stock, user, toast, onCompleteSale, onSaleComplete }) {
  const [cart, setCart] = useState([]);
  const [search, setSearch] = useState("");
  const [modalProd, setModalProd] = useState(null);
  const [client, setClient] = useState({name:"",company:"",email:"",phone:""});
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [drawer, setDrawer] = useState(false);

  const filtered = stock.filter(p =>
    p.category.toLowerCase().includes(search.toLowerCase()) ||
    p.sku.toLowerCase().includes(search.toLowerCase())
  );
  const totalInCart = cart.reduce((s,i)=>s+i.qty,0);

  const addToCart = (items, totalUnits) => {
    setCart(prev => {
      const next = [...prev];
      items.forEach(item => {
        const idx = next.findIndex(c=>c.productId===item.productId&&c.size===item.size);
        if (idx>=0) next[idx]={...next[idx],qty:next[idx].qty+item.qty};
        else next.push({...item,cartId:`${item.productId}-${item.size}-${Date.now()}-${Math.random()}`});
      });
      return next;
    });
    toast(`✓ ${totalUnits} unit${totalUnits>1?"s":""} added to cart`, "success");
  };

  const updateQty = (cartId, d) => {
    setCart(prev => prev.map(i => {
      if (i.cartId!==cartId) return i;
      const sv = stock.find(p=>p.id===i.productId)?.variants.find(v=>v.size===i.size);
      return {...i, qty:Math.max(1,Math.min(sv?.qty??999,i.qty+d))};
    }));
  };
  const removeItem = cartId => setCart(p=>p.filter(i=>i.cartId!==cartId));

  const completeSale = async () => {
    if (!client.name.trim()) { toast("✗ Client name is required","error"); return; }
    if (!cart.length) { toast("✗ Cart is empty","error"); return; }
    const result = await onCompleteSale(cart, client, paymentMethod);
    if (!result.ok) return; // blocked (e.g. insufficient stock) — leave cart as-is so the cashier can fix it
    setCart([]); setClient({name:"",company:"",email:"",phone:""}); setPaymentMethod("cash"); setDrawer(false);
    onSaleComplete(result.inv);
  };

  const getStatus = p => {
    const t = p.variants.reduce((s,v)=>s+v.qty,0);
    if (t===0) return {label:"OUT OF STOCK",cls:"badge-red"};
    if (t<10)  return {label:"LOW STOCK",   cls:"badge-orange"};
    return           {label:"IN STOCK",     cls:"badge-green"};
  };

  return (
    <div style={{paddingBottom:80}}>
      <div className="pos-layout" style={{display:"grid",gridTemplateColumns:"1fr 420px",minHeight:"calc(100vh - 60px)"}}>
        {/* Product grid */}
        <div style={{padding:20,borderRight:"1px solid #2a2a2a",overflowY:"auto"}}>
          <input className="field-input" placeholder="Search products…" value={search}
            onChange={e=>setSearch(e.target.value)} style={{marginBottom:16}} />
          <div className="pos-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            {filtered.map(prod => {
              const totalQty = prod.variants.reduce((s,v)=>s+v.qty,0);
              const st = getStatus(prod);
              return (
                <div key={prod.id} onClick={()=>setModalProd(prod)}
                  onMouseEnter={e=>e.currentTarget.style.borderColor="#c9a84c"}
                  onMouseLeave={e=>e.currentTarget.style.borderColor="#2a2a2a"}
                  style={{background:"#141414",border:"1px solid #2a2a2a",borderRadius:8,
                    padding:"14px 16px",cursor:"pointer",transition:"border-color .15s"}}>
                  <div style={{fontWeight:800,fontSize:16,color:"#f5f5f0",marginBottom:4}}>{prod.category}</div>
                  <div className="mono" style={{fontSize:12,color:"#666",marginBottom:6}}>
                    {prod.sku} · {prod.variants.length} size{prod.variants.length>1?"s":""}
                  </div>
                  <div style={{fontSize:13,color:"#888",marginBottom:8}}>{totalQty} units total</div>
                  <span className={`badge ${st.cls}`}>{st.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Cart panel (desktop) */}
        <div className="cart-panel" style={{padding:20,overflowY:"auto",background:"#0d0d0d"}}>
          <CartContent cart={cart} updateQty={updateQty} removeItem={removeItem}
            client={client} setClient={setClient} paymentMethod={paymentMethod} setPaymentMethod={setPaymentMethod} onComplete={completeSale} />
        </div>
      </div>

      {/* Mobile FAB */}
      <button className="mobile-fab"
        onClick={()=>setDrawer(true)}
        style={{display:"none",position:"fixed",bottom:24,right:24,zIndex:100,
          width:64,height:64,borderRadius:"50%",background:"linear-gradient(135deg,#FFD700,#c9a84c)",
          border:"none",fontSize:24,boxShadow:"0 4px 20px rgba(255,215,0,.4)",
          alignItems:"center",justifyContent:"center",flexDirection:"column"}}>
        🛒
        {totalInCart>0&&(
          <span style={{position:"absolute",top:0,right:0,background:"#c0392b",color:"#fff",
            borderRadius:"50%",width:22,height:22,fontSize:12,fontWeight:700,
            display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'JetBrains Mono'"}}>
            {totalInCart}
          </span>
        )}
      </button>

      {/* Mobile cart drawer */}
      {drawer&&(
        <div style={{position:"fixed",inset:0,zIndex:199,background:"rgba(0,0,0,.6)"}} onClick={()=>setDrawer(false)}>
          <div onClick={e=>e.stopPropagation()}
            style={{position:"absolute",bottom:0,left:0,right:0,background:"#141414",
              borderTop:"3px solid #c9a84c",padding:20,maxHeight:"85vh",overflowY:"auto",
              animation:"drawerUp .3s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}>
              <span style={{fontWeight:800,fontSize:18,color:"#f5f5f0"}}>Cart</span>
              <button onClick={()=>setDrawer(false)} style={{background:"none",border:"none",color:"#666",fontSize:22}}>✕</button>
            </div>
            <CartContent cart={cart} updateQty={updateQty} removeItem={removeItem}
              client={client} setClient={setClient} paymentMethod={paymentMethod} setPaymentMethod={setPaymentMethod} onComplete={completeSale} />
          </div>
        </div>
      )}

      {modalProd&&(
        <ProductModal product={modalProd} stock={stock} onClose={()=>setModalProd(null)} onAdd={addToCart} />
      )}
    </div>
  );
}

// ─── Invoice View ─────────────────────────────────────────────────────────────
function InvoiceView({ invoice, onBack }) {
  const emailInvoice = () => {
    const subject = `Tax Invoice ${invoice.id} — IMPI RMS (Pty) Ltd`;
    const body =
`Dear ${invoice.client.name || "Customer"},

Please find attached your invoice ${invoice.id} dated ${invoice.date}, total ${fmt(invoice.total)} (incl. VAT).

Please click "Print / Save PDF" first, save the PDF, then attach it to this email before sending.

Kind regards,
${invoice.cashier}
IMPI RMS (Pty) Ltd
info@impi-secure.co.za · 083 782 2207`;
    const to = invoice.client.email || "";
    window.location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  const print = () => {
    const html = `<!DOCTYPE html><html><head><title>Invoice ${invoice.id}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;700;900&family=JetBrains+Mono&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Barlow Condensed',Arial,sans-serif;background:#fff;color:#111;padding:40px;max-width:760px;margin:0 auto;}
.mono{font-family:'JetBrains Mono',monospace;}
table{width:100%;border-collapse:collapse;margin:20px 0;}
th{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:8px;border-bottom:2px solid #111;text-align:left;}
td{padding:10px 8px;border-bottom:1px solid #ddd;font-size:14px;}
.right{text-align:right;}
.watermark{background:#ffeeee;border:2px solid #c0392b;color:#c0392b;text-align:center;padding:10px;font-weight:900;font-size:14px;margin-top:24px;}
</style></head><body>
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;flex-wrap:wrap;gap:16px;">
  <div>
    <img src="${BASE}impi-logo.svg" alt="IMPI" style="height:60px;" onerror="this.style.display='none'" />
    <div style="margin-top:8px;line-height:1.7;font-size:13px;">
      <strong>IMPI RMS (Pty) Ltd</strong><br/>
      10 Kosmos Crescent, Rynoue AH, Roodeplaat, Pretoria<br/>
      info@impi-secure.co.za · 012 543 0640<br/>
      www.impi-secure.co.za
    </div>
  </div>
  <div style="text-align:right;">
    <h1 style="font-family:'Barlow Condensed';font-weight:900;font-size:30px;">TAX INVOICE</h1>
    <div class="mono" style="font-size:20px;font-weight:700;color:#c9a84c;">${invoice.id}</div>
    <div style="font-size:13px;color:#555;margin-top:4px;">Date: ${invoice.date}</div>
    <div style="font-size:13px;color:#555;">Cashier: ${invoice.cashier}</div>
    <div style="font-size:13px;color:#555;">Payment: ${invoice.paymentMethod==="card"?"Card":"Cash"}</div>
  </div>
</div>
<div style="background:#f8f8f8;border:1px solid #ddd;border-radius:4px;padding:12px 16px;margin-bottom:24px;font-size:14px;">
  <strong style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#666;">Bill To</strong><br/>
  ${invoice.client.name}${invoice.client.company?` · ${invoice.client.company}`:""}${invoice.client.email?` · ${invoice.client.email}`:""}${invoice.client.phone?` · ${invoice.client.phone}`:""}
</div>
<table>
<thead><tr><th>Description</th><th>Size</th><th class="right">Qty</th><th class="right">Unit Price</th><th class="right">Total</th></tr></thead>
<tbody>${invoice.items.map(i=>`<tr><td>${i.category}</td><td>${i.size}</td><td class="right mono">${i.qty}</td><td class="right mono">${fmt(i.price)}</td><td class="right mono">${fmt(i.price*i.qty)}</td></tr>`).join("")}</tbody>
</table>
<table style="max-width:300px;margin-left:auto;">
<tbody>
<tr><td style="font-weight:900;font-size:16px;">TOTAL DUE</td>
    <td class="right mono" style="font-weight:900;font-size:16px;color:#c9a84c;">${fmt(invoice.total)}</td></tr>
</tbody>
</table>
<p style="margin-top:28px;font-size:13px;color:#777;">Thank you for your purchase<br/>
IMPI RMS (Pty) Ltd · Co. Reg: 2017/099360/07 · PSIRA: 2689596</p>
${TEST_MODE?'<div class="watermark">⚠ TEST DOCUMENT — NOT A VALID TAX INVOICE</div>':""}
<script>window.print();<\/script>
</body></html>`;
    const w = window.open("","_blank");
    w.document.write(html); w.document.close();
  };

  return (
    <div style={{padding:24,maxWidth:820,margin:"0 auto"}}>
      <div className="no-print" style={{display:"flex",gap:10,marginBottom:24}}>
        <button onClick={onBack}
          style={{background:"#222",color:"#d0d0c8",border:"1px solid #333",borderRadius:4,padding:"10px 18px",fontSize:14,fontWeight:700}}>
          ← New Sale
        </button>
        <button onClick={print}
          style={{background:"#222",color:"#d0d0c8",border:"1px solid #333",borderRadius:4,padding:"10px 18px",fontSize:14,fontWeight:700}}>
          🖨 Print / Save PDF
        </button>
        <button onClick={emailInvoice} title={invoice.client.email ? "" : "No customer email captured — will open a blank email"}
          style={{background:"#222",color:"#d0d0c8",border:"1px solid #333",borderRadius:4,padding:"10px 18px",fontSize:14,fontWeight:700}}>
          ✉ Email Invoice
        </button>
      </div>
      <p className="no-print" style={{fontSize:12,color:"#666",marginTop:-16,marginBottom:20}}>
        Tip: click <strong>Print / Save PDF</strong> first and save the file, then <strong>Email Invoice</strong> opens your mail app pre-filled — just attach the saved PDF and send.
      </p>

      <div style={{background:"#fff",color:"#111",borderRadius:8,padding:"40px 48px",boxShadow:"0 4px 40px rgba(0,0,0,.6)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24,flexWrap:"wrap",gap:16}}>
          <div>
            <Logo h={60} />
            <div style={{fontSize:13,lineHeight:1.8,color:"#333",marginTop:8}}>
              <strong>IMPI RMS (Pty) Ltd</strong><br/>
              10 Kosmos Crescent, Rynoue AH, Roodeplaat, Pretoria<br/>
              info@impi-secure.co.za · 012 543 0640<br/>
              www.impi-secure.co.za
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <h1 style={{fontFamily:"'Barlow Condensed'",fontWeight:900,fontSize:30,margin:0}}>TAX INVOICE</h1>
            <div className="mono" style={{fontSize:20,fontWeight:700,color:"#c9a84c",marginTop:4}}>{invoice.id}</div>
            <div style={{fontSize:13,color:"#555",marginTop:6}}>Date: {invoice.date}</div>
            <div style={{fontSize:13,color:"#555"}}>Cashier: {invoice.cashier}</div>
            <div style={{fontSize:13,color:"#555"}}>Payment: {invoice.paymentMethod==="card"?"Card":"Cash"}</div>
          </div>
        </div>

        <div style={{background:"#f8f8f8",border:"1px solid #ddd",borderRadius:4,padding:"12px 16px",marginBottom:24,fontSize:13}}>
          <strong style={{fontSize:11,letterSpacing:1,textTransform:"uppercase",color:"#666"}}>Bill To</strong><br/>
          <span style={{fontSize:15}}>
            {invoice.client.name}
            {invoice.client.company&&` · ${invoice.client.company}`}
            {invoice.client.email&&` · ${invoice.client.email}`}
            {invoice.client.phone&&` · ${invoice.client.phone}`}
          </span>
        </div>

        <table style={{width:"100%",borderCollapse:"collapse",marginBottom:24}}>
          <thead>
            <tr>{["Description","Size","Qty","Unit Price","Total"].map((h,i)=>(
              <th key={h} style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,
                color:"#555",padding:"8px",borderBottom:"2px solid #111",textAlign:i>=2?"right":"left"}}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {invoice.items.map((item,i)=>(
              <tr key={i}>
                <td style={{padding:"10px 8px",borderBottom:"1px solid #eee"}}>{item.category}</td>
                <td style={{padding:"10px 8px",borderBottom:"1px solid #eee"}}>{item.size}</td>
                <td className="mono" style={{padding:"10px 8px",borderBottom:"1px solid #eee",textAlign:"right"}}>{item.qty}</td>
                <td className="mono" style={{padding:"10px 8px",borderBottom:"1px solid #eee",textAlign:"right"}}>{fmt(item.price)}</td>
                <td className="mono" style={{padding:"10px 8px",borderBottom:"1px solid #eee",textAlign:"right"}}>{fmt(item.price*item.qty)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{display:"flex",justifyContent:"flex-end"}}>
          <table style={{minWidth:290}}>
            <tbody>
              <tr><td style={{padding:"4px 8px",fontSize:18,fontWeight:900}}>TOTAL DUE</td>
                  <td className="mono" style={{padding:"4px 8px",fontSize:18,fontWeight:900,textAlign:"right",color:"#c9a84c"}}>{fmt(invoice.total)}</td></tr>
            </tbody>
          </table>
        </div>

        <div style={{marginTop:28,fontSize:13,color:"#777",borderTop:"1px solid #eee",paddingTop:14}}>
          Thank you for your purchase<br/>
          IMPI RMS (Pty) Ltd · Co. Reg: 2017/099360/07 · PSIRA: 2689596
        </div>
        {TEST_MODE&&(
          <div style={{marginTop:20,background:"#ffeeee",border:"2px solid #c0392b",borderRadius:4,
            padding:"10px 16px",textAlign:"center",color:"#c0392b",fontWeight:900,fontSize:14,letterSpacing:1}}>
            ⚠ TEST DOCUMENT — NOT A VALID TAX INVOICE
          </div>
        )}
      </div>
    </div>
  );
}

// ─── View Stock ───────────────────────────────────────────────────────────────
function ViewStock({ stock }) {
  const [expanded, setExpanded] = useState({});
  const qColor = q => q===0?"#c0392b":q<5?"#c0392b":q<10?"#e67e22":"#27ae60";
  const stBadge = q => q===0?"badge-red":q<10?"badge-orange":"badge-green";
  const stLabel = q => q===0?"OUT OF STOCK":q<10?"LOW STOCK":"IN STOCK";
  return (
    <div>
      {stock.map(p=>{
        const tot=p.variants.reduce((s,v)=>s+v.qty,0);
        return (
          <div key={p.id} style={{background:"#141414",border:"1px solid #2a2a2a",borderRadius:8,marginBottom:10,overflow:"hidden"}}>
            <div onClick={()=>setExpanded(x=>({...x,[p.id]:!x[p.id]}))}
              style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 16px",cursor:"pointer"}}>
              <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{fontWeight:800,fontSize:16,color:"#f5f5f0"}}>{p.category}</span>
                <span className="mono" style={{fontSize:11,color:"#666"}}>{p.sku}</span>
                <span className={`badge ${stBadge(tot)}`}>{stLabel(tot)}</span>
              </div>
              <div style={{display:"flex",gap:12,alignItems:"center",flexShrink:0}}>
                <span className="mono" style={{color:qColor(tot),fontWeight:700}}>{tot} units</span>
                <span style={{color:"#666",fontSize:16}}>{expanded[p.id]?"▲":"▼"}</span>
              </div>
            </div>
            {expanded[p.id]&&(
              <table className="tbl" style={{borderTop:"1px solid #2a2a2a"}}>
                <thead><tr><th>Size</th><th>Price (excl. VAT)</th><th>Qty</th><th>Status</th></tr></thead>
                <tbody>
                  {p.variants.map(v=>(
                    <tr key={v.size}>
                      <td style={{fontWeight:700}}>{v.size}</td>
                      <td className="mono">{fmt(v.price)}</td>
                      <td className="mono" style={{color:qColor(v.qty),textDecoration:v.qty===0?"line-through":"none"}}>{v.qty}</td>
                      <td><span className={`badge ${stBadge(v.qty)}`}>{stLabel(v.qty)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Add Product ──────────────────────────────────────────────────────────────
function AddProduct({ toast, refreshAll, eventId }) {
  const [cat, setCat] = useState("");
  const [sku, setSku] = useState("");
  const [variants, setVariants] = useState([{size:"",price:"",qty:""}]);
  const [saving, setSaving] = useState(false);

  const addRow = () => setVariants(p=>[...p,{size:"",price:"",qty:""}]);
  const delRow = i => setVariants(p=>p.filter((_,idx)=>idx!==i));
  const upd = (i,f,v) => setVariants(p=>p.map((r,idx)=>idx===i?{...r,[f]:v}:r));
  const previewQty = variants.reduce((s,v)=>s+(parseInt(v.qty)||0),0);

  const save = async () => {
    if (!cat.trim()) { toast("✗ Category name is required","error"); return; }
    if (!sku.trim()) { toast("✗ SKU is required","error"); return; }
    const valid = variants.filter(v=>v.size&&v.price);
    if (!valid.length) { toast("✗ At least one variant required","error"); return; }
    setSaving(true);
    try {
      await addProductAPI(cat.trim(), sku.trim().toUpperCase(),
        valid.map(v=>({size:v.size,price:parseFloat(v.price)||0,qty:parseInt(v.qty)||0})), eventId);
      await refreshAll();
    } catch (err) {
      setSaving(false);
      toast(`✗ Couldn't save — check your connection (${err.message||"unknown error"})`, "error");
      return;
    }
    setSaving(false);
    toast(`✓ ${cat.trim()} added to inventory — ${valid.length} variant${valid.length>1?"s":""}`, "success");
    setCat(""); setSku(""); setVariants([{size:"",price:"",qty:""}]);
  };

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:20}}>
        <div><label className="sec-label">Category Name</label>
          <input className="field-input" placeholder="e.g. Hi-Vis Jacket" value={cat} onChange={e=>setCat(e.target.value)} /></div>
        <div><label className="sec-label">SKU Code</label>
          <input className="field-input" placeholder="e.g. HVJ" value={sku} onChange={e=>setSku(e.target.value)} style={{fontFamily:"'JetBrains Mono'"}} /></div>
      </div>
      <p className="sec-label" style={{marginBottom:8}}>Variants</p>
      {variants.map((v,i)=>(
        <div key={i} style={{display:"flex",gap:8,marginBottom:8,alignItems:"center"}}>
          <input className="field-input" placeholder="Size" value={v.size} onChange={e=>upd(i,"size",e.target.value)} style={{flex:1.2}} />
          <input className="field-input" placeholder="Price (R)" type="number" value={v.price} onChange={e=>upd(i,"price",e.target.value)} style={{flex:1,fontFamily:"'JetBrains Mono'"}} />
          <input className="field-input" placeholder="Qty" type="number" value={v.qty} onChange={e=>upd(i,"qty",e.target.value)} style={{flex:.8,fontFamily:"'JetBrains Mono'"}} />
          <button onClick={()=>delRow(i)} style={{width:36,height:44,background:"rgba(192,57,43,.2)",border:"1px solid #c0392b",borderRadius:4,color:"#c0392b",fontSize:18,flexShrink:0}}>✕</button>
        </div>
      ))}
      <button onClick={addRow} style={{background:"#222",border:"1px dashed #444",borderRadius:4,color:"#888",padding:"8px 16px",marginBottom:24,fontSize:13,fontWeight:700,width:"100%"}}>
        + Add Variant
      </button>
      {cat&&(
        <div style={{marginBottom:20}}>
          <p className="sec-label" style={{marginBottom:8}}>Preview</p>
          <div style={{background:"#141414",border:"1px solid #c9a84c",borderRadius:8,padding:"14px 16px",maxWidth:240}}>
            <div style={{fontWeight:800,fontSize:16,color:"#f5f5f0"}}>{cat}</div>
            <div className="mono" style={{fontSize:12,color:"#666",marginBottom:6}}>{sku||"SKU"} · {variants.filter(v=>v.size).length} size{variants.filter(v=>v.size).length!==1?"s":""}</div>
            <div style={{fontSize:13,color:"#888",marginBottom:8}}>{previewQty} units total</div>
            <span className="badge badge-green">IN STOCK</span>
          </div>
        </div>
      )}
      <button onClick={save} disabled={saving}
        style={{background:saving?"#555":"linear-gradient(135deg,#FFD700,#c9a84c)",color:saving?"#999":"#000",fontWeight:900,
          fontSize:16,letterSpacing:2,textTransform:"uppercase",padding:"13px 28px",border:"none",borderRadius:4}}>
        {saving?"Saving…":"Save Product"}
      </button>
    </div>
  );
}

// ─── Adjustments ─────────────────────────────────────────────────────────────
function Adjustments({ stock, user, toast, log, refreshAll }) {
  const [prodId, setProdId] = useState("");
  const [size, setSize] = useState("");
  const [adjType, setAdjType] = useState("Receive");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const adjTypes = [{key:"Receive",icon:"➕"},{key:"Write-off",icon:"➖"},{key:"Free Issue",icon:"🎁"},{key:"Return",icon:"↩"}];
  const selProd = stock.find(p=>p.id===prodId);
  const selVariant = selProd?.variants.find(v=>v.size===size);

  const apply = async () => {
    if (!prodId||!size||!qty) { toast("✗ Select product, size and quantity","error"); return; }
    const n = parseInt(qty);
    if (!n||n<1) { toast("✗ Invalid quantity","error"); return; }
    if (!selVariant?.id) { toast("✗ Select a valid product and size","error"); return; }
    const delta = (adjType==="Write-off"||adjType==="Free Issue") ? -n : n;
    const before = selVariant.qty;
    setSaving(true);
    try {
      const after = await applyAdjustmentRPC(selVariant.id, delta, adjType, note.trim(), user.username);
      await refreshAll();
      toast(`✓ Adjustment applied — ${selProd.category} ${size}: ${before} → ${after}`,"success");
      setQty(""); setNote("");
    } catch (err) {
      console.error("Adjustment failed:", err);
      if (isStockError(err)) toast(`✗ Not enough stock — only ${before} on hand`,"error");
      else toast(`✗ Couldn't save — ${err?.message || "unknown error"}`,"error");
    }
    setSaving(false);
  };

  return (
    <div className="adj-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24}}>
      <div>
        <div style={{marginBottom:14}}>
          <label className="sec-label">Product</label>
          <select className="field-input" value={prodId} onChange={e=>{setProdId(e.target.value);setSize("");}}>
            <option value="">Select product…</option>
            {stock.map(p=><option key={p.id} value={p.id}>{p.category}</option>)}
          </select>
        </div>
        <div style={{marginBottom:14}}>
          <label className="sec-label">Size</label>
          <select className="field-input" value={size} onChange={e=>setSize(e.target.value)} disabled={!selProd}>
            <option value="">Select size…</option>
            {selProd?.variants.map(v=><option key={v.size} value={v.size}>{v.size} ({v.qty} in stock)</option>)}
          </select>
        </div>
        <div style={{marginBottom:14}}>
          <label className="sec-label">Adjustment Type</label>
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:4}}>
            {adjTypes.map(t=>(
              <button key={t.key} className={`pill-btn ${adjType===t.key?"active":""}`} onClick={()=>setAdjType(t.key)}>
                {t.icon} {t.key}
              </button>
            ))}
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <label className="sec-label">Quantity</label>
          <input className="field-input" type="number" min="1" value={qty} onChange={e=>setQty(e.target.value)} style={{fontFamily:"'JetBrains Mono'"}} />
        </div>
        <div style={{marginBottom:20}}>
          <label className="sec-label">Note / Reason (optional)</label>
          <input className="field-input" placeholder="e.g. Received from supplier" value={note} onChange={e=>setNote(e.target.value)} />
        </div>
        <button onClick={apply} disabled={saving}
          style={{background:saving?"#555":"linear-gradient(135deg,#FFD700,#c9a84c)",color:saving?"#999":"#000",fontWeight:900,
            fontSize:16,letterSpacing:2,textTransform:"uppercase",padding:"13px 28px",border:"none",borderRadius:4}}>
          {saving?"Applying…":"Apply Adjustment"}
        </button>
      </div>
      <div>
        <p className="sec-label" style={{marginBottom:10}}>Adjustment Log</p>
        {log.length===0
          ? <p style={{color:"#444",fontSize:14}}>No adjustments yet.</p>
          : <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {log.map(e=>(
                <div key={e.id} style={{background:"#141414",border:"1px solid #2a2a2a",borderRadius:6,padding:"10px 14px",fontSize:13}}>
                  <div className="mono" style={{color:"#666",fontSize:11,marginBottom:3}}>{e.ts}</div>
                  <div style={{color:"#d0d0c8"}}>
                    <strong>{e.product}</strong> / {e.size}
                    <span style={{color:e.delta>0?"#27ae60":"#c0392b",fontWeight:700,marginLeft:8}}>
                      {e.delta>0?"+":""}{e.delta}
                    </span>
                    <span style={{color:"#666",marginLeft:4}}>({e.adjType}{e.note?" — "+e.note:""})</span>
                  </div>
                  <div style={{color:"#555",fontSize:11,marginTop:2}}>by {e.cashier}</div>
                </div>
              ))}
            </div>
        }
      </div>
    </div>
  );
}

// ─── Stock Take ───────────────────────────────────────────────────────────────
function StockTake({ stock, user, toast, refreshAll }) {
  const [counts, setCounts] = useState({});
  const [committed, setCommitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const setCount = (pid,size,val) => setCounts(p=>({...p,[`${pid}-${size}`]:val}));

  const allLines = stock.flatMap(p=>p.variants.map(v=>({pid:p.id,cat:p.category,size:v.size,sys:v.qty})));
  const checked = allLines.filter(l=>counts[`${l.pid}-${l.size}`]!==""&&counts[`${l.pid}-${l.size}`]!==undefined);
  const variances = checked.map(l=>(parseInt(counts[`${l.pid}-${l.size}`])||0)-l.sys).filter(v=>v!==0);
  const deficit = variances.filter(v=>v<0).reduce((s,v)=>s+v,0);
  const surplus = variances.filter(v=>v>0).reduce((s,v)=>s+v,0);

  const commit = async () => {
    setSaving(true);
    try {
      await Promise.all(checked.map(l => {
        const variant = stock.find(p=>p.id===l.pid)?.variants.find(v=>v.size===l.size);
        const newQty = Math.max(0, parseInt(counts[`${l.pid}-${l.size}`])||0);
        return setStockTakeRPC(variant.id, newQty, user.username);
      }));
      await refreshAll();
      setCommitted(true);
      toast(`✓ Stock take committed — ${checked.length} lines updated at ${timeStr()}`,"success");
    } catch (err) {
      console.error("Stock take failed:", err);
      toast(`✗ Couldn't commit — ${err?.message || "unknown error"}`,"error");
    }
    setSaving(false);
  };

  return (
    <div>
      <p style={{fontWeight:700,fontSize:16,color:"#f5f5f0",marginBottom:16}}>Daily Stock Take — {dateStr()}</p>
      <div style={{overflowX:"auto"}}>
        <table className="tbl">
          <thead><tr>
            <th>Product</th><th>Size</th>
            <th style={{textAlign:"right"}}>System Qty</th>
            <th style={{textAlign:"center"}}>Physical Count</th>
            <th style={{textAlign:"right"}}>Variance</th>
          </tr></thead>
          <tbody>
            {stock.map(p=>p.variants.map(v=>{
              const key=`${p.id}-${v.size}`;
              const raw=counts[key];
              const has=raw!==undefined&&raw!=="";
              const phys=has?parseInt(raw)||0:null;
              const variance=phys!==null?phys-v.qty:null;
              return (
                <tr key={key}>
                  <td style={{fontWeight:600,color:"#d0d0c8"}}>{p.category}</td>
                  <td>{v.size}</td>
                  <td className="mono" style={{textAlign:"right"}}>{v.qty}</td>
                  <td style={{textAlign:"center"}}>
                    <input className="st-input" type="number" min="0" placeholder="—"
                      value={raw??""}
                      onChange={e=>setCount(p.id,v.size,e.target.value)} />
                  </td>
                  <td className="mono" style={{textAlign:"right",fontWeight:700,
                    color:variance===null?"#555":variance===0?"#27ae60":variance>0?"#e67e22":"#c0392b"}}>
                    {variance===null?"—":variance===0?"✓":(variance>0?"+":"")+variance}
                  </td>
                </tr>
              );
            }))}
          </tbody>
        </table>
      </div>
      <div style={{background:"#141414",border:"1px solid #2a2a2a",borderRadius:6,padding:"12px 16px",margin:"16px 0",
        fontSize:13,color:"#888",display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <span>{checked.length} of {allLines.length} lines checked</span>
        <span>
          {variances.length} variance{variances.length!==1?"s":""} found
          {deficit!==0&&<span style={{color:"#c0392b"}}> ({deficit} deficit</span>}
          {surplus!==0&&<span style={{color:"#e67e22"}}>{deficit!==0?", ":" ("} +{surplus} surplus</span>}
          {(deficit!==0||surplus!==0)&&")"}
        </span>
      </div>
      <button onClick={commit} disabled={committed||!checked.length||saving}
        style={{background:committed||!checked.length||saving?"#333":"#27ae60",
          color:committed||!checked.length||saving?"#555":"#fff",fontWeight:900,fontSize:16,
          letterSpacing:2,textTransform:"uppercase",padding:"13px 28px",border:"none",borderRadius:4}}>
        {committed?"✓ Committed":saving?"Committing…":"✓ Commit Stock Take"}
      </button>
    </div>
  );
}

// ─── Loan / Borrow ──────────────────────────────────────────────────────────
function LoanBorrow({ stock, user, toast, loans, refreshAll }) {
  const [prodId, setProdId] = useState("");
  const [size, setSize] = useState("");
  const [qty, setQty] = useState("");
  const [borrower, setBorrower] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [payMethod, setPayMethod] = useState({}); // loanId -> "cash"|"card", for the invoice step

  const selProd = stock.find(p=>p.id===prodId);
  const selVariant = selProd?.variants.find(v=>v.size===size);

  const bookOut = async () => {
    if (!prodId||!size||!qty||!borrower.trim()) { toast("✗ Select product, size, quantity and who it's going to","error"); return; }
    const n = parseInt(qty);
    if (!n||n<1) { toast("✗ Invalid quantity","error"); return; }
    if (!selVariant?.id) { toast("✗ Select a valid product and size","error"); return; }
    setSaving(true);
    try {
      await createLoanRPC(selVariant.id, n, borrower.trim(), note.trim(), user.username);
      await refreshAll();
      toast(`✓ Booked out — ${n} × ${selProd.category} ${size} to ${borrower.trim()}`,"success");
      setQty(""); setBorrower(""); setNote("");
    } catch (err) {
      if (isStockError(err)) toast(`✗ Not enough stock — only ${selVariant.qty} on hand`,"error");
      else toast(`✗ Couldn't save — ${err?.message || "unknown error"}`,"error");
    }
    setSaving(false);
  };

  const markReturned = async (loan) => {
    if (!window.confirm(`Mark ${loan.qty} × ${loan.category} ${loan.size} as returned by ${loan.borrower}? This adds it back to stock.`)) return;
    try {
      await returnLoanRPC(loan.id, user.username);
      await refreshAll();
      toast(`✓ Returned — ${loan.qty} × ${loan.category} ${loan.size} back in stock`,"success");
    } catch (err) {
      toast(`✗ Couldn't save — ${err?.message || "unknown error"}`,"error");
    }
  };

  const convertToInvoice = async (loan) => {
    const method = payMethod[loan.id] || "cash";
    if (!window.confirm(`Not returned — invoice ${loan.borrower} for ${loan.qty} × ${loan.category} ${loan.size} (${fmt(loan.price*loan.qty)}, ${method})? Stock stays as-is — it's already booked out.`)) return;
    try {
      const invId = await invoiceLoanRPC(loan.id, user.username, method);
      await refreshAll();
      toast(`✓ Invoiced — ${invId}`,"success");
    } catch (err) {
      toast(`✗ Couldn't save — ${err?.message || "unknown error"}`,"error");
    }
  };

  const open = loans.filter(l=>l.status==="out");
  const resolved = loans.filter(l=>l.status!=="out");

  return (
    <div className="adj-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24}}>
      <div>
        <p style={{fontSize:13,color:"#888",marginBottom:16,maxWidth:420}}>
          Book stock out on loan — it comes off the shelf straight away. When it's resolved, mark it either
          <strong> Returned</strong> (back into stock) or <strong>Invoice</strong> (kept, becomes a real sale —
          stock doesn't move again since it already left when booked out).
        </p>
        <div style={{marginBottom:14}}>
          <label className="sec-label">Product</label>
          <select className="field-input" value={prodId} onChange={e=>{setProdId(e.target.value);setSize("");}}>
            <option value="">Select product…</option>
            {stock.map(p=><option key={p.id} value={p.id}>{p.category}</option>)}
          </select>
        </div>
        <div style={{marginBottom:14}}>
          <label className="sec-label">Size</label>
          <select className="field-input" value={size} onChange={e=>setSize(e.target.value)} disabled={!selProd}>
            <option value="">Select size…</option>
            {selProd?.variants.map(v=><option key={v.size} value={v.size}>{v.size} ({v.qty} in stock)</option>)}
          </select>
        </div>
        <div style={{marginBottom:14}}>
          <label className="sec-label">Quantity</label>
          <input className="field-input" type="number" min="1" value={qty} onChange={e=>setQty(e.target.value)} style={{fontFamily:"'JetBrains Mono'"}} />
        </div>
        <div style={{marginBottom:14}}>
          <label className="sec-label">Borrower / Going To</label>
          <input className="field-input" placeholder="e.g. Site foreman, Acme Construction" value={borrower} onChange={e=>setBorrower(e.target.value)} />
        </div>
        <div style={{marginBottom:20}}>
          <label className="sec-label">Note (optional)</label>
          <input className="field-input" placeholder="e.g. Expected back Friday" value={note} onChange={e=>setNote(e.target.value)} />
        </div>
        <button onClick={bookOut} disabled={saving}
          style={{background:saving?"#555":"linear-gradient(135deg,#FFD700,#c9a84c)",color:saving?"#999":"#000",fontWeight:900,
            fontSize:16,letterSpacing:2,textTransform:"uppercase",padding:"13px 28px",border:"none",borderRadius:4}}>
          {saving?"Booking out…":"Book Stock Out"}
        </button>
      </div>

      <div>
        <p className="sec-label" style={{marginBottom:10}}>Currently Out ({open.length})</p>
        {open.length===0
          ? <p style={{color:"#444",fontSize:14,marginBottom:24}}>Nothing out on loan right now.</p>
          : <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:28}}>
              {open.map(l=>(
                <div key={l.id} style={{background:"#141414",border:"1px solid #e67e22",borderRadius:6,padding:"12px 14px"}}>
                  <div style={{color:"#d0d0c8",fontSize:14,marginBottom:2}}>
                    <strong>{l.qty} × {l.category}</strong> / {l.size} — to <strong>{l.borrower}</strong>
                  </div>
                  {l.note && <div style={{color:"#888",fontSize:12,marginBottom:4}}>{l.note}</div>}
                  <div className="mono" style={{color:"#666",fontSize:11,marginBottom:8}}>Booked out {l.createdAt} by {l.cashier}</div>
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <button onClick={()=>markReturned(l)}
                      style={{background:"#27ae60",color:"#fff",border:"none",borderRadius:4,padding:"7px 14px",fontWeight:700,fontSize:12}}>
                      ✓ Mark Returned
                    </button>
                    <select value={payMethod[l.id]||"cash"} onChange={e=>setPayMethod(p=>({...p,[l.id]:e.target.value}))}
                      className="field-input" style={{width:"auto",padding:"6px 8px",fontSize:12}}>
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                    </select>
                    <button onClick={()=>convertToInvoice(l)}
                      style={{background:"#222",color:"#c9a84c",border:"1px solid #c9a84c",borderRadius:4,padding:"7px 14px",fontWeight:700,fontSize:12}}>
                      🧾 Invoice ({fmt(l.price*l.qty)})
                    </button>
                  </div>
                </div>
              ))}
            </div>
        }

        <p className="sec-label" style={{marginBottom:10}}>Resolved</p>
        {resolved.length===0
          ? <p style={{color:"#444",fontSize:14}}>Nothing resolved yet.</p>
          : <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {resolved.map(l=>(
                <div key={l.id} style={{background:"#141414",border:"1px solid #2a2a2a",borderRadius:6,padding:"10px 14px",fontSize:13}}>
                  <span style={{color:"#d0d0c8"}}>{l.qty} × {l.category} / {l.size} — {l.borrower}</span>
                  <span className={`badge ${l.status==="returned"?"badge-green":"badge-gold"}`} style={{marginLeft:8}}>
                    {l.status==="returned"?"RETURNED":`INVOICED ${l.saleId||""}`}
                  </span>
                  <div style={{color:"#555",fontSize:11,marginTop:2}}>by {l.resolvedBy} · {l.resolvedAt}</div>
                </div>
              ))}
            </div>
        }
      </div>
    </div>
  );
}

// ─── Stock Screen ─────────────────────────────────────────────────────────────
function StockScreen({ stock, user, toast, adjLog, loans, refreshAll, eventId }) {
  const [tab, setTab] = useState("view");
  const tabs = [{key:"view",label:"📦 View Stock"},{key:"add",label:"➕ Add Product"},{key:"adjust",label:"🔧 Adjustments"},
    {key:"take",label:"📋 Stock Take"},{key:"loan",label:"🤝 Loan / Borrow"}];
  return (
    <div style={{padding:24}}>
      <div className="stock-tab-bar" style={{display:"flex",gap:4,marginBottom:24,borderBottom:"1px solid #2a2a2a",overflowX:"auto"}}>
        {tabs.map(t=>(
          <button key={t.key} onClick={()=>setTab(t.key)}
            style={{background:tab===t.key?"#c9a84c":"#222",color:tab===t.key?"#000":"#888",
              border:"none",borderRadius:"4px 4px 0 0",padding:"10px 20px",fontWeight:700,
              fontSize:14,letterSpacing:.5,whiteSpace:"nowrap",flexShrink:0}}>
            {t.label}
          </button>
        ))}
      </div>
      {tab==="view"   &&<ViewStock stock={stock} />}
      {tab==="add"    &&<AddProduct toast={toast} refreshAll={refreshAll} eventId={eventId} />}
      {tab==="adjust" &&<Adjustments stock={stock} user={user} toast={toast} log={adjLog} refreshAll={refreshAll} />}
      {tab==="take"   &&<StockTake stock={stock} user={user} toast={toast} refreshAll={refreshAll} />}
      {tab==="loan"   &&<LoanBorrow stock={stock} user={user} toast={toast} loans={loans} refreshAll={refreshAll} />}
    </div>
  );
}

// ─── Sales Screen ─────────────────────────────────────────────────────────────
function SalesScreen({ sales, onView }) {
  const rev = sales.reduce((s,sale)=>s+sale.total,0);
  const units = sales.reduce((s,sale)=>s+sale.items.reduce((ss,i)=>ss+i.qty,0),0);
  return (
    <div style={{padding:24}}>
      <div className="stats-grid" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,marginBottom:28}}>
        {[{l:"INVOICES",v:String(sales.length)},{l:"REVENUE",v:fmt(rev)},{l:"UNITS SOLD",v:String(units)}].map(c=>(
          <div key={c.l} style={{background:"#141414",border:"1px solid #2a2a2a",borderRadius:8,padding:"20px 24px"}}>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:2,color:"#666",textTransform:"uppercase",marginBottom:8}}>{c.l}</div>
            <div className="mono" style={{fontSize:28,fontWeight:700,color:"#c9a84c"}}>{c.v}</div>
          </div>
        ))}
      </div>
      {sales.length===0
        ? <p style={{color:"#444",textAlign:"center",padding:40}}>No sales yet. Complete a sale from the POS screen.</p>
        : <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {[...sales].reverse().map(sale=>{
              const u=sale.items.reduce((s,i)=>s+i.qty,0);
              return (
                <div key={sale.id} onClick={()=>onView(sale)}
                  onMouseEnter={e=>e.currentTarget.style.borderColor="#c9a84c"}
                  onMouseLeave={e=>e.currentTarget.style.borderColor="#2a2a2a"}
                  style={{background:"#141414",border:"1px solid #2a2a2a",borderRadius:6,
                    padding:"12px 16px",cursor:"pointer",display:"flex",alignItems:"center",
                    gap:12,flexWrap:"wrap",transition:"border-color .15s"}}>
                  <span className="mono" style={{color:"#c9a84c",fontWeight:700,minWidth:110}}>{sale.id}</span>
                  <span style={{color:"#888",fontSize:13,minWidth:100}}>{sale.date}</span>
                  <span style={{color:"#888",fontSize:13,minWidth:60}}>{sale.cashier}</span>
                  <span style={{color:"#d0d0c8",fontSize:14,flex:1}}>
                    {sale.client.name}{sale.client.company?` (${sale.client.company})`:""}</span>
                  <span style={{color:"#888",fontSize:13}}>{u} item{u!==1?"s":""}</span>
                  <span className={`badge ${sale.paymentMethod==="card"?"badge-blue":"badge-green"}`} style={{fontSize:10}}>
                    {sale.paymentMethod==="card"?"💳 CARD":"💵 CASH"}
                  </span>
                  <span className="mono" style={{color:"#c9a84c",fontWeight:700}}>{fmt(sale.total)}</span>
                  <span style={{color:"#666",fontSize:12,fontWeight:700,letterSpacing:1}}>VIEW →</span>
                </div>
              );
            })}
          </div>
      }
    </div>
  );
}

// ─── Reconcile ────────────────────────────────────────────────────────────────
function readBackupFile(file, onDone, onError) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data.stock) || !Array.isArray(data.sales)) throw new Error("bad shape");
      onDone(data);
    } catch { onError(); }
  };
  reader.onerror = onError;
  reader.readAsText(file);
}

const stockKey = item => `${item.category}::${item.sku||""}::${item.size}`;

function flattenStock(stockArr) {
  const map = {};
  (stockArr||[]).forEach(p => p.variants.forEach(v => {
    map[stockKey({category:p.category,sku:p.sku,size:v.size})] = { category:p.category, sku:p.sku, size:v.size, qty:v.qty };
  }));
  return map;
}

function buildReconciliation(openingData, closingStock, closingSales) {
  const openMap = flattenStock(openingData.stock);
  const closeMap = flattenStock(closingStock);
  const openIds = new Set((openingData.sales||[]).map(s=>s.id));
  const newSales = (closingSales||[]).filter(s => !openIds.has(s.id));

  const soldMap = {};
  const cashierMap = {};
  const paymentMap = { cash:{units:0,revenue:0,invoices:0}, card:{units:0,revenue:0,invoices:0} };
  newSales.forEach(sale => {
    cashierMap[sale.cashier] = cashierMap[sale.cashier] || { units:0, revenue:0, invoices:0 };
    cashierMap[sale.cashier].revenue += sale.total;
    cashierMap[sale.cashier].invoices += 1;
    const pm = sale.paymentMethod==="card" ? "card" : "cash";
    paymentMap[pm].revenue += sale.total;
    paymentMap[pm].invoices += 1;
    sale.items.forEach(item => {
      const k = stockKey(item);
      soldMap[k] = (soldMap[k]||0) + item.qty;
      cashierMap[sale.cashier].units += item.qty;
      paymentMap[pm].units += item.qty;
    });
  });

  const allKeys = new Set([...Object.keys(openMap), ...Object.keys(closeMap), ...Object.keys(soldMap)]);
  const rows = [...allKeys].map(k => {
    const o = openMap[k], c = closeMap[k];
    const ref = o||c||{};
    const openQty = o?o.qty:0, closeQty = c?c.qty:0;
    const depleted = openQty-closeQty;
    const sold = soldMap[k]||0;
    return { category:ref.category, sku:ref.sku, size:ref.size, openQty, closeQty, depleted, sold, variance:depleted-sold };
  }).sort((a,b)=> a.category.localeCompare(b.category) || a.size.localeCompare(b.size));

  const totals = rows.reduce((t,r)=>({
    depleted:t.depleted+r.depleted, sold:t.sold+r.sold, variance:t.variance+r.variance
  }), {depleted:0,sold:0,variance:0});
  const revenue = newSales.reduce((s,sale)=>s+sale.total,0);

  return { rows, totals, revenue, cashierMap, paymentMap, newSalesCount: newSales.length };
}

// Straight "where do things stand right now" report — every sale currently on
// record, cash/card and per-staff breakdowns, and current stock on hand.
// Needs no opening backup, since it's not computing a before/after variance.
function buildSummary(stock, sales, loans) {
  const soldMap = {};
  const cashierMap = {};
  const paymentMap = { cash:{units:0,revenue:0,invoices:0}, card:{units:0,revenue:0,invoices:0} };
  sales.forEach(sale => {
    cashierMap[sale.cashier] = cashierMap[sale.cashier] || { units:0, revenue:0, invoices:0 };
    cashierMap[sale.cashier].revenue += sale.total;
    cashierMap[sale.cashier].invoices += 1;
    const pm = sale.paymentMethod==="card" ? "card" : "cash";
    paymentMap[pm].revenue += sale.total;
    paymentMap[pm].invoices += 1;
    sale.items.forEach(item => {
      const k = stockKey(item);
      soldMap[k] = (soldMap[k]||0) + item.qty;
      cashierMap[sale.cashier].units += item.qty;
      paymentMap[pm].units += item.qty;
    });
  });

  const openLoans = (loans||[]).filter(l=>l.status==="out");
  const loanMap = {};
  openLoans.forEach(l => {
    const k = stockKey(l);
    loanMap[k] = (loanMap[k]||0) + l.qty;
  });

  const rows = [];
  stock.forEach(p => p.variants.forEach(v => {
    const k = stockKey({category:p.category, sku:p.sku, size:v.size});
    rows.push({ category:p.category, sku:p.sku, size:v.size, sold: soldMap[k]||0, remaining: v.qty, onLoan: loanMap[k]||0 });
  }));
  rows.sort((a,b)=> a.category.localeCompare(b.category) || a.size.localeCompare(b.size));

  const totals = rows.reduce((t,r)=>({ sold:t.sold+r.sold, remaining:t.remaining+r.remaining, onLoan:t.onLoan+r.onLoan }), {sold:0,remaining:0,onLoan:0});
  const revenue = sales.reduce((s,sale)=>s+sale.total,0);

  return { rows, totals, revenue, cashierMap, paymentMap, invoiceCount: sales.length, openLoans };
}

function Reconcile({ stock, sales, loans, toast, event }) {
  const [mode, setMode] = useState("summary"); // "summary" (no file needed) | "variance" (opening vs closing)
  const [opening, setOpening] = useState(null);
  const [openingName, setOpeningName] = useState("");
  const [closingSource, setClosingSource] = useState("live"); // "live" | "file"
  const [closing, setClosing] = useState(null);
  const [closingName, setClosingName] = useState("");

  const onFile = (setData, setName) => e => {
    const file = e.target.files[0];
    if (!file) return;
    readBackupFile(file,
      data => {
        setData(data); setName(file.name);
        if (data.eventId && event?.id && data.eventId !== event.id) {
          toast(`⚠ Loaded ${file.name} — but it's from a DIFFERENT event (${data.eventName||"unknown"}), not "${event.name}". Numbers won't line up.`,"error");
        } else {
          toast(`✓ Loaded ${file.name}`,"success");
        }
      },
      () => toast("✗ Couldn't read that file — is it a valid IMPI POS backup .json?","error"));
  };

  const closingStock = closingSource==="live" ? stock : closing?.stock;
  const closingSales = closingSource==="live" ? sales : closing?.sales;
  const ready = opening && closingStock && closingSales;
  const result = ready ? buildReconciliation(opening, closingStock, closingSales) : null;
  const summary = mode==="summary" ? buildSummary(stock, sales, loans) : null;
  const openLoansList = (loans||[]).filter(l=>l.status==="out");

  const printSummary = () => {
    if (!summary) return;
    const rowsHtml = summary.rows.map(r=>
      `<tr><td>${r.category}</td><td>${r.size}</td><td class="right">${r.sold}</td><td class="right">${r.onLoan}</td><td class="right">${r.remaining}</td></tr>`).join("");
    const cashierHtml = Object.entries(summary.cashierMap).map(([name,c])=>
      `<tr><td>${name}</td><td class="right">${c.invoices}</td><td class="right">${c.units}</td><td class="right">${fmt(c.revenue)}</td></tr>`).join("");
    const paymentHtml = Object.entries(summary.paymentMap).map(([method,c])=>
      `<tr><td>${method==="card"?"Card":"Cash"}</td><td class="right">${c.invoices}</td><td class="right">${c.units}</td><td class="right">${fmt(c.revenue)}</td></tr>`).join("");
    const loansHtml = summary.openLoans.map(l=>
      `<tr><td>${l.category}</td><td>${l.size}</td><td class="right">${l.qty}</td><td>${l.borrower}</td><td>${l.createdAt}</td><td>${l.note||""}</td></tr>`).join("");
    const html = `<!DOCTYPE html><html><head><title>Sales Summary</title><style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:Arial,sans-serif;background:#fff;color:#111;padding:40px;max-width:900px;margin:0 auto;}
table{width:100%;border-collapse:collapse;margin:16px 0 28px;}
th{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:6px 8px;border-bottom:2px solid #111;text-align:left;}
td{padding:7px 8px;border-bottom:1px solid #ddd;font-size:13px;}
.right{text-align:right;}
h1{font-size:22px;margin-bottom:4px;}
h2{font-size:14px;color:#555;margin-bottom:20px;font-weight:400;}
</style></head><body>
<h1>IMPI RMS (Pty) Ltd — Sales Summary</h1>
<h2>As at ${new Date().toLocaleString("en-ZA")}</h2>
<p style="margin-bottom:4px;"><strong>Invoices:</strong> ${summary.invoiceCount}</p>
<p style="margin-bottom:4px;"><strong>Total units sold:</strong> ${summary.totals.sold}</p>
<p style="margin-bottom:4px;"><strong>Total units currently on loan:</strong> ${summary.totals.onLoan}</p>
<p style="margin-bottom:4px;"><strong>Total units remaining on hand:</strong> ${summary.totals.remaining}</p>
<p style="margin-bottom:20px;"><strong>Total revenue:</strong> ${fmt(summary.revenue)}</p>
<h2 style="font-weight:700;color:#111;">By payment method</h2>
<table><thead><tr><th>Method</th><th class="right">Invoices</th><th class="right">Units</th><th class="right">Revenue</th></tr></thead>
<tbody>${paymentHtml}</tbody></table>
<h2 style="font-weight:700;color:#111;">By staff member</h2>
<table><thead><tr><th>Cashier</th><th class="right">Invoices</th><th class="right">Units</th><th class="right">Revenue</th></tr></thead>
<tbody>${cashierHtml}</tbody></table>
<h2 style="font-weight:700;color:#111;">Stock sold vs. on loan vs. on hand</h2>
<table><thead><tr><th>Category</th><th>Size</th><th class="right">Sold</th><th class="right">On Loan</th><th class="right">Remaining</th></tr></thead>
<tbody>${rowsHtml}</tbody></table>
${summary.openLoans.length>0?`<h2 style="font-weight:700;color:#111;">Currently on loan — reference</h2>
<table><thead><tr><th>Category</th><th>Size</th><th class="right">Qty</th><th>Borrower</th><th>Booked Out</th><th>Note</th></tr></thead>
<tbody>${loansHtml}</tbody></table>`:""}
<script>window.print();<\/script>
</body></html>`;
    const w = window.open("","_blank");
    w.document.write(html); w.document.close();
  };

  const printReport = () => {
    if (!result) return;
    const rowsHtml = result.rows.map(r=>`<tr style="${r.variance!==0?'background:#ffeeee;':''}">
      <td>${r.category}</td><td>${r.size}</td><td class="right">${r.openQty}</td><td class="right">${r.closeQty}</td>
      <td class="right">${r.depleted}</td><td class="right">${r.sold}</td>
      <td class="right" style="font-weight:700;${r.variance!==0?'color:#c0392b;':''}">${r.variance}</td></tr>`).join("");
    const cashierHtml = Object.entries(result.cashierMap).map(([name,c])=>
      `<tr><td>${name}</td><td class="right">${c.invoices}</td><td class="right">${c.units}</td><td class="right">${fmt(c.revenue)}</td></tr>`).join("");
    const paymentHtml = Object.entries(result.paymentMap).map(([method,c])=>
      `<tr><td>${method==="card"?"Card":"Cash"}</td><td class="right">${c.invoices}</td><td class="right">${c.units}</td><td class="right">${fmt(c.revenue)}</td></tr>`).join("");
    const html = `<!DOCTYPE html><html><head><title>Stock Reconciliation</title><style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:Arial,sans-serif;background:#fff;color:#111;padding:40px;max-width:900px;margin:0 auto;}
table{width:100%;border-collapse:collapse;margin:16px 0 28px;}
th{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:6px 8px;border-bottom:2px solid #111;text-align:left;}
td{padding:7px 8px;border-bottom:1px solid #ddd;font-size:13px;}
.right{text-align:right;}
h1{font-size:22px;margin-bottom:4px;}
h2{font-size:14px;color:#555;margin-bottom:20px;font-weight:400;}
</style></head><body>
<h1>IMPI RMS (Pty) Ltd — Stock Reconciliation Report</h1>
<h2>Opening: ${openingName || "n/a"} (${opening.exportedAt||""}) &nbsp;→&nbsp; Closing: ${closingSource==="live"?"Live data at "+new Date().toISOString():closingName}</h2>
<p style="margin-bottom:4px;"><strong>Total units depleted from stock:</strong> ${result.totals.depleted}</p>
<p style="margin-bottom:4px;"><strong>Total units recorded as sold:</strong> ${result.totals.sold}</p>
<p style="margin-bottom:4px;"><strong>Variance:</strong> ${result.totals.variance} ${result.totals.variance!==0?"⚠ investigate":"✓ matches"}</p>
<p style="margin-bottom:20px;"><strong>Revenue recorded:</strong> ${fmt(result.revenue)}</p>
<h2 style="font-weight:700;color:#111;">By payment method</h2>
<table><thead><tr><th>Method</th><th class="right">Invoices</th><th class="right">Units</th><th class="right">Revenue</th></tr></thead>
<tbody>${paymentHtml}</tbody></table>
<h2 style="font-weight:700;color:#111;">By staff member</h2>
<table><thead><tr><th>Cashier</th><th class="right">Invoices</th><th class="right">Units</th><th class="right">Revenue</th></tr></thead>
<tbody>${cashierHtml}</tbody></table>
<h2 style="font-weight:700;color:#111;">By product / size</h2>
<table><thead><tr><th>Category</th><th>Size</th><th class="right">Opening</th><th class="right">Closing</th>
<th class="right">Depleted</th><th class="right">Recorded Sold</th><th class="right">Variance</th></tr></thead>
<tbody>${rowsHtml}</tbody></table>
<script>window.print();<\/script>
</body></html>`;
    const w = window.open("","_blank");
    w.document.write(html); w.document.close();
  };

  return (
    <div style={{padding:24,maxWidth:1000,margin:"0 auto"}}>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        <button className={`pill-btn ${mode==="summary"?"active":""}`} onClick={()=>setMode("summary")}>📊 Sales Summary (no file needed)</button>
        <button className={`pill-btn ${mode==="variance"?"active":""}`} onClick={()=>setMode("variance")}>🔍 Variance Check (opening vs closing)</button>
      </div>

      {mode==="summary" && (
        <>
          <p style={{fontSize:13,color:"#888",marginBottom:20,maxWidth:640}}>
            Every sale currently on record — cash vs card, per staff member, and what's been sold vs what's
            still on hand — pulled straight from live data. Nothing to upload.
          </p>
          <div className="stats-grid" style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:16,marginBottom:24}}>
            {[
              {l:"INVOICES",v:String(summary.invoiceCount)},
              {l:"UNITS SOLD",v:String(summary.totals.sold)},
              {l:"ON LOAN",v:String(summary.totals.onLoan),loan:summary.totals.onLoan>0},
              {l:"UNITS ON HAND",v:String(summary.totals.remaining)},
              {l:"TOTAL REVENUE",v:fmt(summary.revenue)},
            ].map(c=>(
              <div key={c.l} style={{background:"#141414",border:`1px solid ${c.loan?"#e67e22":"#2a2a2a"}`,borderRadius:8,padding:"18px 20px"}}>
                <div style={{fontSize:11,fontWeight:700,letterSpacing:2,color:"#666",textTransform:"uppercase",marginBottom:6}}>{c.l}</div>
                <div className="mono" style={{fontSize:24,fontWeight:700,color:c.loan?"#e67e22":"#c9a84c"}}>{c.v}</div>
              </div>
            ))}
          </div>

          <button onClick={printSummary}
            style={{background:"#222",color:"#d0d0c8",border:"1px solid #333",borderRadius:4,
              padding:"10px 18px",fontSize:14,fontWeight:700,marginBottom:24}}>
            🖨 Print / Save Report
          </button>

          <p className="sec-label" style={{marginBottom:10}}>By Payment Method</p>
          <div style={{overflowX:"auto",marginBottom:28}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>{["Method","Invoices","Units","Revenue"].map((h,i)=>(
                <th key={h} style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,
                  color:"#666",padding:"8px",borderBottom:"2px solid #333",textAlign:i>0?"right":"left"}}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {Object.entries(summary.paymentMap).map(([method,c])=>(
                  <tr key={method}>
                    <td style={{padding:"8px",borderBottom:"1px solid #222",color:"#d0d0c8"}}>{method==="card"?"💳 Card":"💵 Cash"}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{c.invoices}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{c.units}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#c9a84c",fontWeight:700}}>{fmt(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="sec-label" style={{marginBottom:10}}>By Staff Member</p>
          <div style={{overflowX:"auto",marginBottom:28}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>{["Cashier","Invoices","Units","Revenue"].map((h,i)=>(
                <th key={h} style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,
                  color:"#666",padding:"8px",borderBottom:"2px solid #333",textAlign:i>0?"right":"left"}}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {Object.entries(summary.cashierMap).map(([name,c])=>(
                  <tr key={name}>
                    <td style={{padding:"8px",borderBottom:"1px solid #222",color:"#d0d0c8"}}>{name}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{c.invoices}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{c.units}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#c9a84c",fontWeight:700}}>{fmt(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="sec-label" style={{marginBottom:10}}>Stock Sold vs. On Loan vs. On Hand</p>
          <div style={{overflowX:"auto",marginBottom:28}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>{["Category","Size","Sold","On Loan","Remaining"].map((h,i)=>(
                <th key={h} style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,
                  color:"#666",padding:"8px",borderBottom:"2px solid #333",textAlign:i>1?"right":"left"}}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {summary.rows.map((r,i)=>(
                  <tr key={i}>
                    <td style={{padding:"8px",borderBottom:"1px solid #222",color:"#d0d0c8"}}>{r.category}</td>
                    <td style={{padding:"8px",borderBottom:"1px solid #222",color:"#888"}}>{r.size}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{r.sold}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",
                      color:r.onLoan>0?"#e67e22":"#444",fontWeight:r.onLoan>0?700:400}}>{r.onLoan||"—"}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",
                      color:r.remaining===0?"#e67e22":"#27ae60",fontWeight:700}}>{r.remaining}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="sec-label" style={{marginBottom:10}}>Currently On Loan — Reference</p>
          {summary.openLoans.length===0
            ? <p style={{color:"#444",fontSize:14}}>Nothing out on loan right now.</p>
            : <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {summary.openLoans.map(l=>(
                  <div key={l.id} style={{background:"#141414",border:"1px solid #e67e22",borderRadius:6,padding:"10px 14px",fontSize:13}}>
                    <span style={{color:"#d0d0c8"}}><strong>{l.qty} × {l.category}</strong> / {l.size} — to <strong>{l.borrower}</strong></span>
                    {l.note && <span style={{color:"#888"}}> · {l.note}</span>}
                    <div style={{color:"#555",fontSize:11,marginTop:2}}>Booked out {l.createdAt} by {l.cashier}</div>
                  </div>
                ))}
              </div>
          }
        </>
      )}

      {mode==="variance" && (
      <>
      <p style={{fontSize:13,color:"#888",marginBottom:20,maxWidth:640}}>
        Load the backup taken at the <strong>start</strong> of the event (opening stock-take) and compare
        it against the <strong>end</strong> of the event — either the live data on this laptop right now,
        or another backup file (e.g. sent in by someone at a different location). This cross-checks stock
        depleted against what the app actually recorded as sold, per product and per staff member.
      </p>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,marginBottom:24}}>
        <div style={{background:"#141414",border:"1px solid #2a2a2a",borderRadius:8,padding:18}}>
          <p className="sec-label" style={{marginBottom:10}}>Opening Backup (required)</p>
          <input type="file" accept=".json" onChange={onFile(setOpening,setOpeningName)}
            style={{color:"#888",fontSize:13}} />
          {opening && <p style={{color:"#27ae60",fontSize:12,marginTop:8}}>✓ {openingName} — {opening.stock.length} products, {opening.sales.length} sales on record</p>}
        </div>
        <div style={{background:"#141414",border:"1px solid #2a2a2a",borderRadius:8,padding:18}}>
          <p className="sec-label" style={{marginBottom:10}}>Closing Data</p>
          <div style={{display:"flex",gap:8,marginBottom:10}}>
            <button className={`pill-btn ${closingSource==="live"?"active":""}`} onClick={()=>setClosingSource("live")}>Use live data (this laptop, now)</button>
            <button className={`pill-btn ${closingSource==="file"?"active":""}`} onClick={()=>setClosingSource("file")}>Load a backup file</button>
          </div>
          {closingSource==="file" && (
            <>
              <input type="file" accept=".json" onChange={onFile(setClosing,setClosingName)} style={{color:"#888",fontSize:13}} />
              {closing && <p style={{color:"#27ae60",fontSize:12,marginTop:8}}>✓ {closingName} — {closing.stock.length} products, {closing.sales.length} sales on record</p>}
            </>
          )}
          {closingSource==="live" && <p style={{color:"#888",fontSize:12}}>{stock.length} products, {sales.length} sales currently in this browser.</p>}
        </div>
      </div>

      {!ready && <p style={{color:"#444",textAlign:"center",padding:40}}>Load an opening backup to begin.</p>}

      {result && (
        <>
          <div className="stats-grid" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16,marginBottom:24}}>
            {[
              {l:"UNITS DEPLETED",v:String(result.totals.depleted)},
              {l:"UNITS RECORDED SOLD",v:String(result.totals.sold)},
              {l:"VARIANCE",v:String(result.totals.variance),bad:result.totals.variance!==0},
              {l:"REVENUE (NEW SALES)",v:fmt(result.revenue)},
            ].map(c=>(
              <div key={c.l} style={{background:"#141414",border:`1px solid ${c.bad?"#c0392b":"#2a2a2a"}`,borderRadius:8,padding:"18px 20px"}}>
                <div style={{fontSize:11,fontWeight:700,letterSpacing:2,color:"#666",textTransform:"uppercase",marginBottom:6}}>{c.l}</div>
                <div className="mono" style={{fontSize:24,fontWeight:700,color:c.bad?"#e74c3c":"#c9a84c"}}>{c.v}</div>
              </div>
            ))}
          </div>

          <button onClick={printReport}
            style={{background:"#222",color:"#d0d0c8",border:"1px solid #333",borderRadius:4,
              padding:"10px 18px",fontSize:14,fontWeight:700,marginBottom:24}}>
            🖨 Print / Save Report
          </button>

          <p className="sec-label" style={{marginBottom:10}}>By Payment Method</p>
          <div style={{overflowX:"auto",marginBottom:28}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>{["Method","Invoices","Units","Revenue"].map((h,i)=>(
                <th key={h} style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,
                  color:"#666",padding:"8px",borderBottom:"2px solid #333",textAlign:i>0?"right":"left"}}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {Object.entries(result.paymentMap).map(([method,c])=>(
                  <tr key={method}>
                    <td style={{padding:"8px",borderBottom:"1px solid #222",color:"#d0d0c8"}}>{method==="card"?"💳 Card":"💵 Cash"}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{c.invoices}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{c.units}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#c9a84c",fontWeight:700}}>{fmt(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="sec-label" style={{marginBottom:10}}>By Staff Member</p>
          <div style={{overflowX:"auto",marginBottom:28}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>{["Cashier","Invoices","Units","Revenue"].map((h,i)=>(
                <th key={h} style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,
                  color:"#666",padding:"8px",borderBottom:"2px solid #333",textAlign:i>0?"right":"left"}}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {Object.entries(result.cashierMap).map(([name,c])=>(
                  <tr key={name}>
                    <td style={{padding:"8px",borderBottom:"1px solid #222",color:"#d0d0c8"}}>{name}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{c.invoices}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{c.units}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#c9a84c",fontWeight:700}}>{fmt(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="sec-label" style={{marginBottom:10}}>By Product / Size</p>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>{["Category","Size","Opening","Closing","Depleted","Recorded Sold","Variance"].map((h,i)=>(
                <th key={h} style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1,
                  color:"#666",padding:"8px",borderBottom:"2px solid #333",textAlign:i>1?"right":"left"}}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {result.rows.map((r,i)=>(
                  <tr key={i} style={{background:r.variance!==0?"rgba(192,57,43,.12)":"transparent"}}>
                    <td style={{padding:"8px",borderBottom:"1px solid #222",color:"#d0d0c8"}}>{r.category}</td>
                    <td style={{padding:"8px",borderBottom:"1px solid #222",color:"#888"}}>{r.size}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{r.openQty}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{r.closeQty}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{r.depleted}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",color:"#888"}}>{r.sold}</td>
                    <td className="mono" style={{padding:"8px",borderBottom:"1px solid #222",textAlign:"right",fontWeight:700,
                      color:r.variance!==0?"#e74c3c":"#27ae60"}}>{r.variance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="sec-label" style={{marginBottom:10,marginTop:28}}>Currently On Loan — Reference</p>
          <p style={{fontSize:12,color:"#666",marginBottom:12,maxWidth:600}}>
            If a variance above looks like a shortage, check here first — some of it may simply be out on loan,
            not missing.
          </p>
          {openLoansList.length===0
            ? <p style={{color:"#444",fontSize:14}}>Nothing out on loan right now.</p>
            : <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {openLoansList.map(l=>(
                  <div key={l.id} style={{background:"#141414",border:"1px solid #e67e22",borderRadius:6,padding:"10px 14px",fontSize:13}}>
                    <span style={{color:"#d0d0c8"}}><strong>{l.qty} × {l.category}</strong> / {l.size} — to <strong>{l.borrower}</strong></span>
                    {l.note && <span style={{color:"#888"}}> · {l.note}</span>}
                    <div style={{color:"#555",fontSize:11,marginTop:2}}>Booked out {l.createdAt} by {l.cashier}</div>
                  </div>
                ))}
              </div>
          }
        </>
      )}
      </>
      )}
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [showHero, setShowHero]   = useState(true);
  const [user, setUser]           = useState(null);
  const [event, setEvent]         = useState(()=> loadLastEvent());
  const [screen, setScreen]       = useState("pos");
  const [stock, setStock]         = useState([]);
  const [sales, setSales]         = useState([]);
  const [adjLog, setAdjLog]       = useState([]);
  const [loans, setLoans]         = useState([]);
  const [invoice, setInvoice]     = useState(null);
  const [loading, setLoading]     = useState(SUPABASE_CONFIGURED);
  const [online, setOnline]       = useState(navigator.onLine);
  const [queueCount, setQueueCount] = useState(loadQueue().length);
  const [syncIssues, setSyncIssues] = useState([]);
  const { toasts, toast, dismiss } = useToast();

  useEffect(()=>{
    const s = document.createElement("style");
    s.textContent = GLOBAL_CSS;
    document.head.appendChild(s);
    return ()=>document.head.removeChild(s);
  },[]);

  // Pull the full current dataset for the SELECTED EVENT from the shared
  // backend. This is the single source of truth for every device working on
  // this event — local state always defers to this.
  const refreshAll = useCallback(async () => {
    if (!SUPABASE_CONFIGURED || !event) return;
    try {
      const data = await fetchAllData(event.id);
      setStock(data.stock); setSales(data.sales); setAdjLog(data.adjLog); setLoans(data.loans);
      saveCache(event.id, data.stock, data.sales, data.adjLog, data.loans);
      setOnline(true);
    } catch (err) {
      console.error("Refresh failed", err);
      setOnline(false);
    }
  }, [event]);

  // Replays sales that were completed while offline, in order, the moment a
  // connection is available. Each queued entry carries the event it was made
  // under, so a sale started on one event always replays against that same
  // event even if this device has since switched to another. Genuine stock
  // conflicts (someone else sold the last unit while this device was
  // offline) are pulled out for manual review rather than silently dropped.
  const flushQueue = useCallback(async () => {
    let q = loadQueue();
    if (!q.length) return;
    let anySynced = false;
    for (const entry of [...q]) {
      try {
        const newId = await completeSaleRPC(entry.eventId, entry.cashier, entry.client, entry.items, entry.subtotal, entry.vat, entry.total, entry.testMode, entry.paymentMethod);
        q = removeFromQueue(entry.tempId);
        setQueueCount(q.length);
        if (entry.eventId === event?.id) {
          setSales(prev => prev.map(s => s.id===entry.tempId ? {...s, id:newId, pending:false} : s));
        }
        toast(`✓ Synced ${entry.tempId} → ${newId}`, "success");
        anySynced = true;
      } catch (err) {
        if (isStockError(err)) {
          setSyncIssues(prev => [...prev, {...entry, error: err.message}]);
          q = removeFromQueue(entry.tempId);
          setQueueCount(q.length);
          if (entry.eventId === event?.id) {
            setSales(prev => prev.map(s => s.id===entry.tempId ? {...s, pending:false, syncFailed:true} : s));
          }
          toast(`⚠ ${entry.tempId} couldn't sync — stock conflict, needs manual review`, "error");
        } else {
          break; // still offline — stop here, the rest will retry next pass
        }
      }
    }
    if (anySynced) refreshAll();
  }, [refreshAll, toast, event]);

  // Re-fetch and re-subscribe whenever the selected event changes, not just on mount.
  useEffect(() => {
    if (!SUPABASE_CONFIGURED || !event) { setLoading(false); return; }
    setLoading(true);
    // Show last-known cached data for THIS event immediately, before the live fetch returns.
    const cached = loadCache(event.id);
    if (cached.stock) { setStock(cached.stock); setSales(cached.sales||[]); setAdjLog(cached.adjLog||[]); setLoans(cached.loans||[]); }
    let cancelled = false;
    (async () => { await refreshAll(); if (!cancelled) setLoading(false); })();
    const unsub = subscribeRealtime(event.id, debounce(refreshAll, 400));
    const onOnline  = () => { setOnline(true); flushQueue(); };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    const interval = setInterval(() => { if (loadQueue().length) flushQueue(); }, 20000);
    return () => {
      cancelled = true;
      unsub();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.id]);

  const login  = u => { setUser(u); setScreen("pos"); };
  const logout = () => { setUser(null); setInvoice(null); setScreen("pos"); };
  const selectEvent = ev => { setEvent(ev); saveLastEvent(ev); setScreen("pos"); };
  const switchEvent = () => setEvent(null);

  const resetAllData = async () => {
    if (!event) return;
    if (!window.confirm(
      `This downloads a safety backup first, then PERMANENTLY WIPES the shared stock, sales and ` +
      `adjustment history for "${event.name}" — not other events on this system. Every device ` +
      `currently working on this event will see it cleared. Use this to start fresh. Continue?`
    )) return;
    downloadBackup(stock, sales, adjLog, loans, event);
    try {
      await wipeAllDataRPC(event.id);
      await refreshAll();
      toast(`✓ "${event.name}" cleared — backup downloaded, starting fresh`, "success");
    } catch (err) {
      console.error("Reset failed:", err);
      toast(`✗ Couldn't reset — ${err?.message || "unknown error"}`, "error");
    }
  };

  // The one place offline support actually matters: completing a sale never
  // blocks the cashier. Online: goes straight to the shared backend, which
  // atomically checks and decrements stock (this is what stops two devices
  // both "selling" the last unit). Offline: completes locally and queues for
  // automatic sync — see flushQueue above.
  const completeSaleFlow = async (cart, client, paymentMethod) => {
    const sub = cart.reduce((s,i)=>s+i.price*i.qty,0);
    const vatAmt = sub*VAT_RATE;
    const total = sub+vatAmt;
    const clientSnap = {...client};
    const itemsSnap = cart.map(({cartId,...rest})=>rest);

    try {
      const newId = await completeSaleRPC(event.id, user.username, clientSnap, itemsSnap, sub, vatAmt, total, TEST_MODE, paymentMethod);
      await refreshAll();
      const inv = { id:newId, date:dateStr(), cashier:user.username, client:clientSnap, paymentMethod, items:itemsSnap, subtotal:sub, vat:vatAmt, total, testMode:TEST_MODE };
      toast(`✓ Sale complete — Invoice ${inv.id}`, "success");
      return { ok:true, inv };
    } catch (err) {
      if (isStockError(err)) {
        toast(`✗ Not enough stock — ${String(err.message).replace("INSUFFICIENT_STOCK:","").trim()}. Adjust the cart and try again.`, "error");
        return { ok:false };
      }
      const tempId = `PENDING-${Date.now()}`;
      const inv = { id:tempId, date:dateStr(), cashier:user.username, client:clientSnap, paymentMethod, items:itemsSnap, subtotal:sub, vat:vatAmt, total, testMode:TEST_MODE, pending:true };
      setStock(prev=>prev.map(p=>({...p,variants:p.variants.map(v=>{
        const ci = itemsSnap.find(c=>c.variantId===v.id);
        return ci ? {...v, qty:Math.max(0, v.qty-ci.qty)} : v;
      })})));
      setSales(prev=>[...prev, inv]);
      pushToQueue({ tempId, eventId:event.id, cashier:user.username, client:clientSnap, paymentMethod, items:itemsSnap, subtotal:sub, vat:vatAmt, total, testMode:TEST_MODE });
      setQueueCount(loadQueue().length);
      setOnline(false);
      toast(`⚠ No connection — saved locally as ${tempId}, will sync automatically once back online`, "error");
      return { ok:true, inv };
    }
  };

  const onSaleComplete = inv => { setInvoice(inv); setScreen("invoice"); };
  const onViewInvoice  = inv => { setInvoice(inv); setScreen("invoice"); };
  const navTo = s => { setScreen(s); if(s!=="invoice") setInvoice(null); };

  const activeNav = screen==="invoice"?"sales":screen;

  if (showHero) return (
    <>
      <TestBanner/>
      <HeroScreen onEnter={()=>setShowHero(false)}/>
      <Toasts toasts={toasts} dismiss={dismiss}/>
    </>
  );

  if (!SUPABASE_CONFIGURED) return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0a0a",padding:24}}>
      <div style={{maxWidth:480,textAlign:"center",color:"#d0d0c8"}}>
        <h2 style={{color:"#c9a84c",marginBottom:12}}>⚠ Backend not configured</h2>
        <p style={{fontSize:14,lineHeight:1.6}}>
          This build is wired for shared, live-synced data across devices, but <code>src/supabase.js</code> still
          has placeholder values. Run <code>supabase/schema.sql</code> in your Supabase project's SQL Editor, then
          fill in <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in <code>src/supabase.js</code> and redeploy.
        </p>
      </div>
    </div>
  );

  if (!user) return (
    <>
      <TestBanner/>
      <LoginScreen onLogin={login}/>
      <Toasts toasts={toasts} dismiss={dismiss}/>
    </>
  );

  if (!event) return (
    <>
      <TestBanner/>
      <EventSelector user={user} onSelect={selectEvent} toast={toast}/>
      <Toasts toasts={toasts} dismiss={dismiss}/>
    </>
  );

  if (loading) return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0a0a"}}>
      <Logo h={90} glow center/>
    </div>
  );

  return (
    <>
      <TestBanner/>
      <Header user={user} screen={activeNav} setScreen={navTo} onLogout={logout} stock={stock} sales={sales}
        adjLog={adjLog} loans={loans} onResetAll={resetAllData} online={online} queueCount={queueCount}
        syncIssuesCount={syncIssues.length} event={event} onSwitchEvent={switchEvent}/>
      <Toasts toasts={toasts} dismiss={dismiss}/>
      {screen==="pos" &&
        <POSScreen stock={stock} user={user} toast={toast} onCompleteSale={completeSaleFlow} onSaleComplete={onSaleComplete}/>}
      {screen==="invoice" && invoice &&
        <InvoiceView invoice={invoice} onBack={()=>{setInvoice(null);setScreen("pos");}}/>}
      {screen==="stock" && user.role==="admin" &&
        <StockScreen stock={stock} user={user} toast={toast} adjLog={adjLog} loans={loans} refreshAll={refreshAll} eventId={event.id}/>}
      {screen==="reconcile" && user.role==="admin" &&
        <Reconcile stock={stock} sales={sales} loans={loans} toast={toast} event={event}/>}
      {screen==="sales" && !invoice &&
        <SalesScreen sales={sales} onView={onViewInvoice}/>}
      {screen==="sales" && invoice &&
        <InvoiceView invoice={invoice} onBack={()=>setInvoice(null)}/>}
    </>
  );
}

