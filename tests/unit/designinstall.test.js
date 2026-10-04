'use strict';

/**
 * LAIN DESIGN AS A COMPONENT (D6): the release stages it as its own package (engine + pinned runtime dependencies,
 * nothing else) and it runs from there alone; an installed LAIN whose person unchecked it has no Design; Settings
 * shows and hides it; and the installer's C# carries the checkbox and the add/remove switches.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');

module.exports = async function () {
  const design = require('../../src/design');

  await test('DESIGN PAYLOAD: staged as its own package — the engine and exactly its pinned runtime dependencies — and it runs from there alone', () => {
    if (!design.installed().ok) { assert.ok(true, 'packages/design-core has no node_modules here (npm ci --omit=dev) — not staged'); return; }
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-app-'));
    const r = require('../../distribution/designpayload').stage(app);
    const want = require('../../distribution/designpayload').runtimePackages().map((x) => `${x.name}@${x.version}`).sort();
    assert.deepStrictEqual(r.dependencies.slice().sort(), want, 'exactly the lockfile\'s runtime packages');
    for (const top of ['@babel/parser', 'parse5', 'postcss']) assert.ok(want.some((w) => w.startsWith(`${top}@`)), top);
    assert.deepStrictEqual(fs.readdirSync(path.join(r.dir, 'node_modules')).filter((n) => !n.startsWith('.')).sort(), [...new Set(require('../../distribution/designpayload').runtimePackages().map((x) => x.name.split('/')[0]))].sort(), 'nothing else in node_modules');
    const pkg = JSON.parse(fs.readFileSync(path.join(r.dir, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.name, '@lain/design-core'); assert.strictEqual(r.version, pkg.version);
    // a child process that knows only the staged folder opens the fixture and edits it
    const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-fx-'));
    require('../designbench').copyDir(path.join(__dirname, '..', 'fixtures', 'design', 'chat-messenger'), fx);
    const out = execFileSync(process.execPath, ['-e', `
      process.env.LAIN_DESIGN_DIR = ${JSON.stringify(r.dir)};
      const d = require(${JSON.stringify(path.join(ROOT, 'src', 'design.js'))});
      const E = d.load();
      const p = E.open(${JSON.stringify(fx)});
      const me = p.scanElements('index.html').find((e) => e.attrs.id === 'me');
      const res = p.applyEdit({ op: 'setStyle', node: me.id, props: { width: '48px' } });
      console.log(JSON.stringify({ at: d.installed(), kind: p.kind, ok: res.ok, from: Object.keys(require.cache).filter((k) => k.includes('design-core')).length }));
    `], { encoding: 'utf8' });
    const j = JSON.parse(out.trim().split('\n').pop());
    assert.ok(j.at.ok); assert.strictEqual(path.resolve(j.at.dir), path.resolve(r.dir));
    assert.strictEqual(j.kind, 'web-html'); assert.ok(j.ok);
    assert.strictEqual(j.from, 0, 'nothing was loaded from the source tree\'s packages/design-core');
  });

  await test('DESIGN COMPONENT: an installed LAIN with "design": false has no Design; an install from before Design (no key) has it', () => {
    const prev = process.env.LAIN_INSTALL_ROOT;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-inst-'));
    try {
      process.env.LAIN_INSTALL_ROOT = root;
      fs.writeFileSync(path.join(root, 'components.json'), JSON.stringify({ cli: true, harness: true, design: false }));
      assert.strictEqual(require('../../src/components').read().design, false);
      const at = design.installed();
      assert.strictEqual(at.ok, false); assert.match(at.why, /Add it with the LAIN installer/);
      fs.writeFileSync(path.join(root, 'components.json'), JSON.stringify({ cli: true, harness: true }));
      assert.strictEqual(require('../../src/components').read().design, true, 'absent = on');
    } finally { if (prev == null) delete process.env.LAIN_INSTALL_ROOT; else process.env.LAIN_INSTALL_ROOT = prev; }
  });

  await test('DESIGN SETTINGS: Settings › General › Components shows LAIN Design; turning it off hides it without uninstalling', async () => {
    const settings = require('../../src/settings');
    const cfg = {};
    const app = { cfg, session: { cwd: os.tmpdir() } };
    const prevSave = require('../../src/config').save;
    require('../../src/config').save = () => {};
    try {
      const sch = await settings.schema(app);
      const fld = sch.sections.find((s) => s.id === 'GENERAL').fields.find((x) => x.key === 'general.design.enabled');
      assert.ok(fld, 'the field exists'); assert.strictEqual(fld.group, 'Components');
      if (design.installed().ok) {
        assert.strictEqual(fld.value, true);
        const r = await settings.update(app, 'general.design.enabled', false);
        assert.ok(r.ok, r.why);
        assert.strictEqual(design.enabled(app), false);
        const st = await require('../../src/harnessapp/routes').dispatch(app, 'POST', '/api/design/open', {});
        assert.strictEqual(st.body.ok, false); assert.ok(st.body.disabled);
        assert.ok((await settings.update(app, 'general.design.enabled', true)).ok);
      } else {
        assert.strictEqual(fld.editable, false); assert.match(fld.why, /installer/);
      }
    } finally { require('../../src/config').save = prevSave; }
  });

  await test('DESIGN INSTALLER: the setup window has the LAIN Design checkbox (on by default); setup takes --design/--no-design/--add-design/--remove-design; components.json records it', () => {
    const setup = fs.readFileSync(path.join(ROOT, 'distribution', 'setup.cs'), 'utf8');
    const ui = fs.readFileSync(path.join(ROOT, 'distribution', 'setupui.cs'), 'utf8');
    const rel = fs.readFileSync(path.join(ROOT, 'distribution', 'release.js'), 'utf8');
    assert.match(setup, /public bool Design = true;/);
    for (const flag of ['--design', '--no-design', '--add-design', '--remove-design']) assert.ok(setup.includes(`"${flag}"`), flag);
    assert.match(setup, /\\"design\\": " \+ \(Design \? "true" : "false"\)/);
    assert.match(setup, /public static int SetDesign\(/);
    assert.match(ui, /LAIN Design — visual editing of app screens/);
    assert.match(ui, /Installer\.SetDesign\(o, design\.Checked, Say\)/);
    assert.match(rel, /require\('\.\/designpayload'\)\.stage\(app\)/);
    assert.match(rel, /--no-design/);
  });
};
