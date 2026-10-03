'use strict';

/** SESSIONS AND QUESTIONS, FROM THE APPLICATION WINDOW. */

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
        const open = { id: `q${++seq}`, title: String(q.title || 'LAIN asks'), question: String(q.question || q.text || ''), options, plan: q.plan && q.plan.file ? { file: q.plan.file, text: String(q.plan.text || '') } : null, at: Date.now(), resolve };
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
  return q ? { id: q.id, title: q.title, question: q.question, options: q.options, plan: q.plan ? { text: q.plan.text } : null } : null;
}

/** OPEN A SESSION AND MAKE IT THE VIEW. */
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
    // WHICH PROJECT, STATED — never LAIN's own folder by accident
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

  /** LOOK AT A CONVERSATION. */
  'POST /api/session/select': async (app, body = {}) => selectSession(app, body),
  'POST /api/session/resume': async (app, body = {}) => selectSession(app, body),

  /** CLOSE THE VIEW — NOT the conversation. */
  /** RENAME the current session — a person-given title (sessionindex.headline prefers it). */
  'POST /api/session/rename': async (app, body = {}) => {
    const t = String(body.title || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
    app.session.title = t || undefined;
    try { app.session.save(); } catch (e) { return { code: 500, body: { ok: false, why: e.message } }; }
    return { code: 200, body: { ok: true, title: t || null } };
  },
  'POST /api/session/close': async (app, body = {}) => {
    const id = String(body.id || app.session.id);
    const pool = app.pool();
    const r = pool.release(id);
    return ok({ id, closed: true, stillRunning: r.stillRunning, view: pool.viewId });
  },

  /** DELETE A CONVERSATION. */
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

  /** SEE WHAT LAIN SEES. A screenshot of the window it is working in, or of the screen when it is not aimed at one. It is a READ and takes the same grant… */
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

  // STOP lives with the rest of Computer Control: harnessapp/computerroutes.js (kill switch + off + disconnect).

  'POST /api/ask/answer': async (app, body = {}) => {
    const q = app._harnessAsk;
    if (!q || q.id !== String(body.id || '')) return bad('that question is no longer open', 409);
    const answer = body.answer == null ? null : String(body.answer);
    if (answer !== null && q.options.length && !q.options.includes(answer)) return bad('not one of the offered answers');
    // A PLAN BUILT FROM THE HARNESS: the edited document is written back before the plan is approved (planmode.js reads it).
    if (q.plan && answer === 'Approve' && typeof body.text === 'string') require('fs').writeFileSync(q.plan.file, `${body.text.trim()}\n`);
    q.resolve(answer);
    return ok({ answered: true });
  },
};

module.exports = { ROUTES, portFor, withPort, pendingAsk };
