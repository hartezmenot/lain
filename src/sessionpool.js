'use strict';

/**
 * THE SESSIONS THAT ARE LIVE RIGHT NOW — Core's set, not a surface's.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS FILE EXISTS TO FIX, stated plainly.
 *
 * There was one `App`, it held one `session`, and `app.abort` was the answer to
 * "is a turn running". So the Harness asked that question — and it is the wrong
 * question, because the answer is about the PROCESS and the thing being asked
 * about is a SESSION. Opening another conversation while one was working was
 * refused with "a turn is running — stop it or let it finish first", which is a
 * sentence about navigation being mistaken for a sentence about execution.
 *
 * NAVIGATION IS NOT EXECUTION. Looking at session B does not touch turn A1.
 * Creating session C does not touch turn A1. The only thing that must still be
 * governed is a second turn in the SAME session, and that was never this
 * check's job — `inputgate.js` and the steer contract own it.
 *
 * ------------------------------------------------------------------------
 * WHAT REPLACES IT.
 *
 *     Core
 *      ├── App(session A)   turn A1 RUNNING     ← the primary, if the CLI is on it
 *      ├── App(session B)   idle
 *      └── App(session C)   idle
 *
 * One `App` per live session, which is exactly what `App` already was — read
 * its header: "two Apps in one process cannot see each other's session". That
 * property was designed for and never used. This is the use.
 *
 * A surface (the terminal, the window) then holds a VIEW: which of these it is
 * showing. `viewSessionId` and `runningSessionId` are different facts, and the
 * whole bug was one variable doing both jobs.
 *
 * ------------------------------------------------------------------------
 * WHAT A SIBLING SHARES WITH THE PRIMARY, AND WHAT IT MUST NOT.
 *
 * SHARED, because they are facts about the PROCESS and duplicating them would
 * produce two disagreeing answers:
 *   · the configuration object (edit it once, every session sees it)
 *   · `availability` — a route shut by a rate limit is shut for everybody
 *   · `connectionEvidence` — a request that really succeeded is evidence once
 *
 * NOT SHARED, because they are facts about a CONVERSATION:
 *   · the session, its checkpoints, its plan, its task, its goal
 *   · `abort` — the running turn, which is the entire point
 *   · `jobs`, the event bus, the handover slot, the project caches
 *
 * ------------------------------------------------------------------------
 * A SIBLING HAS NO TERMINAL, AND THAT IS THE ONLY DIFFERENCE IN BEHAVIOUR.
 *
 * It renders to a sink, its `ui` is never enabled, and it therefore never draws
 * a frame, never enters the alternate screen and never asks a question the
 * terminal would have to answer. Its questions go to the Harness port, which is
 * where a window-started turn's questions already went (sessionroutes.js).
 *
 * THIS IS NOT A SECOND RUNTIME. A sibling runs `App.handle` → `submit` →
 * `runTurn` — the same door, the same input gateway, the same tools, the same
 * mutation transaction, the same permission and trust decisions. It is the same
 * program with a different conversation in it.
 */

const { Session } = require('./session');

/**
 * A writable that discards. A sibling has no terminal, and `Renderer` is the
 * only thing in the program that writes to one — so a sibling is given a
 * stream that goes nowhere rather than a special renderer with an `if` in it.
 */
function sink() {
  return {
    isTTY: false,
    columns: 100,
    write() { return true; },
    on() { return this; },
    once() { return this; },
    removeListener() { return this; },
    end() { },
  };
}

/** How many idle sibling Apps are kept alive. A rail, not an archive. */
const MAX_IDLE = 12;

class SessionPool {
  /** @param {object} primary the App the process was started as. */
  constructor(primary) {
    this.primary = primary;
    /** @type {Map<string, object>} session id → App, siblings only. */
    this.apps = new Map();
    /**
     * WHAT THE WINDOW IS LOOKING AT. Never what is executing.
     *
     * ONE VIEW, NOT ONE PER SURFACE — a deliberate limit, stated so it is not
     * mistaken for an oversight. If the native window and the browser surface
     * are both open, switching session in one switches it in the other. That is
     * right for the case this is built for (one person, one LAIN, two ways in)
     * and wrong for two people on two machines sharing a Core. Making it
     * per-surface means giving surfaces identity, which is a larger change than
     * the defect being fixed here and is not worth inventing before anybody has
     * two surfaces open at once.
     */
    this.viewId = primary.session ? primary.session.id : null;
  }

  /** Every live session id, primary first. */
  ids() {
    const out = [];
    if (this.primary.session) out.push(this.primary.session.id);
    for (const id of this.apps.keys()) if (!out.includes(id)) out.push(id);
    return out;
  }

  /** The App that owns this session right now, or null if it is not live. */
  live(id) {
    const want = String(id || '');
    if (!want) return null;
    if (this.primary.session && this.primary.session.id === want) return this.primary;
    return this.apps.get(want) || null;
  }

  /** Is a turn running in this session? The question the Harness should ask. */
  running(id) {
    const a = this.live(id);
    return Boolean(a && a.abort && !a.abort.signal.aborted);
  }

