'use strict';

/**
 * THE NOEMA UPDATER — one implementation, used by the CLI, the Harness and `noema update`.
 *
 *   check     the channel's signed manifest, at most every CHECK_MS unless asked (cached in <home>/update/state.json)
 *   download  the asset for this machine → <install>/staging → SHA-256 checked against the SIGNED manifest
 *   stage     extracted to <install>/versions/<version> (a new directory — nothing running is touched)
 *   apply     previous ← current, current ← staged, pending ← staged; the app exits with 75 and the launcher
 *             (distribution/launcher.cs) starts the new version with the session to resume. A pending version that
 *             never reports healthy is rolled back by the launcher to the previous one.
 *
 * WHERE IT APPLIES. Only to an INSTALLED Noema (the launcher sets NOEMA_INSTALL_ROOT). A development checkout
 * (`node bin/noema.js`) has nothing to switch and says so. No timer runs unless the CLI or Harness started one, and
 * that one checks at most every six hours — never a poll loop.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('./manifest');

const CHECK_MS = 6 * 3600 * 1000;
const RESTART_CODE = 75;

function home() { return require('../config').configDir(); }
function stateFile() { return path.join(home(), 'update', 'state.json'); }
function readState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; } catch { return {}; } }
function writeState(s) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  const t = `${stateFile()}.tmp`;
  fs.writeFileSync(t, JSON.stringify(s, null, 2));
  fs.renameSync(t, stateFile());
}

/** What this build is (app/build-info.json, written by the release build; a checkout reports "development"). */
function build() {
  let info = {};
  try { info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'build-info.json'), 'utf8')) || {}; } catch { info = {}; }
  const pkg = require('../../package.json');
  return {
    product: 'Noema', version: info.version || pkg.version, channel: info.channel || 'development',
    revision: info.revision || null, built: info.built || null, feed: info.feed || null, protocol: require('./compat').PROTOCOL,
  };
}

function installRoot() {
  const r = process.env.NOEMA_INSTALL_ROOT;
  return r && fs.existsSync(path.join(r, 'current')) ? r : null;
}
function pointer(name) { try { return fs.readFileSync(path.join(installRoot(), name), 'utf8').trim(); } catch { return null; } }
function setPointer(name, value) {
  const p = path.join(installRoot(), name); const t = `${p}.tmp`;
  fs.writeFileSync(t, value);
  fs.renameSync(t, p);
}

function settings(cfg = {}) {
  const u = (cfg && cfg.update) || {};
  return {
    channel: M.CHANNELS.includes(u.channel) ? u.channel : 'stable',
    feed: process.env.NOEMA_UPDATE_FEED || u.feed || build().feed || null,
    auto: u.auto !== false,
  };
}

async function fetchBytes(url) {
  if (/^file:/i.test(url)) return fs.readFileSync(require('url').fileURLToPath(url));
  if (/^[a-z]:[\\/]/i.test(url) || url.startsWith('\\\\')) return fs.readFileSync(url);
  const r = await fetch(url, { redirect: 'follow', cache: 'no-store' });
  if (!r.ok) { const e = new Error(`${r.status} ${r.statusText}`); e.status = r.status; throw e; }
  return Buffer.from(await r.arrayBuffer());
}
function resolveUrl(base, u) {
  if (/^(https?:|file:)/i.test(u)) return u;
  if (/^(https?:|file:)/i.test(base)) return new URL(u, base.endsWith('/') ? base : `${base}/`).href;
  return path.join(base, u);
}

/**
 * CHECK. { state: 'current'|'available'|'staged'|'unconfigured'|'error', ... } — cached; `force` skips the interval.
 */
