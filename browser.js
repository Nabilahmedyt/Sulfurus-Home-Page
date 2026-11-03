#!/usr/bin/env node
/*
 * Codespace Browser — a Chrome-style web proxy in ONE file, zero dependencies.
 *
 *   node browser.js            (Node 18+; Codespaces already has it)
 *
 * Then open the forwarded port (3000) from the Ports tab. Type a URL or a
 * search; every request is fetched by the Codespace and relayed to you.
 *
 * Env: PORT=3000   ALLOW_PRIVATE=1 (allow localhost / private IP targets)
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const { Readable, pipeline } = require('stream');

const PORT = process.env.PORT || 3000;
const ALLOW_PRIVATE = !!process.env.ALLOW_PRIVATE;
const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* Cookie jar (server side, per browser session)                       */
/* ------------------------------------------------------------------ */
const jars = new Map(); // sid -> Map(domain -> Map(name -> value))

function getSid(req, res) {
  const m = /(?:^|;\s*)psid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (m) return m[1];
  const sid = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', 'psid=' + sid + '; Path=/; HttpOnly; SameSite=Lax');
  return sid;
}

function storeCookies(sid, host, list) {
  let jar = jars.get(sid);
  if (!jar) jars.set(sid, (jar = new Map()));
  host = host.toLowerCase();
  for (const sc of list) {
    const parts = sc.split(';');
    const eq = parts[0].indexOf('=');
    if (eq < 1) continue;
    const name = parts[0].slice(0, eq).trim();
    const value = parts[0].slice(eq + 1).trim();
    let domain = host;
    let del = false;
    for (const p of parts.slice(1)) {
      const i = p.indexOf('=');
      const k = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? '' : p.slice(i + 1).trim();
      if (k === 'domain' && v) {
        const d = v.replace(/^\./, '').toLowerCase();
        if (host === d || host.endsWith('.' + d)) domain = d;
      } else if (k === 'max-age' && Number(v) <= 0) del = true;
      else if (k === 'expires' && Date.parse(v) < Date.now()) del = true;
    }
    let m = jar.get(domain);
    if (!m) jar.set(domain, (m = new Map()));
    if (del) m.delete(name);
    else m.set(name, value);
  }
}

function cookieHeader(sid, host) {
  const jar = jars.get(sid);
  if (!jar) return '';
  host = host.toLowerCase();
  const out = [];
  for (const [d, m] of jar)
    if (host === d || host.endsWith('.' + d)) for (const [n, v] of m) out.push(n + '=' + v);
  return out.join('; ');
}

