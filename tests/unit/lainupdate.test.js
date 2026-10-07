'use strict';

/**
 * THE LAIN UPDATER (packaging pass §H–I, §X) — against a real signed feed on disk and a real install layout.
 *
 *   - a manifest is trusted only when its Ed25519 signature verifies against a release key; a tampered manifest, or
 *     one signed by any other key, is refused — and the test key is honoured only in an isolated run
 *   - a downloaded package whose SHA-256 differs from the signed manifest is REJECTED and deleted; the installed
 *     version is untouched; so is a package that is not a LAIN build
 *   - a verified package is unpacked beside the running version (versions/<v>), never over it
 *   - apply: previous ← current, current ← staged, pending ← staged, restart.json for the launcher; after the new
 *     version reports healthy, "Updated from X" still knows X
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, tmpdir } = require('../helpers');

const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
// THE VERSIONS ARE THE PRODUCT'S (one version, package.json): the running one and the next patch release.
const CUR = require('../../package.json').version;
const NEXT = CUR.replace(/\d+$/, (n) => String(Number(n) + 1));

function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } };
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(restore);
  restore();
  return r;
}

/** A feed directory with a package and a manifest signed by `key`. */
function feed({ key, version = NEXT, tamperHash = false, notLAIN = false, channel = 'stable', sequence = 1000, issued = Date.now(), validDays = 30, wrongVersion = null }) {
  const dir = tmpdir('lain-feed-');
  const pkg = tmpdir('lain-pkg-');
  fs.mkdirSync(path.join(pkg, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'runtime', 'node.exe'), 'not really node');
  if (!notLAIN) {
    fs.mkdirSync(path.join(pkg, 'app', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'app', 'bin', 'lain.js'), '// the new version\n');
    fs.writeFileSync(path.join(pkg, 'app', 'build-info.json'), JSON.stringify({ product: 'LAIN', version: wrongVersion || version }));
  } else fs.writeFileSync(path.join(pkg, 'readme.txt'), 'something else');
  const name = `lain-${version}-win-x64.zip`;
  execFileSync(TAR, ['-a', '-cf', path.join(dir, name), '-C', pkg, ...fs.readdirSync(pkg)], { stdio: 'ignore', windowsHide: true });
  let sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
  if (tamperHash) sha = sha.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  const release = {
    schema: 1, product: 'lain', channel, version, released: new Date().toISOString(), minimumCompatible: '0.1.0', protocol: 1,
    sequence, issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + validDays * 864e5).toISOString(),
    notes: 'https://example.invalid/notes', summary: ['A test release'],
    assets: [{ arch: 'x64', kind: 'app', name, url: name, size: fs.statSync(path.join(dir, name)).size, sha256: sha }],
  };
  const bytes = Buffer.from(JSON.stringify(release, null, 2));
  fs.writeFileSync(path.join(dir, `manifest-${channel}.json`), bytes);
  fs.writeFileSync(path.join(dir, `manifest-${channel}.json.sig`), crypto.sign(null, bytes, key).toString('base64'));
  return { dir, release, bytes };
}

/** An installed LAIN's layout: current → CUR. */
function install() {
  const root = tmpdir('lain-install-');
  fs.mkdirSync(path.join(root, 'versions', CUR, 'app', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'versions', CUR, 'app', 'bin', 'lain.js'), '// the running version\n');
  fs.writeFileSync(path.join(root, 'current'), CUR);
  return root;
}

