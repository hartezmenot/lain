'use strict';

/**
 * ACCOUNT ISOLATION — the hotfix acceptance (Phase 8.4).
 *
 * THE FAILURE: Claude had one authenticated account and a coding process working
 * through it. "Add account" signed in against the SAME profile, replaced the
 * first account and interrupted the running task.
 *
 * THE INVARIANT: connecting another account creates an independent AccountInstance
 * and never mutates or interrupts an account (or a running request) that already
 * exists. This file proves it with a fake `claude` that keeps its state in its
 * CLAUDE_CONFIG_DIR, and that RECORDS every invocation with the directory it acted on
 * — so a login against the wrong directory, or a global logout, cannot pass unseen.
 *
 *   A running · B added        A's process is alive, its credentials are the same bytes,
 *                              B signed in in a different directory, no logout ran, no login
 *                              ran anywhere but B's own directory
 *   the default profile        never a target of Add account; Detach never signs it out
 *   cancel                     stops that sign-in only; leaves nothing behind
 *   the same account twice     refused, never merged
 *   a busy account             cannot be detached or signed out from under a request
 *   two accounts               each keeps its own quota and answers as itself
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const { shim } = require('../fixtures/runtimes/shim');

const FAKE = path.join(__dirname, '..', 'fixtures', 'runtimes', 'fakeclaude.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(30); } return false; }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

module.exports = async function () {
  const { App } = require('../../src/app');
  const A = require('../../src/authsession');
  const ai = require('../../src/accountinstances');
  const work = require('../../src/accountwork');
  const cc = require('../../src/drivers/claudecode');
  const ca = require('../../src/drivers/claudeaccount');
  const fx = require('../harness/fabricfixtures');
  const F = require('../../src/fabric/index');

  // ITS OWN CONFIG DIRECTORY: the requests this file makes leave usage receipts, accounts and a fabric registry —
  // none of which may leak into a test that counts the shared home's Claude receipts.
  const savedConfigDir = process.env.LAIN_CONFIG_DIR;
  process.env.LAIN_CONFIG_DIR = tmpdir('authiso-cfg-');
  try { fs.unlinkSync(require('../../src/fabric/store').file()); } catch { /* fresh */ } require('../../src/fabric/store').reset();
  const dir = tmpdir('authiso-');
  const DEFAULT_HOME = path.join(dir, 'default-claude');      // the person's OWN profile (never the real ~/.claude)
  const LOG = path.join(dir, 'invocations.jsonl');
  fs.mkdirSync(DEFAULT_HOME, { recursive: true });
  fs.writeFileSync(path.join(DEFAULT_HOME, '.credentials.json'), JSON.stringify({ fake: true, email: 'default@example.com', subscriptionType: 'pro' }));
  const saved = { HOME: process.env.FAKE_CLAUDE_HOME, LOG: process.env.FAKE_CLAUDE_LOG, CFG: process.env.CLAUDE_CONFIG_DIR };
  process.env.FAKE_CLAUDE_HOME = DEFAULT_HOME; process.env.FAKE_CLAUDE_LOG = LOG; delete process.env.CLAUDE_CONFIG_DIR;

  await fx.reset(); A._reset(); work._reset();
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('authiso-cwd-') });
  const cmd = shim(path.join(dir, 'bin'), 'claude', FAKE);
  app.cfg.runtimes = { 'claude-code': { binary: cmd } };
  const invocations = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const person = async (session, email) => {
    await until(() => session.profile && fs.existsSync(session.profile), 4000);
    fs.writeFileSync(path.join(session.profile, 'fake-login.json'), JSON.stringify({ email, subscriptionType: 'max' }));
  };
  async function connect(email, name) {
    const r = await A.start(app, 'claude', { name });
    assert.ok(r.ok, r.why);
    const s = A.get(r.session.id);
    await until(() => s.profile, 4000);
    await person(s, email);
    const done = await A.settled(s.id, 15000);
    return { session: s, done };
  }

  try {
    await test('ADD ACCOUNT while a request runs: A\'s process, credentials and directory are untouched; B signs in in its OWN directory', async () => {
      const a = await connect('a@example.com', 'Personal');
      assert.strictEqual(a.done.state, 'CONNECTED', JSON.stringify(a.done));
      const aId = a.session.target; const aDir = a.session.profile;
      assert.ok(aDir.startsWith(ca.accountsRoot()), 'a LAIN-owned directory');
      assert.notStrictEqual(path.resolve(aDir).toLowerCase(), path.resolve(DEFAULT_HOME).toLowerCase(), 'never the default profile');

      // A LONG-RUNNING coding request through A.
      const events = [];
      const run = (async () => { for await (const ev of cc.runStream(app, { prompt: 'HOLD this task', mode: 'agent', instanceId: aId, cwd: dir })) events.push(ev.type); return 'finished'; })();
      run.catch(() => {});
      assert.ok(await until(() => fs.existsSync(path.join(aDir, 'runs.jsonl'))), 'the request started in A\'s directory');
      const pid = JSON.parse(fs.readFileSync(path.join(aDir, 'runs.jsonl'), 'utf8').split('\n')[0]).pid;
      assert.ok(alive(pid));
      assert.strictEqual(work.busy('claude-code', aId).length, 1, 'A is marked as working');

      const credsA = fs.readFileSync(path.join(aDir, '.credentials.json'));
      const credsDefault = fs.readFileSync(path.join(DEFAULT_HOME, '.credentials.json'));
      const logBefore = invocations().length;

      // "+ Add account" — B.
      const b = await connect('b@example.com', 'Work');
      assert.strictEqual(b.done.state, 'CONNECTED', JSON.stringify(b.done));
      const bDir = b.session.profile;
      assert.notStrictEqual(path.resolve(bDir).toLowerCase(), path.resolve(aDir).toLowerCase(), 'B has its own directory');

      // WHAT MUST HAVE NOT HAPPENED
      assert.ok(alive(pid), 'A\'s process was never stopped');
      assert.strictEqual(work.busy('claude-code', aId).length, 1, 'A is still working');
      assert.ok(fs.readFileSync(path.join(aDir, '.credentials.json')).equals(credsA), 'A\'s credentials are the same bytes');
      assert.ok(fs.readFileSync(path.join(DEFAULT_HOME, '.credentials.json')).equals(credsDefault), 'the default profile is untouched');
      const during = invocations().slice(logBefore);
      assert.ok(!during.some((i) => i.argv[0] === 'auth' && i.argv[1] === 'logout'), 'no logout ran anywhere');
      const logins = during.filter((i) => i.argv[0] === 'auth' && i.argv[1] === 'login');
      assert.ok(logins.length >= 1 && logins.every((i) => path.resolve(i.cfg || '').toLowerCase() === path.resolve(bDir).toLowerCase()), `every login ran in B's own directory only: ${JSON.stringify(logins.map((l) => l.cfg))}`);
      assert.ok(!during.some((i) => !i.cfg && i.argv[0] === 'auth' && i.argv[1] !== 'status'), 'nothing acted on the default profile');
      assert.ok(!during.some((i) => i.cfg && path.resolve(i.cfg).toLowerCase() === path.resolve(aDir).toLowerCase()), 'nothing at all touched A\'s directory while B signed in');

      // B IS A SECOND CONNECTED ACCOUNT; A is still one.
      const accts = F.family(app, 'claude').accounts;
      const names = accts.map((x) => x.id);
      assert.ok(names.includes(aId) && names.includes(b.session.target), JSON.stringify(names));
      assert.ok(accts.every((x) => x.lifecycle === 'CONNECTED'));

      // THE RUN FINISHES AS A — release it.
      fs.writeFileSync(path.join(aDir, 'release'), '1');
      assert.strictEqual(await run, 'finished', 'A\'s request completed');
      assert.ok(events.includes('finish'), events.join(','));
      assert.ok(await until(() => work.busy('claude-code', aId).length === 0), 'and A is idle again');
    });

    await test('TWO ACCOUNTS: each answers as itself and keeps its OWN quota — nothing merged in Core', async () => {
      const ids = ai.records().filter((r) => r.driver_id === 'claude-code').map((r) => r.id);
      assert.strictEqual(ids.length, 2);
      const [x, y] = ids;
      // THE BOT'S PATH, as a route names it: runtime:claude-code:<instance> — the account comes from the route, never a default.
      const ask = async (id) => { const t = []; for await (const ev of cc.chat({ model: 'claude-code/opus', connectionId: `runtime:claude-code:${id}` }, [{ role: 'user', content: 'hello' }], { app, cwd: dir })) if (ev.type === 'text') t.push(ev.chunk); return t; };
      const one = await ask(x); const two = await ask(y);
      assert.match(one.join(''), /\[as a@example\.com\]/); assert.match(two.join(''), /\[as b@example\.com\]/);
      const ra = require('../../src/runtimeadapters');
      assert.ok(ra.cachedTelemetry(`claude-code--${x}`) && ra.cachedTelemetry(`claude-code--${y}`), 'a telemetry record per account');
      const fam = F.family(app, 'claude');
      assert.ok(fam.accounts.filter((a) => a.id === x || a.id === y).every((a) => a.quota.length >= 1), 'each account reports its own windows');
    });

    await test('CANCEL: stops that sign-in only and leaves nothing behind; every other account is exactly as it was', async () => {
      const before = ai.records().map((r) => r.id).sort();
      const dirsBefore = fs.readdirSync(ca.accountsRoot()).sort();
      const r = await A.start(app, 'claude', { name: 'Spare' });
      assert.ok(r.ok, r.why);
      const s = A.get(r.session.id);
      await until(() => s.profile && fs.existsSync(s.profile), 4000);
      assert.ok(alive(s.pid), 'the login process runs');
      const other = ai.records().filter((x) => x.driver_id === 'claude-code')[0];
      const c = await A.cancel(app, s.id);
      assert.strictEqual(c.session.state, 'CANCELLED');
      assert.ok(await until(() => !alive(s.pid)), 'that login process is gone');
      assert.deepStrictEqual(ai.records().map((x) => x.id).sort(), before, 'no half-made account remains');
      assert.deepStrictEqual(fs.readdirSync(ca.accountsRoot()).sort(), dirsBefore, 'and no half-made profile directory');
      assert.ok(fs.existsSync(path.join(ca.homeFor(other.id), '.credentials.json')), 'the other accounts kept their sign-ins');
    });

    await test('THE SAME ACCOUNT TWICE is refused and cleaned up — never merged, never a duplicate row', async () => {
      const before = ai.records().length;
      const dup = await connect('a@example.com', 'Again');   // signs in as A's identity
      assert.strictEqual(dup.done.state, 'FAILED', JSON.stringify(dup.done));
      assert.match(dup.done.why, /already connected/i);
      assert.strictEqual(ai.records().length, before, 'no third account');
    });

    await test('DEFAULT PROFILE: a LAIN-owned account can never be pointed at it, and Detach of an adopted profile signs nothing out', async () => {
      assert.match(ca.driver.validate({ ownership: 'lain', home: DEFAULT_HOME }), /accounts folder|default/);
      assert.match(ca.driver.validate({ ownership: 'lain', home: path.join(dir, 'elsewhere') }), /accounts folder/);
      // ADOPT the person's own profile as an external_native account, then Detach it.
      const added = ai.add(app, { driver_id: 'claude-code', display_name: 'Mine', config: { ownership: 'external_native', home: DEFAULT_HOME } });
      assert.ok(added.ok, added.why);
      const id = added.instance.id;
      assert.strictEqual(added.instance.ownership, 'external_native');
      const logBefore = invocations().length;
      const credsDefault = fs.readFileSync(path.join(DEFAULT_HOME, '.credentials.json'));
      const d = await ai.disconnect(app, id, {});
      assert.ok(d.ok, d.why);
      assert.ok(fs.readFileSync(path.join(DEFAULT_HOME, '.credentials.json')).equals(credsDefault), 'Detach did not sign the profile out');
      assert.ok(!invocations().slice(logBefore).some((i) => i.argv[1] === 'logout'), 'no logout was run');
      assert.ok(fs.existsSync(DEFAULT_HOME), 'and the directory is still there');
    });

    await test('A BUSY ACCOUNT cannot be detached or signed out from under its request; a LAIN-owned one signs out only in ITS directory', async () => {
      const recs = ai.records().filter((r) => r.driver_id === 'claude-code');
      const [x, y] = recs.map((r) => r.id);
      const xDir = ca.homeFor(x);
      const run = (async () => { for await (const ev of cc.runStream(app, { prompt: 'HOLD again', mode: 'agent', instanceId: x, cwd: dir })) void ev; return 'ok'; })();
      run.catch(() => {});
      assert.ok(await until(() => work.busy('claude-code', x).length === 1));
      const blocked = await ai.disconnect(app, x, { logout: true });
      assert.strictEqual(blocked.ok, false); assert.strictEqual(blocked.busy, true);
      assert.ok(fs.existsSync(path.join(xDir, '.credentials.json')), 'still signed in');
      fs.writeFileSync(path.join(xDir, 'release'), '1'); await run;
      assert.ok(await until(() => work.busy('claude-code', x).length === 0));
      // Y is idle: sign it out — its OWN directory only.
      const yDir = ca.homeFor(y);
      const logBefore = invocations().length;
      const out = await ai.disconnect(app, y, { logout: true, removeProfile: true });
      assert.ok(out.ok, out.why);
      const logouts = invocations().slice(logBefore).filter((i) => i.argv[1] === 'logout');
      assert.deepStrictEqual(logouts.map((l) => path.resolve(l.cfg).toLowerCase()), [path.resolve(yDir).toLowerCase()], 'the provider\'s sign-out ran in that account\'s directory only');
      assert.ok(!fs.existsSync(yDir), 'its LAIN-made profile is removed');
      assert.ok(fs.existsSync(path.join(xDir, '.credentials.json')), 'the other account is signed in as before');
    });

    await test('SWITCH WHILE RUNNING: the choice waits for the request to finish — nothing is cut off — and applies at the turn boundary', async () => {
      const si = require('../../src/sessionintel');
      const [xRec] = ai.records().filter((r) => r.driver_id === 'claude-code');
      const x = xRec.id; const xDir = ca.homeFor(x);
      const other = await connect('c@example.com', 'Spare');
      assert.strictEqual(other.done.state, 'CONNECTED', JSON.stringify(other.done));
      const y = other.session.target;
      const modelId = F.family(app, 'claude').models.find((m) => /opus/i.test(m.id)).id;
      const first = await si.choose(app, app.session, { lane: 'chat', family: 'claude', account: x, model: modelId });
      assert.ok(first.ok, first.why);
      assert.strictEqual(si.lane(app, app.session, 'chat').account, x);
      const runsOf = () => { try { return fs.readFileSync(path.join(xDir, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
      const seen = runsOf().length;
      try { fs.unlinkSync(path.join(xDir, 'release')); } catch { /* an earlier test's release */ }
      const run = (async () => { for await (const ev of cc.runStream(app, { prompt: 'HOLD to switch', mode: 'agent', instanceId: x, cwd: dir })) void ev; return 'ok'; })();
      run.catch(() => {});
      assert.ok(await until(() => work.busy('claude-code', x).length >= 1 && runsOf().length > seen));
      const pid = JSON.parse(runsOf().pop()).pid;
      const r = await si.choose(app, app.session, { lane: 'chat', account: y });
      assert.strictEqual(r.ok, true); assert.strictEqual(r.deferred, true, 'deferred, not applied');
      const l = si.lane(app, app.session, 'chat');
      assert.strictEqual(l.account, x, 'the lane still uses the account the request started on');
      assert.ok(l.switchPending && l.switchPending.account === y, 'and says a switch is waiting');
      assert.ok(alive(pid), 'the running process was not touched');
      fs.writeFileSync(path.join(xDir, 'release'), '1'); await run;
      assert.ok(await until(() => work.busy('claude-code', x).length === 0));
      await si.applyPending(app, app.session);   // (what submitclose.after does at the end of the turn)
      const after = si.lane(app, app.session, 'chat');
      assert.strictEqual(after.account, y, 'applied at the boundary');
      assert.strictEqual(after.switchPending, null);
      assert.deepStrictEqual([after.familyLabel, after.model], [l.familyLabel, l.model], 'the provider and model names did not change');
    });

    await test('CLAUDE FALLBACK: a limited account hands the SAME task to the next; provider and model names do not change', async () => {
      const si = require('../../src/sessionintel');
      const store = require('../../src/fabric/store');
      const [x, y] = ai.records().filter((r) => r.driver_id === 'claude-code').map((r) => r.id);
      const modelId = F.family(app, 'claude').models.find((m) => /opus/i.test(m.id)).id;
      store.setOrder('claude', [x, y]); store.setPolicy('claude', 'auto');
      const rm = (id) => { try { fs.unlinkSync(path.join(ca.homeFor(id), 'release')); } catch { /* none */ } };
      rm(x); rm(y);
      fs.writeFileSync(path.join(ca.homeFor(x), 'limited.json'), '{}');
      const r = await si.choose(app, app.session, { lane: 'chat', family: 'claude', account: x, model: modelId });
      assert.ok(r.ok, r.why);
      const sv = require('../../src/sessionviews');
      app.session.thread = 'chat'; app.session._botTurn = true; app.session._botOwnModel = true; sv.views(app.session).active = 'chat';
      const before = si.lane(app, app.session, 'chat');
      await app.submit('Say ok.');
      await sleep(500);
      const l = si.lane(app, app.session, 'chat');
      assert.strictEqual(l.account, y, JSON.stringify(l.pending || l.why));
      assert.deepStrictEqual([l.familyLabel, l.model], [before.familyLabel, before.model], 'the provider and model names are the same');
      const runs = (id) => { try { return fs.readFileSync(path.join(ca.homeFor(id), 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((z) => JSON.parse(z)); } catch { return []; } };
      assert.ok(runs(x).some((z) => z.limited), 'X was tried and said it was limited');
      assert.ok(runs(y).some((z) => !z.limited), 'Y carried on');
      try { fs.unlinkSync(path.join(ca.homeFor(x), 'limited.json')); } catch { /* none */ }
    });

    await test('CODEX: connecting B never rewrites A\'s auth, never touches its app-server, and never writes into the shared home', async () => {
      await fx.reset();
      const shared = tmpdir('authiso-codex-shared-');
      const OWNER = JSON.stringify({ fake: true, email: 'owner@home.example', accountId: 'acct-owner' });
      fs.writeFileSync(path.join(shared, 'auth.json'), OWNER);
      fs.writeFileSync(path.join(shared, 'config.toml'), 'model = "gpt-5"\n');
      app.cfg.accounts = { ...(app.cfg.accounts || {}), codex: { shared_home: shared } };
      process.env.FAKE_CODEX_LOGIN_WAIT_MS = '15000';
      try {
        const [acctA] = await fx.codexAccounts(app, [{ name: 'Personal', email: 'a@codex.example', models: [{ id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6 Sol', hidden: false, isDefault: true, supportedReasoningEfforts: [] }] }]);
        const hA = ai.handle(app, acctA.id);
        const homeA = fx.homeOf(app, acctA.id);
        const authA = fs.readFileSync(path.join(homeA, 'auth.json'));
        const pidA = hA.current().pid;
        assert.ok(pidA && alive(pidA), 'A\'s app-server is running');
        const sharedBefore = fs.readdirSync(shared).sort();

        const r = await A.start(app, 'codex', { name: 'Work' });
        assert.ok(r.ok, r.why);
        const s = A.get(r.session.id);
        assert.strictEqual(r.session.state, 'AWAITING_BROWSER');
        assert.ok(/^https:\/\/auth\.openai\.com\//.test(r.session.url), 'Codex\'s own sign-in page');
        assert.notStrictEqual(s.target, acctA.id, 'a NEW instance');
        const homeB = fx.homeOf(app, s.target);
        assert.notStrictEqual(path.resolve(homeB).toLowerCase(), path.resolve(homeA).toLowerCase());
        fs.writeFileSync(path.join(homeB, 'fake-login.json'), JSON.stringify({ email: 'b@codex.example', planType: 'pro', accountId: 'acct-b' }));
        const done = await A.settled(s.id, 20000);
        assert.strictEqual(done.state, 'CONNECTED', JSON.stringify(done));

        assert.ok(fs.readFileSync(path.join(homeA, 'auth.json')).equals(authA), 'A\'s auth.json is the same bytes');
        assert.strictEqual(hA.current().pid, pidA, 'A\'s app-server was not restarted');
        assert.ok(alive(pidA), 'and is still running');
        assert.ok(fs.readFileSync(path.join(shared, 'auth.json'), 'utf8') === OWNER, 'the shared home\'s own sign-in is untouched');
        assert.deepStrictEqual(fs.readdirSync(shared).sort(), sharedBefore, 'nothing was created in the shared home');
        const stB = fs.lstatSync(path.join(homeB, 'auth.json'));
        assert.ok(stB.isFile() && !stB.isSymbolicLink(), 'B\'s auth is a file of its own — never a link to anyone else\'s');
        const emails = F.family(app, 'codex').accounts.map((a) => a.identity.email).sort();
        assert.strictEqual(emails.length, 2); assert.ok(emails.every((e) => /•••/.test(e)), 'two accounts, identities masked');
      } finally { delete process.env.FAKE_CODEX_LOGIN_WAIT_MS; await fx.reset(); }
    });
  } finally {
    A._reset(); work._reset();
    for (const [k, v] of Object.entries({ FAKE_CLAUDE_HOME: saved.HOME, FAKE_CLAUDE_LOG: saved.LOG, CLAUDE_CONFIG_DIR: saved.CFG })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await fx.reset();
    try { fs.unlinkSync(require('../../src/fabric/store').file()); } catch { /* none */ } require('../../src/fabric/store').reset();
    if (savedConfigDir === undefined) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = savedConfigDir;
    require('../../src/fabric/store').reset();
  }
};
