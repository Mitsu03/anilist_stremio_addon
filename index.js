const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const addonInterface = require('./addon');
const config = require('./config/env');
const { HTTP_STATUS, ANILIST_OAUTH, MAL_OAUTH } = require('./config/constants');
const tokenManager = require('./config/tokens');

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (config.isDevelopment) {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });
}

// AniList: long bearer token
function isValidAniListToken(token) {
  return typeof token === 'string' && token.length >= 10 && token.length <= 2048 && !/[<>"'\n\r]/.test(token);
}

// MAL: 64-char lowercase hex opaque token issued by this server after OAuth
function isValidMalToken(val) {
  return typeof val === 'string' && /^[a-f0-9]{64}$/.test(val);
}

// IMDB: user ID starts with "ur" + digits, or "p." + alphanumeric
function isValidImdbUserId(val) {
  return typeof val === 'string' && /^(ur\d{4,15}|p\.[a-z0-9]{10,50})$/.test(val);
}

// Letterboxd: 64-char lowercase hex opaque token issued by this server after password login
function isValidLetterboxdToken(val) {
  return typeof val === 'string' && /^[a-f0-9]{64}$/.test(val);
}

function isValidServiceParam(service, param) {
  if (service === 'anilist') return isValidAniListToken(param);
  if (service === 'mal') return isValidMalToken(param);
  if (service === 'imdb') return isValidImdbUserId(param);
  if (service === 'letterboxd') return isValidLetterboxdToken(param);
  return false;
}

// For MAL routes: resolve the opaque addon token to the stored username.
// For all other services the param is already the user-facing identifier.
function resolveServiceToken(service, token) {
  if (service === 'mal') return tokenManager.resolveServiceOpaqueToken('mal', token);
  if (service === 'letterboxd') return tokenManager.resolveServiceOpaqueToken('letterboxd', token);
  return token;
}

const VALID_SERVICES = new Set(['anilist', 'mal', 'imdb', 'letterboxd']);

function configurePageHandler(req, res) {
  const anilistOk = !!config.anilistClientId;
  const malOauthOk = !!(config.malClientId && config.malClientSecret);
  const letterboxdOk = !!(config.letterboxdClientId && config.letterboxdClientSecret);

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AniSync — Configure your Stremio addon</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#080810;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
    body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 60% at 50% -10%,rgba(91,106,245,.18) 0%,transparent 70%);pointer-events:none}
    .card{background:rgba(18,18,28,.95);border:1px solid rgba(91,106,245,.25);border-radius:16px;padding:2.5rem;max-width:480px;width:100%;box-shadow:0 0 40px rgba(91,106,245,.08),0 8px 32px rgba(0,0,0,.5)}
    .logo{display:flex;align-items:center;gap:.75rem;margin-bottom:.35rem}
    .logo-icon{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#5b6af5,#a855f7);display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0}
    h1{font-size:1.45rem;font-weight:700;color:#fff;letter-spacing:-.02em}
    .subtitle{color:#666;font-size:.88rem;margin-bottom:1.5rem;padding-left:48px}
    .section{margin-bottom:1.25rem;padding-bottom:1rem;border-bottom:1px solid rgba(255,255,255,.06)}
    .section:last-of-type{border-bottom:none;margin-bottom:0;padding-bottom:0}
    .section-title{font-size:.95rem;font-weight:600;color:#fff;margin-bottom:1rem;display:flex;align-items:center;gap:.5rem}
    .section-badge{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;font-size:.75rem;flex-shrink:0}
    .badge-anilist{background:linear-gradient(135deg,#02a9ff,#0284c7)}
    .badge-mal{background:linear-gradient(135deg,#2e51a2,#1e3a7a)}
    .badge-imdb{background:linear-gradient(135deg,#f5c518,#e0a800);color:#000}
    .warn{background:rgba(42,31,0,.8);border:1px solid rgba(85,68,.6);border-radius:10px;padding:.75rem 1rem;font-size:.82rem;color:#ffcc55;margin-bottom:1.2rem;line-height:1.5}
    .warn a{color:#ffd97a}
    .err-box{background:rgba(42,16,16,.8);border:1px solid rgba(85,34,34,.8);border-radius:10px;padding:.75rem 1rem;font-size:.82rem;color:#ff8888;margin-bottom:1rem}
    .url-box{display:none}
    .btn{padding:.6rem 1.25rem;border-radius:8px;font-size:.88rem;font-weight:600;cursor:pointer;border:none;text-decoration:none;display:inline-flex;align-items:center;gap:.4rem;transition:all .2s;letter-spacing:.01em}
    .btn:active{transform:scale(.97)}
    .btn-login{background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;justify-content:center;padding:.55rem .9rem;font-size:.85rem;border-radius:8px;box-shadow:0 2px 10px rgba(37,99,235,.25)}
    .btn-login:hover{box-shadow:0 4px 16px rgba(37,99,235,.4);filter:brightness(1.1)}
    .btn-stremio{background:linear-gradient(135deg,#5b6af5,#7c3aed);color:#fff;box-shadow:0 4px 14px rgba(91,106,245,.3)}
    .btn-stremio:hover{box-shadow:0 4px 18px rgba(91,106,245,.5);opacity:1;filter:brightness(1.1)}
    .btn-switch{background:none;color:#444;font-size:.78rem;font-weight:400;padding:.3rem 0;margin-top:.9rem;text-decoration:underline;text-underline-offset:3px;cursor:pointer;border:none}
    .btn-switch:hover{color:#888}
    .hint{font-size:.78rem;color:#555;margin-top:.35rem;min-height:1.2em}
    .hint.err{color:#e05555}
    .field-label{display:block;font-size:.72rem;color:#888;margin-bottom:.4rem;font-weight:500;letter-spacing:.02em;text-transform:uppercase}
    input{width:100%;padding:.65rem .9rem;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:9px;color:#fff;font-size:1rem;outline:none;transition:border-color .2s,box-shadow .2s}
    input:focus{border-color:#5b6af5;box-shadow:0 0 0 3px rgba(91,106,245,.15)}
    input.invalid{border-color:#e05555}
    .note{font-size:.75rem;color:#3a3a4a;margin-top:1.5rem;line-height:1.6;text-align:center}
    .section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem}
    .section-title{font-size:.95rem;font-weight:600;color:#fff;display:flex;align-items:center;gap:.5rem;margin-bottom:0}
    .svc-checkbox-wrap{display:flex;align-items:center;gap:.5rem;opacity:.35;transition:opacity .2s;cursor:not-allowed}
    .svc-checkbox-wrap.enabled{opacity:1;cursor:pointer}
    .svc-checkbox-wrap input[type=checkbox]{width:17px;height:17px;accent-color:#5b6af5;cursor:inherit;flex-shrink:0}
    .svc-checkbox-label{font-size:.78rem;color:#aaa;user-select:none}
    .svc-status{font-size:.78rem;color:#4ade80;font-weight:500;display:none}
    .svc-status.show{display:inline}

    /* AniSync dashboard — adapted from the Lovable project without adding a second app */
    :root{color-scheme:dark;--bg:#11101a;--panel:rgba(29,27,43,.78);--card:#1d1b2b;--card-2:#232036;--text:#f8f7ff;--muted:#aaa5bc;--faint:#777187;--line:rgba(174,164,207,.18);--primary:#a779ff;--primary-2:#7f69ff;--success:#54d997;--warning:#f3c866;--danger:#ff7878;--anilist:#52b7ff;--mal:#6d8cff;--imdb:#f5c518;--letterboxd:#42d17a}
    html{scroll-behavior:smooth}
    body{display:block;padding:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.5}
    body::before{z-index:-2;background:radial-gradient(ellipse 70% 48% at 10% 0%,rgba(126,83,255,.24),transparent 68%),radial-gradient(ellipse 62% 42% at 95% 8%,rgba(58,117,255,.18),transparent 64%),radial-gradient(ellipse 45% 30% at 50% 105%,rgba(172,74,255,.12),transparent 65%)}
    body::after{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.28;background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:44px 44px;mask-image:linear-gradient(to bottom,black,transparent 75%)}
    button,a,input{font:inherit}
    a{color:#bea5ff}
    .topbar{position:sticky;top:0;z-index:20;border-bottom:1px solid var(--line);background:rgba(17,16,26,.72);backdrop-filter:blur(18px) saturate(140%)}
    .topbar-inner{width:min(1180px,calc(100% - 2rem));height:64px;margin:auto;display:flex;align-items:center;justify-content:space-between}
    .brand{display:flex;align-items:center;gap:.7rem;color:var(--text);text-decoration:none}
    .brand-mark{width:38px;height:38px;display:grid;place-items:center;border-radius:12px;background:linear-gradient(135deg,var(--primary),#c55cff 55%,#6d74ff);box-shadow:0 10px 28px rgba(156,100,255,.3);font-weight:900}
    .brand-name{display:block;font-weight:750;letter-spacing:-.02em;line-height:1.05}
    .brand-sub{display:block;margin-top:.2rem;color:var(--muted);font-size:.64rem;letter-spacing:.15em;text-transform:uppercase}
    .top-actions{display:flex;align-items:center;gap:.65rem}
    .server-pill{display:inline-flex;align-items:center;gap:.5rem;padding:.38rem .72rem;border:1px solid rgba(84,217,151,.28);border-radius:999px;background:rgba(84,217,151,.08);color:#81e9b5;font-size:.75rem}
    .server-dot{position:relative;width:7px;height:7px;border-radius:50%;background:var(--success);box-shadow:0 0 0 4px rgba(84,217,151,.08)}
    .help-btn{border:0;background:transparent;color:var(--muted);padding:.5rem .7rem;border-radius:9px;cursor:pointer}
    .help-btn:hover{background:rgba(255,255,255,.06);color:var(--text)}
    .shell{width:min(1180px,calc(100% - 2rem));margin:0 auto;padding:3.25rem 0 3rem}
    .eyebrow{display:flex;align-items:center;gap:.6rem;color:var(--muted);font-size:.76rem}
    .preview-badge{display:inline-flex;align-items:center;gap:.35rem;padding:.25rem .55rem;border:1px solid rgba(167,121,255,.26);border-radius:999px;background:rgba(167,121,255,.1);color:#d7c5ff;font-weight:650}
    .hero h1{max-width:820px;margin-top:1rem;color:var(--text);font-family:'Space Grotesk',Inter,ui-sans-serif,sans-serif;font-size:clamp(2.5rem,6vw,4.4rem);font-weight:680;line-height:1.02;letter-spacing:-.055em}
    .hero-gradient{background:linear-gradient(115deg,#fff 0%,#c7a7ff 50%,#a977ff 78%,#c85cff 100%);background-clip:text;-webkit-background-clip:text;color:transparent}
    .hero-copy{max-width:720px;margin-top:1.1rem;color:var(--muted);font-size:clamp(1rem,2vw,1.16rem)}
    .stepper{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin:2.5rem 0 2.25rem;list-style:none}
    .step{display:flex;align-items:center;gap:.75rem;padding:.78rem;border:1px solid var(--line);border-radius:13px;background:rgba(31,29,45,.5);color:var(--muted);font-size:.82rem;transition:.2s ease}
    .step-number{display:grid;place-items:center;width:30px;height:30px;flex:0 0 30px;border-radius:50%;background:#2c293c;color:#8f899e;font-weight:700}
    .step.active{border-color:rgba(167,121,255,.44);background:rgba(143,92,255,.1);color:var(--text)}
    .step.active .step-number{background:linear-gradient(135deg,var(--primary),var(--primary-2));color:#16121f}
    .step.done{border-color:rgba(84,217,151,.28);background:rgba(84,217,151,.05)}
    .step.done .step-number{background:var(--success);color:#112118}
    .dashboard-section{margin-top:2.2rem}
    .dashboard-heading{display:flex;align-items:flex-start;gap:.7rem;margin-bottom:1rem}
    .heading-icon{display:grid;place-items:center;width:28px;height:28px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.035);color:#cbb8ff;font-size:.82rem}
    .dashboard-heading h2{font-size:1rem;font-weight:700;letter-spacing:-.01em}
    .dashboard-heading p{margin-top:.12rem;color:var(--muted);font-size:.82rem}
    .card{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;max-width:none;padding:0;background:transparent;border:0;border-radius:0;box-shadow:none}
    .card>.logo,.card>.subtitle{display:none}
    .card>.section{min-width:0;margin:0;padding:1.15rem;border:1px solid var(--line);border-radius:15px;background:linear-gradient(145deg,rgba(35,32,54,.9),rgba(25,24,38,.86));box-shadow:0 24px 55px -42px #000;transition:transform .18s,border-color .18s}
    .card>.section:not(#install-all-section):hover{transform:translateY(-2px);border-color:rgba(174,164,207,.3)}
    .section-header{margin-bottom:.55rem}
    .section-title{font-size:.95rem}
    .section-badge{width:33px;height:33px;border-radius:10px;font-weight:800}
    .badge-anilist{background:rgba(82,183,255,.14);border:1px solid rgba(82,183,255,.25);color:var(--anilist)}
    .badge-mal{background:rgba(109,140,255,.14);border:1px solid rgba(109,140,255,.25);color:#9bb0ff}
    .badge-imdb{background:rgba(245,197,24,.14);border:1px solid rgba(245,197,24,.25);color:var(--imdb)}
    .badge-letterboxd{background:rgba(66,209,122,.14)!important;border:1px solid rgba(66,209,122,.25);color:var(--letterboxd)}
    .service-tagline{margin:0 0 1rem 2.7rem;color:var(--muted);font-size:.75rem}
    .svc-checkbox-wrap{opacity:.55;gap:.38rem}
    .svc-checkbox-wrap.enabled{opacity:1}
    .svc-checkbox-wrap input[type=checkbox]{accent-color:var(--primary)}
    .svc-checkbox-label{color:var(--muted)}
    .svc-status{color:var(--success)}
    .btn{min-height:38px;border-radius:9px;justify-content:center;transition:transform .16s,filter .16s,box-shadow .16s}
    .btn:focus-visible,.help-btn:focus-visible,input:focus-visible,.copy-btn:focus-visible{outline:3px solid rgba(167,121,255,.38);outline-offset:2px}
    .btn-login{width:100%;background:#2a273b;border:1px solid var(--line);box-shadow:none;color:var(--text)}
    .btn-login:hover{background:#322e48;box-shadow:none;filter:none}
    .btn-switch{color:var(--muted);text-decoration:none}
    .btn-switch:hover{color:var(--text)}
    .hint{color:var(--muted);line-height:1.45}
    .hint.err{color:var(--danger)}
    .field-label{color:var(--muted);letter-spacing:.1em}
    input{padding:.68rem .78rem;background:rgba(13,12,21,.48);border-color:var(--line);font-size:.9rem}
    input:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(167,121,255,.12)}
    .warn,.err-box{border-radius:9px;margin:.6rem 0 1rem;line-height:1.45}
    .warn{background:rgba(78,59,11,.23);border-color:rgba(243,200,102,.25);color:#f4d88f}
    .err-box{background:rgba(87,25,35,.2);border-color:rgba(255,120,120,.25);color:#ffa2a2}
    .catalog-panel{grid-column:1/-1!important;display:block!important;padding:1.2rem!important}
    .catalog-title{display:flex;align-items:center;justify-content:space-between;gap:1rem}
    .catalog-title strong{font-size:.92rem}
    .catalog-title span{color:var(--muted);font-size:.75rem}
    .catalog-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem;margin-top:.9rem}
    .catalog-group{display:none;padding:.8rem;border:1px solid var(--line);border-radius:10px;background:rgba(13,12,21,.28)}
    .catalog-group.show{display:block}
    .catalog-group-head{display:flex;align-items:center;gap:.5rem;font-size:.78rem;font-weight:700}
    .dot-anilist,.dot-mal,.dot-imdb,.dot-letterboxd{width:7px;height:7px;border-radius:50%}
    .dot-anilist{background:var(--anilist)}.dot-mal{background:var(--mal)}.dot-imdb{background:var(--imdb)}.dot-letterboxd{background:var(--letterboxd)}
    .chip-row{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.65rem}
    .chip{padding:.25rem .52rem;border:1px solid var(--line);border-radius:999px;color:#c2bdcc;background:rgba(255,255,255,.025);font-size:.7rem}
    .catalog-empty{padding:.95rem;border:1px dashed var(--line);border-radius:10px;color:var(--muted);font-size:.8rem;text-align:center}
    #install-all-section{grid-column:1/-1;padding:1.25rem!important;background:linear-gradient(135deg,rgba(119,77,205,.17),rgba(39,33,67,.86))!important;border-color:rgba(167,121,255,.25)!important;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1rem;align-items:center}
    .install-copy{min-width:0}
    .install-copy h3{font-size:1rem}
    .install-copy p{margin-top:.2rem;color:var(--muted);font-size:.8rem}
    .manifest-row{display:flex;align-items:center;gap:.5rem;margin-top:.8rem;padding:.48rem .55rem .48rem .75rem;border:1px solid var(--line);border-radius:9px;background:rgba(12,11,20,.4)}
    .manifest-row code{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:.72rem}
    .copy-btn{border:0;border-radius:7px;padding:.34rem .55rem;background:transparent;color:#cbb8ff;cursor:pointer;font-size:.72rem}
    .copy-btn:disabled{opacity:.35;cursor:not-allowed}
    #install-all-btn{width:auto!important;min-width:190px;padding:.78rem 1.05rem!important;background:linear-gradient(135deg,var(--primary),#bd5cff 55%,var(--primary-2));box-shadow:0 10px 28px rgba(154,97,255,.28);color:#17121f}
    #install-hint{display:none}
    .note{display:none}
    .diagnostics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--line);border-radius:15px;background:var(--panel);overflow:hidden;backdrop-filter:blur(14px)}
    .diag-row{display:flex;align-items:flex-start;gap:.75rem;padding:1rem;border-bottom:1px solid var(--line)}
    .diag-row:nth-child(odd){border-right:1px solid var(--line)}
    .diag-row:nth-last-child(-n+2){border-bottom:0}
    .diag-icon{width:9px;height:9px;margin-top:.3rem;border-radius:50%;background:var(--success);box-shadow:0 0 0 4px rgba(84,217,151,.08)}
    .diag-icon.warn{background:var(--warning);box-shadow:0 0 0 4px rgba(243,200,102,.08)}
    .diag-label{color:var(--muted);font-size:.64rem;letter-spacing:.14em;text-transform:uppercase}
    .diag-value{margin-top:.16rem;font-size:.82rem;overflow-wrap:anywhere}
    footer{margin-top:3rem;padding-top:1.25rem;border-top:1px solid var(--line);color:var(--faint);font-size:.72rem;text-align:center}
    dialog{width:min(500px,calc(100% - 2rem));padding:0;border:1px solid var(--line);border-radius:16px;background:#1d1b2b;color:var(--text);box-shadow:0 30px 90px #000}
    dialog::backdrop{background:rgba(5,4,10,.72);backdrop-filter:blur(5px)}
    .dialog-inner{padding:1.3rem}
    .dialog-head{display:flex;align-items:center;justify-content:space-between;gap:1rem}
    .dialog-head h2{font-size:1.05rem}
    .dialog-close{border:0;background:transparent;color:var(--muted);font-size:1.25rem;cursor:pointer}
    .help-list{margin-top:1rem;display:grid;gap:.6rem}
    .help-list details{padding:.75rem;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.025)}
    .help-list summary{cursor:pointer;font-size:.84rem;font-weight:650}
    .help-list p{margin-top:.55rem;color:var(--muted);font-size:.78rem;line-height:1.55}
    .toast-stack{position:fixed;top:78px;right:1rem;z-index:50;display:grid;gap:.5rem}
    .toast{max-width:320px;padding:.75rem .9rem;border:1px solid var(--line);border-radius:10px;background:#28243a;color:var(--text);box-shadow:0 12px 35px #000;font-size:.8rem;animation:toast-in .2s ease-out}
    @keyframes toast-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
    @media(max-width:760px){.shell{padding-top:2.2rem}.server-pill{display:none}.stepper{grid-template-columns:1fr}.step{padding:.58rem}.step-number{width:26px;height:26px;flex-basis:26px}.card{grid-template-columns:1fr}.catalog-groups{grid-template-columns:1fr}#install-all-section{grid-template-columns:1fr}#install-all-btn{width:100%!important}.diagnostics{grid-template-columns:1fr}.diag-row,.diag-row:nth-child(odd){border-right:0;border-bottom:1px solid var(--line)}.diag-row:last-child{border-bottom:0}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;transition-duration:.01ms!important}}
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="#top" aria-label="AniSync home">
        <span class="brand-mark" aria-hidden="true">✦</span>
        <span><span class="brand-name">AniSync</span><span class="brand-sub">for Stremio</span></span>
      </a>
      <div class="top-actions">
        <span class="server-pill"><span class="server-dot"></span>Server online</span>
        <button class="help-btn" type="button" onclick="openHelp()">Help</button>
      </div>
    </div>
  </header>

  <main class="shell" id="top">
    <section class="hero" aria-labelledby="page-title">
      <div class="eyebrow"><span class="preview-badge">✦ Live configuration</span><span>Self-hosted · Free &amp; open source</span></div>
      <h1 id="page-title">Your watchlists, <span class="hero-gradient">unified in Stremio.</span></h1>
      <p class="hero-copy">Connect AniList, MyAnimeList, IMDb, and Letterboxd. Install one combined addon and keep watching where you left off.</p>
    </section>

    <ol class="stepper" aria-label="Setup progress">
      <li class="step active" id="step-1"><span class="step-number">1</span><span>Connect services</span></li>
      <li class="step" id="step-2"><span class="step-number">2</span><span>Review catalogs</span></li>
      <li class="step" id="step-3"><span class="step-number">3</span><span>Install addon</span></li>
    </ol>

    <section class="dashboard-section" aria-labelledby="services-heading">
      <div class="dashboard-heading">
        <span class="heading-icon" aria-hidden="true">↗</span>
        <div><h2 id="services-heading">Connect services</h2><p>Link one or more sources. Credentials stay on your self-hosted server.</p></div>
      </div>
  <div class="card">
    <div class="logo">
      <div class="logo-icon">&#x1F3AC;</div>
      <h1>Anime Stremio Addon</h1>
    </div>
    <p class="subtitle">Sync your anime list to Stremio &mdash; all statuses.</p>

    <!-- AniList section -->
    <div class="section">
      <div class="section-header">
        <div class="section-title"><span class="section-badge badge-anilist">A</span> AniList</div>
        <label class="svc-checkbox-wrap" id="al-cb-wrap" title="Include AniList in install">
          <input type="checkbox" id="al-include" disabled onchange="updateInstallAll()">
          <span class="svc-checkbox-label">Include</span>
          <span class="svc-status" id="al-status">&#x2713; Connected</span>
        </label>
      </div>
      <p class="service-tagline">Anime lists and progress via OAuth</p>
      ${!anilistOk ? '<div class="err-box"><strong>ANILIST_CLIENT_ID not set.</strong> Add it to .env and restart.</div>' : ''}
      <div id="al-pre"${!anilistOk ? ' style="display:none"' : ''}>
        <button class="btn btn-login" onclick="alLogin()">&#x1F511;&nbsp; Login with AniList</button>
      </div>
      <div id="al-post" style="display:none">
        <div class="url-box" id="al-url"></div>
        <button class="btn-switch" onclick="alReset()">Switch account</button>
      </div>
    </div>

    <!-- MAL section -->
    <div class="section">
      <div class="section-header">
        <div class="section-title"><span class="section-badge badge-mal">M</span> MyAnimeList</div>
        <label class="svc-checkbox-wrap" id="mal-cb-wrap" title="Include MAL in install">
          <input type="checkbox" id="mal-include" disabled onchange="updateInstallAll()">
          <span class="svc-checkbox-label">Include</span>
          <span class="svc-status" id="mal-status">&#x2713; Connected</span>
        </label>
      </div>
      <p class="service-tagline">Anime lists and progress via OAuth</p>
      ${!malOauthOk ? '<div class="warn">MAL support requires <strong>MAL_CLIENT_ID</strong> and <strong>MAL_CLIENT_SECRET</strong> in .env.<br>Register at <a href="https://myanimelist.net/apiconfig" target="_blank" rel="noopener">myanimelist.net/apiconfig</a>.</div>' : ''}
      <div id="mal-pre"${!malOauthOk ? ' style="display:none"' : ''}>
        <button class="btn btn-login" onclick="malConnect()">&#x1F511;&nbsp; Connect to MyAnimeList</button>
      </div>
      <div id="mal-post" style="display:none">
        <input type="hidden" id="mal-token" value="">
        <p class="hint" id="mal-auth-status" style="margin-top:.25rem"></p>
        <button class="btn-switch" onclick="malReset()">Switch account</button>
      </div>
    </div>

    <!-- IMDB section -->
    <div class="section">
      <div class="section-header">
        <div class="section-title"><span class="section-badge badge-imdb">I</span> IMDB</div>
        <label class="svc-checkbox-wrap" id="imdb-cb-wrap" title="Include IMDB in install">
          <input type="checkbox" id="imdb-include" disabled onchange="updateInstallAll()">
          <span class="svc-checkbox-label">Include</span>
          <span class="svc-status" id="imdb-status">&#x2713; Ready</span>
        </label>
      </div>
      <p class="service-tagline">Public watchlist by user ID</p>
      <div id="imdb-form">
        <label class="field-label" for="imdb-userid">IMDB User ID</label>
        <input type="text" id="imdb-userid" placeholder="e.g. ur12345678 or paste profile URL"
               autocomplete="off" spellcheck="false" maxlength="60">
        <p class="hint" id="imdb-hint">Found in your <a href="https://www.imdb.com/user/" target="_blank" rel="noopener" style="color:#5b6af5">IMDB profile URL</a> (e.g. ur12345678 or p.xxxx). Your watchlist must be public.</p>
      </div>
    </div>

    <!-- Letterboxd section -->
    <div class="section">
      <div class="section-header">
        <div class="section-title"><span class="section-badge badge-letterboxd">L</span> Letterboxd</div>
        <label class="svc-checkbox-wrap" id="lb-cb-wrap" title="Include Letterboxd in install">
          <input type="checkbox" id="lb-include" disabled onchange="updateInstallAll()">
          <span class="svc-checkbox-label">Include</span>
          <span class="svc-status" id="lb-status">&#x2713; Connected</span>
        </label>
      </div>
      <p class="service-tagline">Film watchlist and watched history</p>
      ${!letterboxdOk ? '<div class="warn">Letterboxd support requires <strong>LETTERBOXD_CLIENT_ID</strong> and <strong>LETTERBOXD_CLIENT_SECRET</strong> in .env.</div>' : ''}
      <div id="lb-pre"${!letterboxdOk ? ' style="display:none"' : ''}>
        <label class="field-label" for="lb-username">Letterboxd Username</label>
        <input type="text" id="lb-username" placeholder="your_username" autocomplete="username" spellcheck="false" maxlength="40">
        <label class="field-label" for="lb-password" style="margin-top:.8rem">Letterboxd Password</label>
        <input type="password" id="lb-password" placeholder="Your password" autocomplete="current-password" maxlength="120">
        <button class="btn btn-login" onclick="lbLogin()" style="margin-top:.9rem;width:100%;justify-content:center">&#x1F511;&nbsp; Login with Letterboxd</button>
        <p class="hint" id="lb-hint">Uses Letterboxd password grant to create your addon token.</p>
      </div>
      <div id="lb-post" style="display:none">
        <input type="hidden" id="lb-token" value="">
        <p class="hint" id="lb-auth-status" style="margin-top:.25rem"></p>
        <button class="btn-switch" onclick="lbReset()">Switch account</button>
      </div>
    </div>

    <div class="section catalog-panel" id="catalog-panel">
      <div class="catalog-title"><strong>Catalogs exposed in Stremio</strong><span>Filters are selected inside Stremio</span></div>
      <div class="catalog-groups" id="catalog-groups">
        <div class="catalog-empty" id="catalog-empty">Connect and include a service to preview its catalog filters.</div>
        <div class="catalog-group" data-catalog="anilist"><div class="catalog-group-head"><span class="dot-anilist"></span>AniList · Anime</div><div class="chip-row"><span class="chip">Currently Watching</span><span class="chip">On Hold</span><span class="chip">Plan to Watch</span><span class="chip">Dropped</span><span class="chip">Completed</span><span class="chip">Rewatching</span></div></div>
        <div class="catalog-group" data-catalog="mal"><div class="catalog-group-head"><span class="dot-mal"></span>MyAnimeList · Anime</div><div class="chip-row"><span class="chip">Currently Watching</span><span class="chip">On Hold</span><span class="chip">Plan to Watch</span><span class="chip">Dropped</span><span class="chip">Completed</span></div></div>
        <div class="catalog-group" data-catalog="imdb"><div class="catalog-group-head"><span class="dot-imdb"></span>IMDb · Movies &amp; series</div><div class="chip-row"><span class="chip">Watchlist</span></div></div>
        <div class="catalog-group" data-catalog="letterboxd"><div class="catalog-group-head"><span class="dot-letterboxd"></span>Letterboxd · Movies</div><div class="chip-row"><span class="chip">Watchlist</span><span class="chip">Watched</span></div></div>
      </div>
    </div>

    <!-- Install All section -->
    <div class="section" id="install-all-section">
      <div class="install-copy">
        <h3>Install your combined addon</h3>
        <p id="install-summary">Connect at least one service to generate a manifest.</p>
        <div class="manifest-row"><code id="manifest-url">No manifest generated yet</code><button class="copy-btn" id="copy-manifest" type="button" onclick="copyManifest()" disabled>Copy</button></div>
      </div>
      <a class="btn btn-stremio" id="install-all-btn" href="#" style="width:100%;justify-content:center;padding:.85rem;font-size:1rem;border-radius:10px;text-decoration:none;pointer-events:none;opacity:.4">&#x25B6;&nbsp; Install in Stremio</a>
      <p class="hint" style="text-align:center;margin-top:.5rem" id="install-hint">Connect a service above, then check it to install.</p>
    </div>

    <p class="note">Currently Watching &bull; On Hold &bull; Plan to Watch &bull; Dropped &bull; Completed &bull; Rewatching</p>
  </div>
    </section>

    <section class="dashboard-section" aria-labelledby="diagnostics-heading">
      <div class="dashboard-heading">
        <span class="heading-icon" aria-hidden="true">✓</span>
        <div><h2 id="diagnostics-heading">Diagnostics</h2><p>Live readiness of this self-hosted backend.</p></div>
      </div>
      <div class="diagnostics">
        <div class="diag-row"><span class="diag-icon"></span><div><div class="diag-label">Backend URL</div><div class="diag-value" id="backend-url">Current server</div></div></div>
        <div class="diag-row"><span class="diag-icon${anilistOk ? '' : ' warn'}"></span><div><div class="diag-label">AniList OAuth</div><div class="diag-value">${anilistOk ? 'Ready' : 'Missing ANILIST_CLIENT_ID'}</div></div></div>
        <div class="diag-row"><span class="diag-icon${malOauthOk ? '' : ' warn'}"></span><div><div class="diag-label">MyAnimeList OAuth</div><div class="diag-value">${malOauthOk ? 'Ready' : 'Missing MAL client credentials'}</div></div></div>
        <div class="diag-row"><span class="diag-icon${letterboxdOk ? '' : ' warn'}"></span><div><div class="diag-label">Letterboxd login</div><div class="diag-value">${letterboxdOk ? 'Ready' : 'Missing Letterboxd client credentials'}</div></div></div>
        <div class="diag-row"><span class="diag-icon"></span><div><div class="diag-label">Token storage</div><div class="diag-value">Managed on this server</div></div></div>
        <div class="diag-row"><span class="diag-icon"></span><div><div class="diag-label">Progress sync</div><div class="diag-value">AniList and MAL · after 5 minutes</div></div></div>
      </div>
    </section>

    <footer>AniSync · Self-hosted · Not affiliated with Stremio, AniList, MyAnimeList, IMDb, or Letterboxd.</footer>
  </main>

  <dialog id="help-dialog" aria-labelledby="help-title">
    <div class="dialog-inner">
      <div class="dialog-head"><h2 id="help-title">Troubleshooting</h2><button class="dialog-close" type="button" onclick="closeHelp()" aria-label="Close help">×</button></div>
      <div class="help-list">
        <details><summary>OAuth redirect mismatch</summary><p>Register this server's exact AniList and MyAnimeList callback URLs. The protocol, hostname, port, and path must match.</p></details>
        <details><summary>Missing environment variables</summary><p>Add the client ID and secret for the affected service to <code>.env</code>, then restart the server.</p></details>
        <details><summary>Private IMDb watchlist</summary><p>Open IMDb privacy settings and make the watchlist public. AniSync reads the public profile URL.</p></details>
        <details><summary>Progress is not updating</summary><p>AniList and MAL progress updates are sent after the same episode has been open for at least five minutes.</p></details>
        <details><summary>Letterboxd session expired</summary><p>Reconnect the account. The server replaces the expired token with a new opaque addon token.</p></details>
      </div>
    </div>
  </dialog>
  <div class="toast-stack" id="toast-stack" aria-live="polite"></div>

  <script>
    var BASE = window.location.origin;
    document.getElementById('backend-url').textContent = BASE;

    // On return from OAuth callbacks the result comes back in the hash
    (function() {
      var params = new URLSearchParams(window.location.hash.substring(1));
      var alToken = params.get('anilist_token');
      if (alToken) {
        history.replaceState(null, '', window.location.pathname);
        showAlResult(decodeURIComponent(alToken));
      }
      var malToken = params.get('mal_token');
      if (malToken && /^[a-f0-9]{64}$/.test(malToken)) {
        history.replaceState(null, '', window.location.pathname);
        showMalResult(malToken);
      }
    })();

    function alLogin() { window.location.href = BASE + '/auth/anilist'; }

    function alReset() {
      document.getElementById('al-post').style.display = 'none';
      document.getElementById('al-url').textContent = '';
      document.getElementById('al-pre').style.display = 'block';
      var cb = document.getElementById('al-include');
      var wrap = document.getElementById('al-cb-wrap');
      cb.disabled = true; cb.checked = false;
      wrap.classList.remove('enabled');
      document.getElementById('al-status').classList.remove('show');
      updateInstallAll();
    }

    function showAlResult(token) {
      var url = BASE + '/anilist/' + encodeURIComponent(token) + '/manifest.json';
      document.getElementById('al-url').textContent = url;
      document.getElementById('al-pre').style.display = 'none';
      document.getElementById('al-post').style.display = 'block';
      var cb = document.getElementById('al-include');
      var wrap = document.getElementById('al-cb-wrap');
      cb.disabled = false; cb.checked = true;
      wrap.classList.add('enabled');
      document.getElementById('al-status').classList.add('show');
      updateInstallAll();
    }

    // MAL — single Connect button triggers OAuth; username discovered automatically
    function malConnect() {
      window.location.href = BASE + '/auth/mal/connect';
    }

    function showMalResult(token) {
      document.getElementById('mal-token').value = token;
      document.getElementById('mal-pre').style.display = 'none';
      document.getElementById('mal-post').style.display = 'block';
      var cb = document.getElementById('mal-include');
      var wrap = document.getElementById('mal-cb-wrap');
      cb.disabled = false; cb.checked = true;
      wrap.classList.add('enabled');
      document.getElementById('mal-status').classList.add('show');
      // Check auth status
      fetch(BASE + '/auth/mal/' + token + '/status')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var statusEl = document.getElementById('mal-auth-status');
          if (data.authenticated) {
            statusEl.textContent = '\u2705 Authenticated \u2014 progress updates enabled';
          }
        })
        .catch(function() {});
      try { localStorage.setItem('mal-token', token); } catch(e) {}
      updateInstallAll();
    }

    function malReset() {
      document.getElementById('mal-post').style.display = 'none';
      document.getElementById('mal-token').value = '';
      document.getElementById('mal-auth-status').textContent = '';
      document.getElementById('mal-pre').style.display = 'block';
      var cb = document.getElementById('mal-include');
      var wrap = document.getElementById('mal-cb-wrap');
      cb.disabled = true; cb.checked = false;
      wrap.classList.remove('enabled');
      document.getElementById('mal-status').classList.remove('show');
      try { localStorage.removeItem('mal-token'); } catch(e) {}
      updateInstallAll();
    }

    function lbLogin() {
      var username = (document.getElementById('lb-username').value || '').trim();
      var password = document.getElementById('lb-password').value || '';
      var hint = document.getElementById('lb-hint');

      if (!username || !password) {
        hint.textContent = 'Please enter your Letterboxd username and password.';
        hint.classList.add('err');
        return;
      }

      hint.classList.remove('err');
      hint.textContent = 'Signing in...';

      fetch(BASE + '/auth/letterboxd/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      })
      .then(function(r) { return r.json().then(function(b) { return { ok: r.ok, body: b }; }); })
      .then(function(result) {
        if (!result.ok || !result.body || !result.body.token) {
          throw new Error((result.body && result.body.error) || 'Letterboxd login failed.');
        }
        showLbResult(result.body.token, result.body.username || username);
      })
      .catch(function(err) {
        hint.textContent = err.message || 'Letterboxd login failed.';
        hint.classList.add('err');
      });
    }

    function showLbResult(token, username) {
      document.getElementById('lb-token').value = token;
      document.getElementById('lb-username').value = username || '';
      document.getElementById('lb-password').value = '';
      document.getElementById('lb-pre').style.display = 'none';
      document.getElementById('lb-post').style.display = 'block';

      var cb = document.getElementById('lb-include');
      var wrap = document.getElementById('lb-cb-wrap');
      cb.disabled = false; cb.checked = true;
      wrap.classList.add('enabled');
      document.getElementById('lb-status').classList.add('show');

      fetch(BASE + '/auth/letterboxd/' + token + '/status')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var statusEl = document.getElementById('lb-auth-status');
          if (data.authenticated) {
            statusEl.textContent = '\u2705 Authenticated \u2014 watchlist sync enabled';
          } else {
            statusEl.textContent = 'Token expired. Please login again.';
            statusEl.classList.add('err');
          }
        })
        .catch(function() {});

      try { localStorage.setItem('lb-token', token); } catch(e) {}
      try { localStorage.setItem('lb-username', username || ''); } catch(e) {}
      updateInstallAll();
    }

    function lbReset() {
      document.getElementById('lb-post').style.display = 'none';
      document.getElementById('lb-token').value = '';
      document.getElementById('lb-auth-status').textContent = '';
      document.getElementById('lb-pre').style.display = 'block';
      document.getElementById('lb-password').value = '';
      document.getElementById('lb-hint').textContent = 'Uses Letterboxd password grant to create your addon token.';
      document.getElementById('lb-hint').classList.remove('err');

      var cb = document.getElementById('lb-include');
      var wrap = document.getElementById('lb-cb-wrap');
      cb.disabled = true; cb.checked = false;
      wrap.classList.remove('enabled');
      document.getElementById('lb-status').classList.remove('show');

      try { localStorage.removeItem('lb-token'); } catch(e) {}
      updateInstallAll();
    }

    // Restore MAL from localStorage
    (function() {
      if (document.getElementById('mal-post').style.display !== 'none') return;
      try {
        var saved = localStorage.getItem('mal-token');
        if (saved && /^[a-f0-9]{64}$/.test(saved)) showMalResult(saved);
      } catch(e) {}
    })();

    // Restore Letterboxd from localStorage
    (function() {
      try {
        var savedToken = localStorage.getItem('lb-token');
        var savedUsername = localStorage.getItem('lb-username');
        if (savedUsername) {
          document.getElementById('lb-username').value = savedUsername;
        }
        if (savedToken && /^[a-f0-9]{64}$/.test(savedToken)) {
          showLbResult(savedToken, savedUsername || '');
        }
      } catch(e) {}
    })();

    // IMDB — user ID input generates install URL
    var IMDB_RE = /^(ur\\d{4,15}|p\\.[a-z0-9]{10,50})$/

    document.getElementById('imdb-userid') && document.getElementById('imdb-userid').addEventListener('input', imdbUserIdChanged);

    function imdbUserIdChanged() {
      var val = document.getElementById('imdb-userid').value.trim();
      var hint = document.getElementById('imdb-hint');
      if (!val) {
        hint.innerHTML = 'Found in your <a href="https://www.imdb.com/user/" target="_blank" rel="noopener" style="color:#5b6af5">IMDB profile URL</a> (e.g. ur12345678 or p.xxxx). Your watchlist must be public.';
        hint.classList.remove('err');
        var imdbCb = document.getElementById('imdb-include');
        var imdbWrap = document.getElementById('imdb-cb-wrap');
        imdbCb.disabled = true; imdbCb.checked = false;
        imdbWrap.classList.remove('enabled');
        document.getElementById('imdb-status').classList.remove('show');
        updateInstallAll();
        return;
      }
      // Allow pasting full profile URL
      var urlMatch = val.match(/(ur\\d{4,15}|p\\.[a-z0-9]{10,50})/);
      if (urlMatch) {
        val = urlMatch[1];
        document.getElementById('imdb-userid').value = val;
      }
      if (!IMDB_RE.test(val)) {
        hint.textContent = 'Invalid IMDB User ID. Paste your IMDB profile URL or enter the ID directly.';
        hint.classList.add('err');
        var imdbCb2 = document.getElementById('imdb-include');
        var imdbWrap2 = document.getElementById('imdb-cb-wrap');
        imdbCb2.disabled = true; imdbCb2.checked = false;
        imdbWrap2.classList.remove('enabled');
        document.getElementById('imdb-status').classList.remove('show');
        return;
      }
      hint.textContent = '';
      hint.classList.remove('err');
      var imdbCbOk = document.getElementById('imdb-include');
      var imdbWrapOk = document.getElementById('imdb-cb-wrap');
      imdbCbOk.disabled = false; imdbCbOk.checked = true;
      imdbWrapOk.classList.add('enabled');
      document.getElementById('imdb-status').classList.add('show');
      try { localStorage.setItem('imdb-userid', val); } catch(e) {}
      updateInstallAll();
    }

    // Restore IMDB user ID from localStorage
    (function() {
      try {
        var saved = localStorage.getItem('imdb-userid');
        var input = document.getElementById('imdb-userid');
        if (saved && input) {
          input.value = saved;
          input.dispatchEvent(new Event('input'));
        }
      } catch(e) {}
    })();

    // --- Install All (combined addon) ---
    function getServiceConfig() {
      var cfg = {};
      var alCb = document.getElementById('al-include');
      var alUrl = document.getElementById('al-url').textContent;
      if (alCb && alCb.checked && alUrl) {
        var alMatch = alUrl.match(/\\/anilist\\/([^\\/]+)\\/manifest\\.json/);
        if (alMatch) cfg.anilist = decodeURIComponent(alMatch[1]);
      }
      var malCb = document.getElementById('mal-include');
      var malToken = document.getElementById('mal-token');
      if (malCb && malCb.checked && malToken && /^[a-f0-9]{64}$/.test(malToken.value)) {
        cfg.mal = malToken.value;
      }
      var imdbCb = document.getElementById('imdb-include');
      var imdbInput = document.getElementById('imdb-userid');
      if (imdbCb && imdbCb.checked && imdbInput && imdbInput.value.trim() && /^(ur\\d{4,15}|p\\.[a-z0-9]{10,50})$/.test(imdbInput.value.trim())) {
        cfg.imdb = imdbInput.value.trim();
      }
      var lbCb = document.getElementById('lb-include');
      var lbToken = document.getElementById('lb-token');
      if (lbCb && lbCb.checked && lbToken && /^[a-f0-9]{64}$/.test(lbToken.value)) {
        cfg.letterboxd = lbToken.value;
      }
      return cfg;
    }

    function buildCombinedUrl(cfg) {
      var keys = Object.keys(cfg);
      if (keys.length === 0) return null;
      // If only one service, use the direct URL
      if (keys.length === 1) {
        var svc = keys[0];
        return BASE + '/' + svc + '/' + encodeURIComponent(cfg[svc]) + '/manifest.json';
      }
      // Multiple services: base64url-encode the config
      var jsonStr = JSON.stringify(cfg);
      var b64 = btoa(jsonStr).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      return BASE + '/combined/' + b64 + '/manifest.json';
    }

    function updateInstallAll() {
      var cfg = getServiceConfig();
      var keys = Object.keys(cfg);
      var btn = document.getElementById('install-all-btn');
      var hint = document.getElementById('install-hint');
      var manifest = document.getElementById('manifest-url');
      var copyBtn = document.getElementById('copy-manifest');
      var summary = document.getElementById('install-summary');
      var url = keys.length >= 1 ? buildCombinedUrl(cfg) : null;
      if (keys.length >= 1) {
        btn.href = 'stremio://' + url.replace(/^https?:\\/\\//, '');
        btn.style.pointerEvents = '';
        btn.style.opacity = '1';
        hint.textContent = keys.length === 1 ? 'Installing 1 service.' : 'Installing ' + keys.length + ' services combined.';
        manifest.textContent = url;
        copyBtn.disabled = false;
        summary.textContent = keys.length === 1
          ? '1 service ready. Its catalog filters will appear inside Stremio.'
          : keys.length + ' services ready in one combined manifest.';
      } else {
        btn.href = '#';
        btn.style.pointerEvents = 'none';
        btn.style.opacity = '.4';
        hint.textContent = 'Connect a service above, then check it to install.';
        manifest.textContent = 'No manifest generated yet';
        copyBtn.disabled = true;
        summary.textContent = 'Connect at least one service to generate a manifest.';
      }

      var catalogNodes = document.querySelectorAll('[data-catalog]');
      for (var i = 0; i < catalogNodes.length; i++) {
        var name = catalogNodes[i].getAttribute('data-catalog');
        catalogNodes[i].classList.toggle('show', keys.indexOf(name) !== -1);
      }
      document.getElementById('catalog-empty').style.display = keys.length ? 'none' : 'block';

      var checkboxIds = ['al-include', 'mal-include', 'imdb-include', 'lb-include'];
      var connected = checkboxIds.some(function(id) {
        var input = document.getElementById(id);
        return input && !input.disabled;
      });
      var activeStep = !connected ? 1 : keys.length === 0 ? 2 : 3;
      for (var step = 1; step <= 3; step++) {
        var stepEl = document.getElementById('step-' + step);
        stepEl.classList.toggle('active', step === activeStep);
        stepEl.classList.toggle('done', step < activeStep);
        document.querySelector('#step-' + step + ' .step-number').textContent = step < activeStep ? '✓' : String(step);
      }
    }

    function showToast(message) {
      var stack = document.getElementById('toast-stack');
      var item = document.createElement('div');
      item.className = 'toast';
      item.textContent = message;
      stack.appendChild(item);
      window.setTimeout(function() { item.remove(); }, 2800);
    }

    function copyManifest() {
      var value = document.getElementById('manifest-url').textContent;
      if (!value || value === 'No manifest generated yet') return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(function() { showToast('Manifest URL copied'); });
        return;
      }
      var textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      showToast('Manifest URL copied');
    }

    function openHelp() { document.getElementById('help-dialog').showModal(); }
    function closeHelp() { document.getElementById('help-dialog').close(); }

    document.getElementById('help-dialog').addEventListener('click', function(event) {
      if (event.target === this) closeHelp();
    });

    // Initial check
    updateInstallAll();
  </script>
</body>
</html>`);
}

app.get('/', configurePageHandler);
app.get('/configure', configurePageHandler);

// Initiate AniList OAuth authorization code flow
// Redirect URI registered in AniList app: http://localhost:3000/auth/anilist/callback
app.get('/auth/anilist', (req, res) => {
  if (!config.anilistClientId) {
    return res.status(400).send('<h2>ANILIST_CLIENT_ID not configured on this server.</h2>');
  }
  const host = req.headers.host || ('localhost:' + config.port);
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const redirectUri = protocol + '://' + host + '/auth/anilist/callback';
  res.redirect(
    ANILIST_OAUTH.AUTH_URL +
    '?client_id=' + encodeURIComponent(config.anilistClientId) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&response_type=code'
  );
});

// Initiate MAL OAuth PKCE flow — no username needed, discovered after auth
app.get('/auth/mal/connect', (req, res) => {
  if (!config.malClientId || !config.malClientSecret) {
    return res.status(400).send('<h2>MAL OAuth not configured on this server.</h2><a href="/">Try again</a>');
  }

  const host = req.headers.host || ('localhost:' + config.port);
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const redirectUri = `${protocol}://${host}/auth/mal/callback`;

  // MAL uses PKCE with plain method (code_challenge = code_verifier)
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const sessionId = crypto.randomBytes(16).toString('hex');
  tokenManager.storePkceVerifier(sessionId, codeVerifier);

  res.redirect(
    MAL_OAUTH.AUTH_URL +
    '?response_type=code' +
    '&client_id=' + encodeURIComponent(config.malClientId) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&state=' + encodeURIComponent(sessionId) +
    '&code_challenge=' + codeVerifier +
    '&code_challenge_method=plain'
  );
});

// Exchange MAL auth code for access token, discover username, store tokens
app.get('/auth/mal/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    return res.status(400).send(`<h2>Authentication failed: ${error}</h2><a href="/">Try again</a>`);
  }
  if (!code || !state) {
    return res.status(400).send('<h2>No authorization code received.</h2><a href="/">Try again</a>');
  }

  const codeVerifier = tokenManager.getPkceVerifier(state);
  if (!codeVerifier) {
    return res.status(400).send('<h2>Session expired. Please restart the authentication flow.</h2><a href="/">Try again</a>');
  }

  if (!config.malClientId || !config.malClientSecret) {
    return res.status(400).send('<h2>MAL OAuth not configured on this server.</h2><a href="/">Try again</a>');
  }

  const host = req.headers.host || ('localhost:' + config.port);
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const redirectUri = `${protocol}://${host}/auth/mal/callback`;

  try {
    const { data } = await axios.post(MAL_OAUTH.TOKEN_URL, new URLSearchParams({
      client_id: config.malClientId,
      client_secret: config.malClientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });

    // Discover the authenticated user's MAL username
    const malService = require('./services/mal');
    const username = await malService.getAuthenticatedUsername(data.access_token);
    if (!username) {
      return res.status(400).send('<h2>Could not retrieve your MAL username.</h2><a href="/">Try again</a>');
    }

    tokenManager.storeTokens('mal', username, data);

    // Issue a random opaque token for use in the addon URL — never expose the username
    const opaqueToken = crypto.randomBytes(32).toString('hex');
    tokenManager.storeOpaqueToken(opaqueToken, username);

    // Redirect back to configure page with the opaque token in the hash
    res.redirect(`${protocol}://${host}/configure#mal_token=${opaqueToken}`);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message;
    console.error('MAL OAuth callback error:', detail);
    res.status(400).send(`<h2>MAL authentication failed</h2><pre>${detail}</pre><p><a href="/">Try again</a></p>`);
  }
});

// Check if a MAL opaque token is still authenticated (valid access token OR usable refresh token)
app.get('/auth/mal/:token/status', (req, res) => {
  const { token } = req.params;
  if (!isValidMalToken(token)) return res.status(400).json({ error: 'Invalid token' });
  const username = tokenManager.resolveServiceOpaqueToken('mal', token);
  const authenticated = username ? tokenManager.canAuthenticate('mal', username) : false;
  res.json({ authenticated });
});

app.post('/auth/letterboxd/login', async (req, res) => {
  if (!config.letterboxdClientId || !config.letterboxdClientSecret) {
    return res.status(400).json({ error: 'Letterboxd OAuth not configured on this server.' });
  }

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required.' });
  }

  try {
    const letterboxdService = require('./services/letterboxd');
    await letterboxdService.authenticateUser(
      username,
      password,
      config.letterboxdClientId,
      config.letterboxdClientSecret
    );

    const opaqueToken = crypto.randomBytes(32).toString('hex');
    tokenManager.storeServiceOpaqueToken('letterboxd', opaqueToken, username);

    res.json({ token: opaqueToken, username: username.toLowerCase() });
  } catch (err) {
    const message = err.response?.data?.message || err.message || 'Letterboxd authentication failed.';
    console.error('Letterboxd login error:', message);
    res.status(400).json({ error: `Letterboxd authentication failed: ${message}` });
  }
});

app.get('/auth/letterboxd/:token/status', (req, res) => {
  const { token } = req.params;
  if (!isValidLetterboxdToken(token)) return res.status(400).json({ error: 'Invalid token' });
  res.json({ authenticated: tokenManager.hasValidTokensByOpaqueToken('letterboxd', token) });
});

// Exchange authorization code for token, return token to browser via URL hash
app.get('/auth/anilist/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('<h2>Missing authorization code.</h2><a href="/">Try again</a>');
  }
  const host = req.headers.host || ('localhost:' + config.port);
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const redirectUri = protocol + '://' + host + '/auth/anilist/callback';
  try {
    const { data } = await axios.post(ANILIST_OAUTH.TOKEN_URL, {
      grant_type: 'authorization_code',
      client_id: config.anilistClientId,
      client_secret: config.anilistClientSecret,
      redirect_uri: redirectUri,
      code
    }, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 10000
    });
    // Token returned in hash — never sent in a request, never stored server-side
    res.redirect(protocol + '://' + host + '/configure#anilist_token=' + encodeURIComponent(data.access_token));
  } catch (err) {
    const detail = err.response && err.response.data
      ? JSON.stringify(err.response.data, null, 2)
      : err.message;
    res.status(400).send('<h2>AniList authentication failed</h2><pre>' + detail + '</pre><p><a href="/">Try again</a></p>');
  }
});

// --- Combined addon routes ---
// Config token is base64url-encoded JSON: {"anilist":"<token>","mal":"<opaque>","imdb":"<userid>","letterboxd":"<opaque>"}
function parseCombinedConfig(configStr) {
  try {
    const json = Buffer.from(configStr, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Validate each service param
    for (const [svc, param] of Object.entries(parsed)) {
      if (!VALID_SERVICES.has(svc)) return null;
      if (!isValidServiceParam(svc, param)) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function serviceForCatalogId(id) {
  if (id.startsWith('anilist.')) return 'anilist';
  if (id.startsWith('mal.')) return 'mal';
  if (id.startsWith('imdb.')) return 'imdb';
  if (id.startsWith('letterboxd.')) return 'letterboxd';
  return null;
}

app.get('/combined/:config/manifest.json', (req, res) => {
  const svcConfig = parseCombinedConfig(req.params.config);
  if (!svcConfig) return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid combined config.' });
  try {
    res.json(addonInterface.getCombinedManifest(svcConfig));
  } catch (error) {
    console.error('Combined manifest error:', error.message);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'Failed to load manifest' });
  }
});

app.get('/combined/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
  const svcConfig = parseCombinedConfig(req.params.config);
  if (!svcConfig) return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid combined config.' });
  const { type, id, extra } = req.params;

  if (id === 'combined.anime.list' || id === 'combined.movie.list') {
    try {
      const catalog = await addonInterface.getCombinedCatalog(
        type, id, extra, svcConfig,
        config.malClientId, config.letterboxdClientId, config.letterboxdClientSecret
      );
      return res.json(catalog);
    } catch (error) {
      console.error('Combined merged catalog error:', error.message);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: error.message || 'Failed to fetch catalog' });
    }
  }

  const service = serviceForCatalogId(id);
  if (!service || !svcConfig[service]) return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Service not configured.' });
  try {
    const userParam = resolveServiceToken(service, svcConfig[service]);
    const catalog = await addonInterface.getCatalog(type, id, extra, userParam, service, config.malClientId, config.letterboxdClientId, config.letterboxdClientSecret);
    res.json(catalog);
  } catch (error) {
    console.error('Combined catalog error:', error.message);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: error.message || 'Failed to fetch catalog' });
  }
});

app.get('/combined/:config/meta/:type/:id.json', async (req, res) => {
  const svcConfig = parseCombinedConfig(req.params.config);
  if (!svcConfig) return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid combined config.' });
  const { type, id } = req.params;

  // kitsu: meta uses public Kitsu API — no credentials needed
  if (id.startsWith('kitsu:')) {
    try {
      const meta = await addonInterface.getMeta(type, id, null, 'mal', config.malClientId);
      return res.json(meta);
    } catch (error) {
      console.error('Combined meta error:', error.message);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: error.message || 'Failed to fetch meta' });
    }
  }

  // Determine service from ID prefix
  let service = 'anilist';
  if (id.startsWith('mal:')) {
    service = svcConfig.mal ? 'mal' : 'anilist';
  } else if (id.startsWith('tt')) {
    service = svcConfig.imdb ? 'imdb' : 'anilist';
  }
  const token = svcConfig[service];
  if (!token) return res.json({ meta: null });
  try {
    const userParam = resolveServiceToken(service, token);
    if ((service === 'mal' || service === 'letterboxd') && !userParam) return res.json({ meta: null });
    const meta = await addonInterface.getMeta(type, id, userParam, service, config.malClientId);
    res.json(meta);
  } catch (error) {
    console.error('Combined meta error:', error.message);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: error.message || 'Failed to fetch meta' });
  }
});

app.get('/combined/:config/stream/:type/:id.json', async (req, res) => {
  const svcConfig = parseCombinedConfig(req.params.config);
  if (!svcConfig) return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid combined config.' });
  const { type, id } = req.params;
  const videoInfo = {};
  if (req.query.season) videoInfo.season = parseInt(req.query.season, 10);
  if (req.query.episode) videoInfo.episode = parseInt(req.query.episode, 10);
  if (!videoInfo.episode && id.includes(':')) {
    const parts = id.split(':');
    if (parts.length >= 4) {
      const s = parseInt(parts[2], 10), e = parseInt(parts[3], 10);
      if (!isNaN(s) && s > 0) videoInfo.season = s;
      if (!isNaN(e) && e > 0) videoInfo.episode = e;
    } else if (parts.length === 3) {
      const e = parseInt(parts[2], 10);
      if (!isNaN(e) && e > 0) videoInfo.episode = e;
    }
  }
  try {
    const stream = await addonInterface.getCombinedStream(type, id, videoInfo, svcConfig, config.malClientId);
    res.json(stream);
  } catch (error) {
    console.error('Combined stream error:', error.message);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: error.message || 'Failed to fetch stream' });
  }
});

app.get('/:service/:token/manifest.json', (req, res) => {
  const { service, token } = req.params;
  if (!VALID_SERVICES.has(service)) return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Unknown service.' });
  if (!isValidServiceParam(service, token)) return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid identifier.' });
  if (service === 'mal' && !config.malClientId) return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'MAL not configured on this server (missing MAL_CLIENT_ID).' });
  if (service === 'letterboxd' && !(config.letterboxdClientId && config.letterboxdClientSecret)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Letterboxd not configured on this server (missing LETTERBOXD_CLIENT_ID / LETTERBOXD_CLIENT_SECRET).' });
  }
  if (service === 'mal' && !resolveServiceToken('mal', token)) return res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Invalid or expired MAL token.' });
  if (service === 'letterboxd' && !resolveServiceToken('letterboxd', token)) return res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Invalid or expired Letterboxd token.' });
  try {
    res.json(addonInterface.getManifest(service));
  } catch (error) {
    console.error('Manifest error:', error.message);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'Failed to load manifest' });
  }
});

app.get('/:service/:token/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { service, token, type, id, extra } = req.params;
  if (!VALID_SERVICES.has(service)) return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Unknown service.' });
  if (!isValidServiceParam(service, token)) return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid identifier.' });
  if (service === 'mal' && !config.malClientId) return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'MAL not configured on this server (missing MAL_CLIENT_ID).' });
  if (service === 'letterboxd' && !(config.letterboxdClientId && config.letterboxdClientSecret)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Letterboxd not configured on this server (missing LETTERBOXD_CLIENT_ID / LETTERBOXD_CLIENT_SECRET).' });
  }
  try {
    const userParam = resolveServiceToken(service, token);
    if ((service === 'mal' || service === 'letterboxd') && !userParam) return res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: `Invalid or expired ${service} token.` });
    const catalog = await addonInterface.getCatalog(
      type,
      id,
      extra,
      userParam,
      service,
      config.malClientId,
      config.letterboxdClientId,
      config.letterboxdClientSecret
    );
    res.json(catalog);
  } catch (error) {
    console.error('Catalog error:', error.message);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: error.message || 'Failed to fetch catalog' });
  }
});

app.get('/:service/:token/meta/:type/:id.json', async (req, res) => {
  const { service, token, type, id } = req.params;
  if (!VALID_SERVICES.has(service)) return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Unknown service.' });
  if (!isValidServiceParam(service, token)) return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid identifier.' });
  if (service === 'mal' && !config.malClientId) return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'MAL not configured on this server (missing MAL_CLIENT_ID).' });
  if (service === 'letterboxd' && !(config.letterboxdClientId && config.letterboxdClientSecret)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Letterboxd not configured on this server (missing LETTERBOXD_CLIENT_ID / LETTERBOXD_CLIENT_SECRET).' });
  }
  try {
    const userParam = resolveServiceToken(service, token);
    if ((service === 'mal' || service === 'letterboxd') && !userParam) return res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: `Invalid or expired ${service} token.` });
    const meta = await addonInterface.getMeta(type, id, userParam, service, config.malClientId);
    res.json(meta);
  } catch (error) {
    console.error('Meta error:', error.message);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: error.message || 'Failed to fetch meta' });
  }
});

app.get('/:service/:token/stream/:type/:id.json', async (req, res) => {
  const { service, token, type, id } = req.params;
  if (!VALID_SERVICES.has(service)) return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Unknown service.' });
  if (!isValidServiceParam(service, token)) return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid identifier.' });
  try {
    const videoInfo = {};

    // Check query params first (some clients pass season/episode there)
    if (req.query.season) videoInfo.season = parseInt(req.query.season, 10);
    if (req.query.episode) videoInfo.episode = parseInt(req.query.episode, 10);

    // If no episode in query params, extract from ID
    // Stremio series format: prefix:id:season:episode (4 parts)
    // Legacy format:         prefix:id:episode        (3 parts)
    if (!videoInfo.episode && id.includes(':')) {
      const parts = id.split(':');
      if (parts.length >= 4) {
        const potentialSeason = parseInt(parts[2], 10);
        const potentialEpisode = parseInt(parts[3], 10);
        if (!isNaN(potentialSeason) && potentialSeason > 0) {
          videoInfo.season = potentialSeason;
        }
        if (!isNaN(potentialEpisode) && potentialEpisode > 0) {
          videoInfo.episode = potentialEpisode;
        }
      } else if (parts.length === 3) {
        const potentialEpisode = parseInt(parts[2], 10);
        if (!isNaN(potentialEpisode) && potentialEpisode > 0) {
          videoInfo.episode = potentialEpisode;
        }
      }
    }

    if (!videoInfo.episode) {
      console.log(`No episode info found for stream request: ${id}`);
    }

    const userParam = resolveServiceToken(service, token);
    if ((service === 'mal' || service === 'letterboxd') && !userParam) return res.json({ streams: [] });
    const stream = await addonInterface.getStream(type, id, videoInfo, userParam, service, config.malClientId);
    res.json(stream);
  } catch (error) {
    console.error('Stream error:', error.message);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: error.message || 'Failed to fetch stream' });
  }
});

app.use((req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Not found', path: req.url });
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log('='.repeat(60));
  console.log('AniList Stremio Addon');
  console.log('='.repeat(60));
  console.log(`Port: ${config.port}`);
  console.log(`Configure: http://localhost:${config.port}/`);
  console.log(`Manifest:  http://localhost:${config.port}/anilist/<token>/manifest.json`);
  console.log('='.repeat(60));

  // Proactively refresh MAL tokens every 12 hours so they never expire
  // between user visits. Runs once at startup (after a short delay) and
  // then on the fixed interval.
  if (config.malClientId && config.malClientSecret) {
    const { refreshMalTokens } = require('./services/mal');

    async function proactiveMALRefresh() {
      const fs = require('fs');
      const path = require('path');
      const tokensFile = path.join(__dirname, 'data', 'tokens.json');
      let allTokens;
      try {
        allTokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
      } catch (_) {
        return;
      }

      const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days before expiry
      const now = Date.now();

      for (const [key, record] of Object.entries(allTokens)) {
        if (!key.startsWith('mal:') || key.startsWith('mal_link:')) continue;
        if (!record.refresh_token) continue;

        const needsRefresh = !record.expires_at || (record.expires_at - now) < REFRESH_THRESHOLD_MS;
        if (!needsRefresh) continue;

        const username = key.replace(/^mal:/, '');
        try {
          await refreshMalTokens(username, config.malClientId, config.malClientSecret);
          console.log(`[MAL] Proactive token refresh succeeded for user: ${username}`);
        } catch (err) {
          console.warn(`[MAL] Proactive token refresh failed for user "${username}": ${err.message}`);
        }
      }
    }

    // First run after 30 seconds, then every 12 hours
    setTimeout(proactiveMALRefresh, 30 * 1000);
    setInterval(proactiveMALRefresh, 12 * 60 * 60 * 1000);
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