async function check({ cfg = {}, force = false, now = Date.now() } = {}) {
  const s = settings(cfg);
  const st = readState();
  const b = build();
  if (!s.feed) return { state: 'unconfigured', current: b.version, why: 'this build has no update source configured' };
  if (!force && st.checkedAt && now - st.checkedAt < CHECK_MS && st.channel === s.channel) return summarize(st, b);
  const base = s.feed.replace(/[\\/]+$/, '');
  let bytes; let sig;
  try {
    bytes = await fetchBytes(resolveUrl(base, `manifest-${s.channel}.json`));
    sig = (await fetchBytes(resolveUrl(base, `manifest-${s.channel}.json.sig`))).toString('utf8');
  } catch (e) {
    const out = { ...st, channel: s.channel, checkedAt: now, lastError: e.status === 404 ? 'no release has been published on this channel yet' : `the update source did not answer (${e.message})` };
    writeState(out);
    return { state: 'error', current: b.version, why: out.lastError };
  }
  const v = M.verifySignature(bytes, sig, require('./trust').publicKeys());
  if (!v.ok) { writeState({ ...st, channel: s.channel, checkedAt: now, lastError: v.why }); return { state: 'error', current: b.version, why: v.why }; }
  const p = M.parse(bytes);
  if (!p.ok) { writeState({ ...st, channel: s.channel, checkedAt: now, lastError: p.why }); return { state: 'error', current: b.version, why: p.why }; }
  const m = p.manifest;
  const newer = M.compare(m.version, b.version) > 0;
  const reachable = !m.minimumCompatible || M.compare(b.version, m.minimumCompatible) >= 0;
  const asset = M.assetFor(m);
  const out = {
    ...st, channel: s.channel, checkedAt: now, lastError: null,
    available: newer && asset ? {
      version: m.version, released: m.released || null, notes: m.notes || null, summary: Array.isArray(m.summary) ? m.summary.slice(0, 12).map(String) : [],
      mandatory: Boolean(m.mandatory), security: Boolean(m.security), reachable, minimumCompatible: m.minimumCompatible || null,
      protocol: m.protocol || null, asset: { name: asset.name || path.basename(asset.url), url: resolveUrl(base, asset.url), size: asset.size || null, sha256: asset.sha256.toLowerCase() },
    } : null,
  };
  if (out.staged && M.compare(out.staged.version, b.version) <= 0) out.staged = null;
  writeState(out);
  return summarize(out, b);
}

function summarize(st, b = build()) {
  if (st.staged && M.compare(st.staged.version, b.version) > 0) return { state: 'staged', current: b.version, staged: st.staged, available: st.available || null };
  if (st.available && M.compare(st.available.version, b.version) > 0) return { state: 'available', current: b.version, available: st.available };
  if (st.lastError) return { state: 'error', current: b.version, why: st.lastError };
  return { state: 'current', current: b.version, checkedAt: st.checkedAt || null };
}
function status() { return summarize(readState()); }

/**
 * DOWNLOAD + VERIFY + STAGE. Independent of any running task: nothing the app is using is touched.
 * { ok, staged: { version, dir } } or { ok: false, why } — a bad hash or a bad package is rejected and deleted.
 */
async function stage({ cfg = {} } = {}) {
  const root = installRoot();
  if (!root) return { ok: false, why: 'updates apply to an installed Noema — this is a development checkout' };
  const st = readState();
  const a = st.available;
  if (!a) return { ok: false, why: 'no update is available — check first' };
  if (!a.reachable) return { ok: false, why: `Noema ${a.version} needs ${a.minimumCompatible} or newer installed first` };
  if (!/^[\w.+-]+$/.test(a.version)) return { ok: false, why: 'the release version is not a safe directory name' };
  const target = path.join(root, 'versions', a.version);
  if (fs.existsSync(path.join(target, 'app', 'bin', 'noema.js'))) {
    writeState({ ...st, staged: { version: a.version, at: Date.now(), dir: target } });
    setPointer('staged', a.version);
    return { ok: true, staged: { version: a.version, dir: target }, already: true };
  }
  const stagingDir = path.join(root, 'staging');
  fs.mkdirSync(stagingDir, { recursive: true });
  const file = path.join(stagingDir, `${a.version}.zip`);
  const bytes = await fetchBytes(a.asset.url).catch((e) => { throw new Error(`the download failed: ${e.message}`); });
  fs.writeFileSync(`${file}.part`, bytes);
  const hash = await M.sha256File(`${file}.part`);
  if (hash !== a.asset.sha256) {
    try { fs.unlinkSync(`${file}.part`); } catch { /* gone */ }
    writeState({ ...st, lastError: `the downloaded package did not match the signed manifest (SHA-256) — rejected` });
    return { ok: false, why: 'the downloaded package did not match the signed manifest (SHA-256) — rejected; the installed version is unchanged' };
  }
  fs.renameSync(`${file}.part`, file);
  const tmp = `${target}.staging`;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* none */ }
  fs.mkdirSync(tmp, { recursive: true });
  try {
    // tar.exe (bsdtar, part of Windows 10/11) reads zip.
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', file, '-C', tmp], { stdio: 'ignore', windowsHide: true, timeout: 300000 });
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* none */ }
    return { ok: false, why: `the package could not be unpacked: ${e.message}` };
  }
  const ok = fs.existsSync(path.join(tmp, 'runtime', 'node.exe')) && fs.existsSync(path.join(tmp, 'app', 'bin', 'noema.js'));
  if (!ok) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* none */ } return { ok: false, why: 'the package is not a Noema build (runtime/node.exe and app/bin/noema.js missing) — rejected' }; }
  fs.renameSync(tmp, target);
  try { fs.unlinkSync(file); } catch { /* kept */ }
  writeState({ ...readState(), staged: { version: a.version, at: Date.now(), dir: target }, lastError: null });
  // THE LAUNCHER'S VIEW OF IT: at the next cold start at Windows sign-in, the launcher switches to this verified
  // version BEFORE anything runs (distribution/launcher.cs) — one launch, never "start the old one, then restart".
  // A Windows shutdown with an update staged therefore replaces nothing mid-shutdown.
  setPointer('staged', a.version);
  return { ok: true, staged: { version: a.version, dir: target } };
}

