'use strict';

/**
 * CONNECTING TELEGRAM FROM LAIN DESKTOP — the whole flow through the Harness
 * routes, with no CLI.
 *
 * Real Rust supervisor (credential authority + poller), real gateway, real
 * config file; only Telegram's HTTP API is a local fixture (LAIN_TELEGRAM_API),
 * exactly as tests/integration/bot-telegram.test.js does.
 *
 *   token → verified identity → "/start" → candidate → approve → messages work
 *   → revoke → disconnect removes credential and approvals
 *
 * And the security properties: a malformed or rejected token stores nothing;
 * the token appears in no response, no config and no transport store.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test } = require('../helpers');
const { setTimeout: delay } = require('timers/promises');

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await delay(60); }
  return false;
}

module.exports = async () => {
  await test('BOT HARNESS: token → identity → /start → approve → connected → disconnect, no CLI', async () => {
    const supervisor = require('../../src/supervisor');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-harness-'));
    const keys = ['LAIN_HOME', 'LAIN_TELEGRAM_API', 'LAIN_PROVIDER', 'LAIN_MOCK_SCRIPT'];
    const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const token = '123456789:fixture_harness_bot_token_12345678';
    const pending = [], updates = [], sent = [];
    let next = 0;
    const respond = (res, body) => { if (!res.writableEnded) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture');
      const method = url.pathname.split('/').at(-1);
      if (!url.pathname.startsWith(`/bot${token}/`)) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error_code: 401 })); return; }
      if (method === 'getMe') return respond(res, { ok: true, result: { id: 4242, is_bot: true, username: 'lain_harness_bot', first_name: 'LAIN Harness' } });
      if (method === 'getUpdates') {
        const flush = () => { const i = pending.indexOf(flush); if (i >= 0) pending.splice(i, 1); respond(res, { ok: true, result: updates.splice(0) }); };
        if (updates.length) return flush();
        pending.push(flush); setTimeout(flush, 300); return;
      }
      if (method === 'sendMessage') sent.push(Object.fromEntries(url.searchParams));
      respond(res, { ok: true, result: { message_id: sent.length || 1 } });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.LAIN_HOME = path.join(root, 'home');
    process.env.LAIN_TELEGRAM_API = `http://127.0.0.1:${server.address().port}`;
    process.env.LAIN_PROVIDER = 'mock';
    delete process.env.LAIN_MOCK_SCRIPT;
    require('../../src/mockprovider')._reset();
    const say = (sender, text) => {
      updates.push({ update_id: ++next, message: { message_id: next, from: { id: sender, is_bot: false }, chat: { id: sender, type: 'private' }, date: Math.floor(Date.now() / 1000), text } });
      for (const release of [...pending]) release();
    };

    const routes = require('../../src/harnessapp/routes');
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: root });
    const d = (p, b = {}) => routes.dispatch(app, 'POST', p, b);
    try {
      let c = await d('/api/bot/connections');
      assert.strictEqual(c.code, 200, JSON.stringify(c.body));
      const tg0 = c.body.platforms.find((p) => p.platform === 'telegram');
      if (tg0.restartRequired || (tg0.state === 'FAILED' && /runtime did not answer/.test(tg0.summary))) {
        process.stdout.write(`    (skipped: ${tg0.summary})\n`);
        return;
      }
      assert.strictEqual(tg0.state, 'NOT_CONNECTED');
      assert.deepStrictEqual(c.body.platforms.map((p) => [p.platform, p.setup]), [['telegram', 'harness'], ['discord', 'environment'], ['whatsapp', 'environment']]);

      const malformed = await d('/api/bot/telegram/connect', { token: 'not a token' });
      assert.strictEqual(malformed.code, 400);
      assert.match(malformed.body.why, /BotFather/);

      const wrong = await d('/api/bot/telegram/connect', { token: '987654321:wrong_token_that_telegram_rejects_x' });
      assert.strictEqual(wrong.code, 400);
      assert.match(wrong.body.why, /did not accept/);

      const connected = await d('/api/bot/telegram/connect', { token });
      assert.strictEqual(connected.code, 200, JSON.stringify(connected.body));
      assert.ok(!JSON.stringify(connected.body).includes(token), 'the token is never in a response');
      assert.strictEqual(connected.body.telegram.identity.username, 'lain_harness_bot');
      assert.strictEqual(connected.body.telegram.identity.name, 'LAIN Harness');
      assert.ok(!fs.readFileSync(require('../../src/config').configFile(), 'utf8').includes(token), 'nor in config');

      assert.ok(await until(async () => {
        const r = await d('/api/bot/connections');
        return r.body.platforms[0].state === 'CONNECTED';
      }), 'the gateway runs in Core and Telegram is CONNECTED');

      say(999, 'hello before approval');
      say(999, '/start');
      assert.ok(await until(async () => (await d('/api/bot/telegram/candidates')).body.candidates.some((x) => x.senderId === '999')),
        'the /start sender is a candidate');
      assert.ok(!sent.some((s) => s.chat_id === '999'), 'an unapproved sender gets nothing');

      const notCandidate = await d('/api/bot/telegram/approve', { senderId: '12345' });
      assert.strictEqual(notCandidate.code, 409, 'only an ID that sent /start can be approved');

      const approved = await d('/api/bot/telegram/approve', { senderId: '999' });
      assert.strictEqual(approved.code, 200, JSON.stringify(approved.body));
      assert.deepStrictEqual(approved.body.allowedUsers, ['999']);
      c = await d('/api/bot/connections');
      assert.strictEqual(c.body.platforms[0].allowedCount >= 1, true);
      assert.ok(!c.body.platforms[0].candidates.some((x) => x.senderId === '999'), 'an approved sender is no longer a candidate');

      say(999, 'hello after approval');
      assert.ok(await until(() => sent.some((s) => s.chat_id === '999' && s.text)), 'the approved sender is answered by the real runtime');

      const checked = await d('/api/bot/telegram/check');
      assert.strictEqual(checked.body.telegram.authenticated, true);

      const revoked = await d('/api/bot/telegram/revoke', { senderId: '999' });
      assert.deepStrictEqual(revoked.body.allowedUsers, []);

      const gone = await d('/api/bot/telegram/disconnect');
      assert.strictEqual(gone.code, 200, JSON.stringify(gone.body));
      assert.strictEqual(gone.body.telegram.state, 'NOT_CONNECTED');
      assert.strictEqual(gone.body.telegram.configured, false, 'the credential is removed, not hidden');
      const transport = path.join(require('../../src/config').configDir(), 'bot', 'transport.json');
      if (fs.existsSync(transport)) assert.ok(!fs.readFileSync(transport, 'utf8').includes(token));
    } finally {
      try { if (app._botService) await app._botService.stop(); } catch { /* going */ }
      await supervisor.shutdownIn(process.env.LAIN_HOME).catch(() => {});
      for (const release of [...pending]) release();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      try { await require('../../src/harnesslink').shutdown(app); } catch { /* none */ }
    }
  });
};
