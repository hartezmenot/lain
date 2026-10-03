'use strict';

/** CLAUDE CODE — the real `claude` program, driven through its documented non-interactive mode. */

const fs = require('fs');
const path = require('path');
const cliexec = require('./cliexec');
const { flatten } = require('./runtimechat');

const ID = 'claude-code';
const ALIASES = Object.freeze(['opus', 'sonnet', 'haiku', 'fable']);

function root(app) { return (app && app._sibling) || app; }
function settings(app) { const c = (root(app) && root(app).cfg) || {}; return (c.runtimes && c.runtimes[ID]) || {}; }
// (a PATH walk per call was ~150 stats, on every header redraw — pathlookup.js keeps the answer)
function which(name) { return require('../pathlookup').find(name, process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']); }
// AN ISOLATED TEST RUN uses only a configured (fake) binary — never the real one on PATH.
function binary(app) { const s = settings(app); return s.binary ? (fs.existsSync(s.binary) ? s.binary : null) : (process.env.LAIN_ISOLATED === '1' ? null : which('claude')); }

function maskEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '•••' : null;
  return `${s[0]}•••${s.slice(at - 1, at)}@${s.slice(at + 1)}`;
}

async function discover(app) {
  const bin = binary(app);
  if (!bin) return { installed: false, binary: null, version: null, why: 'claude is not on PATH' };
  const r = await cliexec.collect(bin, ['--version'], { timeoutMs: 20000, purpose: 'runtime-probe', label: 'claude --version' }).catch((e) => ({ ok: false, lines: [], stderr: e.message }));
  return { installed: true, binary: bin, version: r.ok ? (r.lines[0] || '').trim() : null, why: r.ok ? null : (r.stderr || '').trim().split('\n')[0] };
}

async function telemetry(app, { prev = null } = {}) {
  const bin = binary(app);
  if (!bin) return { ok: false, why: 'not installed' };
  // ASKED, NOT RUN (claudecontrol.js): identity, the live model catalog and the plan windows from one status session in
  // the person's own profile — Claude Code reads its sign-in; LAIN reads none, and nothing is generated.
  const a = await require('./claudecontrol').ask({ command: bin, args: [] }, {}, { usage: true });
  if (a.ok) {
    const models = (a.models && a.models.length ? a.models : ALIASES.map((x) => ({ id: x, label: `Claude ${x[0].toUpperCase()}${x.slice(1)}`, efforts: [] })))
      .map((m) => ({ id: `${ID}/${m.id}`, alias: m.id, label: `${m.label} · Claude Code`, roles: ['CHAT', 'BOT', 'AGENT'], efforts: m.efforts || [], capabilities: m.capabilities || null, resolved: m.resolved || (prev && prev.resolved && prev.resolved[m.id]) || null }));
    return {
      ok: true, at: Date.now(), why: null,
      identity: { signedIn: Boolean(a.signedIn), method: a.account.apiProvider || null, plan: a.account.plan || null, email: maskEmail(a.account.email), provider: a.account.apiProvider || null, org: a.account.organization ? 'organization present' : null },
      models,
      modelsAt: Date.now(),
      limits: a.limits && a.limits.windows.length ? a.limits : (prev && prev.limits) || null,
      quotaAskedAt: Date.now(),
      resolved: (prev && prev.resolved) || {},
      lastRun: prev && prev.lastRun ? prev.lastRun : null,
    };
  }
  // AN OLDER CLAUDE CODE (no control protocol): its own `auth status`, identity only.
  const r = await cliexec.collect(bin, ['auth', 'status'], { timeoutMs: 20000, purpose: 'runtime-probe', label: 'claude auth status' }).catch((e) => ({ ok: false, lines: [], stderr: e.message }));
  let st = null;
  try { st = JSON.parse(r.lines.join('\n')); } catch { st = null; }
  const identity = st ? {
    signedIn: Boolean(st.loggedIn), method: st.authMethod || null, plan: st.subscriptionType || null,
    email: maskEmail(st.email), provider: st.apiProvider || null, org: st.orgName ? 'organization present' : null,
  } : null;
  return {
    ok: Boolean(st), at: Date.now(), why: st ? null : 'claude auth status gave no readable answer',
    identity,
    models: ALIASES.map((x) => ({ id: `${ID}/${x}`, alias: x, label: `Claude ${x[0].toUpperCase()}${x.slice(1)} · Claude Code`, roles: ['CHAT', 'BOT', 'AGENT'], resolved: (prev && prev.resolved && prev.resolved[x]) || null })),
    limits: prev && prev.limits ? prev.limits : null,
    resolved: (prev && prev.resolved) || {},
    lastRun: prev && prev.lastRun ? prev.lastRun : null,
  };
}

function execution(app, tele) {
  if (!binary(app)) return { chat: { ok: false, why: 'not installed' }, agent: { ok: false, why: 'not installed' } };
  if (tele && tele.identity && !tele.identity.signedIn) return { chat: { ok: false, why: 'Claude Code is not signed in — sign in inside Claude Code' }, agent: { ok: false, why: 'not signed in' } };
  return { chat: { ok: true, how: 'claude -p (no tools)' }, agent: { ok: true, how: 'claude -p with its own tools, in the project folder' } };
}

/** Claude Code's `rate_limit_event` → provider windows (as reported, never averaged). */
const LIMIT_LABEL = Object.freeze({ five_hour: '5-hour', seven_day: '7-day', seven_day_opus: '7-day (Opus)', seven_day_sonnet: '7-day (Sonnet)', seven_day_overage_included: '7-day (overage)' });
const pctOf = (u) => (Number.isFinite(u) ? Math.round((u <= 1 ? u * 100 : u) * 10) / 10 : null);
const secMs = (t) => (Number.isFinite(t) ? (t < 1e11 ? t * 1000 : t) : null);
function limitsFrom(ev) {
  const info = ev && ev.rate_limit_info;
  if (!info) return null;
  let windows = Object.entries(info.unifiedWindows || {}).map(([k, w]) => ({ id: k, label: LIMIT_LABEL[k] || k.replace(/_/g, ' '), usedPercent: pctOf(w && w.utilization), resetsAt: secMs(w && w.resetsAt) }));
  if (!windows.length && info.rateLimitType && info.rateLimitType !== 'overage' && (Number.isFinite(info.utilization) || Number.isFinite(info.resetsAt))) {
    windows = [{ id: info.rateLimitType, label: LIMIT_LABEL[info.rateLimitType] || String(info.rateLimitType).replace(/_/g, ' '), usedPercent: pctOf(info.utilization), resetsAt: secMs(info.resetsAt) }];
  }
  windows = windows.filter((w) => w.usedPercent != null || w.resetsAt);
  return { at: Date.now(), status: info.status || null, overage: info.isUsingOverage === true, windows, basis: 'reported by Claude Code (rate_limit_event)' };
}

/** A traffic reading may carry ONE window: it updates that window and keeps the others it did not mention. */
function mergeLimits(prev, next) {
  if (!next || !next.windows || !next.windows.length) return prev || null;
  if (!prev || !Array.isArray(prev.windows)) return next;
  const byId = new Map(prev.windows.map((w) => [w.id, w]));
  for (const w of next.windows) byId.set(w.id, w);
  return { ...prev, ...next, windows: [...byId.values()] };
}

/** The instance a runtime route names: runtime:claude-code:<id>, else null (the person's own default profile). */
function instanceOf(pc) { const m = /^runtime:claude-code:(.+)$/.exec(String((pc && (pc.instanceId || pc.connectionId)) || '')); return m ? m[1] : (pc && pc.instanceId) || null; }

/** THE ENVIRONMENT OF A RUN — an account's OWN configuration directory, and nothing borrowed from another. */
function envFor(app, instanceId) {
  if (!instanceId) return {};
  const h = require('../accountinstances').handle(app, instanceId);
  if (!h) { const e = new Error('that Claude account is no longer connected'); e.status = 409; throw e; }
  return h.env();
}

/** Run once; yields provider events and returns the result record. */
async function* runStream(app, { prompt, system = null, model = null, effort = null, mode = 'chat', cwd = process.cwd(), signal = null, onMeta = null, instanceId = null } = {}) {
  const bin = binary(app);
  if (!bin) { const e = new Error('Claude Code is not installed'); e.status = 503; throw e; }
  const env = envFor(app, instanceId);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompts', 'none'];
  if (model) args.push('--model', model);
  // THE LANE'S EFFORT in Claude Code's own form (fabric/effortcaps.js) — only a level the model declares.
  args.push(...require('../fabric/effortcaps').runtimeArgs('claude-code', effort));
  if (mode === 'chat') {
    args.push('--tools', '', '--strict-mcp-config', '--no-session-persistence');
    if (system) args.push('--system-prompt', system);
  } else {
    args.push('--permission-mode', settings(app).permissionMode || 'acceptEdits');
    if (system) args.push('--append-system-prompt', require('../discipline/constitution').wrap('claude-code', system));
  }
  const run = cliexec.start(bin, args, { cwd, env, stdin: prompt, signal, purpose: `runtime:${ID}`, label: `Claude Code · ${mode}` });
  // THE RUN IS THIS ACCOUNT'S WORK — connecting or switching another account asks accountwork before it touches anything.
  const work = require('../accountwork').begin(ID, instanceId, { kind: mode, pid: run.pid });
  try {
  let usage = null; let result = null; let limits = null; let resolvedModel = null; let sawText = false;
  for await (const line of run.lines()) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'stream_event' && j.event) {
      const e = j.event;
      if (e.type === 'message_start' && e.message && e.message.model) resolvedModel = e.message.model;
      if (e.type === 'content_block_delta' && e.delta) {
        if (e.delta.type === 'text_delta' && e.delta.text && !j.parent_tool_use_id) { sawText = true; yield { type: 'text', chunk: e.delta.text }; }
        if (e.delta.type === 'thinking_delta' && e.delta.thinking) yield { type: 'reasoning', chunk: e.delta.thinking };
      }
      continue;
    }
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) {
        if (b.type === 'tool_use') yield { type: 'runtime_tool', name: b.name, input: b.input, id: b.id };
        if (b.type === 'text' && b.text && !sawText && mode === 'chat') yield { type: 'text', chunk: b.text };
      }
      continue;
    }
    if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) if (b.type === 'tool_result') yield { type: 'runtime_tool_result', id: b.tool_use_id, isError: b.is_error === true };
      continue;
    }
    if (j.type === 'rate_limit_event') { limits = limitsFrom(j); continue; }
    if (j.type === 'result') { result = j; usage = j.usage || null; }
  }
  const done = await run.done;
  if (onMeta) onMeta({ limits, resolvedModel, result, cancelled: run.cancelled, code: done.code });
  if (run.cancelled) { const e = new Error('cancelled'); e.status = 499; e.cancelled = true; throw e; }
  if (!result || result.is_error || result.subtype !== 'success') {
    const why = (result && (result.result || result.subtype)) || done.stderr.trim().split('\n').pop() || `claude exited with code ${done.code}`;
    const e = new Error(`Claude Code: ${String(why).slice(0, 300)}`); e.status = 502; throw e;
  }
  const u = usage || {};
  const details = u.output_tokens_details || {};
  yield { type: 'finish', reason: 'stop', raw: result.stop_reason || null };
  yield {
    type: 'usage', inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0, cacheCreationTokens: u.cache_creation_input_tokens || 0, cacheReported: true,
    reasoningTokens: Number.isFinite(details.thinking_tokens) ? details.thinking_tokens : undefined,
    costUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : undefined,
    costBasis: 'computed by Claude Code (API-equivalent; a subscription is not billed per token)',
    runtime: { id: ID, session: result.session_id || null, turns: result.num_turns || null, ms: result.duration_ms || null, model: resolvedModel },
  };
  } finally { require('../accountwork').end(work); }
}

