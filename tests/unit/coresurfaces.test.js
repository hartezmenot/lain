'use strict';

/**
 * TWO SURFACES, ONE CORE — the CLI and the Desktop are not two products.
 *
 * ------------------------------------------------------------------------
 * WHAT THESE PIN:
 *
 *   §8/§29  `/resume` and the Desktop rail read ONE session authority. Not two
 *           databases, not a mirror, not a Desktop-only list.
 *   §7/§28  A second launch finds the first rather than becoming a second LAIN.
 *   §11     Closing a view keeps the conversation; only delete deletes.
 *   §18     X, hide and Quit are three different things in the code that owns
 *           each of them.
 *   §25     A notification is an ENDING, never a tool call.
 *
 * The real window, the real tray and the real control pipe are exercised in
 * tests/smoke/desktop-real.test.js. What is here is the shape, which is worth
 * checking on every run rather than only where a desktop exists.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function appAt(cwd) {
  const { App } = require('../../src/app');
  return new App({
    out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false },
    interactive: false,
    cwd: cwd || process.cwd(),
  });
}

module.exports = async function () {
  await test('SURFACES: the rail and /resume are one authority, not two lists', async () => {
    const app = appAt(tmpdir('surf-'));
    const routes = require('../../src/harnessapp/routes');
    const made = [];
    for (let i = 0; i < 3; i++) {
      const r = await routes.dispatch(app, 'POST', '/api/session/new', {});
      made.push(r.body.id);
    }

    // WHAT THE TERMINAL WOULD OFFER, from the index `/resume` reads.
    const fromResume = new Set(require('../../src/sessionindex')
      .summaries({ limit: 200, scope: 'all' }).map((s) => s.id));
    // WHAT THE WINDOW SHOWS.
    const st = await routes.dispatch(app, 'GET', '/api/state', {});
    const rail = st.body.state.sessions;
    const fromRail = new Set(rail.engineering.concat(rail.cowork).map((s) => s.id));

    for (const id of made) {
      assert.ok(fromResume.has(id), `${id} is offered by /resume`);
      assert.ok(fromRail.has(id), `${id} is in the Desktop rail`);
    }
    // AND THE IDS ARE THE SAME IDS. A Desktop-only identifier would be the start
    // of a second session database.
    assert.ok([...fromRail].every((id) => typeof id === 'string' && /^\d{8}-\d{6}-/.test(id)),
      'the rail carries real session ids');

    // CLOSING A VIEW KEEPS IT IN BOTH. §11: close is not delete.
    await routes.dispatch(app, 'POST', '/api/session/close', { id: made[0] });
    assert.ok(require('../../src/sessionindex').summaries({ limit: 200, scope: 'all' })
      .some((s) => s.id === made[0]), 'a closed session is still resumable');

    for (const id of made) require('../../src/sessionstore').forget(id);
  });

  await test('SURFACES: the read model reads one session store, and nothing keeps a second', () => {
    // NO DESKTOP SESSION DATABASE. The rail is built from sessionindex.js; a
    // file that wrote its own list of sessions would be the second database this
    // forbids.
    const state = read('src', 'harnessapp', 'state.js');
    assert.match(state, /require\('\.\.\/sessionindex'\)/, 'the rail reads the session index');
    for (const f of ['src/harnessapp/state.js', 'src/harnessapp/sessionroutes.js', 'src/desktoprun.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.ok(!/sessionsDir\(\)/.test(src), `${f} does not reach the session directory itself`);
    }
  });

  await test('SURFACES: a second launch finds the first — three verbs and no more', () => {
    const lock = read('src', 'corelock.js');
    // THE CONTROL PIPE IS NARROW BY CONSTRUCTION, which is the only reason it
    // can be unauthenticated. If a verb ever carries conversation, a session or
    // a credential, it belongs on the authenticated channel instead.
    const verbs = [...lock.matchAll(/verb === '([a-z]+)'/g)].map((m) => m[1]).sort();
    // 2026-09-29: `open` — Windows' Open with LAIN: a PATH, opened as the IDE would open it (openpath.js); it runs and grants nothing.
    // 2026-09-30: `preview` — `noema preview` while Noema runs: show the running Noema's Preview (it opens a view, grants nothing).
    assert.deepStrictEqual(verbs, ['open', 'preview', 'quit', 'show', 'status'], `five verbs: ${verbs.join(', ')}`);
    // CODE ONLY. Both comment forms are stripped — the first version of this
    // flagged a line saying the pipe hands out no secret, which is a sentence
    // agreeing with the assertion.
    const code = lock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/routes\.dispatch|session\.|apiKey|secret/.test(code),
      'the control pipe reaches no route, no session and no credential');

    // AND THE DIRECT LAUNCH ASKS BEFORE IT BUILDS ANYTHING.
    const run = read('src', 'desktoprun.js');
    const askAt = run.indexOf('lock.discover()');
    const appAt2 = run.indexOf('new App(');
    assert.ok(askAt > 0 && appAt2 > askAt, 'it discovers a running Noema before constructing one');
    const cli = read('src', 'cli.js');
    assert.ok(cli.indexOf("opts.desktop") < cli.indexOf('const { App } = require'),
      'and the CLI routes --desktop before it builds a session');
  });

  await test('SURFACES: the single-instance lock is announced before prepare(), not after', () => {
    // THE RACE THIS CLOSES: `announce()` binds the control pipe and writes the
    // lock file — the thing a second, near-simultaneous launch's `discover()`
    // actually checks. Leaving it until AFTER `app.prepare()` held the window
    // open for however long that took, during which a second launch could also
    // see "nothing running" and become a second LAIN, each then spawning its
    // own window against the same WebView2 profile — the reported
    // ERROR_INVALID_STATE dialog. Shrinking that window to "before prepare()"
    // does not close the race outright (two launches can still both reach
    // `announce()` before either binds), but it removes the one deliberately
    // widened gap this file controlled.
    const run = read('src', 'desktoprun.js');
    const appAt = run.indexOf('new App(');
    const announceAt = run.indexOf('lock.announce(');
    const prepareAt = run.indexOf('app.prepare()');
    assert.ok(appAt > 0 && announceAt > appAt && prepareAt > announceAt,
      `expected new App() -> lock.announce() -> app.prepare(), got positions ${appAt}, ${announceAt}, ${prepareAt}`);
  });

  await test('SURFACES: X, hide and Quit are three different things', () => {
    const host = fs.readFileSync(require('../helpers').harnessPath('native', 'host.cs'), 'utf8');
    // A USER CLOSE IS CANCELLED AND HIDDEN — the window's lifetime is not LAIN's.
    assert.match(host, /CloseReason\.UserClosing[\s\S]{0,140}Hide\(\);/, 'X hides');
    // QUIT IS A SEPARATE, CONFIRMED ACTION THAT ASKS CORE.
    assert.match(host, /void QuitLain\(\)/, 'quit is its own action');
    assert.match(host, /api\/desktop\/quit/, 'and it asks Core rather than exiting here');
    // THE TRAY IS WHAT MAKES HIDING SAFE: something must be left to restore from.
    assert.match(host, /NotifyIcon/, 'there is a tray icon');
    assert.match(host, /tray\.DoubleClick/, 'and double-clicking it brings Noema back');

    // ONE SHUTDOWN SEQUENCE, THREE CALLERS. A second one would forget an entry.
    for (const f of ['src/repl.js', 'src/corelock.js', 'src/harnessapp/routes.js', 'src/desktoprun.js']) {
      assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /teardown'\)\.shutdown\(/,
        `${f} ends Noema through the one sequence`);
    }
  });

  await test('SURFACES: shutting down sweeps the PROCESS, even when asked through a view', async () => {
    // THE TRAP: Quit arrives as a route, and a route acts on the session the
    // window is VIEWING — which may be a sibling. The gateway, the shell jobs,
    // the harness services and the computer bridge all hang off the PRIMARY, so
    // a shutdown through a sibling would sweep nothing and report success.
    const app = appAt(tmpdir('surf-'));
    const pool = app.pool();
    const sib = pool.live(pool.create({}).id);
    assert.notStrictEqual(sib, app, 'a real sibling');

    let sweptFrom = null;
    app._jobs = { stopAll() { sweptFrom = 'primary'; } };
    sib._jobs = { stopAll() { sweptFrom = 'sibling'; } };
    // A turn running in the sibling must be ended by the sweep, not ignored.
    sib.abort = new AbortController();

    await require('../../src/teardown').shutdown(sib, { why: 'the test', closeWindow: false });
    assert.strictEqual(sweptFrom, 'primary', 'the process was swept, not the viewed conversation');
    assert.strictEqual(sib.abort.signal.aborted, true, 'and every live session was stopped');

    for (const id of pool.ids()) if (id !== app.session.id) require('../../src/sessionstore').forget(id);
  });

  await test('SURFACES: a notification is an ending, never a tool call', () => {
    const { sentenceFor } = require('../../src/notify');
    const app = appAt(tmpdir('surf-'));
    // NOTHING TO SAY about a turn in the middle of work.
    assert.strictEqual(sentenceFor(app, { text: 'reading files' }), null);
    // A VERDICT IS WORTH SAYING, and it is the verification's word, not a new one.
    app.session.verification = { verdict: 'PASSED' };
    assert.match(sentenceFor(app, {}), /verification passed$/);
    app.session.verification = { verdict: 'FAILED' };
    assert.match(sentenceFor(app, {}), /verification failed$/);
    // AND SO IS WAITING ON THE PERSON — nothing happens until they come back.
    app.session.verification = null;
    app.session.lifecycle = require('../../src/lifecycle').Lifecycle.from({ state: 'NEEDS_USER', reason: 'it asked you something' });
    assert.match(sentenceFor(app, {}), /waiting for you$/);

    // IT IS SENT FROM THE END OF A SUBMISSION, AFTER THE THINGS THAT CAN
    // CONTINUE IT — a notification about an ending that was not one is worse
    // than none.
    const close = read('src', 'submitclose.js');
    assert.ok(close.indexOf("require('./notify')") > close.indexOf("require('./ratelimit')"),
      'the notification is last, after anything that could continue the turn');
    // AND IT IS NOT WIRED INTO THE TOOL LOOP.
    assert.ok(!/require\('\.\/notify'\)/.test(read('src', 'toolstep.js')), 'no notification per tool call');
    assert.ok(!/require\('\.\.\/notify'\)/.test(read('src', 'tools', 'index.js')), 'nor per tool');
  });
};
