'use strict';

/**
 * LAIN HOOKS — the person's own commands at fixed points of a session, run OUTSIDE the model's context (Phase CAP).
 *
 *   SessionStart       a session begins (or is resumed)              may add context (bounded)
 *   UserPromptSubmit   before a prompt reaches a model               may BLOCK it, or add context (bounded)
 *   PreToolUse         before a tool runs                            may DENY it, or make it ASK
 *   PostToolUse        after a tool ran                              observes
 *   PermissionRequest  before LAIN asks the person to approve        may DENY; may APPROVE an external-action ask
 *   Checkpoint         a checkpoint was taken                        observes
 *   Compact            the conversation was compacted                observes
 *   Stop               a turn ended                                  observes
 *
 * WHERE THEY COME FROM
 *   user     <home>/hooks.json                                        the person's own; always active
 *   project  <project>/.lain/hooks.json                               ACTIVE ONLY WITH CONSENT, recorded OUTSIDE the
 *            repository (cfg.hookConsent[<project>] = sha256 of the file). An edited file needs consent again: a
 *            repository cannot make LAIN run a command by changing a file.
 *   Shape: { "hooks": [ { "event": "PreToolUse", "match": "run_bash|edit_file", "command": "…", "timeout": 10 } ] }
 *
 * A HOOK IS A PROCESS: the event as JSON on stdin (tool inputs redacted), LAIN_HOOK_EVENT in its environment, the
 * project as its working directory. It answers with exit code 2 (= deny, stderr is the reason) or JSON on stdout:
 * { "decision": "allow" | "deny" | "ask" | "block", "reason": "…", "context": "…" }. Silence is "no opinion".
 *
 * WHAT A HOOK CAN NEVER DO — LAIN's mandatory invariants are not configuration:
 *   - "allow" never overrides a refusal. It only answers a question LAIN would otherwise put to the person (an
 *     external action's approval); a gate refusal, read-only mode, PLAN mode, a credential or system path, a
 *     sensitive LAIN path or an update-trust check stand whatever a hook says.
 *   - a filesystem trust question (a path outside the project) can be DENIED by a hook, never approved.
 *   - a failing, slow or crashing hook is reported and IGNORED (fail-open for observation, never fail-to-allow):
 *     it cannot turn a deny into an allow by crashing, and it cannot stall a session past its timeout.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Checkpoint', 'Compact', 'Stop']);
const DECIDES = new Set(['UserPromptSubmit', 'PreToolUse', 'PermissionRequest']);
const CONTEXT = new Set(['SessionStart', 'UserPromptSubmit']);
const DEFAULT_TIMEOUT_S = 10;
const MAX_TIMEOUT_S = 60;
const CONTEXT_LIMIT = 2000;
const MAX_HOOKS = 50;

function home() { return require('./home').resolve(); }
function userFile() { return path.join(home(), 'hooks.json'); }
function projectFile(root) { return root ? require('./projectmeta').file(root, 'hooks.json') : null; }
function hashOf(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }

function parse(text, source) {
  if (text == null) return { hooks: [], problems: [] };
  let j;
  try { j = JSON.parse(text); } catch (e) { return { hooks: [], problems: [`${source}: not JSON (${e.message})`] }; }
  const list = Array.isArray(j) ? j : Array.isArray(j && j.hooks) ? j.hooks : [];
  const hooks = [];
  const problems = [];
  for (const [i, h] of list.slice(0, MAX_HOOKS).entries()) {
    const event = EVENTS.find((e) => e.toLowerCase() === String(h && h.event || '').toLowerCase());
    if (!event) { problems.push(`${source} #${i + 1}: unknown event "${h && h.event}" (one of ${EVENTS.join(', ')})`); continue; }
    const command = String((h && h.command) || '').trim();
    if (!command) { problems.push(`${source} #${i + 1}: no command`); continue; }
    let match = null;
    if (h.match) { try { match = new RegExp(String(h.match)); } catch { problems.push(`${source} #${i + 1}: match is not a valid pattern`); continue; } }
    hooks.push({ event, command, match, matchText: h.match ? String(h.match) : '', timeout: Math.min(MAX_TIMEOUT_S, Math.max(1, Number(h.timeout) || DEFAULT_TIMEOUT_S)), source, index: i });
  }
  return { hooks, problems };
}

function cfgOf(app) { const r = (app && app._sibling) || app; return (r && r.cfg) || {}; }
function projectOf(app) {
  try { const p = require('./sessionviews').project(app && app.session); return p && p.attached && !p.missing ? p.root : (app && app.session && app.session.cwd) || null; } catch { return (app && app.session && app.session.cwd) || null; }
}

/** Consent for a project's hooks file, recorded in the person's config (never in the repository). */
function consent(app, root, { revoke = false } = {}) {
  const c = cfgOf(app);
  const f = projectFile(root);
  const text = f ? readText(f) : null;
  if (!text) return { ok: false, why: 'this project has no hooks file' };
  if (!c.hookConsent || typeof c.hookConsent !== 'object') c.hookConsent = {};
  const key = path.resolve(root).toLowerCase();
  if (revoke) delete c.hookConsent[key]; else c.hookConsent[key] = { sha256: hashOf(text), at: new Date().toISOString() };
  try { require('./config').save(c); } catch { /* in memory */ }
  return { ok: true, consented: !revoke };
}

