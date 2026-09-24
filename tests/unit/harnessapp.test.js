'use strict';

/**
 * THE HARNESS APPLICATION — its read model, its routes, and its boundaries.
 *
 * ------------------------------------------------------------------------
 * WHAT IS ASSERTED HERE IS MOSTLY A NEGATIVE, and deliberately so.
 *
 * The application is a SECOND SURFACE over one product. Almost everything that
 * could go wrong with it is it acquiring an opinion of its own: a second answer
 * to whether a task passed, a second way to make a session current, a second
 * turn entry point that skips the input gateway, a Cowork panel over a backend
 * that has none. So the tests are largely "it does not own this".
 *
 * The Workshop's own end-to-end behaviour is proved against a real dev server
 * and a real browser in tests/smoke/harnessapp-workshop.test.js. This file is
 * the part that can be decided without either.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

const state = require('../../src/harnessapp/state');
const routes = require('../../src/harnessapp/routes');
const page = require(require('../helpers').harnessPath('page', 'page'));

function appAt(cwd) {
  const { App } = require('../../src/app');
  return new App({
    out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false },
    interactive: false,
    cwd: cwd || process.cwd(),
  });
}

module.exports = async function () {
  // --------------------------------------------------------- the read model --

  await test('APP: the state carries the session, the lanes and the sources', async () => {
    const app = appAt(tmpdir('app-'));
    const s = await state.read(app);
    assert.ok(s.current && s.current.id, 'the open session is named');
    assert.strictEqual(s.current.lane, 'engineering', 'a session with no Cowork binding is engineering');
    assert.ok(s.sessions.engineering && s.sessions.cowork, 'both lanes are projected');
    assert.ok(Array.isArray(s.sources.sources), 'the chat sources are listed');
    assert.deepStrictEqual(
      s.sources.sources.map((x) => x.id).sort(),
      ['chatgpt-web', 'gemini-web', 'lain'],
      'all three chat sources reach the application',
    );
  });

  await test('APP: a missing task is null, never an empty task', async () => {
    // The rule harnesssurface.js already holds, carried across the boundary. A
    // surface that renders "no task" as a task with no evidence is telling
    // somebody work exists that does not.
    const s = await state.read(appAt(tmpdir('app-')));
    assert.strictEqual(s.harness, null);
  });

  await test('APP: the lane comes from ASTRA\'S marker, never from the work', async () => {
    // Guessing would put a person's engineering history in the Cowork list. The
    // marker is src/cowork/sessionstate.js, and it is the only input.
    assert.strictEqual(state.laneOf({}), 'engineering');
    assert.strictEqual(state.laneOf({ cowork: { lane: 'cowork', source: 'telegram' } }), 'cowork');
    assert.strictEqual(state.laneOf({ messages: [{ content: 'clean this spreadsheet' }] }), 'engineering',
      'work about a spreadsheet is not a Cowork session');
  });

  await test('APP: Cowork projects shared authorities and keeps unconfigured accounts honest', async () => {
    const app = appAt(tmpdir('app-'));
    let s = await state.read(app);
    assert.strictEqual(s.cowork.active, false);
    for (const ready of ['files', 'artifacts', 'background', 'approvals', 'research']) {
      assert.strictEqual(s.cowork.capabilities[ready].state, 'AVAILABLE');
    }
    for (const absent of ['email', 'calendar', 'contacts', 'reminders', 'notes']) {
      assert.strictEqual(s.cowork.capabilities[absent].state, 'UNCONFIGURED', `${absent} must not be invented`);
    }
    const bound = await routes.dispatch(app, 'POST', '/api/cowork/bind', {});
    assert.strictEqual(bound.code, 200);
    s = await state.read(app);
    assert.strictEqual(s.cowork.active, true);
    assert.strictEqual(s.current.lane, 'cowork');
    assert.strictEqual(s.cowork.session.source, 'harness');
  });

  await test('APP: tool results never travel to the application', async () => {
    // They are the bulk and the risk. The activity projection already summarises
    // what ran; shipping the output would make every poll carry a file body.
    const app = appAt(tmpdir('app-'));
    app.session.messages.push({ role: 'user', content: 'read it' });
    app.session.messages.push({ role: 'tool', tool_call_id: 't1', content: 'SECRET-TOOL-DUMP 40000 lines' });
    app.session.messages.push({ role: 'assistant', content: 'done' });
    const conv = state.conversation(app.session);
    assert.deepStrictEqual(conv.map((m) => m.role), ['user', 'assistant']);
    assert.ok(!JSON.stringify(conv).includes('SECRET-TOOL-DUMP'));
  });

  await test('APP: provenance rides the message it belongs to', async () => {
    const app = appAt(tmpdir('app-'));
    app.session.messages.push({ role: 'user', content: 'explain it' });
    app.session.messages.push({
      role: 'assistant', content: 'here you go',
      provenance: { label: 'ChatGPT.com · gpt-x', sourceId: 'chatgpt-web' },
    });
    const conv = state.conversation(app.session);
    assert.strictEqual(conv[1].provenance.label, 'ChatGPT.com · gpt-x');
    assert.strictEqual(conv[0].provenance, null, 'a user message has none');
  });

  // ------------------------------------------------------------- the routes --

  await test('APP: an unknown route is 404, never a fall-through', async () => {
    const r = await routes.dispatch(appAt(tmpdir('app-')), 'POST', '/api/nope', {});
    assert.strictEqual(r.code, 404);
  });

  await test('APP: a route that throws reports the reason', async () => {
    // A button that does nothing for no stated reason is indistinguishable from
    // a broken build.
    const broken = { get session() { throw new Error('boom'); } };
    const r = await routes.dispatch(broken, 'GET', '/api/state', {});
    assert.strictEqual(r.code, 500);
    assert.match(r.body.why, /boom/);
  });

  await test('APP: an empty prompt is refused rather than submitted', async () => {
    const r = await routes.dispatch(appAt(tmpdir('app-')), 'POST', '/api/turn', { text: '   ' });
    assert.strictEqual(r.code, 400);
  });

  await test('APP: a sentence typed into a working session is a STEER, not a refusal', async () => {
    // THE CONTRACT CHANGED (2026-09-15). This was a flat 409, which is the right
    // answer to "two uncontrolled turns in one session" and the wrong answer to
    // what a person is actually doing — adding a sentence to work in progress.
    // The terminal has always queued that as a steer; the window now uses the
    // same contract rather than a second one. See routes.js `POST /api/turn`.
    const app = appAt(tmpdir('app-'));
    app.abort = new AbortController();
    const r = await routes.dispatch(app, 'POST', '/api/turn', { text: 'also check the logs' });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.steered, true, 'it was taken as a steer');
    assert.strictEqual(app.waitingSteers().length, 1, 'and it is queued for the turn in flight');
    // AND IT IS THE USER'S OWN TEXT, unchanged — nothing composes here.
    assert.match(app.steerQueue[0].text, /also check the logs/);
  });

  await test('APP: asking goes through `app.handle`, the ONE door', () => {
    // Not `submit`, and never `runTurn`. `handle` is where a command is
    // recognised, an open question is answered, a composed goal is captured and
    // the input gateway admits or holds a sentence. A second entry point would
    // be a second set of rules for the same words.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/harnessapp/routes'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(/app\.handle\(/.test(src), 'it must submit through handle');
    assert.ok(!/app\.submit\(/.test(src), 'and never through submit');
    assert.ok(!/runTurn/.test(src), 'and never through the turn loop directly');
  });

  await test('APP: navigating between sessions is never refused by a running turn', async () => {
    // THE CONTRACT CHANGED AGAIN (2026-09-15), and this is the correction the
    // 2026-09-14 version got wrong. Refusing to OPEN session B because session A
    // is working is a lock on the application, not a safety property: a running
    // turn belongs to its session, and looking at another one mutates nothing.
    //
    // WHAT IS STILL GUARDED, and it is the part that mattered: no second way for
    // a session to become live, and the terminal's session is not dragged along.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/harnessapp/sessionroutes'), 'utf8');
    assert.ok(!/app\.session\s*=/.test(src), 'a session is never assigned directly');
    assert.ok(/app\.pool\(\)/.test(src), 'it goes through the one set of live sessions');
    const routesSrc = fs.readFileSync(require.resolve('../../src/harnessapp/routes'), 'utf8');
    assert.ok(!/app\.adopt\(|Session\.resume/.test(routesSrc), 'routes.js itself opens nothing');

    // AND THE BEHAVIOUR, against a real App with a real turn in flight.
    const app = appAt(tmpdir('app-'));
    const mine = app.session.id;
    app.abort = new AbortController();               // session A is working

    const made = await routes.dispatch(app, 'POST', '/api/session/new', { lane: 'engineering' });
    assert.strictEqual(made.code, 200, 'a new session is created while A runs');
    assert.notStrictEqual(made.body.id, mine, 'and it is a different session');

    const cowork = await routes.dispatch(app, 'POST', '/api/session/new', { lane: 'cowork' });
    assert.strictEqual(cowork.code, 200, 'a Cowork session too — the lanes share no lock');

    const back = await routes.dispatch(app, 'POST', '/api/session/select', { id: mine });
    assert.strictEqual(back.code, 200, 'and A can be returned to');
    assert.strictEqual(back.body.running, true, 'with its turn still running');

    // THE TERMINAL WAS NOT MOVED. Its session, and its turn, are where they were.
    assert.strictEqual(app.session.id, mine, 'the terminal kept its session');
    assert.ok(app.abort && !app.abort.signal.aborted, 'and its turn was never touched');

    for (const id of [made.body.id, cowork.body.id]) require('../../src/sessionstore').forget(id);
  });

  await test('APP: closing a view keeps the conversation; deleting is its own verb', async () => {
    const app = appAt(tmpdir('app-'));
    const made = await routes.dispatch(app, 'POST', '/api/session/new', {});
    const id = made.body.id;
    assert.ok(require('../../src/session').Session.list(500).includes(id), 'it was written');

    const closed = await routes.dispatch(app, 'POST', '/api/session/close', { id });
    assert.strictEqual(closed.code, 200);
    // THE WHOLE POINT: the transcript is still there and `/resume` can reach it.
    assert.ok(require('../../src/session').Session.list(500).includes(id), 'closing kept it');
    assert.ok(require('../../src/session').Session.resume(id), 'and it still resumes');

    const gone = await routes.dispatch(app, 'POST', '/api/session/delete', { id });
    assert.strictEqual(gone.code, 200);
    assert.ok(!require('../../src/session').Session.list(500).includes(id), 'deleting removed it');
  });

  // ------------------------------------------------------ no second truth --

  await test('APP: the read model DERIVES nothing — it reads the owners', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/harnessapp/state'), 'utf8');
    for (const owner of ['harnesssurface', 'sessionindex', 'modelsource/registry', 'ui/panes', 'workshop', 'goal']) {
      assert.ok(src.includes(owner), `the read model must consume ${owner} rather than re-deriving it`);
    }
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // A VERDICT COMPUTED HERE would be a second answer to the only question the
    // program exists to answer honestly.
    assert.ok(!/PASSED|FAILED|INCONCLUSIVE/.test(code), 'the app must not compute a verdict');
  });

  await test('APP: polling opens nothing — discovery and the Workshop are POSTs', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/harnessapp/state'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // A poll that could launch a browser launches one every two seconds.
    assert.ok(!/discoverModels|\.open\(|\.connect\(|ensureCatalog/.test(src),
      'the polled read must not launch, connect or refresh anything');
    assert.ok(routes.ROUTES['POST /api/source/models'], 'discovery is an explicit route');
    assert.ok(routes.ROUTES['POST /api/workshop/open'], 'and so is opening the Workshop');
  });

  // -------------------------------------------------------------- the page --

  await test('APP: the page is one self-contained document with valid script', () => {
    const html = page.html();
    assert.match(html, /<!doctype html>/i);
    assert.ok(!/<script[^>]+src=/.test(html), 'no external script — there is no build step and no CDN');
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 2, 'the app and the workshop scripts are both present');
    for (const b of blocks) {
      // A TEMPLATE LITERAL THAT COMPOSES IS NOT JAVASCRIPT THAT PARSES. A
      // stray backtick in a comment ended the string and shipped a broken page
      // that still "rendered" — found by running this.
      assert.doesNotThrow(() => new Function(b), 'the emitted client script must parse');
    }
  });

  await test('APP: there is no HTTP surface left to authenticate to', () => {
    // ---- THREE TESTS BECAME ONE, BECAUSE THE THING THEY GUARDED IS GONE ---
    //
    // They pinned the loopback listener's credential rules: a session in a
    // header rather than a URL, loopback-only binding, and a single-use launch
    // token spent before it was compared. Every one of those was correct, and
    // all of them were about a transport that existed so the Harness could be a
    // page in somebody's Chrome.
    //
    // LAIN Desktop replaced it (2026-09-15). The window is LAIN's own process,
    // reached over a private named pipe whose secret is proven on the first
    // message — there is no port, no cookie, no URL and no token, so there is
    // nothing left for those rules to be true OF.
    //
    // WHAT REPLACES THEM: the channel's own refusal, proved against a real pipe
    // in tests/smoke/desktop-real.test.js, and the boundary guards in
    // tests/unit/desktopboundary.test.js. What is asserted here is that the old
    // surface did not quietly survive.
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'src', 'harnessapp');
    for (const gone of ['server.js', 'localauth.js', 'desktop.js']) {
      assert.ok(!fs.existsSync(path.join(dir, gone)), `${gone} is gone, not merely unused`);
    }
    // AND NOTHING REACHES FOR THEM.
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!/require\('\.\/(server|localauth|desktop)'\)/.test(src), `${f} still requires a removed module`);
    }
    // AND THE PAGE CARRIES NO LOGIN OF ANY KIND.
    const html = page.html();
    assert.ok(!/<input[^>]*type=["']?password/i.test(html), 'no password field');
    assert.ok(!/api\/login/i.test(html), 'nothing posts a login');
    assert.ok(!/__LAIN_HANDED__/.test(html), 'and no session is handed to the document');
  });
};
