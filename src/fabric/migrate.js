'use strict';

/** IMPORT ACCOUNTS — a ONE-TIME move from another router installation INTO LAIN's own fabric, so LAIN stops depending on the router. */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const portable = require('./portable');

const CLASS = Object.freeze({
  PORTABLE_AUTH: 'PORTABLE_AUTH',
  NATIVE_PROFILE_REFERENCE: 'NATIVE_PROFILE_REFERENCE',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  UNSUPPORTED: 'UNSUPPORTED',
});

// A router's provider prefix → the family.
const PREFIX_FAMILY = Object.freeze({
  cx: 'codex', cc: 'claude', ag: 'antigravity', agcc: 'antigravity', gemini: 'antigravity', gh: 'copilot', kr: 'kiro', cu: 'cursor', qd: 'qwen', ocg: 'opencode',
});
/** How a person signs in again, where LAIN has its own supported sign-in for the family. */
const REAUTH = Object.freeze({
  codex: { supported: true, how: 'Connect account — Codex\'s own sign-in, in a Codex home LAIN keeps for this account' },
  claude: { supported: true, how: 'Connect account — Claude Code\'s own sign-in, in a new private profile (no account you have is changed)' },
  antigravity: { supported: true, how: 'Connect account — Google sign-in through Antigravity\'s own server, in a new private profile' },
  opencode: { supported: true, how: 'Sign in inside OpenCode — LAIN runs OpenCode\'s own runtime' },
});
/** Families LAIN reaches only through an API (a LAIN product decision). */
const API_ONLY = Object.freeze({ zai: 'LAIN integrates Z.ai through its API — add your Z.ai API key under MODEL › API' });
/** Where each runtime keeps its sign-in in its own profile (existence is checked, never contents). */
const SIGN_IN_FILE = Object.freeze({ codex: 'auth.json', claude: '.credentials.json' });
const DRIVER = Object.freeze({ codex: 'codex', claude: 'claude-code' });

function reauthOf(family) {
  if (API_ONLY[family]) return { supported: false, apiOnly: true, how: API_ONLY[family] };
  return REAUTH[family] || { supported: false, how: 'LAIN has no runtime for this provider yet — the account stays discovered, and nothing is borrowed from the source' };
}

function root(app) { return (app && app._sibling) || app; }
function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }

// ------------------------------------------------------------- adapters --

/** Routers LAIN is connected to: the families their prefixes name (LAIN's own cached model list). Metadata only. */
function fromConnections(app) {
  const out = [];
  let conns = [];
  try { conns = require('../appcatalog').connections(root(app)); } catch { conns = []; }
  const nine = (c) => { try { return String(c.provider || '').toLowerCase() === '9router' || String(c.provider || '').toLowerCase() === 'omniroute' || require('../ninerouter').isNineRouterUrl(c.baseUrl); } catch { return false; } };
  for (const c of conns) {
    if (!nine(c)) continue;
    const prefixes = new Set();
    for (const m of c.models || []) { const id = typeof m === 'string' ? m : (m && m.id); const p = String(id || '').split('/')[0]; if (PREFIX_FAMILY[p]) prefixes.add(p); }
    const fams = new Set([...prefixes].map((p) => PREFIX_FAMILY[p]));
    for (const family of fams) {
      out.push({ key: `conn:${c.id}:${family}`, source: { kind: 'connection', id: c.id, label: 'Router installation' }, family, kind: 'oauth', identity: null, label: null, transferable: false, credential: null, profileDir: null });
    }
  }
  return out;
}

/** A router export the person picked. An OAuth credential is only ever used through its provider's own format. */
function fromExport(file) {
  let d;
  try { d = JSON.parse(fs.readFileSync(String(file), 'utf8')); } catch (e) { return { ok: false, why: `could not read the export: ${e.message}` }; }
  const list = Array.isArray(d && d.accounts) ? d.accounts : [];
  const src = { kind: 'export', id: String(file), label: String((d && d.source) || 'Router export').slice(0, 60) };
  return {
    ok: true,
    found: list.slice(0, 200).map((a, i) => {
      const kind = a && a.kind === 'api' ? 'api' : 'oauth';
      const family = String((a && a.family) || (kind === 'api' ? a.provider : '') || 'unknown').toLowerCase();
      return {
        key: `export:${require('crypto').createHash('sha1').update(String(file)).digest('hex').slice(0, 8)}:${i}:${family}`, source: src, family, kind, identity: (a && a.identity) ? String(a.identity) : null, label: (a && a.label) ? String(a.label).slice(0, 60) : null,
        transferable: kind === 'api' && Boolean(a && a.key),
        api: kind === 'api' ? { provider: String(a.provider || family), baseUrl: String(a.baseUrl || ''), protocol: a.protocol || '', key: a.key ? String(a.key) : null } : null,
        credential: kind === 'oauth' && a && a.credential && typeof a.credential === 'object' ? a.credential : null,
        profileDir: kind === 'oauth' && a && a.profileDir ? String(a.profileDir) : null,
      };
    }),
  };
}