/* ------------------------------------------------------------------ */
/* URL / HTML / CSS rewriting                                          */
/* ------------------------------------------------------------------ */
const SKIP = /^(javascript:|data:|blob:|about:|mailto:|tel:|#|\/proxy\?url=)/i;
const decodeEnt = (s) => s.replace(/&amp;/g, '&');

function proxify(u, base) {
  if (u == null) return u;
  const s = decodeEnt(String(u)).trim();
  if (!s || SKIP.test(s)) return u;
  let a;
  try {
    a = new URL(s, base);
  } catch {
    return u;
  }
  if (a.protocol !== 'http:' && a.protocol !== 'https:') return u;
  const h = a.hash;
  a.hash = '';
  return '/proxy?url=' + encodeURIComponent(a.href) + h;
}

function rewriteSrcset(v, base) {
  return decodeEnt(v)
    .split(/,\s+/)
    .map((c) => {
      const p = c.trim().split(/\s+/);
      p[0] = proxify(p[0], base);
      return p.join(' ');
    })
    .join(', ');
}

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, u) => 'url(' + q + proxify(u.trim(), base) + q + ')')
    .replace(/@import\s+(['"])(.*?)\1/gi, (m, q, u) => '@import ' + q + proxify(u, base) + q);
}

const jsonForScript = (s) => JSON.stringify(s).replace(/</g, '\\u003c');

function rewriteHtml(html, pageUrl) {
  let base = pageUrl;
  const bm = /<base\s[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>/i.exec(html);
  if (bm) {
    try {
      base = new URL(decodeEnt(bm[2]), pageUrl).href;
    } catch {}
    html = html.replace(bm[0], '');
  }
  html = html
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?(?:content-security-policy|x-frame-options)[^>]*>/gi, '')
    .replace(/\sintegrity\s*=\s*(["']).*?\1/gi, '')
    .replace(
      /(\s(?:href|src|poster|data-src|data-href)\s*=\s*)(["'])(.*?)\2/gis,
      (m, a, q, v) => a + q + proxify(v, base) + q
    )
    .replace(
      /(\s(?:srcset|data-srcset|imagesrcset)\s*=\s*)(["'])(.*?)\2/gis,
      (m, a, q, v) => a + q + rewriteSrcset(v, base) + q
    )
    .replace(
      /(<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']\s*\d+\s*;\s*url=\s*)([^"']+)/gi,
      (m, a, v) => a + proxify(v, base)
    )
    .replace(/(\sstyle\s*=\s*)(["'])(.*?)\2/gis, (m, a, q, v) => a + q + rewriteCss(v, base) + q)
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, c) => a + rewriteCss(css, base) + c);

  const inj =
    '<script>window.__PX_BASE=' + jsonForScript(base) + ';window.__PX_URL=' + jsonForScript(pageUrl) +
    ';</script><script src="/_px/client.js"></script>';
  let m = /<head(?:\s[^>]*)?>/i.exec(html) || /<html(?:\s[^>]*)?>/i.exec(html) || /^\s*<!doctype[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + inj + html.slice(m.index + m[0].length);
  return inj + html;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function realFromReferer(req) {
  const r = req.headers.referer;
  if (!r) return null;
  try {
    const x = new URL(r);
    if (x.pathname === '/proxy') return x.searchParams.get('url');
  } catch {}
  return null;
}

function isBlocked(u) {
  if (ALLOW_PRIVATE) return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '0.0.0.0') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31))
      return true;
  }
  return false;
}

function readBody(req) {
  return new Promise((ok, no) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => ok(Buffer.concat(c)));
    req.on('error', no);
  });
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(body);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function errorPage(res, status, title, detail, url) {
  const html =
    '<!doctype html><meta charset="utf-8"><title>' + esc(title) + '</title>' +
    '<style>body{font:15px system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 24px;color:#202124}' +
    'h1{font-size:22px;font-weight:500}p{color:#5f6368;line-height:1.5}code{background:#f1f3f4;padding:2px 6px;border-radius:4px;word-break:break-all}' +
    '@media(prefers-color-scheme:dark){body{background:#202124;color:#e8eaed}p{color:#9aa0a6}code{background:#35363a}}</style>' +
    '<h1>' + esc(title) + '</h1><p>' + esc(detail || '') + '</p>' + (url ? '<p><code>' + esc(url) + '</code></p>' : '') +
    '<script>try{parent.postMessage({type:"nav",url:' + jsonForScript(url || '') + ',title:' + jsonForScript(title) + ',icon:""},location.origin)}catch(e){}</script>';
  send(res, status, 'text/html', html);
}

const DROP = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'content-encoding',
  'transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'strict-transport-security',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'permissions-policy', 'report-to', 'nel', 'alt-svc', 'link', 'etag', 'last-modified', 'content-length',
  'location', 'public-key-pins', 'clear-site-data',
]);

/* ------------------------------------------------------------------ */
/* The proxy endpoint                                                  */
/* ------------------------------------------------------------------ */
async function handleProxy(req, res, u, sid) {
  let target;
  try {
    target = new URL(u.searchParams.get('url'));
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('protocol');
  } catch {
    return errorPage(res, 400, 'Invalid address', 'That is not a valid http(s) URL.', u.searchParams.get('url'));
  }
  if (isBlocked(target))
    return errorPage(res, 403, 'Blocked address', 'Local and private network addresses are blocked. Start with ALLOW_PRIVATE=1 to allow them.', target.href);

  const headers = {};
  for (const h of ['accept', 'accept-language', 'content-type', 'range', 'user-agent'])
    if (req.headers[h]) headers[h] = req.headers[h];
  headers['user-agent'] = headers['user-agent'] || FALLBACK_UA;
  headers.referer = realFromReferer(req) || target.origin + '/';
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  if (hasBody) headers.origin = target.origin;
  const ck = cookieHeader(sid, target.hostname);
  if (ck) headers.cookie = ck;

  const body = hasBody ? await readBody(req) : undefined;
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  let r;
  try {
    r = await fetch(target.href, {
      method: req.method,
      headers,
      body: body && body.length ? body : undefined,
      redirect: 'manual',
      signal: ac.signal,
    });
  } catch (e) {
    if (ac.signal.aborted) return;
    return errorPage(res, 502, "This site can't be reached", (e.cause && (e.cause.code || e.cause.message)) || e.message, target.href);
  }

  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (sc.length) storeCookies(sid, target.hostname, sc);

  const out = {};
  r.headers.forEach((v, k) => {
    if (!DROP.has(k)) out[k] = v;
  });
  const loc = r.headers.get('location');
  if (loc) out.location = proxify(loc, target.href);
  out['referrer-policy'] = 'same-origin';

  const ct = r.headers.get('content-type') || '';
  const isHtml = /text\/html/i.test(ct);
  const isCss = /text\/css/i.test(ct);

  if (req.method === 'HEAD' || [204, 304].includes(r.status) || (r.status >= 300 && r.status < 400)) {
    res.writeHead(r.status, out);
    return res.end();
  }

  if (isHtml || isCss) {
    const buf = Buffer.from(await r.arrayBuffer());
    let cs = (/charset=([^;\s]+)/i.exec(ct) || [])[1];
    if (!cs) cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1')) || [])[1] || 'utf-8';
    let text;
    try {
      text = new TextDecoder(cs).decode(buf);
    } catch {
      text = buf.toString('utf8');
    }
    const result = isHtml ? rewriteHtml(text, target.href) : rewriteCss(text, target.href);
    out['content-type'] = (isHtml ? 'text/html' : 'text/css') + '; charset=utf-8';
    res.writeHead(r.status, out);
    return res.end(result);
  }

  const cl = r.headers.get('content-length');
  if (cl && !r.headers.get('content-encoding')) out['content-length'] = cl;
  res.writeHead(r.status, out);
  if (!r.body) return res.end();
  pipeline(Readable.fromWeb(r.body), res, () => {});
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const sid = getSid(req, res);
  const p = u.pathname;

  if (p === '/_px/app.js') return send(res, 200, 'application/javascript', APP_JS);
  if (p === '/_px/client.js') return send(res, 200, 'application/javascript', CLIENT_JS);
  if (p === '/_px/cookie' && req.method === 'POST') {
    const text = (await readBody(req)).toString('utf8');
    storeCookies(sid, u.searchParams.get('host') || '', [text]);
    res.writeHead(204);
    return res.end();
  }
  if (p === '/_px/clear' && req.method === 'POST') {
    jars.delete(sid);
    res.writeHead(204);
    return res.end();
  }
  if (p === '/proxy') return handleProxy(req, res, u, sid);

  // A proxied page navigated to a path we didn't rewrite (location.href = '/x', etc.)
  const ref = realFromReferer(req);
  if (ref) {
    try {
      res.writeHead(307, { location: '/proxy?url=' + encodeURIComponent(new URL(req.url, ref).href) });
      return res.end();
    } catch {}
  }

  if (p === '/' || p === '/index.html') return send(res, 200, 'text/html', INDEX_HTML);
  send(res, 404, 'text/plain', 'Not found');
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal error');
    });
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log('Codespace Browser running on port ' + PORT);
    console.log('Open the forwarded address from the Ports tab.');
  });

/* ================================================================== */
/* CLIENT SCRIPT — injected into every proxied page                    */
/* ================================================================== */
const CLIENT_JS = String.raw`(function () {
  if (window.__px) return;
  window.__px = true;
  var PREFIX = '/proxy?url=';
  var ORIGIN = location.origin;
  var BASE = window.__PX_BASE || location.href;
  var PAGE = window.__PX_URL || BASE;
  var SKIP = /^(javascript:|data:|blob:|about:|mailto:|tel:|#|\/proxy\?url=)/i;

  function realOf(u) {
    try {
      var x = new URL(u, location.href);
      if (x.origin === ORIGIN && x.pathname === '/proxy') return (x.searchParams.get('url') || u) + x.hash;
    } catch (e) {}
    return u;
  }
  function realAbs(u) {
    try { return new URL(realOf(u), BASE).href; } catch (e) { return u; }
  }
  function prox(u) {
    if (u == null) return u;
    var s = String(u).trim();
    if (!s || SKIP.test(s)) return u;
    if (s.indexOf(ORIGIN + PREFIX) === 0) return s;
    var a;
    try { a = new URL(s, BASE); } catch (e) { return u; }
    if (a.origin === ORIGIN) { try { a = new URL(a.pathname + a.search + a.hash, BASE); } catch (e) { return u; } }
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return u;
    var h = a.hash;
    a.hash = '';
    return PREFIX + encodeURIComponent(a.href) + h;
  }
  function proxSrcset(v) {
    return String(v).split(/,\s+/).map(function (c) {
      var p = c.trim().split(/\s+/);
      p[0] = prox(p[0]);
      return p.join(' ');
    }).join(', ');
  }
  function send(m) { try { parent.postMessage(m, ORIGIN); } catch (e) {} }

  /* attribute + property patches */
  var URL_ATTRS = { href: 1, src: 1, poster: 1, 'data-src': 1, action: 1, formaction: 1 };
  var _setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    var k = String(n).toLowerCase();
    if (URL_ATTRS[k]) v = prox(v);
    else if (k === 'srcset') v = proxSrcset(v);
    return _setAttr.call(this, n, v);
  };
  function patchProp(ctor, prop) {
    var proto = window[ctor] && window[ctor].prototype;
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      get: d.get,
      set: function (v) { d.set.call(this, prop === 'srcset' ? proxSrcset(v) : prox(v)); },
      configurable: true, enumerable: d.enumerable
    });
  }
  [['HTMLImageElement', 'src'], ['HTMLImageElement', 'srcset'], ['HTMLScriptElement', 'src'],
   ['HTMLIFrameElement', 'src'], ['HTMLMediaElement', 'src'], ['HTMLSourceElement', 'src'],
   ['HTMLSourceElement', 'srcset'], ['HTMLTrackElement', 'src'], ['HTMLEmbedElement', 'src'],
   ['HTMLInputElement', 'src'], ['HTMLLinkElement', 'href'], ['HTMLAnchorElement', 'href'],
   ['HTMLAreaElement', 'href'], ['HTMLFormElement', 'action']
  ].forEach(function (x) { patchProp(x[0], x[1]); });

  var ATTR_RE = /(\s(?:href|src|poster|data-src)\s*=\s*)(["'])(.*?)\2/gis;
  var SRCSET_RE = /(\s(?:srcset|data-srcset)\s*=\s*)(["'])(.*?)\2/gis;
  function rewriteStr(h) {
    return String(h)
      .replace(ATTR_RE, function (m, a, q, v) { return a + q + prox(v.replace(/&amp;/g, '&')) + q; })
      .replace(SRCSET_RE, function (m, a, q, v) { return a + q + proxSrcset(v.replace(/&amp;/g, '&')) + q; });
  }
  var iD = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  if (iD && iD.set) {
    Object.defineProperty(Element.prototype, 'innerHTML', {
      get: iD.get,
      set: function (v) { iD.set.call(this, typeof v === 'string' ? rewriteStr(v) : v); },
      configurable: true
    });
  }
  var _iah = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (p, h) { return _iah.call(this, p, rewriteStr(h)); };
  var _dw = document.write;
  document.write = function () { return _dw.apply(document, [].map.call(arguments, rewriteStr)); };

  /* network patches */
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === 'string' || input instanceof URL) input = prox(String(input));
      else if (input && input.url) {
        var p = prox(input.url);
        if (p !== input.url) input = new Request(p, input);
      }
    } catch (e) {}
    return _fetch.call(this, input, init);
  };
  var _xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    var a = [].slice.call(arguments);
    a[1] = prox(u);
    return _xo.apply(this, a);
  };
  if (navigator.sendBeacon) {
    var _sb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, d) { return _sb(prox(u), d); };
  }
  if (window.EventSource) {
    var _ES = window.EventSource;
    window.EventSource = function (u, o) { return new _ES(prox(u), o); };
    window.EventSource.prototype = _ES.prototype;
  }
  if (navigator.serviceWorker) {
    try { navigator.serviceWorker.register = function () { return Promise.reject(new Error('Service workers are disabled in this browser')); }; } catch (e) {}
  }

  /* window.open -> new tab */
  window.open = function (u) {
    var r = u ? realAbs(u) : '';
    if (/^https?:/i.test(r)) send({ type: 'open', url: r });
    return null;
  };

  /* cookies set by page scripts */
  var jsCookies = {};
  try {
    Object.defineProperty(document, 'cookie', {
      get: function () { return Object.keys(jsCookies).map(function (k) { return k + '=' + jsCookies[k]; }).join('; '); },
      set: function (v) {
        try {
          var first = String(v).split(';')[0];
          var i = first.indexOf('=');
          var n = first.slice(0, i).trim(), val = first.slice(i + 1);
          if (/max-age=0|expires=[^;]*19(69|70)/i.test(v)) delete jsCookies[n]; else jsCookies[n] = val;
          _fetch.call(window, '/_px/cookie?host=' + encodeURIComponent(new URL(PAGE).hostname), { method: 'POST', body: String(v) });
        } catch (e) {}
      },
      configurable: true
    });
  } catch (e) {}

  /* clicks: new-tab links and frame-busting targets */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    var a = e.target && e.target.closest && e.target.closest('a[href], area[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || /^(javascript:|#)/i.test(href)) return;
    var t = (a.getAttribute('target') || '').toLowerCase();
    var r = realAbs(href);
    if (!/^https?:/i.test(r)) return;
    if (t === '_blank' || e.ctrlKey || e.metaKey || e.shiftKey) { e.preventDefault(); send({ type: 'open', url: r }); }
    else if (t === '_top' || t === '_parent') { e.preventDefault(); location.href = prox(r); }
  }, false);

  /* forms */
  function formInfo(f, submitter) {
    var attr = (submitter && submitter.getAttribute && submitter.getAttribute('formaction')) || f.getAttribute('action') || '';
    var method = ((submitter && submitter.getAttribute && submitter.getAttribute('formmethod')) || f.getAttribute('method') || 'get').toLowerCase();
    var url;
    try { url = new URL(realOf(attr), BASE); } catch (e) { url = new URL(BASE); }
    return { url: url, method: method };
  }
  function submitGet(f, info, submitter) {
    var sp = new URLSearchParams();
    new FormData(f).forEach(function (v, k) { if (typeof v === 'string') sp.append(k, v); });
    if (submitter && submitter.name) sp.append(submitter.name, submitter.value || '');
    info.url.search = sp.toString();
    if (f.target === '_blank') send({ type: 'open', url: info.url.href });
    else location.href = prox(info.url.href);
  }
  document.addEventListener('submit', function (e) {
    if (e.defaultPrevented) return;
    var f = e.target;
    if (!f || f.tagName !== 'FORM') return;
    var info = formInfo(f, e.submitter);
    if (info.method === 'post') {
      _setAttr.call(f, 'action', prox(info.url.href));
      if (e.submitter && e.submitter.getAttribute('formaction')) _setAttr.call(e.submitter, 'formaction', prox(info.url.href));
    } else {
      e.preventDefault();
      submitGet(f, info, e.submitter);
    }
  }, false);
  var _sub = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    var info = formInfo(this, null);
    if (info.method === 'post') { _setAttr.call(this, 'action', prox(info.url.href)); return _sub.call(this); }
    submitGet(this, info, null);
  };

  /* history API: keep the real URL in sync */
  function icon() {
    var l = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"]');
    if (l && l.getAttribute('href')) return l.getAttribute('href');
    try { return prox(new URL('/favicon.ico', PAGE).href); } catch (e) { return ''; }
  }
  function notify() { send({ type: 'nav', url: PAGE, title: document.title || '', icon: icon() }); }
  ['pushState', 'replaceState'].forEach(function (k) {
    var o = history[k];
    history[k] = function (s, t, u) {
      if (u != null && u !== '') {
        try {
          var r = new URL(realOf(String(u)), BASE).href;
          BASE = r; PAGE = r;
          var res = o.call(this, s, t, prox(r));
          notify();
          return res;
        } catch (e) {}
      }
      return o.call(this, s, t, u);
    };
  });

  document.addEventListener('DOMContentLoaded', function () {
    notify();
    var t = document.querySelector('title');
    if (t) new MutationObserver(notify).observe(t, { childList: true, characterData: true, subtree: true });
  });
  window.addEventListener('load', notify);
  window.addEventListener('beforeunload', function () { send({ type: 'loading' }); });
  notify();
})();
`;

/* ================================================================== */
/* BROWSER UI SCRIPT                                                   */
/* ================================================================== */
const APP_JS = String.raw`(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };

  var ICONS = {
    back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    forward: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',
    reload: 'M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    star: 'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z',
    starOn: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
    warn: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
    search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    globe: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
    more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z'
  };
  function svg(name, size) {
    size = size || 18;
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true"><path fill="currentColor" d="' + ICONS[name] + '"/></svg>';
  }
  document.querySelectorAll('[data-icon]').forEach(function (el) { el.innerHTML = svg(el.getAttribute('data-icon'), +el.getAttribute('data-size') || 18); });

  function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } }
  function proxied(u) { return '/proxy?url=' + encodeURIComponent(u); }

  function normalize(v) {
    v = v.trim();
    if (!v) return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
    if (/^localhost(:\d+)?(\/|$)/i.test(v) || /^[^\s\/]+\.[^\s]{2,}$/.test(v) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(v)) return 'https://' + v;
    return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(v);
  }

  var tabs = [], activeId = null, nextId = 1;
  var bookmarks = load('px.bookmarks', []);
  var SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation';
  var TILES = [
    ['DuckDuckGo', 'https://duckduckgo.com/'], ['Wikipedia', 'https://en.wikipedia.org/'],
    ['YouTube', 'https://www.youtube.com/'], ['Reddit', 'https://old.reddit.com/'],
    ['GitHub', 'https://github.com/'], ['Hacker News', 'https://news.ycombinator.com/']
  ];

  function active() { return tabs.filter(function (t) { return t.id === activeId; })[0]; }

  function createTab(url, makeActive, lazy, meta) {
    var t = { id: nextId++, url: '', title: 'New Tab', icon: '', hist: [], idx: -1, expecting: false, loading: false, frame: null, timer: null, lazy: false };
    var f = document.createElement('iframe');
    f.className = 'frame';
    f.setAttribute('sandbox', SANDBOX);
    f.setAttribute('allow', 'autoplay; fullscreen; clipboard-write; encrypted-media; picture-in-picture');
    f.setAttribute('allowfullscreen', '');
    f.style.display = 'none';
    f.addEventListener('load', function () {
      if (!t.url) return;
      t.loading = false;
      clearTimeout(t.timer);
      render();
    });
    $('#viewport').appendChild(f);
    t.frame = f;
    tabs.push(t);
    if (url && lazy) {
      t.url = url; t.title = (meta && meta.title) || hostOf(url); t.icon = (meta && meta.icon) || '';
      t.hist = [url]; t.idx = 0; t.lazy = true;
    } else if (!url) {
      t.hist = ['']; t.idx = 0;
    }
    if (makeActive !== false) switchTo(t.id);
    if (url && !lazy) navigate(t, url, true);
    render(); persist();
    return t;
  }

  function startTimer(t) {
    clearTimeout(t.timer);
    t.timer = setTimeout(function () { t.loading = false; render(); }, 25000);
  }

  function navigate(t, url, push) {
    t.lazy = false;
    if (!url) {
      t.url = ''; t.title = 'New Tab'; t.icon = ''; t.loading = false;
      t.frame.src = 'about:blank';
      render(); persist();
      return;
    }
    if (push !== false) {
      t.hist = t.hist.slice(0, t.idx + 1);
      t.hist.push(url);
      t.idx = t.hist.length - 1;
    }
    t.url = url; t.expecting = true; t.loading = true; t.title = hostOf(url); t.icon = '';
    t.frame.src = proxied(url);
    startTimer(t); render(); persist();
  }

  function go(t, d) {
    var i = t.idx + d;
    if (i < 0 || i >= t.hist.length) return;
    t.idx = i;
    navigate(t, t.hist[i], false);
  }

  function switchTo(id) {
    activeId = id;
    var t = active();
    if (t && t.lazy) navigate(t, t.url, false);
    render(); persist();
  }

  function closeTab(id) {
    var i = tabs.map(function (t) { return t.id; }).indexOf(id);
    if (i < 0) return;
    var t = tabs[i];
    clearTimeout(t.timer);
    t.frame.remove();
    tabs.splice(i, 1);
    if (!tabs.length) { createTab('', true); return; }
    if (activeId === id) switchTo(tabs[Math.min(i, tabs.length - 1)].id);
    else { render(); persist(); }
  }

  function persist() {
    save('px.session', {
      active: tabs.map(function (t) { return t.id; }).indexOf(activeId),
      tabs: tabs.map(function (t) { return { url: t.url, title: t.title, icon: t.icon }; })
    });
  }

  /* messages from proxied pages */
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin) return;
    var m = e.data;
    if (!m || !m.type) return;
    var t = tabs.filter(function (x) { return x.frame.contentWindow === e.source; })[0];
    if (m.type === 'open') { if (/^https?:/i.test(m.url)) createTab(m.url, true); return; }
    if (!t) return;
    if (m.type === 'loading') { t.loading = true; startTimer(t); render(); return; }
    if (m.type === 'nav') {
      if (!m.url) return;
      if (t.expecting) { t.hist[t.idx] = m.url; t.expecting = false; }
      else if (m.url !== t.hist[t.idx]) {
        t.hist = t.hist.slice(0, t.idx + 1);
        t.hist.push(m.url);
        t.idx = t.hist.length - 1;
      }
      t.url = m.url;
      t.title = m.title || hostOf(m.url);
      if (m.icon) t.icon = m.icon;
      render(); persist();
    }
  });

  /* rendering */
  var omni = $('#url');
  function isBookmarked(u) { return bookmarks.some(function (b) { return b.url === u; }); }

  function pretty(u) {
    try { var x = new URL(u); return x.host.replace(/^www\./, '') + (x.pathname + x.search + x.hash).replace(/^\/$/, ''); } catch (e) { return u; }
  }

  function render() {
    var t = active();
    var strip = $('#tabs');
    strip.innerHTML = '';
    tabs.forEach(function (tb) {
      var el = document.createElement('div');
      el.className = 'tab' + (tb.id === activeId ? ' active' : '');
      el.title = tb.title;
      var lead = tb.loading ? '<span class="spinner"></span>' : (tb.icon ? '<img class="fav" alt="" src="' + esc(tb.icon) + '">' : '<span class="fav">' + svg('globe', 16) + '</span>');
      el.innerHTML = lead + '<span class="ttl">' + esc(tb.title) + '</span><button class="x" title="Close tab">' + svg('close', 14) + '</button>';
      var img = el.querySelector('img.fav');
      if (img) img.onerror = function () { var s = document.createElement('span'); s.className = 'fav'; s.innerHTML = svg('globe', 16); img.replaceWith(s); };
      el.addEventListener('mousedown', function (e) {
        if (e.button === 1) { e.preventDefault(); closeTab(tb.id); }
      });
      el.addEventListener('click', function (e) {
        if (e.target.closest('.x')) closeTab(tb.id); else switchTo(tb.id);
      });
      strip.appendChild(el);
    });

    tabs.forEach(function (tb) { tb.frame.style.display = (tb === t && tb.url) ? 'block' : 'none'; });
    $('#ntp').style.display = (t && !t.url) ? 'flex' : 'none';
    $('#back').disabled = !t || t.idx <= 0;
    $('#forward').disabled = !t || t.idx >= t.hist.length - 1;
    $('#reload').innerHTML = svg(t && t.loading ? 'close' : 'reload');
    $('#reload').title = t && t.loading ? 'Stop' : 'Reload';
    $('#progress').className = t && t.loading ? 'on' : '';

    if (t) {
      if (document.activeElement !== omni) omni.value = t.url ? pretty(t.url) : '';
      var secure = /^https:/i.test(t.url);
      $('#secure').innerHTML = t.url ? (secure ? svg('lock', 14) : svg('warn', 14)) : svg('search', 16);
      $('#secure').className = 'secure' + (t.url && !secure ? ' warn' : '');
      $('#star').innerHTML = svg(t.url && isBookmarked(t.url) ? 'starOn' : 'star', 18);
      $('#star').className = 'icon' + (t.url && isBookmarked(t.url) ? ' on' : '');
      $('#star').style.visibility = t.url ? 'visible' : 'hidden';
      document.title = (t.url ? t.title : 'New Tab');
    }

    var bar = $('#bookmarks');
    bar.innerHTML = '';
    bookmarks.forEach(function (b, i) {
      var el = document.createElement('button');
      el.className = 'bm';
      el.title = b.url + '\n(right-click to remove)';
      el.innerHTML = '<span class="bmdot">' + esc((b.title || hostOf(b.url)).charAt(0).toUpperCase()) + '</span><span>' + esc(b.title || hostOf(b.url)) + '</span>';
      el.addEventListener('click', function (e) {
        if (e.ctrlKey || e.metaKey || e.button === 1) createTab(b.url, true); else navigate(active(), b.url, true);
      });
      el.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        bookmarks.splice(i, 1); save('px.bookmarks', bookmarks); render();
      });
      bar.appendChild(el);
    });
  }

  /* toolbar */
  $('#back').addEventListener('click', function () { go(active(), -1); });
  $('#forward').addEventListener('click', function () { go(active(), 1); });
  $('#reload').addEventListener('click', function () {
    var t = active();
    if (!t || !t.url) return;
    if (t.loading) {
      try { t.frame.contentWindow.stop(); } catch (e) {}
      t.loading = false; render();
    } else navigate(t, t.url, false);
  });
  $('#home').addEventListener('click', function () { navigate(active(), '', true); });
  $('#newtab').addEventListener('click', function () { createTab('', true); omni.focus(); });
  $('#star').addEventListener('click', function () {
    var t = active();
    if (!t || !t.url) return;
    if (isBookmarked(t.url)) bookmarks = bookmarks.filter(function (b) { return b.url !== t.url; });
    else bookmarks.push({ url: t.url, title: t.title.slice(0, 24) });
    save('px.bookmarks', bookmarks); render();
  });

  omni.addEventListener('focus', function () {
    var t = active();
    omni.value = t && t.url ? t.url : '';
    setTimeout(function () { omni.select(); }, 0);
  });
  omni.addEventListener('blur', function () { render(); });
  omni.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var u = normalize(omni.value);
      if (u) { navigate(active(), u, true); omni.blur(); }
    } else if (e.key === 'Escape') omni.blur();
  });

  /* menu */
  var menu = $('#menu');
  $('#more').addEventListener('click', function (e) { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', function () { menu.classList.remove('open'); });
  menu.addEventListener('click', function (e) {
    var a = e.target.closest('[data-act]');
    if (!a) return;
    var act = a.getAttribute('data-act');
    if (act === 'new') createTab('', true);
    if (act === 'clear') fetch('/_px/clear', { method: 'POST' }).then(function () { alert('Cookies cleared.'); });
    if (act === 'forget') { localStorage.removeItem('px.bookmarks'); bookmarks = []; render(); }
  });

  /* new tab page */
  $('#ntp-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var u = normalize($('#ntp-q').value);
    if (u) navigate(active(), u, true);
  });
  var tilesEl = $('#tiles');
  TILES.forEach(function (x) {
    var b = document.createElement('button');
    b.className = 'tile';
    b.innerHTML = '<span class="tdot">' + esc(x[0].charAt(0)) + '</span><span>' + esc(x[0]) + '</span>';
    b.addEventListener('click', function () { navigate(active(), x[1], true); });
    tilesEl.appendChild(b);
  });

  /* shortcuts (work while the browser chrome has focus) */
  document.addEventListener('keydown', function (e) {
    if (!e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === 't') { e.preventDefault(); createTab('', true); omni.focus(); }
    else if (k === 'w') { e.preventDefault(); closeTab(activeId); }
    else if (k === 'l') { e.preventDefault(); omni.focus(); }
    else if (k === 'r') { e.preventDefault(); $('#reload').click(); }
  });

  /* boot: restore last session (tabs load lazily) */
  var s = load('px.session', null);
  if (s && s.tabs && s.tabs.length) {
    s.tabs.forEach(function (x, i) { createTab(x.url, false, !!x.url, x); });
    switchTo(tabs[Math.max(0, Math.min(s.active, tabs.length - 1))].id);
  } else createTab('', true);
  if (!active().url) omni.focus();
})();
`;

/* ================================================================== */
/* BROWSER UI PAGE                                                     */
/* ================================================================== */
const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>New Tab</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%231a73e8'/%3E%3Ccircle cx='12' cy='12' r='4' fill='white'/%3E%3C/svg%3E">
<style>
:root{
  --strip:#dee1e6; --tab:#fff; --tabhover:rgba(255,255,255,.55); --bar:#fff;
  --omni:#f1f3f4; --text:#202124; --sub:#5f6368; --line:#dadce0; --accent:#1a73e8;
  --hover:rgba(60,64,67,.1); --page:#fff; --warn:#c5221f;
}
@media (prefers-color-scheme:dark){
  :root{
    --strip:#202124; --tab:#35363a; --tabhover:rgba(255,255,255,.1); --bar:#35363a;
    --omni:#202124; --text:#e8eaed; --sub:#9aa0a6; --line:#4a4c50; --accent:#8ab4f8;
    --hover:rgba(232,234,237,.12); --page:#202124; --warn:#f28b82;
  }
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:var(--strip);color:var(--text);font:13px/1.3 "Segoe UI",system-ui,-apple-system,Roboto,sans-serif;overflow:hidden}
button{font:inherit;color:inherit;border:0;background:none;cursor:pointer}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}

