'use strict';

/**
 * WHAT IS ON THIS MACHINE — runtimes and their homes, found, never taken.
 *
 * For each runtime driver: is its binary on PATH, and which of its documented
 * homes exist (~/.codex, $CODEX_HOME, ~/.claude, $CLAUDE_CONFIG_DIR, …). For a
 * home, LAIN checks that it EXISTS and whether the runtime's own sign-in file is
 * PRESENT — by existence only. No file inside another application's home is
 * opened, read or copied here.
 *
 * ADOPT registers an existing home as an account instance (direct mode, that
 * home), so LAIN talks to the runtime there. It copies nothing and moves no
 * token. It happens only when the person presses Adopt — discovery never
 * enables anything by itself.
 *
 * Read on demand (the Runtimes view, `/account`), cached briefly; never polled.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TTL_MS = 60 * 1000;
let cache = null;

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/** The homes a runtime documents, and the sign-in file whose PRESENCE means "signed in there". */
// AN ISOLATED RUN (tests) looks only where it was told to — never at the person's real home.
const REAL = () => process.env.LAIN_ISOLATED !== '1';
const HOMES = {
  codex: () => [process.env.CODEX_HOME, REAL() ? path.join(os.homedir(), '.codex') : null].filter(Boolean).map((h) => ({ home: h, signIn: 'auth.json', sessions: 'sessions' })),
  'claude-code': () => [process.env.CLAUDE_CONFIG_DIR, REAL() ? path.join(os.homedir(), '.claude') : null].filter(Boolean).map((h) => ({ home: h, signIn: '.credentials.json', sessions: 'projects' })),
  opencode: () => [REAL() ? path.join(os.homedir(), '.local', 'share', 'opencode') : null].filter(Boolean).map((h) => ({ home: h, signIn: 'auth.json', sessions: 'storage' })),
  'cursor-agent': () => [REAL() ? path.join(os.homedir(), '.cursor') : null].filter(Boolean).map((h) => ({ home: h, signIn: null, sessions: null })),
  zcode: () => [],
};

function adoptedHome(v) {
  const r = v.runtime;
  if (!r) return null;
  return v.driver_id === 'codex' && r.home_mode === 'overlay' ? null : v.config_home;
}

function discover(app, { force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return withAdopted(app, cache.rows);
  const drivers = require('./providerdrivers').list().filter((d) => d.sourceType === 'runtime');
  const rows = drivers.map((d) => {
    const bin = d.binary ? d.binary((app && app.cfg) || {}) : null;
    const homes = (HOMES[d.id] ? HOMES[d.id]() : []).filter((h, i, all) => all.findIndex((x) => norm(x.home) === norm(h.home)) === i).map((h) => ({
      home: path.resolve(h.home),
      exists: exists(h.home),
      signInPresent: h.signIn ? exists(path.join(h.home, h.signIn)) : null,
      sessionsPresent: h.sessions ? exists(path.join(h.home, h.sessions)) : null,
    })).filter((h) => h.exists);
    return { driver: d.id, displayName: d.displayName, installed: Boolean(bin), binary: bin ? bin.command : null, homes, install: d.install || null, capabilities: [...d.capabilities] };
  });
  cache = { at: Date.now(), rows };
  return withAdopted(app, rows);
}

function withAdopted(app, rows) {
  let inst = [];
  try { inst = require('./accountinstances').list(app); } catch { inst = []; }
  return rows.map((r) => ({
    ...r,
    homes: r.homes.map((h) => {
      const a = inst.find((v) => v.driver_id === r.driver && adoptedHome(v) && norm(adoptedHome(v)) === norm(h.home));
      return { ...h, adoptedBy: a ? a.id : null };
    }),
    instances: inst.filter((v) => v.driver_id === r.driver).length,
  }));
}

/** Register an existing home as an account. Explicit; copies nothing. */
function adopt(app, { driver, home, name = '' } = {}) {
  const row = discover(app).find((r) => r.driver === driver);
  if (!row) return { ok: false, why: 'unknown runtime' };
  const h = row.homes.find((x) => norm(x.home) === norm(String(home || '')));
  if (!h) return { ok: false, why: 'that home was not found on this machine' };
  if (h.adoptedBy) return { ok: false, why: `already registered as ${h.adoptedBy}` };
  // A profile the person made is THEIRS: external_native — LAIN may run the runtime through it and may detach it, never sign it out.
  const config = driver === 'codex' ? { home_mode: 'direct', codex_home: h.home } : driver === 'claude-code' ? { home: h.home, ownership: 'external_native' } : { home: h.home };
  const r = require('./accountinstances').add(app, { driver_id: driver, display_name: name || `${row.displayName} (${path.basename(h.home)})`, config });
  cache = null;
  return r;
}

function _reset() { cache = null; }

module.exports = { discover, adopt, _reset };
