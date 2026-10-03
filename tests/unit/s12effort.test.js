'use strict';

/**
 * S12a — LAIN EFFORT WORKS LIKE PROVIDER EFFORT. A model with no native effort offers Low / High / Max, labelled
 * LAIN effort; the choice is stored and honoured; every surface says "LAIN effort · High"; and what it changes is
 * outside the cached prefix — the system prompt and the tools array are BYTE-IDENTICAL at every level and profile,
 * proven on the wire against a local OpenAI-compatible endpoint that records each request.
 */

const assert = require('assert');
const http = require('http');
const { test, tmpdir } = require('../helpers');

/** A local OpenAI-compatible endpoint: records every request body, answers "ok". */
function fakeEndpoint() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { bodies.push(JSON.parse(raw)); } catch { bodies.push(null); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, bodies, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

module.exports = async function () {
  const { App } = require('../../src/app');
  const si = require('../../src/sessionintel');
  const sv = require('../../src/sessionviews');
  const provider = require('../../src/provider');
  const out = { write() {}, on() {}, columns: 110, rows: 30, isTTY: false };
  const savedProvider = process.env.LAIN_PROVIDER;
  delete process.env.LAIN_PROVIDER;
  const savedSave = require('../../src/config').save;
  require('../../src/config').save = () => {};

  /** model-c has no native effort; model-b has Low/Medium/High (fused upstream ids). */
  function appWith(baseUrl, extra = {}) {
    const app = new App({ out, interactive: false, cwd: tmpdir('s12e-') });
    app.cfg.connections = { 'lain:fx': { baseUrl, provider: 'openai', apiKey: 'sk-x', models: ['model-b', 'model-b-low', 'model-b-medium', 'model-b-high', 'model-c'], ...extra } };
    return app;
  }
  const pcOf = (app) => provider.resolve(sv.turnCfg(app, app.session));

  try {
    await test('S12a PICKER: a model with no native effort offers Low / High / Max as LAIN effort, with one dim line; a native one offers its own levels', async () => {
      const app = appWith('http://127.0.0.1:9/v1');
      const r = await si.choose(app, app.session, { lane: 'coding', family: 'api:lain:fx', model: 'model-c' });
      assert.ok(r.ok, r.why);
      assert.deepStrictEqual([r.lane.efforts, r.lane.effortSource, r.lane.effortKind], [['low', 'high', 'max'], 'lain', 'LAIN effort']);
      const { effortAdapter } = require('../../src/ui/panel');
      const p = effortAdapter({ available: r.lane.efforts, current: r.lane.effective, source: r.lane.effortSource });
      assert.strictEqual(p.title, 'Effort · LAIN effort');
      assert.deepStrictEqual(p.items.filter((i) => i.selectable !== false).map((i) => i.value), ['low', 'high', 'max']);
      assert.strictEqual(p.items.filter((i) => i.selectable === false).length, 1, 'one explaining line');
      assert.strictEqual(p.items[0].tone, 'meta', 'dim');
      const b = await si.choose(app, app.session, { lane: 'coding', model: 'model-b' });
      const pb = effortAdapter({ available: b.lane.efforts, current: b.lane.effort, source: b.lane.effortSource });
      assert.strictEqual(pb.title, 'Effort · Provider effort');
      assert.deepStrictEqual(pb.items.map((i) => i.value), ['low', 'medium', 'high']);
    });

    await test('S12a STORE AND HONOUR: the choice is kept (never nulled, never refused), reaches the turn as LAIN effort, and every surface says "LAIN effort · …"', async () => {
      const app = appWith('http://127.0.0.1:9/v1');
      await si.choose(app, app.session, { lane: 'coding', family: 'api:lain:fx', model: 'model-c' });
      require('../../src/profile').set(app.session, 'NORMAL');
      let l = si.lane(app, app.session, 'coding');
      assert.deepStrictEqual([l.effort, l.effective, l.effortExplicit], [null, 'high', false], 'NORMAL: High by default');
      assert.strictEqual(pcOf(app).lainEffort, 'high');
      const r = await si.choose(app, app.session, { lane: 'coding', effort: 'max' });
      assert.ok(r.ok, r.why);
      l = si.lane(app, app.session, 'coding');
      assert.deepStrictEqual([l.effort, l.effective, l.effortExplicit], ['max', 'max', true]);
      assert.strictEqual(pcOf(app).lainEffort, 'max');
      assert.ok(!pcOf(app).reasoningEffort && !pcOf(app).effortWire, 'never a provider field');
      assert.strictEqual(si.effortText(l), 'LAIN effort · Max');
      assert.match(l.display.text, /· LAIN effort · Max$/, 'the route line');
      const facts = require('../../src/sessionfacts').facts(app).coding;
      assert.strictEqual(facts.effort, 'LAIN effort · Max', 'the status rows (CLI, window, Telegram) read the same fact');
      const tg = await require('../../src/remotecontrols').run(app, '/effort', { surface: 'telegram' });
      assert.match(tg.text, /^Effort: LAIN effort · Max/);
      const bad = await si.choose(app, app.session, { lane: 'coding', effort: 'medium' });
      assert.strictEqual(bad.ok, false, 'a level LAIN effort does not have is refused with the three it has');
      assert.match(bad.why, /Low, High, Max|offers Low, High, Max/);
    });

    await test('S12a FAST/ECO: Low is the default LAIN effort, and the header says it is the profile\'s; an explicit choice wins and is shown as chosen', async () => {
      const app = appWith('http://127.0.0.1:9/v1');
      await si.choose(app, app.session, { lane: 'coding', family: 'api:lain:fx', model: 'model-c' });
      for (const [p, why] of [['FAST', 'Fast default'], ['ECO', 'Eco default']]) {
        require('../../src/profile').set(app.session, p);
        const l = si.lane(app, app.session, 'coding');
        assert.deepStrictEqual([l.effective, l.effortDefaultWhy], ['low', why], p);
        assert.strictEqual(si.effortText(l), `LAIN effort · Low · ${why}`);
        assert.strictEqual(pcOf(app).lainEffort, 'low', `${p} sends Low`);
      }
      await si.choose(app, app.session, { lane: 'coding', effort: 'high' });
      const l = si.lane(app, app.session, 'coding');
      assert.deepStrictEqual([l.effective, l.effortExplicit, l.effortDefaultWhy], ['high', true, ''], 'explicit High wins in Eco');
      assert.strictEqual(si.effortText(l), 'LAIN effort · High');
      assert.strictEqual(pcOf(app).lainEffort, 'high');
    });

    await test('S12a RESUME: the chosen LAIN effort survives a session save and resume', async () => {
      const app = appWith('http://127.0.0.1:9/v1');
      await si.choose(app, app.session, { lane: 'coding', family: 'api:lain:fx', model: 'model-c' });
      await si.choose(app, app.session, { lane: 'coding', effort: 'low' });
      app.session.save();
      const { Session } = require('../../src/session');
      const back = Session.resume(app.session.id);
      const app2 = appWith('http://127.0.0.1:9/v1');
      app2.session = back;
      const l = si.lane(app2, back, 'coding');
      assert.deepStrictEqual([l.model, l.effort, l.effortSource], ['model-c', 'low', 'lain']);
      assert.strictEqual(pcOf(app2).lainEffort, 'low');
    });

    await test('S12a KNOBS: Low 2 parallel reads · tighter output · earlier compaction; High the profile; Max 4 · looser · later', () => {
      const pr = require('../../src/profile');
      assert.deepStrictEqual(['low', 'high', 'max'].map((e) => pr.concurrency('NORMAL', e)), [2, 2, 4]);
      assert.deepStrictEqual(['low', 'high', 'max'].map((e) => pr.concurrency('FAST', e)), [2, 4, 4], 'High is the profile default');
      const out = ['low', 'high', 'max'].map((e) => pr.outputScale('NORMAL', e));
      assert.ok(out[0] < out[1] && out[1] < out[2], JSON.stringify(out));
      const at = ['low', 'high', 'max'].map((e) => pr.compactAt('NORMAL', e));
      assert.ok(at[0] < at[1] && at[1] < at[2], JSON.stringify(at));
      assert.strictEqual(pr.compactAt('NORMAL', null), pr.compactAt('NORMAL'), 'no LAIN effort: the profile alone');
      const tb = require('../../src/toolbudget');
      const huge = { output: 'x'.repeat(200000) };
      const len = (e) => tb.bound('read_file', {}, huge, { cfg: { lainEffort: e } }).length;
      assert.ok(len('low') < len('high') && len('high') < len('max'), `${len('low')} < ${len('high')} < ${len('max')}`);
    });

    await test('S12a WIRE: tools + system are byte-identical across Low/High/Max and every profile; the tail line is at the end; lainEffort is traced', async () => {
      const ep = await fakeEndpoint();
      const reqtrace = require('../../src/reqtrace');
      try {
        const app = appWith(ep.url);
        await si.choose(app, app.session, { lane: 'coding', family: 'api:lain:fx', model: 'model-c' });
        const seen = [];
        for (const prof of ['NORMAL', 'FAST', 'ECO']) {
          for (const e of ['low', 'high', 'max']) {
            require('../../src/profile').set(app.session, prof);
            await si.choose(app, app.session, { lane: 'coding', effort: e });
            const n = ep.bodies.length;
            const { runTurn } = require('../../src/turn');
            const opts = require('../../src/jobrunner').turnOptions(app, { session: app.session });
            for await (const ev of runTurn(app.session, `say ok (${prof} ${e})`, opts)) { if (ev && ev.type === 'done') break; }
            const body = ep.bodies[n];
            assert.ok(body, `a request went out for ${prof}/${e}`);
            const sys = body.messages.find((m) => m.role === 'system');
            seen.push({ prof, e, tools: JSON.stringify(body.tools), system: JSON.stringify(sys), tail: JSON.stringify(body.messages.slice(-2)), body });
            const tr = reqtrace.last();
            assert.strictEqual(tr && tr.lainEffort, e, `reqtrace records lainEffort ${e}`);
          }
        }
        for (const s of seen) {
          assert.strictEqual(s.tools, seen[0].tools, `tools differ at ${s.prof}/${s.e}`);
          assert.strictEqual(s.system, seen[0].system, `system differs at ${s.prof}/${s.e}`);
          assert.ok(!('reasoning_effort' in s.body) && !('enable_thinking' in s.body) && !('thinking' in s.body), 'nothing undeclared on the wire');
        }
        const tailOf = (e) => seen.find((s) => s.prof === 'NORMAL' && s.e === e).tail;
        assert.match(tailOf('low'), /Effort: low\. Answer directly, keep exploration minimal, run only the targeted check\./);
        assert.match(tailOf('max'), /Effort: max\. Investigate thoroughly, consider alternatives before editing, verify with a broader check\./);
        assert.doesNotMatch(tailOf('high'), /Effort:/, 'High adds nothing');
        assert.doesNotMatch(seen[0].system, /Effort: (low|max)/, 'never in the cached prefix');
        process.stdout.write(`      tools ${seen[0].tools.length} B · system ${seen[0].system.length} B — identical across 9 (profile × LAIN effort) requests\n`);
      } finally { ep.server.close(); }
    });

    await test('S12a THINKING SWITCH: only where declared — Low turns it off, High/Max on; nothing without a declaration', async () => {
      const caps = require('../../src/fabric/effortcaps');
      assert.strictEqual(caps.thinkingSwitch({ conn: { baseUrl: 'https://api.z.ai/api/paas/v4', provider: 'zai' }, upstreamId: 'glm-4.7' }), 'thinking.type');
      assert.strictEqual(caps.thinkingSwitch({ conn: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }, upstreamId: 'qwen3-32b' }), 'enable_thinking');
      assert.strictEqual(caps.thinkingSwitch({ conn: { baseUrl: 'https://api.example.test/v1' }, upstreamId: 'qwen3-32b' }), null, 'not guessed from a name alone');
      assert.strictEqual(caps.thinkingSwitch({ conn: { thinkingSwitch: 'none', baseUrl: 'https://api.z.ai/api/paas/v4' }, upstreamId: 'glm-4.7' }), null, 'a connection can say it has none');
      const ep = await fakeEndpoint();
      try {
        for (const [sw, e, want] of [['enable_thinking', 'low', { enable_thinking: false }], ['enable_thinking', 'max', { enable_thinking: true }], ['thinking.type', 'low', { thinking: { type: 'disabled' } }], ['thinking.type', 'high', { thinking: { type: 'enabled' } }]]) {
          const app = appWith(ep.url, { thinkingSwitch: sw });
          await si.choose(app, app.session, { lane: 'coding', family: 'api:lain:fx', model: 'model-c', effort: e });
          const pc = pcOf(app);
          assert.strictEqual(pc.thinkingSwitch, sw);
          const n = ep.bodies.length;
          for await (const ev of provider.chat(pc, [{ role: 'user', content: 'hi' }], {})) { if (!ev) break; }
          const body = ep.bodies[n];
          for (const [k, v] of Object.entries(want)) assert.deepStrictEqual(body[k], v, `${sw} at ${e}`);
        }
      } finally { ep.server.close(); }
    });

    await test('S12a HARNESS DATA: the window\'s lane carries the source, the levels and the level in force', async () => {
      const app = appWith('http://127.0.0.1:9/v1');
      await si.choose(app, app.session, { lane: 'coding', family: 'api:lain:fx', model: 'model-c' });
      require('../../src/profile').set(app.session, 'FAST');
      const st = await require('../../src/harnessapp/state').read(app);
      const c = st.models.coding;
      assert.deepStrictEqual([c.efforts, c.effortSource, c.effective, c.effectiveLabel, c.effortDefaultWhy], [['low', 'high', 'max'], 'lain', 'low', 'Low', 'Fast default']);
      const r = await require('../../src/harnessapp/routes').ROUTES['POST /api/intel/effort'](app, { lane: 'coding', effort: 'max' });
      assert.strictEqual(r.code, 200, JSON.stringify(r.body));
      const c2 = (await require('../../src/harnessapp/state').read(app)).models.coding;
      assert.deepStrictEqual([c2.effective, c2.effortExplicit, c2.effortDefaultWhy], ['max', true, '']);
    });
  } finally {
    require('../../src/config').save = savedSave;
    if (savedProvider !== undefined) process.env.LAIN_PROVIDER = savedProvider;
  }
};
