'use strict';

/**
 * ANTIGRAVITY OVER HTTPS — account management and execution WITHOUT Google's 468 MB ACP server (2026-10-01).
 *
 * ------------------------------------------------------------------------
 * WHY. The first Antigravity integration (drivers/antigravity.js) ran every act — sign-in, identity, models — through
 * Google's `agy_acp_server`, a 468 MB download, because that program performs the login and writes the profile
 * Noema then read. Nothing about OAuth, identity, quota or models needs it: they are plain HTTPS calls, and the
 * reference routers (9Router, OmniRoute, E:\AI\router — read-only references, never a dependency) have made them
 * live since 2026-09-16. Proven here, not assumed:
 *
 *   sign-in   Google installed-app OAuth (RFC 8252): browser → loopback redirect → code → token, with PKCE. The
 *             client id/secret are the PUBLIC installed-app constants every copy of the official app carries; they
 *             identify the program, protect nothing, and RFC 8252 says so.
 *   refresh   oauth2.googleapis.com/token, grant_type=refresh_token
 *   identity  googleapis.com/oauth2/v1/userinfo
 *   project   cloudcode-pa v1internal:loadCodeAssist (onboardUser when the account has none yet)
 *   models    v1internal:fetchAvailableModels {project}
 *   quota     v1internal:retrieveUserQuotaSummary {project} → per-family buckets {window, remainingFraction, resetTime}
 *             (daily-cloudcode-pa first, cloudcode-pa second — the references pin that order)
 *   execute   v1internal:generateContent — the Gemini structured surface: contents/parts, functionDeclarations,
 *             functionCall/functionResponse, thinkingConfig
 *
 * ISOLATION (the auth invariant, intelligence-fabric): one sign-in = one NEW AccountInstance with its own token under
 * its own credential reference (DPAPI, credentials.js). Nothing is read from ~/.gemini or any other program's store,
 * no existing account is touched, nothing is copied.
 *
 * TEST SEAM: NOEMA_ANTIGRAVITY_BASE points every endpoint (auth, token, userinfo, cloudcode) at one fake server.
 */

const crypto = require('crypto');
const http = require('http');

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';   // public installed-app constant (RFC 8252 §8.5)
const SCOPES = ['cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs'].map((s) => `https://www.googleapis.com/auth/${s}`);
const UA = 'antigravity/1.20.3 windows/x86_64';
const META = Object.freeze({ ideType: 9, platform: 5, pluginType: 2 });
const MAX_OUTPUT = 16384;   // the provider's ceiling (400 above it — recorded by the references)
const THINKING = Object.freeze({ none: 0, minimal: 128, low: 1024, medium: 4096, high: 8192, xhigh: 12288, max: 16000 });

function base() { return String(process.env.NOEMA_ANTIGRAVITY_BASE || '').replace(/\/+$/, ''); }
function ep() {
  const b = base();
  return {
    auth: b ? `${b}/o/oauth2/v2/auth` : 'https://accounts.google.com/o/oauth2/v2/auth',
    token: b ? `${b}/token` : 'https://oauth2.googleapis.com/token',
    userinfo: b ? `${b}/oauth2/v1/userinfo?alt=json` : 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
    bootstrap: b || 'https://cloudcode-pa.googleapis.com',
    quota: b ? [b] : ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'],
    execute: b || 'https://daily-cloudcode-pa.googleapis.com',
  };
}

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }

// ---- SIGN-IN -----------------------------------------------------------------------------------------------------

/**
 * Start a sign-in: a loopback listener on 127.0.0.1 (a fresh port), and the URL the person opens.
 * Returns { url, done: Promise<tokens>, cancel() }. `done` resolves once Google redirects back with a code and the code
 * is exchanged; it rejects on a wrong `state`, a denial, or after `timeoutMs`.
 */
function beginLogin({ timeoutMs = 10 * 60 * 1000 } = {}) {
  const state = b64url(crypto.randomBytes(16));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  let server = null;
  let settle;
  const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  done.catch(() => {});
  let timer = null;
  const close = () => { if (timer) clearTimeout(timer); try { server && server.close(); } catch { /* closed */ } };
  const ready = new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/oauth2callback') { res.writeHead(404); res.end(); return; }
      const page = (title, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;padding:40px;background:#0b0f19;color:#e8ecf5"><h2>${title}</h2><p>${body}</p></body>`); };
      if (u.searchParams.get('state') !== state) { page('Sign-in refused', 'This response did not belong to the sign-in Noema started.'); return; }
      if (u.searchParams.get('error')) { page('Sign-in cancelled', 'You can close this tab.'); close(); settle.reject(Object.assign(new Error(`Google sign-in: ${u.searchParams.get('error')}`), { code: 'DENIED' })); return; }
      const code = u.searchParams.get('code');
      if (!code) { page('Sign-in failed', 'No authorization code came back.'); return; }
      try {
        const port = server.address().port;
        const tokens = await exchange({ code, verifier, redirectUri: `http://127.0.0.1:${port}/oauth2callback` });
        page('Signed in to Antigravity', 'Noema has the account. You can close this tab.');
        close();
        settle.resolve(tokens);
      } catch (e) { page('Sign-in failed', 'The code could not be exchanged — try again from Noema.'); close(); settle.reject(e); }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  timer = setTimeout(() => { close(); settle.reject(Object.assign(new Error('the sign-in was not completed in time'), { code: 'TIMEOUT' })); }, timeoutMs);
  if (timer.unref) timer.unref();
  return ready.then((port) => {
    const q = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: `http://127.0.0.1:${port}/oauth2callback`, response_type: 'code', scope: SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    return { url: `${ep().auth}?${q}`, done, cancel: () => { close(); settle.reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); } };
  });
}

