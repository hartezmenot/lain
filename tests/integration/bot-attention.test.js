'use strict';

/**
 * §39–40, §78 — "LAIN needs you" through the REAL Rust Telegram poller against a
 * fixture Telegram API: one Core decision reaches Telegram with buttons; a
 * button press resolves THE SAME record and closes the CLI's panel; an answer
 * given in the CLI first is reflected in Telegram; background completion is
 * notified. No duplicate approval state exists anywhere.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { test } = require('../helpers');
const supervisor = require('../../src/supervisor');
const { Gateway } = require('../../src/bot/gateway');
const { Registry } = require('../../src/bot/contract');
const { Telegram, caps } = require('../../src/bot/telegram');
const decisions = require('../../src/decisions');
const { setTimeout: delay } = require('timers/promises');

async function until(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await delay(40); } return false; }

module.exports = async () => {
  await test('BOT ATTENTION: one Core decision, answered from Telegram, closes the CLI panel; CLI-first answers are reflected; BG COMPLETE is sent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-bot-attn-'));
    const keys = ['LAIN_HOME', 'LAIN_TELEGRAM_API', 'LAIN_BOT_TEST_TOKEN']; const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const token = '123456789:fixture_telegram_bot_token_1234567890';
    process.env.LAIN_BOT_TEST_TOKEN = token;
    const pending = []; const updates = []; const sent = []; let next = 0;
    const respond = (res, body) => { if (!res.writableEnded) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture'); const method = url.pathname.split('/').at(-1);
      if (!url.pathname.startsWith('/bot' + token + '/')) { res.writeHead(404); res.end(); return; }
      if (method === 'getMe') return respond(res, { ok: true, result: { id: 77, username: 'lain_fixture', first_name: 'Noema' } });
      if (method === 'getUpdates') {
        const flush = () => { const i = pending.indexOf(flush); if (i >= 0) pending.splice(i, 1); respond(res, { ok: true, result: updates.splice(0) }); };
        if (updates.length) return flush(); pending.push(flush); setTimeout(flush, 300); return;
      }
      if (method === 'sendMessage') sent.push(Object.fromEntries(url.searchParams));
      respond(res, { ok: true, result: { message_id: sent.length || 1 } });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.LAIN_HOME = path.join(root, 'home');
    process.env.LAIN_TELEGRAM_API = `http://127.0.0.1:${server.address().port}`;
    const press = (data) => {
      updates.push({ update_id: ++next, callback_query: { id: `cb${next}`, from: { id: 555 }, data, message: { message_id: 88, date: 1, text: 'prompt', chat: { id: 555, type: 'private' } } } });
      for (const release of [...pending]) release();
    };
    let gateway;
    try {
      decisions._reset();
      gateway = new Gateway({ dir: path.join(root, 'bot'), registry: new Registry().register(caps, (cfg) => new Telegram(cfg)),
        cfg: { bot: { platforms: { telegram: { enabled: true, tokenEnv: 'LAIN_BOT_TEST_TOKEN', allowUsers: ['555'] } } } },
        runtimeFactory: () => ({ id: 'x', stop() {}, close: async () => {}, steer() {}, async run() { return ''; } }) });
      await gateway.start();

      // 1. A CLI asks; nobody answers the panel; Telegram does.
      let closedWith;
      const panel = { stack: [], close(v) { closedWith = v; this.stack = []; if (this._r) this._r(v); } };
      const app = { session: { id: 'sess-1', cwd: path.join(root, 'toradb') }, ui: { enabled: true, panel } };
      const answer = decisions.ask(app, { type: 'PERMISSION_REQUEST', title: 'MANUAL · allow this step?', question: 'write_file · src/a.js', options: ['Allow once', 'Allow for this turn', 'Deny'] },
        null, () => new Promise((r) => { panel.stack = [{}]; panel._r = r; }));
      assert.ok(await until(() => sent.some((s) => s.reply_markup && /MANUAL · allow this step/.test(s.text))), 'the decision reached Telegram with buttons');
      assert.strictEqual(decisions.pending('sess-1').length, 1, 'exactly one pending record');
      const msg = sent.find((s) => s.reply_markup);
      const data = JSON.parse(msg.reply_markup).inline_keyboard[2][0].callback_data;
      assert.match(data, /^lain:[0-9a-f]{24}:3$/);
      press(data);
      assert.strictEqual(await answer, 'Deny', 'the CLI got the Telegram answer');
      assert.strictEqual(closedWith, 'Deny', 'and its panel closed');
      assert.strictEqual(decisions.pending('sess-1').length, 0);

      // 2. A forged press is refused and changes nothing.
      const d2 = decisions.create({ type: 'ASK_USER', sessionId: 'sess-2', title: 'Which?', options: ['A', 'B'] });
      press(`lain:${d2.id}${'0'.repeat(16)}:1`);
      await delay(1500);
      assert.strictEqual(decisions.get(d2.id).state, 'PENDING', 'a forged token is refused');

      // 3. The CLI answers first; Telegram is told where.
      assert.ok(await until(() => sent.some((s) => /Which\?/.test(s.text))));
      decisions.resolve(d2.id, 'B', { surface: 'cli' });
      assert.ok(await until(() => sent.some((s) => /answered in cli: B/.test(s.text))), 'other surfaces update');
      press(`lain:${decisions.token(d2)}:1`);
      await delay(1500);
      assert.strictEqual(decisions.get(d2.id).answer, 'B', 'a late press does not overwrite the first valid answer');

      // 4. Background completion is an attention event.
      require('../../src/notify').attention(app, 'BACKGROUND_COMPLETE', 'CLI smoke · 565/565');
      assert.ok(await until(() => sent.some((s) => /BG COMPLETE · toradb\nCLI smoke · 565\/565/.test(s.text))));
      // Routine events never are.
      assert.strictEqual(require('../../src/notify').attention(app, 'TOOL_CALL', 'read x'), false);
    } finally {
      await gateway?.stop(); await supervisor.shutdownIn(process.env.LAIN_HOME).catch(() => {});
      for (const release of [...pending]) release(); server.closeAllConnections(); await new Promise((r) => server.close(r));
      for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
};
