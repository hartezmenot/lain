'use strict';

/** THE SESSIONS THAT ARE LIVE RIGHT NOW — Core's set, not a surface's. */

const { Session } = require('./session');

/** A writable that discards. */
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
    /** WHAT THE WINDOW IS LOOKING AT. */
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

  /** MAKE A SESSION LIVE AND LOOK AT IT. */
  open(id) {
    const want = String(id || '');
    if (!want) return { ok: false, why: 'which session?' };
    const already = this.live(want);
    if (already) { this.viewId = want; return { ok: true, id: want, app: already, already: true }; }
    const s = Session.resume(want);
    if (!s) return { ok: false, why: `no session "${want}"`, code: 404 };
    // THE RESUMED SESSION'S OWN ID, NOT WHAT WAS ASKED FOR.
    const app = this.attach(s, { resumedFrom: want });
    this.viewId = s.id;
    return { ok: true, id: s.id, app };
  }

  /** A NEW CONVERSATION, live immediately, without disturbing any other. */
  create({ cwd = null, lane = 'engineering' } = {}) {
    const dir = cwd || (this.primary.session && this.primary.session.cwd) || this.primary.cwd;
    const s = new Session({ cwd: dir });
    const app = this.attach(s);
    if (lane === 'cowork') {
      // ASTRA'S BINDING, called — never reimplemented.
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

  /** CLOSE THE VIEW. Not delete, and not cancel. */
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

  /** Build a sibling App for a session and register it. */
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

  /** THE PRIMARY IS TAKING OVER A SESSION a sibling holds (`/resume` in the terminal, for a conversation the window already opened). */
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

/** WHAT A SESSION IS DOING, in one word, from the feed that already exists. */
function statusOf(app, running) {
  // ONE AUTHORITY. The eight public words and their summary are
  // sessionstatus.js's; this adds only how each is drawn.
  const st = require('./sessionstatus').of(app, { running });
  return { ...row(st.state, st.summary), status: st };
}

/** The eight states, with how each is DRAWN. */
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
    // Whether this is worth showing as an operational row at all.
    notable: active || state === 'WAITING' || state === 'NEEDS_INPUT' || state === 'FAILED',
  };
}

/** THE PROJECT A RESUMED SESSION BELONGS TO — checked, and reconciled. */
function reattachProject(app) {
  const root = app.session && app.session.cwd;
  if (!root) return;
  let exists = false;
  try { exists = require('fs').statSync(root).isDirectory(); } catch { exists = false; }
  app._projectMissing = !exists;
  if (!exists) return;
  // RUNNING IS A STATE THE WINDOW SHOWS ("Understanding project"), so it is recorded before the walk starts, and what the walk found replaces it — the…
  const startedAt = Date.now();
  app._projectSync = { root, running: true, startedAt };
  Promise.resolve()
    .then(() => require('./projectsync').open(root))
    .then((r) => {
      let cov = null;
      try { cov = r && r.index ? require('./projectindex').coverage(root, { index: r.index }) : null; } catch { cov = null; }
      app._projectSync = {
        root, running: false, startedAt, at: Date.now(), verdict: r && r.verdict,
        state: cov ? cov.state : null,
        files: cov ? cov.discovered : null,
        code: cov ? cov.code : null,
        scanned: cov ? cov.scanned : null,
        symbols: cov ? cov.symbols : null,
        truncated: Boolean(r && r.refresh && r.refresh.truncated),
      };
    })
    .catch((e) => { app._projectSync = { root, running: false, startedAt, at: Date.now(), why: (e && e.message) || String(e) }; });
}

/** ONE MORE APP, FOR ONE MORE CONVERSATION. */
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
