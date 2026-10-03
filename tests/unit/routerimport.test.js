'use strict';

/**
 * IMPORT FROM A ROUTER INSTALLED ON THIS PC (§16–§18, 2026-09-29) — against
 * FIXTURE databases shaped like 9Router's and OmniRoute's (the layouts the
 * person's own router imports from). No real router, account or token is used.
 *
 *   9Router    codex (portable)        → migrated, no sign-in, verified by Codex
 *              claude (portable)       → migrated, no sign-in, verified by Anthropic
 *              antigravity             → re-auth: bound to the app that requested it
 *              github-copilot          → unsupported: LAIN has no runtime for it
 *              codex without id token  → re-auth: Codex needs it
 *   OmniRoute  codex, token encrypted  → re-auth: encrypted to its own app
 *              claude, expired, no rt  → re-auth: expired
 *
 * and: the preview carries no token; the router's files are never written; after
 * migration the account is "Codex · Personal", with the router kept as provenance.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { test, tmpdir } = require('../helpers');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
const CODEX = 'app_EMoamEEZ73f0CkXaXp7hrann';
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

module.exports = async function () {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { await test('ROUTER IMPORT: skipped — this Node has no node:sqlite', () => {}); return; }
  const { App } = require('../../src/app');
  const fx = require('../harness/fabricfixtures');
  const M = require('../../src/fabric/migrate');
  const ai = require('../../src/accountinstances');
  const out = { write() {}, on() {}, columns: 100, rows: 30, isTTY: false };

  const dir = tmpdir('routerimp-');
  // ---- FIXTURE: 9Router's providerConnections ----------------------------------------------------------
  const nine = path.join(dir, '9router', 'db', 'data.sqlite');
  fs.mkdirSync(path.dirname(nine), { recursive: true });
  const n = new DatabaseSync(nine);
  n.exec('CREATE TABLE providerConnections (id TEXT, provider TEXT, authType TEXT, name TEXT, email TEXT, priority INTEGER, isActive INTEGER, data TEXT, createdAt TEXT, updatedAt TEXT)');
  const put9 = n.prepare('INSERT INTO providerConnections (id, provider, authType, name, email, isActive, data) VALUES (?,?,?,?,?,1,?)');
  put9.run('n1', 'codex', 'oauth', 'Personal', 'ada@example.com', JSON.stringify({ accessToken: jwt({ client_id: CODEX, exp: Math.floor(Date.now() / 1000) + 3600 }), refreshToken: 'rt-codex-fixture', idToken: jwt({ aud: CODEX, email: 'ada@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }), providerSpecificData: { chatgptAccountId: 'acct-ada' } }));
  put9.run('n2', 'claude', 'oauth', 'Work', 'bee@example.com', JSON.stringify({ accessToken: 'sk-ant-oat01-fixture-bee', refreshToken: 'sk-ant-ort01-fixture-bee', expiresAt: Date.now() + 3600e3, scope: 'user:inference user:profile' }));
  put9.run('n3', 'agy', 'oauth', 'Google', 'cee@example.com', JSON.stringify({ accessToken: 'ya29.fixture', refreshToken: '1//fixture' }));
  put9.run('n4', 'github', 'oauth', 'Copilot', 'dee@example.com', JSON.stringify({ accessToken: 'gho_fixture' }));
  put9.run('n5', 'codex', 'oauth', 'NoId', 'eve@example.com', JSON.stringify({ accessToken: jwt({ client_id: CODEX }), refreshToken: 'rt-noid' }));
  n.close();
  // ---- FIXTURE: OmniRoute's provider_connections ---------------------------------------------------------
  const omni = path.join(dir, '.omniroute', 'storage.sqlite');
  fs.mkdirSync(path.dirname(omni), { recursive: true });
  const o = new DatabaseSync(omni);
  o.exec('CREATE TABLE provider_connections (id TEXT, provider TEXT, auth_type TEXT, name TEXT, email TEXT, is_active INTEGER, access_token TEXT, refresh_token TEXT, id_token TEXT, api_key TEXT, expires_at TEXT, token_expires_at TEXT, scope TEXT, provider_specific_data TEXT)');
  const putO = o.prepare('INSERT INTO provider_connections (id, provider, auth_type, name, email, is_active, access_token, refresh_token, id_token, expires_at) VALUES (?,?,?,?,?,1,?,?,?,?)');
  putO.run('o1', 'codex', 'oauth', 'Sealed', 'fay@example.com', 'v1:9f3a:aGVsbG8=', 'v1:9f3a:d29ybGQ=', null, null);
  putO.run('o2', 'claude', 'oauth', 'Old', 'gus@example.com', 'sk-ant-oat01-fixture-old', '', null, String(Date.now() - 86400e3));
  o.close();
  const paths = { '9router': nine, omniroute: omni };
  const before = [hash(nine), hash(omni)];

  // THE CLAUDE VERIFICATION is Claude Code's own `get_usage` (the fake answers it, and refuses a "not-accepted" token).

  const app = new App({ out, interactive: false, cwd: dir });
  app.cfg.accounts = { ...(app.cfg.accounts || {}), codex: { binary: { command: process.execPath, args: [fx.FAKE_CODEX] } } };
  await fx.claudeRuntime(app, dir);

  try {
    await test('ROUTER IMPORT: every row of both routers is classified from what it actually holds — and the preview holds no token', () => {
      const d = M.discover(app, { routerPaths: paths });
      const who = Object.fromEntries(d.plan.map((p) => [p.identity, p]));
      const c = (e) => [who[e].authClass, who[e].action];
      assert.deepStrictEqual(c('ad•••@example.com'), ['PORTABLE_AUTH', 'migrate']);
      assert.deepStrictEqual(c('be•••@example.com'), ['PORTABLE_AUTH', 'migrate']);
      assert.deepStrictEqual(c('ce•••@example.com'), ['REAUTH_REQUIRED', 'reauth']);
      assert.match(who['ce•••@example.com'].reason, /bound to the application that requested it/);
      assert.deepStrictEqual(c('de•••@example.com'), ['UNSUPPORTED', 'unsupported']);
      assert.match(who['ev•••@example.com'].reason, /no id token/);
      assert.match(who['fa•••@example.com'].reason, /encrypted to its own app/);
      assert.match(who['gu•••@example.com'].reason, /no refresh token|expired/);
      assert.deepStrictEqual(d.routers.map((r) => r.label).sort(), ['9Router', 'OmniRoute']);
      const shown = JSON.stringify(d.plan);
      for (const secret of ['rt-codex-fixture', 'sk-ant-oat01-fixture-bee', 'sk-ant-ort01', 'ya29.fixture', 'gho_fixture', 'v1:9f3a']) assert.ok(!shown.includes(secret), `the preview never carries ${secret}`);
    });

    await test('ROUTER IMPORT: apply — Codex and Claude migrate WITHOUT a sign-in and are verified by their providers; the router is never written', async () => {
      const d = M.discover(app, { routerPaths: paths });
      const want = d.found.filter((x) => ['ada@example.com', 'bee@example.com', 'cee@example.com'].includes(x.identity));
      const r = await M.apply(app, want);
      const by = Object.fromEntries(want.map((x, i) => [x.identity, r.results[i]]));
      assert.strictEqual(by['ada@example.com'].result, 'migrated', JSON.stringify(by['ada@example.com']));
      assert.strictEqual(by['bee@example.com'].result, 'migrated', JSON.stringify(by['bee@example.com']));
      assert.strictEqual(by['cee@example.com'].result, 'reauth-required');
      const A = ai.get(app, by['ada@example.com'].account);
      assert.deepStrictEqual([A.authentication_state, A.identity.email], ['AUTHENTICATED', 'ada@example.com']);
      assert.strictEqual(ai.record(A.id).config.home_mode, 'direct', 'a NEW LAIN-owned Codex home — nothing shared, nothing existing touched');
      assert.deepStrictEqual([hash(nine), hash(omni)], before, 'the router databases are unchanged');
      // THE ROUTER IS PROVENANCE ONLY: the account reads as the person named it, never "9Router Codex".
      require('../../src/appcatalog').invalidate(); app._acctMemo = null; app._catMemo = null; app._fabricMemo = null;
      const names = require('../../src/fabric/index').families(app).flatMap((f) => f.accounts.map((a) => a.name));
      assert.ok(!names.some((x) => /9router|omniroute/i.test(x)), names.join(', '));
    });

    await test('ROUTER IMPORT: a Claude sign-in Anthropic refuses is removed again and waits with the refusal', async () => {
      const d = M.discover(app, { routerPaths: paths });
      const bee = d.found.find((x) => x.identity === 'bee@example.com');
      const forged = { ...bee, key: `${bee.key}:forged`, identity: 'zed@example.com', credential: { ...bee.credential, data: { claudeAiOauth: { ...bee.credential.data.claudeAiOauth, accessToken: 'sk-ant-oat01-not-accepted' } } } };
      const n0 = ai.records().length;
      const r = await M.apply(app, [forged]);
      assert.strictEqual(r.results[0].result, 'reauth-required');
      assert.match(r.results[0].reason, /did not accept the migrated sign-in \(Anthropic refused this sign-in\)/);
      assert.strictEqual(ai.records().length, n0);
    });

    await test('ROUTER IMPORT: under test isolation the REAL router paths are never opened', () => {
      assert.deepStrictEqual(require('../../src/fabric/routerimport').defaultPaths(), { '9router': null, omniroute: null });
    });
  } finally {
    await fx.reset();
  }
};