async function postForm(url, form) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw Object.assign(new Error(`Google token endpoint HTTP ${r.status}${j && j.error ? ` (${j.error})` : ''}`), { status: r.status, code: j && j.error });
  return j;
}

function tokenRecord(j, prev = null) {
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || (prev && prev.refresh_token) || null,
    expires_at: Date.now() + Math.max(60, Number(j.expires_in) || 3600) * 1000,
    scope: j.scope || (prev && prev.scope) || null,
  };
}

async function exchange({ code, verifier, redirectUri }) {
  return tokenRecord(await postForm(ep().token, { code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }));
}

/** A usable access token: the stored one, or a refreshed one (and the refreshed record, for the caller to keep). */
async function fresh(rec) {
  if (rec && rec.access_token && Number(rec.expires_at) - Date.now() > 120_000) return { token: rec.access_token, rec, refreshed: false };
  if (!rec || !rec.refresh_token) throw Object.assign(new Error('this Antigravity account has no refresh token — sign in again'), { status: 401, code: 'LOGIN_REQUIRED' });
  const j = await postForm(ep().token, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: rec.refresh_token, grant_type: 'refresh_token' });
  const next = tokenRecord(j, rec);
  return { token: next.access_token, rec: next, refreshed: true };
}

// ---- ACCOUNT FACTS -----------------------------------------------------------------------------------------------

function headers(token) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': UA }; }