/** Every hook that would run here: user hooks, and project hooks only with current consent. */
function load(app) {
  const u = parse(readText(userFile()), 'user');
  const root = projectOf(app);
  const pf = projectFile(root);
  const ptext = pf ? readText(pf) : null;
  const p = parse(ptext, 'project');
  const c = cfgOf(app).hookConsent || {};
  const rec = root ? c[path.resolve(root).toLowerCase()] : null;
  const consented = Boolean(ptext && rec && rec.sha256 === hashOf(ptext));
  return {
    hooks: [...u.hooks, ...(consented ? p.hooks : [])],
    problems: [...u.problems, ...p.problems],
    project: { root, file: pf, present: ptext != null, consented, changed: Boolean(ptext && rec && !consented), count: p.hooks.length },
    user: { file: userFile(), count: u.hooks.length },
  };
}

function redactInput(v) { try { return JSON.parse(require('./redact').text(JSON.stringify(v == null ? null : v)).slice(0, 8000)); } catch { return null; } }

function runOne(h, payload, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = ''; let err = ''; let done = false;
    let child;
    try {
      child = spawn(h.command, { shell: true, cwd: cwd && fs.existsSync(cwd) ? cwd : undefined, windowsHide: true, env: { ...process.env, LAIN_HOOK_EVENT: h.event } });
    } catch (e) { resolve({ ok: false, why: e.message, ms: 0 }); return; }
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ ...r, ms: Date.now() - started }); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false, why: `timed out after ${h.timeout}s` }); }, h.timeout * 1000);
    child.stdout.on('data', (d) => { if (out.length < 64 * 1024) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 16 * 1024) err += d; });
    child.on('error', (e) => finish({ ok: false, why: e.message }));
    child.on('close', (code) => {
      if (code === 2) { finish({ ok: true, decision: 'deny', reason: err.trim().slice(0, 400) || 'denied by a hook' }); return; }
      if (code !== 0) { finish({ ok: false, why: `exit ${code}${err.trim() ? `: ${err.trim().slice(0, 200)}` : ''}` }); return; }
      let j = null;
      const t = out.trim();
      if (t.startsWith('{')) { try { j = JSON.parse(t); } catch { j = null; } }
      finish({ ok: true, decision: j && j.decision ? String(j.decision).toLowerCase() : null, reason: j && j.reason ? String(j.reason).slice(0, 400) : '', context: j && j.context ? String(j.context) : (!j && t ? t : '') });
    });
    try { child.stdin.end(JSON.stringify(payload)); } catch { /* it reads nothing */ }
  });
}

/**
 * FIRE AN EVENT. Returns the combined verdict: { decision: null|'deny'|'ask'|'allow'|'block', reason, context, ran }.
 * Deny/block beats ask beats allow — the most restrictive hook wins. Context only for SessionStart/UserPromptSubmit.
 */
async function fire(app, event, data = {}, { match = '' } = {}) {
  if (!EVENTS.includes(event) || process.env.LAIN_NO_HOOKS === '1') return { decision: null, reason: '', context: '', ran: 0 };
  let set;
  try { set = load(app); } catch { return { decision: null, reason: '', context: '', ran: 0 }; }
  const hooks = set.hooks.filter((h) => h.event === event && (!h.match || h.match.test(String(match || ''))));
  if (!hooks.length) return { decision: null, reason: '', context: '', ran: 0 };
  const payload = { event, session: app && app.session ? app.session.id : null, cwd: projectOf(app), ...redactInput(data) };
  const results = await Promise.all(hooks.map((h) => runOne(h, payload, projectOf(app))));
  const rank = { block: 3, deny: 3, ask: 2, allow: 1 };
  let decision = null; let reason = ''; const contexts = [];
  results.forEach((r, i) => {
    try { app && app.events && app.events.emit && app.events.emit(require('./events').EVENT.HOOK_RAN, { hook: `${hooks[i].source}#${hooks[i].index + 1}`, point: event, ok: r.ok, error: r.ok ? '' : r.why, ms: r.ms }); } catch { /* reported below */ }
    if (!r.ok) { note(app, `hook ${hooks[i].source}#${hooks[i].index + 1} (${event}) ${r.why} — ignored`); return; }
    if (DECIDES.has(event) && r.decision && rank[r.decision] && (!decision || rank[r.decision] > rank[decision])) { decision = r.decision === 'block' ? 'deny' : r.decision; reason = r.reason || reason; }
    if (CONTEXT.has(event) && r.context) contexts.push(r.context);
  });
  const context = contexts.join('\n').slice(0, CONTEXT_LIMIT);
  return { decision, reason, context, ran: hooks.length };
}

function note(app, text) { try { require('./ui/operation').say(app, text.slice(0, 160)); } catch { /* nowhere to say it */ } }

/** Rows for the Harness page and `/hooks`. */
function rows(app) {
  const s = load(app);
  return {
    hooks: s.hooks.map((h) => ({ event: h.event, match: h.matchText, command: h.command, timeout: h.timeout, source: h.source })),
    problems: s.problems, project: s.project, user: s.user, events: EVENTS,
  };
}

module.exports = { EVENTS, load, fire, consent, rows, parse, userFile, projectFile };
