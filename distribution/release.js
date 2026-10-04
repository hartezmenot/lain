'use strict';

/**
 * BUILD A LAIN RELEASE — the installer, the update package and the signed update feed.
 *
 *   node distribution/release.js [--version 0.1.1] [--channel stable|preview] [--out dist] [--feed <url>]
 *                                [--harness-dir ../lain-harness] [--unsigned] [--no-design]
 *
 * Produces in <out>/:
 *   LAIN-Setup-<v>.exe            one file: the setup program with the payload inside (per-user, no admin)
 *   lain-<v>-win-x64.zip          the update package (runtime/ + app/), what the updater downloads
 *   manifest-<channel>.json(.sig)  the update feed entry, Ed25519-signed with the release key
 *
 * THE RUNTIME is the official Node.js Windows build, downloaded from nodejs.org and checked against nodejs.org's own
 * SHASUMS256.txt before it is used; its LICENSE ships beside it. Cached under %LOCALAPPDATA%\LAIN\build-cache.
 * THE WINDOW HOST and the pseudoconsole are compiled here (csc.exe, part of Windows) and shipped prebuilt, so an
 * installed LAIN never needs a compiler.
 * THE RELEASE KEY is read from %USERPROFILE%\.lain-release\ — or, where it was made, %USERPROFILE%\.noema-release\ —
 * release-signing.key.dpapi (DPAPI, CurrentUser; its entropy keeps the name it was sealed with) and never
 * written anywhere else. Without it (--unsigned) the feed is not produced — an unsigned manifest is never shipped.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE_VERSION = '24.16.0';
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const version = arg('--version', require(path.join(ROOT, 'package.json')).version);
const channel = arg('--channel', 'stable');
const out = path.resolve(arg('--out', path.join(ROOT, 'dist')));
const feed = arg('--feed', null);
const harnessDir = path.resolve(arg('--harness-dir', path.join(ROOT, '..', 'lain-harness')));
const unsigned = argv.includes('--unsigned');
const CSC = (() => {
  const base = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64');
  for (const v of fs.readdirSync(base).filter((n) => /^v4\./.test(n)).sort().reverse()) { const p = path.join(base, v, 'csc.exe'); if (fs.existsSync(p)) return p; }
  throw new Error('csc.exe (part of Windows) was not found');
})();
const say = (s) => process.stdout.write(`${s}\n`);

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function copyTree(from, to, filter = () => true) {
  const st = fs.statSync(from);
  if (st.isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(from)) { const s = path.join(from, f); if (filter(s)) copyTree(s, path.join(to, f), filter); } }
  else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
}
function zip(dir, file) {
  try { fs.unlinkSync(file); } catch { /* none */ }
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${dir.replace(/'/g, "''")}\\*' -DestinationPath '${file.replace(/'/g, "''")}' -CompressionLevel Optimal`], { stdio: 'inherit' });
}
function csc(args) { execFileSync(CSC, ['-nologo', '-optimize+', ...args], { stdio: 'pipe' }); }

