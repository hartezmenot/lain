'use strict';

/**
 * THE STANDALONE MANAGEMENT PAGE (§76, 2026-09-30) — MODEL's essentials when the
 * Harness is not installed, or its window cannot open. A CLI-only LAIN still
 * lets a person add an account or an API key without ever typing a secret into
 * the terminal, its history or a conversation.
 *
 *   /model manage · /account add · /api add  →  fabric/dashlaunch.js
 *        ├ a Harness window (this LAIN's, or a running LAIN's)  →  MODEL
 *        └ no Harness                                          →  THIS PAGE
 *
 * A PAGE ON LOOPBACK, OPENED IN THE DEFAULT BROWSER, OWNED BY THIS CORE.
 *
 *   BOUND to 127.0.0.1 on a port the OS chooses. It ends when the page says
 *   Done, after 20 idle minutes, after two hours at most, or with LAIN.
 *
 *   THE DOOR. The browser is launched at /open/<nonce>: single-use, 60 seconds.
 *   It answers with a redirect to /#k=<session key>. The key lives in the
 *   fragment — never sent to a server, never in an access log, never in a
 *   Referer — and the page takes it out of the address bar and the history
 *   entry at once. The nonce on the launch command line is worthless after its
 *   first use.
 *
 *   EVERY CALL: POST + JSON; the key in a header, compared in constant time;
 *   Host must be this loopback address (DNS rebinding), and an Origin, when
 *   sent, must be this page's. A strict Content-Security-Policy (the page's own
 *   nonce'd script and style, nothing else), no-store, no-referrer, no framing.
 *
 *   A FIXED ALLOW-LIST of the Core routes MODEL itself uses for accounts and
 *   keys, answered by the SAME handlers — this is a second door to them, not a
 *   second implementation. Nothing it returns carries a secret: accounts are
 *   masked views, keys are only ever sent in, never read back.
 */

const http = require('http');
const crypto = require('crypto');

const ROUTES_ALLOWED = Object.freeze([
  '/api/intel/families', '/api/intel/alias', '/api/intel/refresh', '/api/intel/detach',
  '/api/intel/auth/start', '/api/intel/auth/status', '/api/intel/auth/cancel',
  '/api/accounts/choices', '/api/accounts/addkey', '/api/accounts/test', '/api/accounts/remove',
]);
const NONCE_MS = 60 * 1000;
const IDLE_MS = 20 * 60 * 1000;
const MAX_MS = 2 * 60 * 60 * 1000;
const BODY_MAX = 64 * 1024;

let current = null;   // { server, port, key, nonces: Map, started, last, timer, section }