  /** The App the surface is currently showing. Falls back to the primary. */
  view() {
    return this.live(this.viewId) || this.primary;
  }

  /**
   * MAKE A SESSION LIVE AND LOOK AT IT.
   *
   * It never refuses because something else is running. That refusal was the
   * defect. It refuses only when the session does not exist — which is a fact
   * about the request, not about the machine's mood.
   */
  open(id) {
    const want = String(id || '');
    if (!want) return { ok: false, why: 'which session?' };
    const already = this.live(want);
    if (already) { this.viewId = want; return { ok: true, id: want, app: already, already: true }; }
    const s = Session.resume(want);
    if (!s) return { ok: false, why: `no session "${want}"`, code: 404 };
    // THE RESUMED SESSION'S OWN ID, NOT WHAT WAS ASKED FOR. `Session.resume`
    // accepts a short token (`ayze`) and returns the full session, so keying the
    // view on `want` would point the window at a name nothing is registered
    // under — `live()` would then miss, and the view would silently fall back to
    // the terminal's session. Found by reading, not by a failure.
    const app = this.attach(s, { resumedFrom: want });
    this.viewId = s.id;
    return { ok: true, id: s.id, app };
  }

  /**
   * A NEW CONVERSATION, live immediately, without disturbing any other.
   *
   * The primary keeps its session and keeps its turn. This is the whole of
   * "creating a session is not a mutation of the running one".
   */
  create({ cwd = null, lane = 'engineering' } = {}) {
    const dir = cwd || (this.primary.session && this.primary.session.cwd) || this.primary.cwd;
    const s = new Session({ cwd: dir });
    const app = this.attach(s);
    if (lane === 'cowork') {
      // ASTRA'S BINDING, called — never reimplemented. What a Cowork session may
      // do is their runtime's question; this file only decides that creating one
      // does not wait on somebody else's turn.
      const binding = require('./cowork/sessionstate');
      try {
        binding.bind(s, 'harness', binding.sourceBinding('harness', [s.id, s.cwd]));
      } catch (e) {
        this.apps.delete(s.id);
        return { ok: false, why: e.message };
      }
    }
    try { s.save(); } catch { /* an unsaved empty session is still empty */ }
    this.viewId = s.id;
    return { ok: true, id: s.id, app, lane };
  }

  /**
   * CLOSE THE VIEW. Not delete, and not cancel.
   *
   * The conversation stays on disk and stays in `/resume`. A session with a
   * turn still running stays LIVE — closing the tab you were watching it in is
   * not an instruction to stop it — it simply stops being the view.
   */
  release(id) {
    const want = String(id || '');
    const app = this.apps.get(want);
    if (app && !this.running(want)) {
      try { app.session.save(); } catch { /* keep what it had */ }
      this.dispose(app);
      this.apps.delete(want);
    }
    if (this.viewId === want) this.viewId = this.primary.session ? this.primary.session.id : (this.ids()[0] || null);
    return { ok: true, id: want, stillRunning: this.running(want) };
  }

  /**
   * Build a sibling App for a session and register it.
   * @returns {object} the App.
   */
  attach(session, { resumedFrom = null } = {}) {
    const app = siblingApp(this.primary, session, { resumedFrom });
    this.apps.set(session.id, app);
    reattachProject(app);
    this.evict();
    return app;
  }

  /** Drop the oldest idle siblings once the rail is longer than a rail. */
  evict() {
    if (this.apps.size <= MAX_IDLE) return;
    for (const [id, app] of this.apps) {
      if (this.apps.size <= MAX_IDLE) return;
      if (id === this.viewId || this.running(id)) continue;
      try { app.session.save(); } catch { /* nothing to keep */ }
      this.dispose(app);
      this.apps.delete(id);
    }
  }

  /** Release what a sibling holds that is not garbage-collected on its own. */
  dispose(app) {
    // A DESKTOP AUTHORIZATION BELONGS TO THE SESSION IT WAS GIVEN IN — the same
    // rule `App.adopt` applies when a session changes under the terminal.
    try { if (app._desktop) app._desktop.permissions.revoke('the session was closed'); } catch { /* none */ }
  }

  /**
   * THE PRIMARY IS TAKING OVER A SESSION a sibling holds (`/resume` in the
   * terminal, for a conversation the window already opened).
   *
   * Two Apps on one session would be two conversations writing one file, so the
   * sibling is handed over — unless it is mid-turn, in which case the honest
   * answer is that the work is already somewhere, not that it will be moved out
   * from under itself.
   */
  handover(id) {
    const want = String(id || '');
    if (this.running(want)) return { ok: false, why: 'that session has a turn running here — it is already open' };
    const app = this.apps.get(want);
    if (app) {
      try { app.session.save(); } catch { /* keep what it had */ }
      this.dispose(app);
      this.apps.delete(want);
    }
    return { ok: true };
  }

  /** Every live session with what it is doing — the rail's status column. */
  statuses() {
    const out = {};
    for (const id of this.ids()) {
      const app = this.live(id);
      if (!app) continue;
      out[id] = statusOf(app, this.running(id));
    }
    return out;
  }
}

