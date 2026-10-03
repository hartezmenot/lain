'use strict';

/**
 * ANTIGRAVITY OVER HTTPS (2026-10-01) — account management and execution with NO runtime download.
 *
 * A fake Google (OAuth token endpoint, userinfo, Cloud Code v1internal) stands in for the network; the real sign-in
 * session, credential store (memory backend), account registry, fabric and turn-shaped execution run unchanged.
 * Proves: the browser round trip and `state` check; refresh; identity/project/models/quota from the provider's own
 * answers (absent ≠ exhausted, families kept apart, REMAINING semantics); a tool-call round trip through
 * generateContent; and that no ACP binary is needed for any of it.
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { test, tmpdir } = require('../helpers');

function fakeGoogle() {
  const seen = [];
  const state = { tokens: 0, refreshes: 0, quota: null, lastEnvelope: null, accessExpired: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      seen.push({ path: u.pathname, auth: req.headers.authorization || null, body });
      const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (u.pathname === '/token') {
        const f = new URLSearchParams(body);
        if (f.get('grant_type') === 'authorization_code') {
          if (f.get('code') !== 'good-code' || !f.get('code_verifier') || !f.get('client_id')) return json(400, { error: 'invalid_grant' });
          state.tokens += 1;
          return json(200, { access_token: `at-${state.tokens}`, refresh_token: 'rt-1', expires_in: state.accessExpired ? 1 : 3600, scope: 'x' });
        }
        if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'rt-1') { state.refreshes += 1; return json(200, { access_token: `at-r${state.refreshes}`, expires_in: 3600 }); }
        return json(400, { error: 'invalid_grant' });
      }
      if (!bearer) return json(401, { error: { message: 'no token' } });
      if (u.pathname === '/oauth2/v1/userinfo') return json(200, { email: 'ella@example.com', name: 'Ella', id: '42' });
      if (u.pathname === '/v1internal:loadCodeAssist') return json(200, { cloudaicompanionProject: 'proj-123', currentTier: { id: 'free-tier', name: 'Free' }, paidTier: { id: 'g1', name: 'Antigravity Starter Quota' } });
      if (u.pathname === '/v1internal:fetchAvailableModels') return json(200, { models: { 'gemini-3-pro': { displayName: 'Gemini 3 Pro' }, 'claude-sonnet-4-6': {}, 'old-model': { disabled: true } } });
      if (u.pathname === '/v1internal:retrieveUserQuotaSummary') {
        return json(200, state.quota || { groups: [
          { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.74, resetTime: '2026-10-08T09:00:00Z' }] },
          { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0 }, { bucketId: 'x', window: 'weekly' }] },
        ] });
      }
      if (u.pathname === '/v1internal:generateContent') {
        const env = JSON.parse(body); state.lastEnvelope = env;
        const contents = env.request.contents;
        const last = contents[contents.length - 1];
        const answered = last.parts.some((p) => p.functionResponse);
        if (!answered && env.request.tools) return json(200, { response: { candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8, thoughtsTokenCount: 5 } } });
        return json(200, { response: { candidates: [{ content: { parts: [{ text: 'planning', thought: true }, { text: 'alpha' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 100 } } });
      }
      return json(404, { error: { message: 'unknown' } });
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${server.address().port}`, seen, state, close: () => new Promise((c) => { server.closeAllConnections(); server.close(c); }) })));
}

/** Play the browser: follow the auth URL's redirect_uri with a code (and the state LAIN sent, unless told otherwise). */
async function browser(url, { code = 'good-code', state = null } = {}) {
  const u = new URL(url);
  const back = new URL(u.searchParams.get('redirect_uri'));
  back.searchParams.set('code', code);
  back.searchParams.set('state', state || u.searchParams.get('state'));
  const r = await fetch(back.toString());
  return r.text();
}

