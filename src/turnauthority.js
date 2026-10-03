'use strict';

/**
 * A TURN STARTED, AND HOW IT ENDED — recorded where the session lives (2026-10-02).
 *
 *   turnguard.js       the judgement: how it ended, and whether the next sentence needs a briefing
 *   sessionjournal.js  the record every other surface reads: the window (live), another process, the phone
 *   sessionstatus.js   the rail's word, told at once
 *
 * This used to tell the Rust Guardian, which kept a second copy of the same turn state and owned the pid that proved
 * a turn was lost. The session lease (sessionlease.js) now answers "is anybody still running this", and the
 * judgement lives with the session it is about. Nothing here waits on another process.
 *
 * THE ONE JUDGEMENT IS UNCHANGED: A CANCELLATION IS NOT A FAILURE. Ctrl+C is the person's own decision, so the next
 * sentence after it goes through bare; every other bad ending earns the next sentence a briefing.
 */

const guard = require('./turnguard');
const journal = require('./sessionjournal');

/** A turn is starting, and THIS process is answerable for it. */
function begin(app) {
  const session = app && app.session;
  if (!session || !session.id) return;
  // THE ONE START STAMP a session with no terminal clock reads (sessionstatus.js).
  app._turnStartedAt = Date.now();
  app._turnId = `t${((session.turns || []).length) + 1}`;
  require('./sessionstatus').touch(app);
  let pc = {};
  try { pc = require('./provider').resolve({ ...app.cfg, _evidence: app.connectionEvidence }); } catch { pc = {}; }
  guard.begin(app, { model: pc.model || '' });
  journal.note(app, { type: 'turn.begin', model: pc.model || '', provider: pc.provider || '', connectionId: pc.connectionId || '' });
}

/** The turn record's ending, in turnrecord.js's words. `record` null is a loop that THREW: a failure, never a completion. */
function outcomeOf(record) {
  if (!record) return 'provider';
  const stop = String(record.stopReason || 'end');
  if (stop === 'end') return 'completed';
  if (stop === 'rate-limited') return 'rate_limited';
  return stop;
}

function end(app, record) {
  const session = app && app.session;
  if (!session || !session.id) return;
  guard.end(app, record);
  const f = record && record.providerFailure;
  journal.note(app, {
    type: 'turn.end',
    outcome: outcomeOf(record),
    stopReason: (record && record.stopReason) || (record ? 'end' : 'provider'),
    kind: (f && f.kind) || '',
    reason: (f && f.message) || '',
    usage: record && record.usage ? { input: record.usage.inputTokens || 0, output: record.usage.outputTokens || 0, cacheRead: record.usage.cacheReadTokens || 0 } : null,
    toolCalls: (record && record.toolCalls) || 0,
  });
  // THE RAIL LEARNS NOW, not on the next poll.
  require('./sessionstatus').touch(app, { ended: true });
}

/** Kept for callers that named the project for the Guardian; the journal carries the session itself. */
function identify() {}

/**
 * HOW FAR THROUGH, WHEN SOMETHING HAS COUNTED — AND NOT OTHERWISE. The plan is the only real counter; with no plan,
 * the activity alone (never an invented percentage). Recorded only when it changes.
 */
function reportProgress(app, phase) {
  const session = app && app.session;
  if (!session || !session.id) return;
  const plan = session.plan;
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const done = steps.length ? plan.completed.length : 0;
  const total = steps.length;
  const activity = String((phase && (phase.detail || phase.word || phase.phase)) || '');
  const key = `${done}/${total}|${activity}`;
  if (app._progressKey === key) return;
  app._progressKey = key;
  // THE CLI'S WORDS for the Harness live row (S5.2): `Waiting for GLM 5.3` while a request has no byte yet.
  let word = '';
  try { if (phase && phase.live) word = require('./ui/status').liveState({ phase, phaseSince: Date.now() }).word; } catch { word = ''; }
  journal.note(app, { type: 'phase', phase: (phase && phase.phase) || null, activity, ...(word ? { word } : {}), ...(total ? { done, total } : {}) });
}

module.exports = { begin, end, outcomeOf, identify, reportProgress };
