'use strict';

/**
 * DISCOVERED ON THIS PC (Phase 8.4) — native provider homes LAIN found and has
 * not yet been asked to use.
 *
 * THREE DIFFERENT THINGS, never one screen:
 *
 *   DISCOVER   find an account that already exists here: a Codex home someone
 *              signed in to (~/.codex, $CODEX_HOME). Existence only — no file
 *              inside another program's home is opened or read, no model is
 *              asked, no quota is spent. Happens whenever Accounts is opened and
 *              on Refresh; the answer is cached briefly (runtimediscovery.js).
 *   CONNECT    add a NEW account by the provider's own sign-in.
 *   IMPORT     carry account metadata over from another product (migrate.js).
 *
 * A discovered home is offered as "Use in LAIN". One click registers it as an
 * account instance in direct mode — the runtime keeps using its own home, and
 * LAIN copies nothing and moves no token — then asks the runtime who it is and
 * what its limits are. Nothing is enabled behind the person's back.
 *
 * WHAT IS NOT OFFERED: a home whose runtime is not installed (LAIN could not
 * use it), a home nobody signed in to, one already registered, and — for the
 * runtimes that ARE their own sign-in (Claude Code, OpenCode) — a home whose
 * family already has a connected account.
 */

const os = require('os');
const path = require('path');

const FAMILY = Object.freeze({ codex: 'codex', 'claude-code': 'claude', opencode: 'opencode' });

function short(p) {
  const home = os.homedir();
  const s = String(p || '');
  return home && s.toLowerCase().startsWith(home.toLowerCase()) ? `~${s.slice(home.length)}` : s;
}

/** [{ key, family, driver, home, where, label }] — pure reads; see the header. */
function discovered(app, { force = false } = {}) {
  const rd = require('../runtimediscovery');
  const F = require('./index');
  let rows = [];
  try { rows = rd.discover(app, { force }); } catch { rows = []; }
  const out = [];
  for (const r of rows) {
    const family = FAMILY[r.driver];
    if (!family || !r.installed) continue;
    for (const h of r.homes) {
      if (h.adoptedBy || h.signInPresent === false) continue;
      if (r.driver !== 'codex') { const f = F.family(app, family); if (f && f.accounts.length) continue; }
      out.push({ key: `${r.driver}|${h.home}`, family, familyLabel: F.FAMILY_LABEL[family] || family, driver: r.driver, home: h.home, where: short(h.home), label: `Existing ${r.displayName} profile` });
    }
  }
  return out;
}

/**
 * USE A DISCOVERED HOME. The `key` names a row `discovered()` just listed —
 * nothing else can be adopted through here (no path is taken from a caller).
 */
async function use(app, key, { force = false } = {}) {
  const row = discovered(app, { force }).find((d) => d.key === String(key || ''));
  if (!row) return { ok: false, why: 'that profile is no longer here — Refresh' };
  const rd = require('../runtimediscovery');
  const r = rd.adopt(app, { driver: row.driver, home: row.home, name: '' });
  if (!r || !r.ok) return { ok: false, why: (r && r.why) || 'could not use that profile' };
  const id = r.instance && r.instance.id;
  // ASK THE RUNTIME WHO IT IS (a account read — no model request). Its own answer names the account.
  let refreshed = null;
  try { refreshed = id ? await require('../accountinstances').refresh(app, id) : null; } catch { refreshed = null; }
  try { require('./store').event('source-added', { kind: 'oauth', id, family: row.family, name: row.label, capabilities: { discovered: true } }); } catch { /* reported on the next read */ }
  try { require('./tray').changed(app); } catch { /* the next receipt updates it */ }
  return { ok: true, id, family: row.family, refreshed: Boolean(refreshed && refreshed.ok) };
}

module.exports = { discovered, use, short, FAMILY };
