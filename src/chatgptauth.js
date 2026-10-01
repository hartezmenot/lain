'use strict';

/**
 * SIGN IN WITH CHATGPT — an IDENTITY, and only when LAIN may legitimately ask.
 *
 * ------------------------------------------------------------------------
 * WHAT IT IS (OpenAI, checked 2026-09-25). "Sign in with ChatGPT" is an
 * identity-provider sign-in: the app learns the person's name, email and
 * picture. It does NOT expose ChatGPT conversations, memory, files, usage,
 * billing, model inference or API access, and nothing here claims otherwise —
 * a connected identity is shown as "ChatGPT identity", never as model access.
 * It is offered to partner apps OpenAI has admitted; there is no public client
 * registration and no published developer terms. The only public client id in
 * circulation belongs to Codex, and borrowing another application's client is
 * forbidden — that id is refused by name below.
 *
 * SO BY DEFAULT THIS IS NOT AVAILABLE, and says why. When a LAIN-registered
 * client exists, `auth.chatgpt.clientId` in LAIN's config turns it on, and the
 * flow is the standard one:
 *
 *   discovery   <issuer>/.well-known/openid-configuration (HTTPS; loopback only
 *               for a local test issuer)
 *   authorize   the DEFAULT browser (the window's openExternal), official page,
 *               response_type=code, scope openid profile email,
 *               PKCE S256, `state` and `nonce` — both single-use, 10 minutes
 *   callback    http://127.0.0.1:<ephemeral>/callback (RFC 8252 loopback),
 *               state compared in constant time, then the listener closes
 *   exchange    code + verifier at the token endpoint
 *   id token    signature checked against the issuer's JWKS (RS256/ES256),
 *               iss, aud, exp and nonce checked
 *   kept        identity (name, email) and the refresh token, in the OS secret
 *               store (secretstore.js, DPAPI) — never in config.json, never in
 *               /api/state, never in a log
 *   removed     only with a fresh, single-use intent (as API keys, Phase 2)
 */

const crypto = require('crypto');
const http = require('http');

/** The Codex CLI's public client id. Not LAIN's, and never used by LAIN. */
const BORROWED = new Set(['app_EMoamEEZ73f0CkXaXp7hrann']);
const SECRET = 'chatgpt-oauth';
const DEFAULT_ISSUER = 'https://auth.openai.com';
const INTENT_MS = 10 * 60_000;
const SCOPE = 'openid profile email';

const STATE = Object.freeze({
  NOT_AVAILABLE: 'NOT_AVAILABLE',     // no LAIN-registered client
  NOT_CONNECTED: 'NOT_CONNECTED',
  WAITING: 'WAITING',                 // the browser is open on OpenAI's page
  CONNECTED: 'CONNECTED',
  FAILED: 'FAILED',
});

let pending = null;      // { state, nonce, verifier, redirect, server, at, disc, clientId }
let lastError = '';
let removeIntent = null; // { token, at }

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function rand(n = 32) { return b64url(crypto.randomBytes(n)); }
function eq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function loopback(u) { return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'; }
function allowedUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && loopback(u)) return u;
  return null;
}

function client(app) {
  const cfg = (app && (app._sibling || app).cfg) || {};
  const c = cfg.auth && cfg.auth.chatgpt ? cfg.auth.chatgpt : {};
  const clientId = typeof c.clientId === 'string' ? c.clientId.trim() : '';
  const issuer = typeof c.issuer === 'string' && c.issuer ? c.issuer.replace(/\/+$/, '') : DEFAULT_ISSUER;
  if (!clientId) return { ok: false, why: 'OpenAI offers "Sign in with ChatGPT" to partner apps it has admitted, and Noema has no OpenAI-registered client. Nothing is borrowed from another app, so this stays off until one exists.' };
  if (BORROWED.has(clientId)) return { ok: false, why: 'that client id belongs to OpenAI Codex; Noema never signs in as another application' };
  if (!allowedUrl(issuer)) return { ok: false, why: 'the issuer must be an HTTPS address' };
  return { ok: true, clientId, issuer };
}

