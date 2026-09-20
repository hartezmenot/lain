'use strict';

/**
 * THE WEBVIEW2 SDK, VENDORED — the one thing LAIN Desktop needs that Windows
 * does not already provide.
 *
 * ------------------------------------------------------------------------
 * WHAT IS AND IS NOT ON A WINDOWS MACHINE ALREADY.
 *
 * The WebView2 RUNTIME ships with Windows 11 and updates itself with Edge
 * (measured here: 152.0.4191.66 under
 * `C:\Program Files (x86)\Microsoft\EdgeWebView`). That is the renderer, and
 * nothing needs to be shipped for it.
 *
 * What is NOT there is the SDK an application links against: the managed
 * assembly `Microsoft.Web.WebView2.Core.dll`, the WinForms control, and
 * `WebView2Loader.dll` — the shim that finds the runtime. Copies exist inside
 * Visual Studio, and taking a DLL out of somebody's IDE install is not how a
 * product acquires a dependency. So it is fetched from the package Microsoft
 * publishes for exactly this, verified, and vendored into the tree.
 *
 * ------------------------------------------------------------------------
 * WHY NOT MSBUILD. LAIN builds with `node` and, for the Computer MCP bridge,
 * `csc.exe` — the compiler that is part of Windows itself. Requiring Visual
 * Studio to build the desktop host would make a developer machine a
 * prerequisite of the product. `csc.exe` references these DLLs directly, so the
 * toolchain stays exactly what it already was.
 *
 * ONE FETCH, THEN NEVER AGAIN. The package is cached under `native/vendor/`,
 * checked by size and hash, and skipped when it is already there. Nothing here
 * runs during a normal LAIN session; it runs when the host is built.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const VENDOR = path.join(HERE, 'vendor');
const WEBVIEW2 = path.join(VENDOR, 'webview2');

/**
 * PINNED, because a build that silently changes its dependency is not a build
 * anybody can reason about. Bump deliberately.
 */
const PKG = Object.freeze({
  id: 'Microsoft.Web.WebView2',
  version: '1.0.2903.40',
  url: 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.2903.40/microsoft.web.webview2.1.0.2903.40.nupkg',
});

/** What the host actually compiles and ships against, and where it lands. */
const WANTED = Object.freeze([
  { from: 'lib/net462/Microsoft.Web.WebView2.Core.dll', to: 'Microsoft.Web.WebView2.Core.dll' },
  { from: 'lib/net462/Microsoft.Web.WebView2.WinForms.dll', to: 'Microsoft.Web.WebView2.WinForms.dll' },
  { from: 'runtimes/win-x64/native/WebView2Loader.dll', to: 'WebView2Loader.dll' },
]);

function have() {
  return WANTED.every((w) => {
    try { return fs.statSync(path.join(WEBVIEW2, w.to)).size > 1000; } catch { return false; }
  });
}

function download(url, to) {
  return new Promise((resolve, reject) => {
    const go = (u, depth = 0) => {
      if (depth > 5) return reject(new Error('too many redirects'));
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, u).toString(), depth + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${u}`)); }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.writeFileSync(to, buf);
          resolve(buf);
        });
        res.on('error', reject);
      }).on('error', reject);
    };
    go(url);
  });
}

/**
 * A .nupkg is a zip. Windows has `tar` (bsdtar) since 1803, which reads zips —
 * no archive library, and no shelling out to PowerShell's Expand-Archive, which
 * refuses a `.nupkg` extension without being renamed first.
 */
function unzip(nupkg, into) {
  fs.mkdirSync(into, { recursive: true });
  // WINDOWS' OWN tar, BY ABSOLUTE PATH. A bare `tar` can resolve to the one
  // Git for Windows ships, which reads `C:\...` as a REMOTE HOST and fails with
  // "Cannot connect to C: resolve failed". The system copy is the one that
  // understands a Windows path and a zip container.
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const exe = fs.existsSync(sys) ? sys : 'tar';
  execFileSync(exe, ['-xf', nupkg, '-C', into], { stdio: 'pipe', windowsHide: true });
}

/**
 * @returns {{ok: boolean, why?: string, dir?: string, vendored?: boolean}}
 */
async function ensure({ quiet = true } = {}) {
  if (process.platform !== 'win32') return { ok: false, why: 'the desktop host is Windows-only' };
  if (have()) return { ok: true, dir: WEBVIEW2, vendored: false };

  const tmp = path.join(VENDOR, `.${PKG.id}.${PKG.version}.nupkg`);
  const work = path.join(VENDOR, `.unpack-${process.pid}`);
  try {
    if (!quiet) process.stdout.write(`  fetching ${PKG.id} ${PKG.version}\n`);
    const buf = await download(PKG.url, tmp);
    if (buf.length < 100_000) return { ok: false, why: `the package is implausibly small (${buf.length} bytes)` };
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    unzip(tmp, work);
    fs.mkdirSync(WEBVIEW2, { recursive: true });
    for (const w of WANTED) {
      const src = path.join(work, ...w.from.split('/'));
      if (!fs.existsSync(src)) return { ok: false, why: `the package did not contain ${w.from}` };
      fs.copyFileSync(src, path.join(WEBVIEW2, w.to));
    }
    fs.writeFileSync(path.join(WEBVIEW2, 'PROVENANCE.json'), `${JSON.stringify({
      package: PKG.id, version: PKG.version, url: PKG.url, sha256: sha, at: new Date().toISOString(),
      note: 'Fetched by native/vendor.js. The WebView2 RUNTIME is part of Windows; only the SDK is vendored.',
    }, null, 2)}\n`);
    return { ok: true, dir: WEBVIEW2, vendored: true, sha256: sha };
  } catch (e) {
    return { ok: false, why: (e && e.message) || String(e) };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* leftovers are not the build */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* the same */ }
  }
}

/** The reference paths csc.exe needs, or a stated reason there are none. */
function references() {
  if (!have()) return { ok: false, why: 'the WebView2 SDK is not vendored — run native/vendor.js' };
  return {
    ok: true,
    dir: WEBVIEW2,
    refs: [
      path.join(WEBVIEW2, 'Microsoft.Web.WebView2.Core.dll'),
      path.join(WEBVIEW2, 'Microsoft.Web.WebView2.WinForms.dll'),
    ],
    loader: path.join(WEBVIEW2, 'WebView2Loader.dll'),
  };
}

module.exports = { ensure, references, have, PKG, WEBVIEW2 };

if (require.main === module) {
  ensure({ quiet: false }).then((r) => {
    process.stdout.write(r.ok
      ? `WebView2 SDK ready: ${r.dir}${r.vendored ? ' (fetched)' : ' (already present)'}\n`
      : `WebView2 SDK unavailable: ${r.why}\n`);
    process.exit(r.ok ? 0 : 1);
  });
}
