'use strict';

const assert = require('assert');
const { test, tmpdir } = require('../helpers');
const { App } = require('../../src/app');
const binding = require('../../src/cowork/sessionstate');
const artifacts = require('../../src/cowork/artifacts');
const interaction = require('../../src/interaction');
const tools = require('../../src/tools');

function start(app) {
  binding.bind(app.session, 'harness', binding.sourceBinding('harness', [app.session.id, app.session.cwd]));
  const harness = require('../../src/harnesslink').harnessFor(app), task = harness.begin({ title: 'Personal work', objective: 'manage personal services', sessionId: app.session.id });
  harness.runtime.start(task.id);
}

module.exports = async function () {
  await test('COWORK PERSONAL: calendar, contacts, reminders and notes share list, approval and receipt contracts', async () => {
    const cwd = tmpdir('cowork-personal-'), app = new App({ out: { write() {}, on() {}, isTTY: false }, interactive: false, cwd }); start(app);
    const calls = [];
    for (const domain of ['calendar', 'contacts', 'reminders', 'notes']) app.coworkServices ||= {}, app.coworkServices[domain] = { invoke: async (operation, input) => {
      calls.push({ domain, operation, input });
      return operation === 'list' ? { ok: true, data: { items: [{ id: `${domain}-1`, ...(domain === 'contacts' ? { name: `${domain} item` } : { title: `${domain} item` }), ignored: 'never public' }] } }
        : { ok: true, data: { id: input.id || `${domain}-new`, completedAt: '2026-09-12T11:00:00Z' } };
    } };
    const inputs = {
      calendar: { action: 'create', title: 'Planning', start: '2026-09-14T09:00:00+08:00', end: '2026-09-14T10:00:00+08:00' },
      contacts: { action: 'create', name: 'Ada', emails: ['ada@example.com'] },
      reminders: { action: 'complete', id: 'reminder-1' }, notes: { action: 'create', title: 'Ideas', body: 'First idea' },
    };
    for (const domain of Object.keys(inputs)) {
      const listed = await tools.execute(`cowork_${domain}_list`, { query: 'item' }, { app, cwd }); assert.match(listed.output, new RegExp(`${domain} item`)); assert.ok(!listed.output.includes('never public'));
      const changed = await interaction.run(app, { ask: async q => { assert.match(q.question, new RegExp(domain)); return 'Approve once'; } },
        () => tools.execute(`cowork_${domain}_change`, inputs[domain], { app, cwd }));
      assert.match(changed.output, /Receipt/); assert.ok(artifacts.bytes(app, changed.artifact.ref));
    }
    assert.strictEqual(calls.filter(row => row.operation === 'list').length, 4); assert.strictEqual(calls.filter(row => row.operation !== 'list').length, 4);
    const caps = require('../../src/cowork/runtime').project(app).capabilities;
    for (const domain of ['calendar', 'contacts', 'reminders', 'notes']) assert.strictEqual(caps[domain].state, 'CONFIGURED');
    await require('../../src/harnesslink').shutdown(app);
  });
};
