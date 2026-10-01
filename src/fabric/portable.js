'use strict';

/**
 * A SIGN-IN THAT CAN MOVE — migration's PORTABLE_AUTH, per provider (2026-09-29).
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS. Every imported OAuth account used to become "Sign in again
 * to finish migration", even when the source held a complete sign-in in the
 * provider's own format — one the provider's own CLI accepts from any home.
 * That made people sign in to accounts they had already signed in to.
 *
 * So an exported credential is ASSESSED against the one format each official
 * CLI reads, and only then installed:
 *
 *   Codex    `auth.json` (tokens.id_token / access_token / refresh_token /
 *            account_id). Portable when it can be renewed (a refresh token)
 *            and it was issued to the Codex CLI's own public OAuth client —
 *            the client the Codex binary LAIN runs is. A token issued to
 *            another application's client stays that application's.
 *   Claude   Claude Code's `.credentials.json` (claudeAiOauth with a refresh
 *            token). Portable into a Claude Code configuration directory.
 *   Google   (Antigravity) — never portable: a Google refresh token is bound
 *            to the OAuth client that requested it, and Antigravity signs in
 *            with its own.
 *
 * ------------------------------------------------------------------------
 * INSTALLING NEVER TOUCHES AN EXISTING PROFILE (the auth-isolation invariant).
 * A portable sign-in goes into a NEW LAIN-owned directory — a fresh Codex home
 * or a fresh Claude configuration directory under LAIN's accounts folder —
 * written by this process with the user-only permissions of LAIN's config
 * home. Then the PROVIDER is asked who it is (a status read, never a model
 * request). Only an answer that names a signed-in account makes it CONNECTED;
 * anything else removes the directory LAIN just made and leaves the account
 * waiting for a fresh sign-in, with the provider's refusal as the reason.
 *
 * Nothing here reads another program's credential store. The credential comes
 * from an export the person chose (migrate.js fromExport).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** The Codex CLI's public OAuth client (chatgptauth.js BORROWED) — the Codex binary's, never LAIN's own. */
