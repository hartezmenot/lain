'use strict';

/**
 * LAIN DESKTOP — building it, starting it, and owning its lifetime.
 *
 * ------------------------------------------------------------------------
 * THE SHAPE OF THE PRODUCT, AFTER THIS FILE.
 *
 *     lain              the CLI, unchanged
 *     lain --app        LAIN Desktop: a native window LAIN owns
 *
 * What used to happen — mint a token, start an HTTP listener, launch the
 * person's Chrome at a localhost URL and hope the tab was the application — is
 * gone from the normal path. The window is ours, the channel is a private pipe
 * (harnessapp/ipc.js), and the UI is loaded from packaged files.
 *
 * ------------------------------------------------------------------------
 * BUILT THE WAY THE COMPUTER MCP BRIDGE IS BUILT, and for the same reasons:
 * `csc.exe` is part of Windows, the source ships readable in the tree, and the
 * result is cached by the hash of its own inputs so it compiles once. LAIN
 * gains no build system and no toolchain a person has to install.
 *
 * The one thing Windows does not provide is the WebView2 SDK — the runtime is
 * part of the OS, the SDK is not — so it is vendored, verified and pinned. See
 * native/vendor.js.
 *
 * ------------------------------------------------------------------------
 * NOT A SECOND RUNTIME. This module compiles a host, hands it a pipe name and
 * a secret, and watches the process. It holds no session, starts no turn and
 * decides no permission. Everything the window can do, it does by asking Core
 * over a route that already existed.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vendor = require('../native/vendor');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'native', 'host.cs');

/** Where a built host and its packaged assets live, outside the source tree. */
function homeDir() {
  const base = process.env.LAIN_CONFIG_DIR
    || path.join(os.homedir(), '.lain-v2');
  return path.join(base, 'desktop');
}

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

/**
 * THE ASSETS THE WINDOW RENDERS.
 *
 * `harnessapp/page.js` builds the whole interface as one document, so the
 * "packaging" of the frontend is writing that document to disk beside the host.
 * A release therefore needs no dev server and no HTTP listener to show its own
 * UI — which is exactly what `--dev` exists to relax and nothing else.
 */
function writeAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const html = require('./harnessapp/page').html();
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  return { dir, file, bytes: Buffer.byteLength(html) };
}

/**
 * BUILD (or reuse) THE HOST EXECUTABLE.
 *
 * @returns {{ok: boolean, why?: string, exe?: string, built?: boolean}}
 */
function build({ quiet = true } = {}) {
  if (process.platform !== 'win32') return { ok: false, why: 'LAIN Desktop is Windows-only for now' };
  let src;
  try { src = fs.readFileSync(SOURCE, 'utf8'); } catch (e) { return { ok: false, why: `the host source is missing: ${e.message}` }; }

  const sdk = vendor.references();
  if (!sdk.ok) return { ok: false, why: sdk.why };

  const csc = compiler();
  if (!csc) return { ok: false, why: 'no C# compiler was found (Microsoft.NET\\Framework64\\v4.*\\csc.exe)' };

  // CACHED BY WHAT WENT INTO IT — the source and the SDK it links against.
  const stamp = crypto.createHash('sha256')
    .update(src)
    .update(fs.readFileSync(sdk.refs[0]))
    .digest('hex')
    .slice(0, 12);
  const out = homeDir();
  fs.mkdirSync(out, { recursive: true });
  const exe = path.join(out, `lain-desktop-${stamp}.exe`);

  // THE LOADER AND THE ASSEMBLIES MUST SIT BESIDE THE EXE, because that is
  // where the CLR and the WebView2 loader look for them.
  for (const ref of sdk.refs) {
    const dest = path.join(out, path.basename(ref));
    if (!fs.existsSync(dest)) fs.copyFileSync(ref, dest);
  }
  const loader = path.join(out, path.basename(sdk.loader));
  if (!fs.existsSync(loader)) fs.copyFileSync(sdk.loader, loader);

  if (fs.existsSync(exe)) return { ok: true, exe, built: false, dir: out };

  const args = [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    `/out:${exe}`,
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Web.Extensions.dll',
    ...sdk.refs.map((r) => `/reference:${r}`),
    SOURCE,
  ];
  const r = require('child_process').spawnSync(csc, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(exe)) {
    const said = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(0, 8).join('\n');
    return { ok: false, why: `the desktop host did not compile:\n${said}` };
  }
  if (!quiet) process.stdout.write(`  built ${path.basename(exe)}\n`);
  return { ok: true, exe, built: true, dir: out };
}

/** Where a shortcut points. Stable across rebuilds, unlike the hashed name. */
function launcherPath() { return path.join(homeDir(), 'LAIN.exe'); }

