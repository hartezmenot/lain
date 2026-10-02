'use strict';

/**
 * WHAT A TASK DOES WHEN IT RUNS — Core capabilities, not a BOT-only brain.
 *
 *   notify           the task's own text                                 NO_MODEL
 *   limits_summary   every reported window, credits and plans (Core data)  NO_MODEL
 *   usage_summary    consumption by project / source (usage receipts)      NO_MODEL
 *   runtime_status   which runtimes are operational, what local model runs NO_MODEL
 *   run_tests        the project's own test command, in the project        NO_MODEL (a capability)
 *   bot_prompt       a model answers the instruction                       BOT_MODEL / LOCAL_CHEAP / RESEARCH
 *   agent_task       Coding Agent work — not run unattended: it becomes a
 *                    follow-up the person starts (a person present)        CODING_AGENT
 *
 * A MODEL-BACKED TASK GETS A SMALL CONTEXT. Never the full BOT workspace
 * prompt (~19k tokens): an assistant instruction, the task's instruction and —
 * only when the task asks for it — deterministic data (limits, usage) that Core
 * already has. Nothing else (no tool schemas, no project, no IDE state).
 */

const fs = require('fs');
const path = require('path');

function capabilitiesFor(t) {
  const k = t.action ? t.action.kind : `watch:${t.watch && t.watch.kind}`;
  return ({ notify: ['notify'], limits_summary: ['read_usage'], usage_summary: ['read_usage'], runtime_status: ['read_usage'], run_tests: ['read_project', 'run_tests'], bot_prompt: ['model'], agent_task: ['edit_code'] })[k] || ['read_usage'];
}

function pct(v) { return v == null ? '?' : `${Math.round(v)}%`; }
function inT(ms) { if (!ms) return ''; const d = ms - Date.now(); if (d <= 0) return ' (reset due)'; const h = Math.floor(d / 3600e3); const m = Math.round((d % 3600e3) / 60000); return ` · resets in ${h ? `${h}h ` : ''}${m}m`; }

/** Every limit LAIN holds, as reported — never averaged, nothing invented. */
function limitsText(app) {
  const g = require('../harnessapp/usageroutes').grouped(app);
  const lines = [];
  for (const a of g.active) lines.push(`${a.name}: ${a.windows.map((w) => `${w.label} ${w.usedPercent == null ? '?' : `${pct(100 - w.usedPercent)} remaining`}${inT(w.resetsAt)}`).join(' · ')} (${a.reportedBy || 'provider-reported'})`);
  for (const p of g.plans) lines.push(`${p.name} (${p.model}): ${p.state}${p.reason ? ` — ${p.reason}` : ''} · balance not reported by ZCode`);
  if (g.local.length) lines.push(`${g.local.length} local model(s) — no provider quota`);
  if (!lines.length) lines.push('No account has reported a limit yet.');
  return `Model limits\n${lines.join('\n')}`;
}

function usageText(app, args = {}) {
  const u = require('../usage');
  const from = args.range === '7d' ? Date.now() - 7 * 864e5 : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const rows = u.read({ from });
  const by = args.by || 'project';
  const groups = u.aggregate(rows, by, {}).slice(0, 8);
  const name = (k) => (by === 'project' ? require('./intent').projectName(app, k) : k);
  const lines = groups.map((g) => `${name(g.key)}: ${g.requests} request(s) · ${(g.input + g.output).toLocaleString()} tokens${g.estimated && g.estimated.rows ? ` (+${(g.estimated.input + g.estimated.output).toLocaleString()} estimated)` : ''}`);
  return `Usage ${args.range === '7d' ? 'in the last 7 days' : 'today'} by ${by}\n${lines.length ? lines.join('\n') : 'No requests.'}`;
}

async function runtimeText(app) {
  const ra = require('../runtimeadapters');
  const reps = await ra.reports(app).catch(() => []);
  const lines = reps.filter((r) => r.discovery && r.discovery.ok).map((r) => `${r.label}: ${r.state}`);
  const servers = require('../local/llamacpp').status();
  lines.push(servers.length ? `llama.cpp running: ${servers.map((s) => `${s.model} (pid ${s.pid})`).join(', ')}` : 'No local model is loaded.');
  return `Runtimes\n${lines.join('\n')}`;
}

/** The project's own test command — package.json "test", else none (said so). */
function testCommand(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.scripts && pkg.scripts.test) return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['test'], label: 'npm test' };
  } catch { /* no package.json */ }
  return null;
}

