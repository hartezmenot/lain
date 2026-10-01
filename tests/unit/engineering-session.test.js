'use strict';

/**
 * THE ENGINEERING SESSION — chat and coding in ONE session, and the boundary
 * between them.
 *
 * ------------------------------------------------------------------------
 * THE PRODUCT FACT UNDER TEST.
 *
 * A person asks why checkout is failing, asks to see the architecture, says
 * "implement the fix and run the tests", then asks why router.js changed. Four
 * turns, one session, one project, one history — and only the third is coding.
 * Nobody should have to start a new session because the next sentence changed
 * register, and nothing about selecting ChatGPT.com may change who writes a file.
 *
 * ------------------------------------------------------------------------
 * PHASE 8.3: the website sources (ChatGPT.com, Gemini) are REMOVED, not just
 * retired — their adapters, sign-in and check tooling and the web chat
 * transport are gone. What stays proved: they cannot be selected, a session
 * saved on one resumes on LAIN with its conversation intact, and the leftover
 * browser-profile guards still hold.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

const fs = require('fs');
const path = require('path');
const registry = require('../../src/modelsource/registry');
const { SOURCE } = require('../../src/modelsource/contract');
const { Session } = require('../../src/session');

/** An App just real enough for the registry. Nothing here touches a provider. */
function appWith() {
  const session = new Session({ cwd: process.cwd() });
  return { session, cfg: {}, events: { emit: () => null }, render: { notice: () => {}, write: () => {} }, transient: () => {} };
}

module.exports = async function () {
  await test('REMOVED (8.3): the website adapters, their sign-in and the web chat transport are gone from Core', () => {
    const src = path.join(__dirname, '..', '..', 'src');
    for (const f of ['modelsource/chatgpt.js', 'modelsource/gemini.js', 'modelsource/webmodel.js', 'modelsource/websurface.js', 'modelsource/pageops.js', 'modelsource/signin.js', 'modelsource/check.js', 'modelsource/fixture.js', 'chatdispatch.js']) {
      assert.ok(!fs.existsSync(path.join(src, f)), `${f} is deleted`);
    }
    const app = appWith();
    assert.strictEqual(registry.get(app, SOURCE.CHATGPT_WEB), null, 'nothing can construct one');
    assert.strictEqual(registry.get(app, SOURCE.GEMINI_WEB), null);
    assert.ok(registry.get(app, SOURCE.LAIN), 'Noema is the one chat source');
  });

  // ---------------------------------------------------------------- lanes --

  await test('RETIRED: the ChatGPT and Gemini website sources cannot be selected; Noema is the only chat source', () => {
    const app = appWith({ source: SOURCE.LAIN });
    for (const id of [SOURCE.CHATGPT_WEB, SOURCE.GEMINI_WEB]) {
      const r = registry.selectSource(app, id);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.retired, true);
      assert.match(r.why, /retired/);
    }
    assert.deepStrictEqual(registry.DECLARED.map((d) => d.id), [SOURCE.LAIN]);
    assert.strictEqual(registry.selectSource(app, 'claude-web').ok, false, 'an unknown source is refused, not guessed at');
  });

  await test('RETIRED: a session saved on a website source resumes on Noema, its conversation untouched', () => {
    const s = new Session({ cwd: tmpdir('engsess-') });
    s.chatSource = SOURCE.CHATGPT_WEB;
    s.messages.push({ role: 'user', content: 'explain the router' }, { role: 'assistant', content: 'it dispatches by prefix', provenance: { sourceId: SOURCE.CHATGPT_WEB } });
    s.save();
    const back = Session.resume(s.id);
    assert.strictEqual(back.chatSource, null, 'answers from Noema again');
    assert.strictEqual(back.messages.length, 2, 'the old conversation is kept');
    assert.strictEqual(back.messages[1].provenance.sourceId, SOURCE.CHATGPT_WEB, 'and still says where it came from');
  });

  // ------------------------------------------------------ one history -----

  // ------------------------------------------------------ source switching --

  // --------------------------------------------------------- persistence ---

  await test('RESUME: a session written before web sources existed reads as Noema', () => {
    const s = new Session({ cwd: tmpdir('old-') });
    s.save();
    const raw = require('fs').readFileSync(s.file(), 'utf8');
    const data = JSON.parse(raw);
    delete data.chatSource; delete data.sourceSelections; delete data.providerBindings;
    require('fs').writeFileSync(s.file(), JSON.stringify(data));
    const back = Session.resume(s.id);
    assert.strictEqual(back.chatSource, null);
    assert.deepStrictEqual(back.sourceSelections, {});
    assert.deepStrictEqual(back.providerBindings, {});
  });

  // ------------------------------------------------------ context policy ---

  // ------------------------------------------------ the profile boundary ---

  await test('PROFILE: the web-model profile never overlaps the verification browser profile', () => {
    const webprofile = require('../../src/modelsource/webprofile');
    const os = require('os');
    const path = require('path');
    // The verification harness mints its profile with mkdtemp under the system
    // temp directory (harness/browserharness.js `_launch`). These two must not
    // be able to reach each other: one holds a person's logged-in sessions, the
    // other drives the code under test.
    const verification = path.join(os.tmpdir(), 'lain-browser-abc123');
    assert.strictEqual(webprofile.isolatedFrom(verification).ok, true);
    assert.strictEqual(webprofile.isolatedFrom(webprofile.root()).ok, false, 'the guard must actually detect an overlap');
  });

  await test('PROFILE: the authenticated browser is closed on every exit path', async () => {
    // A headful browser holding a login is deliberately NOT a task-managed
    // process — killing it when a verification finishes would log somebody out
    // of ChatGPT for running the tests. The cost of that decision is that
    // something has to close it at the end, and forgetting would leave a window
    // on screen after LAIN is gone. Both exits (`repl.js` and `app.once`) go
    // through harnesslink.shutdown, so that is where it is asserted.
    const webbrowser = require('../../src/modelsource/webbrowser');
    const app = appWith();
    let closed = 0;
    app._webModelBrowser = { closeAll: async () => { closed += 1; return { ok: true }; } };
    await require('../../src/harnesslink').shutdown(app);
    assert.strictEqual(closed, 1, 'the web model browser must be closed on exit');
    // And it is CLOSING, not forgetting: nothing here removes a saved profile.
    const src = require('fs').readFileSync(require.resolve('../../src/harnesslink'), 'utf8');
    assert.ok(!/webprofile|forget/.test(src), 'shutting down must never delete a login');
    assert.strictEqual(typeof webbrowser.forApp, 'function');
  });

  await test('PROFILE: a source id cannot escape the web-model profile root', () => {
    const webprofile = require('../../src/modelsource/webprofile');
    const path = require('path');
    // TWO GUARDS, AND THE TEST WANTS BOTH. `slug` reduces an id to one safe path
    // segment, so a traversal attempt lands INSIDE the root rather than throwing;
    // the containment check behind it is what catches anything slug ever misses.
    // The id is a declared constant today and will one day come from a config
    // file or a plugin, which is when this stops being theoretical.
    const escaped = webprofile.pathFor('../../.ssh');
    assert.ok(path.resolve(escaped).startsWith(path.resolve(webprofile.root()) + path.sep), escaped);
    assert.throws(() => webprofile.pathFor(''), /source id/);
    assert.throws(() => webprofile.pathFor('...'), /source id/);
  });
};