#tabstrip{display:flex;align-items:flex-end;gap:4px;padding:8px 8px 0;height:42px;background:var(--strip);flex:none}
#tabs{display:flex;flex:0 1 auto;min-width:0;max-width:calc(100% - 44px)}
.tab{position:relative;display:flex;align-items:center;gap:8px;height:34px;width:220px;min-width:42px;flex:0 1 220px;padding:0 6px 0 12px;border-radius:9px 9px 0 0;color:var(--sub);cursor:default;user-select:none;font-size:12px}
.tab:not(.active):hover{background:var(--tabhover)}
.tab:not(.active):not(:hover)::after{content:"";position:absolute;right:0;top:9px;bottom:9px;width:1px;background:var(--line)}
.tab.active{background:var(--tab);color:var(--text)}
.tab.active::before,.tab.active::after{content:"";position:absolute;bottom:0;width:8px;height:8px;background:radial-gradient(circle at var(--cx) 0,transparent 8px,var(--tab) 8.5px)}
.tab.active::before{left:-8px;--cx:0}
.tab.active::after{right:-8px;--cx:100%}
.fav{width:16px;height:16px;flex:none;display:grid;place-items:center;object-fit:contain;color:var(--sub)}
.ttl{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 14px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 14px),transparent)}
.x{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;flex:none;color:var(--sub)}
.x:hover{background:var(--hover)}
.tab:not(.active) .x{opacity:0}
.tab:not(.active):hover .x{opacity:1}
@media (max-width:600px){.tab{flex-basis:120px}}
.spinner{width:14px;height:14px;margin:1px;flex:none;border-radius:50%;border:2px solid var(--line);border-top-color:var(--accent);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.icon{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;flex:none;color:var(--sub)}
.icon:hover:not(:disabled){background:var(--hover)}
.icon:disabled{opacity:.38;cursor:default}
#newtab{width:28px;height:28px;margin-bottom:3px}

#toolbar{display:flex;align-items:center;gap:2px;height:40px;padding:0 8px;background:var(--bar);flex:none}
#omni{display:flex;align-items:center;flex:1;min-width:0;height:32px;margin:0 6px;padding:0 4px 0 12px;border-radius:16px;background:var(--omni)}
#omni:focus-within{background:var(--bar);box-shadow:0 0 0 2px var(--accent)}
.secure{display:grid;place-items:center;width:22px;color:var(--sub);flex:none}
.secure.warn{color:var(--warn)}
#url{flex:1;min-width:0;height:100%;margin-left:6px;border:0;outline:0;background:none;color:var(--text);font:inherit;font-size:14px}
#url::placeholder{color:var(--sub)}
#star{width:28px;height:28px}
#star.on{color:var(--accent)}

#bookmarks{display:flex;align-items:center;gap:2px;height:30px;padding:0 8px;background:var(--bar);border-bottom:1px solid var(--line);overflow:hidden;flex:none}
#bookmarks:empty{display:none}
.bm{display:flex;align-items:center;gap:6px;max-width:160px;height:24px;padding:0 8px;border-radius:12px;font-size:12px;white-space:nowrap}
.bm span:last-child{overflow:hidden;text-overflow:ellipsis}
.bm:hover{background:var(--hover)}
.bmdot,.tdot{display:grid;place-items:center;flex:none;border-radius:50%;background:var(--accent);color:var(--bar);font-weight:600}
.bmdot{width:16px;height:16px;font-size:10px}
#toolbar+#progress{border-top:1px solid var(--line)}
#progress{height:2px;position:relative;overflow:hidden;flex:none;background:transparent}
#bookmarks:not(:empty)+#progress{border-top:0}
#progress.on::before{content:"";position:absolute;top:0;bottom:0;left:0;width:30%;background:var(--accent);animation:slide 1.1s ease-in-out infinite}
@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(340%)}}
@media (prefers-reduced-motion:reduce){#progress.on::before{animation:none;width:100%;opacity:.5}.spinner{animation-duration:2s}}

#viewport{position:relative;flex:1;min-height:0;background:var(--page)}
.frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}

