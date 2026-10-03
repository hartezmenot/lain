'use strict';

/** THE TURN PATH (Simplify S1, the only one since S10): the model runs the loop; the lifecycle only describes it. */

/** The input is the person's message: no classification. One task record per session, for the surfaces that show it. */
function identify(app, text) {
  const s = app.session;
  const first = !s.task;
  if (first) {
    const { Task } = require('./task');
    s.task = new Task(text);
  }
  if (!s.lifecycle) {
    const { Lifecycle } = require('./lifecycle');
    s.lifecycle = new Lifecycle(s.task.objective);
  }
  s.lifecycle.state = 'ACTIVE';
  s.lifecycle.reason = '';
  return { kind: first ? 'new' : 'continue', sameTask: !first, mode: null, modeReason: '', reason: 'simple', taskClass: null, aside: false };
}

/** The turn is over: the lifecycle only describes it, and the fact footer goes on the turn. */
function settle(app, record = null) {
  const life = app.session && app.session.lifecycle;
  if (life) { life.state = 'IDLE'; life.reason = ''; }
  if (record) { try { require('./factfooter').attach(app, record); } catch { /* the footer is only shown */ } }
}

/** THE TOOL SET IS FIXED FOR A SESSION; enabling Computer Control or the Preview mid-session grows it once, at a turn boundary. */
function toolSetNote(session, schemas) {
  if (!session) return null;
  const names = schemas.map((s) => s.name);
  const prev = session._toolNames;
  session._toolNames = names;
  if (!prev) return null;
  const added = names.filter((n) => !prev.includes(n));
  const gone = prev.filter((n) => !names.includes(n));
  if (!added.length && !gone.length) return null;
  const line = `tools changed for this session: ${[...added.map((n) => `+${n}`), ...gone.map((n) => `-${n}`)].slice(0, 8).join(' ')} — the cached prefix restarts once`;
  (session.toolSetLog = session.toolSetLog || []).push({ at: Date.now(), added, gone });
  return line;
}

/** THE SELECTION (S8): `{file, range, text}` from the IDE, attached to the person's message when they have one. */
function withSelection(app, text) {
  const s = app && app.session;
  const c = s && s._ide;
  const sel = c && c.selection;
  if (!s || !s._ideTurn || !sel || !sel.text || (s._ideExclude && s._ideExclude.selection)) return text;
  if (Date.now() - c.at > require('./idecontext').FRESH_MS) return text;
  const range = sel.startLine ? ` lines="${sel.startLine}-${sel.endLine || sel.startLine}"` : '';
  return `${text}\n\n<selection file="${c.file || ''}"${range}>\n${sel.text}\n</selection>`;
}

module.exports = { identify, settle, toolSetNote, withSelection };