// ------------------------------------------------------------------ plan --

function emailsOf(app, family) {
  const out = [];
  try {
    for (const a of require('../accountcatalog').list(app).accounts) {
      const f = require('./index').familyIdOf(a);
      if (f === family && a.identity && a.identity.email) out.push({ id: a.id, email: String(a.identity.email).toLowerCase(), name: a.name });
    }
  } catch { /* none */ }
  return out;
}

/** A profile directory an export named, when it really holds the runtime's own sign-in (existence only). */
function namedProfile(x) {
  const f = SIGN_IN_FILE[x.family];
  if (!x.profileDir || !f) return null;
  const home = path.resolve(x.profileDir);
  return exists(path.join(home, f)) ? { key: `${DRIVER[x.family]}|${home}`, where: home, home, driver: DRIVER[x.family], named: true } : null;
}

/** THE CLASS OF ONE DISCOVERED ACCOUNT, and why. */
function classify(x, { native = [] } = {}) {
  if (x.kind === 'api') {
    return x.transferable ? { authClass: CLASS.PORTABLE_AUTH, reason: 'an API key you own — it moves into LAIN\'s secret store once the provider accepts it' }
      : { authClass: CLASS.REAUTH_REQUIRED, reason: 'the source lists this API without its key — add the key in MODEL › API' };
  }
  if (API_ONLY[x.family]) return { authClass: CLASS.UNSUPPORTED, reason: API_ONLY[x.family] };
  const r = reauthOf(x.family);
  if (!r.supported) return { authClass: CLASS.UNSUPPORTED, reason: r.how };
  // A PORTABLE CREDENTIAL moves as it is (fabric/portable.js decides, per provider format).
  if (x.credential) {
    const a = portable.assess(x.family, x.credential);
    if (a.portable) return { authClass: CLASS.PORTABLE_AUTH, reason: 'a complete sign-in in the provider\'s own format — it moves into a new LAIN profile and is verified with the provider', portable: true };
    // A NAMED OR DISCOVERED NATIVE PROFILE still beats re-authentication.
    const home = namedProfile(x) || native.find((d) => d.family === x.family);
    if (home) return { authClass: CLASS.NATIVE_PROFILE_REFERENCE, reason: `the provider's own profile is on this PC (${home.where}) — LAIN uses it where it is`, native: home };
    return { authClass: CLASS.REAUTH_REQUIRED, reason: portable.reasonText(a) };
  }
  const home = namedProfile(x) || native.find((d) => d.family === x.family);
  if (home) return { authClass: CLASS.NATIVE_PROFILE_REFERENCE, reason: `the provider's own profile is on this PC (${home.where}) — LAIN uses it where it is`, native: home };
  return { authClass: CLASS.REAUTH_REQUIRED, reason: portable.reasonText({ reason: 'metadata' }) };
}

/** WHAT WILL HAPPEN to each discovered account — never an action yet. */
function plan(app, found) {
  const ph = store.placeholders();
  let native = [];
  try { native = require('./discover').discovered(app); } catch { native = []; }
  return found.map((x) => {
    const mine = emailsOf(app, x.family);
    const hint = x.identity ? x.identity.toLowerCase() : null;
    const same = hint ? mine.find((m) => m.email === hint) : null;
    const placed = Object.entries(ph).find(([, p]) => p.family === x.family && (hint ? (p.identityHint || '').toLowerCase() === hint : !p.identityHint) && p.provenance && p.provenance.key !== x.key);
    const duplicate = same ? { kind: 'account', id: same.id, name: same.name } : placed ? { kind: 'placeholder', id: placed[0], name: placed[1].label || placed[1].family } : null;
    const c = classify(x, { native });
    const action = duplicate ? 'duplicate'
      : c.authClass === CLASS.PORTABLE_AUTH ? (x.kind === 'api' ? 'transfer' : 'migrate')
        : c.authClass === CLASS.NATIVE_PROFILE_REFERENCE ? 'adopt'
          : c.authClass === CLASS.UNSUPPORTED ? 'unsupported' : 'reauth';
    return {
      key: x.key, family: x.family, kind: x.kind, source: x.source.label, identity: x.identity ? require('./index').mask(x.identity) : null, label: x.label,
      action, authClass: c.authClass, reason: c.reason, duplicate,
      reauth: x.kind === 'oauth' ? reauthOf(x.family) : null, adopt: c.native ? { key: c.native.key, where: c.native.where, named: Boolean(c.native.named) } : null,
      signInNeeded: c.authClass === CLASS.REAUTH_REQUIRED,
      text: duplicate ? 'This account appears to already exist.' : c.reason,
    };
  });
}