module.exports = async function () {
  const creds = require('../../src/credentials');
  const api = require('../../src/drivers/antigravityapi');
  const saved = { base: process.env.LAIN_ANTIGRAVITY_BASE, cfg: process.env.LAIN_CONFIG_DIR };
  const g = await fakeGoogle();
  process.env.LAIN_ANTIGRAVITY_BASE = g.base;
  process.env.LAIN_CONFIG_DIR = tmpdir('agy-https-cfg-');
  creds.useBackend(creds.memoryBackend());
  try {
    await test('ANTIGRAVITY HTTPS: sign-in is a loopback OAuth round trip with PKCE — and a foreign `state` is refused', async () => {
      const login = await api.beginLogin({ timeoutMs: 10000 });
      const u = new URL(login.url);
      assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
      assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
      assert.match(u.searchParams.get('scope'), /cloud-platform/);
      const refused = await browser(login.url, { state: 'not-ours' });
      assert.match(refused, /refused/i, 'a response that did not belong to this sign-in is refused');
      await browser(login.url);
      const t = await login.done;
      assert.ok(t.access_token && t.refresh_token && t.expires_at > Date.now());
    });

    await test('ANTIGRAVITY HTTPS: identity, project, plan, models and quota are the provider\'s own answers', async () => {
      const d = await api.describeAccount('at-x');
      assert.strictEqual(d.identity.email, 'ella@example.com');
      assert.strictEqual(d.project, 'proj-123');
      assert.strictEqual(d.plan, 'Antigravity Starter Quota');
      assert.deepStrictEqual(d.models.map((m) => m.id), ['gemini-3-pro', 'claude-sonnet-4-6'], 'a disabled model is not offered');
      const w = d.quota.windows;
      assert.strictEqual(w.length, 2, 'a bucket with no fraction was NOT reported and is hidden; families never merge');
      const gem = w.find((x) => x.family === 'Gemini Models');
      assert.deepStrictEqual([gem.window, gem.remainingPercent, gem.usedPercent, gem.reported], ['week', 74, 26, 'remaining']);
      assert.strictEqual(gem.resetAt, Date.parse('2026-10-08T09:00:00Z'));
      const third = w.find((x) => x.family === 'Claude and GPT models');
      assert.strictEqual(third.remainingPercent, 0, 'exhausted is shown as exhausted');
    });

    await test('ANTIGRAVITY HTTPS: an expiring access token is refreshed with the refresh token', async () => {
      const r = await api.fresh({ access_token: 'old', refresh_token: 'rt-1', expires_at: Date.now() + 5000 });
      assert.strictEqual(r.refreshed, true);
      assert.match(r.token, /^at-r\d+$/);
      assert.strictEqual(r.rec.refresh_token, 'rt-1', 'the refresh token is kept when Google does not rotate it');
      await assert.rejects(api.fresh({ access_token: 'x', expires_at: 0 }), /sign in again/);
    });

    await test('ANTIGRAVITY HTTPS: Connect account needs NO runtime — CONNECTED after Google answers who it is; the account reports quota', async () => {
      const { App } = require('../../src/app');
      const A = require('../../src/authsession');
      A._reset();
      const app = new App({ out: { write() {}, on() {}, columns: 100, isTTY: false }, interactive: false, cwd: tmpdir('agy-https-app-') });
      app.cfg.runtimes = {};   // no ACP binary anywhere
      const st = await A.start(app, 'antigravity', { name: 'Studio' });
      assert.ok(st.ok, st.why);
      const sess = A.get(st.session.id);
      const end = Date.now() + 5000;
      while (!sess.url && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      assert.ok(sess.url, 'the person is handed a sign-in URL');
      assert.strictEqual(sess.state, 'AWAITING_BROWSER');
      await browser(sess.url);
      const done = await A.settled(sess.id, 10000);
      assert.strictEqual(done.state, 'CONNECTED', JSON.stringify(done));
      const ai = require('../../src/accountinstances');
      const rec = ai.record(sess.target);
      assert.strictEqual(rec.config.auth, 'https');
      assert.ok(creds.isRef(rec.config.credentialRef));
      assert.ok(!rec.config.home, 'no profile directory, no runtime');
      assert.ok(!fs.existsSync(require('../../src/drivers/antigravity').toolsDir()), 'nothing was downloaded');
      assert.ok(rec.models.length === 2 && rec.signedIn, 'its models are known');
      const view = ai.handle(app, sess.target).current();
      assert.strictEqual(view.limits.windows.length, 2);
      assert.ok(view.limits.windows.every((x) => x.reported === 'remaining'));
      const q = await ai.refreshQuota(app, sess.target);
      assert.ok(q.ok, q.why);

      // EXECUTION: a tool call and its result round-trip through generateContent; the receipt carries reasoning tokens.
      const h = ai.handle(app, sess.target);
      const ag = require('../../src/drivers/antigravity');
      const pc = { instanceId: sess.target, model: 'gemini-3-pro' };
      const tools = [{ name: 'read_file', description: 'read', parameters: { type: 'object', $schema: 'x', properties: { path: { type: 'string' }, limit: { type: 'number', optional: true } }, required: ['path', 'limit'] } }];
      const first = [];
      for await (const ev of ag.chat(pc, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'read a.txt' }], { app, tools })) first.push(ev);
      const call = first.find((e) => e.type === 'tool_calls').calls[0];
      assert.strictEqual(call.name, 'read_file');
      assert.deepStrictEqual(call.input, { path: 'a.txt' });
      const decl = g.state.lastEnvelope.request.tools[0].functionDeclarations[0];
      assert.deepStrictEqual(decl.parameters.required, ['path'], '`optional` becomes absence from required');
      assert.ok(!('$schema' in decl.parameters), 'neutral annotations dropped');
      assert.strictEqual(g.state.lastEnvelope.project, 'proj-123');
      assert.deepStrictEqual(g.state.lastEnvelope.request.systemInstruction, { parts: [{ text: 'be brief' }] });
      const second = [];
      const msgs = [{ role: 'user', content: 'read a.txt' }, { role: 'assistant', content: '', tool_calls: [{ id: call.id, name: call.name, arguments: call.input }] }, { role: 'tool', tool_call_id: call.id, content: 'alpha\nbeta' }];
      for await (const ev of ag.chat(pc, msgs, { app, tools })) second.push(ev);
      const fr = g.state.lastEnvelope.request.contents.find((c) => c.parts.some((p) => p.functionResponse)).parts[0].functionResponse;
      assert.strictEqual(fr.name, 'read_file', 'a tool result is answered by NAME');
      assert.strictEqual(second.filter((e) => e.type === 'text').map((e) => e.chunk).join(''), 'alpha');
      assert.strictEqual(second.filter((e) => e.type === 'reasoning').map((e) => e.chunk).join(''), 'planning', 'thought parts are reasoning, never answer text');
      const u = second.find((e) => e.type === 'usage');
      assert.deepStrictEqual([u.inputTokens, u.outputTokens, u.reasoningTokens, u.cacheReadTokens], [150, 5, 3, 100]);
      assert.ok(ai.record(sess.target).verified_at, 'a real answer verifies the account');
      void h;
      A._reset();
    });
  } finally {
    creds.useBackend(null);
    await g.close();
    if (saved.base === undefined) delete process.env.LAIN_ANTIGRAVITY_BASE; else process.env.LAIN_ANTIGRAVITY_BASE = saved.base;
    if (saved.cfg === undefined) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = saved.cfg;
  }
};