/**
 * WHAT A SESSION IS DOING, in one word, from the feed that already exists.
 *
 * `notePhase` is called by turn.js before every provider request and every
 * tool, and it records into the primary job — the same feed the status strip
 * reads. This is a THIRD reader of that value (see harnessapp/state.js on the
 * second), not a third source of it: nothing here decides whether a turn is
 * healthy, only which of five words describes it.
 *
 * A session with no terminal has no status strip to read, which is exactly why
 * the job record — which exists with or without a UI — is the right source.
 */
function statusOf(app, running) {
  // ONE AUTHORITY. The eight public words and their summary are
  // sessionstatus.js's; this adds only how each is drawn.
  const st = require('./sessionstatus').of(app, { running });
  return { ...row(st.state, st.summary), status: st };
}

/**
 * The eight states, with how each is DRAWN.
 *
 * ------------------------------------------------------------------------
 * THE PRESENTATION IS HERE RATHER THAN IN THE READ MODEL, on purpose.
 *
 * harnessapp/state.js is forbidden from containing a verdict vocabulary — an
 * architecture test asserts it, because a read model that can spell PASSED or
 * FAILED is a read model that can eventually decide one. A session status is a
 * different kind of fact, but it is not worth eroding that guard to say so, and
 * the word belongs next to the thing that chose it anyway.
 *
 * STOPPED, not "failed": the last turn did not finish. Whether the WORK failed
 * is the verification's answer and this is in no position to give it.
 */
function row(state, detail) {
  const active = state === 'RUNNING' || state === 'VERIFYING' || state === 'QUEUED';
  const level = state === 'FAILED' ? 'red'
    : (state === 'WAITING' || state === 'NEEDS_INPUT') ? 'amber'
      : active ? 'working' : 'idle';
  return {
    state,
    detail: detail || '',
    word: state === 'RUNNING' ? 'WORKING' : state === 'NEEDS_INPUT' ? 'NEEDS INPUT' : state,
    level,
    spin: active,
    // Whether this is worth showing as an operational row at all. An idle or
    // finished conversation is not "happening"; it simply is. Named apart from
    // a session rail row's own `live` (which means "an App holds it").
    notable: active || state === 'WAITING' || state === 'NEEDS_INPUT' || state === 'FAILED',
  };
}

/**
 * THE PROJECT A RESUMED SESSION BELONGS TO — checked, and reconciled.
 *
 * ------------------------------------------------------------------------
 * OPENING AN OLD CONVERSATION IS OPENING ITS PROJECT.
 *
 * A session from three weeks ago says `cwd: C:/.../toradb`, and the next thing
 * the person types is "continue the stall fix". Two things have to be true
 * before that sentence can mean anything:
 *
 *   THE DIRECTORY STILL EXISTS. It may have been moved, renamed or deleted, and
 *   a session silently bound to a path that is not there produces a turn whose
 *   every read fails for a reason nothing on screen explains. So it is checked
 *   once, here, and the answer travels to the window (harnessapp/state.js).
 *
 *   WHAT LAIN KNOWS ABOUT IT IS CURRENT. The index on disk describes the tree as
 *   it was when the session was last open; an editor, a branch change or a
 *   formatter has moved things since. `projectsync.open` is the reconcile the
 *   `understand` tool already performs — the same one, not a second — so the
 *   first question asked in a resumed session is answered from a tree that was
 *   re-stat'ed rather than from a memory of one.
 *
 * FIRE AND FORGET, AND BOUNDED. Reconciling walks the tree, and opening a
 * session must not block on it — the conversation is readable immediately and
 * the index catches up. A failure is recorded, never thrown: a project whose
 * index cannot be refreshed is still a project you can work in.
 */
function reattachProject(app) {
  const root = app.session && app.session.cwd;
  if (!root) return;
  let exists = false;
  try { exists = require('fs').statSync(root).isDirectory(); } catch { exists = false; }
  app._projectMissing = !exists;
  if (!exists) return;
  Promise.resolve()
    .then(() => require('./projectsync').open(root))
    .then((r) => { app._projectSync = { at: Date.now(), verdict: r && r.verdict }; })
    .catch((e) => { app._projectSync = { at: Date.now(), why: (e && e.message) || String(e) }; });
}

/**
 * ONE MORE APP, FOR ONE MORE CONVERSATION.
 *
 * Constructed through the ordinary constructor with `sibling` set, so there is
 * no second construction path to keep in step with the first. See the header
 * for what is shared and what is not.
 */
function siblingApp(primary, session, { resumedFrom = null } = {}) {
  const { App } = require('./app');
  const app = new App({
    cwd: session.cwd || primary.cwd,
    interactive: false,
    out: sink(),
    sibling: primary,
    session,
    resumedFrom,
  });
  return app;
}

/** The pool for an App. Per-App, never module scope — see app.js's header. */
function forApp(app) {
  const root = app._sibling || app;
  if (!root._pool) root._pool = new SessionPool(root);
  return root._pool;
}

module.exports = { forApp, SessionPool, statusOf, sink, MAX_IDLE, reattach: reattachProject };
