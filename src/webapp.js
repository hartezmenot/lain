'use strict';

/**
 * THE TELEGRAM WEBAPP — LIVE PROGRESS, NOT ANOTHER HARNESS (§42–46).
 *
 * A read-only view a phone opens from the Bot: PC status, CLI and Harness
 * sessions, background jobs, the current step, elapsed, recent changes,
 * verification, and what needs the person. It exposes NO control: approvals
 * and actions go through the Bot and the Core decision record (decisions.js),
 * never through this endpoint.
 *
 * SECURITY, in order:
 *   1. `POST /auth` accepts only Telegram WebApp `initData`, verified with
 *      HMAC-SHA256 under key HMAC-SHA256("WebAppData", bot token), fresh
 *      (auth_date within 24h), from a user the Bot already allows.
 *   2. It returns a short-lived bearer token HMAC-signed by a per-install key.
 *   3. `GET /progress` requires that token. There is no unauthenticated route
 *      except the bootstrap page, which contains no data.
 *   4. ENDPOINT SELECTION IS AUTHENTICATED. The page used to accept any server
 *      whose /ping said `{lain:true}` and then POSTed the signed initData to it —
 *      so a stale LAN/VPN address now held by another device could collect
 *      initData and replay it here within 24h. Now the button URL carries a
 *      per-install ping key (`k`), /ping answers a fresh nonce with
 *      HMAC(k, nonce), and the page verifies it (WebCrypto) before initData
 *      goes anywhere. No verification, no endpoint.
 *
 * ROUTING is connectivity.js: the bootstrap page probes the LAN, Tailscale and
 * ZeroTier endpoints in parallel with short timeouts and keeps the one that
 * answered by preference, showing `CONNECTED · LAN` or `CONNECTED · Tailscale`.
 * Telegram requires WebApps to be served over HTTPS; on a phone that means the
 * page is reached through Tailscale's HTTPS (`tailscale serve`) or a reverse
 * proxy — plain-http LAN access works from a browser on the same network.
 */

const crypto = require('crypto');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TOKEN_MS = 15 * 60 * 1000;
const INIT_MAX_AGE_S = 24 * 60 * 60;

function installKey(home) {
  const f = path.join(home, 'webapp.key');
  try { return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex'); } catch { /* first use */ }
  const k = crypto.randomBytes(32);
  fs.mkdirSync(home, { recursive: true });
  try { fs.writeFileSync(f, k.toString('hex'), { flag: 'wx', mode: 0o600 }); return k; } catch { return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex'); }
}

/** Telegram's documented WebApp initData check. Returns the user id, or null. */
function verifyInitData(initData, botToken, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(String(initData));
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(String(botToken)).digest();
  const want = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(hash))) return null;
  const age = now - Number(params.get('auth_date') || 0);
  if (!(age >= 0 && age <= INIT_MAX_AGE_S)) return null;
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
  return user && user.id != null ? String(user.id) : null;
}

