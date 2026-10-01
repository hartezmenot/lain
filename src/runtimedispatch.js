'use strict';

/**
 * A CODING TURN HANDED TO A RUNTIME THAT DOES AGENT WORK ITSELF.
 *
 * When the Coding Agent is a runtime model (Claude Code, OpenCode), the turn is
 * not run by LAIN's tool loop: the runtime works in the project folder with its
 * OWN tools, under its OWN sign-in, and LAIN streams what it does. This is the
 * third source of the one event stream app.js consumes (chatdispatch.js is the
 * second): `text`, `notice`, `provider_failure`, `done`, and `turnclose.close`
 * at the end so the turn leaves the same record every turn leaves.
 *
 * A LOCAL MODEL IS NOT THIS. A verified local model is an Agent inside LAIN's
 * own loop, with LAIN's tools and gates; only a runtime that acts for itself
 * comes through here.
 *
 * The request is one modelrequest (transport 'runtime'): identity, session,
 * task, cancellation — and the receipt the runtime reported for its work.
 */

const { newRecord } = require('./turnrecord');
const turnclose = require('./turnclose');

const AGENT_RUNTIMES = Object.freeze({ 'claude-code': () => require('./drivers/claudecode'), opencode: () => require('./drivers/opencoderun') });

/** The Coding selection, when it is a runtime model that does agent work. */
function target(app) {
  const sel = require('./modelinventory').codingSelection(app);
  if (!sel.modelId) return null;
  const row = require('./runtimeconnections').rowFor(app, sel.modelId, sel.connectionId || null);
  if (!row || !AGENT_RUNTIMES[row.runtime]) return null;
  if (!(row.roles || []).includes('AGENT')) return null;
  // THE LANE'S FAMILY AND EFFORT (Phase 8.3) — the effort is already one the model declares (sessionintel).
  let lane = null;
  try { lane = require('./sessionintel').lane(app, app.session, 'coding'); } catch { lane = null; }
  return { modelId: sel.modelId, runtime: row.runtime, label: row.label || sel.modelId, connectionId: row.connectionId, instanceId: (/^runtime:[\w-]+:(.+)$/.exec(String(row.connectionId || '')) || [])[1] || null, effort: (lane && lane.effort) || null, family: (lane && lane.family) || null };
}

/** Should this turn go to a runtime agent? Pure; no side effects. */
function routes(app, verdict) {
  if (!app || !app.session) return { yes: false, why: 'no session' };
  if (app.session.thread === 'chat') return { yes: false, why: 'the Chat view is the BOT\'s' };
  const t = target(app);
  if (!t) return { yes: false, why: 'the Coding Agent is not a runtime agent' };
  return { yes: true, why: '', target: t, verdict: verdict || null };
}

async function* run(app, text, verdict, { from = null, typed = false, signal = null } = {}) {
  const session = app.session;
  const t = target(app);
  const record = newRecord(session.id, text, t ? t.modelId : '');
  record.from = from || null;
  record.typed = Boolean(typed);
  record.lane = 'coding';
  record.runtime = t ? t.runtime : null;
  session.messages.push({ role: 'user', content: String(text), ts: new Date().toISOString() });
  if (!t) {
    record.stopReason = 'provider';
    yield { type: 'notice', level: 'warn', message: 'The Coding Agent is no longer a runtime agent — choose it again in the gear.' };
    turnclose.close(session, session.lifecycle || null, record);
    yield { type: 'done', record };
    return;
  }
  const adapter = AGENT_RUNTIMES[t.runtime]();
  record.steps = 1;
  const mr = require('./modelrequest');
  const opened = mr.open({
    turn: record.turnId, step: 1, reason: 'step', transport: mr.TRANSPORT.RUNTIME, model: t.modelId, connection: t.connectionId, provider: t.runtime,
    project: session.cwd, role: 'agent', sessionId: session.id, taskId: session.task ? session.task.id : null, signal, app,
  });
  if (!opened.ok) { record.stopReason = 'aborted'; turnclose.close(session, session.lifecycle || null, record); yield { type: 'done', record }; return; }
  if (opened.env.rec) { opened.env.rec.protocol = 'runtime'; opened.env.rec.runtime = t.runtime; opened.env.rec.family = t.family; opened.env.rec.logicalModel = t.modelId; opened.env.rec.effort = t.effort; }
  yield { type: 'notice', level: 'info', message: `${adapter.label} is working on this in ${session.cwd} with its own tools.` };
  let out = ''; let receipt = null; let tools = 0;
  try {
    for await (const ev of adapter.agent(app, { prompt: String(text), model: t.modelId, effort: t.effort, cwd: session.cwd, signal, instanceId: t.instanceId })) {
      if (!ev) continue;
      if (ev.type === 'text') { out += ev.chunk; yield { type: 'text', chunk: ev.chunk }; continue; }
      // THE RUNTIME'S OWN TOOLS, as facts every surface reads (sessionjournal.js) — a real WebSearch is shown as one.
      if (ev.type === 'runtime_tool') { try { const target = ev.input ? String(ev.input.query || ev.input.url || ev.input.file_path || ev.input.path || ev.input.pattern || ev.input.command || '').split('\n')[0].slice(0, 160) : ''; require('./sessionjournal').note(app, { type: 'tool.start', id: ev.id || null, name: ev.name, target, runtime: t.runtime }); } catch { /* a record */ } }
      if (ev.type === 'runtime_tool_result') { try { require('./sessionjournal').note(app, { type: 'tool.end', id: ev.id || null, name: '', ok: !ev.isError, runtime: t.runtime }); } catch { /* a record */ } continue; }
      if (ev.type === 'runtime_tool') { tools++; yield { type: 'notice', level: 'info', message: `${adapter.label} · ${ev.name}${ev.input && (ev.input.file_path || ev.input.path || ev.input.command) ? ` ${String(ev.input.file_path || ev.input.path || ev.input.command).slice(0, 120)}` : ''}` }; continue; }
      if (ev.type === 'usage') receipt = ev;
    }
    mr.close(opened.env, { ok: true, usage: receipt ? { ...receipt, toolCalls: tools } : null });
    record.usage.requests += 1;
    if (receipt) { record.usage.inputTokens += receipt.inputTokens || 0; record.usage.outputTokens += receipt.outputTokens || 0; }
    record.text = out;
    record.stopReason = 'end';
    session.messages.push({ role: 'assistant', content: out, ts: new Date().toISOString(), provenance: { runtime: t.runtime, model: t.modelId } });
  } catch (e) {
    mr.close(opened.env, { ok: false, status: e.status || 0, failure: e.message, usage: receipt });
    if (e.cancelled || (signal && signal.aborted)) {
      record.stopReason = 'aborted';
      yield { type: 'notice', level: 'info', message: `${adapter.label} was stopped.` };
    } else {
      record.stopReason = 'provider';
      record.errors.push({ kind: 'RUNTIME', message: e.message });
      record.providerFailure = { provider: t.runtime, connectionId: t.connectionId, kind: 'RUNTIME', message: e.message };
      yield { type: 'provider_failure', provider: adapter.label, connectionId: t.connectionId, kind: 'RUNTIME', message: e.message, skipped: false, hint: '' };
    }
  }
  turnclose.close(session, session.lifecycle || null, record);
  yield { type: 'done', record };
}

module.exports = { routes, run, target, AGENT_RUNTIMES };
