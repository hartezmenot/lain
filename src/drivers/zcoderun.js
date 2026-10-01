'use strict';

/**
 * ZCODE — Z.ai's ZCode, reached through the runtime it ships: its bundled CLI
 * (`resources/glm/zcode.cjs`), run by ZCode's own Electron build as node, speaking
 * the documented "ZCode Protocol" over stdio (`zcode app-server`).
 *
 *   discovery   the installed app (ZCode.exe) and its bundled CLI; `version`
 *   telemetry   usage/stats        the runtime's own token accounting by model
 *                                  (input, output, cache read, requests, tools)
 *               session/list       its sessions
 *               session/create     (deferred, never persisted) → the models
 *                                  this runtime can serve right now
 *               Start Plan status  as ZCode last recorded it (entry status and
 *                                  reason from its plan-status cache — no
 *                                  credential, no balance, read-only)
 *   execution   workspace/generateText, for the models the runtime lists
 *
 * THE START PLAN, HONESTLY. The Start Plan (and the Coding Plan) are account
 * plans. ZCode serves them only when its DESKTOP HOST supplies the account
 * configuration and the sign-in headers for each request. A standalone ZCode
 * runtime started by LAIN has no such host, so it does not list the plan models
 * and cannot run GLM-5.3-Flash on the Start Plan. LAIN will not act as that host:
 * doing so needs ZCode's OAuth tokens. So: plan telemetry as ZCode recorded it,
 * "Open ZCode" for balance and claiming, and execution only for what the
 * runtime itself lists. Balance and expiry are not exposed by the protocol and
 * are therefore not shown.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cliexec = require('./cliexec');

const ID = 'zcode';

function root(app) { return (app && app._sibling) || app; }
function settings(app) { const c = (root(app) && root(app).cfg) || {}; return (c.runtimes && c.runtimes[ID]) || {}; }

/** The installed app and its bundled runtime, or null. */
function install(app) {
  const s = settings(app);
  if (!s.appDir && process.env.LAIN_ISOLATED === '1') return null;
  const base = s.appDir || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'ZCode') : null);
  if (!base) return null;
  // `exe`: the program that runs the bundled CLI — ZCode's own Electron build (as node); a test may name node itself.
  const exe = s.exe || path.join(base, process.platform === 'win32' ? 'ZCode.exe' : 'zcode');
  const cli = path.join(base, 'resources', 'glm', 'zcode.cjs');
  const builtin = path.join(base, 'resources', 'config', 'provider', 'zcode-builtin.json');
  if (!fs.existsSync(exe) || !fs.existsSync(cli)) return null;
  return { base, exe, cli, builtin: fs.existsSync(builtin) ? builtin : null };
}
function binary(app) { const i = install(app); return i ? i.exe : null; }

/** The environment ZCode's own desktop app gives its runtime: node mode + its shipped provider config. */
function runtimeEnv(i) { return { ELECTRON_RUN_AS_NODE: '1', ...(i.builtin ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: i.builtin } : {}) }; }

async function discover(app) {
  const i = install(app);
  if (!i) return { installed: false, binary: null, version: null, why: 'ZCode is not installed' };
  const r = await cliexec.collect(i.exe, [i.cli, 'version'], { env: runtimeEnv(i), timeoutMs: 30000, purpose: 'runtime-probe', label: 'zcode version' }).catch((e) => ({ ok: false, lines: [], stderr: e.message }));
  const v = r.ok ? (r.lines.join(' ').match(/\d+\.\d+\.\d+/) || [null])[0] : null;
  return { installed: true, binary: i.exe, cli: i.cli, version: v, why: r.ok ? null : String(r.stderr || '').trim().split('\n')[0] };
}

/**
 * ONE app-server process, request/response over stdio. The server's own
 * requests to its host (permissions, runtime preferences, provider sign-in
 * headers) are answered "not supported" — LAIN is not ZCode's host.
 */
