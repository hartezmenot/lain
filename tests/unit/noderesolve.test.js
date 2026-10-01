'use strict';

/**
 * FINDING NODE — the six answers, and the one that has to be right on Windows.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS TESTED AT ALL, given "it worked on my machine".
 *
 * It worked in a TERMINAL. LAIN Desktop is launched from a shortcut, and a
 * shortcut does not inherit a developer's PATH — so the one environment the
 * resolver exists for is the one nobody develops in. These drive the resolver
 * with the environment a shortcut actually gets.
 *
 * The real installation on this machine is used where it exists, because
 * `C:\Program Files\nodejs\node.exe` is the specific answer that has to come
 * back, space and all.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const resolve = require('../../src/noderesolve');

/** A real executable file to point at, so `usable` has something true to find. */
function fakeNode(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '');
  return p;
}

module.exports = async function () {
  await test('NODE: the interpreter already running Noema is the best answer', () => {
    const r = resolve.find();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exe, process.execPath, 'it is the Node that got here');
    assert.match(r.how, /already running/);
    // AND IT IS A REAL FILE, which is the only thing that makes it the best
    // answer rather than merely the nearest one.
    assert.ok(resolve.usable(r.exe));
  });

  await test('NODE: found on PATH when nothing is running it', () => {
    const dir = tmpdir('node-path-');
    const exe = fakeNode(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    const r = resolve.find({ self: null, env: { PATH: `${dir}` } });
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(r.exe, exe);
    assert.strictEqual(r.how, 'PATH');
  });

  await test('NODE: missing from PATH, found where Windows installs it', () => {
    if (process.platform !== 'win32') return;
    // THE CASE THAT PRODUCED "a node error": a launch with no useful PATH on a
    // machine where Node is installed exactly where the installer puts it.
    const r = resolve.find({ self: null, env: { PATH: '', ProgramFiles: 'C:\\Program Files' } });
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(r.exe, 'C:\\Program Files\\nodejs\\node.exe');
    assert.match(r.how, /standard Windows/);
  });

  await test('NODE: a path with spaces survives, because nothing is ever quoted', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lain node dir-'));
    const dir = path.join(base, 'Program Files', 'nodejs');
    const exe = fakeNode(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    assert.ok(exe.includes(' '), 'the fixture really has a space in it');

    // FOUND ON PATH …
    const viaPath = resolve.find({ self: null, env: { PATH: dir } });
    assert.strictEqual(viaPath.exe, exe, viaPath.why);
    // … AND AS A CONFIGURED OVERRIDE.
    const viaCfg = resolve.find({ self: null, env: {}, cfg: { nodePath: exe } });
    assert.strictEqual(viaCfg.exe, exe, viaCfg.why);

    // AND WHAT COMES BACK IS A PATH, NOT A COMMAND LINE. A caller spawns
    // { exe, args } with an argument array; a quoted string is a second
    // escaping problem that only appears on the machines that have the space.
    assert.ok(!/^"/.test(viaPath.exe) && !/"$/.test(viaPath.exe), 'never pre-quoted');
  });

  await test('NODE: a configured path wins over everything that would be searched', () => {
    const dir = tmpdir('node-cfg-');
    const mine = fakeNode(dir, 'my-node.exe');
    const other = tmpdir('node-other-');
    fakeNode(other, process.platform === 'win32' ? 'node.exe' : 'node');
    const r = resolve.find({ self: null, env: { PATH: other }, cfg: { nodePath: mine } });
    assert.strictEqual(r.exe, mine, 'the override is not outvoted by a search');
    assert.match(r.how, /configured/);

    // LAIN_NODE IS THE SAME DECISION, made in the environment.
    const viaEnv = resolve.find({ self: null, env: { PATH: other, LAIN_NODE: mine } });
    assert.strictEqual(viaEnv.exe, mine);
  });

  await test('NODE: an invalid configured path is an ERROR, never a silent fallback', () => {
    // Falling through to a search would run a DIFFERENT Node than the one the
    // person named — the exact bug an override exists to prevent, and one that
    // would only be noticed as strange behaviour much later.
    const dir = tmpdir('node-bad-');
    fakeNode(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    const r = resolve.find({ self: null, env: { PATH: dir }, cfg: { nodePath: path.join(dir, 'not-here.exe') } });
    assert.strictEqual(r.ok, false, 'it refuses rather than substituting');
    assert.match(r.why, /configured Node path does not exist/);
    assert.match(r.why, /not-here\.exe/, 'and it names the path that was wrong');
  });

  await test('NODE: genuinely unavailable says WHAT was searched, not "node error"', () => {
    const empty = tmpdir('node-empty-');
    const r = resolve.find({ self: null, env: { PATH: empty }, roots: [] });
    assert.strictEqual(r.ok, false);
    // THE DIAGNOSTIC IS THE FEATURE. A person who can see node.exe in Explorer
    // and is told "node error" has been told nothing.
    assert.ok(Array.isArray(r.searched) && r.searched.length, 'it reports where it looked');
    assert.match(r.why, /PATH/, 'PATH was searched, and says so');
    assert.match(r.why, /nodejs\.org|nodePath/, 'and it says what to do about it');
    // AND THE STANDARD INSTALL IS PART OF THE SEARCH on a real machine — proved
    // separately, because on THIS machine it is where Node actually is.
    if (process.platform === 'win32') {
      const real = resolve.find({ self: null, env: { PATH: empty } });
      assert.strictEqual(real.ok, true, 'the standard Windows location is searched for real');
      assert.match(real.exe, /nodejs.node\.exe$/i);
    }
  });

  await test('NODE: `must` throws the same diagnostic rather than a bare failure', () => {
    const empty = tmpdir('node-must-');
    assert.throws(
      () => resolve.must({ self: null, env: { PATH: empty }, roots: [] }),
      (e) => /could not be found/.test(e.message) && Array.isArray(e.searched),
    );
    assert.strictEqual(resolve.must().exe, process.execPath, 'and returns normally when it can');
  });
};