function mintToken(key, userId, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ u: String(userId), exp: now + TOKEN_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function checkToken(key, token, now = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', key).update(body).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  let p = null;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  return p && p.exp > now ? p.u : null;
}

/** What the phone sees. Read from durable state only; nothing here can act. */
function progressView({ now = Date.now(), jobs = null } = {}) {
  const sessions = require('./sessionindex').summaries({ limit: 8, scope: 'all', now }).filter((s) => !s.unreadable);
  const needs = require('./decisions').pending().map((d) => ({ type: d.type, title: d.title, project: d.project, since: d.createdAt }));
  return {
    pc: { host: os.hostname(), platform: os.platform(), uptimeS: Math.round(os.uptime()), load: os.loadavg()[0], freeMemMb: Math.round(os.freemem() / 1048576) },
    sessions: sessions.map((s) => ({
      id: s.shortId, project: s.project, surface: s.cowork ? 'harness' : 'cli', state: s.state, objective: s.objective ? s.objective.slice(0, 160) : null,
      step: s.planTotal ? `${s.planDone}/${s.planTotal}` : null, changed: s.filesChanged, lastCommand: s.lastCommand ? { command: String(s.lastCommand.command || '').slice(0, 120), ok: s.lastCommand.ok } : null,
      lastActivity: s.lastActivity, when: s.when,
    })),
    jobs: Array.isArray(jobs) ? jobs : [],
    needsInput: needs,
    at: now,
  };
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LAIN progress</title>
<style>body{font:15px system-ui,sans-serif;margin:16px;background:#0e0f12;color:#e8e8ea}h1{font-size:16px}.m{color:#8a8f98}.row{padding:8px 0;border-bottom:1px solid #22252b}</style>
<h1>LAIN <span class=m id=route>connecting…</span></h1><div id=out class=m>…</div>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script>
const eps=JSON.parse(atob(new URLSearchParams(location.search).get('e')||'W10='));
const last=localStorage.getItem('lain.last');
const K=new URLSearchParams(location.search).get('k')||'';
const hex=b=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
async function proven(n,p){if(!K||!p||!(window.crypto&&crypto.subtle))return false;const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(K),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(n)))===p}
async function probe(u,s){const n=hex(crypto.getRandomValues(new Uint8Array(16)));const r=await fetch(u+'/ping?n='+n,{signal:s});if(!r.ok)return false;const j=await r.json();return j.lain===true&&await proven(n,j.proof)}
async function pick(){const ctl=new AbortController();setTimeout(()=>ctl.abort(),900);
 const all=[...new Set([last,...eps.map(e=>e.url)].filter(Boolean))];
 const ok=new Set((await Promise.all(all.map(u=>probe(u,ctl.signal).then(v=>v&&u).catch(()=>null)))).filter(Boolean));
 const byRoute=r=>eps.filter(e=>e.route===r).map(e=>e.url).find(u=>ok.has(u));
 return byRoute('LAN')||(last&&ok.has(last)?last:null)||byRoute('Tailscale')||byRoute('ZeroTier')||null}
(async()=>{const base=await pick();if(!base){document.getElementById('route').textContent='OFFLINE · Bot chat only';return}
 localStorage.setItem('lain.last',base);const e=eps.find(x=>x.url===base);document.getElementById('route').textContent='CONNECTED · '+(e?e.route:'LAN');
 const a=await fetch(base+'/auth',{method:'POST',body:(window.Telegram&&Telegram.WebApp.initData)||''});if(!a.ok){document.getElementById('out').textContent='not authorized';return}
 const {token}=await a.json();const tick=async()=>{const p=await (await fetch(base+'/progress',{headers:{authorization:'Bearer '+token}})).json();
 const h=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 document.getElementById('out').innerHTML=p.sessions.map(s=>'<div class=row><b>'+h(s.project)+'</b> <span class=m>'+h(s.state)+' '+h(s.step)+' · '+h(s.when)+'</span><br>'+h(s.objective)+'</div>').join('')+
 (p.needsInput.length?'<p><b>Needs you:</b> '+p.needsInput.map(n=>h(n.title)).join(', ')+'</p>':'')};tick();setInterval(tick,4000)})();
</script>`;

/**
 * Start the progress server. `allowUsers` are the Bot's own allowed Telegram
 * ids; `botToken` verifies initData. Returns { server, port, endpoints, close }.
 */
function start({ port = 0, host = '0.0.0.0', botToken = '', allowUsers = [], home = require('./config').configDir(), jobs = () => [] } = {}) {
  const key = installKey(home);
  const pingKey = pingKeyOf(key);
  const allowed = new Set((allowUsers || []).map(String));
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization', 'x-content-type-options': 'nosniff' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return send(204, '');
    if (req.method === 'GET' && url.pathname === '/ping') {
      const n = url.searchParams.get('n') || '';
      return send(200, { lain: true, ...(/^[0-9a-f]{16,128}$/.test(n) ? { proof: crypto.createHmac('sha256', pingKey).update(n).digest('hex') } : {}) });
    }
    if (req.method === 'GET' && url.pathname === '/') return send(200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'POST' && url.pathname === '/auth') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 8192) return send(413, { error: 'too large' }); }
      const user = verifyInitData(body, botToken);
      if (!user || !allowed.has(user)) return send(401, { error: 'not authorized' });
      return send(200, { token: mintToken(key, user) });
    }
    if (req.method === 'GET' && url.pathname === '/progress') {
      const user = checkToken(key, String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (!user || !allowed.has(user)) return send(401, { error: 'not authorized' });
      return send(200, progressView({ jobs: typeof jobs === 'function' ? jobs() : [] }));
    }
    return send(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const p = server.address().port;
      const eps = require('./connectivity').endpoints({ port: p });
      resolve({ server, port: p, endpoints: eps, pingKey, launch: (pageBase) => launchUrl(pageBase, eps, pingKey), close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** The WebApp URL the Bot puts on its button: the page plus every candidate endpoint. */
function launchUrl(pageBase, eps, pingKey = '') {
  const list = [
    ...eps.lan.map((url) => ({ route: 'LAN', url })),
    ...eps.tailscale.map((url) => ({ route: 'Tailscale', url })),
    ...eps.zerotier.map((url) => ({ route: 'ZeroTier', url })),
  ];
  return `${pageBase}?e=${Buffer.from(JSON.stringify(list)).toString('base64')}${pingKey ? `&k=${pingKey}` : ''}`;
}

/** The key a genuine LAIN proves itself with at /ping — derived, never the install key itself. */
function pingKeyOf(installKeyBytes) { return crypto.createHmac('sha256', installKeyBytes).update('webapp-ping').digest('hex'); }

module.exports = { start, progressView, verifyInitData, mintToken, checkToken, launchUrl, pingKeyOf, PAGE, TOKEN_MS };