function openServer(app, { cwd = process.cwd(), signal = null, spawnFn } = {}) {
  const i = install(app);
  if (!i) throw new Error('ZCode is not installed');
  const r = cliexec.resolveShim(i.exe);
  const { spawn } = require('child_process');
  const child = (spawnFn || spawn)(r.command, [...r.prefix, i.cli, 'app-server'], { cwd, env: { ...process.env, ...runtimeEnv(i) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const recordId = require('../runtimeregistry').register(child, { purpose: `runtime:${ID}`, label: 'ZCode app-server', policy: { onOwnerExit: 'stop' } });
  const pending = new Map(); const listeners = [];
  let id = 0; let buf = ''; let stderr = ''; let closed = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d; let k;
    while ((k = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.id != null && j.method) { child.stdin.write(`${JSON.stringify({ id: j.id, error: { code: -32601, message: 'not supported by Noema' } })}\n`); continue; }
      if (j.id != null && pending.has(j.id)) { const p = pending.get(j.id); pending.delete(j.id); if (j.error) { const e = new Error(j.error.message || 'ZCode error'); e.code = j.error.code; p.reject(e); } else p.resolve(j.result); continue; }
      if (j.method) for (const l of listeners) l(j);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  child.on('close', () => { closed = true; for (const p of pending.values()) p.reject(new Error(`ZCode runtime exited${stderr ? `: ${require('../redact').text(stderr).trim().split('\n').pop()}` : ''}`)); pending.clear(); });
  const close = () => { if (closed) return; closed = true; if (recordId) require('../runtimeregistry').stop(recordId); else { try { child.kill(); } catch { /* gone */ } } };
  if (signal) signal.addEventListener('abort', close, { once: true });
  function request(method, params, { timeoutMs = 60000 } = {}) {
    if (closed) return Promise.reject(new Error('ZCode runtime is closed'));
    const n = ++id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(n); reject(new Error(`${method} timed out`)); }, timeoutMs);
      pending.set(n, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      child.stdin.write(`${JSON.stringify({ id: n, method, params })}\n`);
    });
  }
  return { request, close, on: (f) => listeners.push(f), pid: child.pid, recordId };
}

function workspace(cwd) { const p = path.resolve(cwd || process.cwd()).replace(/\\/g, '/'); return { workspacePath: p, workspaceKey: p }; }

/** ZCode's recorded plan-entry status (non-secret cache written by ZCode). Only whitelisted fields. */
function planStatus() {
  // ZCODE_DATA_BASE_DIR is ZCode's own override for where ~/.zcode lives (tests point it at a fixture).
  const f = path.join(process.env.ZCODE_DATA_BASE_DIR || os.homedir(), '.zcode', 'v2', 'coding-plan-cache.json');
  let j = null;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  const items = (j && j.entryStatus && j.entryStatus.items) || {};
  const pick = (k) => (items[k] ? { status: String(items[k].status || ''), reason: items[k].reason ? String(items[k].reason) : null } : null);
  return {
    recordedAt: j && j.entryStatus && Number.isFinite(j.entryStatus.updatedAt) ? j.entryStatus.updatedAt : null,
    startPlan: pick('builtin:zai-start-plan'),
    codingPlan: pick('builtin:zai-coding-plan'),
    bigmodelStartPlan: pick('builtin:bigmodel-start-plan'),
    bigmodelCodingPlan: pick('builtin:bigmodel-coding-plan'),
    basis: 'as ZCode last recorded it (its plan-status cache); balance and expiry are not exposed by ZCode\'s runtime protocol',
    models: planModels(),
  };
}

/**
 * WHICH MODELS EACH ACCOUNT PLAN INCLUDES — from the provider configuration ZCode
 * itself synced (~/.zcode/v2/runtime/provider/<platform>/<version>/endpoint-*
 * /zcode-builtin.json, highest revision). A public model catalogue, not a
 * credential; read only. What a plan INCLUDES is not what this account may USE:
 * the entitlement is ZCode's, behind its own sign-in.
 */
function planModels() {
  const root = path.join(process.env.ZCODE_DATA_BASE_DIR || os.homedir(), '.zcode', 'v2', 'runtime', 'provider');
  let best = null;
  try {
    for (const plat of fs.readdirSync(root)) {
      for (const ver of fs.readdirSync(path.join(root, plat))) {
        let eps = [];
        try { eps = fs.readdirSync(path.join(root, plat, ver)).filter((d) => d.startsWith('endpoint-')); } catch { continue; }
        for (const ep of eps) {
          const f = path.join(root, plat, ver, ep, 'zcode-builtin.json');
          try {
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            const at = fs.statSync(f).mtimeMs;
            if (!best || (j.revision || 0) > best.revision || ((j.revision || 0) === best.revision && at > best.at)) best = { revision: j.revision || 0, at, j };
          } catch { /* not a config */ }
        }
      }
    }
  } catch { return null; }
  if (!best) return null;
  const rules = (best.j.config && best.j.config.modelConfigRules && best.j.config.modelConfigRules.builtinProviderModelRules) || [];
  const by = {};
  for (const r of rules) if (r && r.providerId && r.modelId && !(r.config && r.config.enabled === false)) (by[r.providerId] = by[r.providerId] || []).push(r.modelId);
  return { revision: best.revision, startPlan: by['account:zai-start-plan'] || [], codingPlan: by['account:zai-individual-coding-plan'] || [], bigmodelStartPlan: by['account:bigmodel-start-plan'] || [], plans: by };
}

const REASON = {
  coding_plan_not_entitled: 'not claimed on this account',
  coding_plan_not_connected: 'not connected',
  coding_plan_not_authenticated: 'not signed in',
};
function reasonText(r) { return REASON[r] || (r ? r.replace(/_/g, ' ') : null); }

async function telemetry(app, { prev = null, cwd = null } = {}) {
  const i = install(app);
  if (!i) return { ok: false, why: 'not installed' };
  const ws = workspace(cwd || path.join(os.tmpdir()));
  let srv;
  try { srv = openServer(app, { cwd: ws.workspacePath }); } catch (e) { return { ok: false, why: e.message }; }
  try {
    const stats = await srv.request('usage/stats', { range: '30d' }, { timeoutMs: 60000 }).catch((e) => ({ error: e.message }));
    const sessions = await srv.request('session/list', { limit: 20 }, { timeoutMs: 30000 }).catch(() => null);
    const created = await srv.request('session/create', { workspace: ws, persistence: 'deferred', mode: 'plan' }, { timeoutMs: 60000 }).catch((e) => ({ error: e.message }));
    let models = [];
    if (created && created.settings && created.settings.model && Array.isArray(created.settings.model.available)) {
      models = created.settings.model.available.map((m) => ({
        id: `${ID}/${m.ref.providerId}/${m.ref.modelId}`, providerId: m.ref.providerId, modelId: m.ref.modelId,
        label: `${m.label} · ZCode (${m.providerLabel || 'configured provider'})`, providerLabel: m.providerLabel || null,
        contextLength: m.contextWindow || null, vision: Boolean(m.properties && m.properties.inputFormat && m.properties.inputFormat.supportsImage),
        roles: ['CHAT', 'BOT'], entitlement: { kind: 'configured', label: `configured in ZCode (${m.providerLabel || m.ref.providerId})` },
      }));
      if (created.session && created.session.sessionId) await srv.request('session/close', { sessionId: created.session.sessionId }, { timeoutMs: 15000 }).catch(() => null);
    }
    const s = stats && !stats.error ? stats : null;
    return {
      ok: Boolean(s), at: Date.now(), why: s ? null : (stats && stats.error) || 'usage/stats gave no answer',
      models,
      usage: s ? { range: s.range, summary: s.summary, models: s.models || [], basis: 'reported by the ZCode runtime (usage/stats)' } : null,
      sessions: sessions && Array.isArray(sessions.sessions) ? { count: sessions.sessions.length } : null,
      plan: planStatus(),
      lastRun: prev && prev.lastRun ? prev.lastRun : null,
    };
  } finally { srv.close(); }
}

const START_PLAN_WHY = 'ZCode serves Start Plan models only inside the ZCode app — its desktop host supplies the sign-in for each request. Noema does not take that role (it would need ZCode\'s OAuth tokens).';
function execution(app, tele) {
  if (!install(app)) return { chat: { ok: false, why: 'not installed' }, agent: { ok: false, why: 'not installed' }, startPlan: { ok: false, why: 'not installed' } };
  const listed = tele && Array.isArray(tele.models) ? tele.models.length : 0;
  const plan = { ok: false, why: START_PLAN_WHY };
  return {
    chat: listed ? { ok: true, how: 'workspace/generateText through the ZCode runtime' } : { ok: false, why: 'the ZCode runtime lists no model it can serve by itself' },
    agent: { ok: false, why: 'Agent work through ZCode is not wired in Noema yet (its session/send protocol is available; not verified)' },
    startPlan: plan,
  };
}

function toZcodeMessages(messages) {
  return messages.map((m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    if (m.role === 'tool') return { role: 'tool', content, toolCallId: String(m.tool_call_id || 'call'), toolName: String(m.name || 'tool') };
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) return { role: 'assistant', content, toolCalls: m.tool_calls.map((c) => ({ id: String(c.id), name: String(c.name), input: typeof c.arguments === 'string' ? safe(c.arguments) : (c.arguments || {}) })) };
    return { role: m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user', content };
  }).filter((m) => m.role !== 'tool' || m.toolCallId);
}
function safe(s) { try { return JSON.parse(s); } catch { return {}; } }

/** ONE MODEL CALL through the ZCode runtime (workspace/generateText) — tools included. */
async function* chat(pc, messages, opts = {}) {
  const rest = String(pc.model || '').replace(/^zcode\//, '');
  const cut = rest.indexOf('/');
  const selection = { providerId: rest.slice(0, cut), modelId: rest.slice(cut + 1) };
  // AN ACCOUNT PLAN (Start Plan, Coding Plan) is served only inside the ZCode app — refused before ZCode is even started.
  if (/^(account:|builtin:)|start-plan|coding-plan/i.test(selection.providerId)) throw new Error(START_PLAN_WHY);
  const ws = workspace(opts.cwd || process.cwd());
  const srv = openServer(opts.app || null, { cwd: ws.workspacePath, signal: opts.signal });
  try {
    const params = { workspace: ws, selection, messages: toZcodeMessages(messages), querySource: 'lain', ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}) };
    if (opts.tools && opts.tools.length) params.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters || { type: 'object' } }));
    const r = await srv.request('workspace/generateText', params, { timeoutMs: 10 * 60000 });
    if (r.text) yield { type: 'text', chunk: r.text };
    if (Array.isArray(r.toolCalls) && r.toolCalls.length) yield { type: 'tool_calls', calls: r.toolCalls.map((c) => ({ id: c.id, name: c.name, input: c.input || {} })) };
    yield { type: 'finish', reason: r.toolCalls && r.toolCalls.length ? 'tool_use' : 'stop', raw: r.finishReason || null };
    const u = r.usage || {};
    yield { type: 'usage', inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, cacheReadTokens: u.cacheReadTokens || 0, cacheCreationTokens: u.cacheWriteTokens || 0, cacheReported: u.cacheReadTokens != null, reasoningTokens: u.reasoningTokens, runtime: { id: ID, model: `${selection.providerId}/${selection.modelId}` } };
  } finally { srv.close(); }
}

module.exports = {
  id: ID, label: 'ZCode', provider: 'zai', kind: 'runtime', icon: 'zcode',
  source: 'ZCode Runtime', authentication: 'ZCode keeps its own Z.ai sign-in',
  install: { docs: 'https://docs.z.ai' },
  binary, installInfo: install, discover, telemetry, execution, chat, openServer, planStatus, planModels, reasonText, START_PLAN_WHY, toZcodeMessages, workspace,
};
