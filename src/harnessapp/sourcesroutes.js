'use strict';

/** MODEL › SOURCES (Phase 8.1) — every source of intelligence LAIN is connected to, and exactly the removal actions that apply to each. */

const ok = (body = {}) => ({ code: 200, body: { ok: true, ...body } });
const bad = (why, code = 400, extra = {}) => ({ code, body: { ok: false, why: String(why || 'refused'), ...extra } });

function root(app) { return (app && app._sibling) || app; }

const ACT = {
  removeCredential: { kind: 'remove-credential', label: 'Remove API credential', explains: 'Deletes the key LAIN keeps for this route. The route stays, waiting for a new key. Your provider account is not touched.' },
  removeSource: { kind: 'remove-source', label: 'Remove source', explains: 'Removes this route and its key from LAIN. Your provider account is not touched.', danger: true },
  detachRuntime: { kind: 'detach', label: 'Detach from LAIN', explains: 'LAIN stops using this account. The runtime keeps its own sign-in and sessions.' },
  signOut: { kind: 'sign-out', label: 'Sign out', explains: 'Signs the runtime out through its own sign-out, then detaches it. Only when you choose it.', danger: true },
  detachRef: { kind: 'detach-9router', label: 'Detach reference', explains: 'LAIN forgets this provider. It stays connected in 9Router.' },
  adopt: { kind: 'adopt-9router', label: 'Adopt from 9Router', explains: 'Use the account 9Router already holds — no second sign-in. 9Router keeps the authentication.' },
};

async function list(app) {
  const r = root(app);
  const cfg = (r && r.cfg) || {};
  const nine = require('../ninerouter');
  const connected = [];
  // API-KEY ROUTES (and local endpoints), from the configuration.
  for (const [id, c] of Object.entries(cfg.connections || {})) {
    if (!c || typeof c !== 'object') continue;
    if (require('../retired').connectionSystem(id, c)) continue;
    const isNine = nine.isNineRouterUrl(c.baseUrl);
    let host = ''; try { host = new URL(String(c.baseUrl || '')).host; } catch { host = String(c.baseUrl || ''); }
    const local = /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host);
    connected.push({
      id, kind: isNine ? '9router' : local ? 'local-endpoint' : 'api', label: isNine ? '9Router' : c.provider || id.replace(/^lain:/, ''), source: isNine ? '9Router (local)' : local ? `Local endpoint · ${host}` : `API · ${host}`,
      account: id, credential: c.credentialRef ? require('../credentials').describe(c.credentialRef).masked || 'stored' : c.envKey ? `environment (${c.envKey})` : c.via === 'bridge' ? 'held by the bridge' : 'none',
      actions: c.via === 'bridge' ? [] : [...(c.credentialRef ? [ACT.removeCredential] : []), ACT.removeSource],
    });
  }
  // RUNTIME ACCOUNTS (Claude Code, Codex, OpenCode …).
  try {
    for (const v of require('../accountinstances').list(app)) {
      if (v.source_type === 'api') continue;
      connected.push({
        id: v.id, kind: 'runtime-account', label: v.display_name, source: `Runtime · ${v.driver_id}`, account: v.identity ? (v.identity.email || v.identity.planType || v.id) : v.id,
        state: v.authentication_state || null, actions: [ACT.detachRuntime, ...(v.capabilities && v.capabilities.logout === false ? [] : [ACT.signOut])],
      });
    }
  } catch { /* none */ }
  // 9ROUTER PROVIDERS LAIN ADOPTED.
  for (const a of nine.adopted(app)) connected.push({ id: `9router:${a.prefix}`, kind: '9router-provider', label: a.label, source: 'Source: 9Router', account: a.prefix, actions: [ACT.detachRef] });
  // AVAILABLE TO ADOPT (network: 9Router's public catalog only — no key, no inference).
  let available = []; let ninerouter = null;
  try {
    const p = await nine.providers(app);
    ninerouter = p.status;
    available = (p.providers || []).filter((x) => !x.adopted && x.kind === 'account').map((x) => ({ id: `9router:${x.prefix}`, kind: '9router-available', label: x.label, source: 'In 9Router', models: x.count, actions: [ACT.adopt] }));
  } catch (e) { ninerouter = { running: false, why: e.message }; }
  // ANTIGRAVITY (Phase 8.1): preferred through 9Router when 9Router already holds it; otherwise the official Antigravity app is where its sign-in lives.
  const ag = antigravityApp();
  const viaNine = available.some((x) => x.id === '9router:ag') || connected.some((x) => x.id === '9router:ag');
  if (ag && !viaNine) available.push({ id: 'antigravity-app', kind: 'runtime-detected', label: 'Antigravity', source: `Antigravity app · ${ag}`, note: 'Connect your Antigravity account in 9Router (then adopt it here), or sign in inside the Antigravity app. LAIN does not take its sign-in.', actions: [] });
  return { connected, available, ninerouter };
}

