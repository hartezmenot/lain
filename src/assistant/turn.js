'use strict';

/**
 * THE ASSISTANT'S TURN — a Core turn with no model. When intent.js recognises a
 * sentence (a reminder, a schedule, a watch, a question Core can answer from
 * its own state), this is the turn: it performs it, says what it did, and
 * closes the record like every other turn. Anything else returns null here and
 * the ordinary route (chat / runtime / geometry / LAIN's turn) takes it.
 *
 * Plugged into app.submit's one routing line as a plan with its own runner —
 * the same door geometryjob.js and selectionjob.js use.
 */

function routes(app, text, from) {
  const session = app && app.session;
  if (!session || typeof text !== 'string') return null;
  if (String(process.env.LAIN_ASSISTANT || '').toLowerCase() === 'off') return null;
  let m = null;
  try { m = require('./intent').match(app, text, { from }); } catch { m = null; }
  return m ? { yes: true, plan: { run: (a, t, verdict, o) => run(a, t, m, o) } } : null;
}

async function* run(app, text, perform, { from = null, typed = false } = {}) {
  const session = app.session;
  const record = require('../turnrecord').newRecord(session.id, text, null);
  record.from = from || null;
  record.typed = Boolean(typed);
  record.lane = 'core';
  record.owner = 'deterministic:assistant';
  session.messages.push({ role: 'user', content: String(text), ts: new Date().toISOString() });
  let r;
  try { r = await perform(); } catch (e) { r = { handled: true, text: `I could not do that: ${e.message}` }; }
  const reply = String(r.text || '');
  record.text = reply;
  record.narration.push({ step: 0, text: reply, at: Date.now() });
  record.stopReason = 'end';
  record.assistant = r.task ? { taskId: r.task.id, type: r.task.type } : { answered: true };
  session.messages.push({ role: 'assistant', content: reply, ts: new Date().toISOString() });
  try {
    require('../dispatch').job(session, { worker: 'CORE', role: 'assistant', contract: 'deterministic', mode: 'DETERMINISTIC', consumed: true, why: r.task ? 'an assistant task was created in Core' : 'answered from Core state; no model was asked', deterministicSufficient: true });
  } catch { /* telemetry only */ }
  yield { type: 'text', chunk: reply };
  require('../turnclose').close(session, session.lifecycle || null, record);
  yield { type: 'done', record };
}

module.exports = { routes, run };