const CODEX_CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** The payload of a JWT, for its issuer / audience / expiry only. Never verified here — the provider verifies. */
function claims(jwt) {
  try {
    const p = String(jwt || '').split('.');
    if (p.length !== 3) return null;
    return JSON.parse(Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
}

const REASON = Object.freeze({
  metadata: () => 'the source exposes only account metadata (which provider, which account) — not a sign-in Noema can use',
  'app-bound': () => 'the source keeps this sign-in encrypted to its own app — it cannot be exported',
  'no-refresh': () => 'the exported sign-in has no refresh token — once it expires it cannot be renewed',
  expired: () => 'the exported sign-in has expired and cannot be renewed',
  'other-client': (x) => `the sign-in was issued to another application's OAuth client${x.client ? ` (${x.client})` : ''} — the provider will not accept it from Noema`,
  'google-bound': () => 'a Google sign-in is bound to the application that requested it; Antigravity signs in with its own',
  'unknown-format': () => 'the credential is in a format Noema does not recognise',
  'no-id-token': () => 'the source keeps no id token, which Codex needs to recognise the sign-in',
  'provider-oauth': () => 'Noema has no runtime that can take this provider\'s sign-in',
  rejected: (x) => `the provider did not accept the migrated sign-in${x.why ? ` (${x.why})` : ''}`,
});
function reasonText(r) { const f = REASON[r && r.reason]; return f ? f(r) : String((r && r.reason) || ''); }

/**
 * CAN THIS EXPORTED CREDENTIAL MOVE AS IT IS? Pure.
 * @returns {{ portable: true } | { portable: false, reason: string, client?: string }}
 */
function assess(family, cred) {
  if (!cred || typeof cred !== 'object') return { portable: false, reason: 'metadata' };
  if (cred.encrypted || cred.appBound) return { portable: false, reason: 'app-bound' };
  if (family === 'codex') {
    const t = cred.format === 'codex-auth-json' && cred.data && cred.data.tokens;
    if (!t) return { portable: false, reason: 'unknown-format' };
    if (!t.refresh_token) {
      const c = claims(t.access_token);
      return { portable: false, reason: c && c.exp && c.exp * 1000 < Date.now() ? 'expired' : 'no-refresh' };
    }
    const c = claims(t.id_token || t.access_token);
    const aud = c ? [].concat(c.aud || [], c.client_id || []).map(String) : [];
    if (aud.length && !aud.includes(CODEX_CLIENT)) return { portable: false, reason: 'other-client', client: aud[0] };
    // CODEX READS ITS ACCOUNT FROM THE ID TOKEN: an auth.json without one does not sign Codex in.
    if (!t.id_token) return { portable: false, reason: 'no-id-token' };
    return { portable: true };
  }
  if (family === 'claude') {
    const o = cred.format === 'claude-credentials' && cred.data && cred.data.claudeAiOauth;
    if (!o) return { portable: false, reason: 'unknown-format' };
    if (!o.refreshToken) return { portable: false, reason: o.expiresAt && Number(o.expiresAt) < Date.now() ? 'expired' : 'no-refresh' };
    if (cred.clientId && String(cred.clientId) !== 'claude-code') return { portable: false, reason: 'other-client', client: String(cred.clientId) };
    return { portable: true };
  }
  if (family === 'antigravity') return { portable: false, reason: 'google-bound' };
  if (cred.format === 'provider-oauth') return { portable: false, reason: 'provider-oauth' };
  return { portable: false, reason: 'unknown-format' };
}

/** Write a credential file LAIN made, readable by this user only (the config home's own ACL on Windows). */
function writePrivate(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * INSTALL A PORTABLE SIGN-IN into a NEW LAIN-owned profile and verify it with the provider (no inference).
 * @returns {{ ok: true, id, identity } | { ok: false, reason: 'rejected', why }}
 */
async function install(app, family, cred, { name = '' } = {}) {
  const ai = require('../accountinstances');
  let id = null;
  try {
    if (family === 'codex') {
      const r = ai.add(app, { driver_id: 'codex', display_name: name, config: { home_mode: 'direct' } });
      if (!r.ok) return { ok: false, reason: 'rejected', why: r.why };
      id = r.instance.id;
      const home = require('../drivers/codexhome').layout(id, { home_mode: 'direct' }).home;
      writePrivate(path.join(home, 'auth.json'), JSON.stringify(cred.data, null, 2));
    } else if (family === 'claude') {
      const ca = require('../drivers/claudeaccount');
      const want = `claude-${crypto.randomBytes(3).toString('hex')}`;
      const r = ai.add(app, { driver_id: ca.ID, id: want, display_name: name, config: { home: ca.homeFor(want), ownership: 'lain' } });
      if (!r.ok) return { ok: false, reason: 'rejected', why: r.why };
      id = r.instance.id;
      writePrivate(path.join(ca.homeFor(id), '.credentials.json'), JSON.stringify(cred.data, null, 2));
    } else {
      return { ok: false, reason: 'unknown-format' };
    }
    // THE PROVIDER SAYS WHO IT IS — or refuses. Only a signed-in answer is CONNECTED.
    const v = await ai.refresh(app, id);
    const inst = v && v.instance;
    const signedIn = inst && /AUTHENTICATED|SIGNED_IN/i.test(String(inst.authentication_state || ''));
    const drop = async (why) => { await ai.disconnect(app, id, { logout: false, removeProfile: true }).catch(() => null); return { ok: false, reason: 'rejected', why: String(why).slice(0, 160) }; };
    if (!signedIn) return drop((v && v.why) || (inst && (inst.error || inst.authentication_state)) || 'no signed-in account');
    // CLAUDE CODE'S `auth status` READS ITS OWN FILE: Anthropic itself must accept the sign-in (a status read, no model).
    if (family === 'claude') {
      const who = await require('./quotaread').claudeIdentity(require('../drivers/claudeaccount').homeFor(id));
      if (!who.ok) return drop(who.why);
      return { ok: true, id, identity: { ...(inst.identity || {}), ...(who.identity.email ? { email: who.identity.email } : {}) } };
    }
    return { ok: true, id, identity: inst.identity || null };
  } catch (e) {
    if (id) await require('../accountinstances').disconnect(app, id, { logout: false, removeProfile: true }).catch(() => null);
    return { ok: false, reason: 'rejected', why: String((e && e.message) || e).slice(0, 160) };
  }
}

module.exports = { assess, install, reasonText, claims, CODEX_CLIENT };
