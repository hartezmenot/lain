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

// THE HARNESS IS ITS OWN PACKAGE (lain-harness, 2026-09-23): the page, the host
// source and the SDK vendoring are found through harnesslocation.js only.
const harness = () => require('./harnesslocation').load();
const vendor = { references: () => { const h = harness(); return h.ok ? h.vendor().references() : { ok: false, why: h.why }; },
  have: () => { const h = harness(); return h.ok ? h.vendor().have() : { ok: false, why: h.why }; } };

const ROOT = path.join(__dirname, '..');
/** The host source's path, or '' when the Harness is not installed. */
const SOURCE = (() => { const h = harness(); return h.ok ? h.hostSource : ''; })();

/** Where a built host and its packaged assets live, outside the source tree. */
function homeDir() {
  const base = require('./home').resolve();
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
  const h = harness();
  if (!h.ok) throw new Error(h.why);
  const html = h.html();
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  // THE HARNESS'S OTHER ASSETS (its vendored editor) are served from the same
  // origin as the page — web workers require it. COPIED, not linked: WebView2's
  // virtual host refuses to follow a junction (ERR_ACCESS_DENIED, measured), so
  // the files must really be under the mapped folder. Copied once per version:
  // a VERSION file that matches means the copy is already current.
  for (const a of (typeof h.assetDirs === 'function' ? h.assetDirs() : [])) {
    const at = path.join(dir, ...String(a.url).split('/'));
    try {
      const want = fs.readFileSync(path.join(a.dir, 'VERSION'), 'utf8');
      let have = null;
      try { have = fs.readFileSync(path.join(at, 'VERSION'), 'utf8'); } catch { have = null; }
      if (have === want && !fs.lstatSync(at).isSymbolicLink()) continue;
      fs.rmSync(at, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.cpSync(a.dir, at, { recursive: true });
    } catch { /* the page falls back to its built-in editor */ }
  }
  return { dir, file, bytes: Buffer.byteLength(html) };
}

/**
 * BUILD (or reuse) THE HOST EXECUTABLE.
 *
 * @returns {{ok: boolean, why?: string, exe?: string, built?: boolean}}
 */
/** The Noema icon the host carries (title bar, taskbar, Alt+Tab). */
const ICON = path.join(__dirname, '..', 'distribution', 'brand', 'noema.ico');
/** A host built by the release (distribution/release.js) — an installed Noema never needs a compiler. */
const PREBUILT = path.join(__dirname, '..', 'native', 'prebuilt');

function build({ quiet = true, out: outDir = null } = {}) {
  if (process.platform !== 'win32') return { ok: false, why: 'Noema Desktop is Windows-only for now' };
  let src;
  const h = harness();
  if (!h.ok) return { ok: false, why: h.why };
  try { src = fs.readFileSync(h.hostSource, 'utf8'); } catch (e) { return { ok: false, why: `the host source is missing: ${e.message}` }; }

  const sdk = vendor.references();
  if (!sdk.ok) return { ok: false, why: sdk.why };

  const csc = compiler();
  if (!csc) return { ok: false, why: 'no C# compiler was found (Microsoft.NET\\Framework64\\v4.*\\csc.exe)' };

  // CACHED BY WHAT WENT INTO IT — the source and the SDK it links against.
  const stamp = crypto.createHash('sha256')
    .update(src)
    .update(fs.readFileSync(sdk.refs[0]))
    .update(fs.existsSync(ICON) ? fs.readFileSync(ICON) : Buffer.alloc(0))
    .digest('hex')
    .slice(0, 12);
  const out = outDir || homeDir();
  fs.mkdirSync(out, { recursive: true });
  const exe = path.join(out, `noema-harness-${stamp}.exe`);

  // THE LOADER AND THE ASSEMBLIES MUST SIT BESIDE THE EXE, because that is
  // where the CLR and the WebView2 loader look for them.
  for (const ref of sdk.refs) {
    const dest = path.join(out, path.basename(ref));
    if (!fs.existsSync(dest)) fs.copyFileSync(ref, dest);
  }
  const loader = path.join(out, path.basename(sdk.loader));
  if (!fs.existsSync(loader)) fs.copyFileSync(sdk.loader, loader);

  if (fs.existsSync(exe)) return { ok: true, exe, built: false, dir: out };
  // THE RELEASE SHIPPED THIS VERY BUILD: copied, not compiled.
  const shipped = path.join(PREBUILT, path.basename(exe));
  if (!outDir && fs.existsSync(shipped)) { fs.copyFileSync(shipped, exe); return { ok: true, exe, built: false, prebuilt: true, dir: out }; }

  const args = [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    ...(fs.existsSync(ICON) ? [`/win32icon:${ICON}`] : []),
    `/out:${exe}`,
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Web.Extensions.dll',
    ...sdk.refs.map((r) => `/reference:${r}`),
    h.hostSource,
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
function launcherPath() { return path.join(homeDir(), 'Noema Harness.exe'); }

/** The release build: compile the host (and its SDK files) into `dir` for distribution/release.js. */
function prebuild(dir) { return build({ out: dir }); }

/** The window host for this build, or null — also what tells Explorer that "Open with" changed. */
function hostExe() { const b = build(); return b.ok ? b.exe : null; }

/**
 * MAKE THE APPLICATION LAUNCHABLE FROM A SHORTCUT.
 *
 * ------------------------------------------------------------------------
 * TWO THINGS A DOUBLE-CLICK NEEDS THAT A `/app` NEVER DID.
 *
 * A STABLE NAME. The build is cached under the hash of its inputs, which is
 * right for a cache and useless for a shortcut: the target would break on the
 * next change to the host. `Noema Harness.exe` is a copy under a name that does not
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
  const entry = path.join(__dirname, '..', 'bin', 'noema.js');
  // WHERE THE FRONT DOOR GOES. By default LAIN's own directory, which is what a
  // developer running from a checkout wants. An INSTALL passes `at`, because
  // Noema Harness.exe belongs with the program it launches — and the uninstaller then
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
async function open(app, { dev = false, wait = false, debugPort = 0, mode = null, section = null, minimized = false } = {}) {
  const built = build();
  if (!built.ok) return built;

  const ipc = require('./harnessapp/ipc');
  const started = await ipc.start(app);
  if (!started.ok) return { ok: false, why: started.why };

  // THE EDITOR'S CODE, fetched once (pinned, verified) and bounded so a slow
  // network never holds the window: without it the page uses its own editor.
  const h = harness();
  if (h.ok && typeof h.ensureVendor === 'function') {
    await require('./deadline').race(h.ensureVendor().catch(() => null), 90_000);
  }
  const assets = writeAssets(path.join(built.dir, 'assets'));

  // THE WINDOW'S OWN FILES FOLLOW THE CONFIG HOME. Under the real home these
  // are exactly the host's defaults; under a test profile they are the
  // profile's, so a test window never writes the person's window state or
  // renderer profile.
  const base = path.dirname(homeDir());
  const args = [
    '--pipe', started.pipe,
    '--secret', started.secret,
    '--assets', assets.dir,
    '--window-state', path.join(base, mode ? `desktop-window-${mode}.json` : 'desktop-window.json'),
    '--user-data', dev ? path.join(homeDir(), 'dev') : homeDir(),
    // THE CORE THIS WINDOW BELONGS TO: the host ends itself when this process is gone (no orphan windows).
    '--core-pid', String(process.pid),
  ];
  // A DEBUGGING PORT IS A DEVELOPMENT AFFORDANCE AND IS GATED TWICE — here and
  // again in the host — so a release build cannot open one by accident.
  // A SMALL NOEMA WINDOW (packaging pass §E, §M): the Model Dashboard or the Preview alone — the same page and components
  // as the Harness, drawn in that mode, with the ordinary Windows title bar.
  if (mode === 'dashboard' || mode === 'preview') args.push('--mode', mode, '--native-caption', ...(section ? ['--section', String(section)] : []));
  if (minimized) args.push('--minimized');   // started at sign-in with "Start minimized" (startup.js)
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
    const rows = fs.readdirSync(out).filter((f) => /^noema-harness-[0-9a-f]+\.exe$/.test(f));
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

module.exports = { build, prebuild, hostExe, open, status, writeAssets, compiler, homeDir, installLauncher, launcherPath, SOURCE };
