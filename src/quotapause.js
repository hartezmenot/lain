'use strict';

/**
 * QUOTA PAUSE, AND A CONTINUE THAT RE-CHECKS NOW.
 *
 *   RUNNING ──(provider limit)──► QUOTA_PAUSED ──▶ Continue──► re-check ──► running again
 *
 * The task is not failed and nothing is rebuilt: the plan, the phase, what
 * landed / remains / failed, the findings, the approved deltas and the evidence
 * all stay in the session exactly as they were (they are persisted with it).
 *
 * ▶ CONTINUE MEANS "RE-CHECK NOW AND CONTINUE", never "wait until the old
 * predicted reset". The prediction goes stale for ordinary reasons — a banked
 * reset, the person switched account, the provider reset early, or it simply
 * accepts new work again — so Continue clears LAIN's own rate-limit hold on
 * the route, refreshes the account's reported state where LAIN can read it,
 * and resumes the same task. If the provider still refuses, the task is paused
 * again with the provider's NEW answer; nothing waits on the old timer.
 */

const wb = require('./workbench');

function pause(app, record) {
  const s = app.session;
  const f = (record && record.providerFailure) || {};
  const q = {
    state: 'QUOTA_PAUSED', at: Date.now(),
    provider: f.provider || null, connectionId: f.connectionId || null, model: f.model || (app.cfg && app.cfg.model) || null,
    predictedReset: f.resumeAt || (f.retryAfterMs ? Date.now() + f.retryAfterMs : null),
    why: String(f.message || f.kind || 'rate limited').slice(0, 300), attempts: ((wb.of(s).quota && wb.of(s).quota.attempts) || 0),
  };
  wb.of(s).quota = q;
  try { s.save(); } catch { /* in memory */ }
  return q;
}

function status(app) { return wb.of(app.session).quota || { state: 'RUNNING' }; }

/** Refresh what LAIN can read about the route's account, without a model call. */
async function recheck(app, q) {
  const notes = [];
  try { if (q.connectionId) { app.availability.retry(q.connectionId); notes.push(`cleared LAIN's hold on ${q.connectionId}`); } } catch { /* no availability */ }
  const model = String(q.model || '');
  try {
    if (/^claude-code\//.test(model)) { await require('./runtimeadapters').report(app, 'claude-code', { refresh: true }); notes.push('refreshed Claude Code'); }
    const ai = require('./accountinstances');
    const acct = ai.list(app).find((v) => q.connectionId && (q.connectionId === v.id || String(q.connectionId).startsWith(`${v.id}:`)));
    if (acct) { await ai.refresh(app, acct.id); notes.push(`refreshed ${acct.display_name}`); }
  } catch (e) { notes.push(`refresh: ${e.message}`); }
  return notes;
}

/**
 * ▶ CONTINUE. Re-check now, then resume the same task on the Coding thread.
 * `submitFn` is for tests; the default submits through the one door.
 */
async function resume(app, { submitFn = null } = {}) {
  const s = app.session;
  const w = wb.of(s);
  const q = w.quota;
  if (!q || q.state !== 'QUOTA_PAUSED') return { ok: false, why: 'the task is not paused on a provider limit' };
  if (app.abort && !app.abort.signal.aborted) return { ok: false, why: 'a turn is already running' };
  const notes = await recheck(app, q);
  q.attempts = (q.attempts || 0) + 1;
  q.lastCheck = { at: Date.now(), notes };
  w.quota = { ...q, state: 'RESUMING' };
  const sv = require('./sessionviews');
  sv.views(s).active = 'coding';
  s.thread = 'coding';
  const text = require('./ratelimit').RESUME_PROMPT;
  const run = submitFn || ((t) => app.submit(t, { sameTask: true, from: 'rate-limit-resume' }));
  Promise.resolve(run(text)).then(() => {
    // STILL REFUSED: submitclose paused it again with the provider's new answer.
    if (wb.of(s).quota && wb.of(s).quota.state === 'RESUMING') wb.of(s).quota = null;
  }).catch(() => { if (wb.of(s).quota && wb.of(s).quota.state === 'RESUMING') wb.of(s).quota = { ...q, state: 'QUOTA_PAUSED' }; });
  return { ok: true, resumed: true, notes, predictedReset: q.predictedReset, ignoredPrediction: Boolean(q.predictedReset && q.predictedReset > Date.now()) };
}

module.exports = { pause, status, resume, recheck };
