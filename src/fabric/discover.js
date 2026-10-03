'use strict';

/** DISCOVERED ON THIS PC (Phase 8.4) — native provider homes LAIN found and has not yet been asked to use. */

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

/** USE A DISCOVERED HOME. */
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