#ntp{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:28px;padding:24px;background:var(--page)}
#ntp h1{margin:0;font-size:44px;font-weight:300;letter-spacing:-1px}
#ntp-form{display:flex;align-items:center;gap:10px;width:min(584px,100%);height:46px;padding:0 18px;border-radius:23px;border:1px solid var(--line);background:var(--page)}
#ntp-form:hover,#ntp-form:focus-within{box-shadow:0 1px 6px rgba(32,33,36,.28);border-color:transparent}
#ntp-form svg{color:var(--sub)}
#ntp-q{flex:1;min-width:0;border:0;outline:0;background:none;color:var(--text);font:inherit;font-size:16px}
#tiles{display:grid;grid-template-columns:repeat(3,112px);gap:12px 16px;justify-content:center}
@media (min-width:640px){#tiles{grid-template-columns:repeat(6,112px)}}
.tile{display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 4px;border-radius:12px;font-size:12px}
.tile:hover{background:var(--hover)}
.tdot{width:48px;height:48px;font-size:20px;background:var(--omni);color:var(--text)}

#menu{display:none;position:absolute;right:8px;top:84px;z-index:10;min-width:220px;padding:6px 0;border-radius:8px;background:var(--bar);border:1px solid var(--line);box-shadow:0 4px 16px rgba(0,0,0,.25)}
#menu.open{display:block}
#menu button{display:block;width:100%;padding:9px 16px;text-align:left;font-size:13px}
#menu button:hover{background:var(--hover)}
#menu hr{border:0;border-top:1px solid var(--line);margin:6px 0}
#menu small{display:block;padding:6px 16px 4px;color:var(--sub);font-size:11px;line-height:1.5}
</style>
</head>
<body>
<div id="tabstrip">
  <div id="tabs"></div>
  <button id="newtab" class="icon" title="New tab (Alt+T)" data-icon="plus"></button>
</div>
<div id="toolbar">
  <button id="back" class="icon" title="Back" data-icon="back"></button>
  <button id="forward" class="icon" title="Forward" data-icon="forward"></button>
  <button id="reload" class="icon" title="Reload (Alt+R)"></button>
  <button id="home" class="icon" title="New tab page" data-icon="home"></button>
  <div id="omni">
    <span id="secure" class="secure"></span>
    <input id="url" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="Search or type a URL" aria-label="Address bar">
    <button id="star" class="icon" title="Bookmark this page"></button>
  </div>
  <button id="more" class="icon" title="Menu" data-icon="more"></button>
</div>
<div id="bookmarks"></div>
<div id="progress"></div>
<div id="menu">
  <button data-act="new">New tab</button>
  <hr>
  <button data-act="clear">Clear cookies</button>
  <button data-act="forget">Remove all bookmarks</button>
  <hr>
  <small>Shortcuts: Alt+T new tab, Alt+W close tab, Alt+L address bar, Alt+R reload. Middle-click a tab to close it. Right-click a bookmark to remove it.</small>
</div>
<div id="viewport">
  <div id="ntp">
    <h1>Browse</h1>
    <form id="ntp-form" autocomplete="off">
      <span data-icon="search"></span>
      <input id="ntp-q" type="text" placeholder="Search the web or type a URL" aria-label="Search or enter address" spellcheck="false">
    </form>
    <div id="tiles"></div>
  </div>
</div>
<script src="/_px/app.js"></script>
</body>
</html>
`;