/**
 * MAKE THE APPLICATION LAUNCHABLE FROM A SHORTCUT.
 *
 * ------------------------------------------------------------------------
 * TWO THINGS A DOUBLE-CLICK NEEDS THAT A `/app` NEVER DID.
 *
 * A STABLE NAME. The build is cached under the hash of its inputs, which is
 * right for a cache and useless for a shortcut: the target would break on the
 * next change to the host. `LAIN.exe` is a copy under a name that does not
 * move.
 *
 * AND A WAY TO FIND NODE. Started from Explorer the host has no Core, no
 * pipe, and no LAIN — it has to start one, which means running Node, which
 * means knowing where Node is. `launch.json` beside the exe records what the
 * resolver found on THIS machine at build time (src/noderesolve.js), so the
 * launcher does not have to re-derive it from an Explorer PATH that may not
 * contain Node at all. The host re-probes if the manifest is stale, and says
 * so natively if it cannot — it never falls back to a browser (§32).
 *
 * The secret is NOT in here: this file says how to start Core, not how to talk
 * to one. The pipe and its secret are minted per run and handed to the window
 * on its command line, exactly as before.
 */
function installLauncher(built, { cfg = {}, at = null } = {}) {
  if (!built || !built.ok) return { ok: false, why: (built && built.why) || 'the host is not built' };
  const node = require('./noderesolve').find({ cfg });
  const entry = path.join(__dirname, '..', 'bin', 'lain.js');
  // WHERE THE FRONT DOOR GOES. By default LAIN's own directory, which is what a
  // developer running from a checkout wants. An INSTALL passes `at`, because
  // LAIN.exe belongs with the program it launches — and the uninstaller then
  // removes it with everything else it put there.
  //
  // `launch.json` goes BESIDE THE LAUNCHER, wherever that is: native/host.cs
  // reads it from its own directory ("beside this exe"), so the two cannot be
  // separated without the host losing the answer it was given.
  const launcher = at ? path.resolve(at) : launcherPath();
  try {
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.copyFileSync(built.exe, launcher);
    fs.writeFileSync(path.join(path.dirname(launcher), 'launch.json'), JSON.stringify({
      node: node.ok ? node.exe : '',
      why: node.ok ? '' : node.why,
      entry,
      args: ['--desktop'],
      wrote: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, why: `the launcher could not be written: ${e.message}` };
  }
  return { ok: true, launcher, node: node.ok ? node.exe : null, why: node.ok ? '' : node.why };
}

/**
 * START THE APPLICATION.
 *
 * Core's private channel first, then the window. The secret goes to the child
 * on its command line — the trusted launch relationship §9 describes — and is
 * never written anywhere a later reader could pick it up.
 *
 * @returns {Promise<{ok: boolean, why?: string, pid?: number, pipe?: string}>}
 */
async function open(app, { dev = false, wait = false, debugPort = 0 } = {}) {
  const built = build();
  if (!built.ok) return built;

  const ipc = require('./harnessapp/ipc');
  const started = await ipc.start(app);
  if (!started.ok) return { ok: false, why: started.why };

  const assets = writeAssets(path.join(built.dir, 'assets'));

  const args = [
    '--pipe', started.pipe,
    '--secret', started.secret,
    '--assets', assets.dir,
  ];
  // A DEBUGGING PORT IS A DEVELOPMENT AFFORDANCE AND IS GATED TWICE — here and
  // again in the host — so a release build cannot open one by accident.
  if (dev) args.push('--dev');
  if (dev && debugPort) args.push('--debug-port', String(debugPort));

  const child = spawn(built.exe, args, {
    cwd: built.dir,
    detached: !wait,
    windowsHide: false,
    stdio: 'ignore',
  });
  if (!wait) child.unref();

  return {
    ok: true,
    pid: child.pid,
    pipe: started.pipe,
    exe: built.exe,
    assets: assets.file,
    debugPort: dev && debugPort ? debugPort : 0,
    child,
  };
}

/** What `/status` and the doctor ask. Never starts anything. */
function status() {
  const sdk = vendor.have();
  const csc = Boolean(compiler());
  const out = homeDir();
  let exe = null;
  try {
    const rows = fs.readdirSync(out).filter((f) => /^lain-desktop-[0-9a-f]+\.exe$/.test(f));
    exe = rows.length ? path.join(out, rows[rows.length - 1]) : null;
  } catch { /* nothing built yet */ }
  return {
    platform: process.platform,
    available: process.platform === 'win32' && csc,
    sdk,
    compiler: csc,
    built: Boolean(exe),
    exe,
    ipc: require('./harnessapp/ipc').status(),
  };
}

module.exports = { build, open, status, writeAssets, compiler, homeDir, installLauncher, launcherPath, SOURCE };
