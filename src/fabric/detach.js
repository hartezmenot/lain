'use strict';

/**
 * REMOVING AN ACCOUNT FROM LAIN (Phase 8.4.1) — every kind of account, one place, three different acts.
 *
 *   detach          LAIN forgets the account. Nothing is signed out anywhere and nothing is deleted. For an account
 *                   that is the person's own (an external/native profile, the default Claude profile) this is the
 *                   ONLY thing LAIN will ever do to it.
 *   sign-out        the provider's own sign-out, in THAT account's directory only, for a LAIN-OWNED account.
 *                   (The account leaves LAIN with it: an account that is signed out is not capacity.)
 *   remove-profile  sign out AND delete the profile directory LAIN made for it.
 *
 * NONE OF THEM RUNS UNDER A REQUEST THAT IS WORKING THROUGH THE ACCOUNT (accountwork.js): the answer is "in use",
 * with what is using it, so the person can Stop that task on purpose. This file never stops anything.
 *
 * What an "account" is here: a connected AccountInstance (Codex, Claude, Antigravity), the person's default runtime
 * profile (`runtime:claude-code`, `runtime:zcode`, `runtime:opencode` — it stops being OFFERED by LAIN; the runtime and
 * its sign-in are untouched), or an entry waiting under Finish setup (an imported pool, a migrated placeholder).
 */

const store = require('./store');

function root(app) { return (app && app._sibling) || app; }
const isDefaultRuntime = (id) => /^runtime:[\w-]+$/.test(String(id || ''));

function refresh(app) {
  try { require('../appcatalog').invalidate(); const r = root(app); if (r) { r._acctMemo = null; r._catMemo = null; } } catch { /* rebuilt on the next read */ }
  try { require('./tray').changed(app); } catch { /* presentation only */ }
}

/** What is working through an account right now: [{ kind: 'agent' | 'chat' }] — observed, never signalled. */
function inUse(accountId) { try { return require('../accountwork').busyAccount(accountId).map((w) => ({ kind: w.kind || 'request' })); } catch { return []; } }
const usedBy = (w) => (w.some((x) => x.kind === 'agent') ? 'Coding Agent' : 'Chat');

/**
 * @param acct  { id, instanceId, ownership, name, family } — a connected account view
 * @param mode  detach | sign-out | remove-profile
 */
async function one(app, acct, mode = 'detach') {
  const id = acct.id;
  const working = inUse(id);
  if (working.length) return { ok: false, busy: true, id, name: acct.name, why: `${acct.name} is in use by ${usedBy(working)} — stop that task first, or let it finish.`, usedBy: usedBy(working) };
  const owned = acct.ownership === 'lain';
  if ((mode === 'sign-out' || mode === 'remove-profile') && !owned) return { ok: false, id, name: acct.name, why: 'This is your own profile — sign out inside the provider\'s own app. LAIN only detaches it.' };
  if (acct.instanceId) {
    const d = await require('../accountinstances').disconnect(app, acct.instanceId, { logout: mode !== 'detach', removeProfile: mode === 'remove-profile' });
    if (!d.ok) return { ok: false, busy: Boolean(d.busy), id, name: acct.name, why: d.why };
    try { store.event('source-removed', { kind: 'oauth', id: acct.instanceId }); } catch { /* reported on the next read */ }
    refresh(app);
    return { ok: true, id, name: acct.name, steps: d.steps };
  }
  if (isDefaultRuntime(id)) {
    // THE PERSON'S OWN DEFAULT PROFILE: LAIN stops OFFERING it. Its sign-in and its sessions are untouched.
    if (mode !== 'detach') return { ok: false, id, name: acct.name, why: 'This is your own profile — sign out inside the provider\'s own app.' };
    const r = root(app); const rt = id.slice('runtime:'.length);
    r.cfg.runtimes = { ...(r.cfg.runtimes || {}), [rt]: { ...((r.cfg.runtimes || {})[rt] || {}), disconnected: true } };
    try { require('../config').save(r.cfg); } catch { /* applies in memory */ }
    try { store.event('source-removed', { kind: 'runtime', id }); } catch { /* reported on the next read */ }
    refresh(app);
    return { ok: true, id, name: acct.name, steps: ['LAIN no longer offers it; the provider\'s own sign-in is untouched'] };
  }
  return { ok: false, id, name: acct.name, why: 'That account cannot be removed from here.' };
}

/** An entry under Finish setup: a placeholder is dropped, an imported pool is forgotten (the router is untouched). */
async function setupEntry(app, entry) {
  if (entry.source === 'placeholder') { const r = require('./migrate').finish(entry.id); refresh(app); return { ok: r.ok, id: entry.id, name: entry.name, why: r.why }; }
  if (entry.source === 'pool') { const d = require('../ninerouter').detach(app, String(entry.id).slice(String(entry.id).lastIndexOf(':') + 1)); refresh(app); return { ok: d.ok, id: entry.id, name: entry.name, why: d.why }; }
  if (entry.instanceId) return one(app, { id: entry.id, instanceId: entry.instanceId, ownership: entry.ownership, name: entry.name }, 'detach');
  return { ok: false, id: entry.id, name: entry.name, why: 'unknown setup entry' };
}

/**
 * DETACH ALL (or sign out all LAIN-owned) for one provider. Accounts in use are SKIPPED and reported — the rest go.
 * `signOut` acts ONLY on LAIN-owned accounts (sign out, then remove the profile LAIN made); an external profile is left exactly as it is.
 */
async function all(app, familyId, { signOut = false, includeSetup = true } = {}) {
  const f = require('./index').family(app, familyId);
  if (!f) return { ok: false, why: 'no such provider' };
  const results = [];
  for (const a of f.accounts) {
    // SIGN OUT ALL acts on what LAIN made and nothing else: the person's own profiles are not touched at all (not even detached).
    if (signOut && a.ownership !== 'lain') continue;
    const mode = signOut ? 'remove-profile' : 'detach';
    // eslint-disable-next-line no-await-in-loop -- one account at a time, each its own act
    results.push(await one(app, { id: a.id, instanceId: a.instanceId, ownership: a.ownership, name: a.name, family: f.id }, mode));
  }
  if (includeSetup && !signOut) for (const p of f.setup) results.push(await setupEntry(app, p));   // eslint-disable-line no-await-in-loop
  const skipped = results.filter((r) => r.busy);
  return { ok: true, results, removed: results.filter((r) => r.ok).length, skipped: skipped.map((r) => ({ id: r.id, name: r.name, usedBy: r.usedBy })), failed: results.filter((r) => !r.ok && !r.busy) };
}

module.exports = { one, setupEntry, all, inUse, usedBy, isDefaultRuntime };
