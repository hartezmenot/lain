'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');
const { Registry, sessionKey } = require('../../src/bot/contract');
const { Gateway } = require('../../src/bot/gateway');
const { Runtime } = require('../../src/bot/runtime');
const artifacts = require('../../src/cowork/artifacts');
const supervisor = require('../../src/supervisor');

const source = (changes = {}) => ({
  platform: 'telegram', accountId: 'default', chatId: 'private-chat', senderId: 'owner',
  messageId: '1', text: 'Create a sales workbook and send it back.', paired: true, ...changes,
});

module.exports = async function () {
  await test('COWORK REMOTE: Telegram uses the shared spreadsheet tool and returns its owned artifact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-cowork-remote-'));
    const previous = Object.fromEntries(['LAIN_HOME', 'LAIN_PROVIDER', 'LAIN_MOCK_SCRIPT'].map(k => [k, process.env[k]]));
    process.env.LAIN_HOME = path.join(dir, 'supervisor');
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = path.join(dir, 'script.json');
    const script = steps => {
      fs.writeFileSync(process.env.LAIN_MOCK_SCRIPT, JSON.stringify(steps));
      require('../../src/mockprovider')._reset();
    };
    const sent = [];
    const registry = new Registry().register({
      version: 1, platform: 'telegram', maxLength: 4000, buttons: true, mediaIn: true, mediaOut: true,
    }, () => ({
      identity: 'fixture-bot', state: 'listening', start: async () => {}, stop: async () => {},
      action: async action => { sent.push(action); return { messageId: String(sent.length) }; },
    }));
    const cfg = { model: 'mock-model', trustedPaths: [], bot: { platforms: {
      telegram: { enabled: true, allowUsers: ['owner'] },
    } } };
    let gateway;
    try {
      script([
        { tool_calls: [{ name: 'cowork_spreadsheet_create', input: { name: 'sales.xlsx', sheets: [{ name: 'Sales', rows: [['Item', 'Amount'], ['A', 12], ['B', 30]] }] } }] },
        { text: 'The workbook is ready.' },
      ]);
      gateway = new Gateway({ cfg, cwd: dir, dir: path.join(dir, 'bot'), registry });
      await gateway.start();
      await gateway.receive(source());
      await Promise.all([...gateway.tasks]);

      const runtime = gateway.runtimes.get(sessionKey(source()));
      assert.ok(runtime?.app.session.cowork, 'Telegram conversation must be a Cowork session');
      const owned = artifacts.list(runtime.app);
      const workbook = owned.find(row => row.name === 'sales-created.xlsx');
      assert.ok(workbook, `the model tool must create a persisted owned workbook: ${JSON.stringify({ owned, messages: runtime.app.session.messages, sent: sent.map(row => ({ type: row.type, text: row.text })) })}`);
      assert.match(workbook.ref, /^cwa_[a-f0-9]{28}$/);
      assert.strictEqual(artifacts.bytes(runtime.app, workbook.ref).subarray(0, 2).toString(), 'PK');

      script([
        { tool_calls: [{ name: 'cowork_deliver_artifact', input: { input_ref: workbook.ref } }] },
        { text: 'The workbook was delivered.' },
      ]);
      await gateway.receive(source({ messageId: '2', text: 'Send the workbook now.' }));
      await Promise.all([...gateway.tasks]);
      await Promise.all([...gateway.delivery.chains.values()]);
      const media = sent.find(action => action.type === 'media' && action.file?.name === workbook.name);
      assert.ok(media, 'the Cowork delivery tool must send the file to the originating Telegram chat');
      assert.strictEqual(media.target.chatId, 'private-chat');
      assert.deepStrictEqual(media.file.bytes, artifacts.bytes(runtime.app, workbook.ref));
      assert.ok(sent.some(action => action.text?.includes('The workbook was delivered.')));
    } finally {
      await gateway?.stop();
      await new Promise(resolve => setTimeout(resolve, 200));
      await supervisor.cleanupOwned().catch(() => {});
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('COWORK REMOTE: Telegram approves an email send in-conversation and receives the durable result', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-cowork-email-remote-'));
    const previous = Object.fromEntries(['LAIN_HOME', 'LAIN_PROVIDER', 'LAIN_MOCK_SCRIPT'].map(k => [k, process.env[k]]));
    process.env.LAIN_HOME = path.join(dir, 'supervisor'); process.env.LAIN_PROVIDER = 'mock'; process.env.LAIN_MOCK_SCRIPT = path.join(dir, 'script.json');
    const script = steps => { fs.writeFileSync(process.env.LAIN_MOCK_SCRIPT, JSON.stringify(steps)); require('../../src/mockprovider')._reset(); };
    const sent = [], serviceCalls = [];
    let gateway;
    const registry = new Registry().register({ version: 1, platform: 'telegram', maxLength: 4000, buttons: true, mediaIn: true, mediaOut: true }, () => ({
      identity: 'fixture-bot', state: 'listening', start: async () => {}, stop: async () => {}, action: async action => {
        sent.push(action);
        if (action.type === 'prompt') await gateway.receive(source({ messageId: `approval-${sent.length}`, text: '', promptResponse: { id: action.prompt.id, value: '1' } }));
        return { messageId: String(sent.length) };
      },
    }));
    const cfg = { model: 'mock-model', trustedPaths: [], bot: { platforms: { telegram: { enabled: true, allowUsers: ['owner'] } } } };
    try {
      script([{ tool_calls: [{ name: 'cowork_email_draft', input: { to: ['friend@example.com'], subject: 'Remote review', body: 'The report is ready.' } }] }, { text: 'The draft is ready for review.' }]);
      gateway = new Gateway({ cfg, cwd: dir, dir: path.join(dir, 'bot'), registry, runtimeFactory: opts => {
        const runtime = new Runtime(opts); runtime.app.coworkServices = { email: { invoke: async (operation, input) => {
          serviceCalls.push({ operation, input }); return { ok: true, data: { messageId: 'telegram-send-1', sentAt: '2026-09-12T10:00:00Z' } };
        } } }; return runtime;
      } });
      await gateway.start(); await gateway.receive(source()); await Promise.all([...gateway.tasks]);
      const runtime = gateway.runtimes.get(sessionKey(source()));
      const draft = artifacts.list(runtime.app).find(row => row.name.endsWith('.email-draft.json')); assert.ok(draft);
      script([{ tool_calls: [{ name: 'cowork_email_send', input: { draft_ref: draft.ref } }] }, { text: 'The approved email was sent.' }]);
      await gateway.receive(source({ messageId: '2', text: 'Approve and send that draft.' })); await Promise.all([...gateway.tasks]); await Promise.all([...gateway.delivery.chains.values()]);
      assert.strictEqual(serviceCalls.length, 1); assert.strictEqual(serviceCalls[0].operation, 'send'); assert.deepStrictEqual(serviceCalls[0].input.to, ['friend@example.com']);
      assert.ok(sent.some(action => action.type === 'prompt' && action.text.includes('friend@example.com')));
      assert.ok(sent.some(action => action.text?.includes('The approved email was sent.')));
      const receipt = artifacts.list(runtime.app).find(row => row.name === 'email-send-receipt.json'); assert.ok(receipt); assert.strictEqual(JSON.parse(artifacts.bytes(runtime.app, receipt.ref)).messageId, 'telegram-send-1');
    } finally {
      await gateway?.stop(); await supervisor.cleanupOwned().catch(() => {}); await require('../../src/harness/processes').cleanupOwned().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 300));
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
};