function identity() {
  const raw = require('./secretstore').get(SECRET);
  if (!raw) return null;
  try { const d = JSON.parse(raw); return d && d.identity ? d.identity : null; } catch { return null; }
}

/** What the window may know. No token, no code, no verifier — ever. */
function status(app) {
  const c = client(app);
  const store = require('./secretstore').available();
  if (!c.ok) return { state: STATE.NOT_AVAILABLE, why: c.why, scope: 'identity', grants: [] };
  if (!store.ok) return { state: STATE.NOT_AVAILABLE, why: store.why, scope: 'identity', grants: [] };
  if (pending && Date.now() - pending.at < INTENT_MS) return { state: STATE.WAITING, why: 'finish signing in in your browser', scope: 'identity', grants: [] };
  const id = require('./secretstore').has(SECRET) ? identity() : null;
  if (id) {
    return { state: STATE.CONNECTED, why: '', scope: 'identity', identity: { name: id.name || null, email: id.email || null, at: id.at || null }, grants: ['name', 'email'] };
  }
  return { state: lastError ? STATE.FAILED : STATE.NOT_CONNECTED, why: lastError, scope: 'identity', grants: [] };
}

async function getJson(url, opts = {}) {
  const u = allowedUrl(url);
  if (!u) throw new Error(`refusing ${url}: not HTTPS`);
  const r = await fetch(u.toString(), { ...opts, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!r.ok) throw new Error(`${u.host} answered ${r.status}${body && body.error ? ` (${body.error})` : ''}`);
  if (!body) throw new Error(`${u.host} did not answer JSON`);
  return body;
}

async function discover(issuer) {
  const d = await getJson(`${issuer}/.well-known/openid-configuration`);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!allowedUrl(d[k])) throw new Error(`the issuer's ${k} is not an HTTPS address`);
  }
  if (d.issuer && d.issuer.replace(/\/+$/, '') !== issuer) throw new Error('the discovery document names a different issuer');
  if (Array.isArray(d.code_challenge_methods_supported) && !d.code_challenge_methods_supported.includes('S256')) throw new Error('the issuer does not support PKCE S256');
  return d;
}

