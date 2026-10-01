'use strict';

/**
 * ANTIGRAVITY — several Google accounts behind ONE provider, each in its own private profile (Phase 8.4 hotfix).
 * A fake ACP server (tests/fixtures/antigravity/fakeacp.js) keeps its sign-in in GEMINI_HOME like the real one and
 * records the profile it acted on, whether file credential storage was forced, and whether an ambient Google
 * credential leaked into its environment.
 *
 *   three accounts       each signs in in its OWN profile; B and C never touch A's; identities stay distinct
 *   no ambient credential  LAIN's own GEMINI_API_KEY never reaches an account's server
 *   one provider         Antigravity, once — the models are logical, never "Account 2 · model"
 *   fallback             a limited account hands the SAME task to the next one; provider and model unchanged
 *   the server           installed only on request, only from a verified download
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { test, tmpdir } = require('../helpers');

const FAKE = path.join(__dirname, '..', 'fixtures', 'antigravity', 'fakeacp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(30); } return false; }

module.exports = async function () {
  const { App } = require('../../src/app');
  const A = require('../../src/authsession');
  const ai = require('../../src/accountinstances');
  const ag = require('../../src/drivers/antigravity');
  const F = require('../../src/fabric/index');
  const store = require('../../src/fabric/store');
  const si = require('../../src/sessionintel');
  const fx = require('../harness/fabricfixtures');

  const dir = tmpdir('agy-');
  const LOG = path.join(dir, 'acp.jsonl');
  const saved = { LOG: process.env.FAKE_AGY_LOG, KEY: process.env.GEMINI_API_KEY, GOOG: process.env.GOOGLE_API_KEY };
  process.env.FAKE_AGY_LOG = LOG; process.env.GEMINI_API_KEY = 'ambient-gemini-key'; process.env.GOOGLE_API_KEY = 'ambient-google-key';
  await fx.reset(); A._reset();
  try { fs.unlinkSync(store.file()); } catch { /* fresh */ } store.reset();
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('agy-cwd-') });
  app.cfg.runtimes = { antigravity: { acpBinary: process.execPath, acpArgs: [FAKE] } };
  const log = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  /** Sign in one account. `verify`: also show it answers a test message (a sign-in alone proves an identity, and advertises nothing). */
  async function connect(email, name, { verify = true } = {}) {
    const r = await A.start(app, 'antigravity', { name });
    assert.ok(r.ok, r.why);
    const s = A.get(r.session.id);
    await until(() => s.profile && fs.existsSync(s.profile), 4000);
    fs.writeFileSync(path.join(s.profile, 'fake-login.json'), JSON.stringify({ email }));
    const done = await A.settled(s.id, 20000);
    if (verify && done.state === 'CONNECTED') { const v = await ag.verify(app, s.target); assert.ok(v.ok, v.why); }
    return { s, done };
  }

  try {
    await test('THREE ACCOUNTS: each signs in in its own private profile; B and C never touch A; identities stay distinct', async () => {
      const a = await connect('personal@gmail.com', 'Personal');
      assert.strictEqual(a.done.state, 'CONNECTED', JSON.stringify(a.done));
      const credsA = fs.readFileSync(path.join(a.s.profile, 'oauth_creds.json'));
      const acctsA = fs.readFileSync(path.join(a.s.profile, 'google_accounts.json'));
      const before = log().length;
      const b = await connect('work@gmail.com', 'Work');
      const c = await connect('backup@gmail.com', 'Backup');
      assert.strictEqual(b.done.state, 'CONNECTED', JSON.stringify(b.done)); assert.strictEqual(c.done.state, 'CONNECTED', JSON.stringify(c.done));
      const dirs = [a, b, c].map((x) => path.resolve(x.s.profile).toLowerCase());
      assert.strictEqual(new Set(dirs).size, 3, 'three profiles');
      assert.ok(dirs.every((d) => d.startsWith(path.resolve(ag.accountsRoot()).toLowerCase())), 'all under Noema\'s accounts folder');
      assert.ok(fs.readFileSync(path.join(a.s.profile, 'oauth_creds.json')).equals(credsA) && fs.readFileSync(path.join(a.s.profile, 'google_accounts.json')).equals(acctsA), 'A\'s sign-in is the same bytes');
      const during = log().slice(before);
      assert.ok(!during.some((i) => path.resolve(i.acts_on || '').toLowerCase() === dirs[0]), 'nothing touched A\'s profile while B and C signed in');
      assert.ok(during.every((i) => i.home && !path.resolve(i.home).toLowerCase().startsWith(path.resolve(path.join(os.homedir(), '.gemini')).toLowerCase())), 'nothing was ever signed in inside ~/.gemini');
      // THE BOUNDARY: file credential storage, and no ambient Google credential.
      assert.ok(log().every((i) => i.forceFile === '1'), 'file credential storage was forced for every server');
      assert.ok(log().every((i) => i.ambient.length === 0), `an ambient credential leaked: ${JSON.stringify(log().map((i) => i.ambient))}`);
      assert.ok(fs.existsSync(path.join(a.s.profile, '.lain', 'auth-url.txt')) || a.s.url, 'the sign-in address was captured for the person');
      const fam = F.family(app, 'antigravity');
      assert.strictEqual(fam.accounts.length, 3);
      assert.ok(fam.accounts.every((x) => x.lifecycle === 'CONNECTED'));
      assert.deepStrictEqual(fam.accounts.map((x) => x.identity.email).sort(), ['ba•••@gmail.com', 'pe•••@gmail.com', 'wo•••@gmail.com']);
    });

    await test('ONE PROVIDER: Antigravity once, with logical models — never "Account 2 · model"', () => {
      const fams = F.families(app).filter((f) => f.id === 'antigravity');
      assert.strictEqual(fams.length, 1);
      assert.deepStrictEqual(fams[0].models.map((m) => m.label).sort(), ['Gemini 3.8 Flash', 'Gemini 3.8 Pro']);
      assert.ok(fams[0].models.every((m) => m.accounts.length === 3), 'every account serves each model');
      assert.ok(!JSON.stringify(fams[0].models.map((m) => m.label)).match(/Account|Personal|Work/));
    });

    await test('FALLBACK: a limited account hands the SAME task to the next; provider and model do not change', async () => {
      const recs = ai.records().filter((r) => r.driver_id === 'antigravity');
      const byMail = {}; for (const r of recs) byMail[(require('../../src/accountcatalog').find(app, r.id).identity || {}).email] = r.id;
      const [a, b] = [byMail['personal@gmail.com'], byMail['work@gmail.com']];
      store.setOrder('antigravity', [a, b, byMail['backup@gmail.com']]); store.setPolicy('antigravity', 'auto');
      fs.writeFileSync(path.join(ag.homeFor(a), 'limited.json'), '{}');
      const runs = (id) => { try { return fs.readFileSync(path.join(ag.homeFor(id), 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch { return []; } };
      const [a0, b0] = [runs(a).length, runs(b).length];   // each account already answered its test message
      const r = await si.choose(app, app.session, { lane: 'chat', family: 'antigravity', model: 'gemini-3.8-flash' });
      assert.ok(r.ok, r.why);
      assert.strictEqual(si.lane(app, app.session, 'chat').account, a);
      const sv = require('../../src/sessionviews');
      app.session.thread = 'chat'; app.session._botTurn = true; app.session._botOwnModel = true; sv.views(app.session).active = 'chat';
      await app.submit('Say ok.');
      await sleep(400);
      const l = si.lane(app, app.session, 'chat');
      assert.strictEqual(l.account, b, JSON.stringify(l.pending || l.why));
      assert.deepStrictEqual([l.familyLabel, l.model], ['Antigravity', 'gemini-3.8-flash'], 'provider and model unchanged');
      const ev = store.events({ type: 'fallback' }).slice(-1)[0];
      assert.deepStrictEqual([ev.family, ev.model], ['antigravity', 'gemini-3.8-flash']);
      assert.strictEqual(runs(a).length - a0, 1, 'A was tried once'); assert.ok(runs(b).length > b0, 'B carried on');
      assert.strictEqual(runs(b)[b0].as, 'work@gmail.com', 'as the account it is');
    });

    await test('CANCEL and a SECOND client cannot cross: cancelling a sign-in removes only its half-made profile', async () => {
      const before = ai.records().map((r) => r.id).sort();
      const dirsBefore = fs.readdirSync(ag.accountsRoot()).sort();
      const r = await A.start(app, 'antigravity', { name: 'Spare' });
      assert.ok(r.ok, r.why);
      const s = A.get(r.session.id);
      await until(() => s.profile && fs.existsSync(s.profile), 4000);
      const c = await A.cancel(app, s.id);
      assert.strictEqual(c.session.state, 'CANCELLED');
      assert.deepStrictEqual(ai.records().map((x) => x.id).sort(), before);
      assert.deepStrictEqual(fs.readdirSync(ag.accountsRoot()).sort(), dirsBefore, 'no half-made profile');
    });

    await test('VERIFIED BY EXECUTION: a sign-in advertises nothing; the account\u2019s own answer — a test message or a real request — makes Chat and Assistant available', async () => {
      const F2 = require('../../src/fabric/index');
      const { ROUTES } = require('../../src/harnessapp/routes');
      const u = await connect('unproven@gmail.com', 'Unproven', { verify: false });
      assert.strictEqual(u.done.state, 'CONNECTED');
      const view = () => F2.family(app, 'antigravity').accounts.find((a) => a.instanceId === u.s.target);
      assert.strictEqual(view().verified, false, 'signed in, not yet shown to answer');
      const cat = require('../../src/runtimeconnections').connections(app).find((c) => c.instanceId === u.s.target);
      assert.deepStrictEqual(cat.models.map((m) => m.roles), [[], []], 'no role is advertised on a sign-in alone');
      assert.ok(cat.models.every((m) => !m.roles.includes('AGENT')), 'and Coding is never advertised: no Antigravity tool-using run has been verified');
      // THE TEST MESSAGE, from the window: one real request through THIS account
      const before = log().length;
      const r = await ROUTES['POST /api/intel/verify'](app, { id: u.s.target });
      assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
      assert.strictEqual(view().verified, true);
      assert.ok(cat && require('../../src/runtimeconnections').connections(app).find((c) => c.instanceId === u.s.target).models.every((m) => m.roles.includes('CHAT') && m.roles.includes('BOT') && !m.roles.includes('AGENT')));
      assert.ok(log().length > before, 'a real server process ran the message');
      assert.ok(require('../../src/accountinstances').record(u.s.target).verified_by === 'test');
      // A REAL REQUEST verifies too
      const w = await connect('other@gmail.com', 'Other', { verify: false });
      assert.strictEqual(F2.family(app, 'antigravity').accounts.find((a) => a.instanceId === w.s.target).verified, false);
      let text = '';
      for await (const ev of ag.chat({ instanceId: w.s.target, model: 'gemini-3.8-flash' }, [{ role: 'user', content: 'hello' }], { app })) if (ev.type === 'text') text += ev.chunk;
      assert.ok(text.length > 0);
      assert.strictEqual(F2.family(app, 'antigravity').accounts.find((a) => a.instanceId === w.s.target).verified, true, 'the answer to a real request verified it');
      assert.strictEqual(require('../../src/accountinstances').record(w.s.target).verified_by, 'request');
      // an account that needs no test says so
      const codexish = await ROUTES['POST /api/intel/verify'](app, { id: 'runtime:claude-code' });
      assert.strictEqual(codexish.body.ok, false);
    });

    await test('THE SERVER IS OPTIONAL: without it, connecting signs in over HTTPS; the install stays explicit, verified against its checksum, and refuses a wrong file', async () => {
      const bare = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('agy-bare-') });
      bare.cfg.runtimes = {};
      // NO RUNTIME NEEDED TO CONNECT (2026-10-01, drivers/antigravityapi.js): Google's own sign-in page, no download asked for.
      const none = await A.start(bare, 'antigravity', {});
      assert.strictEqual(none.ok, true, none.why);
      assert.ok(await until(() => Boolean(A.get(none.session.id).url), 5000));
      assert.notStrictEqual(A.get(none.session.id).needs, 'install-acp', 'no 468 MB download is asked for');
      assert.match(A.get(none.session.id).url, /accounts\.google\.com\/o\/oauth2\/v2\/auth|\/o\/oauth2\/v2\/auth/);
      await A.cancel(bare, none.session.id);
      assert.strictEqual((await ag.installServer(bare, {})).ok, false, 'not without confirmation');
      // A LOCAL MIRROR standing in for Google's release address (a configured source, https-only otherwise).
      const stage = tmpdir('agy-zip-'); fs.writeFileSync(path.join(stage, 'agy_acp_server.exe'), 'fake server\n'); fs.writeFileSync(path.join(stage, 'localharness_external.exe'), 'harness\n');
      const zip = path.join(tmpdir('agy-zipout-'), 'server.zip');
      const tarBin = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      cp.execFileSync(tarBin, ['-a', '-c', '-f', zip, '-C', stage, 'agy_acp_server.exe', 'localharness_external.exe'], { windowsHide: true });
      const bytes = fs.readFileSync(zip); const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-length': bytes.length }); res.end(bytes); });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${srv.address().port}/server.zip`;
      try {
        bare.cfg.runtimes = { antigravity: { install: { url, sha256: '0'.repeat(64), exe: 'agy_acp_server.exe' } } };
        assert.ok((await ag.installServer(bare, { confirm: true })).ok);
        assert.ok(await until(() => ag.installStatus(bare).state === 'failed', 15000), JSON.stringify(ag.installStatus(bare)));
        assert.match(ag.installStatus(bare).why, /checksum/);
        assert.ok(!ag.binaryOf(bare.cfg), 'nothing was installed from a file that did not match');
        bare.cfg.runtimes = { antigravity: { install: { url, sha256: sha, exe: 'agy_acp_server.exe' } } };
        assert.ok((await ag.installServer(bare, { confirm: true })).ok);
        assert.ok(await until(() => ag.installStatus(bare).state === 'installed', 20000), JSON.stringify(ag.installStatus(bare)));
        assert.ok(ag.binaryOf(bare.cfg), 'the verified server is installed in Noema\'s own tools folder');
        assert.ok(ag.binaryOf(bare.cfg).command.startsWith(ag.toolsDir()));
      } finally { srv.close(); try { fs.rmSync(ag.toolsDir(), { recursive: true, force: true }); } catch { /* none */ } }
    });
  } finally {
    A._reset();
    for (const [k, v] of Object.entries({ FAKE_AGY_LOG: saved.LOG, GEMINI_API_KEY: saved.KEY, GOOGLE_API_KEY: saved.GOOG })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await fx.reset();
    try { fs.unlinkSync(store.file()); } catch { /* none */ } store.reset();
  }
};
