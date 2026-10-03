'use strict';

/**
 * PHASE 8.3 — THE UNIFIED INTELLIGENCE FABRIC (part 1). Fixtures only: three
 * real Codex account instances, each with its own home, run by the fake
 * `codex app-server` / `codex exec` (tests/harness/fabricfixtures.js), stand in
 * for three backing accounts of ONE provider family. No real account, no real
 * quota, no real provider. (8.4: an imported router pool is metadata, never
 * capacity, so it can no longer stand in for an account.)
 *
 *   FAMILY        one Codex, three backing accounts — never "Codex Account 3 › GPT-6 Sol"
 *   AUTO          A limited mid-task → the same task continues on B: same session,
 *                 task, model, effort, execution; only the backing account changes
 *   PINNED        A limited → nothing goes to B; Switch account · Wait · Choose another model
 *   ASK           A limited → B proposed; nothing is sent through B until Switch
 *   INCOMPATIBLE  no other account serves the model at that effort → asked, never downgraded
 *   EFFORT        per model: High/XHigh · Low/Medium/High · none — exactly; no other level reaches transport
 *   EXECUTION     Normal/Fast/Eco toggles; effort ≠ execution
 *   PARITY        CLI, Harness, IDE, Telegram say Codex › GPT 6 Sol › XHigh › Fast — before and after a fallback
 *   SERVE         lain/<provider>/<model>; policy underneath; no identity exposed
 *   CLI           /account and /model manage the same fabric; /api never takes a key
 *   FREEBUFF      gone
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { test, tmpdir } = require('../helpers');

const fx = require('../harness/fabricfixtures');

/** GPT-6 Sol as the fake Codex lists it, with the effort levels an account offers. */
const SOL = (levels) => [{ id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6 Sol', hidden: false, isDefault: true, supportedReasoningEfforts: levels.map((e) => ({ reasoningEffort: e, description: '' })) }];

module.exports = async function () {
  const { App } = require('../../src/app');
  const { ROUTES } = require('../../src/harnessapp/routes');
  const si = require('../../src/sessionintel');
  const store = require('../../src/fabric/store');
  const F = require('../../src/fabric/index');
  const out = { write() {}, on() {}, columns: 110, rows: 30, isTTY: false };
  const call = (app, k, body) => ROUTES[`POST ${k}`](app, body || {});
  const savedProvider = process.env.LAIN_PROVIDER;
  delete process.env.LAIN_PROVIDER;
  /** A turn as the Harness's Chat runs it: the BOT, on the chat lane's own model. */
  async function chatTurn(app, text) {
    const sv = require('../../src/sessionviews');
    app.session.thread = 'chat'; app.session._botTurn = true; app.session._botOwnModel = true; sv.views(app.session).active = 'chat';
    await app.submit(text);
    await new Promise((r) => setTimeout(r, 300));
  }

  /** Three backing accounts of Codex: A and B serve GPT-6 Sol at XHigh; C does not. */
  async function codexApp({ aLimited = true, c = true, policy = 'auto', pinned = null } = {}) {
    try { fs.unlinkSync(store.file()); } catch { /* fresh */ }
    store.reset(); await fx.reset();
    const app = new App({ out, interactive: false, cwd: tmpdir('p83-') });
    const made = await fx.codexAccounts(app, [
      { name: 'Personal', email: 'personal@example.com', models: SOL(['high', 'xhigh']) },
      { name: 'Work', email: 'work@example.com', models: SOL(['high', 'xhigh']) },
      ...(c ? [{ name: 'Backup', email: 'backup@example.com', models: SOL(['low', 'high']) }] : []),
    ]);
    const [A, B, C] = made;
    app.cfg.model = undefined; app.cfg.connection = undefined;
    store.setOrder('codex', made.map((m) => m.id));
    store.setPolicy('codex', policy, pinned === 'A' ? A.id : pinned === 'B' ? B.id : pinned);
    if (aLimited) fx.limit(app, A.id);
    const r = await si.choose(app, app.session, { lane: 'chat', family: 'codex', model: 'gpt-6-sol', effort: 'xhigh' });
    assert.ok(r.ok, r.why);
    require('../../src/profile').set(app.session, 'FAST');
    app.session.thread = 'chat';   // Harness Chat is the surface these accounts serve
    const seen = (x) => (x ? fx.execs(app, x.id) : []);
    return { app, A, B, C, seen };
  }

  try {
    await test('FAMILY: Codex appears ONCE with its three backing accounts; the route never names an account number', async () => {
      const { app } = await codexApp({ aLimited: false });
      const fams = F.families(app).filter((f) => f.id === 'codex');
      assert.strictEqual(fams.length, 1, 'one Codex');
      assert.ok(fams[0].accounts.every((a) => a.lifecycle === 'CONNECTED'), 'only connected accounts are capacity');
      assert.deepStrictEqual(fams[0].accounts.map((a) => a.name), ['Personal', 'Work', 'Backup']);
      const models = F.search(app, { family: 'codex' }).models;
      assert.deepStrictEqual(models.map((m) => m.label), ['GPT-6 Sol'], 'one logical model — not one per account');
      const l = si.lane(app, app.session, 'chat');
      assert.deepStrictEqual([l.familyLabel, l.modelLabel, l.effortLabel, l.policyLabel, l.accountLabel], ['Codex', 'GPT-6 Sol', 'XHigh', 'Automatic fallback', 'Personal']);
      const picker = (await call(app, '/api/intel/families')).body.families;
      assert.ok(!JSON.stringify(picker.map((f) => f.label)).match(/Account \d|Personal|Work/), 'no account is a provider row');
    });

    await test('AUTO: A is rate limited mid-task → the SAME task continues on B; model, effort and execution unchanged', async () => {
      const { app, A, B, C, seen } = await codexApp({ aLimited: true });
      const sid = app.session.id;
      await chatTurn(app, 'Say ok.');
      const l = si.lane(app, app.session, 'chat');
      assert.strictEqual(seen(A).length, 1, 'A was tried once');
      assert.ok(seen(B).length >= 1, 'B carried on');
      assert.strictEqual(seen(C).length, 0, 'C does not serve XHigh — never used');
      assert.deepStrictEqual(fx.wire(seen(B)[0]), { model: 'gpt-6-sol', effort: 'xhigh' }, 'the same model at the same effort, on the wire');
      assert.deepStrictEqual([l.family, l.model, l.effort, l.account], ['codex', 'gpt-6-sol', 'xhigh', B.id]);
      assert.strictEqual(require('../../src/profile').of(app.session), 'FAST', 'execution unchanged');
      assert.strictEqual(app.session.id, sid, 'same session');
      const ev = store.events({ type: 'fallback' }).slice(-1)[0];
      assert.deepStrictEqual([ev.from.name, ev.to.name, ev.model, ev.effort], ['Personal', 'Work', 'gpt-6-sol', 'xhigh']);
      const rows = require('../../src/usage').read({});
      const last = rows[rows.length - 1];
      assert.deepStrictEqual([last.family, last.effort, last.account], ['codex', 'xhigh', B.id], 'the receipt proves family, effort and backing account');
      assert.ok(store.limitedNow(A.id), 'A is recorded as limited for every surface and the tray');
    });

    await test('PINNED: "Use one account only" — A limited, NOTHING goes to B; Switch account · Wait · Choose another model', async () => {
      const { app, A, B, C, seen } = await codexApp({ aLimited: true, policy: 'pinned', pinned: 'A' });
      await chatTurn(app, 'Say ok.');
      assert.strictEqual(seen(B).length + seen(C).length, 0, 'never switched on its own');
      const l = si.lane(app, app.session, 'chat');
      assert.strictEqual(l.account, A.id);
      assert.ok(l.pending && l.pending.kind === 'pinned', 'the question waits on the session');
      assert.deepStrictEqual(l.pending.choices, ['switch-account', 'wait', 'choose-model']);
      assert.deepStrictEqual(l.pending.candidates.map((c) => c.name), ['Work'], 'only an account that serves GPT-6 Sol at XHigh is offered');
      const d = await call(app, '/api/intel/decide', { choice: 'switch-account', account: B.id });
      assert.strictEqual(d.code, 200, JSON.stringify(d.body));
      const f = F.family(app, 'codex');
      assert.deepStrictEqual([f.policy, f.pinned], ['pinned', B.id], 'still one account only — now Work');
    });

    await test('ASK: A limited → B is PROPOSED; no request goes through B until the person says Switch', async () => {
      const { app, B, seen } = await codexApp({ aLimited: true, policy: 'ask' });
      await chatTurn(app, 'Say ok.');
      const l = si.lane(app, app.session, 'chat');
      assert.strictEqual(seen(B).length, 0, 'nothing sent through B yet');
      assert.ok(l.pending && l.pending.kind === 'ask' && l.pending.to.name === 'Work', JSON.stringify(l.pending));
      assert.match(l.pending.text, /Switch to Work\?/);
      assert.strictEqual(l.ok, false, 'the lane waits for the decision');
      const d = await call(app, '/api/intel/decide', { choice: 'switch' });
      assert.strictEqual(d.code, 200, JSON.stringify(d.body));
      for (let i = 0; i < 150 && !seen(B).length; i++) await new Promise((r) => setTimeout(r, 40));
      assert.ok(seen(B).length >= 1, 'after Switch, the same task carries on through B');
      assert.strictEqual(si.lane(app, app.session, 'chat').account, B.id);
    });

    await test('INCOMPATIBLE: no other account serves GPT-6 Sol at XHigh → asked; the model and effort are never lowered', async () => {
      const { app, B, seen, C } = await codexApp({ aLimited: true });
      await require('../../src/accountinstances').disconnect(app, B.id, { logout: false });   // only A (XHigh) and C (no XHigh) remain
      require('../../src/appcatalog').invalidate(); app._acctMemo = null; app._catMemo = null;
      await chatTurn(app, 'Say ok.');
      assert.strictEqual(seen(C).length, 0, 'no silent downgrade to an account that cannot serve XHigh');
      const l = si.lane(app, app.session, 'chat');
      assert.deepStrictEqual([l.model, l.effort], ['gpt-6-sol', 'xhigh']);
      assert.ok(l.pending && l.pending.kind === 'incompatible', JSON.stringify(l.pending));
      assert.match(l.pending.text, /will not change the model or the effort/);
    });

    await test('EFFORT: each model offers exactly its own levels — High/XHigh · Low/Medium/High · none — and nothing else reaches transport', async () => {
      const app = new App({ out, interactive: false, cwd: tmpdir('p83e-') });
      app.cfg.connections = { 'lain:fx': { baseUrl: 'http://127.0.0.1:9/v1', provider: 'openai', apiKey: 'sk-x', models: ['model-a', 'model-a-high', 'model-a-xhigh', 'model-b', 'model-b-low', 'model-b-medium', 'model-b-high', 'model-c'] } };
      const byLabel = Object.fromEntries(F.search(app, { family: 'api:lain:fx' }).models.map((m) => [m.id, m.effortLabels]));
      assert.deepStrictEqual(byLabel, { 'model-a': ['High', 'XHigh'], 'model-b': ['Low', 'Medium', 'High'], 'model-c': [] });
      let r = await si.choose(app, app.session, { lane: 'coding', family: 'api:lain:fx', model: 'model-a', effort: 'low' });
      assert.strictEqual(r.ok, false, 'Model A has no Low'); assert.match(r.why, /offers High, XHigh/);
      r = await si.choose(app, app.session, { lane: 'coding', family: 'api:lain:fx', model: 'model-a', effort: 'xhigh' });
      assert.ok(r.ok, r.why);
      const pc = require('../../src/provider').resolve(require('../../src/sessionviews').turnCfg(app, app.session));
      assert.deepStrictEqual([pc.model, pc.reasoningEffort], ['model-a-xhigh', 'xhigh'], 'the one form the transport understands');
      r = await si.choose(app, app.session, { lane: 'coding', model: 'model-c' });
      assert.ok(r.ok, r.why);
      assert.strictEqual(r.effortReset, true, 'a stored level the new model does not take goes back to its default — and says so');
      // 2026-10-02: a model with NO native effort offers LAIN execution effort (Low / High / Max) — honestly labelled,
      // and never sent to the provider as if it were hidden reasoning.
      assert.deepStrictEqual([r.lane.efforts, r.lane.effort, r.lane.effortSource], [['low', 'high', 'max'], null, 'lain'], 'Model C offers LAIN effort, not a native selector');
      assert.strictEqual(require('../../src/sessionviews').turnCfg(app, app.session).effort, undefined, 'no stored level, nothing chosen');
      await si.set(app, app.session, { lane: 'reasoning', value: 'high', scope: 'session' });
      const pcC = require('../../src/provider').resolve(require('../../src/sessionviews').turnCfg(app, app.session));
      assert.ok(!pcC.effortWire && !pcC.reasoningEffort, 'LAIN effort never reaches the wire');
      assert.notStrictEqual(pcC.effortSource, 'provider');
      // THE RUNTIMES' OWN SYNTAX, in one place (fabric/effortcaps.js).
      const argv = require('../../src/drivers/codexexec').argsFor('gpt-6-sol', 'xhigh');
      assert.ok(argv.join(' ').includes('-c model_reasoning_effort="xhigh"'), argv.join(' '));
      assert.ok(!require('../../src/drivers/codexexec').argsFor('gpt-6-sol', null).includes('-c'), 'no level, no flag');
      assert.deepStrictEqual(require('../../src/fabric/effortcaps').runtimeArgs('claude-code', 'xhigh'), ['--effort', 'xhigh']);
      assert.deepStrictEqual(require('../../src/fabric/effortcaps').declared({ runtime: 'claude-code', upstreamId: 'opus' }).levels, ['low', 'medium', 'high', 'xhigh', 'max']);
      assert.strictEqual(require('../../src/fabric/effortcaps').declared({ runtime: 'claude-code', upstreamId: 'haiku' }), null, 'Haiku: no configurable effort');
    });

    await test('DEFAULTS: a role default names provider, model, effort, execution and policy — the Assistant runs on it as an exact route', async () => {
      const app = new App({ out, interactive: false, cwd: tmpdir('p83d-') });
      app.cfg.connections = { 'lain:fx': { baseUrl: 'http://127.0.0.1:9/v1', provider: 'openai', apiKey: 'sk-x', models: ['model-b', 'model-b-low', 'model-b-medium', 'model-b-high'] } };
      let r = await call(app, '/api/intel/role', { role: 'assistant', family: 'api:lain:fx', model: 'model-b', effort: 'xhigh' });
      assert.strictEqual(r.code, 400, 'a level the model does not declare is refused in a default too');
      r = await call(app, '/api/intel/role', { role: 'assistant', family: 'api:lain:fx', model: 'model-b', effort: 'medium', execution: 'eco', policy: 'auto' });
      assert.strictEqual(r.code, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.value, { family: 'api:lain:fx', model: 'model-b', effort: 'medium', execution: 'ECO', policy: 'auto', pinned: null }, 'no backing account unless pinned');
      const route = require('../../src/fabric/roles').routeFor(app, 'assistant');
      assert.deepStrictEqual([route.connection, route.model, route.effort], ['lain:fx', 'model-b', 'medium']);
      const pc = require('../../src/provider').resolve({ ...app.cfg, model: route.model, connection: route.connection, effort: route.effort });
      assert.strictEqual(pc.model, 'model-b-medium', 'the effort reaches the wire');
      await call(app, '/api/intel/role', { role: 'assistant', clear: true });
    });

    await test('EXECUTION: Normal · Fast · Eco toggles from any surface; effort and execution never move each other', async () => {
      const { app } = await codexApp({ aLimited: false });
      const rc = require('../../src/remotecontrols');
      const prof = () => require('../../src/profile').of(app.session);
      require('../../src/profile').set(app.session, 'NORMAL');
      await rc.run(app, '/fast', { surface: 'telegram' }); assert.strictEqual(prof(), 'FAST');
      await rc.run(app, '/eco', { surface: 'telegram' }); assert.strictEqual(prof(), 'ECO', 'Fast + /eco → Eco');
      await rc.run(app, '/fast', { surface: 'telegram' }); assert.strictEqual(prof(), 'FAST', 'Eco + /fast → Fast');
      await rc.run(app, '/fast', { surface: 'telegram' }); assert.strictEqual(prof(), 'NORMAL', 'Fast + /fast → Normal');
      await rc.run(app, '/eco', { surface: 'telegram' }); await rc.run(app, '/normal', { surface: 'telegram' }); assert.strictEqual(prof(), 'NORMAL', '/normal returns');
      assert.strictEqual(si.lane(app, app.session, 'chat').effort, 'xhigh', 'XHigh stayed through every execution change');
      await rc.run(app, '/eco', { surface: 'telegram' });
      await si.choose(app, app.session, { lane: 'chat', effort: 'high' });
      assert.strictEqual(prof(), 'ECO', 'and Eco stayed through an effort change');
      // THE GUI: one Execution dropdown, never a permanent Normal/Fast/Eco row.
      const comp = fs.readFileSync(require('../helpers').harnessPath('page', 'chat', 'composer.js'), 'utf8');
      const cells = comp.slice(comp.indexOf('function execCell('), comp.indexOf('// ---- SLASH SUGGESTIONS'));
      // 2026-09-30: the execution cell is an icon that opens ONE small popover (execution, run strategy, context).
      assert.ok(/(profileMenu|modeMenu)\(b\)/.test(cells), 'the execution cell opens one menu');
      assert.ok(!/\[\['NORMAL', 'Normal'\], \['FAST', 'Fast'\], \['ECO', 'Eco'\]\]\.forEach/.test(cells), 'no three-button row');
    });

    await test('PARITY: the terminal, Harness Chat, the IDE and Telegram report Codex › GPT-6 Sol › XHigh › Fast — and still do after A → B', async () => {
      const { app } = await codexApp({ aLimited: false });
      const rc = require('../../src/remotecontrols');
      const rowsOf = async () => {
        const cli = Object.fromEntries(require('../../src/diagnose').statusRows(app).map(([k, v]) => [k, String(v).replace(/\x1b\[[0-9;]*m/g, '')]));
        const st = await require('../../src/harnessapp/state').read(app);
        const win = Object.fromEntries(require('../../src/sessionfacts').rows(st.facts));
        const tg = Object.fromEntries((await rc.run(app, '/status', { surface: 'telegram' })).text.split('\n').map((l) => [l.slice(0, l.indexOf(': ')).toLowerCase(), l.slice(l.indexOf(': ') + 2)]));
        const lanes = (await call(app, '/api/intel/lanes')).body.lanes;
        return { cli, win, tg, lanes };
      };
      const check = (S, account) => {
        for (const s of [S.cli, S.win, S.tg]) {
          assert.match(s.provider, /^Codex( \(chat\))? · Automatic fallback$/);
          assert.strictEqual(s.model, 'GPT-6 Sol');
          assert.strictEqual(s.effort, 'XHigh');
          assert.strictEqual(s.execution, 'Fast');
          assert.match(s.account, new RegExp(`^${account}`));
        }
        assert.deepStrictEqual([S.lanes.chat.familyLabel, S.lanes.chat.modelLabel, S.lanes.chat.effortLabel], ['Codex', 'GPT-6 Sol', 'XHigh'], 'Harness Chat');
      };
      check(await rowsOf(), 'Personal');
      const fb = require('../../src/fabric/fallback').onTurnLimited(app, { lane: 'chat', providerFailure: { retryAfterMs: 3600e3 } });
      assert.strictEqual(fb.action, 'switched');
      check(await rowsOf(), 'Work');
    });

    await test('SERVE: lain/codex/gpt-6-sol — the policy chooses the account; effort is checked; no identity is exposed', async () => {
      const { app, A, B } = await codexApp({ aLimited: false });
      const serve = require('../../src/serve');
      const aliases = serve.aliases(app).map((a) => a.alias);
      assert.ok(aliases.includes('lain/codex/gpt-6-sol'), aliases.slice(0, 10).join(', '));
      assert.ok(!aliases.some((a) => /Personal|codex-\d|@/.test(a)), 'no backing account in a route name');
      const pc = serve.resolveAlias(app, 'lain/codex/gpt-6-sol', { effort: 'xhigh' });
      assert.deepStrictEqual([pc.family, pc.accountId], ['codex', A.id]);
      assert.match(serve.resolveAlias(app, 'lain/codex/gpt-6-sol', { effort: 'max' }).refused, /offers/);
      assert.match(serve.resolveAlias(app, 'lain/codex/gpt-6-sol@Work').refused, /pinning/, 'pinning is off unless configured');
      app.cfg.server = { pinnable: true };
      assert.strictEqual(serve.resolveAlias(app, 'lain/codex/gpt-6-sol@Work').accountId, B.id, 'by the alias the person gave it');
    });

    await test('CLI: /account shows the family, its policy and numbered accounts; pin, automatic, reorder and rename write the ONE fabric', async () => {
      const { app, B } = await codexApp({ aLimited: false });
      const commands = require('../../src/commands');
      const text = [];
      app.render = { write: (s) => text.push(String(s)), notice() {}, openSurface() {}, doneSurface() {} };
      await commands.run(app, '/account');
      assert.match(text.join(''), /Codex\n {2}Policy: Automatic fallback\n {2}Backing accounts:\n.*1\. Personal/);
      await commands.run(app, '/account pin 2');
      assert.deepStrictEqual([F.family(app, 'codex').policy, F.family(app, 'codex').pinned], ['pinned', B.id]);
      assert.strictEqual(si.lane(app, app.session, 'chat').account, B.id, 'the lane follows the pin at once');
      await commands.run(app, '/account automatic');
      await commands.run(app, '/account reorder 3,1,2');
      assert.deepStrictEqual(F.family(app, 'codex').accounts.map((a) => a.name), ['Backup', 'Personal', 'Work']);
      await commands.run(app, '/account rename 1 Spare');
      const win = (await call(app, '/api/intel/families')).body.families.find((f) => f.id === 'codex');
      assert.strictEqual(win.accounts[0].name, 'Spare', 'the window reads what the terminal wrote');
      assert.strictEqual(win.policy, 'auto');
    });

    await test('CLI: /api, /api add, /account add and /model manage open the Model Dashboard; a pasted key is refused and never stored', async () => {
      const app = new App({ out, interactive: false, cwd: tmpdir('p83c-') });
      const text = [];
      app.render = { write: (s) => text.push(String(s)), notice() {}, openSurface() {}, doneSurface() {} };
      app.input = { history: [], histIndex: 0, line: '' };
      const dl = require('../../src/fabric/dashlaunch');
      const real = { open: dl.open, watch: dl.watch };
      const opened = [];
      dl.open = async (a, section) => { opened.push(dl.sectionOf(section)); return { ok: true, how: 'opened' }; };
      dl.watch = () => () => {};
      try {
        const commands = require('../../src/commands');
        for (const c of ['/api', '/api add', '/account add', '/model manage']) await commands.run(app, c);
        assert.deepStrictEqual(opened, ['api', 'api', 'accts', 'mdl']);
        const KEY = 'sk-live-typed-into-the-terminal-7f7f';
        app.input.history.push(`/api ${KEY}`);
        await commands.run(app, `/api ${KEY}`);
        assert.ok(!text.join('').includes(KEY), 'never echoed');
        assert.ok(!app.input.history.some((h) => h.includes(KEY)), 'gone from history');
        assert.ok(!JSON.stringify(app.cfg).includes(KEY), 'never stored');
      } finally { dl.open = real.open; dl.watch = real.watch; }
    });

    await test('CLI: the Model Dashboard tells a waiting terminal only the safe completion event — never the key', async () => {
      const dl = require('../../src/fabric/dashlaunch');
      const since = Date.now() - 1;
      const got = [];
      const stop = dl.watch(since, (e) => got.push(e), { timeoutMs: 5000 });
      store.event('source-added', { kind: 'api', id: 'lain:deepseek', name: 'DeepSeek API', capabilities: { models: 3 }, key: 'sk-MUST-NOT-TRAVEL' });
      for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 100));
      stop();
      assert.strictEqual(got.length, 1);
      assert.deepStrictEqual(Object.keys(got[0]).sort(), ['at', 'capabilities', 'family', 'id', 'kind', 'name', 'type']);
      assert.ok(!JSON.stringify(got).includes('sk-MUST-NOT-TRAVEL'));
      assert.match(dl.describe(got[0]), /API added: DeepSeek API \(lain:deepseek\) · 3 models/);
    });

    await test('ONE REGISTRY, TWO PROCESSES: an API added by another LAIN (the Harness) is seen here without a restart — and its removal too', async () => {
      const app = new App({ out, interactive: false, cwd: tmpdir('p83x-') });
      const config = require('../../src/config');
      config.save(app.cfg);   // this process's own write — never mistaken for another's
      assert.strictEqual(require('../../src/fabric/sync').sync(app, { force: true }), false);
      const other = (code) => require('child_process').spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: process.env, windowsHide: true });
      const add = other(`const fs=require('fs');const f=${JSON.stringify(config.configFile())};const c=JSON.parse(fs.readFileSync(f,'utf8'));c.connections={...(c.connections||{}),'lain:elsewhere':{baseUrl:'http://127.0.0.1:9/v1',provider:'openai',apiKey:'sk-x',models:['other-model']}};fs.writeFileSync(f,JSON.stringify(c));`);
      assert.strictEqual(add.status, 0, add.stderr);
      // THIS PROCESS SAVES ITS OWN CHANGE before it has looked: the other process's API is not erased.
      app.cfg.executionProfile = 'ECO';
      config.save(app.cfg);
      assert.ok(JSON.parse(fs.readFileSync(config.configFile(), 'utf8')).connections['lain:elsewhere'], 'a save never erases another LAIN\'s addition');
      assert.strictEqual(JSON.parse(fs.readFileSync(config.configFile(), 'utf8')).executionProfile, 'ECO', 'and this process\'s own change is written');
      require('../../src/fabric/sync').sync(app, { force: true });
      assert.ok(F.family(app, 'api:lain:elsewhere'), 'the other process\'s API is in this process\'s fabric');
      const rm = other(`const fs=require('fs');const f=${JSON.stringify(config.configFile())};const c=JSON.parse(fs.readFileSync(f,'utf8'));delete c.connections['lain:elsewhere'];fs.writeFileSync(f,JSON.stringify(c));`);
      assert.strictEqual(rm.status, 0, rm.stderr);
      require('../../src/fabric/sync').sync(app, { force: true });
      assert.strictEqual(F.family(app, 'api:lain:elsewhere'), null, 'and its removal');
    });

    await test('FREEBUFF: gone from Core, the Harness, discovery, MODEL, Home search, Usage and the launcher', () => {
      const scan = (dir) => {
        const hits = [];
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) hits.push(...scan(p));
          else if (/\.(js|cs)$/.test(e.name) && /freebuff/i.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
        }
        return hits;
      };
      const src = scan(path.join(__dirname, '..', '..', 'src'));
      const page = scan(path.dirname(require('../helpers').harnessPath('page', 'page.js')));
      assert.deepStrictEqual([...src, ...page], [], 'no active Freebuff integration');
      assert.strictEqual(require('../../src/runtimeadapters').get('freebuff'), null);
    });
  } finally {
    if (savedProvider !== undefined) process.env.LAIN_PROVIDER = savedProvider;
    await fx.reset();
    try { fs.unlinkSync(store.file()); } catch { /* none */ }
    store.reset();
  }
};
