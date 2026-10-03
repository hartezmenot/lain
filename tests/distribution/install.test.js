'use strict';

/**
 * INSTALLATION — every case installs into a TEMPORARY directory and drives PATH
 * through an INJECTED FAKE.
 *
 * ------------------------------------------------------------------------
 * THE RULE THIS FILE OBEYS ABOVE ALL OTHERS.
 *
 *     NO TEST HERE MAY TOUCH THE DEVELOPER'S REAL PATH — OR THEIR START MENU.
 *
 * `distribution/pathenv.js` takes an adapter for exactly this reason, and every
 * case below passes one. A test that persisted a PATH entry would be damage
 * outside the tree that no assertion sees — the same class of failure as a test
 * writing the user's real config home, which `tests/run.js` argues at length and
 * refuses to allow.
 *
 * The Start Menu half obeys the same rule by the same means: `install` takes
 * `desktop: false` everywhere below, and the one case that DOES write a
 * shortcut redirects `%APPDATA%` to a temporary directory first — which is how
 * Windows itself resolves the Start Menu, so nothing is being pretended.
 *
 * The one exception is DETECTION, which only ever READS. `where lain` /
 * `command -v lain` change nothing.
 *
 * ------------------------------------------------------------------------
 * WHAT IS ACTUALLY PROVEN HERE, as opposed to asserted about:
 *
 *   the launcher files exist AND RUN — `--version` is really executed
 *   PATH is APPENDED, never rebuilt, and every prior entry survives verbatim
 *   a second install is idempotent — no duplicate entry, no second block
 *   a DENIED PATH write still installs, and reports the manual command
 *   uninstall removes what it wrote and NOTHING the person owns
 *   development mode needs none of it
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const install = require('../../distribution/install');
const uninstall = require('../../distribution/uninstall');
const pathenv = require('../../distribution/pathenv');
const detect = require('../../distribution/detect');

const ROOT = path.join(__dirname, '..', '..');

/** A real newline, spelled without an escape the shell transport can eat. */
const NL = String.fromCharCode(10);

function tmpBin() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lain-dist-')), 'bin'); }

/**
 * A FAKE PERSISTENT PATH. It is a string in this process and nothing else — no
 * registry, no profile, no environment.
 */
function fakeEnv(initial = '/usr/bin:/bin', sep = ':') {
  const state = { value: initial, writes: 0, denied: false };
  return {
    sep,
    state,
    get() { return state.value; },
    set(v) {
      if (state.denied) throw new Error('Access is denied.');
      state.writes += 1;
      state.value = v;
    },
    manual(dir) { return `ADD ${dir} BY HAND`; },
  };
}

/**
 * A fake PATH in THIS platform's own shape, for tests that put a real temp
 * directory on it. Found on the move to D:\lain (2026-09-23): with ':' as the
 * separator a Windows temp dir `C:\...\bin` split into `C` and `\...\bin`, and
 * `\...\bin` resolved against whatever DRIVE the test ran from. It passed on C:
 * by coincidence and failed on D:.
 */
function hostEnv() {
  return fakeEnv(process.platform === 'win32' ? 'C:\\Windows;C:\\Windows\\System32' : '/usr/bin:/bin', path.delimiter);
}

