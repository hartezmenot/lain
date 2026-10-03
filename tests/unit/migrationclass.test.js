'use strict';

/**
 * MIGRATION ACCEPTANCE (§54, 2026-09-29) — a fixture router export holds four accounts:
 *
 *   A  a portable, authenticated Codex sign-in (the Codex CLI's own auth.json shape,
 *      issued to the Codex CLI's client, renewable)           → migrated, NO sign-in
 *   B  a Claude profile directory on this PC                   → adopted where it is, NO sign-in
 *   C  an Antigravity sign-in encrypted to the router's app    → re-authentication, with the reason
 *   D  metadata only (which Codex account, no credential)     → re-authentication
 *
 * and, beside them, the edges a real source produces: a token issued to another
 * application's OAuth client, a sign-in with no refresh token, Z.ai (API-only in
 * LAIN), a provider LAIN has no runtime for, and a portable sign-in the provider
 * REFUSES at verification (removed again, never left half-made).
 *
 * Only fakes run: the fake Codex app-server and a fake `claude` read the same files
 * the real ones do. No real credential exists anywhere in this test.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A structurally real (unsigned, fake) JWT — the fakes read its claims as the real CLI would. */
const jwt = (claims) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.sig`;
const CODEX_CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann';
const codexAuth = ({ email, aud = CODEX_CLIENT, refresh = 'rt-fixture-not-real', exp = Math.floor(Date.now() / 1000) + 3600 }) => ({
  format: 'codex-auth-json',
  data: { OPENAI_API_KEY: null, tokens: { id_token: jwt({ iss: 'https://auth.openai.com', aud, email, exp, 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acct-fixture' } }), access_token: jwt({ aud, exp }), refresh_token: refresh, account_id: 'acct-fixture' }, last_refresh: new Date().toISOString() },
});

module.exports = async function () {
  const { App } = require('../../src/app');
  const fx = require('../harness/fabricfixtures');
  const M = require('../../src/fabric/migrate');
  const store = require('../../src/fabric/store');
  const ai = require('../../src/accountinstances');
  const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };

  const dir = tmpdir('migclass-');
  const app = new App({ out, interactive: false, cwd: dir });
  // THE FAKES — the same binaries the connected-account fixtures use.
  app.cfg.accounts = { ...(app.cfg.accounts || {}), codex: { binary: { command: process.execPath, args: [path.join(__dirname, '..', 'fixtures', 'codex', 'fakeappserver.js')] } } };
  await fx.claudeRuntime(app, dir);
  // B's PROFILE ON THIS PC: Claude Code's own directory, signed in (the fake reads `.credentials.json`).
  const claudeHome = path.join(dir, 'existing-claude');
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({ email: 'bee@example.com', subscriptionType: 'max', claudeAiOauth: { accessToken: 'at-fixture', refreshToken: 'rt-fixture', expiresAt: Date.now() + 3600e3 } }));

  const exportFile = path.join(dir, 'router-export.json');
  fs.writeFileSync(exportFile, JSON.stringify({
    source: 'Router fixture',
    accounts: [
      { family: 'codex', kind: 'oauth', identity: 'ada@example.com', label: 'Personal', credential: codexAuth({ email: 'ada@example.com' }) },       // A
      { family: 'claude', kind: 'oauth', identity: 'bee@example.com', label: 'Work', profileDir: claudeHome },                                      // B
      { family: 'antigravity', kind: 'oauth', identity: 'cee@example.com', credential: { encrypted: true } },                                       // C
      { family: 'codex', kind: 'oauth', identity: 'dee@example.com' },                                                                                // D
      { family: 'codex', kind: 'oauth', identity: 'eve@example.com', credential: codexAuth({ email: 'eve@example.com', aud: 'app_router_own_client' }) },   // another client's token
      { family: 'codex', kind: 'oauth', identity: 'fay@example.com', credential: codexAuth({ email: 'fay@example.com', refresh: '', exp: 1 }) },            // expired, no refresh
      { family: 'zai', kind: 'oauth', identity: 'gus@example.com' },
      { family: 'kiro', kind: 'oauth', identity: 'hal@example.com' },
    ],
  }));

  await test('MIGRATION §54: every account is classified from what the source actually holds — with the reason', async () => {
    const d = M.discover(app, { exportFile });
    assert.strictEqual(d.exportError, null);
    const byWho = Object.fromEntries(d.plan.map((p) => [p.identity, p]));
    const cls = (who) => [byWho[who].authClass, byWho[who].action];
    assert.deepStrictEqual(cls('ad•••@example.com'), ['PORTABLE_AUTH', 'migrate'], 'A moves');
    assert.deepStrictEqual(cls('be•••@example.com'), ['NATIVE_PROFILE_REFERENCE', 'adopt'], 'B is used where it is');
    assert.deepStrictEqual(cls('ce•••@example.com'), ['REAUTH_REQUIRED', 'reauth'], 'C cannot be exported');
    assert.match(byWho['ce•••@example.com'].reason, /encrypted to its own app/);
    assert.deepStrictEqual(cls('de•••@example.com'), ['REAUTH_REQUIRED', 'reauth'], 'D is metadata only');
    assert.match(byWho['de•••@example.com'].reason, /only account metadata/);
    assert.match(byWho['ev•••@example.com'].reason, /another application's OAuth client \(app_router_own_client\)/);
    assert.match(byWho['fa•••@example.com'].reason, /expired/);
    assert.deepStrictEqual(cls('gu•••@example.com'), ['UNSUPPORTED', 'unsupported']);
    assert.match(byWho['gu•••@example.com'].reason, /through its API/);
    assert.deepStrictEqual(cls('ha•••@example.com'), ['UNSUPPORTED', 'unsupported']);
    // A and B need NO sign-in; the plan says so.
    assert.deepStrictEqual(d.plan.filter((p) => !p.signInNeeded).map((p) => p.identity).sort(), ['ad•••@example.com', 'be•••@example.com', 'gu•••@example.com', 'ha•••@example.com'].sort());
  });

  await test('MIGRATION §54: apply — A migrated and verified, B adopted and verified, C/D waiting with reasons; nothing asked to sign in again', async () => {
    const before = ai.records().length;
    const d = M.discover(app, { exportFile });
    const r = await M.apply(app, d.found);
    const res = Object.fromEntries(d.found.map((x, i) => [x.identity, r.results[i]]));
    assert.strictEqual(res['ada@example.com'].result, 'migrated', JSON.stringify(res['ada@example.com']));
    assert.strictEqual(res['bee@example.com'].result, 'connected', JSON.stringify(res['bee@example.com']));
    assert.strictEqual(res['cee@example.com'].result, 'reauth-required');
    assert.strictEqual(res['dee@example.com'].result, 'reauth-required');
    assert.strictEqual(res['gus@example.com'].result, 'unsupported');
    // VERIFIED BY THE PROVIDER'S OWN STATUS READ — not assumed.
    const A = ai.get(app, res['ada@example.com'].account);
    assert.strictEqual(A.authentication_state, 'AUTHENTICATED');
    assert.strictEqual(A.identity.email, 'ada@example.com');
    const B = ai.get(app, res['bee@example.com'].account);
    assert.strictEqual(B.identity.email, 'bee@example.com');
    // B IS THE PERSON'S OWN PROFILE, used where it is: registered external_native, never copied.
    assert.strictEqual(path.resolve(B.config_home || (ai.record(B.id).config || {}).home), path.resolve(claudeHome));
    assert.strictEqual((ai.record(B.id).config || {}).ownership, 'external_native');
    assert.strictEqual(ai.records().length, before + 2, 'exactly two new accounts');
    // C AND D WAIT, with the reason on the placeholder (the Setup page shows it).
    const ph = Object.values(store.placeholders());
    const C = ph.find((p) => p.identityHint === 'cee@example.com');
    assert.deepStrictEqual([C.state, C.authClass], ['REAUTH_REQUIRED', 'REAUTH_REQUIRED']);
    assert.match(C.reason, /encrypted/);
    // THE SOURCE IS PROVENANCE ONLY — never a brand in the account's name.
    const acct = require('../../src/accountcatalog').list(app).accounts.find((a) => a.instanceId === A.id || a.id === A.id);
    assert.ok(acct && !/router/i.test(acct.name), `named ${acct && acct.name}`);
  });

  await test('MIGRATION: a portable sign-in the PROVIDER refuses is removed again — never left half-made — and waits with the refusal', async () => {
    // Structurally portable (Codex client, renewable), but the fake Codex rejects it: an id_token with no claims it can read.
    const bad = { format: 'codex-auth-json', data: { tokens: { id_token: 'not-a-jwt', access_token: 'x', refresh_token: 'rt', account_id: 'a' } } };
    const f = path.join(dir, 'refused.json');
    fs.writeFileSync(f, JSON.stringify({ source: 'Router fixture', accounts: [{ family: 'codex', kind: 'oauth', identity: 'ivy@example.com', credential: bad }] }));
    const before = ai.records().length;
    const d = M.discover(app, { exportFile: f });
    assert.strictEqual(d.plan[0].authClass, 'PORTABLE_AUTH');
    const r = await M.apply(app, d.found);
    assert.strictEqual(r.results[0].result, 'reauth-required');
    assert.match(r.results[0].reason, /did not accept the migrated sign-in/);
    assert.strictEqual(ai.records().length, before, 'the half-made account was removed');
  });

  // THE FAKE APP-SERVERS the migrated accounts started are stopped, or the runner waits on them (lain-test-isolation).
  await fx.reset();
};
