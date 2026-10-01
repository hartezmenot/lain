'use strict';

/**
 * MODEL — "what intelligence can LAIN actually use?" — as one projection, and
 * the operations on local models, runtimes and legacy keys.
 *
 *   current   what CHAT, the BOT and the Coding Agent use now
 *   groups    Local · Runtimes & plans · Chat sources · Cloud APIs — each row
 *             says what it is, where it runs, which roles it may fill, and its
 *             usage or limit in the terms that source actually has (a local
 *             model has NO provider quota; a plan shows what its runtime
 *             recorded; nothing is invented)
 *   runtimes  every runtime adapter: DISCOVERY / TELEMETRY / EXECUTION apart
 *
 * Reads caches and LAIN's own registries; a refresh is always explicit.
 */

const path = require('path');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400) { return { code, body: { ok: false, why: String(why) } }; }
function root(app) { return (app && app._sibling) || app; }

const testing = new Map();   // modelId -> { startedAt }  (Agent tests in flight)
const runtimeTests = new Map();

function gb(n) { return Number.isFinite(n) ? `${(n / 1073741824).toFixed(n >= 10 * 1073741824 ? 0 : 1)} GB` : null; }
/** A window in words: what REMAINS of it (every provider reports what is used; the figure is 100 minus that). */
function pctWord(w) { return w && w.usedPercent != null ? `${w.label} ${Math.round(100 - w.usedPercent)}% remaining` : null; }

function labelOf(app, modelId) {
  if (!modelId) return null;
  const rt = require('../runtimeconnections').rowFor(app, modelId);
  if (rt) return { label: rt.label || modelId, via: rt.locality === 'local' ? (rt.runtime === 'ollama' ? 'Ollama · Local' : 'llama.cpp · Local') : `${({ 'claude-code': 'Claude Code', opencode: 'OpenCode', zcode: 'ZCode' })[rt.runtime] || rt.runtime} Runtime`, local: rt.locality === 'local', runtime: rt.runtime };
  return { label: modelId, via: 'API', local: false, runtime: null };
}

async function current(app) {
  const r = root(app);
  const intel = require('../sessionintel').resolve(app, app.session);
  const roles = require('../modelroles');
  const chatSrc = intel.chat.source;
  let chatState = null;
  if (chatSrc !== 'lain') {
    try { const s = require('../modelsource/registry').get(app, chatSrc); const st = s ? await s.status({ open: false }) : null; chatState = st ? st.state : null; } catch { chatState = null; }
  }
  return {
    chat: chatSrc === 'lain'
      ? { source: 'lain', label: (labelOf(app, intel.chat.model) || {}).label || intel.chat.model || 'no model chosen', via: (labelOf(app, intel.chat.model) || {}).via || 'API', chatOnly: false, modelId: intel.chat.model }
      : { source: chatSrc, label: roles.labelFor(chatSrc, chatSrc), sourceLabel: chatSrc === roles.CHATGPT_CHAT.source ? roles.CHATGPT_CHAT.origin : chatSrc, alias: chatSrc === roles.CHATGPT_CHAT.source ? roles.CHATGPT_CHAT.alias : null, chatOnly: true, capability: 'CHAT ONLY', state: chatState, siteModel: intel.chat.model || null },
    bot: { modelId: intel.bot.model, scope: intel.bot.scope, ...(labelOf(app, intel.bot.model) || { label: 'no model chosen', via: '' }) },
    coding: { modelId: intel.coding.model, scope: intel.coding.scope, ...(labelOf(app, intel.coding.model) || { label: 'no model chosen', via: '' }), delegated: require('../runtimedispatch').target(app) ? true : false },
    reasoning: intel.reasoning,
    project: intel.project,
    defaults: { model: (r.cfg && r.cfg.model) || null },
  };
}

