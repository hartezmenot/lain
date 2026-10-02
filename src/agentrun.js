'use strict';

/**
 * THE `Agent` TOOL (Simplify S2; S6 adds type files, background and parallel runs). A helper is a fresh session in
 * the same project: its context is the system prompt, LAIN.md and the prompt it was given — never the parent's
 * conversation. It runs the ordinary loop with its type's tools and returns its final message. Agents do not start
 * agents.
 */

const TYPES = Object.freeze({
  explore: { readOnly: true, does: 'reads and searches; never edits or runs commands' },
  general: { readOnly: false, does: 'can read, edit and run commands' },
});

async function run(input = {}, ctx = {}) {
  const app = ctx.app;
  const parent = ctx.session || (app && app.session);
  if (!app || !parent) return { output: 'Agent needs a LAIN session', isError: true };
  if (parent._agentType) return { output: 'an agent cannot start another agent — do the work here, or report back', isError: true, denied: true };
  const type = TYPES[input.type] ? input.type : 'general';
  const prompt = String(input.prompt || '').trim();
  if (!prompt) return { output: 'Agent needs a prompt', isError: true };
  const { Session } = require('./session');
  const child = new Session({ cwd: parent.cwd });
  child._agentType = type;
  child.execMode = require('./execmode').of(parent);   // the parent's permission mode
  child._agentParent = parent.id;
  const job = app.jobs && typeof app.jobs.create === 'function' ? app.jobs.create({ request: `${type} · ${String(input.description || prompt).slice(0, 80)}`, primary: false, session: child, kind: 'subagent' }) : null;
  if (job) { job.parentSessionId = parent.id; job.state = 'RUNNING'; job.startedAt = Date.now(); app.jobs.changed(); }
  let record = null;
  try {
    const { runTurn } = require('./turn');
    const opts = require('./jobrunner').turnOptions(app, { session: child, signal: ctx.signal, from: 'agent' });
    for await (const ev of runTurn(child, prompt, opts)) {
      if (ev && ev.type === 'tool_start' && job) { job.detail = String(ev.name).slice(0, 80); app.jobs.changed(); }
      if (ev && ev.type === 'done') record = ev.record;
    }
  } catch (e) {
    if (job) job._finish('FAILED', { error: e.message });
    return { output: `the ${type} agent failed: ${e.message}`, isError: true };
  } finally {
    try { child.save(); } catch { /* the transcript is a convenience */ }
  }
  const last = record && record.narration && record.narration.length ? record.narration[record.narration.length - 1].text : String((record && record.text) || '').trim();
  const ended = record && record.stopReason && record.stopReason !== 'end' ? ` (ended: ${record.stopReason})` : '';
  if (job) job._finish(ended ? 'FAILED' : 'SUCCEEDED', { result: record });
  return { output: `${last || '(the agent said nothing)'}${ended}`, meta: { agent: type, session: child.id, toolCalls: (record && record.toolCalls) || 0 } };
}

module.exports = { run, TYPES };
