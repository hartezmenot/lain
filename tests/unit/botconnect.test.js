'use strict';

/**
 * TELEGRAM APPROVAL RULES, WITHOUT A NETWORK OR A SUPERVISOR.
 *
 *   · only an unauthorized PRIVATE `/start` from a person is recorded as a candidate
 *   · recording grants nothing
 *   · only a recorded candidate can be approved, and approval takes effect on
 *     the running gateway's own settings object — no restart
 *   · a malformed token never reaches LAIN's runtime
 */

const assert = require('assert');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const { Gateway } = require('../../src/bot/gateway');
const { Registry, authorized } = require('../../src/bot/contract');

function fakeAdapterRegistry() {
  const caps = { version: 1, platform: 'telegram', maxLength: 4096, format: 'plain', edit: true, typing: true, threads: true, buttons: true, mediaIn: false, mediaOut: false };
  return new Registry().register(caps, () => ({
    identity: '4242', state: 'stopped',
    async start() { this.state = 'listening'; },
    async stop() { this.state = 'stopped'; },
    async action() { return {}; },
  }));
}

function msg(sender, text, kind = 'dm') {
  return { platform: 'telegram', accountId: 'default', chatId: kind === 'dm' ? String(sender) : '-100', senderId: String(sender), messageId: `u:${Math.random()}`, kind, text };
}

module.exports = async function () {
  await test('BOT: only a private /start from an unapproved person becomes a candidate, and it grants nothing', async () => {
    const settings = { enabled: true, accountId: 'default', allowUsers: [] };
    const ran = [];
    const gw = new Gateway({
      cfg: { bot: { platforms: { telegram: settings } } },
      dir: path.join(tmpdir('botgw-'), 'bot'),
      registry: fakeAdapterRegistry(),
      runtimeFactory: () => ({ id: 's', stop() {}, async close() {}, async run(e) { ran.push(e.text); return 'ok'; } }),
    });
    await gw.start();
    try {
      assert.strictEqual((await gw.receive(msg(999, '/start'))).accepted, false, '/start is refused');
      await gw.receive(msg(888, 'hello'));
      await gw.receive(msg(777, '/start', 'group'));
      await gw.receive({ ...msg(666, '/start'), bot: true });
      const cands = Object.values(gw.store.data.candidates || {});
      assert.deepStrictEqual(cands.map((c) => c.senderId), ['999'], 'only the private /start from a person');
      assert.strictEqual(ran.length, 0, 'no turn ran for anyone');
      assert.strictEqual(authorized(require('../../src/bot/contract').event(msg(999, 'hi')), settings), false);

      // APPROVAL IN PLACE: the gateway holds this very settings object.
      settings.allowUsers.push('999');
      const r = await gw.receive(msg(999, 'now I am allowed'));
      assert.strictEqual(r.accepted, true, 'the running gateway honours the approval without a restart');
    } finally { await gw.stop(); }
  });

  await test('BOT: approve accepts only a recorded candidate; a malformed token never reaches the runtime', async () => {
    const bc = require('../../src/botconnect');
    const fs = require('fs');
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('botc-') });
    app.cfg.bot = { platforms: { telegram: { enabled: true, accountId: 'default', allowUsers: [] } } };
    const dir = path.join(require('../../src/config').configDir(), 'bot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transport.json'), JSON.stringify({ version: 1, sessions: {}, inbox: {}, deliveries: {}, candidates: {
      'telegram:default:999': { platform: 'telegram', accountId: 'default', senderId: '999', chatId: '999', firstAt: 1, lastAt: 2, count: 1 },
    } }));
    assert.strictEqual(bc.approveTelegram(app, '12345').ok, false, 'not a candidate');
    assert.strictEqual(bc.approveTelegram(app, 'abc').ok, false, 'not a number');
    const held = app.cfg.bot.platforms.telegram;
    const ok = bc.approveTelegram(app, '999');
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(app.cfg.bot.platforms.telegram, held, 'the same object the gateway holds');
    assert.deepStrictEqual(held.allowUsers, ['999']);
    assert.deepStrictEqual(bc.candidates(app, 'telegram'), [], 'an approved ID is no longer offered');

    const sup = require('../../src/supervisor');
    const real = { call: sup.call, callIfRunning: sup.callIfRunning };
    let contacted = false;
    sup.call = async () => { contacted = true; return { ok: false }; };
    sup.callIfRunning = async () => { contacted = true; return { ok: false }; };
    try {
      const r = await bc.connectTelegram(app, 'definitely not a token');
      assert.strictEqual(r.ok, false);
      assert.strictEqual(contacted, false, 'rejected before anything was contacted');
    } finally { Object.assign(sup, real); }
    assert.ok(bc.TOKEN_RE.test('123456789:AAHfiqksKZ8WmR2zSjiQ7_v4TMAKdiHm9T0'), 'a real-shaped token passes the format check');
  });
};