/** What this machine MEASURED for a local model (usage receipts), and how big LAIN's BOT request is — so a first-reply wait is predictable, not a surprise. */
function localSpeed(modelId) {
  const u = require('../usage');
  const rows = u.read({ from: Date.now() - 30 * 864e5 });
  const mine = rows.filter((r) => r.model === modelId && r.local);
  const s = u.sum(mine, {});
  const api = rows.filter((r) => r.systemChars != null && r.role === 'bot');
  const reqTokens = api.length ? Math.round(api.reduce((a, r) => a + (r.systemChars || 0) + (r.toolSchemaChars || 0) + (r.messageChars || 0), 0) / api.length / 4) : null;
  return mine.length ? { requests: mine.length, promptTokPerSec: s.local.promptTokPerSec, tokPerSec: s.local.tokPerSec, botRequestTokens: reqTokens,
    firstReplySecs: s.local.promptTokPerSec && reqTokens ? Math.round(reqTokens / s.local.promptTokPerSec) : null } : { requests: 0, botRequestTokens: reqTokens };
}

function localRows(app, cur) {
  const rows = [];
  const llama = require('../local/llamacpp');
  const md = require('../local/modeldirs').list();
  const servers = llama.status();
  const verify = require('../localagent');
  for (const m of md.models) {
    const v = verify.history(app, m.id);
    const srv = servers.find((s) => s.model === m.id);
    const roleList = ['CHAT', 'BOT', 'AUX', ...(m.vision ? ['VISION'] : []), ...(v && !v.stale && v.result === 'verified' ? ['AGENT'] : [])];
    rows.push({
      key: m.id, kind: 'local', modelId: m.id, label: m.modelName || path.basename(m.file, '.gguf'), provider: 'llama.cpp', icon: 'llamacpp',
      via: 'llama.cpp · Local', account: path.basename(m.file), roles: roleList,
      agent: testing.has(m.id) ? 'testing…' : v ? (v.stale ? 'not verified (model or runtime changed)' : v.result) : 'not verified',
      usage: { kind: 'text', text: 'No provider quota' },
      status: srv ? { word: srv.state === 'ready' ? 'Running' : srv.state === 'starting' ? 'Starting…' : srv.state, cls: srv.state === 'ready' ? 'ok' : 'busy' } : { word: 'Ready to start', cls: '' },
      current: { bot: cur.bot.modelId === m.id, coding: cur.coding.modelId === m.id, chat: cur.chat.modelId === m.id },
      detail: {
        file: m.file, quantization: m.quantization, quantSource: m.quantSource, sizeBytes: m.sizeBytes, size: gb(m.sizeBytes), contextLength: m.contextLength,
        architecture: m.architecture, sizeLabel: m.sizeLabel, tokenizer: m.tokenizer, chatTemplate: m.chatTemplate, vision: m.vision, projector: m.projector, pairing: m.pairing,
        blockCount: m.blockCount, embeddingLength: m.embeddingLength, runtime: llama.configFor(app, m), server: srv ? { ...srv, memoryBytes: llama.processMemory(srv.pid) } : null,
        agentTest: v || null, estimate: llama.estimate(m, llama.configFor(app, m)), speed: localSpeed(m.id),
      },
    });
  }
  const oll = require('../local/ollama').cached();
  for (const m of ((oll && oll.models) || [])) {
    const v = verify.history(app, m.id);
    rows.push({
      key: m.id, kind: 'local', modelId: m.id, label: m.name, provider: 'ollama', icon: 'ollama', via: 'Ollama · Local', account: oll.endpoint,
      roles: m.embedding ? ['EMBEDDING'] : ['CHAT', 'BOT', 'AUX', ...(m.vision ? ['VISION'] : []), ...(v && !v.stale && v.result === 'verified' ? ['AGENT'] : [])],
      agent: testing.has(m.id) ? 'testing…' : v ? (v.stale ? 'not verified (model or runtime changed)' : v.result) : 'not verified',
      usage: { kind: 'text', text: 'No provider quota' },
      status: oll.running ? { word: (oll.loaded || []).some((x) => x.name === m.name) ? 'Loaded' : 'Available', cls: 'ok' } : { word: 'Ollama not running', cls: 'warn' },
      current: { bot: cur.bot.modelId === m.id, coding: cur.coding.modelId === m.id, chat: cur.chat.modelId === m.id },
      detail: { family: m.family, parameterSize: m.parameterSize, quantization: m.quantization, size: gb(m.sizeBytes), contextLength: m.contextLength, capabilities: m.capabilities, modifiedAt: m.modifiedAt, agentTest: v || null },
    });
  }
  return rows;
}