// ----------------------------------------------------------------- apply --

async function transfer(app, x) {
  const ops = require('../harnessapp/accountops');
  const r = await ops.addKey(root(app), { provider: x.api.provider, key: x.api.key, baseUrl: x.api.baseUrl, protocol: x.api.protocol });
  if (!r.ok) return placeholder(x, { authClass: CLASS.REAUTH_REQUIRED, reason: portable.reasonText({ reason: 'rejected', why: r.why }) });
  store.event('migration', { key: x.key, family: x.family, result: 'transferred', authClass: CLASS.PORTABLE_AUTH, connection: r.connection, provenance: x.source.label });
  return { ok: true, result: 'transferred', authClass: CLASS.PORTABLE_AUTH, connection: r.connection, label: r.label };
}

/** PORTABLE_AUTH, a sign-in: install it in a new LAIN-owned profile and let the provider say who it is. */
async function migrate(app, x) {
  const r = await portable.install(app, x.family, x.credential, { name: x.label || '' });
  if (!r.ok) return placeholder(x, { authClass: CLASS.REAUTH_REQUIRED, reason: portable.reasonText(r) });
  store.event('migration', { key: x.key, family: x.family, result: 'migrated', authClass: CLASS.PORTABLE_AUTH, account: r.id, provenance: x.source.label });
  const got = r.identity && r.identity.email ? String(r.identity.email).toLowerCase() : null;
  const hint = x.identity ? String(x.identity).toLowerCase() : null;
  return { ok: true, result: hint && got && hint !== got ? 'migrated-other' : 'migrated', authClass: CLASS.PORTABLE_AUTH, account: r.id };
}

/** NATIVE_PROFILE_REFERENCE: use the profile where it is, then CHECK who it is. */
async function adoptNative(app, x, p) {
  let used;
  if (p.adopt && p.adopt.named) {
    // A PROFILE THE EXPORT NAMED: registered as the person's own (external_native) — never signed out by LAIN, never copied.
    const driver = DRIVER[x.family];
    const home = p.adopt.where;
    const config = driver === 'codex' ? { home_mode: 'direct', codex_home: home } : { home, ownership: 'external_native' };
    const a = require('../accountinstances').add(app, { driver_id: driver, display_name: x.label || '', config });
    used = a.ok ? { ok: true, id: a.instance.id } : { ok: false, why: a.why };
    if (used.ok) { try { await require('../accountinstances').refresh(app, used.id); } catch { /* read below */ } }
  } else {
    used = await require('./discover').use(app, p.adopt.key, { force: true });
  }
  if (!used.ok) return placeholder(x, { authClass: CLASS.REAUTH_REQUIRED, reason: `the profile on this PC could not be used: ${used.why || 'unknown'}` });
  const hint = x.identity ? String(x.identity).toLowerCase() : null;
  let got = null;
  try { const a = require('../accountcatalog').find(app, used.id); got = a && a.identity && a.identity.email ? String(a.identity.email).toLowerCase() : null; } catch { got = null; }
  store.event('migration', { key: x.key, family: x.family, result: 'connected', authClass: CLASS.NATIVE_PROFILE_REFERENCE, account: used.id, provenance: x.source.label });
  if (hint && got && hint !== got) {
    const ph = placeholder(x, { authClass: CLASS.REAUTH_REQUIRED, reason: 'the profile on this PC is signed in to a different account' });
    return { ...ph, result: 'connected-other', account: used.id };
  }
  return { ok: true, result: 'connected', authClass: CLASS.NATIVE_PROFILE_REFERENCE, account: used.id };
}

