'use strict';

/** WHAT THE USER TYPED WHILE IT WAS WORKING. */

/** The two promises a steer can carry. */
const MODE = Object.freeze({ WAIT: 'WAIT', NOW: 'NOW' });

/** Queue a correction, and TELL THE TASK AND THE PLAN about it immediately. */
function queue(app, text, mode = MODE.WAIT) {
  const t = String(text || '').trim();
  if (!t) return false;
  app.steerQueue.push({ text: t, mode: mode === MODE.NOW ? MODE.NOW : MODE.WAIT });
  if (app.session.task) app.session.task.steer(t);
  if (app.session.plan) app.session.plan.steer(t);
  if (app.ui.enabled) app.ui.refresh();
  return true;
}

/** Promote everything waiting to NOW — the second Enter. */
function promote(app) {
  let n = 0;
  for (const s of app.steerQueue) if (s.mode !== MODE.NOW) { s.mode = MODE.NOW; n += 1; }
  if (n && app.ui.enabled) app.ui.refresh();
  return n;
}

/** Take the most recent pending steer BACK, for editing. */
function takeBack(app) {
  if (!app.steerQueue.length) return null;
  const last = app.steerQueue.pop();
  // THE TASK'S RECORD OF IT GOES TOO.
  if (app.session.task && Array.isArray(app.session.task.steers)) {
    const list = app.session.task.steers;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].text === last.text) { list.splice(i, 1); break; }
    }
  }
  if (app.ui.enabled) app.ui.refresh();
  return last.text;
}

/** Everything still waiting for the work in flight to finish. */
function waiting(app) {
  return app.steerQueue.filter((s) => s.mode !== MODE.NOW).map((s) => s.text);
}

/** The PROMOTED ones, handed to a running turn at a step boundary and removed. */
function takeNow(app) {
  const out = [];
  for (let i = app.steerQueue.length - 1; i >= 0; i--) {
    if (app.steerQueue[i].mode === MODE.NOW) out.unshift(app.steerQueue.splice(i, 1)[0].text);
  }
  return out;
}

/** Everything queued, whatever its mode, and the queue is emptied once. */
function drain(app) {
  const all = app.steerQueue.map((s) => s.text);
  app.steerQueue.length = 0;
  return all;
}

/** DELIVER the NOW steers into a running turn, between steps (moved here from turn.js). */
function deliver(session, record, opts, step) {
  const out = [];
  if (!opts || typeof opts.steer !== 'function') return out;
  for (const s of opts.steer() || []) {
    const text = String(s || '').trim();
    if (!text) continue;
    session.messages.push({ role: 'user', content: `⚑ USER STEER: ${text}`, ts: new Date().toISOString(), _steer: true });
    record.steers = (record.steers || 0) + 1;
    // THE WORDS, AND WHERE THEY LANDED — not merely how many there were.
    (record.steerTexts = record.steerTexts || []).push({ step, text });
    out.push({ type: 'notice', level: 'info', message: `⚑ USER STEER delivered to the model: ${text}` });
  }
  if (out.length) require('./inflight').persist(session, { force: true });
  return out;
}

module.exports = { MODE, queue, promote, takeBack, waiting, takeNow, drain, deliver };