function runtimeRows(app, cur, reports) {
  const rows = [];
  const byId = Object.fromEntries(reports.map((r) => [r.id, r]));
  const ra = require('../runtimeadapters');
  // CLAUDE CODE
  const cc = byId['claude-code'];
  if (cc && cc.discovery.ok) {
    const t = cc.detail || {};
    const lim = t.limits || null;
    for (const m of (t.models || [])) {
      rows.push({
        key: m.id, kind: 'runtime', modelId: m.id, label: m.label.replace(/ · Claude Code$/, ''), provider: 'anthropic', icon: 'anthropic',
        via: 'Claude Code Runtime', account: t.identity ? `${t.identity.plan || ''} ${t.identity.email || ''}`.trim() : 'sign-in not read',
        roles: (ra.servableModels(app, 'claude-code').find((x) => x.id === m.id) || {}).roles || [],
        usage: lim && lim.windows.length ? { kind: 'windows', windows: lim.windows, text: lim.windows.map(pctWord).filter(Boolean).join(' · '), basis: lim.basis, at: lim.at } : { kind: 'text', text: 'windows appear after the first run' },
        status: { word: cc.state, cls: /Operational|Ready/.test(cc.state) ? 'ok' : 'warn' },
        current: { bot: cur.bot.modelId === m.id, coding: cur.coding.modelId === m.id },
        detail: { resolved: m.resolved, identity: t.identity || null },
      });
    }
  }
  // OPENCODE — runtime-bound free models individually; the rest summarised.
  const oc = byId.opencode;
  if (oc && oc.discovery.ok) {
    const t = oc.detail || {};
    const servable = ra.servableModels(app, 'opencode');
    const bound = (t.models || []).filter((m) => m.entitlement.kind === 'runtime-bound');
    for (const m of bound) {
      rows.push({
        key: m.id, kind: 'runtime', modelId: m.id, label: m.upstream, provider: 'opencode', icon: 'opencode', via: 'OpenCode Runtime', account: m.entitlement.label,
        roles: (servable.find((x) => x.id === m.id) || {}).roles || [], usage: { kind: 'text', text: 'free · runtime-bound' },
        status: { word: oc.state, cls: /Operational|Ready/.test(oc.state) ? 'ok' : 'warn' }, current: { bot: cur.bot.modelId === m.id, coding: cur.coding.modelId === m.id }, detail: { entitlement: m.entitlement },
      });
    }
    const others = (t.models || []).length - bound.length;
    if (others > 0) rows.push({ key: 'opencode:more', kind: 'runtime-summary', label: `${others} more OpenCode models`, provider: 'opencode', icon: 'opencode', via: 'OpenCode Runtime', account: 'OpenCode Go · Zen · configured providers', roles: ['CHAT', 'BOT', 'AGENT'], usage: { kind: 'text', text: 'as OpenCode accounts them' }, status: { word: oc.state, cls: /Operational|Ready/.test(oc.state) ? 'ok' : 'warn' }, detail: { runtime: 'opencode' } });
  }
  // NO ZCODE ROWS (2026-09-29): LAIN integrates Z.ai through its API only — a "Z.ai API" source under MODEL › API.
  // CODEX accounts (runtime only; windows as reported).
  try {
    for (const v of require('../accountinstances').list(app).filter((x) => x.driver_id === 'codex')) {
      const ws = (v.limits && v.limits.windows) || [];
      rows.push({ key: `codex:${v.id}`, kind: 'plan', label: v.display_name, provider: 'openai', icon: 'openai', via: 'Codex Runtime', account: v.identity && v.identity.email ? v.identity.email : 'not signed in', roles: [],
        usage: ws.length ? { kind: 'windows', windows: ws.map((w) => ({ label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt })), text: ws.map(pctWord).filter(Boolean).join(' · ') } : { kind: 'text', text: v.limits_error || 'not reported yet' },
        status: { word: v.runtime ? String(v.runtime.runtime_state || '').toLowerCase().replace(/_/g, ' ') : 'registered', cls: '' }, detail: { instance: v.id, execution: 'Codex subscriptions run inside Codex; Noema reads their windows and sessions — execution through Noema is not implemented' } });
    }
  } catch { /* no registry */ }
  return rows;
}

