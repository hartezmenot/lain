'use strict';

/**
 * WINDOWS "OPEN WITH LAIN" (§12, §13, §53 — 2026-09-29).
 *
 *   - LAIN is an AVAILABLE handler: a ProgID, Applications\LAIN.exe with its
 *     SupportedTypes, `OpenWithProgids` on every development extension, "Open with
 *     LAIN" on those types, and "Open folder in LAIN" on folders — never the
 *     `(Default)` of an extension key and never UserChoice: no default is taken
 *   - the writes really work: a round trip through the REAL reg.exe into a SCRATCH
 *     hive (never the person's associations), read back, then removed
 *   - `LAIN.exe <path>` opens the PROJECT the file belongs to and then the file;
 *     a folder is opened as the project
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const wa = require('../../src/winassoc');
  const op = require('../../src/openpath');
  const EXE = 'C:\\Users\\me\\.lain-v2\\desktop\\lainw.exe';

  await test('OPEN WITH: every development type offers LAIN — and no extension\'s default program is ever written', () => {
    const p = wa.plan(EXE);
    const keys = p.map((a) => [a[1], a.includes('/ve') ? '(Default)' : a[a.indexOf('/v') + 1]]);
    for (const e of ['py', 'js', 'ts', 'rs', 'md', 'json', 'sql', 'sh']) {
      assert.ok(keys.some(([k, v]) => k === `${wa.HIVE}\\.${e}\\OpenWithProgids` && v === 'LAIN.Harness.File'), `.${e} lists LAIN in Open with`);
      assert.ok(keys.some(([k]) => k === `${wa.HIVE}\\SystemFileAssociations\\.${e}\\shell\\LAIN.Harness.Open\\command`), `.${e} has "Open with LAIN"`);
    }
    // NEVER THE DEFAULT: nothing is written to `.ext` itself (its (Default) is the program a double-click runs), nor UserChoice.
    assert.ok(!keys.some(([k, v]) => /\\\.[a-z0-9]+$/i.test(k) && v === '(Default)'), 'no extension default');
    assert.ok(!p.some((a) => /UserChoice/i.test(a[1])), 'no UserChoice');
    // THE FOLDER: on the folder and inside it.
    const cmd = (key) => { const a = p.find((x) => x[1] === `${wa.HIVE}\\${key}` && x.includes('/ve')); return a && a[a.indexOf('/d') + 1]; };
    assert.strictEqual(cmd('Directory\\shell\\LAIN.Harness.Open'), 'Open folder in LAIN');
    assert.strictEqual(cmd('Directory\\shell\\LAIN.Harness.Open\\command'), `"${EXE}" "%1"`);
    assert.strictEqual(cmd('Directory\\Background\\shell\\LAIN.Harness.Open\\command'), `"${EXE}" "%V"`);
    assert.strictEqual(cmd('LAIN.Harness.File\\shell\\open\\command'), `"${EXE}" "%1"`);
    assert.strictEqual(wa.EXTENSIONS.length, 39);
    // REMOVAL deletes LAIN's value in OpenWithProgids — never the extension key.
    assert.ok(wa.unplan().every((a) => !/\\\.[a-z0-9]+$/i.test(a[1]) || a.includes('/v')), 'only values under .ext are removed');
  });

  await test('OPEN WITH: a real reg.exe round trip into a SCRATCH hive — written, read back, removed', () => {
    if (process.platform !== 'win32') return;
    const root = `HKCU\\Software\\LAIN-Test-${process.pid}-${Date.now().toString(36)}`;
    const hive = `${root}\\Classes`;
    try {
      const r = wa.register({ exe: EXE, hive, extensions: ['py', 'rs'] });
      assert.ok(r.ok, JSON.stringify(r.failed));
      const st = wa.status({ hive });
      assert.deepStrictEqual([st.registered, st.exe], [true, EXE]);
      const q = spawnSync('reg.exe', ['query', `${hive}\\.py\\OpenWithProgids`, '/v', 'LAIN.Harness.File'], { encoding: 'utf8' });
      assert.strictEqual(q.status, 0, 'OpenWithProgids holds LAIN.Harness.File');
      const d = spawnSync('reg.exe', ['query', `${hive}\\.py`, '/ve'], { encoding: 'utf8' });
      assert.ok(d.status !== 0 || !/REG_SZ\s+(?!\(value not set\))\S/.test(d.stdout), `the .py default is untouched: ${d.stdout}`);
      wa.unregister({ hive, extensions: ['py', 'rs'] });
      assert.strictEqual(wa.status({ hive }).registered, false);
      const gone = spawnSync('reg.exe', ['query', `${hive}\\.py\\OpenWithProgids`, '/v', 'LAIN.Harness.File'], { encoding: 'utf8' });
      assert.notStrictEqual(gone.status, 0, 'LAIN\'s value is removed');
    } finally { spawnSync('reg.exe', ['delete', root, '/f'], { windowsHide: true }); }
  });

  await test('OPEN A FILE: the project it belongs to (nearest marker), then the file; a loose file opens its folder; a folder is the project', () => {
    const dir = tmpdir('openpath-');
    const proj = path.join(dir, 'cheate');
    fs.mkdirSync(path.join(proj, 'crates', 'inspect', 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'Cargo.toml'), '[workspace]\n');
    const file = path.join(proj, 'crates', 'inspect', 'src', 'main.rs');
    fs.writeFileSync(file, 'fn main() {}\n');
    fs.writeFileSync(path.join(proj, 'crates', 'inspect', 'Cargo.toml'), '[package]\n');
    const t = op.resolveTarget(file);
    assert.deepStrictEqual([t.ok, t.dir, t.root, t.rel], [true, false, path.join(proj, 'crates', 'inspect'), 'src/main.rs'], 'the nearest project wins');
    const loose = path.join(dir, 'notes.txt'); fs.writeFileSync(loose, 'x');
    assert.strictEqual(op.resolveTarget(loose).root, dir);
    const f = op.resolveTarget(`"${proj}"`);
    assert.deepStrictEqual([f.dir, f.root, f.rel], [true, proj, null], 'quotes from a shell are tolerated');
    assert.strictEqual(op.resolveTarget(path.join(dir, 'missing.py')).ok, false);
  });

  await test('OPEN A FILE: opening it sets the project on the session and asks the window, once, for the IDE with the file in focus', async () => {
    const { App } = require('../../src/app');
    const dir = tmpdir('openpath-app-');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'app.py'), 'print(1)\n');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('openpath-cwd-') });
    const r = await op.open(app, path.join(dir, 'src', 'app.py'));
    assert.ok(r.ok, r.why);
    assert.strictEqual(path.resolve(app.session.cwd).toLowerCase(), path.resolve(dir).toLowerCase(), 'the project is the file\'s project');
    const nav = app._uiNavigate;
    assert.deepStrictEqual([nav.surface, nav.args.openFile, nav.args.focus], ['ide', 'src/app.py', 'editor']);
    const again = await op.open(app, path.join(dir, 'src', 'app.py'));
    assert.ok(again.ok);
    assert.strictEqual(app._uiNavigate.seq, nav.seq + 1, 'each open is a new, once-only navigation');
  });
};