async function getJson(url, token) {
  const r = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(15000) });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
}
async function postJson(url, token, body, timeoutMs = 15000) {
  const r = await fetch(url, { method: 'POST', headers: headers(token), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
}
async function postFirst(hosts, path, token, body) {
  let last = { ok: false, status: 0, json: null, host: null };
  for (const h of hosts) {
    try { const r = await postJson(`${h}${path}`, token, body); last = { ...r, host: h }; if (r.ok) return last; } catch { last = { ok: false, status: 0, json: null, host: h }; }
  }
  return last;
}

/** WHO this token belongs to: { email, name, id } — the provider's own answer, never inferred. */
async function identity(token) {
  const r = await getJson(ep().userinfo, token);
  if (!r.ok || !r.json || !r.json.email) throw Object.assign(new Error(`Google account lookup HTTP ${r.status}`), { status: r.status });
  return { email: String(r.json.email), name: r.json.name ? String(r.json.name) : null, id: r.json.id ? String(r.json.id) : null };
}

function projectOf(j) { const p = j && j.cloudaicompanionProject; return typeof p === 'string' ? p : (p && p.id) || null; }

/** The account's Cloud Code project and plan (loadCodeAssist; onboardUser for an account that has none yet). */
async function bootstrap(token) {
  const load = await postJson(`${ep().bootstrap}/v1internal:loadCodeAssist`, token, { metadata: META });
  const j = load.json || {};
  let project = projectOf(j);
  if (!project && (Array.isArray(j.allowedTiers) || j.currentTier)) {
    const def = Array.isArray(j.allowedTiers) ? (j.allowedTiers.find((t) => t && t.isDefault) || j.allowedTiers[0]) : null;
    try {
      const on = await postJson(`${ep().bootstrap}/v1internal:onboardUser`, token, { tierId: (def && def.id) || 'free-tier', metadata: META });
      if (on.ok) project = projectOf(on.json) || projectOf(on.json && on.json.response);
    } catch { /* reported below */ }
  }
  const paid = j.paidTier || {}; const cur = j.currentTier || {};
  return { project, plan: (paid.name || cur.name || null), tierId: (paid.id || cur.id || null), status: load.status };
}

/** The models this account may use (fetchAvailableModels) — ids as the provider names them. */
async function models(token, project) {
  const r = await postFirst(ep().quota, '/v1internal:fetchAvailableModels', token, { project });
  if (!r.ok) return { ok: false, status: r.status, models: [] };
  const m = (r.json && r.json.models) || {};
  const list = Array.isArray(m) ? m.map((x) => [x.id || x.modelId || x.name, x]) : Object.entries(m);
  return { ok: true, models: list.filter(([id, v]) => id && !(v && v.disabled === true)).map(([id, v]) => ({ id: String(id), label: String((v && (v.displayName || v.label)) || id) })) };
}

function windowOf(b) {
  const raw = typeof b.window === 'string' ? b.window.trim().toLowerCase() : '';
  const text = raw || `${b.bucketId || ''} ${b.displayName || ''}`.toLowerCase();
  if (/\bweekly\b|\bweek\b/.test(text)) return { key: 'week', label: 'Weekly' };
  if (/\b(5h|5-hour|five[_ -]?hour)\b/.test(text)) return { key: '5h', label: '5-hour' };
  if (/\bdaily\b|\bday\b/.test(text)) return { key: 'day', label: 'Daily' };
  if (/\bmonthly\b|\bmonth\b/.test(text)) return { key: 'month', label: 'Monthly' };
  return raw ? { key: raw.replace(/[^a-z0-9]+/g, '_'), label: raw } : null;
}

/**
 * QUOTA AS THE PROVIDER STATES IT — retrieveUserQuotaSummary, per family and window. `remainingFraction` is REMAINING
 * (0..1); a bucket with no fraction was NOT reported and is left out (absent ≠ exhausted); 0 is genuinely exhausted.
 * Families never merge ("Gemini Models" and "Claude and GPT models" are separate pools).
 */
function parseQuota(raw) {
  const root = raw || {};
  const groups = Array.isArray(root.groups) ? root.groups : (root.quotaSummary && Array.isArray(root.quotaSummary.groups) ? root.quotaSummary.groups : []);
  const out = [];
  for (const g of groups) {
    const family = (g && typeof g.displayName === 'string' && g.displayName.trim()) || 'Models';
    for (const b of (g && Array.isArray(g.buckets) ? g.buckets : [])) {
      if (!b || b.disabled === true || typeof b.remainingFraction !== 'number' || !Number.isFinite(b.remainingFraction)) continue;
      const w = windowOf(b);
      if (!w) continue;
      const remaining = Math.max(0, Math.min(1, b.remainingFraction));
      const resetAt = typeof b.resetTime === 'string' && !Number.isNaN(Date.parse(b.resetTime)) ? Date.parse(b.resetTime) : null;
      if (out.some((x) => x.family === family && x.window === w.key)) continue;
      out.push({ family, window: w.key, label: `${family} · ${w.label}`, remainingPercent: Math.round(remaining * 1000) / 10, usedPercent: Math.round((1 - remaining) * 1000) / 10, reported: 'remaining', resetAt, source: 'retrieveUserQuotaSummary' });
    }
  }
  return out;
}

async function quota(token, project) {
  const r = await postFirst(ep().quota, '/v1internal:retrieveUserQuotaSummary', token, { project });
  if (!r.ok) return { ok: false, status: r.status, windows: [], why: `quota summary HTTP ${r.status}` };
  return { ok: true, windows: parseQuota(r.json), host: r.host };
}

/** Everything an account row needs, in one pass: identity, project, plan, models, quota. */
async function describeAccount(token) {
  const who = await identity(token);
  const boot = await bootstrap(token);
  if (!boot.project) return { identity: who, project: null, plan: boot.plan, models: [], quota: { ok: false, windows: [], why: `no Cloud Code project (HTTP ${boot.status}) — finish onboarding in the official Antigravity app` } };
  const [m, q] = await Promise.all([models(token, boot.project), quota(token, boot.project)]);
  return { identity: who, project: boot.project, plan: boot.plan, tierId: boot.tierId, models: m.models, quota: q };
}

// ---- EXECUTION ---------------------------------------------------------------------------------------------------

const SCHEMA_KEYS = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'nullable', 'format', 'anyOf', 'minItems', 'maxItems']);
/** Gemini's declaration schema is a SUBSET of JSON Schema; neutral annotations are dropped, `optional` becomes absence. */
function geminiSchema(node) {
  if (Array.isArray(node)) return node.map(geminiSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  const optional = new Set();
  if (node.properties && typeof node.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(node.properties)) { if (v && v.optional === true) optional.add(k); out.properties[k] = geminiSchema(v); }
  }
  if (node.const !== undefined && node.enum === undefined) out.enum = [node.const];
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' || k === 'const' || !SCHEMA_KEYS.has(k)) continue;
    out[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : (k === 'items' || k === 'anyOf') ? geminiSchema(v) : v;
  }
  if (optional.size && Array.isArray(out.required)) { out.required = out.required.filter((r) => !optional.has(r)); if (!out.required.length) delete out.required; }
  return out;
}