async function chatRows(app, cur) {
  const roles = require('../modelroles');
  const out = [];
  let src = [];
  try { src = await require('./accounts').sources(app); } catch { src = []; }
  for (const s of src) {
    if (s.kind !== 'WEB') continue;
    const isGpt = s.id === roles.CHATGPT_CHAT.source;
    out.push({
      key: `chat:${s.id}`, kind: 'chat', source: s.id, modelId: isGpt ? roles.CHATGPT_CHAT.alias : null,
      label: isGpt ? roles.CHATGPT_CHAT.label : s.label, provider: isGpt ? 'openai' : 'google', icon: isGpt ? 'openai' : 'google',
      via: isGpt ? roles.CHATGPT_CHAT.origin : 'gemini.google.com', account: isGpt ? `Noema alias: ${roles.CHATGPT_CHAT.alias}` : 'website session',
      roles: ['CHAT'], capabilityLabel: 'CHAT ONLY', usage: { kind: 'text', text: 'observed by Noema · no billed figures' },
      status: { word: /^(CONNECTED|READY|SIGNED_IN|AVAILABLE)$/i.test(String(s.state || '')) ? 'Connected' : 'Disconnected', cls: /^(CONNECTED|READY|SIGNED_IN|AVAILABLE)$/i.test(String(s.state || '')) ? 'ok' : '' },
      current: { chat: cur.chat.source === s.id }, detail: { state: s.state, why: s.why, siteModel: s.model || null },
    });
  }
  return out;
}

function cloudRows(app, cur) {
  const out = [];
  for (const g of require('./accounts').providers(app)) {
    for (const c of g.connections) {
      const u = c.usage && c.usage.headline ? c.usage.headline : null;
      out.push({
        key: `api:${c.id}`, kind: 'api', connectionId: c.id, label: g.label === c.id ? c.id : `${g.label}`, provider: g.provider, icon: g.provider,
        via: `API · ${c.host || c.id}`, account: c.id, roles: ['CHAT', 'BOT', 'AGENT', 'AUX'], modelCount: c.modelCount,
        usage: u ? { kind: 'percent', percent: u.percent, text: `${u.label || 'Limit'} ${Math.round(100 - u.percent)}% remaining` } : { kind: 'text', text: 'no limit reported' },
        status: { word: c.readiness === 'REQUEST_READY' ? 'Connected' : c.readiness === 'AUTHENTICATED' ? 'Configured' : c.readiness === 'CREDENTIAL_FOUND' ? 'Needs a check' : 'No credential', cls: c.readiness === 'REQUEST_READY' || c.readiness === 'AUTHENTICATED' ? 'ok' : c.readiness === 'NONE' ? 'bad' : 'warn' },
        current: { bot: false, coding: cur.coding.modelId && (c.models || []).includes(cur.coding.modelId) },
        detail: { models: c.models.slice(0, 60), catalog: c.catalog, availability: c.availability },
      });
    }
  }
  return out;
}

