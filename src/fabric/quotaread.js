'use strict';

/**
 * PROVIDER QUOTA, READ — never inferred, never paid for (2026-09-29).
 *
 *   Claude   GET <api.anthropic.com>/api/oauth/usage
 *            the account's OWN OAuth token, from a LAIN-owned Claude profile
 *            (never the person's own profile — that store is Claude Code's)
 *   Z.ai     GET <origin>/api/monitor/usage/quota/limit
 *            the API key LAIN holds for the Z.ai API source
 *   Codex    `account/rateLimits/read` through the account's own app-server —
 *            already a status read (accountinstances.refresh), unchanged
 *
 * Every one is a MANAGEMENT read: no model runs, no quota is spent, nothing is
 * refreshed on the provider's behalf (an expired Claude token is left for
 * Claude Code's own next run to renew).
 *
 * PROVENANCE. The contracts are adapted from the person's own router
 * (E:\AI\router, src/subscription-management.ts — "verified live"), which
 * studied 9Router, OmniRoute and the Z.ai usage tooling:
 *   Claude   headers `anthropic-version: 2023-06-01`, `anthropic-beta:
 *            oauth-2025-04-20`; windows at the ROOT (five_hour, seven_day,
 *            seven_day_opus, seven_day_sonnet) with `utilization` = percent
 *            USED and `resets_at` (ISO); identity from /api/claude_cli/bootstrap
 *   Z.ai     `{ code: 200, data: { limits: [{ type, unit, number, usage,
 *            currentValue, remaining, percentage, nextResetTime }] } }` —
 *            percentage = percent CONSUMED; unit 3 × 5 = the 5-hour window,
 *            unit 6 × 1 = weekly; TIME_LIMIT = the monthly MCP allowance; the
 *            monitor takes the raw key, else `Bearer` (both are deployed)
 *
 * ORIENTATION IS RESOLVED HERE: every window leaves as `usedPercent`; the
 * fabric derives what remains (fabric/index.js normWindow).
 */

const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 10000;
const CLAUDE_LABEL = Object.freeze({ five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly (Opus)', seven_day_sonnet: 'weekly (Sonnet)' });

function managementBase() { return String(process.env.LAIN_ANTHROPIC_MANAGEMENT_BASE || 'https://api.anthropic.com').replace(/\/+$/, ''); }
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isoMs = (v) => { if (typeof v === 'string' && v.trim()) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; } const n = num(v); return n && n > 0 ? (n < 1e11 ? n * 1000 : n) : null; };

async function getJson(url, headers, fetchImpl = globalThis.fetch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    const r = await fetchImpl(url, { method: 'GET', headers, signal: ctl.signal });
    const json = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, json };
  } finally { clearTimeout(timer); }
}

/** The OAuth sign-in Claude Code keeps in a profile LAIN made (its `.credentials.json`), or why there is none. */
function claudeToken(home) {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8')); } catch { return { ok: false, why: 'not signed in' }; }
  const o = d && d.claudeAiOauth;
  if (!o || !o.accessToken) return { ok: false, why: 'this profile holds no Claude sign-in token' };
  if (o.expiresAt && Number(o.expiresAt) <= Date.now()) return { ok: false, expired: true, why: 'the sign-in token expired — Claude Code renews it on its next run' };
  return { ok: true, token: String(o.accessToken) };
}

function claudeHeaders(token, version) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': `claude-code/${version || '2.1'}` };
}

/**
 * CLAUDE: this account's windows, from Anthropic's usage endpoint.
 * @returns {{ ok: true, limits: { at, windows: [{ id, label, usedPercent, resetsAt }], basis } } | { ok: false, why, status? }}
 */
async function claudeUsage(home, { fetchImpl, version } = {}) {
  const t = claudeToken(home);
  if (!t.ok) return t;
  let r;
  try { r = await getJson(`${managementBase()}/api/oauth/usage`, claudeHeaders(t.token, version), fetchImpl); } catch (e) { return { ok: false, why: `the usage endpoint did not answer: ${String((e && e.message) || e).slice(0, 80)}` }; }
  if (!r.ok) return { ok: false, status: r.status, why: r.status === 401 || r.status === 403 ? 'Anthropic refused this sign-in for usage' : `the usage endpoint answered HTTP ${r.status}` };
  const root = r.json && typeof r.json === 'object' ? r.json : {};
  const windows = [];
  for (const [id, label] of Object.entries(CLAUDE_LABEL)) {
    const w = root[id];
    if (!w || typeof w !== 'object') continue;
    const used = num(w.utilization) != null ? num(w.utilization) : num(w.used_percent);
    const resetsAt = isoMs(w.resets_at != null ? w.resets_at : w.reset_at);
    if (used == null && !resetsAt) continue;
    windows.push({ id, label, usedPercent: used == null ? null : Math.round(Math.max(0, Math.min(100, used)) * 10) / 10, resetsAt });
  }
  return { ok: true, limits: { at: Date.now(), status: null, windows, basis: 'reported by Anthropic (OAuth usage)' } };
}

