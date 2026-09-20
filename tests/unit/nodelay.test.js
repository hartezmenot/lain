'use strict';

/**
 * NOTHING WAITS ON PURPOSE.
 *
 * ------------------------------------------------------------------------
 * THE RULE, AND WHY IT NEEDS A TEST RATHER THAN A PROMISE.
 *
 * LAIN must never intentionally make finished work feel slower. Not a minimum
 * card lifetime, not an animation before a state is replaced, not a delayed
 * DONE, not "hold it a moment so the person can see it happened".
 *
 * That kind of delay is easy to reintroduce and impossible to notice in a
 * green suite, because every test still passes — just later. So the shapes are
 * pinned here:
 *
 *   THE CLI    plays its activity timeline INSTANTLY. The machinery that can
 *              pace it still exists and is off; this fails if it is turned on.
 *   THE WINDOW is woken by Core the moment authoritative state moves. Its poll
 *              is a fallback, not the clock it used to be.
 *   NEITHER    adds a timer between "the fact is true" and "the fact is shown".
 *
 * WHAT IS NOT IN SCOPE: provider backoff, reconnect backoff, request timeouts,
 * readiness polling, input disambiguation. Those are required by something
 * outside LAIN, and removing them would be a different defect.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

module.exports = async function () {
  await test('NODELAY: the CLI timeline is INSTANT — no card is held for a minimum time', () => {
    // The pacing constants still exist (ENTER/HOLD/SETTLE/EXIT) because the
    // machinery that could animate is still there. What matters is that the
    // product never asks for it.
    const ui = read('src', 'ui', 'index.js');
    assert.match(ui, /ActivitySurface\)\(\{ instant: true \}\)/,
      'the activity surface must be constructed instant — a paced one holds every tool row');

    // AND INSTANT REALLY MEANS INSTANT, not "fast". A paced playback returns a
    // finite speed; an instant one collapses the whole timeline at once.
    const { Playback } = require('../../src/ui/playback');
    const paced = new Playback({ instant: false });
    const now = new Playback({ instant: true });
    assert.strictEqual(now.speed(), Infinity, 'an instant timeline spends no time');
    assert.ok(Number.isFinite(paced.speed()), 'and the paced one it replaced did');
  });

  await test('NODELAY: a finished operation is drawn at once, not after a hold', () => {
    const { ActivitySurface } = require('../../src/ui/activity');
    const a = new ActivitySurface({ instant: true });
    const id = a.begin({ tool: 'read_file', target: 'a.js' });
    a.end(id, { ok: true });
    // BUSY IS THE QUESTION THE TICKER ASKS. An instant surface is never busy
    // "playing" something that already happened, so nothing schedules a frame
    // to wait for it.
    assert.strictEqual(a.busy(), false,
      'a completed operation must not leave the surface animating');
  });

  await test('NODELAY: Core wakes the window the moment its state moves', () => {
    // ---- THE BIGGEST ONE, AND IT WAS NOT A SLEEP -------------------------
    //
    // The window polls `/api/state`. That is right as a FALLBACK and was wrong
    // as the clock: an answer that existed at T appeared at up to T + pollMs,
    // so the application looked slower than the work it was reporting for no
    // reason but that nobody had told it to look again.
    const ipc = read('src', 'harnessapp', 'ipc.js');
    assert.match(ipc, /function wake\(\)/, 'Core can say "look now"');
    assert.match(ipc, /JSON\.stringify\(\{ wake: 1 \}\)/, 'and it carries no state — one read model');

    // EVERY PLACE AUTHORITATIVE STATE MOVES SAYS IT.
    // notePhase hands the phase to the status authority, which wakes the window
    // AND emits session.status — one call, no timer between.
    assert.match(read('src', 'app.js'), /sessionstatus'\)\.touch\(this, \{ phase: p \|\| null \}\)/,
      'notePhase — before every provider call and every tool');
    assert.match(read('src', 'sessionstatus.js'), /ipc\.wake\(\)/,
      'and the status authority wakes the window');
    assert.match(read('src', 'turnevents.js'), /ipc'\)\.wake\(\)/,
      'every turn event — prose, tool rows, done');
    assert.match(read('src', 'harnessapp', 'routes.js'), /require\('\.\/ipc'\)\.wake\(\)/,
      'and every write route — creating a session, selecting one, starting a turn');

    // THE RENDERER ACTS ON IT IMMEDIATELY, with no timer in between.
    const script = require('../../src/harnessapp/pagescript').js();
    assert.match(script, /if \(m\.wake\) \{ poll\(\); return; \}/,
      'a wake polls at once — a debounce here would be the delay this removes');
  });

  await test('NODELAY: a wake is not batched, debounced or rate-limited', () => {
    // A timer added to "smooth out" wakes would reintroduce exactly what this
    // removes. A wake is a few bytes on a pipe; there is nothing to smooth.
    const ipc = read('src', 'harnessapp', 'ipc.js');
    const fn = ipc.slice(ipc.indexOf('function wake()'), ipc.indexOf('function toHost('));
    assert.ok(!/setTimeout|setInterval|debounce|throttle/.test(fn),
      'wake() must not schedule anything');
  });

  await test('NODELAY: the write routes wake, and reads do not', () => {
    // Waking on a GET would be a loop: the poll reads state, the read wakes the
    // poll, forever.
    const routes = read('src', 'harnessapp', 'routes.js');
    const disp = routes.slice(routes.indexOf('async function dispatch('));
    assert.match(disp, /!== 'GET'/, 'a read changes nothing and must not wake');
  });

  await test('NODELAY: session navigation adds no waiting of its own', async () => {
    // §9: clicking a session renders it as soon as Core can answer. The guard
    // that used to make this wait was removed with the global turn lock; this
    // is the timing half of the same property.
    const routes = require('../../src/harnessapp/routes');
    const { App } = require('../../src/app');
    const app = new App({
      out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false },
      interactive: false, cwd: tmpdir('nodelay-'),
    });
    app.abort = new AbortController();          // another session is working

    const t0 = Date.now();
    const made = await routes.dispatch(app, 'POST', '/api/session/new', {});
    const sel = await routes.dispatch(app, 'POST', '/api/session/select', { id: made.body.id });
    const took = Date.now() - t0;
    assert.strictEqual(made.code, 200);
    assert.strictEqual(sel.code, 200);
    // NOT A BENCHMARK — a ceiling no amount of machine slowness reaches but any
    // deliberate pause would. A single 250ms "settle" would fail this.
    assert.ok(took < 2000, `creating and selecting a session took ${took}ms`);

    app.abort = null;
    require('../../src/sessionstore').forget(made.body.id);
  });

  await test('NODELAY: no presentation timer waits before showing something true', () => {
    // A sweep for the SHAPE rather than for a name: a timer whose callback
    // reveals state is a delayed reveal however it is spelled.
    const suspects = [
      ['src/harnessapp/pagescript.js', /setTimeout\([^)]*render\(\)/],
      ['src/harnessapp/pagecowork.js', /setTimeout\([^)]*render\(\)/],
      ['src/ui/index.js', /setTimeout\([^)]*refresh\(\)/],
    ];
    for (const [file, re] of suspects) {
      assert.ok(!re.test(read(...file.split('/'))), `${file} defers a render behind a timer`);
    }
  });
};