async function fabric(app, { refresh = false } = {}) {
  const ra = require('../runtimeadapters');
  const reports = await ra.reports(app, { refresh });
  const cur = await current(app);
  const local = localRows(app, cur);
  const runtime = runtimeRows(app, cur, reports);
  // (The website "Chat sources" group went with the retired website sources — Phase 8.1.)
  const cloud = cloudRows(app, cur);
  const md = require('../local/modeldirs').list();
  return {
    at: Date.now(), current: cur,
    groups: [
      { id: 'local', title: 'Local', rows: local, empty: 'No local models yet — add a model directory for llama.cpp, or start Ollama.' },
      { id: 'runtime', title: 'Runtimes & plans', rows: runtime, empty: 'No runtime found on this machine.' },
      { id: 'cloud', title: 'Cloud APIs', rows: cloud, empty: 'No API account yet.' },
    ],
    runtimes: reports,
    local: { dirs: md.dirs, projectors: md.projectors.map((p) => ({ file: p.file, name: p.name, projector: p.projector })), other: md.other.map((o) => ({ file: o.file, name: o.name, ok: o.ok, why: o.why || null, quantization: o.quantization || null, sizeBytes: o.sizeBytes })), servers: require('../local/llamacpp').status(), ollama: require('../local/ollama').cached() },
    legacyKeys: require('../keymigration').legacy(root(app).cfg || {}).length,
    testing: [...testing.keys()],
  };
}

