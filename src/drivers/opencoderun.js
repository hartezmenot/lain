'use strict';

/**
 * OPENCODE RUNTIME — the real `opencode` program, through its documented
 * commands. Kept apart from OpenCode Zen as an API (an API key LAIN holds is a
 * connection in MODEL › Providers; this is the RUNTIME).
 *
 *   discovery   `opencode` on PATH, `opencode --version`
 *   telemetry   `opencode models`       provider/model ids the runtime serves
 *               `opencode auth list`    which providers hold a credential
 *                                       (names and kinds — never a key)
 *               `opencode session list --format json`   its own sessions
 *   execution   `opencode run --format json -m <provider/model>`
 *                 BOT (chat)  the read-only `plan` agent
 *                 AGENT       the default agent, in the project folder
 *               then `opencode session export <id>` for the tokens and cost
 *               OpenCode itself recorded for that run
 *
 * RUNTIME-BOUND MODELS. OpenCode's free models (`opencode/*-free`,
 * `opencode/big-pickle`, `opencode-free/*`) are served only inside OpenCode.
 * LAIN reaches them by running OpenCode — never by calling the endpoint behind
 * it or by copying OpenCode's credentials.
 */

const fs = require('fs');
const path = require('path');
const cliexec = require('./cliexec');
const { flatten } = require('./runtimechat');

const ID = 'opencode';

