'use strict';

/**
 * A NATIVE CODEX ACCOUNT IS ITS OWN ROUTE (Phase 8.2) — "Codex · Account 2 ›
 * GPT-6 Sol" is answered by that ChatGPT sign-in, not by whichever one a router
 * picks. Fake Codex only (tests/fixtures/codex/fakeappserver.js: the app-server
 * protocol subset plus `codex exec` — no network, no account, no quota).
 *
 *   LISTED      a signed-in account's models come from Codex's own model/list
 *               (hidden presets stay hidden); they are kept, so the route
 *               exists without a Codex process running
 *   PINNED      two accounts with the SAME email stay two accounts; Chat on the
 *               second runs codex exec in the second's home and nowhere else —
 *               read-only, ephemeral, no user config, outside the project; the
 *               receipt names that account as requested and as used
 *   CODING      the Coding Agent is never routed to it (Chat / BOT only)
 *   SIGNED OUT  an account with no sign-in has no route, and says why
 *   CANCEL      a cancelled request stops the process it started
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
function execLog(home) { try { return fs.readFileSync(path.join(home, 'fake-exec.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }

module.exports = async function () {
  const { App } = require('../../src/app');
  const ai = require('../../src/accountinstances');
  const A = require('../../src/accountcatalog');
  const si = require('../../src/sessionintel');
  const sv = require('../../src/sessionviews');
  const provider = require('../../src/provider');
  const exec = require('../../src/drivers/codexexec');
  const project = tmpdir('codex-route-project-');
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: project });
  app.cfg.accounts = { ...(app.cfg.accounts || {}), codex: { binary: { command: process.execPath, args: [FAKE] } } };
  const saved = process.env.LAIN_PROVIDER;
  delete process.env.LAIN_PROVIDER;
  try { fs.unlinkSync(ai.file()); } catch { /* fresh */ }
  const ids = [];
  const signIn = async (i, who) => {
    const r = ai.add(app, { driver_id: 'codex', display_name: `Codex ${i}`, config: { home_mode: 'direct' } });
    assert.ok(r.ok, r.why);
    ids.push(r.instance.id);
    if (!who) return r.instance.id;
    const h = ai.handle(app, r.instance.id);
    fs.mkdirSync(h.layout.home, { recursive: true });
    fs.writeFileSync(path.join(h.layout.home, 'fake-login.json'), JSON.stringify(who));   // the person, in their browser
    const l = await ai.login(app, r.instance.id);
    assert.ok(l.ok, l.why);
    assert.ok(await waitFor(() => (ai.get(app, r.instance.id) || {}).authentication_state === 'AUTHENTICATED'), 'signed in through Codex\'s own login');
    // THE REFRESH CODEX'S OWN SIGN-IN TRIGGERS is enough: nobody presses Refresh.
    assert.ok(await waitFor(() => { ai.list(app); const rec = ai.record(r.instance.id); return Boolean(rec && rec.signedIn && rec.models && rec.models.length); }), 'its models were kept after sign-in');
    return r.instance.id;
  };

  try {
    await test('CODEX ROUTE — LISTED: a signed-in account\'s own model list (hidden presets stay hidden), kept for when no Codex runs', async () => {
      const one = await signIn(1, { email: 'a@example.com', planType: 'plus', accountId: 'acct-1' });
      const rec = ai.record(one);
      assert.deepStrictEqual(rec.models.map((m) => m.id), ['gpt-6-sol', 'gpt-5.5'], 'Codex\'s own list; "internal-preview" is hidden there and here');
      assert.strictEqual(rec.signedIn, true);
      assert.ok(!/token|secret|"fake":\s*true/i.test(fs.readFileSync(ai.file(), 'utf8')), 'the registry keeps model ids and a flag — no sign-in material');
      await ai.stopAll();   // no Codex process: the route stays
      const acct = A.find(app, one);
      assert.ok(acct, 'the account is listed by its instance id');
      assert.strictEqual(acct.kind, 'runtime'); assert.strictEqual(acct.family, 'codex'); assert.strictEqual(acct.pinned, true);
      assert.strictEqual(acct.usable, true, acct.why);
      assert.deepStrictEqual(acct.routes, [`runtime:codex:${one}`]);
      const ms = A.models(app, one);
      assert.deepStrictEqual(ms.map((m) => m.id).sort(), ['gpt-5.5', 'gpt-6-sol']);
      assert.ok(ms.every((m) => m.chat && !m.coding), 'Chat / BOT only');
      assert.strictEqual(A.modelLabel(app, one, 'gpt-6-sol'), 'GPT-6 Sol', 'Codex\'s own name for it');
    });

    await test('CODEX ROUTE — PINNED: the same email twice is two accounts; Chat on the second runs in the second\'s home only, read-only and outside the project', async () => {
      const two = await signIn(2, { email: 'a@example.com', planType: 'pro', accountId: 'acct-2' });
      const [one] = ids;
      assert.notStrictEqual(one, two);
      assert.ok(A.find(app, one) && A.find(app, two), 'never merged by email');
      const offers = A.offering(app, 'gpt-6-sol').map((a) => a.id);
      assert.ok(offers.includes(one) && offers.includes(two), JSON.stringify(offers));
      const r = await si.choose(app, app.session, { lane: 'chat', account: two, model: 'gpt-6-sol' });
      assert.ok(r.ok, r.why);
      assert.strictEqual(r.lane.account, two); assert.strictEqual(r.lane.route, `runtime:codex:${two}`);
      app.session.thread = 'chat';
      delete app.cfg.connections;   // A PERSON WITH RUNTIME ACCOUNTS ONLY: no API connection configured at all
      const cfg = sv.turnCfg(app, app.session);
      const pc = provider.resolve(cfg);
      assert.ok(!pc.unavailable, JSON.stringify(pc.unavailable));
      assert.strictEqual(pc.runtime, 'codex'); assert.strictEqual(pc.accountId, two); assert.strictEqual(pc.requestedAccount, two);
      assert.strictEqual(pc.routeId, `runtime:codex:${two}`); assert.strictEqual(pc.model, 'gpt-6-sol');
      let text = '';
      for await (const ev of provider.chat(pc, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'which account are you?' }], { trace: { reason: 'turn' } })) if (ev.type === 'text') text += ev.chunk;   // the one text field every transport uses
      assert.strictEqual(text, 'answered by a@example.com (acct-2) on gpt-6-sol', 'the second account answered, on the model chosen');
      const h1 = ai.handle(app, one).layout.home; const h2 = ai.handle(app, two).layout.home;
      assert.strictEqual(execLog(h1).length, 0, 'the first account was not asked');
      const [run] = execLog(h2);
      assert.ok(run, 'codex exec ran in the second account\'s home');
      assert.strictEqual(path.resolve(run.home), path.resolve(h2));
      for (const f of ['--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config']) assert.ok(run.argv.includes(f), `${f} — ${run.argv.join(' ')}`);
      assert.strictEqual(run.argv[run.argv.indexOf('--sandbox') + 1], 'read-only');
      assert.strictEqual(run.argv[run.argv.indexOf('--model') + 1], 'gpt-6-sol');
      assert.strictEqual(path.resolve(run.argv[run.argv.indexOf('--cd') + 1]), path.resolve(exec.workDir()));
      assert.ok(!path.resolve(run.cwd).startsWith(path.resolve(project)), 'never inside the project');
      assert.match(run.prompt, /be brief[\s\S]*which account are you\?/, 'the conversation, flattened, on stdin');
      const rows = require('../../src/usage').read({ from: Date.now() - 60000 });
      const last = rows[rows.length - 1];
      assert.strictEqual(last.account, two); assert.strictEqual(last.requestedAccount, two); assert.strictEqual(last.route, `runtime:codex:${two}`);
      assert.ok(last.output > 0 && last.input > 0, `Codex's own token counts: ${JSON.stringify([last.input, last.output])}`);
    });

    await test('CODEX ROUTE — CODING: the Coding Agent is never routed to a Codex account (it needs tool calls codex exec does not hand back)', async () => {
      const [, two] = ids;
      const r = await si.choose(app, app.session, { lane: 'coding', account: two, model: 'gpt-6-sol' });
      assert.strictEqual(r.ok, false, 'refused');
      assert.ok(r.why && r.why.length > 10, r.why);
    });

    await test('CODEX ROUTE — SIGNED OUT: an account that has not signed in has no route, and says why', async () => {
      const three = await signIn(3, null);
      const acct = A.find(app, three);
      assert.strictEqual(acct.usable, false);
      assert.match(acct.why, /not signed in/);
      const r = A.routeFor(app, three, 'gpt-6-sol');
      assert.strictEqual(r.ok, false);
    });

    await test('CODEX ROUTE — CANCEL: a cancelled request stops the process it started, by its own handle', async () => {
      const [, two] = ids;
      process.env.FAKE_CODEX_SLOW = '1';
      const ctl = new AbortController();
      const pc = { runtime: 'codex', connectionId: `runtime:codex:${two}`, model: 'gpt-6-sol' };
      const before = new Set(require('../../src/runtimeregistry').list().map((x) => x.pid));
      const it = exec.chat(pc, [{ role: 'user', content: 'take your time' }], { app, signal: ctl.signal })[Symbol.asyncIterator]();
      const pending = it.next();
      let pid = null;
      assert.ok(await waitFor(() => { const n = require('../../src/runtimeregistry').list().find((x) => x.purpose === 'runtime:codex-chat' && !before.has(x.pid)); pid = n ? n.pid : null; return Boolean(pid); }), 'registered while it runs');
      ctl.abort();
      const e = await pending.then(() => null, (x) => x);
      assert.ok(e && e.status === 499, e && e.message);
      assert.ok(await waitFor(() => !alive(pid)), 'its process stopped');
    });
  } finally {
    delete process.env.FAKE_CODEX_SLOW;
    if (saved !== undefined) process.env.LAIN_PROVIDER = saved;
    await ai.stopAll();
    for (const id of ids) { if (ai.record(id)) await ai.disconnect(app, id, { logout: false }).catch(() => {}); }
  }
};