module.exports = async function () {
  const M = require('../../src/update/manifest');
  const U = require('../../src/update/updater');
  const trust = require('../../src/update/trust');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const PUB = publicKey.export({ type: 'spki', format: 'pem' });
  const other = crypto.generateKeyPairSync('ed25519');

  await test('UPDATE: versions order as releases do — 0.1.10 after 0.1.9, a prerelease before its release', () => {
    assert.ok(M.compare('0.1.10', '0.1.9') > 0);
    assert.ok(M.compare('0.2.0-preview.1', '0.2.0') < 0);
    assert.ok(M.compare('0.2.0-preview.2', '0.2.0-preview.10') < 0);
    assert.strictEqual(M.compare('1.0.0', '1.0.0'), 0);
  });

  await test('UPDATE: a manifest is trusted only when its signature verifies — tampered or foreign-signed is refused', () => {
    const f = feed({ key: privateKey });
    const sig = fs.readFileSync(path.join(f.dir, 'manifest-stable.json.sig'), 'utf8');
    assert.ok(M.verifySignature(f.bytes, sig, [PUB]).ok, 'the right key verifies');
    const tampered = Buffer.from(f.bytes.toString('utf8').replace(NEXT, '9.9.9'));
    assert.ok(!M.verifySignature(tampered, sig, [PUB]).ok, 'one changed byte is refused');
    assert.ok(!M.verifySignature(f.bytes, crypto.sign(null, f.bytes, other.privateKey).toString('base64'), [PUB]).ok, 'another key is refused');
    assert.ok(!M.verifySignature(f.bytes, '', [PUB]).ok, 'no signature is refused');
    assert.ok(!M.parse(Buffer.from('{"schema":1,"product":"other"}')).ok, 'not a LAIN manifest');
  });

  await test('UPDATE: the test key is honoured only in an isolated run — a release build trusts its release keys alone', () => {
    withEnv({ LAIN_UPDATE_TEST_KEY: PUB, LAIN_ISOLATED: null, LAIN_ISOLATED: null }, () => {
      assert.strictEqual(trust.publicKeys().length, trust.RELEASE_KEYS.length);
    });
    withEnv({ LAIN_UPDATE_TEST_KEY: PUB, LAIN_ISOLATED: '1' }, () => {
      assert.ok(trust.publicKeys().includes(PUB));
    });
  });

  await test('UPDATE: check → stage → apply against a signed feed; the running version is never touched', async () => {
    const home = tmpdir('lain-uphome-');
    const root = install();
    const f = feed({ key: privateKey });
    await withEnv({ LAIN_CONFIG_DIR: home, LAIN_CONFIG_DIR: home, LAIN_INSTALL_ROOT: root, LAIN_UPDATE_FEED: f.dir, LAIN_UPDATE_TEST_KEY: PUB, LAIN_ISOLATED: '1' }, async () => {
      const c = await U.check({ force: true });
      assert.strictEqual(c.state, 'available', JSON.stringify(c));
      assert.strictEqual(c.available.version, NEXT);
      const s = await U.stage({});
      assert.ok(s.ok, s.why);
      assert.ok(fs.existsSync(path.join(root, 'versions', NEXT, 'app', 'bin', 'lain.js')), 'unpacked beside the running version');
      assert.strictEqual(fs.readFileSync(path.join(root, 'versions', CUR, 'app', 'bin', 'lain.js'), 'utf8'), '// the running version\n');
      assert.strictEqual(U.status().state, 'staged');
      const a = U.apply({ args: ['--resume', 's1'], cwd: root });
      assert.ok(a.ok, a.why);
      assert.strictEqual(a.restartCode, 75);
      const ptr = (n) => fs.readFileSync(path.join(root, n), 'utf8').trim();
      assert.strictEqual(ptr('current'), NEXT);
      assert.strictEqual(ptr('previous'), CUR, 'the old version is kept for rollback');
      assert.strictEqual(ptr('pending'), NEXT, 'until it reports healthy');
      assert.deepStrictEqual(JSON.parse(ptr('restart.json')), { args: ['--resume', 's1'], cwd: root });
      assert.strictEqual(U.readState().applied.from, CUR);
    });
  });

  await test('UPDATE: a package whose SHA-256 differs from the signed manifest is rejected and deleted', async () => {
    const home = tmpdir('lain-uphome-');
    const root = install();
    const f = feed({ key: privateKey, tamperHash: true });
    await withEnv({ LAIN_CONFIG_DIR: home, LAIN_CONFIG_DIR: home, LAIN_INSTALL_ROOT: root, LAIN_UPDATE_FEED: f.dir, LAIN_UPDATE_TEST_KEY: PUB, LAIN_ISOLATED: '1' }, async () => {
      assert.strictEqual((await U.check({ force: true })).state, 'available');
      const s = await U.stage({});
      assert.ok(!s.ok);
      assert.match(s.why, /SHA-256/);
      assert.ok(!fs.existsSync(path.join(root, 'versions', NEXT)), 'nothing was unpacked');
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'staging')), [], 'the download was deleted');
      assert.strictEqual(fs.readFileSync(path.join(root, 'current'), 'utf8'), CUR);
      assert.ok(!U.apply({}).ok, 'and there is nothing to apply');
    });
  });

  await test('UPDATE: a package that is not a LAIN build is rejected; a foreign-signed feed never stages', async () => {
    const home = tmpdir('lain-uphome-');
    const root = install();
    const f = feed({ key: privateKey, notLAIN: true });
    await withEnv({ LAIN_CONFIG_DIR: home, LAIN_CONFIG_DIR: home, LAIN_INSTALL_ROOT: root, LAIN_UPDATE_FEED: f.dir, LAIN_UPDATE_TEST_KEY: PUB, LAIN_ISOLATED: '1' }, async () => {
      await U.check({ force: true });
      const s = await U.stage({});
      assert.ok(!s.ok);
      assert.match(s.why, /not a LAIN build/);
      assert.ok(!fs.existsSync(path.join(root, 'versions', NEXT)));
    });
    const home2 = tmpdir('lain-uphome-');
    const g = feed({ key: other.privateKey });
    await withEnv({ LAIN_CONFIG_DIR: home2, LAIN_CONFIG_DIR: home2, LAIN_INSTALL_ROOT: root, LAIN_UPDATE_FEED: g.dir, LAIN_UPDATE_TEST_KEY: PUB, LAIN_ISOLATED: '1' }, async () => {
      const c = await U.check({ force: true });
      assert.strictEqual(c.state, 'error');
      assert.match(c.why, /signature/);
      assert.ok(!(await U.stage({})).ok, 'nothing is available to stage');
    });
  });

  await test('UPDATE ANTI-REPLAY: an older signed manifest (lower sequence) is refused; the highest is remembered beside the install too', async () => {
    const root = install();
    const env = (home, dir) => ({ LAIN_CONFIG_DIR: home, LAIN_INSTALL_ROOT: root, LAIN_UPDATE_FEED: dir, LAIN_UPDATE_TEST_KEY: PUB, LAIN_ISOLATED: '1' });
    const newer = feed({ key: privateKey, sequence: 2000 });
    const older = feed({ key: privateKey, sequence: 1500 });
    await withEnv(env(tmpdir('lain-uphome-'), newer.dir), async () => {
      assert.strictEqual((await U.check({ force: true })).state, 'available');
      assert.strictEqual(U.highestSequence(), 2000);
      assert.strictEqual(fs.readFileSync(path.join(root, 'feed-sequence'), 'utf8'), '2000', 'remembered beside the install');
    });
    // A NEW DATA HOME (a reset) still refuses the replay: the install root remembers.
    await withEnv(env(tmpdir('lain-uphome-'), older.dir), async () => {
      const c = await U.check({ force: true });
      assert.strictEqual(c.state, 'error', JSON.stringify(c));
      assert.match(c.why, /replay/);
      assert.strictEqual(c.phase, 'FAILED');
      assert.ok(!(await U.stage({})).ok);
    });
  });

  await test('UPDATE: an expired manifest, one dated in the future, and one without sequence or validity are refused', async () => {
    const root = install();
    for (const [f, re] of [[feed({ key: privateKey, issued: Date.now() - 40 * 864e5, validDays: 30 }), /expired/], [feed({ key: privateKey, issued: Date.now() + 5 * 864e5 }), /future/]]) {
      await withEnv({ LAIN_CONFIG_DIR: tmpdir('lain-uphome-'), LAIN_INSTALL_ROOT: root, LAIN_UPDATE_FEED: f.dir, LAIN_UPDATE_TEST_KEY: PUB, LAIN_ISOLATED: '1' }, async () => {
        const c = await U.check({ force: true });
        assert.strictEqual(c.state, 'error'); assert.match(c.why, re);
      });
    }
    const bare = JSON.parse(feed({ key: privateKey }).bytes.toString('utf8'));
    delete bare.sequence;
    assert.match(M.parse(Buffer.from(JSON.stringify(bare))).why, /sequence/);
  });

  await test('UPDATE: a package whose own build-info names another version than the signed manifest is rejected', async () => {
    const root = install();
    const f = feed({ key: privateKey, wrongVersion: '9.9.9' });
    await withEnv({ LAIN_CONFIG_DIR: tmpdir('lain-uphome-'), LAIN_INSTALL_ROOT: root, LAIN_UPDATE_FEED: f.dir, LAIN_UPDATE_TEST_KEY: PUB, LAIN_ISOLATED: '1' }, async () => {
      await U.check({ force: true });
      const s = await U.stage({});
      assert.ok(!s.ok); assert.match(s.why, /says it is LAIN 9\.9\.9/);
      assert.ok(!fs.existsSync(path.join(root, 'versions', NEXT)), 'nothing staged');
      assert.ok(!fs.existsSync(path.join(root, 'versions', `${NEXT}.staging`)), 'the staging folder is gone');
    });
  });

  await test('UPDATE PHASES: one state for every surface — AVAILABLE, then STAGED (RESTART_REQUIRED for a running LAIN), FAILED with its reason', async () => {
    const root = install();
    const f = feed({ key: privateKey });
    await withEnv({ LAIN_CONFIG_DIR: tmpdir('lain-uphome-'), LAIN_INSTALL_ROOT: root, LAIN_UPDATE_FEED: f.dir, LAIN_UPDATE_TEST_KEY: PUB, LAIN_ISOLATED: '1' }, async () => {
      assert.strictEqual((await U.check({ force: true })).phase, 'AVAILABLE');
      assert.ok((await U.stage({})).ok);
      assert.strictEqual(U.status().phase, 'STAGED');
      const app = { session: null, abort: null };
      const v = require('../../src/update/ux').view(app, { fresh: true });
      assert.strictEqual(v.phase, 'RESTART_REQUIRED');
      assert.strictEqual(v.label, '✓ Update installed · Restart to activate');
      U.writeState({ ...U.readState(), phase: 'DOWNLOADING', phaseAt: Date.now(), staged: null, available: { version: NEXT, asset: { sha256: 'a'.repeat(64) } } });
      assert.strictEqual(U.status().phase, 'DOWNLOADING', 'a live phase is what both surfaces see');
    });
  });

  await test('CLI UPDATE POLICY: staged while idle → restart at once; while busy → one notice, no interruption; idle again → one "Restart to activate", then the restart', async () => {
    const C = require('../../src/update/cli');
    const L = require('../../src/update/lifecycle');
    const said = []; const restarts = [];
    const realPerform = L.perform;
    L.perform = async (a, kind) => { restarts.push(kind); return { ok: true }; };
    try {
      // IDLE: a staged version restarts immediately (the session resumes — lifecycle.perform passes --resume).
      const idleApp = { render: { notice: (t, x) => said.push(x) }, _lastInputAt: Date.now() - 10 * 60 * 1000, abort: null, session: null };
      C.follow(idleApp, NEXT);
      assert.deepStrictEqual(restarts, ['update']);
      assert.ok(said.some((x) => new RegExp(`LAIN ${NEXT.replace(/\./g, '\\.')} installed — restarting into it`).test(x)), said.join(' | '));
      // BUSY: nothing restarts; ONE notice however many ticks pass.
      said.length = 0; restarts.length = 0;
      const busyApp = { render: { notice: (t, x) => said.push(x) }, abort: { abort() {} }, session: null };
      C.follow(busyApp, NEXT);
      await new Promise((r) => setTimeout(r, 4500));
      assert.deepStrictEqual(restarts, [], 'a busy CLI is never interrupted');
      assert.strictEqual(said.filter((x) => /restart when the current task finishes/.test(x)).length, 1, said.join(' | '));
      // IDLE BOUNDARY: one "Restart to activate" notice — after one settled quiet step, so the turn's close cannot clear it.
      busyApp.abort = null; busyApp._lastInputAt = Date.now() - 10 * 60 * 1000;
      await new Promise((r) => setTimeout(r, 4500));
      assert.strictEqual(said.filter((x) => /Update installed · Restart to activate/.test(x)).length, 1, said.join(' | '));
      assert.deepStrictEqual(restarts, [], 'not yet — the person gets the idle window first');
      clearInterval(busyApp._update.watch);
      // A DRAFT, A QUESTION OR A KEYSTROKE IS NOT IDLE.
      assert.ok(!C.idle({ input: { line: 'half a thought' } }));
      assert.ok(!C.idle({ ui: { panel: { visible: true } } }));
      assert.ok(!C.idle({ _lastInputAt: Date.now() }));
      assert.ok(C.idle({ _lastInputAt: Date.now() - 10 * 60 * 1000 }));
    } finally { L.perform = realPerform; }
  });

  await test('UPDATE: the new version reports healthy — staged clears, "updated from" is kept; a checkout has nothing to apply', () => {
    const home = tmpdir('lain-uphome-');
    const health = path.join(tmpdir('lain-health-'), 'health-0.1.0');
    withEnv({ LAIN_CONFIG_DIR: home, LAIN_CONFIG_DIR: home, LAIN_HEALTH_FILE: health, LAIN_INSTALL_ROOT: null }, () => {
      U.writeState({ staged: { version: '0.0.9' }, available: null, applied: { version: '0.0.9', from: '0.0.8' } });
      assert.ok(U.markHealthy());
      assert.ok(fs.existsSync(health), 'the launcher sees the health mark');
      const st = U.readState();
      assert.strictEqual(st.staged, null);
      assert.strictEqual(st.applied.from, '0.0.8');
      assert.ok(st.applied.healthyAt);
      assert.strictEqual(U.installRoot(), null);
      assert.ok(!U.apply({}).ok);
    });
  });
};
