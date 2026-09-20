'use strict';

/**
 * SESSIONS AND QUESTIONS, FROM THE APPLICATION WINDOW.
 *
 * ------------------------------------------------------------------------
 * NAVIGATION IS NOT EXECUTION. This file used to say otherwise.
 *
 * Opening another conversation, or starting a new one, was refused while a turn
 * was running — "a turn is running — stop it or let it finish first". That was
 * wrong, and wrong in an instructive way: the check asked `app.abort`, which is
 * a fact about the PROCESS, in order to answer a question about a SESSION. One
 * variable was doing two jobs, so looking at session B was treated as a
 * mutation of session A's work.
 *
 * A session is now made LIVE rather than switched INTO (src/sessionpool.js).
 * The window holds a VIEW; Core holds one App per live conversation; a running
 * turn belongs to its own. Selecting, creating and closing therefore never
 * consult anything that is executing, and they cannot fail because something
 * else is busy.
 *
 * WHAT IS STILL GOVERNED is a second turn in the SAME session, and that was
 * never this file's job: `inputgate.js` admits or holds, and the steer contract
 * decides whether a sentence typed into working session lands now or after. See
 * `POST /api/turn` in routes.js.
 *
 * A NEW Cowork session is an empty session bound to Cowork through Astra's own
 * binding (`cowork/sessionstate.js`); this file decides nothing about what a
 * Cowork session may do, and creating one never waits on engineering work.
 *
 * ------------------------------------------------------------------------
 * A QUESTION ASKED DURING A TURN THE WINDOW STARTED IS ASKED IN THE WINDOW.
 *
 * `interaction.js` is the presentation seam every approval and `ask_user` goes
 * through. A turn started from the Harness runs inside a Harness PORT, so its
 * questions are projected into `/api/state` and answered with
 * `/api/ask/answer` — never silently refused for want of a terminal, and never
 * surfaced in a terminal nobody is watching. The port presents; gate.js,
 * trust.js and permissions.js still decide what the answer permits.
 */

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400) { return { code, body: { ok: false, why: String(why || 'refused') } }; }

let seq = 0;

/** The Harness interaction port for one App. Holds at most one open question. */
function portFor(app) {
  if (app._harnessPort) return app._harnessPort;
  const port = {
    ask(question, signal) {
      return new Promise((resolve) => {
        const q = question || {};
        const options = (q.options || []).map((o) => (typeof o === 'string' ? o : (o && (o.label || o.value)) || String(o)));
        const open = { id: `q${++seq}`, title: String(q.title || 'LAIN asks'), question: String(q.question || q.text || ''), options, at: Date.now(), resolve };
        app._harnessAsk = open;
        // A QUESTION IS A STATUS CHANGE: the rail says NEEDS_INPUT now.
        require('../sessionstatus').touch(app);
        const done = (value) => {
          if (app._harnessAsk === open) app._harnessAsk = null;
          resolve(value);
          require('../sessionstatus').touch(app);
        };
        open.resolve = done;
        if (signal) {
          if (signal.aborted) return done(null);
          signal.addEventListener('abort', () => done(null), { once: true });
        }
      });
    },
  };
  app._harnessPort = port;
  return port;
}

/** Run `fn` with the Harness port in scope, so its questions come to the window. */
function withPort(app, fn) {
  return require('../interaction').run(app, portFor(app), fn);
}

/** What the window shows of an open question — no resolver, no internals. */
function pendingAsk(app) {
  const q = app && app._harnessAsk;
  return q ? { id: q.id, title: q.title, question: q.question, options: q.options } : null;
}

/**
 * OPEN A SESSION AND MAKE IT THE VIEW.
 *
 * NOTHING ABOUT WHAT IS RUNNING IS CONSULTED. That is the fix. A session that
 * does not exist is a 404, which is a fact about the request; there is no
 * longer any state of the machine that can refuse this.
 */
function selectSession(app, body) {
  const id = String(body.id || '');
  if (!id) return bad('which session?');
  const pool = app.pool();
  const r = pool.open(id);
  if (!r.ok) return bad(r.why, r.code || 400);
  if (app.ui && app.ui.enabled) app.ui.refresh();
  return ok({ id: r.id, already: Boolean(r.already), running: pool.running(r.id) });
}