/** The BOT path: a conversation → one Claude Code run with no tools. */
async function* chat(pc, messages, opts = {}) {
  const { system, prompt } = flatten(messages);
  const alias = String(pc.model || '').replace(/^claude-code\//, '') || null;
  const app = opts.app || null;
  const instanceId = instanceOf(pc);
  yield* runStream(app, { prompt, system, model: alias, effort: pc.reasoningEffort || null, mode: 'chat', cwd: opts.cwd || process.cwd(), signal: opts.signal, instanceId, onMeta: (m) => remember(app, alias, m, instanceId) });
}

/** The Coding Agent path: a task → Claude Code works in the project with its own tools. */
async function* agent(app, { prompt, system = null, model = null, effort = null, cwd, signal, instanceId = null }) {
  const alias = String(model || '').replace(/^claude-code\//, '') || null;
  yield* runStream(app, { prompt, system, model: alias, effort, mode: 'agent', cwd, signal, instanceId, onMeta: (m) => remember(app, alias, m, instanceId) });
}

/** What a run revealed — windows, the model an alias resolved to, the outcome — kept with the telemetry. */
function remember(app, alias, m, instanceId = null) {
  try {
    const ra = require('../runtimeadapters');
    // PER ACCOUNT: an account's windows are its own — never merged with another's.
    const tid = instanceId ? `${ID}--${instanceId}` : ID;
    const prev = ra.cachedTelemetry(tid) || {};
    const next = { ...prev };
    if (m.limits) next.limits = mergeLimits(prev.limits, m.limits);
    if (alias && m.resolvedModel) next.resolved = { ...(prev.resolved || {}), [alias]: m.resolvedModel };
    next.lastRun = { at: Date.now(), ok: !m.cancelled && m.result && m.result.subtype === 'success' && !m.result.is_error, cancelled: m.cancelled };
    ra.saveTelemetry(tid, next);
  } catch { /* measurement only */ }
}

module.exports = {
  id: ID, label: 'Claude Code', provider: 'anthropic', kind: 'runtime', icon: 'anthropic',
  source: 'Claude Code Runtime', authentication: 'Claude app / runtime sign-in (kept by Claude Code)',
  install: { docs: 'https://docs.anthropic.com/en/docs/claude-code/setup' },
  binary, discover, telemetry, execution, chat, agent, runStream, limitsFrom, mergeLimits, maskEmail, ALIASES, instanceOf,
};