/** CLAUDE: who a sign-in belongs to, from Anthropic (a status read) — how a migrated sign-in is verified. */
async function claudeIdentity(home, { fetchImpl, version } = {}) {
  const t = claudeToken(home);
  if (!t.ok) return t;
  let r;
  try { r = await getJson(`${managementBase()}/api/claude_cli/bootstrap`, claudeHeaders(t.token, version), fetchImpl); } catch (e) { return { ok: false, why: `Anthropic did not answer: ${String((e && e.message) || e).slice(0, 80)}` }; }
  if (!r.ok) return { ok: false, status: r.status, why: r.status === 401 || r.status === 403 ? 'Anthropic refused this sign-in' : `Anthropic answered HTTP ${r.status}` };
  const j = r.json || {};
  const acct = j.account || j.oauth_account || j.user || {};
  const email = j.email || acct.email || acct.account_email || null;
  const plan = j.subscription_type || j.subscriptionType || j.plan || acct.plan || null;
  return { ok: true, identity: { email: email ? String(email) : null, plan: plan ? String(plan) : null } };
}

/** Z.AI: one limit entry → a window, by the provider's own (unit, number) pair; else by `type`; else nothing. */
function zaiWindowOf(item) {
  const unit = num(item && item.unit); const n = num(item && item.number);
  if (unit === 3 && n === 5) return { id: 'five_hour', label: '5-hour' };
  if (unit === 6 && n === 1) return { id: 'seven_day', label: 'weekly' };
  const type = String((item && item.type) || '').toUpperCase();
  if (type === 'TOKENS_LIMIT') return { id: 'five_hour', label: '5-hour' };
  if (type === 'TIME_LIMIT') return { id: 'mcp_monthly', label: 'monthly (MCP)' };
  return null;
}

/**
 * Z.AI: the API key's windows, from the monitor endpoint at the API's ORIGIN (never appended to /api/coding/paas/v4).
 * Z.ai wraps errors in an HTTP 200 body — `code` is the truth.
 */
async function zaiQuota(baseUrl, key, { fetchImpl } = {}) {
  if (!key) return { ok: false, why: 'no API key' };
  let origin;
  try { origin = new URL(String(baseUrl || 'https://api.z.ai')).origin; } catch { return { ok: false, why: 'the Z.ai address is not a valid URL' }; }
  let last = null;
  for (const style of ['raw', 'bearer']) {
    let r;
    try { r = await getJson(`${origin}/api/monitor/usage/quota/limit`, { Authorization: style === 'raw' ? key : `Bearer ${key}`, Accept: 'application/json', 'Accept-Language': 'en-US,en' }, fetchImpl); } catch (e) { return { ok: false, why: `the Z.ai monitor did not answer: ${String((e && e.message) || e).slice(0, 80)}` }; }
    const code = r.json && num(r.json.code);
    const authShaped = r.status === 401 || r.status === 403 || code === 1000 || code === 401;
    last = { r, code };
    if (r.ok && (code === 200 || code === 0 || code == null) && !authShaped) break;
    if (!authShaped) break;
  }
  const { r, code } = last;
  if (!r.ok || (code != null && code !== 200 && code !== 0)) return { ok: false, status: r.status, why: `the Z.ai monitor refused the key (HTTP ${r.status}${code != null ? `, code ${code}` : ''})` };
  const data = (r.json && r.json.data) || {};
  const items = Array.isArray(data.limits) ? data.limits : Array.isArray(r.json.limits) ? r.json.limits : [];
  const windows = [];
  for (const item of items) {
    const w = zaiWindowOf(item);
    if (!w) continue;
    const used = num(item.percentage);
    const resetsAt = isoMs(item.nextResetTime);
    if (used == null && num(item.remaining) == null) continue;
    windows.push({ ...w, usedPercent: used == null ? null : Math.max(0, Math.min(100, used)), resetsAt, limit: num(item.usage), used: num(item.currentValue), remaining: num(item.remaining) });
  }
  return { ok: true, windows, basis: 'reported by Z.ai (monitor)' };
}

/** Is this API source Z.ai's (global or BigModel)? A connection may also say so itself (`provider: zai`). */
function isZai(baseUrl, provider = '') { if (String(provider).toLowerCase() === 'zai') return true; try { return /(^|\.)z\.ai$|(^|\.)bigmodel\.cn$/i.test(new URL(String(baseUrl)).hostname); } catch { return false; } }

/**
 * THE API SOURCES WHOSE PROVIDER ANSWERS QUOTA WITHOUT A MODEL CALL — today, Z.ai's monitor. Each reading is kept as
 * the account's reported windows (fabric/store.recordQuota), which every surface then states as what remains.
 */
async function refreshApi(app) {
  const r = (app && app._sibling) || app;
  let conns = [];
  try { conns = r && r.connections ? r.connections() : []; } catch { conns = []; }
  const out = [];
  for (const c of conns) {
    if (!isZai(c.baseUrl, c.provider)) continue;
    // THE KEY IS READ WHERE KEYS MAY BE READ (accountinstances.js) — this module only ever receives it.
    // eslint-disable-next-line no-await-in-loop -- one provider read per source
    const q = await require('../accountinstances').refreshQuota(app, c.id);
    out.push({ id: c.id, ok: Boolean(q && q.ok), why: (q && q.why) || null, windows: q && q.ok && q.windows ? q.windows.length : 0 });
  }
  return out;
}

module.exports = { claudeUsage, claudeIdentity, claudeToken, zaiQuota, refreshApi, isZai, zaiWindowOf, managementBase };
