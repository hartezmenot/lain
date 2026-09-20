'use strict';

/**
 * WHAT GETS INSTALLED — assembled from the package allowlist, never by hand.
 *
 * ------------------------------------------------------------------------
 * THE ALLOWLIST, PLUS ONE DECLARED EXTRA.
 *
 * `package.json` already declares what ships (`files`). A second, hand-written
 * list inside the installer would be a second answer to "what is the product",
 * and the two would drift the first time somebody adds a module — the failure
 * being an installed LAIN that is missing one file and dies at the moment it
 * needs it. So the payload is that list, and the ONE thing the installer adds
 * to it is named and reasoned about below rather than being a second list.
 *
 * ------------------------------------------------------------------------
 * WHAT THE CLEAN-ROOM AUDIT FOUND (2026-09-16).
 *
 * The allowlist was copied to an empty directory and the product run there with
 * every file access traced. It reached back into the checkout for NOTHING:
 * `--version` and `--doctor` both ran, and the only path outside the install
 * directory was `~/.lain-v2`, which is user data and belongs there.
 *
 * One real gap, and it is the extra named below: the WebView2 SDK was
 * fetched-on-demand and not shipped, so an installed copy could not build
 * LAIN.exe without network — `the WebView2 SDK is not vendored`. A product that
 * needs the internet to finish installing itself is not installed.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/**
 * WHAT THE INSTALLER CARRIES THAT THE NPM PACKAGE DOES NOT.
 *
 * `package.json`'s `files` is the NPM allowlist, and it deliberately excludes
 * `native/vendor/` — publishing Microsoft's DLLs inside LAIN's npm package is a
 * different act from shipping them inside LAIN's own Windows installer, and a
 * guard in tests/distribution/install.test.js enforces that.
 *
 * The INSTALLER needs them. Without the SDK an installed copy cannot build
 * LAIN.exe at all — measured in the clean room: `the WebView2 SDK is not
 * vendored — run native/vendor.js` — and a product that needs the internet to
 * finish installing itself is not installed.
 *
 * The SDK travels with `PROVENANCE.json`, which records the package, version,
 * source URL and SHA-256 it was fetched under. The RUNTIME is part of Windows
 * and is not shipped by anybody.
 */
const INSTALLER_EXTRAS = ['native/vendor/'];

/** The allowlist, plus the manifest the runtime reads its own version from. */
function entries() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return [...pkg.files, 'package.json', ...INSTALLER_EXTRAS];
}

function copyInto(dest, { root = ROOT } = {}) {
  let files = 0;
  let bytes = 0;
  const missing = [];
  for (const entry of entries()) {
    const src = path.join(root, entry);
    if (!fs.existsSync(src)) { missing.push(entry); continue; }
    const dst = path.join(dest, entry);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
  }
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  if (fs.existsSync(dest)) walk(dest);
  return { files, bytes, missing };
}

/**
 * ZIP IT WITH WHAT WINDOWS ALREADY HAS.
 *
 * LAIN has zero runtime dependencies and no build toolchain beyond `node` and
 * the `csc.exe` that is part of Windows. Adding an archiver to make an
 * installer would be a dependency acquired for the one step whose job is to
 * remove dependencies. `Compress-Archive` is in every supported PowerShell.
 */
function zip(dir, out) {
  try { fs.unlinkSync(out); } catch { /* not there */ }
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path ${JSON.stringify(path.join(dir, '*'))} -DestinationPath ${JSON.stringify(out)} -CompressionLevel Optimal -Force`],
    { stdio: 'pipe', timeout: 600_000, windowsHide: true });
  } catch (e) {
    const said = String((e && (e.stderr || e.stdout)) || (e && e.message) || '').trim().split('\n')[0];
    return { ok: false, why: `the payload could not be archived: ${said || 'Compress-Archive failed'}` };
  }
  if (!fs.existsSync(out)) return { ok: false, why: 'the archiver reported success and produced nothing' };
  return { ok: true, path: out, bytes: fs.statSync(out).size };
}

module.exports = { entries, copyInto, zip, ROOT, INSTALLER_EXTRAS };