function decodePart(p) { return JSON.parse(Buffer.from(String(p).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }

/** Check an ID token's signature and claims. Throws with the reason. */
async function verifyIdToken(idToken, { disc, issuer, clientId, nonce, now = Date.now(), jwks = null }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('the ID token is not a JWT');
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  const alg = header.alg;
  if (!['RS256', 'ES256'].includes(alg)) throw new Error(`unsupported ID token algorithm ${alg}`);
  const keys = jwks || await getJson(disc.jwks_uri);
  const jwk = (keys.keys || []).find((k) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig'));
  if (!jwk) throw new Error('no signing key matches the ID token');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const good = alg === 'RS256'
    ? crypto.verify('RSA-SHA256', data, key, sig)
    : crypto.verify('SHA256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  if (!good) throw new Error('the ID token signature does not verify');
  if (String(claims.iss || '').replace(/\/+$/, '') !== issuer) throw new Error('the ID token was issued by someone else');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('the ID token is for a different client');
  if (!claims.exp || claims.exp * 1000 < now - 60_000) throw new Error('the ID token has expired');
  if (!eq(claims.nonce, nonce)) throw new Error('the ID token nonce does not match this sign-in');
  return claims;
}

function page(title, text) {
  return `<!doctype html><meta charset="utf-8"><title>Noema</title><body style="font:15px system-ui;background:#101218;color:#e8e8ef;display:grid;place-items:center;height:90vh"><div><h2>${title}</h2><p>${text}</p></div>`;
}

/**
 * START. Returns the official authorization URL for the window to open in the
 * DEFAULT browser (host.cs openExternal). Nothing is opened here.
 */
async function begin(app, { onDone = null } = {}) {
  const c = client(app);
  if (!c.ok) return { ok: false, state: STATE.NOT_AVAILABLE, why: c.why };
  const store = require('./secretstore').available();
  if (!store.ok) return { ok: false, state: STATE.NOT_AVAILABLE, why: store.why };
  cancel();
  lastError = '';
  let disc;
  try { disc = await discover(c.issuer); } catch (e) { lastError = (e && e.message) || String(e); return { ok: false, state: STATE.FAILED, why: lastError }; }
  const verifier = rand(48);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = rand(24);
  const nonce = rand(24);
  const server = http.createServer();
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  pending = { state, nonce, verifier, redirect, server, at: Date.now(), disc, clientId: c.clientId, issuer: c.issuer };
  const expire = setTimeout(() => { if (pending && pending.server === server) { lastError = 'the sign-in was not finished within 10 minutes'; cancel(); } }, INTENT_MS);
  if (expire.unref) expire.unref();
  server.on('request', async (req, res) => {
    const u = new URL(req.url, redirect);
    if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
    const p = pending;
    const done = (code, title, text) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page(title, text)); };
    // ONE CALLBACK, THIS STATE, ONCE. Anything else is refused and ends the attempt.
    if (!p || p.server !== server || !eq(u.searchParams.get('state'), p.state)) {
      done(400, 'Sign-in refused', 'This response does not belong to the sign-in Noema started.');
      return;
    }
    pending = null;
    clearTimeout(expire);
    setImmediate(() => server.close());
    if (u.searchParams.get('error')) {
      lastError = `OpenAI returned ${u.searchParams.get('error')}`;
      done(400, 'Not signed in', 'OpenAI did not complete the sign-in. You can close this tab.');
      if (onDone) onDone(status(app));
      return;
    }
    try {
      const form = new URLSearchParams({
        grant_type: 'authorization_code', code: String(u.searchParams.get('code') || ''), redirect_uri: p.redirect,
        client_id: p.clientId, code_verifier: p.verifier,
      });
      const tok = await getJson(p.disc.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() });
      const claims = await verifyIdToken(tok.id_token, { disc: p.disc, issuer: p.issuer, clientId: p.clientId, nonce: p.nonce });
      const kept = require('./secretstore').put(SECRET, JSON.stringify({
        identity: { sub: claims.sub, name: claims.name || null, email: claims.email || null, at: Date.now() },
        refreshToken: tok.refresh_token || null,
      }));
      if (!kept.ok) throw new Error(kept.why);
      done(200, 'Signed in to Noema', 'Your ChatGPT identity is connected to Noema. You can close this tab.');
    } catch (e) {
      lastError = (e && e.message) || String(e);
      done(400, 'Not signed in', 'Noema could not complete the sign-in. The reason is shown in Noema.');
    }
    if (onDone) onDone(status(app));
  });
  const q = new URLSearchParams({
    response_type: 'code', client_id: c.clientId, redirect_uri: redirect, scope: SCOPE,
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return { ok: true, state: STATE.WAITING, url: `${disc.authorization_endpoint}?${q.toString()}` };
}

function cancel() {
  if (pending && pending.server) { try { pending.server.close(); } catch { /* closed */ } }
  pending = null;
}

/** Disconnect, two-step: the first call returns a single-use token, the second uses it. */
function disconnect({ token = null } = {}) {
  if (!token) {
    removeIntent = { token: rand(18), at: Date.now() };
    return { ok: true, confirm: true, token: removeIntent.token, impact: 'Noema forgets your ChatGPT identity and its refresh token. Nothing in your ChatGPT account changes.' };
  }
  const i = removeIntent;
  removeIntent = null;
  if (!i || Date.now() - i.at > 2 * 60_000 || !eq(i.token, token)) return { ok: false, why: 'that confirmation has expired — start again' };
  require('./secretstore').remove(SECRET);
  lastError = '';
  return { ok: true, removed: true };
}

module.exports = { STATE, BORROWED, SCOPE, status, begin, cancel, disconnect, verifyIdToken, discover, client, allowedUrl };
