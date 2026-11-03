#!/usr/bin/env node
/*
 * Codespace Remote Browser
 * A real Chromium runs inside your Codespace, loads sites itself, and streams the
 * rendered page to a Chrome-style UI in your browser. Your clicks, scrolling and
 * typing are sent back to it.
 *
 *   npm install && npm run setup && npm start
 *
 * Then open the forwarded address for port 3000 from the Ports tab (keep it Private).
 *
 * Env: PORT=3000  QUALITY=60 (jpeg 20-90)  SCALE=1 (2 = sharper on hi-dpi, more bandwidth)
 *      NO_SANDBOX=1 (only if Chromium fails to start inside the container)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium, WebSocketServer;
try {
  ({ chromium } = require('playwright'));
  ({ WebSocketServer } = require('ws'));
} catch (e) {
  console.error('Missing dependencies. Run:  npm install && npm run setup');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const QUALITY = Math.min(90, Math.max(20, Number(process.env.QUALITY) || 60));
const SCALE = Math.min(3, Math.max(1, Number(process.env.SCALE) || 1));
const NO_SANDBOX = process.env.NO_SANDBOX === '1';
const STATE_FILE = path.join(__dirname, '.browser-state.json');

/* ------------------------------------------------------------------ */
/* Browser session (one shared session; reconnecting restores the tabs) */
/* ------------------------------------------------------------------ */
let browser = null, context = null;
const tabs = new Map();      // id -> tab
const byPage = new Map();    // Page -> tab
let activeId = null, nextId = 1;
let client = null;
let view = { w: 1280, h: 720 };

function clamp(n, lo, hi) { n = Math.round(Number(n) || lo); return Math.min(hi, Math.max(lo, n)); }

async function launch() {
  browser = await chromium.launch({ headless: true, args: NO_SANDBOX ? ['--no-sandbox'] : [] });
  const major = String(browser.version()).split('.')[0];
  const opts = {
    viewport: { width: view.w, height: view.h },
    deviceScaleFactor: SCALE,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36',
    acceptDownloads: false,
    locale: 'en-US'
  };
  if (fs.existsSync(STATE_FILE)) opts.storageState = STATE_FILE;
  try {
    context = await browser.newContext(opts);
  } catch (e) {
    delete opts.storageState; // corrupt state file
    context = await browser.newContext(opts);
  }
  context.on('page', onPage);
  await context.newPage();
  setInterval(saveState, 30000);
  setInterval(pollTitles, 1000);
}
function saveState() {
  if (context) context.storageState({ path: STATE_FILE }).catch(function () {});
}

function onPage(page) {
  const t = {
    id: nextId++, page: page, title: '', url: 'about:blank', requested: '', loading: false,
    favicon: '', cdp: null, casting: false, gotFrame: false, canBack: false, canFwd: false
  };
  tabs.set(t.id, t);
  byPage.set(page, t);

  page.on('close', function () { closed(t); });
  page.on('dialog', function (d) { d.accept().catch(function () {}); });
  page.on('download', function (d) { d.cancel().catch(function () {}); });
  page.on('framenavigated', function (f) {
    if (f === page.mainFrame()) { t.url = f.url(); t.favicon = ''; meta(t); push(); }
  });
  page.on('request', function (r) {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
      t.loading = true; push();
      setTimeout(function () { if (t.loading) { t.loading = false; push(); } }, 30000);
    }
  });
  page.on('load', function () { t.loading = false; meta(t); push(); });
  page.on('requestfailed', function (r) {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) { t.loading = false; push(); }
  });

  t.ready = initCdp(t);
  setActive(t.id);
}

async function initCdp(t) {
  t.cdp = await context.newCDPSession(t.page);
  t.cdp.on('Page.screencastFrame', function (f) {
    t.gotFrame = true;
    if (client && client.readyState === 1 && t.id === activeId && client.bufferedAmount < 2e6) {
      client.send(Buffer.from(f.data, 'base64'), { binary: true });
    }
    t.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(function () {});
  });
}

async function startCast(t) {
  try {
    await t.ready;
    if (t.casting) return;
    t.casting = true;
    t.gotFrame = false;
    await t.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: QUALITY, maxWidth: view.w * SCALE, maxHeight: view.h * SCALE, everyNthFrame: 1
    });
    // Static pages may not emit a frame right away; grab one manually.
    setTimeout(async function () {
      if (t.casting && !t.gotFrame && client && client.readyState === 1 && t.id === activeId) {
        try {
          const buf = await t.page.screenshot({ type: 'jpeg', quality: QUALITY });
          client.send(buf, { binary: true });
        } catch (e) { /* ignore */ }
      }
    }, 500);
  } catch (e) { t.casting = false; }
}
async function stopCast(t) {
  if (!t.casting) return;
  t.casting = false;
  try { await t.cdp.send('Page.stopScreencast'); } catch (e) { /* ignore */ }
}