function callId(i, name, args) { return `call_${crypto.createHash('sha256').update(`${i} ${name} ${JSON.stringify(args || {})}`).digest('hex').slice(0, 24)}`; }
function argsOf(a) { if (a && typeof a === 'object') return a; try { const v = JSON.parse(String(a || '{}')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function resultOf(text) { try { const v = JSON.parse(String(text)); return v && typeof v === 'object' && !Array.isArray(v) ? v : { result: v }; } catch { return { result: String(text || '') }; } }

/** Noema's messages → the Cloud Code envelope. Internal shape: tool_calls [{id, name, arguments}], tool {tool_call_id}. */
function envelope({ project, model, effort = null }, messages, tools) {
  const contents = []; const system = []; const names = new Map();
  for (const m of messages || []) {
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('') : '';
    if (m.role === 'system') { if (text) system.push({ text }); continue; }
    if (m.role === 'tool') { contents.push({ role: 'user', parts: [{ functionResponse: { name: names.get(String(m.tool_call_id)) || String(m.name || 'tool'), response: resultOf(text) } }] }); continue; }
    if (m.role === 'assistant') {
      const parts = [];
      if (text) parts.push({ text });
      for (const tc of m.tool_calls || []) { names.set(String(tc.id), String(tc.name)); parts.push({ functionCall: { name: String(tc.name), args: argsOf(tc.arguments !== undefined ? tc.arguments : tc.input) } }); }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      continue;
    }
    contents.push({ role: 'user', parts: [{ text }] });
  }
  const merged = [];
  for (const c of contents) { const last = merged[merged.length - 1]; if (last && last.role === c.role) last.parts.push(...c.parts); else merged.push({ role: c.role, parts: [...c.parts] }); }
  const request = { contents: merged, sessionId: crypto.randomUUID() };
  if (system.length) request.systemInstruction = { parts: system };
  if (tools && tools.length) request.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, ...(t.description ? { description: String(t.description) } : {}), parameters: geminiSchema(t.parameters || { type: 'object', properties: {} }) })) }];
  const gen = { maxOutputTokens: MAX_OUTPUT };
  const budget = effort && Object.prototype.hasOwnProperty.call(THINKING, String(effort).toLowerCase()) ? THINKING[String(effort).toLowerCase()] : null;
  if (budget != null && /thinking|-high|-low|-medium|pro|agent|^gemini-3|claude/i.test(String(model))) gen.thinkingConfig = { thinkingBudget: budget, includeThoughts: budget > 0 };
  request.generationConfig = gen;
  return { project, model, userAgent: 'antigravity', requestType: 'agent', requestId: `agent/${crypto.randomUUID()}/${Date.now()}`, request };
}

/** One generateContent call → Noema's stream events (text, reasoning, tool_calls, usage, finish). */
async function* chat({ token, project, model, effort = null }, messages, opts = {}) {
  const body = envelope({ project, model, effort }, messages, opts.tools || []);
  const r = await fetch(`${ep().execute}/v1internal:generateContent`, { method: 'POST', headers: headers(token), body: JSON.stringify(body), signal: opts.signal || undefined });
  const text = await r.text();
  if (!r.ok) {
    let msg = `Antigravity HTTP ${r.status}`;
    try { const j = JSON.parse(text); if (j && j.error && j.error.message) msg += `: ${String(j.error.message).slice(0, 200)}`; } catch { /* not JSON */ }
    throw Object.assign(new Error(msg), { status: r.status });
  }
  const value = JSON.parse(text);
  const native = value.response || value;
  const c = (native.candidates || [])[0] || {};
  const calls = [];
  for (const part of (c.content && c.content.parts) || []) {
    if (part.functionCall && typeof part.functionCall.name === 'string') { calls.push({ id: callId(calls.length, part.functionCall.name, part.functionCall.args), name: part.functionCall.name, input: part.functionCall.args || {}, malformed: null }); continue; }
    if (typeof part.text === 'string' && part.text) yield part.thought ? { type: 'reasoning', chunk: part.text } : { type: 'text', chunk: part.text };
  }
  if (calls.length) yield { type: 'tool_calls', calls };
  const u = native.usageMetadata || null;
  yield { type: 'finish', reason: calls.length ? 'tool_calls' : c.finishReason === 'MAX_TOKENS' ? 'length' : 'stop', raw: c.finishReason || null };
  if (u) yield { type: 'usage', inputTokens: u.promptTokenCount || 0, outputTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), reasoningTokens: Number.isFinite(u.thoughtsTokenCount) ? u.thoughtsTokenCount : undefined, cacheReadTokens: u.cachedContentTokenCount || 0, cacheCreationTokens: 0, cacheReported: u.cachedContentTokenCount != null };
}

module.exports = { beginLogin, exchange, fresh, identity, bootstrap, models, quota, parseQuota, describeAccount, envelope, chat, geminiSchema, CLIENT_ID, SCOPES, ep };
