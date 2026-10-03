'use strict';

/**
 * CLI UX PASS (2026-09-23): the command row's output tail and the footer.
 *
 * A shell call is drawn as `› cmd`, the LAST lines of what it printed (with a
 * muted count of what came before), then `Command completed in … · exit code …`.
 * The footer is one row of key hints that are true right now: how to stop and
 * inspect a running turn, or how to reach commands and files when idle. It
 * repeats nothing the header says, and it gives way to an open panel.
 */

const assert = require('assert');
const { test } = require('../helpers');
const describe = require('../../src/describe');
const shellrow = require('../../src/ui/shellrow');
const footer = require('../../src/ui/footer');

module.exports = async function run() {
  await test('output tail: last lines, earlier count, no [via] stamp, no bracket markers', () => {
    const t = describe.outputTail('[via shell: bash · cwd=C:/tmp/x]\none\ntwo\n\nthree\nfour\nfive\n[exit 1]');
    assert.deepStrictEqual(t.tail, ['two', 'three', 'four', 'five']);
    assert.strictEqual(t.lines, 5);
    const rec = describe.actionRecord({ name: 'run_bash', input: { command: 'npm test' } }, { output: 'ok 1\nok 2', exitCode: 0 }, { ms: 1200 });
    assert.deepStrictEqual(rec.tail, ['ok 1', 'ok 2']);
    const file = describe.actionRecord({ name: 'read_file', input: { path: 'a.js' } }, { output: 'secret contents' });
    assert.strictEqual(file.tail, undefined, 'a file\'s contents never become a tail');
  });

  await test('command row: › cmd, (N earlier lines), the tail as output rows, then the completion', () => {
    const out = [];
    shellrow.push(out, { name: 'run_powershell', target: 'git status --short', ok: true, ms: 412, exitCode: 0, ...describe.outputTail('a\nb\nc\nd\ne\nf') });
    const rows = out.map((r) => r.text);
    assert.deepStrictEqual(rows, ['› git status --short', '    (2 earlier lines)', '    c', '    d', '    e', '    f', '    Command completed in 0.4s · exit code 0']);
    assert.deepStrictEqual(out.map((r) => Boolean(r.out)), [false, false, true, true, true, true, false], 'only the output lines wear the text colour');
    const bad = [];
    shellrow.push(bad, { name: 'run_bash', target: 'npm test', ok: false, ms: 2000, exitCode: 1, ...describe.outputTail('1 failing') });
    assert.strictEqual(bad[0].text, '✗› npm test');
    assert.match(bad[bad.length - 1].text, /Command failed in 2\.0s · exit code 1/);
  });

  await test('footer: runtime-true hints — interrupt while running, commands when idle', () => {
    const P = { plain: (s) => s, meta: (s) => s };
    const idle = footer.line({ state: { run: { parts: ['AUTO'] } } }, 100, P);
    const busy = footer.line({ state: { run: { parts: ['RUNNING', '00:12'] } } }, 100, P);
    assert.match(idle, /\/ commands · @ files · shift\+tab mode$/);
    assert.match(busy, /esc interrupt · ctrl\+o activity · shift\+tab mode$/);
    assert.strictEqual(idle.length, 99, 'right-aligned inside the frame');
    assert.strictEqual(footer.line({ state: {} }, 20, P), '', 'too narrow: nothing rather than a clipped hint');
  });

  await test('footer: a row on a normal terminal, none with a panel open or on a short one', () => {
    const geometry = require('../../src/ui/geometry');
    const screen = (rows, panel = null) => ({ rows, panel, state: {}, _wrapped: () => [''], exitHint: null });
    assert.strictEqual(geometry.regions(screen(30)).footerRows, 1);
    assert.strictEqual(geometry.regions(screen(12)).footerRows, 0);
    const open = { visible: true, items: [1, 2, 3], kind: 'list', isCompletion: true };
    assert.strictEqual(geometry.regions(screen(30, open)).footerRows, 0, 'the panel sits in its place');
  });
};
