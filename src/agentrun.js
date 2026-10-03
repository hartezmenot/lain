'use strict';

/** THE `Agent` TOOL (Simplify S6). */

const MAX_RESULT = 6000;

function finalMessage(record) {
  const last = record && record.narration && record.narration.length ? record.narration[record.narration.length - 1].text : String((record && record.text) || '').trim();
  return String(last || '').slice(0, MAX_RESULT);
}

/** One agent, to its end. Returns { ok, text, child, record }. */
async function runOne(app, parent, spec, prompt, { description = '', signal = null, job = null } = {}) {
  const { Session } = require('./session');
  const child = new Session({ cwd: parent.cwd });
  child._agentType = spec.name;
  child._agentSpec = spec;
  child.execMode = require('./execmode').of(parent);   // the parent's permission mode
  child._agentParent = parent.id;
  child.title = `${spec.name} · ${String(description || prompt).slice(0, 60)}`;
  let record = null;
  try {
    const { runTurn } = require('./turn');
    const opts = require('./jobrunner').turnOptions(app, { session: child, signal, from: 'agent' });
    for await (const ev of runTurn(child, prompt, opts)) {
      if (!ev) continue;
      if (job && ev.type === 'tool_start') { job.detail = String(ev.name).slice(0, 80); app.jobs.changed(); }
      if (job && (ev.type === 'text' || ev.type === 'reasoning')) { job.chars = (job.chars || 0) + String(ev.chunk || '').length; }
      if (ev.type === 'done') record = ev.record;
    }
  } catch (e) {
    return { ok: false, text: `the ${spec.name} agent failed: ${e.message}`, child, record };
  } finally {
    try { child.save(); } catch { /* the transcript is a convenience */ }
  }
  const ended = record && record.stopReason && record.stopReason !== 'end' ? ` (ended: ${record.stopReason})` : '';
  return { ok: !ended, text: `${finalMessage(record) || '(the agent said nothing)'}${ended}`, child, record };
}

async function run(input = {}, ctx = {}) {
  const app = ctx.app;
  const parent = ctx.session || (app && app.session);
  if (!app || !parent) return { output: 'Agent needs a LAIN session', isError: true };
  if (parent._agentType) return { output: 'an agent cannot start another agent — do the work here, or report back', isError: true, denied: true };
  const types = require('./agenttypes').all(parent.cwd);
  const want = String(input.type || 'general').toLowerCase();
  const spec = types[want];
  if (!spec) return { output: `no agent type "${want}" — available: ${Object.keys(types).join(', ')}`, isError: true };
  const prompt = String(input.prompt || '').trim();
  if (!prompt) return { output: 'Agent needs a prompt', isError: true };
  const description = String(input.description || prompt).replace(/\s+/g, ' ').slice(0, 80);
  const job = app.jobs && typeof app.jobs.create === 'function' ? app.jobs.create({ request: `${spec.name} · ${description}`, primary: false, session: null, kind: 'subagent' }) : null;
  if (job) { job.parentSessionId = parent.id; job.agentType = spec.name; job.agentLabel = description; job.state = 'RUNNING'; job.startedAt = Date.now(); job.chars = 0; app.jobs.changed(); }
  const settle = (r) => {
    if (job) { job.sessionId = r.child && r.child.id; job._finish(r.ok ? 'SUCCEEDED' : 'FAILED', { result: r.record }); }
    return r;
  };
  if (input.background === true) {
    // THE RESULT REJOINS LIKE A JOB'S (bgdetach.rejoin): seen by the model with the next request.
    runOne(app, parent, spec, prompt, { description, job }).then(settle).then((r) => {
      try { require('./bgdetach').rejoin(app, parent, { jobId: job ? job.id : 'agent', kind: 'agent', label: `${spec.name} · ${description}`, ok: r.ok, summary: r.text, tail: '' }); } catch { /* /agents still has it */ }
    }).catch(() => {});
    return { output: `agent ${job ? job.id : ''} (${spec.name}) started in the background: ${description}. Its final message arrives in this conversation when it finishes; carry on.`, meta: { agent: spec.name, background: true, job: job ? job.id : null } };
  }
  const r = settle(await runOne(app, parent, spec, prompt, { description, signal: ctx.signal, job }));
  return { output: r.text, isError: !r.ok, meta: { agent: spec.name, session: r.child && r.child.id, toolCalls: (r.record && r.record.toolCalls) || 0 } };
}

const TYPES = require('./agenttypes').BUILT_IN;

module.exports = { run, runOne, TYPES, finalMessage };