function placeholder(x, cls = null) {
  // ONE PLACEHOLDER PER DISCOVERED ACCOUNT PER SOURCE: re-importing the same source is idempotent; the same
  // identity from ANOTHER source is a separate entry only when the person chose Add separately.
  const id = `import:${x.family}:${require('crypto').createHash('sha1').update(`${x.family}|${x.identity || ''}|${x.key}|${x.source.id}`).digest('hex').slice(0, 10)}`;
  const c = cls || classify(x);
  const r = reauthOf(x.family);
  const state = c.authClass === CLASS.UNSUPPORTED ? 'UNSUPPORTED' : 'REAUTH_REQUIRED';
  store.putPlaceholder(id, {
    family: x.family, label: x.label || null, identityHint: x.identity || null,
    state, authClass: c.authClass, reason: c.reason, how: r.how, note: c.reason,
    provenance: { key: x.key, source: x.source.label, kind: x.source.kind }, discoveredAt: Date.now(),
  });
  store.event('migration', { key: x.key, family: x.family, result: state === 'UNSUPPORTED' ? 'unsupported' : 'reauth-required', authClass: c.authClass, reason: c.reason, placeholder: id, provenance: x.source.label });
  return { ok: true, result: state === 'UNSUPPORTED' ? 'unsupported' : 'reauth-required', authClass: c.authClass, reason: c.reason, placeholder: id, how: r.how };
}

/** APPLY — `decisions` maps each discovered key to the person's answer where one is needed: 'keep' (skip; keep what LAIN has) · 'replace' · 'separate'. */
async function apply(app, found, decisions = {}) {
  const planned = plan(app, found);
  const out = [];
  for (const x of found) {
    const p = planned.find((y) => y.key === x.key);
    const choice = decisions[x.key] || null;
    if (p.action === 'duplicate' && !choice) { out.push({ key: x.key, ok: false, result: 'needs-decision', text: p.text, choices: ['keep', 'replace', 'separate'] }); continue; }
    if (choice === 'keep') { out.push({ key: x.key, ok: true, result: 'kept-existing' }); continue; }
    if (choice === 'replace' && p.duplicate && p.duplicate.kind === 'placeholder') store.dropPlaceholder(p.duplicate.id);
    // A DUPLICATE the person chose to replace or add separately is decided by its own class, as any other.
    const c = classify(x, { native: p.adopt ? [{ ...p.adopt, family: x.family }] : [] });
    let r;
    // eslint-disable-next-line no-await-in-loop -- one provider check per account, in order
    if (c.authClass === CLASS.PORTABLE_AUTH) r = x.kind === 'api' ? await transfer(app, x) : await migrate(app, x);
    // eslint-disable-next-line no-await-in-loop -- the same
    else if (c.authClass === CLASS.NATIVE_PROFILE_REFERENCE) r = await adoptNative(app, x, { adopt: { key: c.native.key, where: c.native.where, named: Boolean(c.native.named) } });
    else r = placeholder(x, c);
    out.push({ key: x.key, ...r });
  }
  try { require('../appcatalog').invalidate(); } catch { /* not loaded */ }
  try { require('./tray').changed(app); } catch { /* no tray */ }
  return { ok: true, results: out };
}

/** A PLACEHOLDER IS DONE when LAIN's own sign-in for it exists: an account of the family with the same identity */
function reconcile(app) {
  const done = [];
  for (const [id, p] of Object.entries(store.placeholders())) {
    if (!p.identityHint) continue;
    const hit = emailsOf(app, p.family).find((m) => m.email === String(p.identityHint).toLowerCase());
    if (hit) { store.dropPlaceholder(id); store.event('migration', { family: p.family, result: 'migrated', placeholder: id, account: hit.id }); done.push(id); }
  }
  return done;
}
function finish(id) { const p = store.placeholders()[id]; if (!p) return { ok: false, why: 'no such discovered account' }; store.dropPlaceholder(id); store.event('migration', { family: p.family, result: 'dismissed', placeholder: id }); return { ok: true }; }

/** Everything every source holds right now: a router LAIN is connected to (metadata), a router INSTALLED on this PC */
function discover(app, { exportFile = null, routers = true, routerPaths = null } = {}) {
  const found = [];
  const ri = require('./routerimport');
  const fromRouters = routers ? ri.fromRouters(routerPaths || undefined) : [];
  // AN INSTALLED ROUTER SPEAKS FOR ITSELF: its connection's prefix-only metadata would only duplicate its own rows.
  const covered = new Set(fromRouters.map((x) => x.family));
  found.push(...fromConnections(app).filter((x) => !covered.has(x.family)), ...fromRouters);
  let exportError = null;
  if (exportFile) { const e = fromExport(exportFile); if (e.ok) found.push(...e.found); else exportError = e.why; }
  return { found, plan: plan(app, found), exportError, routers: routers ? ri.installed(routerPaths || undefined) : [] };
}

module.exports = { CLASS, discover, plan, classify, apply, reconcile, finish, fromExport, fromConnections, reauthOf, PREFIX_FAMILY, API_ONLY };
