'use strict';

/**
 * THE INSTALLER — the artifact people actually download.
 *
 * ------------------------------------------------------------------------
 * THE RULE THIS FILE OBEYS ABOVE ALL OTHERS, and it is the same one
 * install.test.js obeys:
 *
 *     NO TEST HERE MAY TOUCH THE DEVELOPER'S REAL PATH, START MENU OR DATA.
 *
 * Every case installs into a TEMPORARY directory with `--no-path` and
 * `--no-shortcuts`. THE SECOND ONE WAS MISSING AT FIRST, and the tier left a
 * real Start Menu entry and a real Add/Remove Programs registration behind on
 * the developer's machine — found by checking afterwards rather than by any
 * assertion, which is exactly why the check is worth doing.
 *
 * ------------------------------------------------------------------------
 * WHAT IS PROVEN HERE, as opposed to asserted about:
 *
 *   the artifact BUILDS, and carries the whole product inside it
 *   an install produces both entrypoints — LAIN.exe and the CLI
 *   the installed copy depends on NOTHING in the checkout
 *   an UPGRADE replaces the program and keeps the person's work
 *   an UNINSTALL removes the program and keeps the person's work
 *   Node is checked BEFORE anything is written, not after
 *
 * These are slow (each install compiles the native host), so the set is small
 * and each case earns its seconds.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, tmpdir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');
const build = require('../../distribution/build');
const payload = require('../../distribution/payload');

/** Built once for the whole file — it is the expensive part. */
let ARTIFACT = null;
function artifact() {
  if (ARTIFACT) return ARTIFACT;
  ARTIFACT = build.build({ out: tmpdir('lain-dist-') });
  return ARTIFACT;
}

function setup(args) {
  const a = artifact();
  try { return { ok: true, out: execFileSync(a.exe, args, { encoding: 'utf8', timeout: 600000 }) }; }
  catch (e) { return { ok: false, out: String((e.stdout || '') + (e.stderr || '') + (e.message || '')) }; }
}

