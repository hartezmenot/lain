'use strict';

/**
 * LAIN → NOEMA (packaging pass §B) — the state moves once, safely, and nothing that knew LAIN breaks.
 *
 *   B1  ~/.lain-v2 → ~/.noema: ONE rename (a multi-GB home is never copied), a junction left at the old path so an
 *       old LAIN or a script still finds it, a migration record — and a home IN USE is left where it is (deferred)
 *   B2  a project's .noema/ is its folder; an existing .lain/ is used as it is until `noema project migrate` moves it —
 *       never both written; a .gitignore that hid .lain/ hides .noema/ too
 *   B3  `lain` still works — same home, same Core — and says once that it is now `noema`
 *   env NOEMA_* reaches every module that still reads LAIN_*
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, tmpdir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');

/** A child with a fresh user profile and none of the home overrides — so the real migration path runs, in a sandbox. */
function envFor(profile, extra = {}) {
  const env = { ...process.env, USERPROFILE: profile, HOME: profile, NOEMA_NO_UPDATE_CHECK: '1', ...extra };
  for (const k of ['NOEMA_CONFIG_DIR', 'NOEMA_HOME', 'LAIN_CONFIG_DIR', 'LAIN_HOME']) delete env[k];
  return env;
}
function node(args, env) { return spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 60000, windowsHide: true }); }
function migrateIn(profile) {
  const r = node(['-e', "process.stdout.write(JSON.stringify(require('./src/home').migrate({ version: 'test' })))"], envFor(profile));
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

module.exports = async function () {
  const meta = require('../../src/projectmeta');

  await test('RENAME B1: LAIN\'s home moves to ~/.noema by one rename — the old path becomes a junction, the data is the same data', () => {
    const profile = tmpdir('noema-profile-');
    const old = path.join(profile, '.lain-v2');
    fs.mkdirSync(path.join(old, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(old, 'sessions', 's1.json'), '{"id":"s1"}');
    const inode = fs.statSync(path.join(old, 'sessions', 's1.json')).ino;
    const r = migrateIn(profile);
    assert.strictEqual(r.state, 'moved', JSON.stringify(r));
    assert.ok(r.verified, 'verified');
    const now = path.join(profile, '.noema', 'sessions', 's1.json');
    assert.strictEqual(fs.readFileSync(now, 'utf8'), '{"id":"s1"}');
    assert.strictEqual(fs.statSync(now).ino, inode, 'MOVED, not copied — the same file');
    assert.ok(fs.lstatSync(old).isSymbolicLink(), 'the old path is a junction');
    assert.strictEqual(fs.readFileSync(path.join(old, 'sessions', 's1.json'), 'utf8'), '{"id":"s1"}', 'and still leads to the data');
    assert.ok(fs.existsSync(path.join(profile, '.noema', 'migrations', 'home-from-lain.json')));
    assert.strictEqual(migrateIn(profile).state, 'done', 'a second start does nothing');
  });

  await test('RENAME B1: a home in use is not moved (deferred) — and a person with no LAIN gets a fresh ~/.noema', () => {
    const profile = tmpdir('noema-profile-');
    const old = path.join(profile, '.lain-v2');
    fs.mkdirSync(old, { recursive: true });
    // A PROCESS HOLDING A FILE INSIDE IT is what "in use" means on Windows: the directory cannot be renamed.
    const holder = require('child_process').spawn(process.execPath, ['-e', "require('fs').openSync(process.argv[1] + '/held.log', 'w'); setTimeout(() => {}, 30000)", old], { stdio: 'ignore', windowsHide: true });
    try {
      const until = Date.now() + 5000;
      while (!fs.existsSync(path.join(old, 'held.log')) && Date.now() < until) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']);
      const r = migrateIn(profile);
      assert.strictEqual(r.state, 'deferred', JSON.stringify(r));
      assert.ok(fs.existsSync(path.join(old, 'held.log')) && !fs.existsSync(path.join(profile, '.noema')), 'nothing moved, nothing duplicated');
      const used = node(['-e', "process.stdout.write(require('./src/home').resolve())"], envFor(profile));
      assert.strictEqual(used.stdout.trim().toLowerCase(), old.toLowerCase(), 'Noema keeps using LAIN\'s home until it can move it');
    } finally { holder.kill(); }
    const fresh = tmpdir('noema-profile-');
    assert.strictEqual(migrateIn(fresh).state, 'none');
    const h = node(['-e', "process.stdout.write(require('./src/home').resolve())"], envFor(fresh));
    assert.strictEqual(h.stdout.trim().toLowerCase(), path.join(fresh, '.noema').toLowerCase());
  });

  await test('RENAME B3: `lain` runs the same Noema and says once that the command is now `noema`', () => {
    const profile = tmpdir('noema-profile-');
    const home = path.join(profile, '.noema');
    fs.mkdirSync(home, { recursive: true });
    const env = envFor(profile);
    const a = node(['bin/lain.js', '--version'], env);
    assert.strictEqual(a.status, 0, a.stderr);
    assert.match(a.stdout, /^Noema CLI \d+\.\d+\.\d+/);
    assert.match(a.stderr, /LAIN has been renamed to Noema\.\nThe `lain` command is deprecated; use `noema`\./);
    const b = node(['bin/lain.js', '--version'], env);
    assert.ok(!/renamed/.test(b.stderr), 'said once');
    const c = node(['bin/noema.js', '--version'], env);
    assert.strictEqual(c.stdout, a.stdout, 'the same program');
    assert.ok(!/renamed/.test(c.stderr));
  });

  await test('RENAME B3: a LAIN still running on this home (the old pipe name) is found — Noema never starts a second Core beside it', async () => {
    const lock = require('../../src/corelock');
    const home = tmpdir('noema-corehome-');
    const saved = { L: process.env.LAIN_CONFIG_DIR, N: process.env.NOEMA_CONFIG_DIR };
    process.env.LAIN_CONFIG_DIR = home; delete process.env.NOEMA_CONFIG_DIR;
    const net = require('net');
    const old = net.createServer((s) => s.on('data', () => s.end(`${JSON.stringify({ ok: true, pid: 4242, since: 1, surface: 'cli' })}\n`)));
    try {
      assert.match(lock.controlPipe({ legacy: true }), /\\pipe\\lain-core-[0-9a-f]{16}$/);
      assert.strictEqual(lock.controlPipe().replace('noema-core-', ''), lock.controlPipe({ legacy: true }).replace('lain-core-', ''), 'the same home, the same key');
      assert.strictEqual((await lock.discover()).running, false, 'nothing running');
      await new Promise((r) => old.listen(lock.controlPipe({ legacy: true }), r));
      const d = await lock.discover();
      assert.strictEqual(d.running, true, 'the old LAIN answers under its old name');
      assert.strictEqual(d.pid, 4242);
    } finally {
      await new Promise((r) => old.close(() => r()));
      if (saved.L == null) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = saved.L;
      if (saved.N != null) process.env.NOEMA_CONFIG_DIR = saved.N;
    }
  });

  await test('RENAME env: NOEMA_* reaches modules that read LAIN_*; the home override has one order', () => {
    const boot = require('../../src/boot');
    const env = { NOEMA_ISOLATED: '1', NOEMA_HOME: 'C:\\h1', LAIN_DEBUG: 'kept' , NOEMA_DEBUG: 'new' };
    boot.aliasEnv(env);
    assert.strictEqual(env.LAIN_ISOLATED, '1');
    assert.strictEqual(env.LAIN_CONFIG_DIR, 'C:\\h1');
    assert.strictEqual(env.LAIN_DEBUG, 'kept', 'an explicit LAIN_ value is not overwritten');
    const env2 = { NOEMA_CONFIG_DIR: 'C:\\h2', NOEMA_HOME: 'C:\\h1' };
    boot.aliasEnv(env2);
    assert.strictEqual(env2.LAIN_CONFIG_DIR, 'C:\\h2', 'NOEMA_CONFIG_DIR wins');
  });

  await test('RENAME B2: a new project gets .noema/; an existing .lain/ is used as it is — one authority, never both', () => {
    const fresh = tmpdir('noema-proj-');
    assert.strictEqual(meta.name(fresh), '.noema');
    assert.strictEqual(require('../../src/lainstore').dirFor ? path.basename(require('../../src/lainstore').dirFor(fresh)) : '.noema', '.noema');
    const old = tmpdir('noema-proj-');
    fs.mkdirSync(path.join(old, '.lain'));
    assert.strictEqual(meta.name(old), '.lain', 'LAIN\'s folder stays the authority until it is migrated');
    assert.ok(meta.legacyOnly(old));
    assert.strictEqual(meta.file(old, 'preview.json'), path.join(old, '.lain', 'preview.json'));
    require('../../src/projectindex').refresh(old);
    assert.ok(fs.existsSync(path.join(old, '.lain', 'index.json')), 'the index is written where the project already keeps it');
    assert.ok(!fs.existsSync(path.join(old, '.noema')), 'and no second folder appears');
  });

  await test('RENAME B2: `noema project migrate` moves .lain/ to .noema/ once, keeps the ignore rule, and refuses to merge', () => {
    const p = tmpdir('noema-proj-');
    fs.mkdirSync(path.join(p, '.lain', 'architecture'), { recursive: true });
    fs.writeFileSync(path.join(p, '.lain', 'architecture', 'skeleton.json'), '{"a":1}');
    fs.writeFileSync(path.join(p, '.gitignore'), 'node_modules/\n.lain/\n');
    const r = meta.migrate(p);
    assert.strictEqual(r.state, 'moved', JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(path.join(p, '.noema', 'architecture', 'skeleton.json'), 'utf8'), '{"a":1}');
    assert.ok(!fs.existsSync(path.join(p, '.lain')));
    assert.match(fs.readFileSync(path.join(p, '.gitignore'), 'utf8'), /^\.noema\/$/m);
    assert.strictEqual(meta.migrate(p).state, 'done');
    fs.mkdirSync(path.join(p, '.lain'));
    const both = meta.migrate(p);
    assert.strictEqual(both.state, 'both', 'two folders are reported, never merged');
    assert.strictEqual(meta.name(p), '.noema');
  });
};
