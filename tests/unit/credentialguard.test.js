'use strict';

/**
 * THE SECRET DOES NOT TRAVEL — architecture guards for credential references.
 *
 * STATIC: the code paths a secret could leak through do not touch one.
 *   · only connections.js resolves a credential reference (the transport side)
 *   · only the transport and its owners read `.apiKey`
 *   · only credentials.js reads the OS secret store
 *
 * DYNAMIC: a known fake key, stored by reference, is present exactly where a
 * request is built and nowhere a person, a model or a log would read it —
 * account listings, the window's projections and routes, the system prompt,
 * the tool schemas, LAIN's self-knowledge tool, the harness state.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const SRC = path.join(__dirname, '..', '..', 'src');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');
// Comments may name the field; code may not. Strip block and line comments.
const code = (p) => fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

module.exports = async function () {
  const files = walk(SRC);

  await test('GUARD: only the transport resolves a credential reference', () => {
    const callers = files.filter((f) => /credentials'\)\.resolve\(|\bcreds\.resolve\(/.test(code(f))).map(rel);
    // keymigration.js reads a freshly stored key back ONCE to verify it before config forgets the plaintext (Security › Migrate).
    // github.js is the GitHub transport: it resolves the token only to build a GitHub API request or git's HTTP header (Phase 8).
    // mcpclient.js is a transport too (Phase 8.1): an MCP server's token is resolved as its request is sent.
    // serve.js resolves LAIN's OWN local access token to check a client's request (Phase 8.1) —
    // never a provider key; the provider key is resolved by the transport it then calls.
    assert.deepStrictEqual(callers, ['connections.js', 'github.js', 'keymigration.js', 'mcpclient.js', 'serve.js'], callers.join(', '));
  });

  await test('GUARD: `.apiKey` is read only by the transport and the owners that store or mask it', () => {
    // fabric/routerimport.js (2026-09-29) is a MIGRATION SOURCE: it reads a router row's own `apiKey` column only to hand
    // it to accountops.addKey (verified, then kept in the secret store); the key stays in Core memory behind a one-time
    // token and never reaches the window (tests/unit/routerimport.test.js pins that the preview carries no key).
    const ALLOWED = new Set(['connections.js', 'provider.js', 'responsesapi.js', 'catalogstate.js', 'redact.js', 'diagnose.js', 'apicommand.js', 'accountinstances.js', 'keymigration.js', 'fabric/routerimport.js']);
    const readers = files.filter((f) => /\.apiKey\b/.test(code(f))).map(rel).filter((f) => !ALLOWED.has(f));
    assert.deepStrictEqual(readers, [], `unexpected readers of a key: ${readers.join(', ')}`);
    for (const dir of ['tools/', 'bot/', 'harnessapp/', 'drivers/']) {
      assert.ok(!files.map(rel).some((f) => f.startsWith(dir) && /\.apiKey\b/.test(code(path.join(SRC, f)))), `${dir} touches a key`);
    }
  });

  await test('GUARD: only credentials.js opens the OS secret store', () => {
    const users = files.filter((f) => /require\('\.\.?\/secretstore'\)/.test(code(f))).map(rel).sort();
    assert.deepStrictEqual(users, ['credentials.js']);
  });

  await test('GUARD: a stored key reaches the request and nothing a person, model or log reads', async () => {
    const creds = require('../../src/credentials');
    creds.useBackend(creds.memoryBackend());
    const SECRET = 'sk-guard-5f0c1e9d8b7a6c5d4e3f2a1b0c9d8e7f';
    try {
      const { App } = require('../../src/app');
      const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('guard-') });
      const ref = creds.ref('lain:guardprov-abc123');
      assert.ok(creds.store(ref, SECRET).ok);
      app.cfg.connections = { ...(app.cfg.connections || {}), 'lain:guardprov': { provider: 'guardprov', via: 'native', auth: 'api_key', protocol: 'chat', baseUrl: 'https://guard.invalid/v1', credentialRef: ref, models: ['guard-model'] } };
      const conn = app.connections().find((c) => c.id === 'lain:guardprov');
      assert.strictEqual(conn.apiKey, SECRET, 'the transport gets the key');
      assert.ok(!JSON.stringify(app.cfg).includes(SECRET), 'config names it, never holds it');

      const surfaces = {
        'account instances': require('../../src/accountinstances').list(app),
        'window: accounts': await require('../../src/harnessapp/accounts').read(app),
        'route: /api/instances': (await require('../../src/harnessapp/instanceroutes').ROUTES['POST /api/instances'](app, {})).body,
        'system prompt': app.systemPrompt(),
        'tool schemas': require('../../src/tools').schemas(app),
        'self-knowledge: providers': await require('../../src/tools').execute('lain_workspace', { action: 'describe', topic: 'all' }, { app, session: app.session, cwd: app.session.cwd }),
        'harness state': await require('../../src/harnessapp/state').read(app),
        'credential describe': creds.describe(ref),
      };
      for (const [name, value] of Object.entries(surfaces)) {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        assert.ok(!text.includes(SECRET), `${name} carries the key`);
        assert.ok(!text.includes(SECRET.slice(8, 28)), `${name} carries part of the key`);
      }
      const row = surfaces['account instances'].find((r) => r.id === 'lain:guardprov');
      assert.strictEqual(row.credential_ref, ref, 'the reference is what is shown');
      assert.strictEqual(row.credential.masked, '••••8e7f');
      assert.ok(creds.leaks({ x: SECRET }) && !creds.leaks(surfaces['account instances']));
    } finally { creds.useBackend(null); }
  });
};
