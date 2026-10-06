'use strict';

/**
 * THE LAIN INSTALLER — the artifact people actually download (distribution/release.js → LAIN-Setup-<v>.exe).
 *
 * ------------------------------------------------------------------------
 * NO TEST HERE MAY TOUCH THE DEVELOPER'S REAL PATH, START MENU, "OPEN WITH", INSTALLED APPS OR DATA.
 * Every case installs into a TEMPORARY folder with --no-path --no-open-with --no-open-folder --no-start-menu
 * --no-register, and a temporary data home (LAIN_CONFIG_DIR). The last case checks that the machine's own
 * registrations are exactly what they were — a test that left one behind is found by looking.
 *
 * WHAT IS PROVEN (the matrix, packaging pass §T): clean CLI-only · the installed copy depends on nothing in the
 * checkout · add the Harness later · repair · clean CLI + Harness · upgrade 0.1.0 → 0.1.1 side by side · uninstall
 * the program only (data kept) · uninstall + data · no LAIN executable ships, and an upgrade removes one ·
 * the `lain` command is a shim onto lain.exe · start at sign-in survives repair and upgrade, goes with the Harness
 * and comes back with it, and uninstall leaves no dead entry. The Startup folder is a TEMPORARY one (APPDATA).
 *
 * The releases are built UNSIGNED here (no feed; the executables are never code-signed in this repository), from
 * the official Node.js runtime that release.js verifies against nodejs.org. Slow — two builds and eight installs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, tmpdir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');
const HARNESS = path.join(ROOT, 'harness');
const ISO = ['--no-path', '--no-open-with', '--no-open-folder', '--no-start-menu', '--no-register'];

function reg(key) { return spawnSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true }).status === 0; }
function userPath() { return spawnSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('PATH','User')"], { encoding: 'utf8', windowsHide: true }).stdout.trim(); }
function snapshot() {
  return {
    lainFile: reg('HKCU\\Software\\Classes\\LAIN.File'), lainFile: reg('HKCU\\Software\\Classes\\LAIN.Harness.File'),
    uninstall: reg('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LAIN'), path: userPath(),
    menu: fs.existsSync(path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'LAIN')),
  };
}
const sleep = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);

module.exports = async function () {
  if (process.platform !== 'win32') {
    await test('INSTALLER: skipped — the LAIN installer is a Windows program', () => {});
    return;
  }
  if (!fs.existsSync(path.join(HARNESS, 'index.js'))) {
    await test(`INSTALLER: skipped — no Harness package at ${HARNESS} to build the payload from`, () => {});
    return;
  }
  const before = snapshot();
  const work = tmpdir('lain-installer-');
  const HOME = path.join(work, 'data');
  fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'sessions', 'marker.json'), '{"kept":true}');
  // A TEMPORARY APPDATA: the Startup folder setup and the CLI write to (startup.js) is this one, never the person's.
  const APPDATA = path.join(work, 'appdata');
  fs.mkdirSync(APPDATA, { recursive: true });
  const env = { ...process.env, LAIN_CONFIG_DIR: HOME, LAIN_NO_UPDATE_CHECK: '1', APPDATA };
  const LINK = path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'LAIN Harness.lnk');
  const linkTarget = () => {
    if (!fs.existsSync(LINK)) return null;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:L); $s.TargetPath + "|" + $s.Arguments'], { env: { ...process.env, L: LINK }, encoding: 'utf8', windowsHide: true });
    return String(r.stdout || '').trim();
  };
  const real = (p) => fs.realpathSync.native(p).toLowerCase();
  const pointsInto = (dir) => { const t = linkTarget(); return Boolean(t) && t.split('|')[0].toLowerCase() === real(path.join(dir, 'LAIN Harness.exe')) && t.split('|')[1] === '--startup'; };
  // ONLY THE OTHER SPELLINGS ARE SCRUBBED. This line once deleted LAIN_CONFIG_DIR itself (a NOEMA_* → LAIN_* rename of
  // the old scrub), so "uninstall + remove data" below removed the person's REAL ~/.lain (2026-10-06). Never again:
  for (const k of ['LAIN_HOME', 'LAIN_INSTALL_ROOT', 'NOEMA_CONFIG_DIR', 'NOEMA_HOME']) delete env[k];
  const realHome = path.join(require('os').homedir(), '.lain').toLowerCase();
  if (!env.LAIN_CONFIG_DIR || path.resolve(env.LAIN_CONFIG_DIR).toLowerCase() === realHome || !path.resolve(env.LAIN_CONFIG_DIR).toLowerCase().startsWith(path.resolve(work).toLowerCase())) {
    throw new Error(`REFUSING TO RUN: the installer tests' data home is not a temporary folder (${env.LAIN_CONFIG_DIR || 'unset'})`);
  }

  const builds = {};
  function release(version) {
    if (builds[version]) return builds[version];
    const out = path.join(work, `dist-${version}`);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'distribution', 'release.js'), '--version', version, '--out', out, '--unsigned'], { encoding: 'utf8', timeout: 900000, windowsHide: true });
    assert.strictEqual(r.status, 0, `release ${version} did not build:\n${r.stdout}\n${r.stderr}`);
    builds[version] = path.join(out, `LAIN-Setup-${version}.exe`);
    return builds[version];
  }
  function run(exe, args) {
    // HARD FAIL BEFORE ANY UNINSTALL: the program folder, the data home and the program run must all be this run's own.
    if (args.includes('--uninstall') || args.includes('--remove-data') || args.includes('--repair')) {
      const inWork = (p) => Boolean(p) && path.resolve(p).toLowerCase().startsWith(path.resolve(work).toLowerCase() + path.sep);
      const dirArg = args[args.indexOf('--dir') + 1];
      const realHome = path.join(require('os').homedir(), '.lain').toLowerCase();
      if (!inWork(env.LAIN_CONFIG_DIR) || path.resolve(env.LAIN_CONFIG_DIR).toLowerCase() === realHome || !inWork(exe) || (args.includes('--dir') && !inWork(dirArg))) {
        throw new Error(`REFUSING ${args.join(' ')}: data ${env.LAIN_CONFIG_DIR}, program ${exe}, dir ${dirArg} — not all inside ${work}`);
      }
    }
    const log = path.join(work, `setup-${Date.now()}.log`);
    const r = spawnSync(exe, [...args, '--log', log], { env, encoding: 'utf8', timeout: 600000, windowsHide: true });
    return { code: r.status, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  }
  function cli(dir, args) {
    const r = spawnSync(path.join(dir, 'lain.exe'), args, { env, encoding: 'utf8', timeout: 120000, windowsHide: true, cwd: tmpdir('lain-elsewhere-') });
    return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
  }
  const ptr = (dir, n) => { try { return fs.readFileSync(path.join(dir, n), 'utf8').trim(); } catch { return null; } };
  const comps = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'components.json'), 'utf8')); } catch { return {}; } };
  const D1 = path.join(work, 'cli');
  const D2 = path.join(work, 'full');

  await test('INSTALLER: the release builds — setup, update package; UNSIGNED makes no feed', () => {
    const setup = release('0.1.0');
    assert.ok(fs.existsSync(setup), setup);
    assert.ok(fs.existsSync(path.join(path.dirname(setup), 'lain-0.1.0-win-x64.zip')));
    assert.ok(!fs.existsSync(path.join(path.dirname(setup), 'manifest-stable.json')), 'an unsigned build never produces a feed');
  });

  await test('INSTALLER: clean CLI-only — launchers, private runtime, no Harness, `lain --version` answers', () => {
    const r = run(release('0.1.0'), ['--silent', '--dir', D1, '--cli-only', ...ISO]);
    assert.strictEqual(r.code, 0, r.log);
    for (const f of ['lain.exe', 'lainw.exe', 'Uninstall LAIN.exe', 'lain.ico']) assert.ok(fs.existsSync(path.join(D1, f)), f);
    assert.ok(fs.existsSync(path.join(D1, 'versions', '0.1.0', 'runtime', 'node.exe')), 'the private runtime');
    assert.ok(fs.existsSync(path.join(D1, 'versions', '0.1.0', 'runtime', 'LICENSE-node.txt')), 'and its licence');
    assert.ok(!fs.existsSync(path.join(D1, 'LAIN Harness.exe')), 'the Harness is optional');
    assert.strictEqual(ptr(D1, 'current'), '0.1.0');
    const v = cli(D1, ['--version']);
    assert.match(v.out, /^LAIN CLI 0\.1\.0 \(stable/, v.out || v.err);
    assert.match(r.log, /Verified: LAIN CLI 0\.1\.0/, 'setup verified the installed CLI itself');
    assert.ok(!fs.existsSync(LINK), 'start at sign-in is OFF until the person turns it on');
  });

  await test('INSTALLER: the launchers are lain.exe and LAIN Harness.exe — no Noema program, command or shim ships', () => {
    const files = fs.readdirSync(D1);
    assert.ok(files.includes('lain.exe') && files.includes('Uninstall LAIN.exe'), files.join(', '));
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]);
    assert.deepStrictEqual(walk(D1).filter((f) => /noema/i.test(f) && !/\.(js|md|json)$/i.test(f)), [], 'no noema.exe, noema.cmd or Noema Harness.exe anywhere');
    const r = cli(D1, ['--version']);
    assert.match(r.out, /^LAIN CLI 0\.1\.0/, r.out + r.err);
    assert.ok(!/noema|renamed/i.test(r.err), r.err);
    assert.ok(!fs.existsSync(path.join(HOME, '..', '.lain-v2')) && !fs.existsSync(path.join(HOME, '..', '.noema')), 'no old home was made');
  });

  await test('INSTALLER: the installed copy depends on NOTHING in the checkout', () => {
    const hits = [];
    const walk = (d, depth) => {
      if (depth > 9) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p, depth + 1); continue; }
        if (!/\.(js|json|cmd|cs)$/i.test(e.name)) continue;
        let text = '';
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        if (text.toLowerCase().includes(ROOT.toLowerCase())) hits.push(path.relative(D1, p));
      }
    };
    walk(D1, 0);
    assert.deepStrictEqual(hits, [], `installed files naming the checkout: ${hits.join(', ')}`);
  });

  await test('INSTALLER: add the Harness later — nothing else changes, the data is the same', () => {
    const r = run(path.join(D1, 'Uninstall LAIN.exe'), ['--add-harness', '--dir', D1]);
    assert.strictEqual(r.code, 0, r.log);
    assert.ok(fs.existsSync(path.join(D1, 'LAIN Harness.exe')));
    assert.strictEqual(comps(D1).harness, true);
    assert.strictEqual(fs.readFileSync(path.join(HOME, 'sessions', 'marker.json'), 'utf8'), '{"kept":true}');
  });

  await test('INSTALLER: start at sign-in — the CLI turns it on; the entry is the version-independent launcher', () => {
    const r = cli(D1, ['settings', 'startup', 'harness', 'on']);
    assert.strictEqual(r.code, 0, r.out + r.err);
    assert.ok(pointsInto(D1), `the Startup entry: ${linkTarget()}`);
    assert.ok(!/versions/i.test(linkTarget()), 'never a version folder');
    assert.match(cli(D1, ['settings', 'startup', 'status']).out, /with Windows: ON[\s\S]*registered/);
  });

  await test('INSTALLER: repair restores a missing program file and keeps every choice', () => {
    fs.unlinkSync(path.join(D1, 'versions', '0.1.0', 'app', 'bin', 'lain.js'));
    const r = run(release('0.1.0'), ['--silent', '--dir', D1, '--repair']);
    assert.strictEqual(r.code, 0, r.log);
    assert.ok(fs.existsSync(path.join(D1, 'versions', '0.1.0', 'app', 'bin', 'lain.js')));
    const c = comps(D1);
    assert.ok(c.harness === true && c.path === false && c.openWith === false && c.registered === false, JSON.stringify(c));
    assert.ok(pointsInto(D1), 'start at sign-in survives a repair');
  });

  await test('INSTALLER: clean CLI + Harness', () => {
    const r = run(release('0.1.0'), ['--silent', '--dir', D2, '--harness', ...ISO]);
    assert.strictEqual(r.code, 0, r.log);
    assert.ok(fs.existsSync(path.join(D2, 'LAIN Harness.exe')));
    assert.strictEqual(comps(D2).harness, true);
  });

  await test('INSTALLER: upgrade 0.1.0 → 0.1.1 side by side — previous kept for rollback, choices kept', () => {
    fs.writeFileSync(path.join(D1, 'noema.exe'), 'MZ obsolete');           // a Noema-era program left in the folder
    fs.writeFileSync(path.join(D1, 'noema.cmd'), '@echo off');
    const r = run(release('0.1.1'), ['--silent', '--dir', D1]);
    assert.strictEqual(r.code, 0, r.log);
    assert.strictEqual(ptr(D1, 'current'), '0.1.1');
    assert.strictEqual(ptr(D1, 'previous'), '0.1.0');
    assert.ok(fs.existsSync(path.join(D1, 'versions', '0.1.0')) && fs.existsSync(path.join(D1, 'versions', '0.1.1')));
    assert.match(cli(D1, ['--version']).out, /^LAIN CLI 0\.1\.1/);
    assert.ok(comps(D1).harness === true && comps(D1).openWith === false, JSON.stringify(comps(D1)));
    assert.ok(!fs.existsSync(path.join(D1, 'noema.exe')) && !fs.existsSync(path.join(D1, 'noema.cmd')), 'the upgrade removed the Noema-era program and command');
    assert.match(r.log, /removed the obsolete noema\.exe/);
    assert.ok(fs.existsSync(path.join(D1, 'lain.exe')), 'lain.exe is the product');
    assert.ok(pointsInto(D1), 'start at sign-in survives the upgrade, unchanged');
  });

  await test('INSTALLER: removing the Harness removes its Startup entry; adding it back restores it — the choice is kept', () => {
    let r = run(path.join(D1, 'Uninstall LAIN.exe'), ['--remove-harness', '--dir', D1]);
    assert.strictEqual(r.code, 0, r.log);
    assert.ok(!fs.existsSync(path.join(D1, 'LAIN Harness.exe')));
    assert.ok(!fs.existsSync(LINK), 'no dead entry');
    assert.match(cli(D1, ['settings', 'startup', 'status']).out, /with Windows: ON \(LAIN Harness is not installed/);
    r = run(path.join(D1, 'Uninstall LAIN.exe'), ['--add-harness', '--dir', D1]);
    assert.strictEqual(r.code, 0, r.log);
    assert.ok(pointsInto(D1), 'registered again');
  });

  await test('INSTALLER: uninstall the program only — the data is kept', () => {
    const r = run(path.join(D2, 'Uninstall LAIN.exe'), ['--uninstall', '--silent', '--dir', D2]);
    sleep(4000);
    assert.strictEqual(r.code, 0, r.log);
    assert.ok(pointsInto(D1), 'uninstalling ANOTHER install leaves this one\'s Startup entry alone');
    assert.ok(!fs.existsSync(path.join(D2, 'versions')) && !fs.existsSync(path.join(D2, 'lain.exe')));
    assert.ok(fs.existsSync(path.join(HOME, 'sessions', 'marker.json')), 'the data stays');
  });

  await test('INSTALLER: uninstall + "Also remove LAIN user data" — both gone; a junction out of the data is removed, never followed', () => {
    // A PROTECTED EXTERNAL FIXTURE behind a Windows junction (and a file symlink) inside the data home — as account homes
    // link into ~\.codex. After "remove data" it must be byte-for-byte what it was.
    const ext = path.join(work, 'protected-external');
    fs.mkdirSync(path.join(ext, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(ext, 'sessions', 'real.jsonl'), 'REAL SESSION DATA');
    fs.writeFileSync(path.join(ext, 'config.toml'), 'model = "kept"\n');
    const hash = (d) => fs.readdirSync(d, { recursive: true }).sort().map((f) => { const p = path.join(d, f); return fs.statSync(p).isFile() ? `${f}:${require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex')}` : `${f}/`; }).join('\n');
    const before = hash(ext);
    fs.mkdirSync(path.join(HOME, 'accounts', 'codex-x', 'shadow'), { recursive: true });
    fs.symlinkSync(path.join(ext, 'sessions'), path.join(HOME, 'accounts', 'codex'), 'junction');
    fs.symlinkSync(path.join(ext, 'config.toml'), path.join(HOME, 'accounts', 'codex-x', 'shadow', 'config.toml'), 'file');
    const r = run(path.join(D1, 'Uninstall LAIN.exe'), ['--uninstall', '--silent', '--remove-data', '--dir', D1]);
    sleep(4000);
    assert.strictEqual(r.code, 0, r.log);
    assert.strictEqual(hash(ext), before, `the external fixture behind the junction is untouched:\n${r.log}`);
    assert.match(r.log, /links removed without following them/, r.log);
    assert.ok(!fs.existsSync(path.join(D1, 'lain.exe')));
    assert.ok(!fs.existsSync(path.join(D1, 'lain.cmd')), 'the shim goes with the program');
    assert.ok(!fs.existsSync(LINK), 'uninstall removed the Startup entry — nothing dead is left');
    assert.ok(!fs.existsSync(HOME), 'the data folder is removed');
  });

  await test('INSTALLER: nothing outside the sandbox changed — "Open with", PATH, Start Menu, Installed apps', () => {
    assert.deepStrictEqual(snapshot(), before);
  });
};