module.exports = async function () {
  // ------------------------------------------------------------- the PATH --

  await test('PATH: an entry is APPENDED and every prior entry survives verbatim', () => {
    const env = fakeEnv('/usr/bin:/bin:/opt/weird path/bin');
    const before = env.get();
    const r = pathenv.ensure(env, '/home/me/.lain-v2/bin');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.changed, true);
    assert.ok(env.get().startsWith(before), 'the original value must be a prefix — nothing rewritten');
    assert.strictEqual(env.get(), `${before}:/home/me/.lain-v2/bin`);
  });

  await test('PATH: a second install adds nothing and says so', () => {
    // An installer that reports "added to PATH" on every run trains people to
    // ignore the line on the one run where it was true.
    const env = fakeEnv('/usr/bin:/home/me/.lain-v2/bin');
    const r = pathenv.ensure(env, '/home/me/.lain-v2/bin');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(env.state.writes, 0, 'it must not write at all');
  });

  await test('PATH: a trailing separator is not a different directory', () => {
    const env = fakeEnv('/usr/bin:/home/me/bin/');
    assert.strictEqual(pathenv.ensure(env, '/home/me/bin').changed, false);
  });

  await test('PATH: on Windows the comparison is case-insensitive', function () {
    if (process.platform !== 'win32') { process.stdout.write('      (not Windows — NOT VERIFIED here)\n'); return; }
    const env = fakeEnv('C:\\Windows;C:\\Users\\Me\\.lain-v2\\Bin', ';');
    assert.strictEqual(pathenv.ensure(env, 'C:\\Users\\Me\\.lain-v2\\bin').changed, false);
  });

  await test('PATH: empty entries left by a stray separator are ignored, not preserved as ""', () => {
    assert.deepStrictEqual(pathenv.entries('/a::/b:', ':'), ['/a', '/b']);
  });

  await test('PATH: removal takes exactly one entry and leaves the rest alone', () => {
    const env = fakeEnv('/usr/bin:/home/me/.lain-v2/bin:/opt/tools');
    const r = pathenv.remove(env, '/home/me/.lain-v2/bin');
    assert.strictEqual(r.changed, true);
    assert.strictEqual(env.get(), '/usr/bin:/opt/tools');
  });

  await test('PATH: removing something that is not there changes nothing', () => {
    const env = fakeEnv('/usr/bin:/bin');
    const r = pathenv.remove(env, '/nowhere');
    assert.strictEqual(r.changed, false);
    assert.strictEqual(env.state.writes, 0);
  });

  // ------------------------------------------------------ a real install --

  await test('INSTALL: a fresh install writes launchers that ACTUALLY RUN', () => {
    const dir = tmpBin();
    const env = fakeEnv();
    const r = install.install({ dir, env, desktop: false });
    assert.ok(r.launchers.length >= 1, 'no launcher was written');
    for (const f of r.launchers) assert.ok(fs.existsSync(f), `${f} is missing`);
    // THE CONTRACT: not "files copied" but "it ran".
    assert.strictEqual(r.verified, true, `the launcher did not run: ${JSON.stringify(r.steps)}`);
    assert.match(String(r.version), /^LAIN CLI\s/);
    assert.strictEqual(r.ok, true);
  });

  await test('INSTALL: the launcher points at the ONE canonical runtime, never a copy', () => {
    // §1: there must be exactly one LAIN runtime. A copied src/ is a fork that
    // drifts, and the first symptom is a bug fixed in the repo and still live
    // on PATH.
    const dir = tmpBin();
    const r = install.install({ dir, env: fakeEnv(), desktop: false });
    const body = fs.readFileSync(r.launchers[0], 'utf8');
    const entry = detect.entrypoint();
    const normalised = body.replace(/\\/g, '/');
    assert.ok(normalised.includes(entry.replace(/\\/g, '/')),
      `the launcher does not reference ${entry}:\n${body}`);
    assert.ok(!fs.existsSync(path.join(dir, 'src')), 'the runtime must not be copied into the bin directory');
  });

  await test('INSTALL: a path WITH SPACES in it still runs', () => {
    // §7 names this explicitly, and it is the classic Windows launcher bug:
    // an unquoted path stops at the first space, so `C:\Program Files\...`
    // becomes `C:\Program`. Both the node binary and the entrypoint are
    // interpolated into the shim, and both can contain one.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lain dist '));
    const dir = path.join(base, 'my bin');
    const r = install.install({ dir, env: fakeEnv(), desktop: false });
    assert.strictEqual(r.verified, true, `a launcher in "${dir}" did not run: ${JSON.stringify(r.steps)}`);
    assert.match(String(r.version), /^LAIN CLI\s/);
  });

  await test('INSTALL: it is idempotent — twice is the same as once', () => {
    const dir = tmpBin();
    const env = hostEnv();
    install.install({ dir, env, desktop: false });
    const writes = env.state.writes;
    const second = install.install({ dir, env, desktop: false });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(env.state.writes, writes, 'the second install must not write PATH again');
    assert.strictEqual(pathenv.entries(env.get(), path.delimiter).filter((e) => pathenv.samePath(e, dir)).length, 1,
      'exactly one entry, however many times it is run');
  });

  await test('INSTALL: a DENIED PATH write still installs, and hands over the manual command', () => {
    // §7: installation succeeds, the limitation is explained, the location is
    // given, and global availability is NOT falsely reported.
    const dir = tmpBin();
    const env = fakeEnv();
    env.state.denied = true;
    const r = install.install({ dir, env, desktop: false });
    assert.strictEqual(r.launchers.length >= 1, true, 'the launcher must still be written');
    assert.strictEqual(r.verified, true, 'and it must still run');
    assert.ok(r.warnings.some((w) => /PATH was not changed/.test(w)), 'the limitation must be stated');
    assert.match(r.manual, /ADD .* BY HAND/, 'and a deterministic manual command given');
    const text = install.render(r);
    assert.ok(!/^\s*Ready\./m.test(text), `it must not claim readiness:\n${text}`);
    assert.match(text, /To put it on PATH yourself/);
  });

  await test('INSTALL: --no-path leaves PATH completely alone', () => {
    const dir = tmpBin();
    const env = fakeEnv();
    const r = install.install({ dir, env, skipPath: true, desktop: false });
    assert.strictEqual(env.state.writes, 0);
    assert.strictEqual(r.ok, true, 'and it still installs and verifies');
  });

  await test('INSTALL: a missing runtime is refused rather than half-done', () => {
    const dir = tmpBin();
    const real = detect.entrypoint;
    detect.entrypoint = () => path.join(os.tmpdir(), 'definitely-not-here-9f3a', 'lain.js');
    try {
      const r = install.install({ dir, env: fakeEnv(), desktop: false });
      assert.strictEqual(r.ok, false);
      assert.ok(r.steps.some((s) => !s.ok && /entrypoint is missing/.test(s.text)));
      assert.strictEqual(r.launchers.length, 0, 'nothing may be written when the runtime is absent');
    } finally { detect.entrypoint = real; }
  });

  await test('INSTALL: the report never says Ready when a new shell is needed', () => {
    const dir = tmpBin();
    const r = install.install({ dir, env: fakeEnv(), desktop: false });
    const text = install.render(r);
    if (r.needsNewShell) {
      assert.match(text, /Open a NEW terminal/);
      assert.ok(!/^\s*Ready\./m.test(text), 'a shell that cannot see it yet is not ready');
    }
    // and the full path is always given, so it is usable immediately either way
    assert.ok(text.includes(dir), 'the report must name where the launcher is');
  });

  // ----------------------------------------------------------- uninstall --

  await test('UNINSTALL: it removes what it wrote and the PATH entry', () => {
    const dir = tmpBin();
    const env = hostEnv();
    install.install({ dir, env, desktop: false });
    assert.ok(fs.readdirSync(dir).length > 0);
    assert.strictEqual(pathenv.contains(env.get(), dir, path.delimiter), true, 'the install really put it on PATH');
    const r = uninstall.uninstall({ dir, env });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fs.readdirSync(dir).length, 0, 'every launcher must be gone');
    assert.strictEqual(pathenv.contains(env.get(), dir, path.delimiter), false, 'and the PATH entry with them');
  });

  await test('UNINSTALL: it never touches a file it did not write', () => {
    const dir = tmpBin();
    const env = fakeEnv();
    install.install({ dir, env, desktop: false });
    const mine = path.join(dir, 'my-own-script.sh');
    fs.writeFileSync(mine, 'echo hello');
    uninstall.uninstall({ dir, env });
    assert.ok(fs.existsSync(mine), 'a file the person put there must survive');
  });

  await test('UNINSTALL: sessions, config and the checkout are kept, and said so', () => {
    // An uninstaller that takes the sessions with it is data loss wearing a
    // feature's clothes.
    const r = uninstall.uninstall({ dir: tmpBin(), env: fakeEnv() });
    const text = uninstall.render(r);
    assert.match(text, /Left in place, deliberately/);
    assert.match(text, /sessions/);
    assert.match(text, /this checkout/);
  });

  await test('UNINSTALL: running it twice is not an error', () => {
    const dir = tmpBin();
    const env = fakeEnv();
    install.install({ dir, env, desktop: false });
    uninstall.uninstall({ dir, env });
    const again = uninstall.uninstall({ dir, env });
    assert.strictEqual(again.ok, true);
  });

  // ------------------------------------------------- the desktop entry ------
  //
  // WHY THIS EXISTS AT ALL. `lain` on PATH is the CLI's story and it was the
  // only one: LAIN.exe was written into LAIN's own directory, where nothing
  // points at it. A Windows application you can only start by typing a path
  // into a terminal is one you start by opening a terminal first, which is the
  // thing the native Harness exists to make optional.

  await test('DESKTOP: the Start Menu entry is written, points at LAIN.exe, and uninstall takes it away', async () => {
    if (process.platform !== 'win32') return;
    const shortcut = require('../../distribution/shortcut');
    // %APPDATA% IS THE REDIRECTION. Windows resolves the per-user Start Menu
    // through it, so pointing it at a temporary directory is the real lookup
    // aimed somewhere harmless — not a stub of one.
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-appdata-'));
    const realAppData = process.env.APPDATA;
    process.env.APPDATA = fake;
    try {
      assert.ok(shortcut.shortcutPath().startsWith(fake), 'the entry is being written inside the temporary profile');
      assert.strictEqual(shortcut.status().exists, false, 'and there is none there yet');

      // A REAL .lnk, pointing at a real file — but not LAIN.exe, because
      // building the desktop host is desktop.js's job and this case is about
      // the shortcut. `install` refuses a target that is not there, which is
      // the half worth proving.
      const missing = shortcut.install({ target: path.join(fake, 'not-here.exe') });
      assert.strictEqual(missing.ok, false, 'it will not point at something absent');
      assert.match(missing.why, /not at/);

      const target = path.join(fake, 'LAIN.exe');
      fs.writeFileSync(target, 'MZ');
      const made = shortcut.install({ target });
      assert.strictEqual(made.ok, true, `the shortcut was written: ${made.why}`);
      assert.ok(fs.existsSync(made.link), 'and it is on disk');
      assert.strictEqual(shortcut.status().exists, true);

      // IT POINTS WHERE IT SAYS. Read back through the same COM object that
      // wrote it, because a .lnk is a binary shell structure and asserting on
      // its bytes would be asserting on a format nobody here controls.
      const { execFileSync } = require('child_process');
      const read = execFileSync('powershell', ['-NoProfile', '-Command',
        `(New-Object -ComObject WScript.Shell).CreateShortcut(${JSON.stringify(made.link)}).TargetPath`],
      { encoding: 'utf8' }).trim();
      // REAL PATHS ON BOTH SIDES. `os.tmpdir()` hands back the 8.3 form
      // (HARTEZ~1) and the shell stores the long one — the same file, spelled
      // two ways, which is a difference about Windows and not about the
      // shortcut.
      const real = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return p.toLowerCase(); } };
      assert.strictEqual(real(read), real(target), 'the shortcut points at LAIN.exe');

      // WRITING IT AGAIN IS NOT AN ERROR, and does not make a second one.
      assert.strictEqual(shortcut.install({ target }).ok, true);
      assert.strictEqual(fs.readdirSync(shortcut.menuDir()).filter((f) => f === shortcut.NAME).length, 1);

      // AND UNINSTALL TAKES IT AWAY — twice, because doing it twice is not an
      // error either.
      const gone = uninstall.uninstall({ dir: tmpBin(), env: fakeEnv() });
      assert.strictEqual(shortcut.status().exists, false, 'the entry is gone');
      assert.ok(gone.steps.some((s) => /Start Menu/.test(s.text)), 'and the uninstall said so');
      assert.strictEqual(uninstall.uninstall({ dir: tmpBin(), env: fakeEnv() }).ok, true);
    } finally {
      if (realAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = realAppData;
      try { fs.rmSync(fake, { recursive: true, force: true }); } catch { /* temp */ }
    }
  });

  await test('DESKTOP: an install can decline it, and never fails because of it', () => {
    const dir = tmpBin();
    const env = fakeEnv();
    const r = install.install({ dir, env, desktop: false });
    assert.strictEqual(r.desktop, null, 'no desktop was installed');
    assert.strictEqual(r.shortcut, null);
    assert.strictEqual(r.ok, true, 'and the install is still a success — the CLI is the product here');
  });

  // ------------------------------------------------- the unix profile half --
  //
  // These run on EVERY platform. `unix.js`'s profile writer is plain file I/O
  // over a home directory it is handed, so the half that was previously only
  // reasoned about on Windows can be exercised here for real.

  await test('UNIX: the block goes in the file THAT SHELL actually reads', () => {
    const unix = require('../../distribution/platform/unix');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-home-'));
    assert.strictEqual(path.basename(unix.profileFile(home, '/bin/zsh')), '.zshrc');
    assert.strictEqual(path.basename(unix.profileFile(home, '/usr/bin/fish')), 'config.fish');
    // bash prefers an EXISTING .bashrc; with neither present it falls back to
    // .profile, which bash, dash and sh all read for a login shell.
    assert.strictEqual(path.basename(unix.profileFile(home, '/bin/bash')), '.profile');
    fs.writeFileSync(path.join(home, '.bashrc'), '');
    assert.strictEqual(path.basename(unix.profileFile(home, '/bin/bash')), '.bashrc');
    assert.strictEqual(path.basename(unix.profileFile(home, '/bin/sh')), '.profile');
  });

  await test('UNIX: it appends a MARKED block and leaves the rest of the file alone', () => {
    const unix = require('../../distribution/platform/unix');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-home-'));
    const rc = path.join(home, '.zshrc');
    const original = ['# years of careful configuration', 'export EDITOR=vim', 'alias g=git', ''].join(NL);
    fs.writeFileSync(rc, original);
    const env = unix.envFor(home, '/bin/zsh');
    pathenv.ensure(env, '/home/me/.lain-v2/bin');
    const after = fs.readFileSync(rc, 'utf8');
    assert.ok(after.startsWith(original), 'a profile is a file people have spent years on');
    assert.ok(after.includes('# >>> LAIN Harness >>>'));
    assert.ok(after.includes('export PATH="/home/me/.lain-v2/bin:$PATH"'), after);
    assert.ok(after.includes('# <<< LAIN Harness <<<'));
  });

  await test('UNIX: running it twice leaves ONE block, not two', () => {
    const unix = require('../../distribution/platform/unix');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-home-'));
    const env = unix.envFor(home, '/bin/zsh');
    pathenv.ensure(env, '/home/me/.lain-v2/bin');
    const r = pathenv.ensure(env, '/home/me/.lain-v2/bin');
    assert.strictEqual(r.changed, false, 'the second run must recognise its own block');
    const text = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    assert.strictEqual(text.split('>>> LAIN Harness >>>').length - 1, 1);
  });

  await test('UNIX: removal takes the block out and restores the file', () => {
    const unix = require('../../distribution/platform/unix');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-home-'));
    const rc = path.join(home, '.zshrc');
    fs.writeFileSync(rc, 'alias g=git' + NL);
    const env = unix.envFor(home, '/bin/zsh');
    pathenv.ensure(env, '/home/me/.lain-v2/bin');
    pathenv.remove(env, '/home/me/.lain-v2/bin');
    const after = fs.readFileSync(rc, 'utf8');
    assert.ok(!after.includes('LAIN Harness'), 'the block survived: ' + after);
    assert.ok(after.includes('alias g=git'), 'and the person own lines must survive too');
  });

  await test('UNIX: fish gets fish syntax, not bash syntax', () => {
    const unix = require('../../distribution/platform/unix');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-home-'));
    const env = unix.envFor(home, '/usr/bin/fish');
    pathenv.ensure(env, '/home/me/.lain-v2/bin');
    const text = fs.readFileSync(path.join(home, '.config', 'fish', 'config.fish'), 'utf8');
    assert.ok(text.includes('fish_add_path'));
    assert.ok(!text.includes('export PATH='), 'fish has no `export PATH=`');
  });

  await test('UNIX: the launcher execs, so signals and exit codes are node own', () => {
    const unix = require('../../distribution/platform/unix');
    const body = unix.shims('/opt/lain/bin/lain.js').lain;
    assert.ok(body.startsWith('#!/bin/sh'), body);
    assert.ok(body.includes(NL + 'exec '), 'a wrapper that forks swallows Ctrl+C');
    assert.ok(body.includes('"$@"'), 'arguments must be passed through quoted');
  });


  // ------------------------------------------------------------ detection --

  await test('DETECT: it reads only — it can never change anything', () => {
    const src = fs.readFileSync(path.join(ROOT, 'distribution', 'detect.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['writeFileSync', 'mkdirSync', 'unlinkSync', 'SetEnvironmentVariable', 'appendFileSync']) {
      assert.ok(!code.includes(forbidden), `detect.js must not ${forbidden}`);
    }
  });

  await test('DETECT: the entrypoint is the ONE canonical bin/lain.js', () => {
    assert.strictEqual(path.basename(detect.entrypoint()), 'lain.js');
    assert.strictEqual(path.basename(path.dirname(detect.entrypoint())), 'bin');
    assert.ok(fs.existsSync(detect.entrypoint()));
  });

  await test('DETECT: the bin directory is a BIN directory, never a repository root', () => {
    // §6: a checkout on PATH puts every script in it one typo away from running.
    const bin = detect.binDir();
    assert.strictEqual(path.basename(bin), 'bin');
    assert.notStrictEqual(path.resolve(bin), path.resolve(ROOT));
  });

  await test('DETECT: a probe reports shadowing rather than hiding it', () => {
    const p = detect.probe({ dir: tmpBin() });
    for (const k of ['binDir', 'launchers', 'installed', 'onLivePath', 'resolutions', 'resolvesTo', 'shadowed', 'version']) {
      assert.ok(Object.prototype.hasOwnProperty.call(p, k), `the probe is missing ${k}`);
    }
    assert.strictEqual(p.installed, false, 'an empty directory is not an installation');
  });

  // ------------------------------------------------------- the boundary --

  await test('BOUNDARY: nothing in src/ may reach the installer', () => {
    // §15, enforced structurally. A running LAIN must not be able to mutate
    // PATH, and the way to guarantee that is for the code to be unreachable.
    const offenders = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        const text = fs.readFileSync(p, 'utf8');
        if (/require\((['"])[^'"]*distribution\//.test(text)) offenders.push(path.relative(ROOT, p));
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepStrictEqual(offenders, [], `these reach into distribution/: ${offenders.join(', ')}`);
  });

  await test('BOUNDARY: no PATH mutation lives anywhere in src/', () => {
    const offenders = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        const code = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/SetEnvironmentVariable|setx\s|process\.env\.PATH\s*=/.test(code)) offenders.push(path.relative(ROOT, p));
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepStrictEqual(offenders, [], `the runtime must never edit PATH: ${offenders.join(', ')}`);
  });

  // --------------------------------------------------- development mode --

  await test('DEV: the repository runs with no installation at all', () => {
    // §10: developers must not have to install anything, or modify their PATH,
    // to run LAIN or its tests.
    const { spawnSync } = require('child_process');
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-dev-'));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'lain.js'), '--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, LAIN_CONFIG_DIR: cfg, LAIN_HOME: path.join(cfg, 'sup') },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(String(r.stdout), /^LAIN CLI\s/);
  });

  await test('DEV: --doctor runs with no provider, no session and no install', () => {
    // The post-install verification command must work on a machine that has
    // not been configured yet — which is every machine, at the moment it is
    // checked.
    const { spawnSync } = require('child_process');
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-doc-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-docp-'));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'lain.js'), '--doctor'], {
      encoding: 'utf8', windowsHide: true, timeout: 120000, cwd,
      env: { ...process.env, LAIN_CONFIG_DIR: cfg, LAIN_HOME: path.join(cfg, 'sup') },
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.match(out, /LAIN Harness/);
    assert.match(out, /Core/);
    assert.match(out, /Verification/);
    assert.ok(!/no saved sessions|session \d/.test(out), 'it must not create a session');
    assert.strictEqual(r.status, 0, `core must be available on a clean machine:\n${out}`);
  });

  await test('DOCTOR: it CREATES NOTHING in the directory it is run in', () => {
    // A diagnostic with side effects is a diagnostic people stop running. The
    // obvious writability probe — mkdir the task root and write in it — left a
    // `.lain/` behind in whatever directory somebody checked.
    const { spawnSync } = require('child_process');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-clean-'));
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-cleancfg-'));
    const before = fs.readdirSync(cwd);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'lain.js'), '--doctor'], {
      encoding: 'utf8', windowsHide: true, timeout: 120000, cwd,
      env: { ...process.env, LAIN_CONFIG_DIR: cfg, LAIN_HOME: path.join(cfg, 'sup') },
    });
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.deepStrictEqual(fs.readdirSync(cwd), before, 'the doctor wrote into the working directory');
    assert.match(r.stdout, /will be created/, 'and it says the storage does not exist yet, rather than making it');
  });

  await test('DOCTOR: an absent OPTIONAL capability is never reported as an error', () => {
    // §12/§13: installation must not fail because Docker is missing.
    const { Harness } = require('../../src/harness');
    const rows = [
      { group: 'Core', name: 'runtime', kind: 'core', state: 'AVAILABLE', why: '' },
      { group: 'Optional', name: 'docker', kind: 'optional', state: 'UNAVAILABLE', why: 'not installed' },
    ];
    const s = Harness.summarise(rows);
    assert.strictEqual(s.ok, true, 'a missing optional capability must not fail the summary');
    assert.deepStrictEqual(s.unavailable, ['docker']);
    const text = require('../../src/harnessreport').render(rows, s);
    assert.match(text, /These are not errors/);
  });

  await test('DOCTOR: a broken CORE capability IS an error', () => {
    const { Harness } = require('../../src/harness');
    const s = Harness.summarise([
      { group: 'Core', name: 'task storage', kind: 'core', state: 'MISCONFIGURED', why: 'not writable' },
    ]);
    assert.strictEqual(s.ok, false);
    assert.match(s.why, /task storage/);
  });

  // ------------------------------------------------------------ packaging --

  await test('PACKAGE: one executable, one entrypoint, no second CLI', () => {
    // ONE PROGRAM: `lain`, and `lain` — its name before the rename — as a shim to the same Core and home (bin/lain.js
    // prints the deprecation once and runs the same boot). No `lain-cli`, `lain-harness` or `lain-runtime`.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(pkg.bin).sort(), ['lain', 'lain'], 'the command and its deprecated alias');
    assert.strictEqual(pkg.bin.lain, 'bin/lain.js');
    assert.strictEqual(pkg.bin.lain, 'bin/lain.js');
    assert.match(fs.readFileSync(path.join(ROOT, 'bin', 'lain.js'), 'utf8'), /require\('\.\.\/src\/boot'\)\.start\(\{ via: 'lain' \}\)/, 'the alias is the same program');
  });

  await test('PACKAGE: the published files are an ALLOWLIST that carries the runtime', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(Array.isArray(pkg.files) && pkg.files.length, 'without `files`, npm ships logs, tests and v1-backup');
    for (const needed of ['bin/', 'src/']) {
      assert.ok(pkg.files.includes(needed), `the package must ship ${needed}`);
    }
    for (const banned of ['tests/', 'bench/', 'rust/', 'v1-backup/', '.lain-probe/']) {
      assert.ok(!pkg.files.includes(banned), `${banned} must not be published`);
    }

    // ---- LAIN DESKTOP SHIPS ITS SOURCE, NOT ITS BINARIES --------------
    //
    // The native host is compiled on the machine that runs it, by the compiler
    // Windows already has — the same arrangement the Computer MCP bridge uses.
    // So the package must carry `native/host.cs`, or an installed LAIN can
    // never build the application; and it must NOT carry `native/vendor/`,
    // which is fetched, pinned and hashed per machine. Publishing those DLLs
    // would put a third party's binaries inside LAIN's own package.
    // SINCE 2026-09-23 the host source lives in the lain-harness package and
    // travels as `harness/` — whose OWN allowlist carries native/host.cs and
    // native/vendor.js and never native/vendor/.
    assert.ok(pkg.files.includes('harness/'), 'the package must ship the Harness — LAIN Desktop is built from it');
    const hpkg = JSON.parse(fs.readFileSync(require('../helpers').harnessPath('package.json'), 'utf8'));
    for (const needed of ['native/host.cs', 'native/vendor.js', 'page/']) {
      assert.ok(hpkg.files.includes(needed), `the Harness package must ship ${needed}`);
    }
    for (const banned of ['native/', 'native/vendor/', 'native/vendor']) {
      assert.ok(!hpkg.files.includes(banned), `harness ${banned} would publish vendored binaries`);
      assert.ok(!pkg.files.includes(banned), `${banned} would publish vendored binaries`);
    }
  });

  await test('PACKAGE: no script is named `install` — npm would run it on every dependency install', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const reserved of ['install', 'preinstall', 'postinstall']) {
      assert.ok(!pkg.scripts[reserved],
        `a "${reserved}" script would put PATH mutation inside dependency resolution`);
    }
    assert.strictEqual(pkg.scripts.setup, 'node distribution/install.js');
  });

  await test('PACKAGE: LAIN still has no runtime dependencies', () => {
    // The whole install story rests on this: nothing to resolve, nothing to
    // audit, and `npm i -g` cannot fail on a transitive package.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    assert.deepStrictEqual(deps, [], `runtime dependencies appeared: ${deps.join(', ')}`);
  });
};