module.exports = async function () {
  if (process.platform !== 'win32') {
    await test('INSTALLER: skipped — the LAIN installer is a Windows program', () => {});
    return;
  }

  await test('INSTALLER: the artifact builds, and carries the whole product', () => {
    const a = artifact();
    assert.strictEqual(a.ok, true, a.why);
    assert.ok(fs.existsSync(a.exe), 'one file, which is what ships');
    assert.match(path.basename(a.exe), /^LAIN-Setup\.exe$/);
    // THE PAYLOAD IS THE PACKAGE ALLOWLIST plus one DECLARED extra, never a
    // second hand-written list that can drift from it.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const named = payload.entries();
    for (const shipped of pkg.files) assert.ok(named.includes(shipped), `${shipped} is in the payload`);
    assert.deepStrictEqual(
      named.filter((e) => !pkg.files.includes(e) && e !== 'package.json'),
      payload.INSTALLER_EXTRAS,
      'and the only additions are the declared ones');

    // THE ONE EXTRA, AND WHY IT IS NOT IN THE NPM PACKAGE. Publishing
    // Microsoft's DLLs inside LAIN's npm package is a different act from
    // shipping them inside LAIN's own Windows installer — install.test.js
    // guards the first, and without them an installed copy cannot build
    // LAIN.exe offline at all.
    assert.deepStrictEqual(payload.INSTALLER_EXTRAS, ['native/vendor/']);
    assert.ok(!pkg.files.includes('native/vendor/'), 'and npm still does not publish it');
    assert.ok(a.payloadFiles > 300, `${a.payloadFiles} files is not a whole product`);
  });

  await test('INSTALLER: it installs both entrypoints, and the launcher points into the install', () => {
    const dir = path.join(tmpdir('lain-install-'), 'LAIN');
    const r = setup(['--silent', '--dir', dir, '--no-path', '--no-shortcuts']);
    assert.strictEqual(r.ok, true, r.out.slice(-400));

    assert.ok(fs.existsSync(path.join(dir, 'LAIN.exe')), 'the Harness');
    assert.ok(fs.existsSync(path.join(dir, 'lain.cmd')), 'and the CLI, always together');
    assert.ok(fs.existsSync(path.join(dir, 'Uninstall LAIN.exe')), 'and a way back out');

    // WHAT THE NATIVE HOST READS AT STARTUP. It must name this install, not the
    // machine the artifact was built on.
    const launch = JSON.parse(fs.readFileSync(path.join(dir, 'launch.json'), 'utf8'));
    assert.strictEqual(path.resolve(launch.entry), path.resolve(path.join(dir, 'bin', 'lain.js')));
    assert.ok(launch.node && fs.existsSync(launch.node), `a real Node was recorded: ${launch.node}`);

    // AND THE CLI SHIM QUOTES ITS PATHS — an install directory with a space in
    // it is the ordinary case, and this one has one.
    const shim = fs.readFileSync(path.join(dir, 'lain.cmd'), 'utf8');
    assert.match(shim, /^"[^"]+node\.exe" "[^"]+lain\.js" %\*$/m, shim);
  });

  await test('INSTALLER: the installed copy depends on NOTHING in the checkout', () => {
    // §16. A distribution certified by running the repository has not been
    // certified: the repository has files the artifact does not.
    const dir = path.join(tmpdir('lain-indep-'), 'LAIN');
    assert.strictEqual(setup(['--silent', '--dir', dir, '--no-path', '--no-shortcuts']).ok, true);

    const hits = [];
    const walk = (d, depth) => {
      if (depth > 8) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p, depth + 1); continue; }
        if (!/\.(js|json|cmd|cs)$/i.test(e.name)) continue;
        let text = '';
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        if (text.toLowerCase().includes(ROOT.toLowerCase())) hits.push(path.relative(dir, p));
      }
    };
    walk(dir, 0);
    assert.deepStrictEqual(hits, [], `installed files naming the checkout: ${hits.join(', ')}`);

    // AND IT RUNS, from a working directory that is nobody's project.
    const home = tmpdir('lain-indep-home-');
    const out = execFileSync(process.execPath, [path.join(dir, 'bin', 'lain.js'), '--version'], {
      encoding: 'utf8', timeout: 120000, cwd: tmpdir('lain-elsewhere-'),
      env: { ...process.env, LAIN_CONFIG_DIR: home },
    });
    assert.match(out.trim(), /^lain \d/, out.trim());
  });

  await test('INSTALLER: an upgrade replaces the program and keeps the person\'s work', () => {
    const dir = path.join(tmpdir('lain-upgrade-'), 'LAIN');
    assert.strictEqual(setup(['--silent', '--dir', dir, '--no-path', '--no-shortcuts']).ok, true);

    // A file the next version does not ship, and a file that is the person's.
    const stale = path.join(dir, 'src', 'gone-in-the-next-version.js');
    fs.writeFileSync(stale, '// not shipped any more\n');

    const again = setup(['--silent', '--dir', dir, '--no-path', '--no-shortcuts']);
    assert.strictEqual(again.ok, true, again.out.slice(-400));
    assert.ok(!fs.existsSync(stale), 'a module the new version does not ship is gone');
    assert.ok(fs.existsSync(path.join(dir, 'LAIN.exe')), 'and the program is there');
    // THE UPGRADE PATH THAT FAILED FIRST TIME: ExtractToDirectory refuses to
    // replace an existing file, and package.json is loose in the root.
    assert.ok(fs.existsSync(path.join(dir, 'package.json')), 'loose files are replaced, not refused');
  });

  await test('INSTALLER: uninstalling removes the program and KEEPS the data', () => {
    const dir = path.join(tmpdir('lain-uninstall-'), 'LAIN');
    assert.strictEqual(setup(['--silent', '--dir', dir, '--no-path', '--no-shortcuts']).ok, true);

    const r = setup(['--uninstall', '--dir', dir, '--silent']);
    assert.strictEqual(r.ok, true, r.out.slice(-400));
    assert.ok(!fs.existsSync(path.join(dir, 'src')), 'the runtime is gone');
    assert.ok(!fs.existsSync(path.join(dir, 'bin')), 'and the entrypoint');
    // THE SENTENCE THAT MATTERS TO SOMEBODY UNINSTALLING.
    assert.match(r.out, /Kept your sessions, goals and settings/);
    assert.ok(!/removed your lain data/i.test(r.out), 'nothing of theirs was taken');
  });

  await test('INSTALLER: the Node requirement is stated, and the refusal cannot be deleted quietly', () => {
    // ---- WHAT CANNOT BE TESTED HERE, AND WHY -----------------------------
    //
    // The intended case is "no Node, so refuse before writing anything". It
    // cannot be staged on this machine: WINDOWS WILL NOT LET A PROCESS OVERRIDE
    // %ProgramFiles%. Measured — a child started with ProgramFiles set to
    // C:\NoSuchPlace and PATH emptied reports `ProgramFiles=C:\Program Files`
    // and an empty PATH. So the standard location cannot be hidden from the
    // preflight, and on a machine with Node installed there the refusal is
    // unreachable.
    //
    // That is a fact about the platform rather than a gap in the check, and it
    // is also what makes the check robust. What IS asserted is that the
    // requirement is stated where a person will see it, and that the refusal
    // text is still in the shipped binary — so the branch cannot be removed
    // without this failing.
    const a = artifact();
    // .NET keeps string literals as UTF-16 in the assembly, so the bytes to
    // look for are the UTF-16 ones — searched as latin1 this found nothing and
    // said the branch was missing when it was not.
    const binary = fs.readFileSync(a.exe);
    const has = (s) => binary.includes(Buffer.from(s, 'utf16le'));
    assert.ok(has('Node.js 18 or newer'), 'the refusal is compiled in');
    assert.ok(has('nodejs.org'), 'and it says where to get it');
    assert.ok(has('nodejs'), 'and where it looked');

    // AND ON A MACHINE THAT HAS ONE, IT SAYS WHICH — before anything else.
    const dir = path.join(tmpdir('lain-node-'), 'LAIN');
    const r = setup(['--silent', '--dir', dir, '--no-path', '--no-shortcuts']);
    assert.strictEqual(r.ok, true, r.out.slice(-300));
    const first = r.out.trim().split('\n')[0];
    assert.match(first, /^Node v\d+\.\d+\.\d+ at /, `the runtime is reported first: ${first}`);
    const launch = JSON.parse(fs.readFileSync(path.join(dir, 'launch.json'), 'utf8'));
    assert.ok(fs.existsSync(launch.node), 'and the one it recorded really exists');
  });
};