/** The official Antigravity application, if installed (a path check — nothing is launched or read). */
function antigravityApp() {
  if (process.env.LAIN_ISOLATED === '1') return process.env.LAIN_ANTIGRAVITY_APP || null;
  const fs = require('fs'); const path = require('path');
  const tries = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe'), path.join(process.env.ProgramFiles || '', 'Antigravity', 'Antigravity.exe')];
  for (const p of tries) { try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  return null;
}

async function action(app, body = {}) {
  const kind = String(body.kind || ''); const id = String(body.id || '');
  const r = root(app);
  const cfg = (r && r.cfg) || {};
  if (kind === 'remove-credential') {
    const c = cfg.connections && cfg.connections[id];
    if (!c || !c.credentialRef) return bad('this route has no stored credential');
    if (body.confirm !== true) return bad('confirm removing the credential', 428, { needsConfirm: true });
    require('../credentials').remove(c.credentialRef);
    delete c.credentialRef;
    require('../config').save(cfg);
    try { require('../appcatalog').invalidate(); } catch { /* not loaded */ }
    return ok({ done: 'credential removed', note: 'The route stays; add a new key to use it again. The provider account is untouched.' });
  }
  if (kind === 'remove-source') {
    if (body.confirm !== true) return bad('confirm removing this source', 428, { needsConfirm: true });
    const ops = require('./accountops');
    const first = ops.remove(app, { id });
    if (!first.ok) return bad(first.why, 409);
    const second = ops.remove(app, { id, token: first.token });
    if (!second.ok) return bad(second.why, 409);
    // A 9Router connection takes LAIN's adopted references with it.
    if (require('../ninerouter').isNineRouterUrl((cfg.connections && cfg.connections[id] && cfg.connections[id].baseUrl) || '')) { /* already deleted above */ }
    for (const a of require('../ninerouter').adopted(app)) if (a.connection === id) require('../ninerouter').detach(app, a.prefix);
    try { require('../appcatalog').invalidate(); } catch { /* not loaded */ }
    try { require('../fabric/store').event('source-removed', { kind: 'api', id }); require('../fabric/tray').changed(app); } catch { /* the registry reports on the next read */ }
    return ok({ done: 'source removed', note: 'Removed from LAIN. The provider account itself is not revoked.' });
  }
  // THREE DIFFERENT THINGS, never one button: detach LAIN forgets the account.
  if (kind === 'detach' || kind === 'sign-out' || kind === 'remove-profile') {
    if ((kind === 'sign-out' || kind === 'remove-profile') && body.confirm !== true) return bad('confirm signing out', 428, { needsConfirm: true });
    const d = await require('../accountinstances').disconnect(app, id, { logout: kind !== 'detach', removeProfile: kind === 'remove-profile' });
    if (d.ok) { try { require('../fabric/store').event('source-removed', { kind: 'oauth', id }); require('../fabric/tray').changed(app); } catch { /* the registry reports on the next read */ } }
    return d.ok ? ok({ done: kind === 'sign-out' ? 'signed out and detached' : kind === 'remove-profile' ? 'signed out and profile removed' : 'detached', steps: d.steps }) : bad(d.why, 409, { busy: Boolean(d.busy) });
  }
  if (kind === 'detach-9router') { const d = require('../ninerouter').detach(app, id.replace(/^9router:/, '')); return d.ok ? ok(d) : bad(d.why, 409); }
  if (kind === 'adopt-9router') { const a = await require('../ninerouter').adopt(app, id.replace(/^9router:/, ''), { key: body.key || null }); return a.ok ? ok(a) : bad(a.why, 409); }
  return bad('unknown action');
}

const ROUTES = {
  'POST /api/sources/list': async (app) => ok(await list(app)),
  'POST /api/sources/action': async (app, body = {}) => action(app, body),
  'POST /api/ninerouter/providers': async (app) => { const p = await require('../ninerouter').providers(app); return p.ok ? ok(p) : bad(p.why, 409, p); },
};

module.exports = { ROUTES, ACT, list, action };