function root(app) { return (app && app._sibling) || app; }
function settings(app) { const c = (root(app) && root(app).cfg) || {}; return (c.runtimes && c.runtimes[ID]) || {}; }
// (a PATH walk per call was ~150 stats, on every header redraw — pathlookup.js keeps the answer)
function which(name) { return require('../pathlookup').find(name, process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']); }
function binary(app) { const s = settings(app); return s.binary ? (fs.existsSync(s.binary) ? s.binary : null) : (process.env.LAIN_ISOLATED === '1' ? null : which('opencode')); }

/**
 * WHERE A MODEL'S ENTITLEMENT LIVES. A FREE model on an OpenCode provider
 * (opencode, opencode-go, opencode-free — "-free", big-pickle) is RUNTIME-BOUND:
 * served only inside OpenCode, so only an OpenCode session may use it
 * (runtimebound.js forbids every direct HTTP route to it).
 */
function entitlement(id) {
  const [prov, ...rest] = String(id).split('/');
  const name = rest.join('/');
  if (/^opencode(-go|-free)?$/.test(prov) && (prov === 'opencode-free' || /-free$/.test(name) || name === 'big-pickle')) return { kind: 'runtime-bound', label: 'Runtime-bound · free inside OpenCode' };
  if (prov === 'opencode') return { kind: 'zen', label: 'OpenCode Zen · inside OpenCode' };
  if (prov === 'opencode-go') return { kind: 'subscription', label: 'OpenCode Go subscription · inside OpenCode' };
  return { kind: 'configured', label: `configured in OpenCode (${prov})` };
}

function parseModels(lines) {
  return lines.map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w./:#@-]+$/.test(l)).slice(0, 600).map((m) => row(m));
}
function row(m, extra = {}) {
  return { id: `${ID}/${m}`, upstream: m, label: `${extra.name && extra.name !== m.split('/').slice(1).join('/') ? `${extra.name} (${m})` : m} · OpenCode`, provider: m.split('/')[0], entitlement: entitlement(m), roles: ['CHAT', 'BOT', 'AGENT'], ...extra };
}

/** `opencode auth list` lines → [{ name, kind, stored }] — names and kinds only. */
function parseAuth(lines) {
  const out = [];
  for (const l of lines) {
    const m = /^\s*[●○•*-]?\s*([A-Za-z0-9][\w .-]{0,40}?)\s{2,}(API key|OAuth|oauth|api|wellknown|env)\b\s*(\w+)?/i.exec(l);
    if (m) out.push({ name: m[1].trim(), kind: m[2], state: m[3] || null });
  }
  return out;
}

async function discover(app) {
  const bin = binary(app);
  if (!bin) return { installed: false, binary: null, version: null, why: 'opencode is not on PATH' };
  const r = await cliexec.collect(bin, ['--version'], { timeoutMs: 20000, purpose: 'runtime-probe', label: 'opencode --version' }).catch((e) => ({ ok: false, lines: [], stderr: e.message }));
  return { installed: true, binary: bin, version: r.ok ? (r.lines[0] || '').trim() : null, why: r.ok ? null : String(r.stderr || '').trim().split('\n')[0] };
}

const srv = () => require('./opencodeserver');

/**
 * TELEMETRY through the server OpenCode ships (models with their names and
 * capabilities, sessions), plus `opencode auth list` for which providers hold a
 * credential (names only). The server is started for this and stopped when idle.
 */
async function telemetry(app, { prev = null } = {}) {
  const bin = binary(app);
  if (!bin) return { ok: false, why: 'not installed' };
  let list = []; let sessions = null; let why = null;
  try {
    const s = await srv().ensure(bin);
    const dir = srv().scratchDir();
    list = (await srv().models(s, dir)).map((m) => row(`${m.providerID}/${m.id}`, { name: m.name, tools: m.tools, vision: (m.input || []).includes('image') }));
    const all = await srv().sessions(s, dir).catch(() => []);
    sessions = { count: all.length, recent: all.slice(0, 10) };
  } catch (e) { why = e.message; }
  const auth = await cliexec.collect(bin, ['auth', 'list'], { timeoutMs: 45000, purpose: 'runtime-probe', label: 'opencode auth list' }).catch((e) => ({ ok: false, lines: [], stderr: e.message }));
  return {
    ok: list.length > 0, at: Date.now(), why: list.length ? null : (why || 'OpenCode listed no models'),
    via: 'opencode serve (OpenCode v2 API)',
    models: list,
    providers: auth.ok ? parseAuth(auth.lines) : null,
    sessions,
    counts: { runtimeBound: list.filter((m) => m.entitlement.kind === 'runtime-bound').length, total: list.length },
    verified: (prev && prev.verified) || {},
    lastRun: prev && prev.lastRun ? prev.lastRun : null,
  };
}

function execution(app, tele) {
  if (!binary(app)) return { chat: { ok: false, why: 'not installed' }, agent: { ok: false, why: 'not installed' } };
  if (tele && tele.ok === false && !(tele.models || []).length) return { chat: { ok: false, why: tele.why || 'OpenCode lists no models' }, agent: { ok: false, why: tele.why || 'OpenCode lists no models' } };
  return { chat: { ok: true, how: 'an OpenCode session through opencode serve (side effects denied)' }, agent: { ok: true, how: 'an OpenCode session (build agent) in the project folder, through opencode serve' } };
}

/** THE BRIDGE: one prompt through a real OpenCode session on LAIN's own `opencode serve`. */
async function* runStream(app, { prompt, model, mode = 'chat', cwd = null, signal = null } = {}) {
  const bin = binary(app);
  if (!bin) { const e = new Error('OpenCode is not installed'); e.status = 503; throw e; }
  const upstream = String(model || '').replace(/^opencode\//, '');
  const s = await srv().ensure(bin);
  let ok = false;
  try {
    for await (const ev of srv().prompt(s, { text: prompt, model: upstream, mode, cwd: cwd || srv().scratchDir(), signal, title: mode === 'chat' ? 'LAIN · BOT' : 'LAIN · Agent', agentShell: Boolean(settings(app).agentShell) })) {
      if (ev.type === 'usage') ok = true;
      yield ev;
    }
  } finally { remember(app, { ok, mode }); }
}

function remember(app, r) {
  try { const ra = require('../runtimeadapters'); const prev = ra.cachedTelemetry(ID) || {}; ra.saveTelemetry(ID, { ...prev, lastRun: { at: Date.now(), ok: r.ok, mode: r.mode } }); } catch { /* measurement only */ }
}

async function* chat(pc, messages, opts = {}) {
  const { system, prompt } = flatten(messages, { max: 24000 });
  const full = system ? `${system.slice(0, 6000)}\n\n---\n\n${prompt}` : prompt;
  yield* runStream(opts.app || null, { prompt: full, model: pc.model, mode: 'chat', cwd: null, signal: opts.signal });
}

async function* agent(app, { prompt, model, cwd, signal }) {
  yield* runStream(app, { prompt, model, mode: 'agent', cwd, signal });
}

/** OpenCode's own sessions (read through its API; never its storage). */
async function listSessions(app, { directory = null } = {}) {
  const bin = binary(app);
  if (!bin) return [];
  const s = await srv().ensure(bin);
  return srv().sessions(s, directory || srv().scratchDir());
}
async function readSession(app, sessionId, { directory = null } = {}) {
  const bin = binary(app);
  if (!bin) return [];
  const s = await srv().ensure(bin);
  return srv().messages(s, sessionId, directory || srv().scratchDir());
}

module.exports = {
  id: ID, label: 'OpenCode', provider: 'opencode', kind: 'runtime', icon: 'opencode',
  source: 'OpenCode Runtime', authentication: 'OpenCode keeps its own provider credentials',
  install: { docs: 'https://opencode.ai/docs' },
  binary, discover, telemetry, execution, chat, agent, runStream, entitlement, parseModels, parseAuth, listSessions, readSession, row,
};
