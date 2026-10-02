'use strict';

/**
 * WINDOWS STARTUP (consolidation §5–§10) and LAIN'S LEFTOVERS (§2–§4), against a temporary Startup folder and home.
 *
 * Real Windows shortcuts are written — into APPDATA redirected to a temp directory, never the person's own Startup
 * folder — and read back through the Shell. The registry half of legacy cleanup is not exercised here (it would be
 * the real HKCU); tests/acceptance covers it with the keys exported first.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const startup = require('../../src/startup');

const WIN = process.platform === 'win32';

/** A temp APPDATA, a temp install root holding a launcher, a temp config home — restored afterwards. */
async function sandbox(fn, { launcher = true } = {}) {
  const saved = { APPDATA: process.env.APPDATA, LAIN_INSTALL_ROOT: process.env.LAIN_INSTALL_ROOT, LAIN_CONFIG_DIR: process.env.LAIN_CONFIG_DIR };
  const appdata = tmpdir('startup-appdata-');
  const root = tmpdir('startup-install-');
  const home = tmpdir('startup-home-');
  if (launcher) fs.writeFileSync(path.join(root, 'LAIN Harness.exe'), 'MZ');
  Object.assign(process.env, { APPDATA: appdata, LAIN_INSTALL_ROOT: root, LAIN_CONFIG_DIR: home });
  try { return await fn({ appdata, root, home, exe: path.join(root, 'LAIN Harness.exe') }); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
}

module.exports = async function () {
  await test('STARTUP: off by default — nothing is registered for a person who never asked', () => sandbox(() => {
    assert.deepStrictEqual(startup.DEFAULTS, { harness: false, minimized: false, restoreWorkspace: true });
    const cfg = {};
    const r = startup.sync(cfg);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.registered, false);
    assert.ok(!fs.existsSync(startup.linkPath()), 'no shortcut appears without a choice');
    assert.deepStrictEqual(cfg, {}, 'and the config is not written on the person\'s behalf');
  }));

  await test('STARTUP: ON writes a per-user shortcut to the version-independent launcher with --startup; OFF removes it', () => sandbox(({ exe, appdata }) => {
    if (!WIN) return;
    const cfg = { startup: { harness: true } };
    const r = startup.sync(cfg);
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(r.registered, true);
    assert.ok(startup.linkPath().startsWith(appdata), 'per-user: under the person\'s own Startup folder, no administrator');
    const st = startup.status(cfg);
    const real = (p) => fs.realpathSync.native(p).toLowerCase();
    assert.strictEqual(real(st.target), real(exe), 'the canonical launcher, never a version folder');
    assert.ok(!/versions[\\/]/i.test(st.target));
    assert.strictEqual(st.consistent, true);
    const t = fs.statSync(startup.linkPath()).mtimeMs;
    assert.strictEqual(startup.sync(cfg).registered, true);
    assert.strictEqual(fs.statSync(startup.linkPath()).mtimeMs, t, 'idempotent: an up-to-date shortcut is left alone');
    cfg.startup.harness = false;
    assert.strictEqual(startup.sync(cfg).registered, false);
    assert.ok(!fs.existsSync(startup.linkPath()), 'turning it off removes the entry');
  }));

  await test('STARTUP: no Harness, no entry — removing the Harness leaves no dead shortcut, and the choice is kept', () => sandbox(({ exe }) => {
    if (!WIN) return;
    const cfg = { startup: { harness: true } };
    assert.strictEqual(startup.sync(cfg).registered, true);
    fs.unlinkSync(exe);                                            // the Harness component is removed
    const r = startup.sync(cfg);
    assert.strictEqual(r.registered, false);
    assert.match(r.why, /not installed/);
    assert.ok(!fs.existsSync(startup.linkPath()), 'no dead entry');
    assert.strictEqual(cfg.startup.harness, true, 'the person\'s choice survives, and is applied when the Harness returns');
    fs.writeFileSync(exe, 'MZ');
    assert.strictEqual(startup.sync(cfg).registered, true, 'add the Harness back: registered again');
  }));

  await test('STARTUP: LAIN\'s Startup shortcut carries the choice over once, then is removed; an explicit OFF is respected', () => sandbox(() => {
    if (!WIN) return;
    fs.mkdirSync(startup.startupDir(), { recursive: true });
    fs.writeFileSync(startup.legacyLinkPath(), 'old');
    let saved = 0;
    const cfg = {};
    const r = startup.sync(cfg, { save: () => { saved++; } });
    assert.strictEqual(r.migrated, true);
    assert.strictEqual(cfg.startup.harness, true, 'they chose to start LAIN at sign-in; LAIN Harness inherits it');
    assert.strictEqual(saved, 1, 'and it is saved');
    assert.ok(!fs.existsSync(startup.legacyLinkPath()), 'LAIN.lnk is gone');
    assert.ok(fs.existsSync(startup.linkPath()), 'LAIN Harness.lnk replaces it');

    fs.writeFileSync(startup.legacyLinkPath(), 'old');
    const off = { startup: { harness: false } };
    const r2 = startup.sync(off);
    assert.strictEqual(r2.migrated, false, 'a person who already turned it off is not turned back on');
    assert.ok(!fs.existsSync(startup.legacyLinkPath()));
    assert.ok(!fs.existsSync(startup.linkPath()));
  }));

  await test('STARTUP: Settings and `lain settings startup` write the same canonical setting', async () => sandbox(async ({ home }) => {
    if (!WIN) return;
    const lines = [];
    const out = { write: (s) => lines.push(s) };
    assert.strictEqual(startup.cli(['harness', 'on'], { out }), 0, lines.join(''));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).startup.harness, true);
    assert.ok(fs.existsSync(startup.linkPath()));
    assert.match(lines.join(''), /Start LAIN Harness with Windows: ON[\s\S]*registered →/);
    assert.strictEqual(startup.cli(['minimized', 'maybe'], { out }), 2, 'on|off only');

    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: home });
    const settings = require('../../src/settings');
    const keys = (await settings.schema(app)).sections.flatMap((s) => s.fields.filter((f) => f.group === 'Startup').map((f) => [f.key, f.value]));
    assert.deepStrictEqual(keys.map((k) => k[0]), ['general.startup.harness', 'general.startup.minimized', 'general.startup.restoreWorkspace']);
    assert.strictEqual((await settings.update(app, 'general.startup.harness', false)).ok, true);
    assert.ok(!fs.existsSync(startup.linkPath()), 'the Settings toggle made Windows match');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).startup.harness, false);
    assert.strictEqual((await settings.update(app, 'general.startup.minimized', 'yes')).ok, false, 'a boolean');
  }));

  await test('LEGACY: old LAIN launchers and builds in the home are removed once a LAIN launcher exists; LAIN state is kept', () => sandbox(({ home, exe, appdata }) => {
    const desk = path.join(home, 'desktop');
    fs.mkdirSync(desk, { recursive: true });
    for (const f of ['LAIN.exe', 'lain-desktop-0123abcd.exe', 'LAIN Harness.exe', 'keep.txt']) fs.writeFileSync(path.join(desk, f), 'x');
    const menu = path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    fs.mkdirSync(menu, { recursive: true });
    fs.writeFileSync(path.join(menu, 'LAIN.lnk'), 'x');
    const legacy = require('../../src/legacycleanup');
    const p = legacy.plan({ registry: false });
    assert.deepStrictEqual(p.executables.map((f) => path.basename(f)).sort(), ['LAIN.exe', 'lain-desktop-0123abcd.exe']);
    assert.strictEqual(p.openWith, false, 'the registry is not read in this test');
    const r = legacy.cleanup({ launcherExe: exe, cfg: {}, save: () => {}, registry: false });
    assert.ok(!fs.existsSync(path.join(desk, 'LAIN.exe')) && !fs.existsSync(path.join(desk, 'lain-desktop-0123abcd.exe')), r.kept.join('; '));
    assert.ok(fs.existsSync(path.join(desk, 'LAIN Harness.exe')) && fs.existsSync(path.join(desk, 'keep.txt')), 'LAIN\'s own files stay');
    assert.ok(!fs.existsSync(path.join(menu, 'LAIN.lnk')));
    assert.ok(r.done.some((l) => /removed LAIN\.exe/.test(l)));
    const again = legacy.plan({ registry: false });
    assert.strictEqual(again.executables.length + (again.startMenuLink ? 1 : 0), 0, 'nothing left to do');
  }));

  await test('COMPAT: the `noema` command is a shim onto the same LAIN — no Noema executable, no second home or pipe', () => {
    const code = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'bin', f), 'utf8').replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '');
    const lines = code('noema.js').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    assert.deepStrictEqual(lines, ['#!/usr/bin/env node', "'use strict';", "require('../src/boot').start({ via: 'noema' });"], 'one line: the same boot, marked as the old name');
    assert.ok(!/\.noema|noema\.exe|noema-supervisor|noema-core/i.test(code('noema.js') + code('lain.js')), 'neither names a Noema home, binary, supervisor or pipe');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    assert.strictEqual(pkg.name, 'lain');
    assert.deepStrictEqual(pkg.bin, { lain: 'bin/lain.js', noema: 'bin/noema.js' }, 'lain is the command; noema the alias');
  });
};
