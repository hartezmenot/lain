'use strict';

/**
 * NOEMA → LAIN (2026-10-02) — the product is LAIN again. The state moves once, safely, and nothing that knew Noema
 * breaks; nothing of the OBSOLETE pre-cleanup LAIN comes back.
 *
 *   home    ~/.noema → ~/.lain: ONE rename (a multi-GB home is never copied), junctions left at ~/.noema and
 *           ~/.lain-v2, a migration record — a home IN USE is left where it is (deferred) — and a historical ~/.lain
 *           (an obsolete LAIN's real folder beside a real Noema home) is set aside, never deleted, never adopted
 *   command `noema` runs the same LAIN — same home, same Core — and says once that the product is LAIN again
 *   pipe    a Noema-era Core still running on this home (noema-core-<hash of ~/.noema>) is found, never duplicated
 *   env     NOEMA_* reaches every module that reads LAIN_*; LAIN_* wins
 *   project .lain/ is canonical; an existing .noema/ is used as it is until `lain project migrate` — never both
 *   windows the current Open With ProgID is not the obsolete LAIN.File; registering removes LAIN.File and Noema.File
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, tmpdir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');

/** A child with a fresh user profile and none of the home overrides — so the real migration path runs, in a sandbox. */
function envFor(profile, extra = {}) {
  const env = { ...process.env, USERPROFILE: profile, HOME: profile, LAIN_NO_UPDATE_CHECK: '1', ...extra };
  for (const k of ['NOEMA_CONFIG_DIR', 'NOEMA_HOME', 'LAIN_CONFIG_DIR', 'LAIN_HOME', 'LAIN_VIA', 'NOEMA_VIA']) if (!(k in extra)) delete env[k];
  return env;
}
function node(args, env) { return spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 60000, windowsHide: true }); }
function inProfile(profile, expr) {
  const r = node(['-e', `process.stdout.write(JSON.stringify(${expr}))`], envFor(profile));
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const migrateIn = (profile) => inProfile(profile, "require('./src/home').migrate({ version: 'test' })");
const resolveIn = (profile) => inProfile(profile, "require('./src/home').resolve()");

module.exports = async function () {
  const meta = require('../../src/projectmeta');

  await test('RENAME home: ~/.noema moves to ~/.lain by one rename — nothing is left at ~/.noema or ~/.lain-v2', () => {
    const profile = tmpdir('lain-profile-');
    const noema = path.join(profile, '.noema');
    fs.mkdirSync(path.join(noema, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(noema, 'sessions', 's1.json'), '{"id":"s1"}');
    fs.symlinkSync(noema, path.join(profile, '.lain-v2'), 'junction');   // what the Noema-era move left behind
    const inode = fs.statSync(path.join(noema, 'sessions', 's1.json')).ino;
    assert.strictEqual(resolveIn(profile).toLowerCase(), noema.toLowerCase(), 'before the move the Noema home is the one home');
    const r = migrateIn(profile);
    assert.strictEqual(r.state, 'moved', JSON.stringify(r));
    assert.ok(r.verified, 'verified');
    const now = path.join(profile, '.lain', 'sessions', 's1.json');
    assert.strictEqual(fs.readFileSync(now, 'utf8'), '{"id":"s1"}');
    assert.strictEqual(fs.statSync(now).ino, inode, 'MOVED, not copied — the same file');
    for (const old of [noema, path.join(profile, '.lain-v2')]) {
      let st = null; try { st = fs.lstatSync(old); } catch { st = null; }
      assert.strictEqual(st, null, `${old} is gone — not a junction, not a folder`);
    }
    assert.ok(fs.existsSync(path.join(profile, '.lain', 'migrations', 'home-from-noema.json')));
    assert.strictEqual(resolveIn(profile).toLowerCase(), path.join(profile, '.lain').toLowerCase());
    assert.strictEqual(migrateIn(profile).state, 'done', 'a second start does nothing');
    assert.ok(!fs.existsSync(noema) && !fs.existsSync(path.join(profile, '.lain-v2')), 'a second start recreates nothing');
  });

  await test('RENAME home: ~/.lain-v2 and ~/.noema junctions an older build left are retired and never recreated; a real folder or a foreign link stays', () => {
    const profile = tmpdir('lain-profile-');
    const lain = path.join(profile, '.lain');
    fs.mkdirSync(path.join(lain, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(lain, 'config.json'), '{"keep":true}');
    fs.writeFileSync(path.join(lain, 'migrations-marker'), 'x');
    fs.mkdirSync(path.join(lain, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(lain, 'migrations', 'home-from-noema.json'), '{}');
    fs.symlinkSync(lain, path.join(profile, '.noema'), 'junction');
    fs.symlinkSync(lain, path.join(profile, '.lain-v2'), 'junction');
    const r = migrateIn(profile);
    assert.strictEqual(r.state, 'done', JSON.stringify(r));
    assert.strictEqual(r.retired.length, 2, JSON.stringify(r));
    for (const old of ['.noema', '.lain-v2']) assert.ok(!fs.existsSync(path.join(profile, old)), `${old} retired`);
    assert.strictEqual(fs.readFileSync(path.join(lain, 'config.json'), 'utf8'), '{"keep":true}', 'the data behind the links is untouched');
    for (let i = 0; i < 3; i++) migrateIn(profile);
    assert.ok(!fs.existsSync(path.join(profile, '.lain-v2')), 'no LAIN start recreates ~/.lain-v2');
    // A REAL ~/.lain-v2 FOLDER is somebody's data, and a link that leads elsewhere is not LAIN's: both stay.
    const p2 = tmpdir('lain-profile-');
    fs.mkdirSync(path.join(p2, '.lain', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(p2, '.lain', 'migrations', 'home-from-noema.json'), '{}');
    fs.mkdirSync(path.join(p2, '.lain-v2'));
    fs.writeFileSync(path.join(p2, '.lain-v2', 'mine.txt'), 'mine');
    const elsewhere = path.join(p2, 'elsewhere'); fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(p2, '.noema'), 'junction');
    assert.strictEqual(migrateIn(p2).retired.length, 0);
    assert.strictEqual(fs.readFileSync(path.join(p2, '.lain-v2', 'mine.txt'), 'utf8'), 'mine');
    assert.ok(fs.lstatSync(path.join(p2, '.noema')).isSymbolicLink(), 'a foreign link is left alone');
  });

  await test('RENAME home: a historical ~/.lain (the obsolete LAIN\'s) is set aside, not adopted — the Noema home moves in', () => {
    const profile = tmpdir('lain-profile-');
    fs.mkdirSync(path.join(profile, '.lain', 'old-stuff'), { recursive: true });
    fs.writeFileSync(path.join(profile, '.lain', 'old-stuff', 'x.txt'), 'obsolete');
    fs.mkdirSync(path.join(profile, '.noema', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(profile, '.noema', 'config.json'), '{"current":true}');
    assert.strictEqual(resolveIn(profile).toLowerCase(), path.join(profile, '.noema').toLowerCase(), 'the obsolete folder is never the home');
    const r = migrateIn(profile);
    assert.strictEqual(r.state, 'moved', JSON.stringify(r));
    assert.ok(r.archived && fs.readFileSync(path.join(r.archived, 'old-stuff', 'x.txt'), 'utf8') === 'obsolete', 'set aside, not deleted');
    assert.strictEqual(fs.readFileSync(path.join(profile, '.lain', 'config.json'), 'utf8'), '{"current":true}');
  });

  await test('RENAME home: a home in use is not moved (deferred) — and a person with no prior home gets a fresh ~/.lain', () => {
    const profile = tmpdir('lain-profile-');
    const old = path.join(profile, '.noema');
    fs.mkdirSync(old, { recursive: true });
    // A PROCESS HOLDING A FILE INSIDE IT is what "in use" means on Windows: the directory cannot be renamed.
    const holder = require('child_process').spawn(process.execPath, ['-e', "require('fs').openSync(process.argv[1] + '/held.log', 'w'); setTimeout(() => {}, 30000)", old], { stdio: 'ignore', windowsHide: true });
    try {
      const until = Date.now() + 5000;
      while (!fs.existsSync(path.join(old, 'held.log')) && Date.now() < until) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']);
      const r = migrateIn(profile);
      assert.strictEqual(r.state, 'deferred', JSON.stringify(r));
      assert.ok(fs.existsSync(path.join(old, 'held.log')) && !fs.existsSync(path.join(profile, '.lain')), 'nothing moved, nothing duplicated');
      assert.strictEqual(resolveIn(profile).toLowerCase(), old.toLowerCase(), 'LAIN keeps using the Noema home until it can move it');
    } finally { holder.kill(); }
    const fresh = tmpdir('lain-profile-');
    assert.strictEqual(migrateIn(fresh).state, 'none');
    assert.strictEqual(resolveIn(fresh).toLowerCase(), path.join(fresh, '.lain').toLowerCase());
  });

  await test('RENAME command: `noema` runs the same LAIN and says once that the product is LAIN again; `lain` says nothing', () => {
    const profile = tmpdir('lain-profile-');
    fs.mkdirSync(path.join(profile, '.lain'), { recursive: true });
    const env = envFor(profile);
    const a = node(['bin/noema.js', '--version'], env);
    assert.strictEqual(a.status, 0, a.stderr);
    assert.match(a.stdout, /^LAIN CLI \d+\.\d+\.\d+/);
    assert.match(a.stderr, /Noema has been renamed back to LAIN\.\nUse `lain` for future commands/);
    const b = node(['bin/noema.js', '--version'], env);
    assert.ok(!/renamed/.test(b.stderr), 'said once');
    const c = node(['bin/lain.js', '--version'], env);
    assert.strictEqual(c.stdout, a.stdout, 'the same program');
    assert.ok(!/renamed/.test(c.stderr));
    // The installed `noema.cmd` shim marks itself with LAIN_VIA=noema and runs lain.exe — the same notice path.
    const p2 = tmpdir('lain-profile-');
    fs.mkdirSync(path.join(p2, '.lain'), { recursive: true });
    const d = node(['bin/lain.js', '--version'], envFor(p2, { LAIN_VIA: 'noema' }));
    assert.match(d.stderr, /renamed back to LAIN/);
  });

  await test('RENAME pipe: a Noema-era Core on this home (noema-core-<hash of ~/.noema>) is found — LAIN never starts a second Core', async () => {
    const lock = require('../../src/corelock');
    const home = tmpdir('lain-corehome-');
    const saved = { L: process.env.LAIN_CONFIG_DIR, N: process.env.NOEMA_CONFIG_DIR };
    process.env.LAIN_CONFIG_DIR = home; delete process.env.NOEMA_CONFIG_DIR;
    const net = require('net');
    const old = net.createServer((s) => s.on('data', () => s.end(`${JSON.stringify({ ok: true, pid: 4242, since: 1, surface: 'cli' })}\n`)));
    try {
      assert.match(lock.controlPipe(), /\\pipe\\lain-core-[0-9a-f]{16}$/);
      assert.match(lock.controlPipe({ legacy: true }), /\\pipe\\noema-core-[0-9a-f]{16}$/);
      assert.strictEqual(lock.controlPipe().replace('lain-core-', ''), lock.controlPipe({ legacy: true }).replace('noema-core-', ''), 'an override home: the same key');
      assert.strictEqual((await lock.discover()).running, false, 'nothing running');
      await new Promise((r) => old.listen(lock.controlPipe({ legacy: true }), r));
      const d = await lock.discover();
      assert.strictEqual(d.running, true, 'the Noema-era Core answers under its old name');
      assert.strictEqual(d.pid, 4242);
    } finally {
      await new Promise((r) => old.close(() => r()));
      if (saved.L == null) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = saved.L;
      if (saved.N != null) process.env.NOEMA_CONFIG_DIR = saved.N;
    }
    // THE DEFAULT HOME: the legacy key is the hash of ~/.noema, which is what a Noema-era Core listened under.
    const profile = tmpdir('lain-profile-');
    fs.mkdirSync(path.join(profile, '.lain'), { recursive: true });
    const keys = inProfile(profile, "[require('./src/corelock').controlPipe(), require('./src/corelock').controlPipe({ legacy: true })]");
    const hash = (d) => require('crypto').createHash('sha256').update(path.resolve(d).toLowerCase()).digest('hex').slice(0, 16);
    assert.ok(keys[0].endsWith(`lain-core-${hash(path.join(profile, '.lain'))}`), keys[0]);
    assert.ok(keys[1].endsWith(`noema-core-${hash(path.join(profile, '.noema'))}`), keys[1]);
  });

  await test('RENAME env: NOEMA_* reaches modules that read LAIN_*; the home override has one order', () => {
    const boot = require('../../src/boot');
    const env = { NOEMA_ISOLATED: '1', NOEMA_HOME: 'C:\\h1', LAIN_DEBUG: 'kept', NOEMA_DEBUG: 'new' };
    boot.aliasEnv(env);
    assert.strictEqual(env.LAIN_ISOLATED, '1');
    assert.strictEqual(env.LAIN_CONFIG_DIR, 'C:\\h1');
    assert.strictEqual(env.LAIN_DEBUG, 'kept', 'an explicit LAIN_ value is not overwritten');
    const env2 = { NOEMA_CONFIG_DIR: 'C:\\h2', NOEMA_HOME: 'C:\\h1' };
    boot.aliasEnv(env2);
    assert.strictEqual(env2.LAIN_CONFIG_DIR, 'C:\\h2', 'NOEMA_CONFIG_DIR wins');
    assert.strictEqual(require('../../src/home').override({ LAIN_HOME: 'A', NOEMA_CONFIG_DIR: 'B' }), 'A', 'LAIN_* wins over NOEMA_*');
  });

  await test('RENAME project: a new project gets .lain/; an existing .noema/ is used as it is — one authority, never both', () => {
    const fresh = tmpdir('lain-proj-');
    assert.strictEqual(meta.name(fresh), '.lain');
    const old = tmpdir('lain-proj-');
    fs.mkdirSync(path.join(old, '.noema'));
    assert.strictEqual(meta.name(old), '.noema', 'the Noema-era folder stays the authority until it is migrated');
    assert.ok(meta.legacyOnly(old));
    assert.strictEqual(meta.file(old, 'preview.json'), path.join(old, '.noema', 'preview.json'));
    require('../../src/projectindex').refresh(old);
    assert.ok(fs.existsSync(path.join(old, '.noema', 'index.json')), 'the index is written where the project already keeps it');
    assert.ok(!fs.existsSync(path.join(old, '.lain')), 'and no second folder appears');
  });

  await test('RENAME project: `lain project migrate` moves .noema/ to .lain/ once (NOEMA.md → LAIN.md), keeps the ignore rule, refuses to merge', () => {
    const p = tmpdir('lain-proj-');
    fs.mkdirSync(path.join(p, '.noema', 'architecture'), { recursive: true });
    fs.writeFileSync(path.join(p, '.noema', 'architecture', 'skeleton.json'), '{"a":1}');
    fs.writeFileSync(path.join(p, '.noema', 'NOEMA.md'), '# rules');
    fs.writeFileSync(path.join(p, '.gitignore'), 'node_modules/\n.noema/\n');
    const r = meta.migrate(p);
    assert.strictEqual(r.state, 'moved', JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(path.join(p, '.lain', 'architecture', 'skeleton.json'), 'utf8'), '{"a":1}');
    assert.strictEqual(fs.readFileSync(path.join(p, '.lain', 'LAIN.md'), 'utf8'), '# rules');
    assert.ok(!fs.existsSync(path.join(p, '.noema')));
    assert.match(fs.readFileSync(path.join(p, '.gitignore'), 'utf8'), /^\.lain\/$/m);
    assert.strictEqual(meta.migrate(p).state, 'done');
    fs.mkdirSync(path.join(p, '.noema'));
    const both = meta.migrate(p);
    assert.strictEqual(both.state, 'both', 'two folders are reported, never merged');
    assert.strictEqual(meta.name(p), '.lain');
  });

  await test('RENAME constitution: a Noema-era NOEMA.md is read until LAIN.md exists; LAIN.md wins', () => {
    const p = tmpdir('lain-proj-');
    fs.mkdirSync(path.join(p, '.lain'));
    fs.writeFileSync(path.join(p, '.lain', 'NOEMA.md'), 'old rules');
    const c = require('../../src/discipline/constitution');
    assert.match(JSON.stringify(c.project(p)), /old rules/);
    fs.writeFileSync(path.join(p, '.lain', 'LAIN.md'), 'new rules');
    const now = JSON.stringify(c.project(p));
    assert.match(now, /new rules/);
    assert.ok(!/old rules/.test(now));
  });

  await test('RENAME windows: Open With uses LAIN.Harness.File (not the obsolete LAIN.File) and removes LAIN.File and Noema.File', () => {
    const w = require('../../src/winassoc');
    const calls = [];
    const r = w.register({ exe: 'C:\\x\\LAIN Harness.exe', exec: (a) => { calls.push(a); return { ok: true }; }, hive: 'HKCU\\Software\\Test', extensions: ['js'], notify: false });
    assert.ok(r.ok);
    const adds = calls.filter((a) => a[0] === 'add').map((a) => a[1]);
    const dels = calls.filter((a) => a[0] === 'delete').map((a) => a[1]);
    assert.ok(adds.some((k) => /\\LAIN\.Harness\.File$/.test(k)), 'the current ProgID');
    assert.ok(!adds.some((k) => /\\LAIN\.File(\\|$)/.test(k)), 'the obsolete ProgID is never written');
    for (const old of ['LAIN.File', 'Noema.File', 'Applications\\LAIN.exe', 'Applications\\Noema Harness.exe', 'Applications\\noemaw.exe']) assert.ok(dels.some((k) => k.endsWith(`\\${old}`)), `removes ${old}`);
    assert.ok(calls.findIndex((a) => a[0] === 'add') > calls.findIndex((a) => a[0] === 'delete'), 'older entries go first');
  });

  await test('RENAME windows: the startup link, Start Menu shortcut and launcher are never the obsolete LAIN\'s names', () => {
    const st = require('../../src/startup');
    assert.strictEqual(st.LINK_NAME, 'LAIN Harness.lnk');
    assert.deepStrictEqual(st.legacyLinkPaths().map((p) => path.basename(p)), ['LAIN.lnk', 'Noema Harness.lnk']);
    assert.strictEqual(path.basename(require('../../src/desktop').launcherPath()), 'LAIN Harness.exe');
    const src = fs.readFileSync(path.join(ROOT, 'distribution', 'shortcut.js'), 'utf8');
    assert.match(src, /const NAME = 'LAIN Harness\.lnk'/);
    const setup = fs.readFileSync(path.join(ROOT, 'distribution', 'setup.cs'), 'utf8');
    assert.match(setup, /Uninstall\\LAIN\.Install"/, 'the Installed-apps key is not the obsolete "LAIN"');
    // THE `noema` COMMAND IS RETIRED (2026-10-06): setup no longer writes noema.cmd, and removes one an older setup left.
    assert.ok(!/NoemaShim|WriteAllText\(Path\.Combine\(dir, "noema\.cmd"\)/.test(setup), 'setup writes no noema.cmd');
    assert.match(setup, /"lain\.cmd", "noema\.cmd" \}/, 'an older noema.cmd is removed on upgrade');
  });

  await test('RENAME update: manifests for product `lain` and the Noema-era `noema` are accepted; a staged Noema-era package is a build', () => {
    const m = require('../../src/update/manifest');
    const base = { schema: 1, channel: 'stable', version: '1.2.3', assets: [{ url: 'lain-1.2.3-win-x64.zip', sha256: 'a'.repeat(64) }] };
    assert.ok(m.parse(JSON.stringify({ ...base, product: 'lain' })).ok);
    assert.ok(m.parse(JSON.stringify({ ...base, product: 'noema' })).ok, 'a feed published in the Noema era still parses');
    assert.ok(!m.parse(JSON.stringify({ ...base, product: 'other' })).ok);
    const src = fs.readFileSync(path.join(ROOT, 'src', 'update', 'updater.js'), 'utf8');
    assert.match(src, /function entryIn\(dir\) \{ return fs\.existsSync\(path\.join\(dir, 'app', 'bin', 'lain\.js'\)\) \|\| fs\.existsSync\(path\.join\(dir, 'app', 'bin', 'noema\.js'\)\); \}/);
    assert.ok(!/'app', 'bin', 'noema\.js'\)\)\s*\)?\s*[;{]/.test(src.replace(/function entryIn[^\n]*\n/, '')), 'every other check goes through entryIn');
    assert.ok(fs.existsSync(path.join(ROOT, 'bin', 'noema.js')), 'every package keeps bin/noema.js, which a Noema-era launcher starts');
  });

  await test('RENAME legacy cleanup: obsolete and Noema-era builds are found; the current launcher and its launch.json are not', () => {
    const profile = tmpdir('lain-profile-');
    const desk = path.join(profile, '.lain', 'desktop');
    fs.mkdirSync(desk, { recursive: true });
    for (const f of ['LAIN Harness.exe', 'lain-harness-0123456789ab.exe', 'launch.json', 'LAIN.exe', 'lain-desktop-0123456789ab.exe', 'noema-harness-0123456789ab.exe', 'Noema Harness.exe']) fs.writeFileSync(path.join(desk, f), f === 'launch.json' ? '{"entry":"D:\\\\lain\\\\bin\\\\lain.js"}' : 'x');
    const plan = inProfile(profile, "require('./src/legacycleanup').plan({ registry: false })");
    const names = plan.executables.map((p) => path.basename(p)).sort();
    assert.deepStrictEqual(names, ['LAIN.exe', 'Noema Harness.exe', 'lain-desktop-0123456789ab.exe', 'noema-harness-0123456789ab.exe'].sort());
    assert.strictEqual(plan.oldLaunchJson, null, 'the current launcher\'s launch.json is not obsolete');
  });
};
