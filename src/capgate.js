'use strict';

/** WHERE SKILLS AND HOOKS MEET A SESSION (Phase CAP) — one call from app.handle and one subscription per App, so the input path carries two lines and… */

const attached = new WeakSet();
const appOf = new WeakMap();   // session → App, so a checkpoint or compaction (which know only the session) finds it

function hooks() { return require('./userhooks'); }

/** A single-line `/<name> …` that names a skill (and not a command). */
function skillCall(app, s) {
  const t = String(s || '').trim();
  if (!t.startsWith('/') || t.includes('\n')) return null;
  const name = t.slice(1).split(/\s+/)[0];
  if (!name || name.includes('/')) return null;
  const k = require('./skills').find(app, name);
  return k ? { name: k.name, rest: t.slice(1 + name.length).trim() } : null;
}

/** BEFORE A PROMPT REACHES A MODEL. */
async function prompt(app, s, { isPaste = false, asText = false } = {}) {
  attach(app);
  let text = s;
  if (app && app.session) appOf.set(app.session, app);
  if (!isPaste && !asText) {
    const call = skillCall(app, s);
    if (call) {
      const x = require('./skills').expand(app, call.name, call.rest);
      if (!x.ok) { say(app, x.why); return { handled: true }; }
      text = x.scout ? `${x.text}\n\nThis skill runs as a scout: call use_skill {"name":"${call.name}","request":${JSON.stringify(call.rest || '')}} and report its result.` : x.text;
    }
  }
  const session = app && app.session;
  const ctx = [];
  if (session && !session._hookSessionStarted) {
    session._hookSessionStarted = true;
    const h = await hooks().fire(app, 'SessionStart', { resumed: Boolean(session.turns && session.turns.length) });
    if (h.context) ctx.push(h.context);
  }
  const h = await hooks().fire(app, 'UserPromptSubmit', { prompt: String(text).slice(0, 8000) });
  if (h.decision === 'deny') { say(app, `A hook held this prompt: ${h.reason || 'no reason given'}`); return { handled: true }; }
  if (h.context) ctx.push(h.context);
  return { text: ctx.length ? `${text}\n\n[context from your hooks]\n${ctx.join('\n').slice(0, 2000)}` : text };
}

function say(app, text) {
  try { if (app && app.render && app.render.notice) { app.render.notice('warn', text); return; } } catch { /* fall through */ }
  try { require('./ui/operation').say(app, text); } catch { /* nowhere to say it */ }
}

/** Once per App: the observational events, fired after the fact and never awaited by the work. */
function attach(app) {
  if (!app || attached.has(app)) return;
  attached.add(app);
  const { EVENT, busOf } = require('./events');
  try {
    busOf(app).on((ev) => {
      if (ev && (ev.type === EVENT.TASK_COMPLETED || ev.type === EVENT.TASK_FAILED)) {
        hooks().fire(app, 'Stop', { stopReason: ev.stopReason || 'end', toolCalls: ev.toolCalls || 0, failed: ev.type === EVENT.TASK_FAILED }).catch(() => {});
      }
    });
  } catch { /* no bus — no Stop hook */ }
  try {
    require('./taskcheckpoint').onCommit((session, cp) => {
      const owner = appOf.get(session);
      if (owner === app) hooks().fire(app, 'Checkpoint', { reason: (cp && cp.reason) || '', step: (cp && cp.step) || null }).catch(() => {});
    });
  } catch { /* no checkpoints */ }
}

/** A compaction succeeded on `session` (contextauthority.js). */
function compacted(session, info = {}) {
  const app = session && appOf.get(session);
  if (app) hooks().fire(app, 'Compact', { reason: info.reason || '', before: info.before || 0, after: info.after || 0 }).catch(() => {});
}

module.exports = { prompt, attach, compacted, skillCall };
