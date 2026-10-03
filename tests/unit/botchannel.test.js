'use strict';

/**
 * THE TELEGRAM CHANNEL, END TO END, AGAINST A FAKE RUNTIME.
 *
 *   · THE P0: a connected bot whose gateway is not running is CONFIGURED, not
 *     connected — and its messages wait at Telegram. `resume` fixes that.
 *   · every stage of a message leaves a receipt under one id, and a refused
 *     message says why
 *   · a real round trip (reply acknowledged) is what makes it OPERATIONAL
 *   · Send test proves the outbound half
 *   · disconnect stops polling, releases the lease, removes the credential,
 *     clears approvals, marks DISCONNECTED, and does not claim revocation
 *   · reconnect works; the token never lands in a receipt, a store or a response
 *
 * The real Telegram adapter (src/bot/telegram.js) and the real gateway run; the
 * supervisor is tests/fixtures/bot/fakesupervisor.js; the conversation runtime
 * is a fake (no model, no quota).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

async function waitFor(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}

module.exports = async function () {
  const fake = require('../fixtures/bot/fakesupervisor').install();
  const bc = require('../../src/botconnect');
  const trace = require('../../src/bot/trace');
  const { App } = require('../../src/app');
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('botch-') });
  const botDir = path.join(require('../../src/config').configDir(), 'bot');
  for (const f of ['transport.json', 'trace.json']) { try { fs.unlinkSync(path.join(botDir, f)); } catch { /* fresh */ } }
  const turns = [];
  let failNext = false;
  app._botRuntimeFactory = () => ({
    id: 'fake-session', lastOutcome: null, stop() {}, async close() {},
    async run(e) {
      turns.push(e.text);
      if (failNext) { failNext = false; this.lastOutcome = { providerFailure: 'fake · rate_limit · slow down' }; return 'The configured provider could not complete this request.'; }
      this.lastOutcome = { model: 'fake-model' }; return `echo: ${e.text}`;
    },
  });
  const tg = () => bc.telegram(app);

  try {
    await test('CHANNEL P0: a verified token with no gateway is CONFIGURED — and the message waits at Telegram', async () => {
      const r = await bc.connectTelegram(app, fake.GOOD);
      assert.ok(r.ok, r.why);
      // Simulate a LAIN restart: the gateway connect started is gone.
      await bc.stopService(app);
      fake.dm(555, 'hello?');
      const t = await tg();
      assert.strictEqual(t.status, 'CONFIGURED', t.summary);
      assert.notStrictEqual(t.state, 'CONNECTED', 'never "connected" because a token verified');
      assert.ok(/messages wait at Telegram/.test(t.summary), t.summary);
      assert.strictEqual(fake.state.atTelegram.length, 1, 'no one polled: the runtime polls only for a lease holder');
    });

    await test('CHANNEL: resume at launch brings back the connected channel; an unapproved sender is refused WITH A REASON', async () => {
      const res = await bc.resume(app);
      assert.ok(res.started, JSON.stringify(res));
      assert.ok(await waitFor(() => fake.state.atTelegram.length === 0 && fake.state.mailbox.length === 0), 'polled and acknowledged');
      const t = await tg();
      assert.strictEqual(t.status, 'LISTENING', t.summary);
      assert.strictEqual(t.diagnostics.runtime.leased, true);
      const d = t.diagnostics;
      assert.ok(d.lastInbound && d.lastInbound.sender === '555');
      assert.strictEqual(d.lastAuthorize.ok, false);
      assert.ok(/not approved/.test(d.lastAuthorize.why), d.lastAuthorize.why);
      assert.strictEqual(d.lastMessage.stoppedAt.stage, 'authorize', 'where it stopped, by name');
      assert.strictEqual(d.lastInbound.rid, d.lastAuthorize.rid, 'one message, one receipt id');
      assert.deepStrictEqual(bc.candidates(app).map((c) => c.senderId), ['555'], 'a plain "hello?" asks to be approved too');
      assert.strictEqual(turns.length, 0);
      assert.strictEqual(fake.state.sent.length, 0, 'strangers get nothing back');
    });

    await test('CHANNEL: approved → dispatch → model → reply delivered: OPERATIONAL only after the round trip', async () => {
      assert.ok(bc.approveTelegram(app, '555').ok);
      fake.dm(555, 'what is 2+2');
      assert.ok(await waitFor(() => fake.state.sent.some((m) => m.method === 'sendMessage' && /echo: what is 2\+2/.test(m.text))), JSON.stringify(fake.state.sent));
      assert.ok(await waitFor(async () => (await tg()).status === 'OPERATIONAL'));
      const d = (await tg()).diagnostics;
      const stages = d.lastMessage.path.map((p) => `${p.stage}:${p.ok}`);
      assert.deepStrictEqual(stages, ['inbound:true', 'authorize:true', 'dispatch:true', 'model:true', 'outbound:true'], stages.join(' '));
      assert.strictEqual(d.lastMessage.stoppedAt, null, 'it did not stop');
      assert.strictEqual(d.lastModel.model, 'fake-model');
    });

    await test('CHANNEL: a provider failure is a MODEL receipt with its reason; Send test proves the outbound half', async () => {
      failNext = true;
      fake.dm(555, 'try again');
      assert.ok(await waitFor(async () => { const d = (await tg()).diagnostics; return d.lastModel && d.lastModel.ok === false; }));
      assert.ok(/rate_limit/.test((await tg()).diagnostics.lastModel.why));
      const before = fake.state.sent.length;
      const s = await bc.sendTest(app, {});
      assert.ok(s.ok && /^t-/.test(s.receipt), JSON.stringify(s));
      assert.strictEqual(fake.state.sent.length, before + 1);
      assert.strictEqual(fake.state.sent[fake.state.sent.length - 1].chatId, '555');
      assert.strictEqual((await bc.sendTest(app, { to: '999' })).ok, false, 'never to someone unapproved');
    });

    await test('CHANNEL: disconnect stops polling, releases the lease, removes the credential and approvals — and does not claim revocation', async () => {
      const r = await bc.disconnectTelegram(app);
      assert.ok(r.ok, r.why);
      assert.ok(/still valid at Telegram/.test(r.notRevoked));
      assert.strictEqual(fake.state.configured, false, 'the runtime no longer holds the token');
      assert.strictEqual(fake.state.owner, '', 'no lease');
      const svc = await bc.service(app);
      assert.strictEqual(svc.running, false, 'the gateway (and its runtimes) stopped');
      const s = app.cfg.bot.platforms.telegram;
      assert.strictEqual(s.enabled, false, 'removed from BOT routing');
      assert.deepStrictEqual(s.allowUsers, []);
      assert.deepStrictEqual(bc.candidates(app), []);
      const t = await tg();
      assert.strictEqual(t.status, 'DISCONNECTED');
      assert.ok(t.disconnectedAt);
      fake.dm(555, 'anyone?');
      assert.strictEqual((await bc.resume(app)).started, false, 'a disconnected channel does not come back at launch');
      await new Promise((r2) => setTimeout(r2, 300));
      assert.strictEqual(fake.state.atTelegram.length, 1, 'nothing polls a disconnected bot');
    });

    await test('CHANNEL: reconnect works; the token is in no receipt, store, config or response', async () => {
      const r = await bc.connectTelegram(app, fake.GOOD);
      assert.ok(r.ok, r.why);
      assert.ok(await waitFor(async () => (await tg()).status === 'LISTENING'));
      const secret = fake.GOOD.split(':')[1];
      const files = ['trace.json', 'transport.json'].map((f) => { try { return fs.readFileSync(path.join(botDir, f), 'utf8'); } catch { return ''; } });
      files.push(fs.readFileSync(require('../../src/config').configFile(), 'utf8'));
      files.push(JSON.stringify(await bc.connections(app)), JSON.stringify(r));
      for (const f of files) assert.ok(!f.includes(secret), 'token leaked');
      assert.ok(trace.read().length > 0);
    });
  } finally {
    await bc.stopService(app).catch(() => {});
    fake.restore();
  }
};
