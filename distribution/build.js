'use strict';

/**
 * MAKE THE THING PEOPLE DOWNLOAD — `LAIN-Setup.exe`, one file.
 *
 *     node distribution/build.js [--out <dir>]
 *
 * ------------------------------------------------------------------------
 * THE ARTIFACT IS WHAT GETS CERTIFIED, NOT THE CHECKOUT.
 *
 * A distribution that is only ever tested by running `node src/...` in the
 * repository has not been tested: the repository has files the artifact does
 * not, and every one of them is a way for the installed product to work for a
 * reason the user will not have. So the acceptance drive installs THIS FILE and
 * runs what it produced — see tests/distribution and docs/STATUS.md.
 *
 * ------------------------------------------------------------------------
 * NO BUILD TOOLCHAIN. `node`, the `csc.exe` that is part of Windows, and
 * PowerShell's archiver. Same as everything else here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const payload = require('./payload');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['setup.cs', 'setupinstall.cs', 'setupsystem.cs', 'setupui.cs'];

function compiler() {
  const root = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64');
  let best = null;
  try {
    for (const name of fs.readdirSync(root)) {
      if (!/^v4\./.test(name)) continue;
      const exe = path.join(root, name, 'csc.exe');
      if (fs.existsSync(exe)) best = exe;
    }
  } catch { /* reported by the caller */ }
  return best;
}

function build({ out = path.join(ROOT, 'dist') } = {}) {
  if (process.platform !== 'win32') return { ok: false, why: 'the LAIN installer is a Windows program' };
  const csc = compiler();
  if (!csc) return { ok: false, why: 'no C# compiler was found (Microsoft.NET\\Framework64\\v4.*\\csc.exe)' };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-setup-'));
  const tree = path.join(work, 'payload');
  fs.mkdirSync(tree, { recursive: true });

  // ---- 1. THE PAYLOAD, FROM THE ALLOWLIST ------------------------------
  const copied = payload.copyInto(tree);
  if (copied.missing.length) {
    return { ok: false, why: `the package allowlist names files that are not here: ${copied.missing.join(', ')}` };
  }
  const zipped = payload.zip(tree, path.join(work, 'payload.zip'));
  if (!zipped.ok) return zipped;

  // ---- 2. THE INSTALLER, WITH THE PAYLOAD INSIDE IT --------------------
  fs.mkdirSync(out, { recursive: true });
  const exe = path.join(out, 'LAIN-Setup.exe');
  try { fs.unlinkSync(exe); } catch { /* not there */ }
  try {
    execFileSync(csc, [
      '-nologo', '-optimize+', '-target:winexe', `-out:${exe}`,
      '-r:System.dll', '-r:System.Drawing.dll', '-r:System.Windows.Forms.dll',
      '-r:System.IO.Compression.dll', '-r:System.IO.Compression.FileSystem.dll',
      '-r:System.Web.Extensions.dll',
      `-resource:${zipped.path},payload.zip`,
      ...SOURCES.map((f) => path.join(__dirname, f)),
    ], { stdio: 'pipe', timeout: 300_000, windowsHide: true });
  } catch (e) {
    const said = String((e && (e.stdout || e.stderr)) || (e && e.message) || '').trim().split('\n').slice(0, 8).join('\n');
    return { ok: false, why: `the installer did not compile:\n${said}` };
  }
  if (!fs.existsSync(exe)) return { ok: false, why: 'the compiler reported success and produced no program' };

  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
  return {
    ok: true,
    exe,
    bytes: fs.statSync(exe).size,
    payloadFiles: copied.files,
    payloadBytes: copied.bytes,
    version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
  };
}

module.exports = { build, compiler };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && i + 1 < argv.length) opts.out = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('Usage: node distribution/build.js [--out <dir>]\n');
      process.exit(0);
    }
  }
  const r = build(opts);
  if (!r.ok) { process.stderr.write(`${r.why}\n`); process.exit(1); }
  process.stdout.write(
    `LAIN ${r.version} installer\n`
    + `  ${r.exe}\n`
    + `  ${(r.bytes / 1048576).toFixed(1)} MB · ${r.payloadFiles} files (${(r.payloadBytes / 1048576).toFixed(1)} MB uncompressed)\n`);
}
