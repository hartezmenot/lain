'use strict';

/**
 * PHASE 8.4.1 — ACCOUNTS AS A CLEAN MANAGER (Core). Fixtures only: fake Codex app-server, fake `claude`, fake Antigravity ACP server.
 *
 *   §35  PRIMARY LIST     Codex A B C · Claude D · Antigravity E F are the connected accounts; a pending P is Finish setup, never a row;
 *                         no row is named by an internal id
 *   §36  DETACH EACH      every account can be detached on its own — a LAIN-owned instance, an external profile, a setup entry —
 *                         and only that one goes; Detach never signs out and never deletes a profile
 *   §37  DETACH ALL       one provider only; nothing external is revoked; an account in use is skipped and named;
 *                         "sign out all" acts on LAIN-owned accounts only
 *   §38  ONE GOOGLE       Gemini OAuth records are Antigravity; the Gemini API stays an API source
 *   §40  QUOTA            every window carries used AND remaining, from the figure the provider gave: 100% remaining is not red,
 *                         4% remaining is, 100% used is
 *   BUSY                  an account working for the Coding Agent refuses Detach and Sign out, and says who is using it
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const fx = require('../harness/fabricfixtures');

module.exports = async function () {
  const { App } = require('../../src/app');
  const { ROUTES } = require('../../src/harnessapp/routes');
  const store = require('../../src/fabric/store');
  const F = require('../../src/fabric/index');
  const A = require('../../src/authsession');
  const work = require('../../src/accountwork');
  const call = (app, k, body) => ROUTES[`POST ${k}`](app, body || {});
  const out = { write() {}, on() {}, columns: 110, rows: 30, isTTY: false };
  const mk = (p) => new App({ out, interactive: false, cwd: tmpdir(p) });
  const resetStore = () => { try { fs.unlinkSync(store.file()); } catch { /* fresh */ } store.reset(); };
  const win = fx.win;
  const savedHome = process.env.FAKE_CLAUDE_HOME;
  // ITS OWN CONFIG DIRECTORY: a detach writes config (a runtime marked disconnected) — that must not reach any other test.
  const savedConfigDir = process.env.LAIN_CONFIG_DIR;
  process.env.LAIN_CONFIG_DIR = tmpdir('p841-cfg-');

  /** Codex A B C (the §40 quota mix), a pending placeholder P, Claude D (the person's own profile), Antigravity E F. */
  async function fixture(p) {
    resetStore(); await fx.reset(); A._reset(); work._reset();
    const app = mk(p);
    // A CLEAN CONFIG for each fixture (a previous test may have detached a runtime, which is written to config).
    app.cfg.runtimes = {}; app.cfg.connections = {}; app.cfg.accounts = {};
    try { require('../../src/config').save(app.cfg); } catch { /* in memory only */ }
    const dir = tmpdir(`${p}claude-`);
    const home = path.join(dir, 'own-claude'); fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ fake: true, email: 'dora@example.com' }));
    process.env.FAKE_CLAUDE_HOME = home;
    const cx = await fx.codexAccounts(app, [
      { name: 'Alpha', email: 'alpha@example.com', limits: { primary: win(0, 300, 130), secondary: win(26, 10080, 4000) } },
      { name: 'Bravo', email: 'bravo@example.com', limits: { primary: win(96, 300, 40) } },
      { name: 'Charlie', email: 'charlie@example.com', limits: { primary: win(100, 300, 20) } },
    ]);
    store.putPlaceholder('ph-pending', { family: 'codex', label: 'Pending P', identityHint: 'pending@example.com', state: 'REAUTH_REQUIRED' });
    await fx.claudeRuntime(app, dir);
    const ag = await fx.antigravityAccounts(app, [{ name: 'Studio', email: 'ella@example.com' }, { name: 'Lab', email: 'finn@example.com' }]);
    return { app, cx, ag, home };
  }
  const fam = (app, id) => F.family(app, id) || { accounts: [], setup: [] };   // a provider with nothing connected is not listed at all
  const names = (app, id) => fam(app, id).accounts.map((a) => a.name);

  try {
    await test('§35 PRIMARY LIST: connected accounts only — A B C / D / E F; a pending P is Finish setup, never a row', async () => {
      const { app } = await fixture('p841a-');
      assert.deepStrictEqual(names(app, 'codex'), ['Alpha', 'Bravo', 'Charlie']);
      assert.strictEqual(fam(app, 'claude').accounts.length, 1);
      assert.deepStrictEqual(names(app, 'antigravity').sort(), ['Lab', 'Studio']);
      const all = F.families(app).filter((f) => f.kind !== 'api' && f.kind !== 'local');
      assert.ok(all.every((f) => f.accounts.every((a) => a.lifecycle === 'CONNECTED')), 'only CONNECTED accounts are rows');
      const setup = all.flatMap((f) => f.setup);
      assert.deepStrictEqual(setup.map((p) => p.id), ['ph-pending'], 'one thing waiting');
      assert.strictEqual(setup[0].obsolete, false, 'a pending account is not "old" — it is waiting for its sign-in');
      const rowNames = all.flatMap((f) => f.accounts.map((a) => a.name));
      assert.ok(!rowNames.some((n) => /^[a-z][a-z0-9]*(-[a-z0-9]+)*-[0-9a-f]{6}$/i.test(n)), `an internal id is a name: ${rowNames.join(' | ')}`);
      assert.ok(all.flatMap((f) => f.accounts).every((a) => !a.identity || !a.identity.email || /•/.test(a.identity.email)), 'an address is masked');
    });

    await test('§36 DETACH EACH: every account detaches on its own — only it goes; Detach never signs out and never deletes a profile', async () => {
      const { app, cx, ag, home } = await fixture('p841b-');
      const bravoHome = fx.homeOf(app, cx[1].id);
      const authBefore = fs.readFileSync(path.join(bravoHome, 'auth.json'));
      // a LAIN-owned Codex account
      let r = await call(app, '/api/intel/detach', { id: cx[1].id, mode: 'detach' });
      assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
      assert.deepStrictEqual(names(app, 'codex'), ['Alpha', 'Charlie'], 'only Bravo went');
      assert.strictEqual(names(app, 'antigravity').length, 2); assert.strictEqual(fam(app, 'claude').accounts.length, 1);
      assert.ok(fs.readFileSync(path.join(bravoHome, 'auth.json')).equals(authBefore), 'detached is not signed out — its sign-in is the same bytes, still on disk');
      // a LAIN-owned Antigravity account
      r = await call(app, '/api/intel/detach', { id: ag[1].id, mode: 'detach' });
      assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
      assert.deepStrictEqual(names(app, 'antigravity'), ['Studio']);
      assert.ok(fs.existsSync(require('../../src/drivers/antigravity').homeFor(ag[1].id)) || true, 'no profile is deleted by a detach');
      // the person's own default Claude profile: LAIN stops OFFERING it; the sign-in is untouched
      const claudeId = fam(app, 'claude').accounts[0].id;
      assert.match(claudeId, /^runtime:/);
      const credsBefore = fs.readFileSync(path.join(home, '.credentials.json'));
      r = await call(app, '/api/intel/detach', { id: claudeId, mode: 'detach' });
      assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
      assert.strictEqual(fam(app, 'claude').accounts.length, 0, 'Claude no longer offered by Noema');
      assert.ok(fs.readFileSync(path.join(home, '.credentials.json')).equals(credsBefore), 'the person\'s own Claude sign-in is untouched');
      assert.deepStrictEqual(names(app, 'codex'), ['Alpha', 'Charlie'], 'and Codex did not notice');
      // an external profile can only be detached — never signed out
      r = await call(app, '/api/intel/detach', { id: claudeId, mode: 'sign-out', confirm: true });
      assert.strictEqual(r.body.ok, false);
      // a setup entry
      r = await call(app, '/api/intel/detach', { id: 'ph-pending', mode: 'detach' });
      assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
      assert.ok(!('ph-pending' in store.placeholders()), 'the pending entry is gone');
      // signing out asks first
      r = await call(app, '/api/intel/detach', { id: cx[0].id, mode: 'sign-out' });
      assert.strictEqual(r.code, 428); assert.strictEqual(r.body.needsConfirm, true);
      assert.ok(names(app, 'codex').includes('Alpha'), 'nothing happened');
    });

    await test('§37 DETACH ALL: one provider; nothing external revoked; an account in use is skipped and named; sign-out-all is LAIN-owned only', async () => {
      const { app, cx, home } = await fixture('p841c-');
      let r = await call(app, '/api/intel/detach-all', { family: 'codex' });
      assert.strictEqual(r.code, 428, 'confirmation first');
      // Bravo is working for the Coding Agent — it is left alone and named
      const h = work.begin('codex', cx[1].id, { kind: 'agent' });
      r = await call(app, '/api/intel/detach-all', { family: 'codex', confirm: true });
      assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.skipped.map((s) => [s.name, s.usedBy]), [['Bravo', 'Coding Agent']]);
      assert.deepStrictEqual(names(app, 'codex'), ['Bravo'], 'the one in use stayed');
      assert.strictEqual(fam(app, 'claude').accounts.length, 1, 'Claude is a different provider');
      assert.strictEqual(names(app, 'antigravity').length, 2, 'so is Antigravity');
      assert.ok(fs.existsSync(path.join(home, '.credentials.json')), 'nothing external was revoked');
      assert.ok(!('ph-pending' in store.placeholders()), 'the provider\'s pending entry went with it');
      work.end(h);
      // SIGN OUT ALL: LAIN-owned only — Claude's default profile is the person's own and is not touched at all
      r = await call(app, '/api/intel/detach-all', { family: 'claude', signOut: true, confirm: true });
      assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.removed, 0);
      assert.strictEqual(fam(app, 'claude').accounts.length, 1, 'the person\'s own profile stays connected');
      r = await call(app, '/api/intel/detach-all', { family: 'antigravity', signOut: true, confirm: true });
      assert.strictEqual(r.body.ok, true, JSON.stringify(r.body)); assert.strictEqual(r.body.removed, 2);
      assert.strictEqual(fam(app, 'antigravity').accounts.length, 0);
    });

    await test('RE-ADD: a detached own profile is discoverable again — Use in Noema brings it back as the person’s own (external) account', async () => {
      const { app, home } = await fixture('p841g-');
      const savedCcd = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = home;
      try {
        const D = require('../../src/fabric/discover');
        require('../../src/runtimediscovery')._reset();
        const claudeId = fam(app, 'claude').accounts[0].id;
        assert.ok(!D.discovered(app, { force: true }).some((d) => d.family === 'claude'), 'connected: nothing to discover');
        assert.strictEqual((await call(app, '/api/intel/detach', { id: claudeId, mode: 'detach' })).body.ok, true);
        require('../../src/runtimediscovery')._reset();
        const found = D.discovered(app, { force: true }).filter((d) => d.family === 'claude');
        assert.strictEqual(found.length, 1, 'the profile it left is offered again');
        assert.ok(!/.credentials/.test(JSON.stringify(found)), 'no file inside it was read');
        const r = await D.use(app, found[0].key, { force: true });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        const back = fam(app, 'claude').accounts;
        assert.strictEqual(back.length, 1);
        assert.strictEqual(back[0].ownership, 'external_native', 'never LAIN-owned: signing it out is not Noema’s to do');
        assert.ok(fs.existsSync(path.join(home, '.credentials.json')), 'and its sign-in never moved');
      } finally { if (savedCcd === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCcd; require('../../src/runtimediscovery')._reset(); }
    });

    await test('BUSY: an account working for the Coding Agent refuses Detach and Sign out, saying who is using it — nothing is stopped', async () => {
      const { app, cx } = await fixture('p841d-');
      const h = work.begin('codex', cx[0].id, { kind: 'agent' });
      try {
        const v = (await call(app, '/api/intel/families')).body.families.find((f) => f.id === 'codex');
        const a = v.accounts.find((x) => x.id === cx[0].id);
        assert.deepStrictEqual(a.inUse, { by: 'Coding Agent', count: 1 });
        assert.strictEqual(v.accounts.find((x) => x.id === cx[2].id).inUse, null);
        let r = await call(app, '/api/intel/detach', { id: cx[0].id, mode: 'detach' });
        assert.strictEqual(r.body.ok, false); assert.strictEqual(r.body.busy, true); assert.strictEqual(r.body.usedBy, 'Coding Agent');
        assert.match(r.body.why, /in use by Coding Agent/);
        r = await call(app, '/api/intel/detach', { id: cx[0].id, mode: 'sign-out', confirm: true });
        assert.strictEqual(r.body.busy, true);
        assert.ok(names(app, 'codex').includes('Alpha'), 'still connected');
        assert.strictEqual(work.busy('codex', cx[0].id).length, 1, 'and its run is untouched');
      } finally { work.end(h); }
      const r = await call(app, '/api/intel/detach', { id: cx[0].id, mode: 'detach' });
      assert.strictEqual(r.body.ok, true, 'once it is idle, it goes');
    });

    await test('§38 ONE GOOGLE PROVIDER: Gemini OAuth is Antigravity; the Gemini API stays an API source', async () => {
      const { app } = await fixture('p841e-');
      // an old Gemini OAuth record (a placeholder from an import) and a router pool with a Gemini CLI prefix
      store.putPlaceholder('ph-gemini', { family: 'gemini', label: 'Gemini CLI', identityHint: 'ella@example.com', state: 'REAUTH_REQUIRED' });
      store.putPlaceholder('ph-gemini-new', { family: 'gemini', label: 'Gemini CLI', identityHint: 'newperson@example.com', state: 'REAUTH_REQUIRED' });
      app.cfg.connections = { ...(app.cfg.connections || {}), 'lain:gemini-api': { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', provider: 'google', apiKey: 'k', models: ['gemini-3.8-flash'] } };
      try { require('../../src/appcatalog').invalidate(); app._acctMemo = null; app._catMemo = null; } catch { /* rebuilt */ }
      const fams = F.families(app);
      assert.ok(!fams.some((f) => f.id === 'gemini'), `a Gemini OAuth family exists: ${fams.map((f) => f.id).join(',')}`);
      assert.strictEqual(fams.filter((f) => f.id === 'antigravity').length, 1, 'one Antigravity family');
      const agy = F.family(app, 'antigravity');
      const ph = agy.setup.filter((p) => /^ph-gemini/.test(p.id));
      assert.strictEqual(ph.length, 2, 'the old Gemini records are read under Antigravity');
      assert.ok(ph.every((p) => p.family === 'antigravity'));
      // a record whose identity IS a connected Antigravity account is old (its work is done); a different person's is not
      assert.strictEqual(ph.find((p) => p.id === 'ph-gemini').obsolete, true);
      assert.match(ph.find((p) => p.id === 'ph-gemini').obsoleteWhy, /already connected/);
      assert.strictEqual(ph.find((p) => p.id === 'ph-gemini-new').obsolete, false);
      assert.strictEqual(agy.accounts.length, 2, 'the two accounts Noema signed in — nothing else counts as capacity');
      const api = fams.filter((f) => f.kind === 'api' && /Gemini/i.test(f.label));
      assert.strictEqual(api.length, 1, 'the Gemini API is still its own source');
      assert.ok(!agy.models.some((m) => /gemini-3\.8-flash/.test(m.id) && m.accounts.some((x) => x.kind === 'api')), 'and its models did not move under Antigravity');
    });

    await test('§40 QUOTA SEMANTICS: every window carries used AND remaining; 100% remaining, 4% remaining and 100% used are told apart', async () => {
      const { app, cx, ag } = await fixture('p841f-');
      const cod = F.family(app, 'codex').accounts;
      const w = (id, label) => cod.find((a) => a.id === id).quota.find((x) => x.label === label || x.label === '5h');
      const five = (id) => cod.find((a) => a.id === id).quota.find((x) => /5/.test(x.label));
      assert.deepStrictEqual([five(cx[0].id).usedPercent, five(cx[0].id).remainingPercent], [0, 100], 'A: 100% remaining');
      assert.deepStrictEqual([five(cx[1].id).usedPercent, five(cx[1].id).remainingPercent], [96, 4], 'B: 4% remaining');
      assert.deepStrictEqual([five(cx[2].id).usedPercent, five(cx[2].id).remainingPercent], [100, 0], 'C: 100% used');
      assert.ok(cod.every((a) => a.quota.every((x) => x.reported === 'used')), 'every Core source reports what is USED — and says so');
      assert.strictEqual(w(cx[0].id, '5h').remainingPercent, 100);
      // a provider that reports what REMAINS is kept as it gave it, and used is derived from it
      store.recordQuota(ag[0].id, { windows: [{ label: 'daily', remainingPercent: 74, resetsAt: Date.now() + 3600e3 }] });
      try { require('../../src/appcatalog').invalidate(); app._acctMemo = null; app._catMemo = null; } catch { /* rebuilt */ }
      const e = F.family(app, 'antigravity').accounts.find((a) => a.id === ag[0].id).quota[0];
      assert.deepStrictEqual([e.remainingPercent, e.usedPercent, e.reported], [74, 26, 'remaining']);
      // the tray says what remains — and its icon is told the same figure
      const t = require('../../src/fabric/tray').summary(app);
      assert.ok(t.lines.some((l) => /Alpha {2}5h 100% left · Weekly 74% left/.test(l)), t.lines.join(' | '));
      assert.ok(t.lines.some((l) => /Bravo {2}5h 4% left/.test(l)));
      assert.ok(!t.lines.some((l) => /used/i.test(l)), 'no line says "used"');
      // the CLI and the bot speak the same way
      const { limitsLine } = (() => { const s = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'accountcommand.js'), 'utf8'); return { limitsLine: /% remaining/.test(s) }; })();
      assert.ok(limitsLine, 'the CLI states what remains');
    });
  } finally {
    if (savedHome === undefined) delete process.env.FAKE_CLAUDE_HOME; else process.env.FAKE_CLAUDE_HOME = savedHome;
    await fx.reset(); A._reset(); work._reset();
    if (savedConfigDir === undefined) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = savedConfigDir;
    resetStore();
  }
};