const ROUTES = {
  'POST /api/fabric': async (app, body = {}) => ok(await fabric(app, { refresh: Boolean(body.refresh) })),
  'POST /api/runtimes': async (app, body = {}) => {
    const ra = require('../runtimeadapters');
    if (body.id) return ok({ report: await ra.report(app, String(body.id), { refresh: Boolean(body.refresh) }) });
    return ok({ reports: await ra.reports(app, { refresh: Boolean(body.refresh) }) });
  },
  /** A deliberate, minimal live run through a runtime ("Reply with OK") — only when the person presses Test. */
  'POST /api/runtimes/test': async (app, body = {}) => {
    const id = String(body.id || '');
    const model = String(body.model || '');
    if (!['claude-code', 'opencode'].includes(id)) return bad('this runtime has no test run');
    if (runtimeTests.has(id)) return bad('a test is already running', 409);
    runtimeTests.set(id, Date.now());
    try {
      const cfg = { ...(root(app).cfg || {}), connections: (root(app).cfg && root(app).cfg.connections) || {}, model, connection: `runtime:${id}` };
      const pc = require('../provider').resolve(cfg);
      if (pc.protocol !== 'runtime') return bad(`${model} is not a model this runtime serves now — refresh the runtime first`);
      let text = ''; let usage = null; const t0 = Date.now();
      for await (const ev of require('../provider').chat(pc, [{ role: 'user', content: 'Reply with exactly the word OK and nothing else.' }], { trace: { reason: 'runtime-test' }, role: 'machinery', app: { cfg: pc.adapterCfg } })) {
        if (ev.type === 'text') text += ev.chunk;
        if (ev.type === 'usage') usage = ev;
      }
      return ok({ id, model, text: text.trim().slice(0, 200), ms: Date.now() - t0, usage: usage ? { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, costUsd: usage.costUsd, costBasis: usage.costBasis || null } : null });
    } catch (e) { return bad(e.message, 502); } finally { runtimeTests.delete(id); }
  },
  /** DISCONNECT FROM LAIN / reconnect: LAIN stops (or resumes) offering a runtime's models. It never signs out of the runtime. */
  'POST /api/runtimes/disconnect': async (app, body = {}) => {
    const id = String(body.id || ''); const r = root(app);
    if (!require('../runtimeadapters').get(id)) return bad('unknown runtime');
    r.cfg.runtimes = { ...(r.cfg.runtimes || {}), [id]: { ...((r.cfg.runtimes || {})[id] || {}), disconnected: body.reconnect ? undefined : true } };
    try { require('../config').save(r.cfg); } catch { /* applies in memory */ }
    return ok({ id, disconnected: !body.reconnect, note: 'Noema no longer offers its models. You are still signed in to the runtime itself.' });
  },
  /** VERIFY a runtime model (chat + agent probes through the real runtime) — a deliberate click; it uses a little of that runtime's allowance. */
  'POST /api/runtimes/verify': async (app, body = {}) => {
    const id = String(body.id || ''); const model = String(body.model || '');
    if (!require('../runtimeverify').BRIDGES[id]) return bad('this runtime has no verification');
    if (runtimeTests.has(`v:${model}`)) return bad('already verifying this model', 409);
    runtimeTests.set(`v:${model}`, Date.now());
    try { return ok(await require('../runtimeverify').verify(root(app), id, model)); } finally { runtimeTests.delete(`v:${model}`); }
  },
  'POST /api/local/dirs/add': async (app, body = {}) => { const r = require('../local/modeldirs').add(String(body.path || '')); return r.ok ? ok(r) : bad(r.why); },
  'POST /api/local/dirs/remove': async (app, body = {}) => { const r = require('../local/modeldirs').remove(String(body.id || '')); return r.ok ? ok(r) : bad(r.why); },
  'POST /api/local/dirs/rescan': async (app, body = {}) => ok(require('../local/modeldirs').rescan(body.id ? String(body.id) : null)),
  'POST /api/local/pair': async (app, body = {}) => ok(require('../local/modeldirs').pair(String(body.model || ''), body.projector === undefined ? undefined : body.projector)),
  'POST /api/local/defaults': async (app, body = {}) => { const r = require('../local/modeldirs').setDefaults(String(body.file || ''), body.values || {}); return r.ok ? ok(r) : bad(r.why); },
  'POST /api/local/llama/start': async (app, body = {}) => { const r = await require('../local/llamacpp').ensure(root(app), String(body.model || '')); return r.ok ? ok(r) : bad(r.why, 409); },
  'POST /api/local/llama/stop': async (app, body = {}) => {
    const llama = require('../local/llamacpp');
    const s = llama.status().find((x) => x.model === body.model || x.key === body.key);
    if (!s) return bad('that model is not running under Noema');
    const r = llama.stop(s.key, { force: Boolean(body.force) });
    return r.ok ? ok(r) : bad(r.why, 409);
  },
  'POST /api/local/llama/restart': async (app, body = {}) => {
    const llama = require('../local/llamacpp');
    const s = llama.status().find((x) => x.model === body.model);
    if (s) { const st = llama.stop(s.key); if (!st.ok) return bad(st.why, 409); }
    const r = await llama.ensure(root(app), String(body.model || ''));
    return r.ok ? ok(r) : bad(r.why, 409);
  },
  'POST /api/local/ollama/refresh': async (app) => ok({ info: await require('../local/ollama').refresh(root(app)) }),
  'POST /api/local/agent-test': async (app, body = {}) => {
    const id = String(body.model || '');
    if (!/^(llamacpp|ollama)\//.test(id)) return bad('the Agent test is for local models');
    if (testing.has(id)) return bad('already testing this model', 409);
    testing.set(id, { startedAt: Date.now() });
    // IN THE BACKGROUND: a local model may take a minute; the view polls /api/fabric.
    require('../localagent').run(root(app), id).catch((e) => ({ ok: false, why: e.message })).finally(() => testing.delete(id));
    return ok({ started: true });
  },
  'POST /api/bot/profile': async (app) => ok({ profile: require('../botprofile').get(root(app).cfg || {}), limits: require('../botprofile').LIMITS }),
  'POST /api/bot/profile/set': async (app, body = {}) => { const r = require('../botprofile').set(root(app), body.values || {}); return r.ok ? ok(r) : bad(r.why); },
  'POST /api/security/legacy-keys': async (app) => ok({ keys: require('../keymigration').legacy(root(app).cfg || {}) }),
  'POST /api/security/migrate-keys': async (app, body = {}) => { const r = require('../keymigration').migrate(root(app), { only: body.id ? String(body.id) : null }); return ok(r); },
};

module.exports = { ROUTES, fabric, current };
