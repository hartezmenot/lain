'use strict';

/**
 * DISCOVERY FINDS, ADOPT REGISTERS, NOTHING IS TAKEN.
 *   · a Codex home named by CODEX_HOME is found; its sign-in is noted by
 *     PRESENCE — the file is not read, copied or changed
 *   · Adopt registers that home (direct mode) and nothing else; twice is refused
 *   · a runtime that is not installed says so, with install help, and no download
 *   · a window past its reported reset is expired, never "confirmed"
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const disc = require('../../src/runtimediscovery');
  const ai = require('../../src/accountinstances');
  const FAKE = path.join(__dirname, '..', 'fixtures', 'codex', 'fakeappserver.js');
  const home = tmpdir('codex-found-');
  const AUTH = JSON.stringify({ fake: true, email: 'found@example.com', planType: 'plus', accountId: 'acct-found' });
  fs.writeFileSync(path.join(home, 'auth.json'), AUTH);
  fs.mkdirSync(path.join(home, 'sessions'));
  const before = fs.statSync(path.join(home, 'auth.json')).mtimeMs;
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const app = { cfg: { accounts: { codex: { binary: { command: process.execPath, args: [FAKE] } } } }, connections: () => [] };
  try { fs.unlinkSync(ai.file()); } catch { /* fresh */ }
  disc._reset();
  let adopted = null;
  try {
    await test('DISCOVERY: a Codex home is found; its sign-in is noted by presence only', () => {
      const cx = disc.discover(app, { force: true }).find((r) => r.driver === 'codex');
      assert.ok(cx.installed, 'the configured binary counts as installed');
      const h = cx.homes.find((x) => x.home === path.resolve(home));
      assert.ok(h, JSON.stringify(cx.homes));
      assert.strictEqual(h.signInPresent, true);
      assert.strictEqual(h.sessionsPresent, true);
      assert.strictEqual(h.adoptedBy, null, 'found is not adopted');
      assert.strictEqual(ai.list(app).length, 0, 'discovery enables nothing');
    });

    await test('ADOPT: registers the home as it is — nothing copied — and reads the runtime there', async () => {
      const r = disc.adopt(app, { driver: 'codex', home });
      assert.ok(r.ok, r.why);
      adopted = r.instance.id;
      const h = ai.handle(app, adopted);
      assert.strictEqual(h.layout.mode, 'direct');
      assert.strictEqual(path.resolve(h.layout.home), path.resolve(home));
      assert.strictEqual(h.layout.lainOwned, false, 'a home Noema did not create is never deleted by Noema');
      assert.ok((await ai.refresh(app, adopted)).ok);
      assert.strictEqual(ai.get(app, adopted).identity.email, 'found@example.com', 'the runtime, in that home, says who it is');
      assert.strictEqual(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), AUTH);
      assert.strictEqual(fs.statSync(path.join(home, 'auth.json')).mtimeMs, before, 'the sign-in file is untouched');
      assert.strictEqual(disc.adopt(app, { driver: 'codex', home }).ok, false, 'adopting twice is refused');
      assert.strictEqual(disc.discover(app).find((x) => x.driver === 'codex').homes.find((x) => x.home === path.resolve(home)).adoptedBy, adopted);
    });

    await test('DISCONNECT an adopted home: unregistered, and the person\'s own sign-in stays where it was', async () => {
      const r = await ai.disconnect(app, adopted);
      assert.ok(r.ok, r.why);
      assert.ok(!r.steps.some((x) => /signed out/.test(x)), r.steps.join(' | '));
      assert.ok(r.steps.some((x) => /home kept/.test(x)));
      assert.strictEqual(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), AUTH, 'not signed out, not deleted');
      assert.ok(fs.existsSync(path.join(home, 'sessions')));
      adopted = null;
    });

    await test('RUNTIMES: not installed is said plainly, with install help — nothing is downloaded', async () => {
      const zc = disc.discover(app, { force: true }).find((r) => r.driver === 'zcode');
      assert.strictEqual(zc.installed, false);
      assert.ok(zc.install && /^https:\/\//.test(zc.install.docs));
      const d = require('../../src/providerdrivers').get('zcode');
      const h = d.create({ id: 'zcode-x', config: {} }, { binary: null });
      const s = await h.refresh();
      assert.strictEqual(s.runtime_state, 'NOT_INSTALLED');
    });

    await test('RESET: a window past its reported reset is expired, never confirmed; the next midnight follows the clock', async () => {
      const rt = require('../../src/drivers/runtimes');
      assert.strictEqual(require('../../src/providerdrivers').get('freebuff'), null, 'Freebuff is gone (8.3)');
      const t0 = new Date(2026, 8, 25, 23, 59, 30).getTime();
      const m0 = rt.nextLocalMidnight(t0);
      assert.strictEqual(new Date(m0).getDate(), 26);
      const t1 = m0 + 60 * 1000;   // the clock advanced past midnight
      assert.strictEqual(new Date(rt.nextLocalMidnight(t1)).getDate(), 27, 'the next expected reset, not a replenishment');
      const stamped = ai.stampWindows({ windows: [{ id: 'daily', label: 'daily', usedPercent: null, resetsAt: m0 }] }, t1);
      assert.deepStrictEqual([stamped.windows[0].expired, stamped.windows[0].resetConfirmed], [true, false]);
    });
  } finally {
    if (adopted) await ai.disconnect(app, adopted, { logout: false }).catch(() => {});
    await ai.stopAll();
    if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
    disc._reset();
  }
};
