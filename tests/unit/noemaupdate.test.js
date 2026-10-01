'use strict';

/**
 * THE NOEMA UPDATER (packaging pass §H–I, §X) — against a real signed feed on disk and a real install layout.
 *
 *   - a manifest is trusted only when its Ed25519 signature verifies against a release key; a tampered manifest, or
 *     one signed by any other key, is refused — and the test key is honoured only in an isolated run
 *   - a downloaded package whose SHA-256 differs from the signed manifest is REJECTED and deleted; the installed
 *     version is untouched; so is a package that is not a Noema build
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
function feed({ key, version = '0.1.1', tamperHash = false, notNoema = false, channel = 'stable' }) {
  const dir = tmpdir('noema-feed-');
  const pkg = tmpdir('noema-pkg-');
  fs.mkdirSync(path.join(pkg, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'runtime', 'node.exe'), 'not really node');
  if (!notNoema) {
    fs.mkdirSync(path.join(pkg, 'app', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'app', 'bin', 'noema.js'), '// the new version\n');
  } else fs.writeFileSync(path.join(pkg, 'readme.txt'), 'something else');
  const name = `noema-${version}-win-x64.zip`;
  execFileSync(TAR, ['-a', '-cf', path.join(dir, name), '-C', pkg, ...fs.readdirSync(pkg)], { stdio: 'ignore', windowsHide: true });
  let sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
  if (tamperHash) sha = sha.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  const release = {
    schema: 1, product: 'noema', channel, version, released: new Date().toISOString(), minimumCompatible: '0.1.0', protocol: 1,
    notes: 'https://example.invalid/notes', summary: ['A test release'],
    assets: [{ arch: 'x64', kind: 'app', name, url: name, size: fs.statSync(path.join(dir, name)).size, sha256: sha }],
  };
  const bytes = Buffer.from(JSON.stringify(release, null, 2));
  fs.writeFileSync(path.join(dir, `manifest-${channel}.json`), bytes);
  fs.writeFileSync(path.join(dir, `manifest-${channel}.json.sig`), crypto.sign(null, bytes, key).toString('base64'));
  return { dir, release, bytes };
}

/** An installed Noema's layout: current → 0.1.0. */
function install() {
  const root = tmpdir('noema-install-');
  fs.mkdirSync(path.join(root, 'versions', '0.1.0', 'app', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'versions', '0.1.0', 'app', 'bin', 'noema.js'), '// the running version\n');
  fs.writeFileSync(path.join(root, 'current'), '0.1.0');
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
    const tampered = Buffer.from(f.bytes.toString('utf8').replace('0.1.1', '9.9.9'));
    assert.ok(!M.verifySignature(tampered, sig, [PUB]).ok, 'one changed byte is refused');
    assert.ok(!M.verifySignature(f.bytes, crypto.sign(null, f.bytes, other.privateKey).toString('base64'), [PUB]).ok, 'another key is refused');
    assert.ok(!M.verifySignature(f.bytes, '', [PUB]).ok, 'no signature is refused');
    assert.ok(!M.parse(Buffer.from('{"schema":1,"product":"other"}')).ok, 'not a Noema manifest');
  });

  await test('UPDATE: the test key is honoured only in an isolated run — a release build trusts its release keys alone', () => {
    withEnv({ NOEMA_UPDATE_TEST_KEY: PUB, NOEMA_ISOLATED: null, LAIN_ISOLATED: null }, () => {
      assert.strictEqual(trust.publicKeys().length, trust.RELEASE_KEYS.length);
    });
    withEnv({ NOEMA_UPDATE_TEST_KEY: PUB, NOEMA_ISOLATED: '1' }, () => {
      assert.ok(trust.publicKeys().includes(PUB));
    });
  });

  await test('UPDATE: check → stage → apply against a signed feed; the running version is never touched', async () => {
    const home = tmpdir('noema-uphome-');
    const root = install();
    const f = feed({ key: privateKey });
    await withEnv({ LAIN_CONFIG_DIR: home, NOEMA_CONFIG_DIR: home, NOEMA_INSTALL_ROOT: root, NOEMA_UPDATE_FEED: f.dir, NOEMA_UPDATE_TEST_KEY: PUB, NOEMA_ISOLATED: '1' }, async () => {
      const c = await U.check({ force: true });
      assert.strictEqual(c.state, 'available', JSON.stringify(c));
      assert.strictEqual(c.available.version, '0.1.1');
      const s = await U.stage({});
      assert.ok(s.ok, s.why);
      assert.ok(fs.existsSync(path.join(root, 'versions', '0.1.1', 'app', 'bin', 'noema.js')), 'unpacked beside the running version');
      assert.strictEqual(fs.readFileSync(path.join(root, 'versions', '0.1.0', 'app', 'bin', 'noema.js'), 'utf8'), '// the running version\n');
      assert.strictEqual(U.status().state, 'staged');
      const a = U.apply({ args: ['--resume', 's1'], cwd: root });
      assert.ok(a.ok, a.why);
      assert.strictEqual(a.restartCode, 75);
      const ptr = (n) => fs.readFileSync(path.join(root, n), 'utf8').trim();
      assert.strictEqual(ptr('current'), '0.1.1');
      assert.strictEqual(ptr('previous'), '0.1.0', 'the old version is kept for rollback');
      assert.strictEqual(ptr('pending'), '0.1.1', 'until it reports healthy');
      assert.deepStrictEqual(JSON.parse(ptr('restart.json')), { args: ['--resume', 's1'], cwd: root });
      assert.strictEqual(U.readState().applied.from, '0.1.0');
    });
  });

  await test('UPDATE: a package whose SHA-256 differs from the signed manifest is rejected and deleted', async () => {
    const home = tmpdir('noema-uphome-');
    const root = install();
    const f = feed({ key: privateKey, tamperHash: true });
    await withEnv({ LAIN_CONFIG_DIR: home, NOEMA_CONFIG_DIR: home, NOEMA_INSTALL_ROOT: root, NOEMA_UPDATE_FEED: f.dir, NOEMA_UPDATE_TEST_KEY: PUB, NOEMA_ISOLATED: '1' }, async () => {
      assert.strictEqual((await U.check({ force: true })).state, 'available');
      const s = await U.stage({});
      assert.ok(!s.ok);
      assert.match(s.why, /SHA-256/);
      assert.ok(!fs.existsSync(path.join(root, 'versions', '0.1.1')), 'nothing was unpacked');
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'staging')), [], 'the download was deleted');
      assert.strictEqual(fs.readFileSync(path.join(root, 'current'), 'utf8'), '0.1.0');
      assert.ok(!U.apply({}).ok, 'and there is nothing to apply');
    });
  });

  await test('UPDATE: a package that is not a Noema build is rejected; a foreign-signed feed never stages', async () => {
    const home = tmpdir('noema-uphome-');
    const root = install();
    const f = feed({ key: privateKey, notNoema: true });
    await withEnv({ LAIN_CONFIG_DIR: home, NOEMA_CONFIG_DIR: home, NOEMA_INSTALL_ROOT: root, NOEMA_UPDATE_FEED: f.dir, NOEMA_UPDATE_TEST_KEY: PUB, NOEMA_ISOLATED: '1' }, async () => {
      await U.check({ force: true });
      const s = await U.stage({});
      assert.ok(!s.ok);
      assert.match(s.why, /not a Noema build/);
      assert.ok(!fs.existsSync(path.join(root, 'versions', '0.1.1')));
    });
    const home2 = tmpdir('noema-uphome-');
    const g = feed({ key: other.privateKey });
    await withEnv({ LAIN_CONFIG_DIR: home2, NOEMA_CONFIG_DIR: home2, NOEMA_INSTALL_ROOT: root, NOEMA_UPDATE_FEED: g.dir, NOEMA_UPDATE_TEST_KEY: PUB, NOEMA_ISOLATED: '1' }, async () => {
      const c = await U.check({ force: true });
      assert.strictEqual(c.state, 'error');
      assert.match(c.why, /signature/);
      assert.ok(!(await U.stage({})).ok, 'nothing is available to stage');
    });
  });

  await test('UPDATE: the new version reports healthy — staged clears, "updated from" is kept; a checkout has nothing to apply', () => {
    const home = tmpdir('noema-uphome-');
    const health = path.join(tmpdir('noema-health-'), 'health-0.1.0');
    withEnv({ LAIN_CONFIG_DIR: home, NOEMA_CONFIG_DIR: home, NOEMA_HEALTH_FILE: health, NOEMA_INSTALL_ROOT: null }, () => {
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
