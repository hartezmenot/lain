'use strict';

/**
 * ONE SESSION, FIVE SURFACES (Phase 8.2) — the terminal, Harness Chat, the
 * IDE's Coding Agent, the IDE's Coding Chat and Telegram read the SAME session
 * state and say the same thing about it: session, task, project, account,
 * model, effort, execution, strategy, phase and plan. And a change made on one
 * surface is what every other surface shows next:
 *
 *   the account, changed in the window    → the terminal's header and /status
 *   the model, changed in the terminal    → the window's lanes, Telegram
 *   /fast, sent from Telegram             → everywhere, and the next turn's profile
 *
 * Fixture accounts only (an OpenAI API key and a fake 9Router with a Codex
 * pool — nothing is sent: choosing is passive).
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

const plain = (s) => String(s == null ? '' : s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

module.exports = async function () {
  const { App } = require('../../src/app');
  const sf = require('../../src/sessionfacts');
  const uiViews = require('../../src/ui/views');
  const diagnose = require('../../src/diagnose');
  const state = require('../../src/harnessapp/state');
  const intel = require('../../src/harnessapp/intelroutes').ROUTES;
  const rc = require('../../src/remotecontrols');
  const commands = require('../../src/commands');
  const { Plan } = require('../../src/plan');
  const project = tmpdir('parity-project-');
  const app = new App({ out: { write() {}, on() {}, columns: 120, rows: 30, isTTY: false }, interactive: false, cwd: project });
  app.cfg.connections = {
    'lain:alt': { baseUrl: 'http://127.0.0.1:9/v1', provider: 'deepseek', apiKey: 'sk-alt', models: ['alt-model', 'alt-two'] },
    'lain:oai': { baseUrl: 'http://127.0.0.1:9/v1', provider: 'openai', apiKey: 'sk-test', models: ['gpt-6-sol', 'gpt-5.5', 'gpt-5.5-low', 'gpt-5.5-high'] },
  };
  app.cfg.model = 'gpt-6-sol'; app.cfg.connection = 'lain:oai';
  const out = [];
  app.render = { write: (s) => out.push(String(s)), openSurface() {}, doneSurface() {}, notice() {} };
  const saved = process.env.LAIN_PROVIDER;
  delete process.env.LAIN_PROVIDER;

  // ---- what each surface shows, read the way that surface reads it ------------------------------
  async function surfaces() {
    const snap = app.ui.snapshot();
    const cliRows = Object.fromEntries(diagnose.statusRows(app).map(([k, v]) => [k, plain(v)]));
    const st = await state.read(app);
    const lanes = (await intel['POST /api/intel/lanes'](app, {})).body.lanes;
    const tg = (await rc.run(app, '/status', { surface: 'telegram' })).text;
    const tgRows = Object.fromEntries(tg.split('\n').map((l) => { const i = l.indexOf(': '); return [l.slice(0, i).toLowerCase(), l.slice(i + 2)]; }));
    const fromFacts = (f) => Object.fromEntries(sf.rows(f));
    return {
      cli: { rows: cliRows, header: plain(uiViews.header({ ...snap, width: 220 })[0]) },
      harnessChat: { rows: fromFacts(st.facts), lane: lanes.chat, workbench: st.workbench, plan: st.plan },
      ideAgent: { rows: fromFacts(st.facts), lane: lanes.coding, workbench: st.workbench, plan: st.plan },
      ideChat: { rows: fromFacts(st.facts), lane: lanes.chat },
      telegram: { rows: tgRows },
      facts: sf.facts(app),
    };
  }
  // (the phase row carries the run strategy, the mode and the plan's progress — /status must fit its panel)
  // PHASE 8.3: provider › model › effort for the lane in front, execution, the other lane.
  const FIELDS = ['session', 'project', 'task', 'provider', 'model', 'effort', 'execution', 'chat', 'phase'];
  function agree(S, why) {
    const want = Object.fromEntries(sf.rows(S.facts));
    for (const name of ['cli', 'harnessChat', 'ideAgent', 'ideChat', 'telegram']) {
      for (const k of FIELDS) assert.strictEqual(plain(S[name].rows[k]), plain(want[k]), `${why}: ${name} says ${k} = "${S[name].rows[k]}", the session says "${want[k]}"`);
    }
    assert.strictEqual(S.ideAgent.lane.account, S.facts.coding.accountId, `${why}: the IDE's Coding Agent account`);
    assert.strictEqual(S.ideAgent.lane.model, S.facts.coding.modelId, `${why}: the IDE's Coding Agent model`);
    assert.strictEqual(S.harnessChat.lane.account, S.facts.chat.accountId, `${why}: Harness Chat's account`);
    assert.strictEqual(S.ideChat.lane.model, S.facts.chat.modelId, `${why}: the IDE's Coding Chat model`);
    assert.strictEqual(S.ideAgent.workbench.profile, S.facts.execution, `${why}: the IDE's execution profile`);
    assert.strictEqual(S.ideAgent.workbench.strategy.label, S.facts.strategy, `${why}: the IDE's strategy`);
  }

  try {
    await test('PARITY: the terminal, Harness Chat, the IDE (Agent and Coding Chat) and Telegram say the same thing about one session', async () => {
      app.session.task = { id: 'T-parity', objective: 'Ship the settings page', state: 'RUNNING' };
      const plan = new Plan('Ship the settings page');
      plan.addSteps(['Read the page', 'Add the form', 'Verify it in Preview'], { origin: 'user' });
      plan.complete('read');
      app.session.plan = plan;
      await intel['POST /api/intel/choose'](app, { lane: 'coding', account: 'lain:oai', model: 'gpt-6-sol' });
      await intel['POST /api/intel/choose'](app, { lane: 'chat', account: 'lain:oai', model: 'gpt-5.5' });
      const S = await surfaces();
      assert.strictEqual(S.facts.task, 'Ship the settings page');
      assert.strictEqual(S.telegram.rows.task, 'Ship the settings page · T-parity', 'the task and its id');
      assert.deepStrictEqual(S.facts.plan, { done: 1, total: 3, current: 'Add the form' });
      assert.strictEqual(S.facts.coding.accountId, 'lain:oai');
      agree(S, 'at rest');
      assert.match(S.cli.header, /OpenAI API › GPT[- ]6 Sol/i, `the terminal's header, provider first: ${S.cli.header}`);
      assert.match(S.telegram.rows.provider, /^OpenAI API · Automatic fallback$/, S.telegram.rows.provider);
    });

    await test('PARITY: the account changed in the window is the terminal\'s account — header, /status and the next turn\'s route', async () => {
      const r = await intel['POST /api/intel/choose'](app, { lane: 'coding', account: 'lain:alt', model: 'alt-model' });
      assert.strictEqual(r.code, 200, JSON.stringify(r.body));
      const S = await surfaces();
      agree(S, 'after the window chose the other API');
      assert.strictEqual(S.facts.coding.accountId, 'lain:alt');
      // THE PROVIDER FAMILY names the route (Phase 8.3); the backing account and the exact route follow.
      assert.match(S.cli.header, /DeepSeek API › Alt Model/i, `the provider family names the route: ${S.cli.header}`);
      assert.match(S.cli.rows.account, /^DeepSeek API · route lain:alt · alt-model\b/, `the backing account and the exact route the next turn takes: ${S.cli.rows.account}`);
      delete app.session.thread;
      const pc = require('../../src/provider').resolve(require('../../src/sessionviews').turnCfg(app, app.session));
      assert.strictEqual(pc.accountId, 'lain:alt');
      assert.strictEqual(app.cfg.connection, 'lain:oai', 'a session choice, not the process default');
    });

    await test('PARITY: the model changed in the terminal is the window\'s model — and Telegram\'s', async () => {
      await commands.run(app, '/account use openai');
      await commands.run(app, '/model gpt-5.5');
      const S = await surfaces();
      agree(S, 'after /model in the terminal');
      assert.strictEqual(S.ideAgent.lane.account, 'lain:oai', out.join(''));
      assert.strictEqual(S.ideAgent.lane.model, 'gpt-5.5', out.join(''));
      assert.match(S.telegram.rows.provider, /^OpenAI API\b/, S.telegram.rows.provider);
      assert.match(S.telegram.rows.model, /^GPT[- ]5\.5$/i, S.telegram.rows.model);
    });

    await test('PARITY: /fast from Telegram is the profile everywhere — and effort from the window reaches the terminal\'s header', async () => {
      const r = await rc.run(app, '/fast', { surface: 'telegram' });
      assert.ok(r.ok, r.text);
      let S = await surfaces();
      agree(S, 'after /fast from Telegram');
      assert.strictEqual(S.facts.execution, 'FAST');
      assert.strictEqual(S.telegram.rows.execution, 'Fast');
      assert.strictEqual(require('../../src/sessionviews').turnCfg(app, app.session).executionProfile, 'FAST', 'the next turn runs Fast');
      const e = await require('../../src/harnessapp/intelroutes').ROUTES['POST /api/intel/lanes'](app, {});
      assert.ok(e.body.lanes.coding);
      await require('../../src/sessionintel').set(app, app.session, { lane: 'reasoning', value: 'high', scope: 'session' });
      S = await surfaces();
      agree(S, 'after effort High in the window');
      assert.match(S.cli.header, /high/i, `the terminal's header carries the effort: ${S.cli.header}`);
      assert.strictEqual(S.telegram.rows.effort, 'High');
      // A LEVEL THE MODEL DOES NOT DECLARE is refused - it never reaches transport (8.3).
      const no = await require('../../src/sessionintel').set(app, app.session, { lane: 'reasoning', value: 'xhigh', scope: 'session' });
      assert.strictEqual(no.ok, false, 'GPT 5.5 on this key offers Low and High only');
      assert.strictEqual(require('../../src/sessionviews').turnCfg(app, app.session).effort, 'high', 'the next turn carries the level the model declares');
      await rc.run(app, '/fast', { surface: 'telegram' });   // the active profile again → Normal
      S = await surfaces();
      agree(S, 'after /fast again');
      assert.strictEqual(S.facts.execution, 'NORMAL');
    });
  } finally {
    if (saved !== undefined) process.env.LAIN_PROVIDER = saved;
  }
};
