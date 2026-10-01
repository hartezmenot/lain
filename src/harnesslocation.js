'use strict';

/**
 * WHERE THE VISUAL HARNESS LIVES (2026-09-23).
 *
 * The Harness (interface document + native WebView2 shell) moved to its own
 * repository, `lain-harness`. It is presentation only: Core keeps every owner
 * of state and authority and serves the Harness through the channels that
 * already existed — the local HTTP API (harnessapp/routes.js) and the named
 * pipe (harnessapp/ipc.js). This module is the ONE place Core finds the
 * package. Nothing else may reach into its files.
 *
 * ORDER:
 *   1. LAIN_HARNESS_DIR            an explicit override (development, tests)
 *   2. <lain>/harness              bundled into an installed build (distribution/payload.js)
 *   3. <lain>/../lain-harness      the sibling checkout (lain + lain-harness side by side)
 *
 * Absent → `load()` returns null with the reason. The desktop surface says the
 * Harness is not installed. The CLI never needs it.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/** The contract this Core speaks (lain-harness/index.js CONTRACT). */
const CONTRACT = 2;  // 2: the workspace shell (workspaceroutes.js, usage, navigation)

function candidates() {
  return [process.env.LAIN_HARNESS_DIR, path.join(ROOT, 'harness'), path.join(ROOT, '..', 'lain-harness')].filter(Boolean);
}

/** The Harness root, or null. */
function root() {
  for (const dir of candidates()) {
    try { if (fs.existsSync(path.join(dir, 'index.js')) && fs.existsSync(path.join(dir, 'package.json'))) return path.resolve(dir); } catch { /* next */ }
  }
  return null;
}

let cached = null;
/**
 * The loaded Harness contract: { root, CONTRACT, html(), hostSource, vendor() },
 * or { ok:false, why } — never a throw.
 */
function load() {
  const dir = root();
  if (!dir) return { ok: false, why: `Noema Harness is not installed (looked in: ${candidates().join(', ')})` };
  if (cached && cached.root === dir) return cached;
  let mod;
  try { mod = require(path.join(dir, 'index.js')); } catch (e) { return { ok: false, why: `Noema Harness at ${dir} failed to load: ${e.message}` }; }
  if (mod.CONTRACT !== CONTRACT) return { ok: false, why: `Noema Harness at ${dir} speaks contract ${mod.CONTRACT}; this Core speaks ${CONTRACT}` };
  cached = { ok: true, root: dir, ...mod };
  return cached;
}

/** The files an installed build bundles (distribution/payload.js). */
function packageFiles(dir = root()) {
  if (!dir) return [];
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).files || []; } catch { return []; }
}

function _reset() { cached = null; }

module.exports = { CONTRACT, root, load, candidates, packageFiles, _reset };
