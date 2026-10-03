'use strict';

/** TELLING SOMEBODY SOMETHING FINISHED, WHEN THEY ARE NOT LOOKING. */

const path = require('path');

/** The endings worth interrupting somebody for, and the sentence for each. */
function sentenceFor(app, record) {
  const project = path.basename((app.session && app.session.cwd) || '') || 'LAIN';
  const life = app.session && app.session.lifecycle;
  if (record && record.stopReason === 'no-progress') return `${project} — blocked: no progress after a wake-up`;

  // WAITING ON THE PERSON is the most useful of all: nothing will happen until
  // they come back, and they are the only one who can know that.
  if (life && life.state === 'NEEDS_USER') return `${project} — waiting for you`;

  // A VERDICT THE VERIFICATION REACHED. Read, never re-derived: a second opinion
  // about whether something passed is the one thing this program must not have.
  const v = app.session && app.session.verification;
  if (v && v.verdict === 'PASSED') return `${project} — verification passed`;
  if (v && v.verdict === 'FAILED') return `${project} — verification failed`;

  if (record && record.providerFailure) return `${project} — the turn did not finish`;
  if (life && life.state === 'DONE') return `${project} — done`;
  return null;
}

/** A TURN ENDED. Say so, if it is worth saying. */
function turnEnded(app, record) {
  try {
    if (!app || !app.session) return { sent: false, why: 'no session' };
    const text = sentenceFor(app, record);
    if (!text) return { sent: false, why: 'nothing worth interrupting for' };
    // THE PERSON'S OWN PREFERENCE (Settings → Notifications). Absent means on.
    const kind = kindOf(text);
    const prefs = (app.cfg && app.cfg.notifications) || {};
    if (prefs[kind] === false) return { sent: false, why: `${kind} notifications are off`, text };
    attention(app, attentionKind(app, record), text);
    const r = require('./harnessapp/ipc').toHost(`notify:${text}`);
    return { sent: Boolean(r.ok), why: r.why || '', text };
  } catch (e) {
    return { sent: false, why: (e && e.message) || String(e) };
  }
}

/** Which preference governs a sentence: needsInput, errors or completion. */
function kindOf(text) {
  if (/waiting for you$/.test(text)) return 'needsInput';
  if (/failed$|did not finish$/.test(text)) return 'errors';
  return 'completion';
}

/** THE MOMENTS THAT GENUINELY NEED THE PERSON, for remote surfaces (§39). */
const ATTENTION = new Set(['BLOCKED', 'BACKGROUND_COMPLETE', 'TASK_COMPLETE', 'FAILED']);

function attentionKind(app, record) {
  if (record && record.stopReason === 'aborted') return null;           // the person stopped it; they know
  if (record && record.providerFailure) return 'FAILED';
  // A TURN THAT DID NOT END NATURALLY IS NOT A FINISHED TASK: a length cut, a refusal, a step limit, no progress.
  if (record && record.stopReason && record.stopReason !== 'end') return 'BLOCKED';
  if (record && require('./wakeup').statesBlocker(record.text)) return 'BLOCKED';
  const v = app.session && app.session.verification;
  if (v && v.verdict === 'FAILED') return 'FAILED';
  const life = app.session && app.session.lifecycle;
  if (life && life.lastCommand && life.lastCommand.ok === false) return 'FAILED';
  // TASK_COMPLETE only once the final smoke settled (finalsmoke.js); RUNNING
  // reports itself as BACKGROUND_COMPLETE when it rejoins.
  const st = require('./finalsmoke').state(life, app.session && app.session.cwd);
  if (st === 'FAILED') return 'FAILED';
  if (st === 'MISSING') return 'BLOCKED';
  if (st === 'RUNNING') return null;
  return 'TASK_COMPLETE';
}

function attention(app, kind, text, meta = null) {
  if (!ATTENTION.has(kind)) return false;
  try {
    const fsx = require('fs');
    const dir = path.join(require('./config').configDir(), 'attention');
    fsx.mkdirSync(dir, { recursive: true });
    const project = path.basename((app && app.session && app.session.cwd) || '') || 'LAIN';
    const row = { kind, text: String(text || '').slice(0, 500), project, sessionId: (app && app.session && app.session.id) || '', meta, at: Date.now() };
    const file = path.join(dir, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
    fsx.writeFileSync(file, JSON.stringify(row));
    return true;
  } catch { return false; }
}

module.exports = { turnEnded, sentenceFor, kindOf, attention, attentionKind, ATTENTION };