function same(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function headers(res, extra = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}
function json(res, code, body) {
  headers(res, { 'Content-Type': 'application/json; charset=utf-8' });
  res.writeHead(code);
  res.end(JSON.stringify(body));
}

/** Was this request meant for THIS page? Host, Origin and the key. */
function allowed(req, st) {
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${st.port}`) return 'wrong host';
  const origin = req.headers.origin;
  if (origin != null && origin !== `http://127.0.0.1:${st.port}`) return 'wrong origin';
  if (!same(req.headers['x-lain-key'], st.key)) return 'not this page';
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on('data', (c) => { n += c.length; if (n > BODY_MAX) { reject(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { reject(new Error('not JSON')); } });
    req.on('error', reject);
  });
}

async function handle(app, req, res, st) {
  st.last = Date.now();
  const url = new URL(req.url, `http://127.0.0.1:${st.port}`);
  // THE DOOR: a single-use nonce buys the session key, delivered in a fragment.
  const door = /^\/open\/([a-f0-9]{32})$/.exec(url.pathname);
  if (req.method === 'GET' && door) {
    const at = st.nonces.get(door[1]);
    st.nonces.delete(door[1]);
    if (!at || Date.now() - at > NONCE_MS || String(req.headers.host || '') !== `127.0.0.1:${st.port}`) {
      headers(res, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.writeHead(410); res.end('This link was already used or has expired. Run the command in LAIN again.');
      return;
    }
    headers(res, { Location: `/#k=${st.key}&s=${encodeURIComponent(st.section || 'accts')}` });
    res.writeHead(303); res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/') {
    if (String(req.headers.host || '') !== `127.0.0.1:${st.port}`) { res.writeHead(421); res.end(); return; }
    const nonce = crypto.randomBytes(16).toString('base64');
    headers(res, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.writeHead(200);
    res.end(page(nonce));
    return;
  }
  if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) { json(res, 404, { ok: false, why: 'not here' }); return; }
  const refused = allowed(req, st);
  if (refused) { json(res, 403, { ok: false, why: refused }); return; }
  if (url.pathname === '/api/_close') { json(res, 200, { ok: true }); setImmediate(stop); return; }
  if (!ROUTES_ALLOWED.includes(url.pathname)) { json(res, 404, { ok: false, why: 'not available on this page' }); return; }
  let body;
  try { body = await readBody(req); } catch (e) { json(res, 400, { ok: false, why: e.message }); return; }
  const fn = require('../harnessapp/routes').ROUTES[`POST ${url.pathname}`];
  if (!fn) { json(res, 404, { ok: false, why: 'not available' }); return; }
  try {
    const r = await fn(app, body || {});
    json(res, r && r.code ? r.code : 200, (r && r.body) || { ok: false });
  } catch (e) {
    json(res, 500, { ok: false, why: require('../redact').text(String(e && e.message || e)).slice(0, 300) });
  }
}

/** Start (or reuse) the page; returns the one-time launch URL. The browser is opened by `open`. */
function start(app, { section = 'accts' } = {}) {
  if (current) {
    current.section = section;
    return Promise.resolve(launchUrl(current));
  }
  return new Promise((resolve) => {
    const st = { server: null, port: 0, key: crypto.randomBytes(32).toString('hex'), nonces: new Map(), started: Date.now(), last: Date.now(), timer: null, section };
    const server = http.createServer((req, res) => { handle(app, req, res, st).catch(() => { try { json(res, 500, { ok: false, why: 'failed' }); } catch { /* gone */ } }); });
    server.on('error', (e) => resolve({ ok: false, why: `the account page could not start: ${e.message}` }));
    server.listen(0, '127.0.0.1', () => {
      st.server = server;
      st.port = server.address().port;
      st.timer = setInterval(() => { const now = Date.now(); if (now - st.last > IDLE_MS || now - st.started > MAX_MS) stop(); }, 30000);
      if (st.timer.unref) st.timer.unref();
      // THE SERVER IS KEPT REFERENCED: a one-shot `lain` invocation stays until the page says Done or goes idle.
      current = st;
      resolve(launchUrl(st));
    });
  });
}
function launchUrl(st) {
  const n = crypto.randomBytes(16).toString('hex');
  st.nonces.set(n, Date.now());
  return { ok: true, url: `http://127.0.0.1:${st.port}/open/${n}`, base: `http://127.0.0.1:${st.port}/`, port: st.port };
}
function stop() {
  const st = current;
  current = null;
  if (!st) return;
  clearInterval(st.timer);
  try { st.server.close(); } catch { /* closed */ }
  try { st.server.closeAllConnections(); } catch { /* older node */ }
}
function status() { return current ? { running: true, port: current.port, section: current.section, since: current.started } : { running: false }; }

/** Start it and open the one-time link in the default browser. The link carries a nonce, never the key. */
async function open(app, { section = 'accts' } = {}) {
  const r = await start(app, { section });
  if (!r.ok) return r;
  if (process.env.LAIN_STANDALONE_NO_BROWSER === '1') return { ...r, opened: false };
  const { spawn } = require('child_process');
  try {
    const cmd = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', r.url]] : process.platform === 'darwin' ? ['open', [r.url]] : ['xdg-open', [r.url]];
    const ch = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true });
    ch.on('error', () => { /* reported below as not opened */ });
    ch.unref();
    return { ...r, opened: true };
  } catch (e) { return { ...r, opened: false, why: e.message }; }
}

