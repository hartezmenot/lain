'use strict';

/**
 * CHATGPT CHAT IS CHAT ONLY — every entry point that chooses a model for a
 * role other than CHAT refuses the chatgpt.com website session and its LAIN
 * alias `luna-chat-xhigh`. The alias is a LAIN route name, never an OpenAI
 * model id, and resolves only in the CHAT lane.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const roles = require('../../src/modelroles');
  const { App } = require('../../src/app');
  const mkApp = () => new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('chatonly-') });

  await test('CHAT ONLY: the policy allows ChatGPT Chat for CHAT and refuses every other role', () => {
    for (const role of roles.ROLES) {
      const row = { source: 'chatgpt-web', modelId: 'gpt-x' };
      assert.strictEqual(roles.allowed(row, role), role === 'CHAT', role);
      assert.strictEqual(roles.allowed({ modelId: 'luna-chat-xhigh' }, role), role === 'CHAT', `alias · ${role}`);
    }
    const r = roles.check({ source: 'chatgpt-web' }, 'BOT');
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'chat-only'); assert.match(r.why, /ChatGPT Chat is CHAT ONLY/);
    assert.strictEqual(roles.CHATGPT_CHAT.label, 'ChatGPT Chat');
    assert.strictEqual(roles.CHATGPT_CHAT.alias, 'luna-chat-xhigh');
    assert.strictEqual(require('../../src/modelsource/contract').LABEL['chatgpt-web'], 'ChatGPT Chat', 'renamed everywhere the label is read');
  });

  await test('CHAT ONLY: the Coding lane refuses the website source and the alias', async () => {
    const inv = require('../../src/modelinventory');
    const app = mkApp();
    for (const sel of [{ source: 'chatgpt-web', modelId: 'gpt-x' }, { source: 'lain', modelId: 'luna-chat-xhigh' }, { source: 'lain', modelId: 'ChatGPT Chat' }]) {
      const r = await inv.select(app, { lane: 'coding', ...sel });
      assert.strictEqual(r.ok, false, JSON.stringify(sel));
      assert.match(r.why, /CHAT ONLY/);
    }
    assert.strictEqual(inv.selections(app).coding.source, 'lain');
  });

  await test('RETIRED (Phase 8.1): the ChatGPT Chat alias no longer selects a website source; no website row is listed in any lane', async () => {
    const inv = require('../../src/modelinventory');
    const app = mkApp();
    const r = await inv.select(app, { lane: 'chat', source: 'lain', modelId: 'luna-chat-xhigh' });
    assert.strictEqual(r.ok, false, 'the alias is refused');
    assert.match(r.why, /retired/);
    const rows = (await inv.search(app, { lane: 'chat', query: '' })).rows.filter((x) => x.source === 'chatgpt-web' || x.source === 'gemini-web');
    assert.strictEqual(rows.length, 0, 'no website row');
    const coding = await inv.search(app, { lane: 'coding', query: '' });
    assert.ok(!coding.rows.some((x) => x.source === 'chatgpt-web' || x.modelId === 'luna-chat-xhigh'), 'never offered to the Agent');
  });

  await test('CHAT ONLY: the BOT is never the chat source — choosing ChatGPT Chat for CHAT leaves the BOT on a LAIN route', async () => {
    const si = require('../../src/sessionintel');
    const app = mkApp();
    app.cfg.model = 'some-model';
    app.session.chatSource = 'chatgpt-web';
    app.session.sourceSelections = { 'chatgpt-web': 'gpt-x' };
    const r = si.resolve(app, app.session);
    assert.strictEqual(r.bot.source, 'lain');
    assert.strictEqual(r.bot.model, 'some-model');
    for (const lane of ['bot', 'coding']) {
      for (const scope of ['session', 'project', 'global']) {
        const s = await si.set(app, app.session, { lane, value: 'luna-chat-xhigh', scope });
        assert.strictEqual(s.ok, false, `${lane}/${scope}`);
        assert.strictEqual(s.code, 'chat-only');
      }
    }
    // (A session still pointing at the retired source resolves on LAIN; the refusals changed nothing.)
  });

  await test('CHAT ONLY: workers, the /model default and the transport never take it', () => {
    const workers = require('../../src/workers');
    const cfg = { workers: { decision_intent: { model: 'luna-chat-xhigh', gate: { pass: true } }, evidence_narrower: { model: 'gpt-x', source: 'chatgpt-web', gate: { pass: true } } } };
    assert.strictEqual(workers.binding(cfg, 'decision_intent'), null, 'a worker never binds to the alias');
    assert.strictEqual(workers.binding(cfg, 'evidence_narrower'), null, 'nor to the website source');
    const pc = require('../../src/provider').resolve({ connections: {}, model: 'luna-chat-xhigh' });
    assert.ok(!pc.protocol, 'the alias is not a model any route serves');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modelcommand.js'), 'utf8');
    assert.ok(/agentGate\(app, model\.id\)/.test(src) && /agentGate\(app, m\.id\)/.test(src), 'both /model setters are gated');
  });

  await test('CHAT ONLY: ChatGPT Chat usage is its own source — observed, estimated by LAIN, never counted as reported tokens', () => {
    const usage = require('../../src/usage');
    const web = usage.fromRecord({ id: 'w1', at: Date.now(), transport: 'website', connection: 'chatgpt-web', provider: 'chatgpt-web', ok: true, ms: 1200,
      receipt: { inputTokens: 250, outputTokens: 100, estimated: true, observed: { inChars: 1000, outChars: 400, basis: 'Estimated by LAIN (characters / 4)' } } });
    const api = usage.fromRecord({ id: 'a1', at: Date.now(), transport: 'api', connection: 'lain:openai', provider: 'openai', model: 'gpt-5', ok: true, ms: 800, receipt: { inputTokens: 10, outputTokens: 5 } });
    assert.strictEqual(web.via, 'Website · ChatGPT Chat'); assert.strictEqual(web.tokens, 'estimated'); assert.strictEqual(web.role, 'chat');
    assert.strictEqual(api.via, 'API');
    const s = usage.sum([web, api], {});
    assert.strictEqual(s.input, 10, 'the estimate is not added to reported input');
    assert.strictEqual(s.estimated.input, 250);
    assert.strictEqual(s.observed.inChars, 1000);
    const by = usage.aggregate([web, api], 'via', {}).map((g) => g.key).sort();
    assert.deepStrictEqual(by, ['API', 'Website · ChatGPT Chat'], 'never merged with Codex or the OpenAI API');
  });
};
