'use strict';

/**
 * THE TEST PROFILE — one place that decides where a test run may write.
 *
 * ------------------------------------------------------------------------
 * WHY IT EXISTS. tests/run.js already isolated the config home for the tiers
 * it runs, but the real-window driver (tests/harness/appdriver.js) could be
 * required from anywhere — a scratch script, a debugging session — and then
 * it constructed a real App against the person's real `~/.lain-v2`. That
 * happened: a driver run wrote nine test sessions into a real session store,
 * and cleaning them up meant deleting from it. A test must not be ABLE to do
 * that, whoever calls it.
 *
 * ------------------------------------------------------------------------
 * WHAT A RUN OWNS. `ensure()` gives the process ONE run root under the OS
 * temp directory and points every LAIN home at something inside it:
 *
 *   LAIN_CONFIG_DIR   <root>/home            config, sessions, catalog, desktop build
 *   LAIN_HOME         <root>/home/supervisor-home
 *   LAIN_TEMP_ROOT    <root>/workspaces      subagent / A-B workspaces
 *   LAIN_V1_CONFIG    <root>/home/no-v1-config.json   (does not exist)
 *   LAIN_AGENTS_HOME  <root>/home            the person's AGENTS.md stays out
 *
 * Projects a test creates come from `tmp(prefix)`, inside the same root.
 * `cleanup()` removes the root it created and nothing else — never a glob over
 * the shared temp directory, where other runs and other programs keep files.
 *
 * An environment that ALREADY points at a scratch home (tests/run.js set it)
 * is respected. One that points at the real home is refused before anything
 * is constructed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_HOME = path.join(os.homedir(), '.lain-v2');

let state = null;

function same(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }

function refuse(what, value) {
  throw new Error(`REFUSING: ${what} points at the real Noema home (${value}). Tests may only write inside their own run root.`);
}

/** Establish (or adopt) the isolated profile. Idempotent. */
function ensure() {
  if (state) return state;
  const env = process.env;
  // THE RUN'S PROCESS OWNERSHIP (src/runtimeregistry.js). Read BEFORE TEMP is
  // redirected below: the registry directory must outlive any one run so the
  // next run can see what a killed one left, and it is a TEST registry — the
  // real one (%LOCALAPPDATA%\LAIN\runtime) is never read or reaped by a test.
  const realTmp = os.tmpdir();
  if (env.LAIN_CONFIG_DIR && same(env.LAIN_CONFIG_DIR, REAL_HOME)) refuse('LAIN_CONFIG_DIR', env.LAIN_CONFIG_DIR);
  if (env.LAIN_HOME && same(env.LAIN_HOME, REAL_HOME)) refuse('LAIN_HOME', env.LAIN_HOME);
  let owned = false;
  let root;
  if (env.LAIN_CONFIG_DIR) {
    // ADOPTED: the runner already made a scratch home. Test-owned temp dirs go
    // beside it, under a directory this run creates.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-run-'));
    owned = true;
  } else {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-run-'));
    owned = true;
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    env.LAIN_CONFIG_DIR = home;
    if (env.LAIN_WATCH == null) env.LAIN_WATCH = '0';
    if (env.LAIN_AGENTS_HOME == null) env.LAIN_AGENTS_HOME = home;
  }
  // A MARKER code can check before touching another program's real home
  // (drivers/codexhome.js refuses to link into the real ~/.codex under it).
  env.LAIN_ISOLATED = '1';
  // ZCode's own data-dir override: a test never reads the person's ~/.zcode.
  if (!env.ZCODE_DATA_BASE_DIR) env.ZCODE_DATA_BASE_DIR = path.join(env.LAIN_CONFIG_DIR, 'no-zcode');
  if (!env.LAIN_V1_CONFIG) env.LAIN_V1_CONFIG = path.join(env.LAIN_CONFIG_DIR, 'no-v1-config.json');
  if (!env.LAIN_HOME) env.LAIN_HOME = path.join(env.LAIN_CONFIG_DIR, 'supervisor-home');
  if (!env.LAIN_TEMP_ROOT) env.LAIN_TEMP_ROOT = path.join(root, 'workspaces');
  // THE RUN'S OWN TEMP DIRECTORY. os.tmpdir() reads TEMP/TMP on every call, so
  // every fixture a test makes with mkdtemp(os.tmpdir()) — and every child it
  // spawns — lands inside this run's root, and cleanup() takes it all away
  // without a glob over the shared temp directory.
  const scratch = path.join(root, 'tmp');
  fs.mkdirSync(scratch, { recursive: true });
  env.TEMP = scratch;
  env.TMP = scratch;
  env.TMPDIR = scratch;
  // DELETES GO TO THE RUN'S OWN BIN, never the person's Recycle Bin.
  if (!env.LAIN_TRASH_DIR) env.LAIN_TRASH_DIR = path.join(root, 'trash');
  if (!env.LAIN_RUNTIME_DIR) env.LAIN_RUNTIME_DIR = path.join(realTmp, 'lain-test-runtime');
  if (!env.LAIN_RUN_OWNER) env.LAIN_RUN_OWNER = `harness-test:${path.basename(root)}`;
  // A test's supervisor ends with the test; a person's outlives LAIN on purpose.
  if (!env.LAIN_SUPERVISOR_ON_OWNER_EXIT) env.LAIN_SUPERVISOR_ON_OWNER_EXIT = 'stop';
  fs.mkdirSync(env.LAIN_TEMP_ROOT, { recursive: true });
  // THE LAST WORD: whatever was adopted, nothing below may resolve to the real home.
  if (same(require(path.join(__dirname, '..', '..', 'src', 'config')).configDir(), REAL_HOME)) refuse('configDir()', REAL_HOME);
  state = { root, owned, home: env.LAIN_CONFIG_DIR };
  // WHAT A KILLED EARLIER RUN LEFT: only test owners whose own process is gone,
  // only records whose policy asked to be stopped, each re-verified by pid +
  // start time. Never by name.
  try { state.reaped = require(path.join(__dirname, '..', '..', 'src', 'runtimeregistry')).reapStale({ ownerPrefix: 'harness-test:' }); } catch { state.reaped = null; }
  return state;
}

/** A directory this run owns, for a project or a fixture. */
function tmp(prefix = 'fixture-') {
  const s = ensure();
  return fs.mkdtempSync(path.join(s.root, prefix));
}

/** Remove what this run created — its own root — and nothing else. */
function cleanup() {
  if (!state || !state.owned) return;
  // This run's own processes, by record and identity.
  try { require(path.join(__dirname, '..', '..', 'src', 'runtimeregistry')).stopOwned(process.env.LAIN_RUN_OWNER); } catch { /* best effort */ }
  try { fs.rmSync(state.root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a locked file is left for the OS */ }
}

function isolated() {
  return Boolean(process.env.LAIN_CONFIG_DIR) && !same(process.env.LAIN_CONFIG_DIR, REAL_HOME);
}

module.exports = { ensure, tmp, cleanup, isolated, REAL_HOME };