async function setActive(id) {
  const next = tabs.get(id);
  if (!next) return;
  const prev = tabs.get(activeId);
  activeId = id;
  if (prev && prev !== next) stopCast(prev);
  try { await next.page.bringToFront(); } catch (e) { /* ignore */ }
  startCast(next);
  push();
}

function closed(t) {
  tabs.delete(t.id);
  byPage.delete(t.page);
  if (activeId === t.id) {
    activeId = null;
    const ids = Array.from(tabs.keys());
    if (ids.length) setActive(ids[ids.length - 1]);
    else context.newPage().catch(function () {});
  }
  push();
}

async function newTab(url) {
  const page = await context.newPage();
  const t = await tabFor(page);
  if (url && t) navigate(t, url);
}
async function tabFor(page) {
  for (let i = 0; i < 40; i++) {
    const t = byPage.get(page);
    if (t) return t;
    await new Promise(function (r) { setTimeout(r, 25); });
  }
  return null;
}

function navigate(t, url) {
  t.requested = url;
  t.loading = true;
  push();
  t.page.goto(url, { waitUntil: 'commit', timeout: 30000 })
    .catch(function () { /* error page is shown by Chromium */ })
    .then(function () { push(); });
}

async function meta(t) {
  try {
    const title = await t.page.title();
    let fav = '';
    try {
      fav = await t.page.evaluate(function () {
        const l = document.querySelector('link[rel~="icon"]');
        return l ? l.href : '';
      });
    } catch (e) { /* ignore */ }
    t.title = title;
    if (fav) t.favicon = fav;
    push();
  } catch (e) { /* page closed or navigating */ }
}
async function pollTitles() {
  for (const t of tabs.values()) {
    try {
      const title = await t.page.title();
      if (title !== t.title) { t.title = title; push(); }
    } catch (e) { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */
function send(obj) {
  if (client && client.readyState === 1) client.send(JSON.stringify(obj));
}
let pushTimer = null;
function push() {
  if (pushTimer) return;
  pushTimer = setTimeout(async function () {
    pushTimer = null;
    const a = tabs.get(activeId);
    if (a && a.cdp) {
      try {
        const h = await a.cdp.send('Page.getNavigationHistory');
        a.canBack = h.currentIndex > 0;
        a.canFwd = h.currentIndex < h.entries.length - 1;
      } catch (e) { /* ignore */ }
    }
    send({
      t: 'state', active: activeId,
      tabs: Array.from(tabs.values()).map(function (t) {
        return { id: t.id, title: t.title, url: t.url, requested: t.requested, loading: t.loading,
                 favicon: t.favicon, canBack: t.canBack, canFwd: t.canFwd };
      })
    });
  }, 30);
}

const MOUSE_BTN = { left: 'left', middle: 'middle', right: 'right' };
async function handle(m) {
  const t = tabs.get(activeId);
  switch (m.t) {
    case 'resize': {
      view = { w: clamp(m.w, 200, 3000), h: clamp(m.h, 200, 3000) };
      for (const x of tabs.values()) x.page.setViewportSize({ width: view.w, height: view.h }).catch(function () {});
      if (t) { await stopCast(t); await startCast(t); }
      break;
    }
    case 'nav': if (t && typeof m.url === 'string') navigate(t, m.url); break;
    case 'new': await newTab(typeof m.url === 'string' ? m.url : ''); break;
    case 'close': { const x = tabs.get(m.id); if (x) x.page.close().catch(function () {}); break; }
    case 'activate': await setActive(m.id); break;
    case 'back': if (t) t.page.goBack({ waitUntil: 'commit', timeout: 15000 }).catch(function () {}); break;
    case 'fwd': if (t) t.page.goForward({ waitUntil: 'commit', timeout: 15000 }).catch(function () {}); break;
    case 'reload': if (t) { t.loading = true; push(); t.page.reload({ waitUntil: 'commit', timeout: 30000 }).catch(function () {}); } break;
    case 'stop': if (t && t.cdp) { t.cdp.send('Page.stopLoading').catch(function () {}); t.loading = false; push(); } break;
    case 'mouse': {
      if (!t) break;
      const p = t.page;
      if (m.a === 'move') await p.mouse.move(m.x, m.y);
      else if (m.a === 'down') { await p.mouse.move(m.x, m.y); await p.mouse.down({ button: MOUSE_BTN[m.b] || 'left', clickCount: m.c || 1 }); }
      else if (m.a === 'up') { await p.mouse.move(m.x, m.y); await p.mouse.up({ button: MOUSE_BTN[m.b] || 'left', clickCount: m.c || 1 }); }
      break;
    }
    case 'wheel': if (t) { await t.page.mouse.move(m.x, m.y); await t.page.mouse.wheel(m.dx || 0, m.dy || 0); } break;
    case 'key': if (t && typeof m.k === 'string') {
      try { if (m.d) await t.page.keyboard.down(m.k); else await t.page.keyboard.up(m.k); } catch (e) { /* unknown key */ }
    } break;
    case 'type': if (t && typeof m.text === 'string') await t.page.keyboard.insertText(m.text); break;
    case 'copy': if (t) {
      try {
        const text = await t.page.evaluate(function () { return String(window.getSelection()); });
        if (text) send({ t: 'copied', text: text });
      } catch (e) { /* ignore */ }
    } break;
    case 'clear':
      await context.clearCookies();
      try { fs.unlinkSync(STATE_FILE); } catch (e) { /* none */ }
      send({ t: 'toast', msg: 'Cookies cleared.' });
      break;
  }
}
let queue = Promise.resolve(), pending = 0;
function enqueue(m) {
  if (m.t === 'mouse' && m.a === 'move' && pending > 2) return; // drop stale moves
  pending++;
  queue = queue.then(function () { return handle(m); }).catch(function () {}).then(function () { pending--; });
}

/* ------------------------------------------------------------------ */
/* HTTP + WebSocket                                                    */
/* ------------------------------------------------------------------ */
const ready = launch();
let launchError = null;
ready.catch(function (e) {
  launchError = e;
  console.error('\nCould not start Chromium:\n' + e.message.split('\n')[0]);
  console.error('Try:  npm run setup      (installs Chromium and system libraries)');
  console.error('If it still fails to launch, try:  NO_SANDBOX=1 npm start\n');
});

const server = http.createServer(function (req, res) {
  if (req.url === '/' || req.url.indexOf('/?') === 0) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(INDEX_HTML);
  }
  res.writeHead(404); res.end('Not found');
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', function (req, sock, head) {
  let okOrigin = false;
  try { okOrigin = new URL(req.headers.origin).host === req.headers.host; } catch (e) { /* no origin */ }
  if (req.url !== '/ws' || !okOrigin) return sock.destroy();
  wss.handleUpgrade(req, sock, head, function (ws) { wss.emit('connection', ws, req); });
});
wss.on('connection', function (ws) {
  if (client && client !== ws) { try { client.close(4000, 'replaced'); } catch (e) { /* ignore */ } }
  client = ws;
  ws.isAlive = true;
  ws.on('pong', function () { ws.isAlive = true; });
  ws.on('message', function (data, isBinary) {
    if (isBinary) return;
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (m && typeof m.t === 'string') enqueue(m);
  });
  ws.on('close', function () {
    if (client === ws) {
      client = null;
      const a = tabs.get(activeId);
      if (a) stopCast(a);
    }
  });
  send({ t: 'status', msg: 'Starting browser...' });
  ready.then(function () {
    push();
    const a = tabs.get(activeId);
    if (a) startCast(a);
  }, function (e) {
    const missing = /Executable doesn't exist/i.test(e.message);
    send({ t: 'fatal', msg: missing
      ? 'Chromium is not installed. In the Codespace terminal run: npm run setup, then restart the server.'
      : 'Chromium failed to start: ' + e.message.split('\n')[0] + ' (try restarting with NO_SANDBOX=1 npm start)' });
  });
});
setInterval(function () {
  wss.clients.forEach(function (ws) {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 25000);

server.listen(PORT, '0.0.0.0', function () {
  console.log('Remote browser UI on port ' + PORT + ' - open it from the Ports tab.');
});
function shutdown() {
  const done = function () { process.exit(0); };
  if (context) context.storageState({ path: STATE_FILE }).catch(function () {}).then(function () {
    (browser ? browser.close() : Promise.resolve()).catch(function () {}).then(done);
  }); else done();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', function (e) { console.error('unhandled:', e && e.message); });

/* ================================================================== */
/* The browser UI                                                      */
/* ================================================================== */
const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Remote Browser</title>
<style>
:root{
  --strip:#dee1e6; --tab:#ffffff; --tabh:#e9ebef; --bar:#ffffff; --omni:#f1f3f4; --omnif:#ffffff;
  --text:#202124; --muted:#5f6368; --line:#dadce0; --accent:#1a73e8; --hover:rgba(60,64,67,.12); --danger:#d93025;
}
@media (prefers-color-scheme: dark){
  :root{
    --strip:#202124; --tab:#35363a; --tabh:#2b2c2f; --bar:#35363a; --omni:#202124; --omnif:#202124;
    --text:#e8eaed; --muted:#9aa0a6; --line:#4a4c50; --accent:#8ab4f8; --hover:rgba(232,234,237,.12); --danger:#f28b82;
  }
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%;margin:0;overflow:hidden}
body{font:13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--text);background:var(--bar)}
button{font:inherit;color:inherit}
#app{display:flex;flex-direction:column;height:100%}

#tabstrip{display:flex;align-items:flex-end;gap:4px;padding:8px 8px 0;background:var(--strip);min-height:42px}
#tabs{display:flex;flex:1;min-width:0;align-items:flex-end}
.tab{position:relative;display:flex;align-items:center;gap:8px;flex:1 1 0;min-width:40px;max-width:240px;height:34px;padding:0 6px 0 12px;border-radius:9px 9px 0 0;color:var(--muted);cursor:default;user-select:none}
.tab:hover{background:var(--tabh)}
.tab.active{background:var(--tab);color:var(--text)}
.tab:not(.active)::after{content:"";position:absolute;right:0;top:9px;height:16px;width:1px;background:var(--line)}
.tab:hover::after{display:none}
.fav{width:16px;height:16px;border-radius:3px;flex:none}
.spin{width:14px;height:14px;flex:none;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.ttl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.x{flex:none;width:20px;height:20px;border:0;border-radius:50%;background:none;font-size:16px;line-height:1;cursor:pointer;color:inherit;opacity:.8}
.x:hover{background:var(--hover);opacity:1}
#newtab-btn{flex:none;width:28px;height:28px;margin:0 0 3px;border:0;border-radius:50%;background:none;font-size:20px;line-height:1;cursor:pointer;color:var(--muted)}
#newtab-btn:hover{background:var(--hover)}

#toolbar{display:flex;align-items:center;gap:4px;padding:6px 8px;background:var(--bar)}
.ib{flex:none;width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:50%;background:none;color:var(--muted);cursor:pointer}
.ib:hover:not(:disabled){background:var(--hover)}
.ib:disabled{opacity:.35;cursor:default}
.ib svg{width:20px;height:20px;fill:currentColor}
#omnibox{flex:1;min-width:0;height:34px;display:flex;align-items:center;gap:8px;padding:0 6px 0 14px;border-radius:17px;background:var(--omni);border:1px solid transparent}
#omnibox:focus-within{background:var(--omnif);border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
#sec{flex:none;display:flex;align-items:center;gap:4px;color:var(--muted);font-size:12px}
#sec svg{width:14px;height:14px;fill:currentColor}
#sec.warn{color:var(--danger)}
#url{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:var(--text);font-size:14px}
#star.on{color:var(--accent)}

#bookmarks{display:flex;gap:2px;padding:0 8px 4px;background:var(--bar);overflow:hidden;white-space:nowrap}
.bm{border:0;background:none;border-radius:14px;padding:5px 10px;cursor:pointer;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.bm:hover{background:var(--hover)}
#chrome-line{height:1px;background:var(--line)}
#loadbar{height:2px;position:relative;overflow:hidden;background:transparent}
#loadbar.on::after{content:"";position:absolute;top:0;bottom:0;width:35%;background:var(--accent);animation:ld 1.1s ease-in-out infinite}
@keyframes ld{from{transform:translateX(-100%)}to{transform:translateX(300%)}}

#viewport{position:relative;flex:1;background:#fff;min-height:0}
#screen{position:absolute;inset:0;width:100%;height:100%;display:block;outline:0;touch-action:none;background:#fff}

#newtab{position:absolute;inset:0;display:none;background:var(--bar);overflow:auto;z-index:2}
#newtab.show{display:block}
.nt-inner{max-width:640px;margin:0 auto;padding:16vh 20px 40px;text-align:center}
.nt-inner h1{margin:0 0 28px;font-size:34px;font-weight:500;letter-spacing:-.5px}
#nt-q{width:100%;height:46px;padding:0 22px;border:1px solid var(--line);border-radius:23px;background:var(--omni);color:var(--text);font-size:16px;outline:0}
#nt-q:focus{background:var(--omnif);border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
#tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:12px;margin-top:36px}
.tile{display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 6px;border:0;border-radius:10px;background:none;cursor:pointer}
.tile:hover{background:var(--hover)}
.tile i{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;background:var(--omni);font-style:normal;font-size:20px;color:var(--accent)}

#overlay{position:absolute;inset:0;z-index:5;display:none;place-items:center;background:rgba(0,0,0,.5);color:#fff;text-align:center;padding:24px}
#overlay.show{display:grid}
#overlay p{margin:0 0 14px;font-size:15px;max-width:420px}
#overlay button{border:0;border-radius:18px;padding:9px 18px;background:var(--accent);color:#fff;font-size:14px;cursor:pointer}

#menu{position:fixed;top:84px;right:10px;z-index:10;min-width:230px;padding:6px 0;border-radius:8px;background:var(--bar);border:1px solid var(--line);box-shadow:0 4px 18px rgba(0,0,0,.25)}
#menu button{display:flex;justify-content:space-between;gap:20px;width:100%;padding:9px 16px;border:0;background:none;text-align:left;cursor:pointer;font-size:13px}
#menu button:hover{background:var(--hover)}
#menu kbd{color:var(--muted);font:inherit}
#menu hr{border:0;border-top:1px solid var(--line);margin:6px 0}
#kb{position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;border:0;padding:0}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
</style>
</head>
<body>
<div id="app">
  <div id="tabstrip">
    <div id="tabs"></div>
    <button id="newtab-btn" title="New tab (Alt+T)">+</button>
  </div>
  <div id="toolbar">
    <button class="ib" id="back" title="Back" disabled><svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></button>
    <button class="ib" id="fwd" title="Forward" disabled><svg viewBox="0 0 24 24"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/></svg></button>
    <button class="ib" id="reload" title="Reload (Alt+R)"><svg viewBox="0 0 24 24"><path id="reload-path" d="M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></button>
    <div id="omnibox">
      <span id="sec" hidden></span>
      <input id="url" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="Search DuckDuckGo or type a URL" aria-label="Address bar">
      <button class="ib" id="star" title="Bookmark this page"><svg viewBox="0 0 24 24"><path id="star-path" d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/></svg></button>
    </div>
    <button class="ib" id="menu-btn" title="Menu"><svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>
  </div>
  <div id="bookmarks"></div>
  <div id="chrome-line"></div>
  <div id="loadbar"></div>
  <div id="viewport">
    <canvas id="screen" tabindex="0"></canvas>
    <div id="newtab">
      <div class="nt-inner">
        <h1>Remote Browser</h1>
        <input id="nt-q" type="text" spellcheck="false" autocomplete="off" placeholder="Search DuckDuckGo or type a URL" aria-label="Search or enter address">
        <div id="tiles"></div>
      </div>
    </div>
    <div id="overlay"><div><p id="ov-msg"></p><button id="ov-btn" hidden>Use it here</button></div></div>
  </div>
</div>

<div id="menu" hidden>
  <button data-a="newtab">New tab <kbd>Alt+T</kbd></button>
  <button data-a="close">Close tab <kbd>Alt+W</kbd></button>
  <hr>
  <button data-a="kb">Show keyboard</button>
  <button data-a="bar">Show or hide bookmarks bar</button>
  <button data-a="clear">Clear cookies</button>
</div>
<input id="kb" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Keyboard input">

<script>
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var canvas = $('#screen'), ctx = canvas.getContext('2d');
  var tabsEl = $('#tabs'), urlEl = $('#url'), nt = $('#newtab'), ov = $('#overlay'), kb = $('#kb');
  var ws = null, state = { tabs: [], active: null }, view = { w: 1280, h: 720 };
  var retry = 0, halted = false;
  var els = {};

  var STAR_OFF = 'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z';
  var STAR_ON = 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';
  var RELOAD = 'M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z';
  var STOP = 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';
  var LOCK = '<svg viewBox="0 0 24 24"><path d="M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9V6z"/></svg>';

  /* ---------- helpers ---------- */
  function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return u; } }
  function originOf(u) { try { var o = new URL(u); return /^https?:$/.test(o.protocol) ? o.origin : ''; } catch (e) { return ''; } }
  function toUrl(s) {
    s = (s || '').trim();
    if (!s) return '';
    if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(s)) return s;
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([\/?#].*)?$/i.test(s)) return 'http://' + s;
    if (!/\s/.test(s) && /^[\w\-]+(\.[\w\-]+)+(:\d+)?([\/?#].*)?$/i.test(s)) return 'https://' + s;
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
  }
  function cur() {
    for (var i = 0; i < state.tabs.length; i++) if (state.tabs[i].id === state.active) return state.tabs[i];
    return null;
  }
  function shownUrl(t) {
    if (!t) return '';
    var u = t.url.indexOf('chrome-error:') === 0 ? (t.requested || '') : t.url;
    return u === 'about:blank' ? '' : u;
  }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function setOverlay(msg, button) {
    ov.classList.toggle('show', !!msg);
    $('#ov-msg').textContent = msg || '';
    $('#ov-btn').hidden = !button;
  }
  $('#ov-btn').addEventListener('click', function () { location.reload(); });

  /* ---------- connection ---------- */
  function connect() {
    setOverlay('Connecting...');
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.binaryType = 'blob';
    ws.onopen = function () { retry = 0; sendResize(); };
    ws.onmessage = function (e) {
      if (typeof e.data !== 'string') { draw(e.data); return; }
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t === 'state') { state = m; setOverlay(''); render(); }
      else if (m.t === 'status') setOverlay(m.msg);
      else if (m.t === 'fatal') { halted = true; setOverlay(m.msg); }
      else if (m.t === 'copied') { try { navigator.clipboard.writeText(m.text); } catch (x) {} }
      else if (m.t === 'toast') alert(m.msg);
    };
    ws.onclose = function (e) {
      if (e.code === 4000) { halted = true; setOverlay('This browser is open in another window.', true); return; }
      if (halted) return;
      setOverlay('Reconnecting...');
      setTimeout(connect, Math.min(5000, 500 * ++retry));
    };
  }

  /* ---------- screen ---------- */
  var drawing = false, pendingBlob = null;
  function draw(blob) {
    pendingBlob = blob;
    if (drawing) return;
    drawing = true;
    (function next() {
      var b = pendingBlob; pendingBlob = null;
      if (!b) { drawing = false; return; }
      createImageBitmap(b).then(function (bmp) {
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        next();
      }).catch(next);
    })();
  }
  var vp = $('#viewport'), rzTimer = null;
  function sendResize() {
    view.w = Math.max(200, Math.floor(vp.clientWidth));
    view.h = Math.max(200, Math.floor(vp.clientHeight));
    send({ t: 'resize', w: view.w, h: view.h });
  }
  if (window.ResizeObserver) new ResizeObserver(function () { clearTimeout(rzTimer); rzTimer = setTimeout(sendResize, 150); }).observe(vp);
  window.addEventListener('resize', function () { clearTimeout(rzTimer); rzTimer = setTimeout(sendResize, 150); });

  /* ---------- render UI state ---------- */
  function makeTab(t) {
    var root = document.createElement('div');
    root.className = 'tab';
    root.innerHTML = '<img class="fav" alt="" referrerpolicy="no-referrer" hidden><span class="spin" hidden></span><span class="ttl"></span><button class="x" title="Close tab">&times;</button>';
    var o = { root: root, fav: root.querySelector('.fav'), spin: root.querySelector('.spin'), ttl: root.querySelector('.ttl'), bad: '' };
    o.fav.addEventListener('error', function () { o.bad = o.fav.getAttribute('src'); o.fav.hidden = true; });
    root.addEventListener('mousedown', function (e) { if (e.button === 1) { e.preventDefault(); send({ t: 'close', id: t.id }); } });
    root.addEventListener('click', function (e) {
      if (e.target.classList.contains('x')) send({ t: 'close', id: t.id }); else send({ t: 'activate', id: t.id });
    });
    return o;
  }
  function render() {
    var seen = {};
    state.tabs.forEach(function (t) {
      seen[t.id] = 1;
      var o = els[t.id];
      if (!o) { o = els[t.id] = makeTab(t); tabsEl.appendChild(o.root); }
      o.root.classList.toggle('active', t.id === state.active);
      var u = shownUrl(t);
      o.ttl.textContent = t.title || (u ? hostOf(u) : 'New Tab');
      o.spin.hidden = !t.loading;
      var ico = t.favicon || (u && originOf(u) ? originOf(u) + '/favicon.ico' : '');
      if (ico && o.fav.getAttribute('src') !== ico) o.fav.setAttribute('src', ico);
      o.fav.hidden = !ico || t.loading || o.bad === ico;
    });
    Object.keys(els).forEach(function (id) {
      if (!seen[id]) { els[id].root.remove(); delete els[id]; }
    });
    var t = cur();
    if (!t) return;
    var u2 = shownUrl(t);
    nt.classList.toggle('show', t.url === 'about:blank' && !t.loading);
    if (document.activeElement !== urlEl) urlEl.value = u2.replace(/^https:\/\//, '');
    $('#back').disabled = !t.canBack;
    $('#fwd').disabled = !t.canFwd;
    $('#reload-path').setAttribute('d', t.loading ? STOP : RELOAD);
    $('#reload').title = t.loading ? 'Stop' : 'Reload (Alt+R)';
    $('#loadbar').classList.toggle('on', !!t.loading);
    var has = u2 !== '';
    var starred = has && bmIndex(u2) >= 0;
    $('#star').classList.toggle('on', starred);
    $('#star-path').setAttribute('d', starred ? STAR_ON : STAR_OFF);
    $('#star').disabled = !has;
    var sec = $('#sec');
    if (!has) sec.hidden = true;
    else if (/^http:/i.test(u2)) { sec.hidden = false; sec.className = 'warn'; sec.innerHTML = LOCK + '<span>Not secure</span>'; }
    else { sec.hidden = false; sec.className = ''; sec.innerHTML = LOCK; }
    document.title = (t.title ? t.title + ' - ' : '') + 'Remote Browser';
  }

  /* ---------- bookmarks ---------- */
  var BM_KEY = 'rb:bookmarks', BAR_KEY = 'rb:bar';
  var showBar = localStorage.getItem(BAR_KEY) !== '0';
  function loadBm() {
    try { var v = JSON.parse(localStorage.getItem(BM_KEY)); if (Array.isArray(v)) return v; } catch (e) {}
    return [
      { t: 'Wikipedia', u: 'https://en.wikipedia.org/' },
      { t: 'Hacker News', u: 'https://news.ycombinator.com/' },
      { t: 'DuckDuckGo', u: 'https://duckduckgo.com/' }
    ];
  }
  var bms = loadBm();
  function bmIndex(u) { for (var i = 0; i < bms.length; i++) if (bms[i].u === u) return i; return -1; }
  function saveBm() {
    try { localStorage.setItem(BM_KEY, JSON.stringify(bms)); } catch (e) {}
    renderBm(); render();
  }
  function renderBm() {
    var bar = $('#bookmarks');
    bar.innerHTML = '';
    bms.forEach(function (b, i) {
      var a = document.createElement('button');
      a.className = 'bm';
      a.textContent = b.t || hostOf(b.u);
      a.title = b.u + ' (right-click to remove)';
      a.addEventListener('click', function (e) {
        if (e.ctrlKey || e.metaKey) send({ t: 'new', url: b.u }); else send({ t: 'nav', url: b.u });
      });
      a.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        if (confirm('Remove bookmark "' + a.textContent + '"?')) { bms.splice(i, 1); saveBm(); }
      });
      bar.appendChild(a);
    });
    bar.hidden = !showBar || bms.length === 0;
  }

  /* ---------- toolbar ---------- */
  $('#back').addEventListener('click', function () { send({ t: 'back' }); });
  $('#fwd').addEventListener('click', function () { send({ t: 'fwd' }); });
  $('#reload').addEventListener('click', function () {
    var t = cur(); if (!t) return;
    send({ t: t.loading ? 'stop' : 'reload' });
  });
  $('#star').addEventListener('click', function () {
    var t = cur(); var u = shownUrl(t);
    if (!u) return;
    var i = bmIndex(u);
    if (i >= 0) bms.splice(i, 1); else bms.push({ t: t.title, u: u });
    saveBm();
  });
  $('#newtab-btn').addEventListener('click', function () { send({ t: 'new' }); });

  urlEl.addEventListener('focus', function () {
    var t = cur(); if (t) urlEl.value = shownUrl(t);
    setTimeout(function () { urlEl.select(); }, 0);
  });
  urlEl.addEventListener('blur', render);
  urlEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var u = toUrl(urlEl.value); urlEl.blur();
      if (u) send({ t: 'nav', url: u });
    } else if (e.key === 'Escape') urlEl.blur();
  });
  $('#nt-q').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var u = toUrl(e.target.value); e.target.value = '';
      if (u) send({ t: 'nav', url: u });
    }
  });
  [
    ['DuckDuckGo', 'https://duckduckgo.com/', 'D'],
    ['Wikipedia', 'https://en.wikipedia.org/', 'W'],
    ['Hacker News', 'https://news.ycombinator.com/', 'Y'],
    ['GitHub', 'https://github.com/', 'G'],
    ['MDN', 'https://developer.mozilla.org/', 'M'],
    ['Reddit', 'https://www.reddit.com/', 'R']
  ].forEach(function (x) {
    var b = document.createElement('button');
    b.className = 'tile';
    b.innerHTML = '<i>' + x[2] + '</i><span>' + x[0] + '</span>';
    b.addEventListener('click', function () { send({ t: 'nav', url: x[1] }); });
    $('#tiles').appendChild(b);
  });

  /* ---------- menu ---------- */
  var menu = $('#menu');
  function closeMenu() { menu.hidden = true; }
  $('#menu-btn').addEventListener('click', function (e) { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', closeMenu);
  window.addEventListener('blur', closeMenu);
  menu.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var a = b.getAttribute('data-a');
    if (a === 'newtab') send({ t: 'new' });
    else if (a === 'close') send({ t: 'close', id: state.active });
    else if (a === 'kb') kb.focus();
    else if (a === 'bar') { showBar = !showBar; localStorage.setItem(BAR_KEY, showBar ? '1' : '0'); renderBm(); }
    else if (a === 'clear') send({ t: 'clear' });
  });

  /* ---------- mouse / wheel ---------- */
  var BTN = ['left', 'middle', 'right'];
  function pos(e) {
    var r = canvas.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) * view.w / r.width), y: Math.round((e.clientY - r.top) * view.h / r.height) };
  }
  var dragging = false, mvPending = null;
  canvas.addEventListener('mousedown', function (e) {
    canvas.focus(); e.preventDefault(); dragging = true;
    var p = pos(e);
    send({ t: 'mouse', a: 'down', x: p.x, y: p.y, b: BTN[e.button] || 'left', c: e.detail || 1 });
  });
  window.addEventListener('mouseup', function (e) {
    if (!dragging) return;
    dragging = false;
    var p = pos(e);
    send({ t: 'mouse', a: 'up', x: p.x, y: p.y, b: BTN[e.button] || 'left', c: e.detail || 1 });
  });
  window.addEventListener('mousemove', function (e) {
    if (e.target !== canvas && !dragging) return;
    var p = pos(e);
    if (mvPending) { mvPending = p; return; }
    mvPending = p;
    requestAnimationFrame(function () { var q = mvPending; mvPending = null; send({ t: 'mouse', a: 'move', x: q.x, y: q.y }); });
  });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var p = pos(e);
    var k = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? view.h : 1);
    send({ t: 'wheel', x: p.x, y: p.y, dx: e.deltaX * k, dy: e.deltaY * k });
  }, { passive: false });

  /* ---------- touch ---------- */
  var tch = null;
  canvas.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { tch = null; return; }
    var t = e.touches[0];
    tch = { x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY, at: Date.now(), moved: false };
  }, { passive: true });
  canvas.addEventListener('touchmove', function (e) {
    if (!tch) return;
    e.preventDefault();
    var t = e.touches[0];
    var dx = tch.lx - t.clientX, dy = tch.ly - t.clientY;
    if (Math.abs(t.clientX - tch.x) + Math.abs(t.clientY - tch.y) > 8) tch.moved = true;
    tch.lx = t.clientX; tch.ly = t.clientY;
    var p = pos(t);
    send({ t: 'wheel', x: p.x, y: p.y, dx: dx, dy: dy });
  }, { passive: false });
  canvas.addEventListener('touchend', function (e) {
    if (!tch) return;
    var c = tch; tch = null;
    if (!c.moved && Date.now() - c.at < 500) {
      e.preventDefault();
      var p = pos({ clientX: c.x, clientY: c.y });
      send({ t: 'mouse', a: 'move', x: p.x, y: p.y });
      send({ t: 'mouse', a: 'down', x: p.x, y: p.y, b: 'left', c: 1 });
      send({ t: 'mouse', a: 'up', x: p.x, y: p.y, b: 'left', c: 1 });
    }
  }, { passive: false });

  /* ---------- keyboard ---------- */
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  function kmap(k) { return (isMac && k === 'Meta') ? 'Control' : k; }
  function skipKey(e) { return e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified'; }
  canvas.addEventListener('keydown', function (e) {
    if (e.altKey && /^Key[TWLR]$/.test(e.code)) return;
    var mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'v') return;
    if (mod && k === 'c') send({ t: 'copy' });
    if (skipKey(e)) return;
    e.preventDefault();
    send({ t: 'key', d: 1, k: kmap(e.key) });
  });
  canvas.addEventListener('keyup', function (e) {
    if (e.altKey && /^Key[TWLR]$/.test(e.code)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
    if (skipKey(e)) return;
    e.preventDefault();
    send({ t: 'key', d: 0, k: kmap(e.key) });
  });
  document.addEventListener('paste', function (e) {
    var a = document.activeElement;
    if (a !== canvas && a !== kb) return;
    var text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (text) { e.preventDefault(); send({ t: 'type', text: text }); }
  });
  // On-screen keyboard (touch devices): menu > Show keyboard
  kb.addEventListener('input', function () { if (kb.value) { send({ t: 'type', text: kb.value }); kb.value = ''; } });
  kb.addEventListener('keydown', function (e) {
    if (e.key === 'Backspace' || e.key === 'Enter' || e.key === 'Tab' || e.key.indexOf('Arrow') === 0) {
      e.preventDefault();
      send({ t: 'key', d: 1, k: e.key }); send({ t: 'key', d: 0, k: e.key });
    }
  });
  document.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyT') { e.preventDefault(); send({ t: 'new' }); }
    else if (e.code === 'KeyW') { e.preventDefault(); send({ t: 'close', id: state.active }); }
    else if (e.code === 'KeyL') { e.preventDefault(); urlEl.focus(); }
    else if (e.code === 'KeyR') { e.preventDefault(); $('#reload').click(); }
  });

  renderBm();
  connect();
})();
</script>
</body>
</html>
`;