/** RUN TESTS: owned process, bounded time, failures extracted from the output (no model). */
function runTests(t, { timeoutMs = 20 * 60 * 1000 } = {}) {
  const root = t.projectRoot;
  if (!root || !fs.existsSync(root)) return Promise.resolve({ ok: false, text: `The project folder is not available: ${root || '(none)'}` });
  const c = (t.action.args && t.action.args.command) ? { cmd: t.action.args.command, args: t.action.args.argv || [], label: [t.action.args.command, ...(t.action.args.argv || [])].join(' ') } : testCommand(root);
  if (!c) return Promise.resolve({ ok: false, text: `No test command found in ${path.basename(root)} (package.json has no "test" script).` });
  return new Promise((resolve) => {
    const child = require('../runtimeregistry').spawnRegistered(c.cmd, c.args, { cwd: root, shell: process.platform === 'win32' && /\.cmd$/i.test(c.cmd), stdio: ['ignore', 'pipe', 'pipe'] }, { purpose: 'assistant:run_tests', label: `tests · ${path.basename(root)}`, policy: { onOwnerExit: 'stop' } });
    let out = '';
    const take = (d) => { out = (out + d).slice(-400000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = require('../redact').text(out);
      const fails = text.split(/\r?\n/).filter((l) => /(^|\s)(✗|✖|FAIL(ED)?\b|not ok\b|AssertionError|Error:)/.test(l)).slice(0, 12);
      const summary = (text.match(/(\d+)\s+passed,\s+(\d+)\s+failed/) || [])[0] || (text.match(/Tests?:\s+[^\n]+/) || [])[0] || '';
      resolve({ ok: code === 0, code, text: code === 0 ? `${c.label} in ${path.basename(root)} passed${summary ? ` — ${summary}` : ''}.` : `${c.label} in ${path.basename(root)} FAILED (exit ${code})${summary ? ` — ${summary}` : ''}${fails.length ? `\n${fails.map((l) => `• ${l.trim().slice(0, 200)}`).join('\n')}` : ''}`, failures: fails.length });
    });
  });
}

/** WHICH MODEL a model-backed task uses — resolved at run time, never ChatGPT Chat (CHAT ONLY). */
function modelFor(app, policy) {
  const r = (app && app._sibling) || app;
  if (policy === 'LOCAL_CHEAP') {
    const local = require('../runtimeconnections').connections(r).filter((c) => c.locality === 'local').flatMap((c) => c.models.filter((m) => (m.roles || []).includes('BOT')));
    return local.length ? local[0].id : null;
  }
  let m = null;
  try { m = require('../sessionintel').resolve(r, r.session).bot.model; } catch { m = null; }
  return m || (r.cfg && r.cfg.model) || null;
}

/** THE MINIMAL ASSISTANT CONTEXT — measured in usage as origin Scheduled/Recurring. */
async function botPrompt(app, t) {
  const r = (app && app._sibling) || app;
  // THE ASSISTANT ROLE'S DEFAULT (Model Dashboard › Defaults, Phase 8.3), else the Chat lane — as an exact route,
  // with the effort the model declares; a local-cheap policy keeps its own local model.
  const route = t.modelPolicy === 'LOCAL_CHEAP' ? null : require('../fabric/roles').routeOrChat(r, 'assistant');
  const model = route ? route.model : modelFor(app, t.modelPolicy);
  if (!model) return { ok: false, text: 'No model is available for this task’s policy.' };
  const cfg = { ...(r.cfg || {}), connections: (r.cfg && r.cfg.connections) || {}, model, connection: route ? route.connection : null, account: route ? route.account : undefined, family: route ? route.family : undefined, effort: route ? route.effort || undefined : r.cfg && r.cfg.effort };
  const pc = require('../provider').resolve(cfg);
  const hint = require('../provider').credentialHint(pc, cfg);
  if (hint) return { ok: false, text: hint };
  const data = [];
  const inc = (t.action.args && t.action.args.include) || [];
  if (inc.includes('limits')) data.push(limitsText(app));
  if (inc.includes('usage')) data.push(usageText(app, { range: 'today', by: 'project' }));
  const messages = [
    { role: 'system', content: 'You are LAIN’s personal assistant, running a scheduled task. Answer briefly and concretely. Use only the data given; if something is not in it, say it is not known.' },
    { role: 'user', content: `${t.instruction || t.title}${data.length ? `\n\nData from LAIN (deterministic):\n${data.join('\n\n')}` : ''}` },
  ];
  let text = '';
  for await (const ev of require('../provider').chat(pc, messages, { role: 'bot', origin: t.type === 'recurring' ? 'recurring' : 'scheduled', trace: { reason: 'assistant-task' }, app: pc.adapterCfg ? { cfg: pc.adapterCfg } : null })) if (ev.type === 'text') text += ev.chunk;
  return { ok: Boolean(text.trim()), text: text.trim() || 'The model returned no text.', model };
}

/** RUN ONE ACTION. Returns { ok, text, model? }. */
async function run(app, t) {
  const k = t.action.kind;
  if (k === 'notify') return { ok: true, text: t.instruction || t.title };
  if (k === 'limits_summary') return { ok: true, text: limitsText(app) };
  if (k === 'usage_summary') return { ok: true, text: usageText(app, t.action.args || {}) };
  if (k === 'runtime_status') return { ok: true, text: await runtimeText(app) };
  if (k === 'run_tests') return runTests(t);
  if (k === 'bot_prompt') return botPrompt(app, t);
  if (k === 'agent_task') return { ok: true, text: `Agent task ready to start: ${t.instruction || t.title}. Coding Agent work does not run unattended — open LAIN to start it.`, followUp: true };
  return { ok: false, text: `unknown action ${k}` };
}

module.exports = { run, capabilitiesFor, limitsText, usageText, runtimeText, testCommand, modelFor };