const ROUTES = {
  /**
   * A NEW CONVERSATION, and nothing else is disturbed.
   *
   * It does not adopt, so the terminal keeps the session it is on and a turn in
   * flight there keeps running. A Cowork session is created by the same call
   * with `lane: 'cowork'`, and specifically does NOT wait on engineering work —
   * the two lanes were sharing one lock, which is how the global guard proved
   * itself global.
   */
  'POST /api/session/new': async (app, body = {}) => {
    const lane = body.lane === 'cowork' ? 'cowork' : 'engineering';
    // ---- WHICH PROJECT, STATED — never LAIN's own folder by accident --------
    //
    // `project` names one explicitly. Otherwise an engineering session inherits
    // the project of the session being viewed ONLY when that one is attached;
    // with nothing attached it starts with NO project (an empty placeholder
    // directory) and Project Files offers Add project. `inherit: false` asks
    // for a blank one on purpose.
    const sv = require('../sessionviews');
    let cwd = null;
    let attached = false;
    if (lane === 'engineering') {
      if (body.project) {
        const chk = sv.checkRoot(body.project);
        if (!chk.ok) return bad(chk.why);
        cwd = chk.root; attached = true;
      } else if (body.inherit !== false && !app.session.cowork && sv.project(app.session).attached) {
        cwd = app.session.cwd; attached = true;
      } else {
        cwd = sv.unattachedDir();
      }
    }
    const r = app.pool().create({ lane, cwd: cwd || app.session.cwd || app.cwd });
    if (!r.ok) return bad(r.why);
    if (lane === 'engineering') {
      const v = sv.views(r.app.session);
      v.project.attached = attached;
      v.project.attachedAt = attached ? Date.now() : null;
      // THE DEFAULT CHAT MODEL (Settings → Models), applied once, to a new
      // session. It never changes an existing session's choice.
      const dc = app.cfg && app.cfg.defaultChat;
      if (dc && dc.source) {
        r.app.session.chatSource = dc.source;
        if (dc.model) r.app.session.sourceSelections = { ...(r.app.session.sourceSelections || {}), [dc.source]: dc.model };
      }
      try { r.app.session.save(); } catch { /* an unsaved empty session is still empty */ }
    }
    if (app.ui && app.ui.enabled) app.ui.refresh();
    return ok({ id: r.id, lane, project: lane === 'engineering' ? sv.project(r.app.session) : null });
  },

  /**
   * LOOK AT A CONVERSATION. Live if it already is, resumed from disk if not.
   *
   * `resume` is the name the frontend has always called; `select` is the name
   * that says what it does. Both are this, because the operation is the same
   * one and a second entry point would be a second set of rules.
   */
  'POST /api/session/select': async (app, body = {}) => selectSession(app, body),
  'POST /api/session/resume': async (app, body = {}) => selectSession(app, body),

  /**
   * CLOSE THE VIEW — NOT the conversation.
   *
   * The session stays on disk, stays in `/resume`, and keeps whatever it was
   * doing. Closing the tab you were watching work in has never been an
   * instruction to stop the work, and this route is deliberately incapable of
   * deleting anything: see `POST /api/session/delete` for the action that can.
   */
  'POST /api/session/close': async (app, body = {}) => {
    const id = String(body.id || app.session.id);
    const pool = app.pool();
    const r = pool.release(id);
    return ok({ id, closed: true, stillRunning: r.stillRunning, view: pool.viewId });
  },

  /**
   * DELETE A CONVERSATION. Explicit, named, and never what a close button does.
   */
  'POST /api/session/delete': async (app, body = {}) => {
    const id = String(body.id || '');
    if (!id) return bad('which session?');
    const pool = app.pool();
    if (pool.running(id)) return bad('that session has a turn running — stop it first', 409);
    if (pool.primary.session && pool.primary.session.id === id) return bad('that session is open in the terminal', 409);
    pool.release(id);
    // THE ONE VERB THAT DELETES, in the one file that can. See sessionstore.js.
    const r = require('../sessionstore').forget(id);
    if (!r.ok) return bad(r.why, 404);
    return ok({ id, deleted: true });
  },

  /**
   * SEE WHAT LAIN SEES. A screenshot of the window it is working in, or of the
   * screen when it is not aimed at one. It is a READ and takes the same grant
   * every other observation does.
   */
  'POST /api/computer/view': async (app, body = {}) => {
    const c = require('../computermcp').existing(app);
    if (!c || !c.connected) return bad('the computer is not connected', 409);
    const r = await c.capture(body.window || body.pid ? { window: body.window, pid: body.pid } : {});
    if (!r.ok) return bad(r.why);
    const fs = require('fs');
    let data = null;
    try { data = fs.readFileSync(r.result.path).toString('base64'); } catch (e) { return bad(`the image could not be read: ${e.message}`); }
    try { fs.unlinkSync(r.result.path); } catch { /* a leftover frame is not worth failing over */ }
    return ok({ image: `data:image/png;base64,${data}`, region: r.result.region });
  },

  /**
   * STOP. The authorization goes, the bridge goes, and a turn in flight is
   * interrupted — one button, and it cannot half-work.
   */
  'POST /api/computer/stop': async (app) => {
    const c = require('../computermcp').existing(app);
    const interrupted = Boolean(app.abort && !app.abort.signal.aborted);
    if (interrupted) app.abort.abort();
    if (c) c.disconnect('you stopped it from the Harness');
    return ok({ stopped: true, interrupted });
  },

  'POST /api/ask/answer': async (app, body = {}) => {
    const q = app._harnessAsk;
    if (!q || q.id !== String(body.id || '')) return bad('that question is no longer open', 409);
    const answer = body.answer == null ? null : String(body.answer);
    if (answer !== null && q.options.length && !q.options.includes(answer)) return bad('not one of the offered answers');
    q.resolve(answer);
    return ok({ answered: true });
  },
};

module.exports = { ROUTES, portFor, withPort, pendingAsk };
