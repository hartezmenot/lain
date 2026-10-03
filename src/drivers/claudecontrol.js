'use strict';

/** CLAUDE CODE, ASKED — NOT RUN (2026-10-02). */

const WINDOWS = Object.freeze([
  ['five_hour', '5-hour'],
  ['seven_day', '7-day'],
  ['seven_day_opus', '7-day (Opus)'],
  ['seven_day_sonnet', '7-day (Sonnet)'],
]);
const TIMEOUT_MS = 30_000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isoMs = (v) => { if (typeof v === 'string' && v.trim()) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; } const n = num(v); return n && n > 0 ? (n < 1e11 ? n * 1000 : n) : null; };

/** `get_usage`'s rate_limits → windows { id, label, usedPercent, resetsAt } (only what was reported). */
function windowsOf(rateLimits) {
  const rl = rateLimits && typeof rateLimits === 'object' ? rateLimits : {};
  const out = [];
  for (const [id, label] of WINDOWS) {
    const w = rl[id];
    if (!w || typeof w !== 'object') continue;
    const used = num(w.utilization);
    const resetsAt = isoMs(w.resets_at);
    if (used == null && !resetsAt) continue;
    out.push({ id, label, usedPercent: used == null ? null : Math.max(0, Math.min(100, Math.round(used * 10) / 10)), resetsAt });
  }
  for (const m of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
    if (!m || typeof m !== 'object') continue;
    const used = num(m.utilization);
    const resetsAt = isoMs(m.resets_at);
    if (used == null && !resetsAt) continue;
    const name = String(m.display_name || m.name || 'model').slice(0, 40);
    out.push({ id: `model:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label: `7-day (${name})`, usedPercent: used == null ? null : Math.max(0, Math.min(100, Math.round(used * 10) / 10)), resetsAt });
  }
  return out;
}

/** `initialize`'s models → the catalog's shape. Capabilities only as Claude Code states them. */
function modelsOf(models) {
  const out = [];
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || typeof m !== 'object' || !m.value) continue;
    const efforts = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.map(String) : [];
    out.push({
      id: String(m.value),
      label: String(m.displayName || m.value),
      description: m.description ? String(m.description).slice(0, 160) : '',
      resolved: m.resolvedModel ? String(m.resolvedModel) : null,
      efforts,
      capabilities: {
        reasoning: m.supportsEffort === true || efforts.length > 0,
        adaptiveThinking: m.supportsAdaptiveThinking === true,
        fastMode: m.supportsFastMode === true,
        tools: true,   // every Claude Code model runs Claude Code's own tools — the runtime says so by running them
      },
    });
  }
  return out;
}

/** Parse the control responses a session printed. */
function parse(lines) {
  const r = { init: null, usage: null, errors: [] };
  for (const l of lines || []) {
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (!j || j.type !== 'control_response' || !j.response) continue;
    const id = j.response.request_id;
    if (j.response.subtype === 'error') { r.errors.push({ id, error: String(j.response.error || 'error').slice(0, 200) }); continue; }
    if (id === 'init') r.init = j.response.response || {};
    if (id === 'usage') r.usage = j.response.response || {};
  }
  return r;
}

/** ASK. `binary` is { command, args } (claudeaccount.binaryOf); `env` the account's own ({ CLAUDE_CONFIG_DIR }). @returns {Promise<{ok, account?… */
async function ask(binary, env = {}, { usage = true, timeoutMs = TIMEOUT_MS, cwd = null } = {}) {
  if (!binary || !binary.command) return { ok: false, why: 'Claude Code is not installed' };
  const reqs = [{ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } }];
  if (usage) reqs.push({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } });
  const stdin = `${reqs.map((x) => JSON.stringify(x)).join('\n')}\n`;
  const os = require('os');
  let res;
  try {
    res = await require('./cliexec').collect(binary.command, [...(binary.args || []), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
      env, stdin, timeoutMs, cwd: cwd || os.tmpdir(), purpose: 'runtime-probe', label: 'claude status (initialize · get_usage)',
    });
  } catch (e) { return { ok: false, why: `Claude Code could not be asked: ${String((e && e.message) || e).slice(0, 120)}` }; }
  const p = parse(res.lines);
  if (!p.init) {
    const unsupported = p.errors.some((e) => /unknown|unsupported|not supported/i.test(e.error));
    return { ok: false, unsupported, why: res.cancelled ? 'Claude Code did not answer in time' : (p.errors[0] && p.errors[0].error) || 'Claude Code gave no status answer' };
  }
  const a = p.init.account || {};
  const account = { email: a.email ? String(a.email) : null, organization: a.organization ? String(a.organization) : null, plan: a.subscriptionType ? String(a.subscriptionType) : null, apiProvider: a.apiProvider ? String(a.apiProvider) : null };
  const out = { ok: true, account, models: modelsOf(p.init.models), signedIn: Boolean(account.email || account.plan) };
  if (usage) {
    if (p.usage) {
      out.rateLimitsAvailable = p.usage.rate_limits_available !== false;
      const windows = windowsOf(p.usage.rate_limits);
      out.limits = { at: Date.now(), windows, basis: 'reported by Claude Code (get_usage)', plan: p.usage.subscription_type || account.plan || null };
    } else {
      const e = p.errors.find((x) => x.id === 'usage');
      out.usageWhy = e ? e.error : 'Claude Code did not report usage';
    }
  }
  return out;
}

module.exports = { ask, parse, windowsOf, modelsOf, WINDOWS };