// ------------------------------------------------------------------ the page --

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- a self-contained browser page */
function client() {
  var KEY = '';
  var SECTION = 'accts';
  (function () {
    var h = String(location.hash || '').replace(/^#/, '');
    h.split('&').forEach(function (p) { var kv = p.split('='); if (kv[0] === 'k') KEY = kv[1] || ''; if (kv[0] === 's') SECTION = decodeURIComponent(kv[1] || 'accts'); });
    // THE KEY LEAVES THE ADDRESS BAR AND THE HISTORY ENTRY AT ONCE.
    try { history.replaceState(null, '', '/'); } catch (e) { /* older browser */ }
  })();
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lain-key': KEY }, body: JSON.stringify(body || {}), credentials: 'omit', cache: 'no-store' })
      .then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, why: String(e && e.message || e) }; });
  }
  function say(text, bad) { var n = $('note'); n.textContent = text || ''; n.className = 'note' + (bad ? ' bad' : ''); }
  var fams = [];
  var choices = [];
  function load() {
    return api('/api/intel/families').then(function (r) {
      if (!r || !r.ok) { say((r && r.why) || 'LAIN did not answer — run the command again.', true); return; }
      fams = r.families || []; draw();
    });
  }
  function draw() {
    var acc = $('accts'); acc.textContent = '';
    var subs = fams.filter(function (f) { return (f.kind === 'oauth' || f.kind === 'runtime') && f.accounts.length; });
    if (!subs.length) acc.appendChild(el('p', 'muted', 'No accounts yet.'));
    subs.forEach(function (f) {
      var card = el('div', 'card');
      card.appendChild(el('h3', '', f.label + ' · ' + f.accounts.length + ' account' + (f.accounts.length === 1 ? '' : 's')));
      f.accounts.forEach(function (a) {
        var row = el('div', 'row');
        var t = el('div', 'grow'); t.appendChild(el('b', '', a.name)); t.appendChild(el('small', '', [a.identity && a.identity.email, a.identity && a.identity.plan, a.stateLabel || a.state].filter(Boolean).join(' · '))); row.appendChild(t);
        var q = (a.quota || []).filter(function (w) { return w.remainingPercent != null; }).map(function (w) { return w.label + ' ' + Math.round(w.remainingPercent) + '% left'; }).join(' · ');
        row.appendChild(el('span', 'muted', q || a.quotaNote || ''));
        var rn = el('button', 'ghost', 'Rename'); rn.onclick = function () { var n = prompt('Name for this account', a.alias || a.name); if (n == null) return; api('/api/intel/alias', { id: a.id, name: n }).then(load); }; row.appendChild(rn);
        var dt = el('button', 'ghost danger', 'Detach'); dt.onclick = function () { if (!confirm('Detach ' + a.name + ' from LAIN? Nothing is signed out, and no other account changes.')) return; api('/api/intel/detach', { id: a.id, mode: 'detach' }).then(function (r) { say(r && r.ok ? 'Detached.' : (r && r.why) || 'not detached', !(r && r.ok)); load(); }); }; row.appendChild(dt);
        card.appendChild(row);
      });
      acc.appendChild(card);
    });
    var apis = $('apis'); apis.textContent = '';
    var keys = fams.filter(function (f) { return f.kind === 'api'; });
    if (!keys.length) apis.appendChild(el('p', 'muted', 'No API keys yet.'));
    keys.forEach(function (f) {
      var a = f.accounts[0] || {};
      var row = el('div', 'row card');
      var t = el('div', 'grow'); t.appendChild(el('b', '', f.label)); t.appendChild(el('small', '', [a.usable === false ? (a.stateLabel || 'Not ready') : 'Ready', (f.modelCount || 0) + ' models', f.endpoint ? String(f.endpoint).replace(/^https?:\/\//, '') : ''].filter(Boolean).join(' · '))); row.appendChild(t);
      apis.appendChild(row);
    });
  }
  // ---- ADD AN ACCOUNT: the provider's own sign-in, in this browser ---------------------------------------------
  var polling = null;
  function signIn(family, label) {
    var name = prompt('A name for the new ' + label + ' account (optional)', '') ;
    if (name == null) return;
    say('Starting ' + label + ' sign-in…');
    api('/api/intel/auth/start', { family: family, name: name }).then(function (r) {
      if (!r || !r.ok) { say((r && r.why) || 'the sign-in did not start', true); return; }
      track(r.session);
    });
  }
  function track(s) {
    clearTimeout(polling);
    var box = $('auth'); box.textContent = ''; box.hidden = false;
    if (!s) { box.hidden = true; return; }
    box.appendChild(el('b', '', 'Signing in: ' + s.family + ' — ' + String(s.state || '').toLowerCase().replace(/_/g, ' ')));
    if (s.userCode) box.appendChild(el('div', 'code', s.userCode));
    if (s.url && /^https:\/\//.test(s.url)) { var a = el('a', 'btn', 'Open the sign-in page'); a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; box.appendChild(a); }
    if (s.why) box.appendChild(el('p', 'bad', s.why));
    if (s.note) box.appendChild(el('p', 'muted', s.note));
    if (s.active) {
      var c = el('button', 'ghost', 'Cancel'); c.onclick = function () { api('/api/intel/auth/cancel', { id: s.id }).then(function () { track(null); load(); }); }; box.appendChild(c);
      polling = setTimeout(function () { api('/api/intel/auth/status', { id: s.id }).then(function (r) { track(r && r.session); if (r && r.session && !r.session.active) load(); }); }, 1500);
    } else if (s.state === 'CONNECTED') { say('Account connected.'); load(); }
  }
  // ---- ADD AN API KEY: typed here, sent once, never read back --------------------------------------------------
  function keyForm() {
    var sel = $('prov'); sel.textContent = '';
    choices.forEach(function (p) { var o = document.createElement('option'); o.value = p.id; o.textContent = p.label + (p.host ? ' — ' + p.host : ''); sel.appendChild(o); });
    var sync = function () { var p = choices.filter(function (x) { return x.id === sel.value; })[0]; $('baseRow').hidden = !(p && p.needsBaseUrl); };
    sel.onchange = sync; sync();
    $('addKey').onclick = function () {
      var key = $('key');
      if (!key.value.trim()) { say('Paste the API key.', true); return; }
      say('Checking the key with the provider…');
      var body = { provider: sel.value, key: key.value, baseUrl: $('base').value || '' };
      key.value = '';
      api('/api/accounts/addkey', body).then(function (r) { body.key = ''; say(r && r.ok ? 'Key added — kept in the Windows secret store.' : (r && r.why) || 'the key was not added', !(r && r.ok)); load(); });
    };
  }
  document.addEventListener('DOMContentLoaded', function () {
    if (!KEY) { say('Open this page from LAIN (/account add, /api add or /model manage).', true); return; }
    [['codex', 'Codex'], ['claude', 'Claude'], ['antigravity', 'Antigravity']].forEach(function (x) { var b = el('button', '', 'Add ' + x[1] + ' account'); b.onclick = function () { signIn(x[0], x[1]); }; $('adders').appendChild(b); });
    $('done').onclick = function () { api('/api/_close').then(function () { document.body.textContent = ''; document.body.appendChild(el('p', 'bye', 'Done — you can close this tab. LAIN has closed this page.')); }); };
    api('/api/accounts/choices').then(function (r) { choices = (r && r.providers) || []; keyForm(); });
    load().then(function () { var t = $(SECTION === 'api' ? 'apiSec' : 'acctSec'); if (t) t.scrollIntoView(); });
  });
}

function page(nonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>LAIN accounts</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#0E131A;--card:#141B24;--line:#243040;--text:#E6EAF0;--muted:#8A96A8;--acc:#9B8AFB;--bad:#F87171}
@media (prefers-color-scheme: light){:root{--bg:#EEF1F5;--card:#FFFFFF;--line:#D6DCE4;--text:#1A2230;--muted:#5B6678;--acc:#6D5AE6;--bad:#C0392B}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 "Segoe UI",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px 60px}h1{font-size:22px;margin:0 0 4px}h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:28px 0 10px}h3{font-size:15px;margin:0 0 8px}
p{margin:0 0 10px}.muted{color:var(--muted)}.bad{color:var(--bad)}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 10px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 0}.grow{flex:1;min-width:180px}.row small{display:block;color:var(--muted)}
button,.btn{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:8px;padding:7px 12px;cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.btn:hover{border-color:var(--acc)}.ghost{background:transparent}.danger{color:var(--bad)}#adders{display:flex;gap:8px;flex-wrap:wrap}
label{display:block;margin:0 0 10px}label span{display:block;font-size:12.5px;color:var(--muted);margin-bottom:4px}input,select{width:100%;font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text)}
.note{min-height:22px;margin:12px 0;color:var(--muted)}.note.bad{color:var(--bad)}.code{font:600 26px/1.3 Consolas,monospace;letter-spacing:.15em;margin:8px 0}
#auth{margin:12px 0}header{display:flex;align-items:flex-start;gap:12px}header div{flex:1}.bye{padding:40px;text-align:center}
</style></head><body><main>
<header><div><h1>LAIN — accounts and API keys</h1><p class="muted">Served by LAIN on this computer only (127.0.0.1). Keys go straight to the Windows secret store and are never shown again. The full dashboard is in the LAIN Harness.</p></div><button id="done">Done</button></header>
<div id="note" class="note"></div>
<section id="acctSec"><h2>Accounts</h2><div id="adders"></div><div id="auth" class="card" hidden></div><div id="accts"><p class="muted">Reading…</p></div></section>
<section id="apiSec"><h2>API keys</h2><div class="card"><label><span>Provider</span><select id="prov"></select></label><label id="baseRow" hidden><span>Endpoint (base URL)</span><input id="base" autocomplete="off" spellcheck="false" placeholder="https://…/v1"></label><label><span>API key</span><input id="key" type="password" autocomplete="off" spellcheck="false"></label><button id="addKey">Add key</button></div><div id="apis"></div></section>
</main><script nonce="${nonce}">(${client.toString()})();</script></body></html>`;
}

module.exports = { start, open, stop, status, ROUTES_ALLOWED, page };
