'use strict';

/**
 * EIGHT CODEX ACCOUNTS, AT ONCE, AND NONE OF THEM COLLAPSE.
 *
 * Runs eight real driver instances, each with its own `codex app-server`
 * process (tests/fixtures/codex/fakeappserver.js — the real protocol subset, no
 * network, no account, no quota) and its own home:
 *
 *   · six OVERLAY accounts share one Codex home for sessions/config and each
 *     keeps its own auth.json; two DIRECT accounts have homes of their own
 *   · each signs in through the runtime's own login (a URL LAIN opens; LAIN
 *     never sees a password) and reports its own identity and limits
 *   · same email ≠ same account: never merged
 *   · rename / refresh / disconnect one touches no other
 *   · one writer per thread; a handoff is detach → confirm → attach, and only
 *     between accounts that read the same session store
 *   · the shared home's own sign-in is never read, linked or copied
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const FAKE = path.join(__dirname, '..', 'fixtures', 'codex', 'fakeappserver.js');

async function waitFor(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 40)); }
  return false;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

module.exports = async function () {
  const ai = require('../../src/accountinstances');
  const tw = require('../../src/threadwriters');
  const shared = tmpdir('codex-shared-');
  fs.mkdirSync(path.join(shared, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'sessions', 't-shared.json'), JSON.stringify({ preview: 'a native Codex session' }));
  fs.writeFileSync(path.join(shared, 'config.toml'), 'model = "gpt-5"\n');
  const OWNER_AUTH = JSON.stringify({ fake: true, email: 'owner@home.example', planType: 'pro', accountId: 'acct-owner', secret: 'the-shared-home-own-login' });
  fs.writeFileSync(path.join(shared, 'auth.json'), OWNER_AUTH);

  const app = {
    cfg: { accounts: { codex: { binary: { command: process.execPath, args: [FAKE] } } } },
    connections: () => [],
  };
  try { fs.unlinkSync(ai.file()); } catch { /* fresh */ }
  const ids = [];
  const WHO = [
    { email: 'a@example.com', planType: 'plus', accountId: 'acct-1' },
    { email: 'a@example.com', planType: 'pro', accountId: 'acct-2' },   // same email, another account
    { email: 'b@example.com', planType: 'plus', accountId: 'acct-3' },
    { email: 'c@example.com', planType: 'team', accountId: 'acct-4' },
    { email: 'd@example.com', planType: 'plus', accountId: 'acct-5' },
    { email: 'e@example.com', planType: 'free', accountId: 'acct-6' },
    { email: 'f@example.com', planType: 'plus', accountId: 'acct-7' },
    { email: 'g@example.com', planType: 'pro', accountId: 'acct-8' },
  ];

  try {
    await test('EIGHT CODEX: eight instances — six share a home by overlay, two have their own', () => {
      for (let i = 0; i < 8; i++) {
        const config = i < 6 ? { home_mode: 'overlay', shared_home: shared } : { home_mode: 'direct' };
        const r = ai.add(app, { driver_id: 'codex', display_name: `Codex ${i + 1}`, config });
        assert.ok(r.ok, r.why);
        ids.push(r.instance.id);
      }
      assert.strictEqual(new Set(ids).size, 8);
      const rows = ai.list(app);
      assert.strictEqual(rows.filter((r) => r.driver_id === 'codex').length, 8);
      assert.ok(rows.every((r) => r.credential_ref === null && r.credential.held_by === 'runtime'), 'Noema holds no secret for a runtime account');
    });

    await test('EIGHT CODEX: each signs in through the runtime\'s own login, concurrently, as itself', async () => {
      await Promise.all(ids.map(async (id, i) => {
        const h = ai.handle(app, id);
        fs.mkdirSync(h.layout.home, { recursive: true });
        fs.writeFileSync(path.join(h.layout.home, 'fake-login.json'), JSON.stringify(WHO[i]));   // the person, in the browser
        if (i === 2) fs.writeFileSync(path.join(h.layout.home, 'fake-limits.json'), JSON.stringify({ primary: { usedPercent: 87, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 600 } }));
        const r = await ai.login(app, id, { device: i === 7 });
        assert.ok(r.ok, r.why);
        assert.ok(/^https:\/\/auth\.openai\.com\//.test(r.login.url), 'a URL for the person\'s browser — no password passes through Noema');
        if (i === 7) assert.strictEqual(r.login.userCode, 'ABCD-1234');
      }));
      assert.ok(await waitFor(() => ai.list(app).filter((r) => r.driver_id === 'codex' && r.authentication_state === 'AUTHENTICATED').length === 8), JSON.stringify(ai.list(app).map((r) => [r.id, r.authentication_state])));
      const rows = ai.list(app).filter((r) => r.driver_id === 'codex');
      const pids = rows.map((r) => r.runtime.pid);
      assert.strictEqual(new Set(pids).size, 8, 'eight app-servers, concurrently');
      assert.ok(pids.every(alive));
      for (let i = 0; i < 8; i++) {
        const r = rows.find((x) => x.id === ids[i]);
        assert.strictEqual(r.identity.email, WHO[i].email);
        assert.strictEqual(r.identity.planType, WHO[i].planType);
        assert.strictEqual(r.identity.providerAccountId, WHO[i].accountId);
      }
    });

    await test('EIGHT CODEX: same email is not the same account; limits are each account\'s own, never combined', () => {
      const rows = ai.list(app).filter((r) => r.driver_id === 'codex');
      const a = rows.filter((r) => r.identity.email === 'a@example.com');
      assert.strictEqual(a.length, 2, 'two rows for one email');
      assert.ok(!a.some((r) => r.sameIdentityAs), 'different provider accounts: not even flagged');
      const hot = rows.find((r) => r.id === ids[2]);
      assert.deepStrictEqual(hot.limits.windows.map((w) => [w.label, w.usedPercent]), [['5h', 87]]);
      const cold = rows.find((r) => r.id === ids[3]);
      assert.deepStrictEqual(cold.limits.windows.map((w) => w.label), ['5h', 'weekly']);
      assert.strictEqual(cold.limits.source, 'provider');
      assert.ok(!('usedPercent' in cold.limits), 'no one number for incomparable windows');
      assert.ok(hot.reset_windows.every((w) => w.confirmed === false));
    });

    await test('EIGHT CODEX: isolation — overlay shares sessions by link, keeps auth private, never touches the shared home\'s sign-in', () => {
      const codexhome = require('../../src/drivers/codexhome');
      for (let i = 0; i < 6; i++) {
        const h = ai.handle(app, ids[i]);
        assert.strictEqual(h.storeKey, ai.handle(app, ids[0]).storeKey, 'one session store');
        const st = fs.lstatSync(path.join(h.layout.home, 'sessions'));
        assert.ok(st.isSymbolicLink(), 'sessions is the shared directory, linked');
        assert.ok(fs.existsSync(path.join(h.layout.home, 'sessions', 't-shared.json')), 'the native session is visible');
        const auth = fs.lstatSync(path.join(h.layout.home, 'auth.json'));
        assert.ok(auth.isFile() && !auth.isSymbolicLink() && auth.nlink === 1, 'auth.json is this account\'s own file');
        assert.ok(h.authIsPrivate());
        assert.ok(!fs.readFileSync(path.join(h.layout.home, 'auth.json'), 'utf8').includes('the-shared-home-own-login'));
        const cfgLink = path.join(h.layout.home, 'config.toml');
        if (fs.existsSync(cfgLink)) {
          const cs = fs.lstatSync(cfgLink);
          assert.ok(cs.isSymbolicLink() || cs.nlink > 1, 'config is shared by link, never copied');
        }
      }
      assert.strictEqual(fs.readFileSync(path.join(shared, 'auth.json'), 'utf8'), OWNER_AUTH, 'the shared home\'s own sign-in is untouched');
      const d1 = ai.handle(app, ids[6]); const d2 = ai.handle(app, ids[7]);
      assert.notStrictEqual(d1.storeKey, d2.storeKey, 'direct homes are separate stores');
      assert.notStrictEqual(d1.storeKey, ai.handle(app, ids[0]).storeKey);
      assert.ok(codexhome.layout(ids[6], { home_mode: 'direct' }).lainOwned);
    });

    await test('EIGHT CODEX: building shadows changed nothing in the shared home; the real ~/.codex is refused under test', () => {
      const codexhome = require('../../src/drivers/codexhome');
      assert.deepStrictEqual(fs.readdirSync(shared).sort(), ['auth.json', 'config.toml', 'sessions'], 'no directory was created in the person\'s home');
      const real = codexhome.layout('probe', { home_mode: 'overlay', shared_home: require('os').homedir() + '/.codex' });
      assert.throws(() => codexhome.materialize(real), /real ~\/\.codex/);
    });

    await test('EIGHT CODEX: one writer per thread; handoff is detach → confirm released → attach', async () => {
      const inst = (i) => { const h = ai.handle(app, ids[i]); return { id: ids[i], driver: 'codex', storeKey: h.storeKey, handle: h }; };
      const A = inst(0); const B = inst(1); const D = inst(6);
      assert.ok(tw.acquire('t-shared', A).ok);
      await A.handle.attachThread('t-shared');
      const refused = tw.acquire('t-shared', B);
      assert.strictEqual(refused.ok, false, 'no competing writer');
      assert.strictEqual(refused.holder, A.id);
      const moved = await tw.handoff('t-shared', A, B);
      assert.ok(moved.ok, moved.why);
      assert.deepStrictEqual(moved.steps, ['detached', 'confirmed released', 'attached']);
      assert.ok(!(await A.handle.loaded()).includes('t-shared') && (await B.handle.loaded()).includes('t-shared'));
      assert.strictEqual(tw.holder(B.storeKey, 't-shared').instanceId, B.id);
      const notHolder = await tw.handoff('t-shared', A, B);
      assert.strictEqual(notHolder.ok, false, 'a non-holder cannot hand over');
      assert.ok(/does not hold|held by/.test(notHolder.why), notHolder.why);
      const wrongStore = await tw.handoff('t-shared', B, D);
      assert.strictEqual(wrongStore.ok, false);
      assert.ok(/same session store/.test(wrongStore.why));
      const stillB = (await B.handle.loaded()).includes('t-shared');
      assert.ok(stillB, 'a refused handoff moves nothing');
      const busy = await ai.disconnect(app, B.id);
      assert.strictEqual(busy.ok, false, 'an account writing to a thread is not pulled out from under it');
      await B.handle.detachThread('t-shared'); tw.release('t-shared', B);
    });

    await test('EIGHT CODEX: rename, refresh and disconnect one account; the other seven do not notice', async () => {
      assert.ok(ai.rename(app, ids[4], 'Work Codex').ok);
      assert.strictEqual(ai.get(app, ids[4]).display_name, 'Work Codex');
      assert.ok((await ai.refresh(app, ids[3])).ok);
      const before = ai.list(app).filter((r) => r.id !== ids[5]).map((r) => [r.id, r.identity.email, r.runtime.pid]);
      const gonePid = ai.get(app, ids[5]).runtime.pid;
      const shadow = ai.handle(app, ids[5]).layout.home;
      const r = await ai.disconnect(app, ids[5]);
      assert.ok(r.ok, r.why);
      assert.ok(r.steps.includes('runtime stopped') && r.steps.includes('shadow home removed'), r.steps.join(' | '));
      assert.ok(await waitFor(() => !alive(gonePid)), 'its process stopped');
      assert.ok(!fs.existsSync(shadow));
      assert.ok(fs.existsSync(path.join(shared, 'sessions', 't-shared.json')), 'removing a shadow never follows its links');
      assert.strictEqual(fs.readFileSync(path.join(shared, 'auth.json'), 'utf8'), OWNER_AUTH);
      const after = ai.list(app).map((x) => [x.id, x.identity.email, x.runtime.pid]);
      assert.deepStrictEqual(after, before, 'seven accounts, unchanged: same identity, same process');
    });
  } finally {
    await ai.stopAll();
    for (const id of ids) { const rec = ai.record(id); if (rec) await ai.disconnect(app, id, { logout: false }).catch(() => {}); }
  }
};