async function runtime() {
  const cache = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'LAIN', 'build-cache', `node-v${NODE_VERSION}`);
  const zipName = `node-v${NODE_VERSION}-win-x64.zip`;
  const zipFile = path.join(cache, zipName);
  fs.mkdirSync(cache, { recursive: true });
  const sums = await (await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`)).text();
  const want = (sums.split('\n').find((l) => l.endsWith(`  ${zipName}`)) || '').split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error(`nodejs.org's SHASUMS256.txt lists no ${zipName}`);
  if (!fs.existsSync(zipFile) || sha256(zipFile) !== want) {
    say(`  downloading ${zipName} from nodejs.org`);
    const r = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${zipName}`);
    if (!r.ok) throw new Error(`nodejs.org answered ${r.status}`);
    fs.writeFileSync(zipFile, Buffer.from(await r.arrayBuffer()));
  }
  const got = sha256(zipFile);
  if (got !== want) throw new Error(`the Node.js download does not match nodejs.org's SHA-256 (${got} ≠ ${want})`);
  const unpacked = path.join(cache, 'unpacked');
  if (!fs.existsSync(path.join(unpacked, `node-v${NODE_VERSION}-win-x64`, 'node.exe'))) {
    fs.mkdirSync(unpacked, { recursive: true });
    execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', zipFile, '-C', unpacked, `node-v${NODE_VERSION}-win-x64/node.exe`, `node-v${NODE_VERSION}-win-x64/LICENSE`], { stdio: 'ignore' });
  }
  return { dir: path.join(unpacked, `node-v${NODE_VERSION}-win-x64`), sha256: want };
}

function revision() { try { return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } }

function releaseKey() {
  const f = ['.lain-release', '.noema-release'].map((d) => path.join(os.homedir(), d, 'release-signing.key.dpapi')).find((p) => fs.existsSync(p)) || path.join(os.homedir(), '.lain-release', 'release-signing.key.dpapi');
  if (!fs.existsSync(f)) return null;
  const ps = `Add-Type -AssemblyName System.Security; $b = [IO.File]::ReadAllBytes('${f.replace(/'/g, "''")}'); [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b, [Text.Encoding]::UTF8.GetBytes('noema-release-signing'), 'CurrentUser'))`;
  const der = Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim(), 'base64');
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

(async () => {
  if (process.platform !== 'win32') throw new Error('LAIN releases are built on Windows');
  if (!fs.existsSync(path.join(harnessDir, 'index.js'))) throw new Error(`no Harness package at ${harnessDir}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-release-'));
  const vdir = path.join(work, 'payload', 'versions', version);
  const app = path.join(vdir, 'app');
  say(`LAIN ${version} (${channel}) → ${out}`);

  // 1. THE APP: what package.json ships, the Harness package (the UI runtime), and build-info.json.
  const pkg = require(path.join(ROOT, 'package.json'));
  for (const f of pkg.files || []) { const s = path.join(ROOT, f); if (fs.existsSync(s)) copyTree(s, path.join(app, f.replace(/[\\/]$/, ''))); }
  copyTree(path.join(ROOT, 'package.json'), path.join(app, 'package.json'));
  for (const extra of ['native/vendor']) { const s = path.join(ROOT, extra); if (fs.existsSync(s)) copyTree(s, path.join(app, extra)); }
  copyTree(harnessDir, path.join(app, 'harness'), (p) => !/[\\/](\.git|node_modules|tests?|docs)$/.test(p));
  // LAIN DESIGN (optional, its own version): the engine and its pinned runtime dependencies in app/design; the
  // surface rides in app/harness/design. Installed or not is the person's choice at setup (components.json).
  const designBuild = argv.includes('--no-design') ? null : require('./designpayload').stage(app);
  if (!designBuild) fs.rmSync(path.join(app, 'harness', 'design'), { recursive: true, force: true });
  fs.writeFileSync(path.join(app, 'build-info.json'), JSON.stringify({ product: 'LAIN', version, channel, revision: revision(), built: new Date().toISOString(), feed, design: designBuild ? { version: designBuild.version, dependencies: designBuild.dependencies } : null }, null, 2));
  say(designBuild ? `  LAIN Design ${designBuild.version} (${designBuild.dependencies.join(', ')})` : '  LAIN Design NOT included (--no-design)');

  // 2. PREBUILT NATIVE PIECES (no compiler on the person's machine).
  process.env.LAIN_HARNESS_DIR = path.join(app, 'harness');
  const prebuilt = require(path.join(ROOT, 'src', 'desktop')).prebuild(path.join(app, 'native', 'prebuilt'));
  if (!prebuilt.ok) throw new Error(`the window host did not build: ${prebuilt.why}`);
  say(`  window host ${path.basename(prebuilt.exe)}`);
  // The job supervisor (Rust, statically linked CRT) — built beforehand with `cargo build --release` in rust/lain-supervisor.
  const sup = path.join(ROOT, 'rust', 'lain-supervisor', 'target', 'release', 'lain-supervisor.exe');
  if (fs.existsSync(sup)) { fs.copyFileSync(sup, path.join(app, 'native', 'prebuilt', 'lain-supervisor.exe')); say('  job supervisor lain-supervisor.exe'); }
  else say('  job supervisor NOT included (rust/lain-supervisor not built) — survive_restart jobs are unavailable in this build');

  // 3. THE RUNTIME (official, verified).
  const rt = await runtime();
  fs.mkdirSync(path.join(vdir, 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(rt.dir, 'node.exe'), path.join(vdir, 'runtime', 'node.exe'));
  fs.copyFileSync(path.join(rt.dir, 'LICENSE'), path.join(vdir, 'runtime', 'LICENSE-node.txt'));
  say(`  Node.js ${NODE_VERSION} (sha256 ${rt.sha256.slice(0, 16)}…, verified against nodejs.org)`);

  // 4. LAUNCHERS, with version resources and the LAIN icon.
  const ico = path.join(ROOT, 'distribution', 'brand', 'lain.ico');
  const ver = version.replace(/-.*$/, '');
  const info = (title) => { const f = path.join(work, `ver-${title.replace(/\W/g, '')}.cs`); fs.writeFileSync(f, `using System.Reflection;\n[assembly: AssemblyTitle("${title}")]\n[assembly: AssemblyProduct("LAIN")]\n[assembly: AssemblyCompany("LAIN")]\n[assembly: AssemblyCopyright("LAIN")]\n[assembly: AssemblyVersion("${ver}.0")]\n[assembly: AssemblyFileVersion("${ver}.0")]\n[assembly: AssemblyInformationalVersion("${version} (${channel})")]\n`); return f; };
  const launcher = path.join(ROOT, 'distribution', 'launcher.cs');
  const root = path.join(work, 'payload');
  csc(['-target:exe', `-win32icon:${ico}`, `-out:${path.join(root, 'lain.exe')}`, launcher, info('LAIN CLI')]);
  csc(['-target:winexe', '-define:GUI', '-r:System.Windows.Forms.dll', `-win32icon:${ico}`, `-out:${path.join(root, 'lainw.exe')}`, launcher, info('LAIN')]);
  csc(['-target:winexe', '-define:GUI', '-define:HARNESS', '-r:System.Windows.Forms.dll', `-win32icon:${ico}`, `-out:${path.join(root, 'LAIN Harness.exe')}`, launcher, info('LAIN Harness')]);
  fs.copyFileSync(path.join(root, 'LAIN Harness.exe'), path.join(app, 'distribution', 'LAIN Harness.exe'));
  fs.copyFileSync(ico, path.join(root, 'lain.ico'));

  // 5. THE UPDATE PACKAGE (runtime/ + app/) and its signed feed entry.
  fs.mkdirSync(out, { recursive: true });
  const assetName = `lain-${version}-win-x64.zip`;
  const asset = path.join(out, assetName);
  zip(vdir, asset);
  const manifest = {
    schema: 1, product: 'lain', channel, version, released: new Date().toISOString(),
    minimumCompatible: arg('--minimum-compatible', '0.1.0'), protocol: require(path.join(ROOT, 'src', 'update', 'compat')).PROTOCOL,
    minimumCli: arg('--minimum-cli', '0.1.0'), minimumHarness: arg('--minimum-harness', '0.1.0'),
    mandatory: argv.includes('--mandatory'), security: argv.includes('--security'),
    notes: arg('--notes', null), summary: (arg('--summary', '') || '').split('|').filter(Boolean),
    assets: [{ arch: 'x64', kind: 'app', name: assetName, url: assetName, size: fs.statSync(asset).size, sha256: sha256(asset) }],
  };
  const mbytes = Buffer.from(JSON.stringify(manifest, null, 2));
  if (!unsigned) {
    const key = releaseKey();
    if (!key) throw new Error('the release signing key is not available — use --unsigned for a local build (no feed is produced)');
    fs.writeFileSync(path.join(out, `manifest-${channel}.json`), mbytes);
    fs.writeFileSync(path.join(out, `manifest-${channel}.json.sig`), crypto.sign(null, mbytes, key).toString('base64'));
    say(`  manifest-${channel}.json signed`);
  } else say('  --unsigned: no update feed produced');

  // 6. THE SETUP PROGRAM with the payload inside.
  const payloadZip = path.join(work, 'payload.zip');
  zip(root, payloadZip);
  const payloadJson = path.join(work, 'payload.json');
  fs.writeFileSync(payloadJson, JSON.stringify({ version, channel, node: NODE_VERSION }));
  const setup = path.join(out, `LAIN-Setup-${version}.exe`);
  csc(['-target:winexe', `-win32icon:${ico}`, `-out:${setup}`, '-r:System.dll', '-r:System.Drawing.dll', '-r:System.Windows.Forms.dll', '-r:System.IO.Compression.dll', '-r:System.IO.Compression.FileSystem.dll',
    `-resource:${payloadZip},payload.zip`, `-resource:${payloadJson},payload.json`,
    ...['setup.cs', 'setupsystem.cs', 'setupui.cs'].map((f) => path.join(ROOT, 'distribution', f)), info('LAIN Setup')]);
  say(`  ${path.basename(setup)} (${Math.round(fs.statSync(setup).size / 1048576)} MB)`);
  fs.rmSync(work, { recursive: true, force: true });
  say('done — UNSIGNED BINARIES: no code-signing certificate is configured (the update feed itself is Ed25519-signed).');
})().catch((e) => { process.stderr.write(`release: ${e.message}\n`); process.exit(1); });