/**
 * APPLY — point the install at the staged version and ask the launcher to restart into it with `args` (the session
 * to resume). The caller must already have committed its checkpoint and saved; it then exits with RESTART_CODE.
 */
function apply({ args = [], cwd = process.cwd() } = {}) {
  const root = installRoot();
  if (!root) return { ok: false, why: 'updates apply to an installed Noema' };
  const st = readState();
  const v = st.staged && st.staged.version;
  if (!v || !fs.existsSync(path.join(root, 'versions', v, 'app', 'bin', 'noema.js'))) return { ok: false, why: 'no staged update to apply' };
  const cur = pointer('current');
  if (cur && cur !== v) setPointer('previous', cur);
  setPointer('pending', v);
  setPointer('current', v);
  try { fs.unlinkSync(path.join(root, 'staged')); } catch { /* none */ }
  fs.writeFileSync(path.join(root, 'restart.json'), JSON.stringify({ args: args.map(String), cwd }));
  writeState({ ...st, applied: { version: v, from: cur, at: Date.now() } });
  return { ok: true, version: v, from: cur, restartCode: RESTART_CODE };
}

/** A restart WITHOUT a version change (the same launcher protocol). */
function requestRestart({ args = [], cwd = process.cwd() } = {}) {
  const root = installRoot();
  if (!root) return { ok: false, why: 'not started by the Noema launcher' };
  fs.writeFileSync(path.join(root, 'restart.json'), JSON.stringify({ args: args.map(String), cwd }));
  return { ok: true, restartCode: RESTART_CODE };
}

/** STARTED WELL: tell the launcher this version is healthy (it clears `pending`, so no rollback). */
function markHealthy() {
  const f = process.env.NOEMA_HEALTH_FILE;
  if (!f) return false;
  try { fs.writeFileSync(f, new Date().toISOString()); } catch { return false; }
  try {
    const st = readState();
    // `applied` stays (marked healthy): the restarted session says "Updated from X" from it (update/cli.js afterRestart).
    if (st.staged && M.compare(build().version, st.staged.version) >= 0) writeState({ ...st, staged: null, available: null, applied: st.applied ? { ...st.applied, healthyAt: Date.now() } : null });
  } catch { /* the next check corrects it */ }
  return true;
}

/** Old versions: keep current and previous, remove the rest (never one that is running — Windows refuses anyway). */
function prune() {
  const root = installRoot();
  if (!root) return { removed: [] };
  const keep = new Set([pointer('current'), pointer('previous'), pointer('pending')].filter(Boolean));
  const removed = [];
  for (const v of fs.readdirSync(path.join(root, 'versions'))) {
    if (keep.has(v)) continue;
    try { fs.rmSync(path.join(root, 'versions', v), { recursive: true, force: true }); removed.push(v); } catch { /* in use */ }
  }
  return { removed };
}

module.exports = { CHECK_MS, RESTART_CODE, build, installRoot, settings, check, status, stage, apply, requestRestart, markHealthy, prune, readState, writeState };
