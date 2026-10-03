'use strict';

/**
 * EXTERNAL SESSIONS — seen, resumed where they live, or continued as a new
 * LAIN session; never taken over or written back.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const ai = require('../../src/accountinstances');
  const ext = require('../../src/externalsessions');
  const FAKE = path.join(__dirname, '..', 'fixtures', 'codex', 'fakeappserver.js');
  const shared = tmpdir('codex-ext-');
  fs.mkdirSync(path.join(shared, 'sessions'), { recursive: true });
  const THREAD = { preview: 'fix the login bug', cwd: shared, turns: [{ id: 'u1', items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'The login button does nothing.' }] },
    { type: 'agentMessage', text: 'The handler is never bound; bind it in init().' },
  ] }] };
  const threadFile = path.join(shared, 'sessions', 'thr-1.json');
  fs.writeFileSync(threadFile, JSON.stringify(THREAD));
  const original = fs.readFileSync(threadFile, 'utf8');
  const app = { cfg: { accounts: { codex: { binary: { command: process.execPath, args: [FAKE] } } } }, connections: () => [], session: { cwd: shared } };
  try { fs.unlinkSync(ai.file()); } catch { /* fresh */ }
  const ids = [];
  try {
    for (const who of [{ email: 'x@example.com', planType: 'plus', accountId: 'a1' }, { email: 'y@example.com', planType: 'pro', accountId: 'a2' }]) {
      const r = ai.add(app, { driver_id: 'codex', display_name: who.email, config: { home_mode: 'overlay', shared_home: shared } });
      ids.push(r.instance.id);
      const h = ai.handle(app, r.instance.id);
      fs.mkdirSync(h.layout.home, { recursive: true });
      fs.writeFileSync(path.join(h.layout.home, 'fake-login.json'), JSON.stringify(who));
      await ai.login(app, r.instance.id);
    }
    const until = Date.now() + 5000;
    while (Date.now() < until && !ai.list(app).every((v) => v.authentication_state === 'AUTHENTICATED')) await new Promise((r) => setTimeout(r, 40));

    await test('EXTERNAL: a native Codex thread is one ref, with every account that reads its store', async () => {
      const r = await ext.list(app);
      const s = r.sessions.filter((x) => x.runtime === 'codex');
      assert.strictEqual(s.length, 1, 'listed once per store, not once per account');
      assert.strictEqual(s[0].origin, 'external:codex:thr-1');
      assert.deepStrictEqual(s[0].compatibleAccounts.sort(), ids.slice().sort());
      assert.strictEqual(r.adapters.cursor.level, 'UNSUPPORTED');
      assert.strictEqual(r.adapters['claude-code'].level, 'OPTIONAL');
    });

    await test('CONTINUE IN LAIN: a new session from a read-only import — the original is not touched', async () => {
      const r = await ext.continueInLain(app, { origin: 'external:codex:thr-1', account: ids[1] });
      assert.ok(r.ok, r.why);
      const { Session } = require('../../src/session');
      const s = Session.resume(r.session);
      assert.strictEqual(s.origin.origin, 'external:codex:thr-1');
      assert.ok(/login button does nothing/.test(s.messages[0].content) && /bind it in init/.test(s.messages[0].content));
      assert.ok(/read-only import/.test(s.messages[0].content));
      assert.strictEqual(fs.readFileSync(threadFile, 'utf8'), original, 'the Codex thread is unchanged');
      assert.strictEqual((await ext.continueInLain(app, { origin: 'external:cursor:x', account: ids[0] })).ok, false);
    });

    await test('RESUME ORIGINAL: the runtime’s own resume, in the chosen account’s home', () => {
      const r = ext.resumeOriginal(app, { origin: 'external:codex:thr-1', account: ids[0] });
      assert.ok(r.ok);
      assert.strictEqual(r.command, 'codex resume thr-1');
      assert.strictEqual(r.env.CODEX_HOME, ai.handle(app, ids[0]).layout.home);
    });
  } finally {
    await ai.stopAll();
    for (const id of ids) await ai.disconnect(app, id, { logout: false }).catch(() => {});
  }
};
