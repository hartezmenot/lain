'use strict';

const assert = require('assert');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const { App } = require('../../src/app');
const binding = require('../../src/cowork/sessionstate');
const artifacts = require('../../src/cowork/artifacts');
const tools = require('../../src/tools');
const interaction = require('../../src/interaction');

function appAt(cwd, cfg) {
  return new App({ cfg, out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd });
}
function start(app) {
  binding.bind(app.session, 'harness', binding.sourceBinding('harness', [app.session.id, app.session.cwd]));
  const harness = require('../../src/harnesslink').harnessFor(app);
  const task = harness.begin({ title: 'Email task', objective: 'send approved email', sessionId: app.session.id }); harness.runtime.start(task.id);
}

module.exports = async function () {
  await test('COWORK EMAIL: configured process bridge keeps credentials out of requests and stores a send receipt', async () => {
    const cwd = tmpdir('cowork-email-'), old = process.env.COWORK_TEST_EMAIL_TOKEN;
    process.env.COWORK_TEST_EMAIL_TOKEN = 'credential-must-never-enter-request';
    const cfg = { cowork: { services: { email: { command: [process.execPath, path.join(__dirname, '..', 'fixtures', 'cowork-email-service.js')], envFrom: { FIXTURE_EMAIL_TOKEN: 'COWORK_TEST_EMAIL_TOKEN' } } } } };
    const app = appAt(cwd, cfg); start(app);
    try {
      const found = await tools.execute('cowork_email_search', { query: 'quarterly update' }, { app, cwd });
      assert.strictEqual(found.isError, undefined); assert.match(found.output, /Quarterly update/);
      const draft = await tools.execute('cowork_email_draft', { to: ['friend@example.com'], subject: 'Fixture send', body: 'Please review.\nThanks.' }, { app, cwd });
      const sent = await interaction.run(app, { ask: async () => 'Approve once' }, () => tools.execute('cowork_email_send', { draft_ref: draft.artifact.ref }, { app, cwd }));
      assert.match(sent.output, /Email sent/); assert.strictEqual(JSON.parse(artifacts.bytes(app, sent.artifact.ref)).messageId, 'sent-42');
      assert.ok(!found.output.includes(process.env.COWORK_TEST_EMAIL_TOKEN));
    } finally {
      if (old === undefined) delete process.env.COWORK_TEST_EMAIL_TOKEN; else process.env.COWORK_TEST_EMAIL_TOKEN = old;
      await require('../../src/harnesslink').shutdown(app);
    }
  });
};
