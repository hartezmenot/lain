'use strict';

const assert = require('assert');
const { test, tmpdir } = require('../helpers');
const binding = require('../../src/cowork/sessionstate');
const attachments = require('../../src/cowork/attachments');
const artifacts = require('../../src/cowork/artifacts');
const contract = require('../../src/cowork/contract');
const runtime = require('../../src/cowork/runtime');
const worker = require('../../src/cowork/worker');
const routes = require('../../src/harnessapp/routes');
const tools = require('../../src/tools');
const interaction = require('../../src/interaction');

function appAt(cwd) {
  const { App } = require('../../src/app');
  return new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd });
}

function start(app, source = 'harness', identity = null) {
  binding.bind(app.session, source, binding.sourceBinding(source, identity || [app.session.id, app.session.cwd]));
  const harness = require('../../src/harnesslink').harnessFor(app);
  const task = harness.begin({ title: 'Cowork task', objective: 'produce an owned result', sessionId: app.session.id });
  harness.runtime.start(task.id);
  return task;
}

module.exports = async function () {
  await test('COWORK: source identity is stable and another source cannot take over', () => {
    const app = appAt(tmpdir('cowork-'));
    const marker = binding.bind(app.session, 'harness', binding.sourceBinding('harness', 'owner'));
    assert.strictEqual(binding.from(marker).source, 'harness');
    assert.throws(() => binding.bind(app.session, 'telegram', binding.sourceBinding('telegram', 'owner')), /different source/);
  });

  await test('COWORK: its tools appear only for a bound session and artifact outputs do not request workspace trust', () => {
    const app = appAt(tmpdir('cowork-'));
    assert.strictEqual(tools.has('cowork_artifacts', app), false);
    start(app);
    for (const name of ['cowork_artifacts', 'cowork_spreadsheet_inspect', 'cowork_spreadsheet_transform', 'cowork_spreadsheet_create',
      'cowork_image_inspect', 'cowork_image_transform', 'cowork_document_inspect', 'cowork_document_transform', 'cowork_document_create', 'cowork_deliver_artifact']) {
      assert.strictEqual(tools.has(name, app), true, name);
      assert.strictEqual(tools.isMutating(name, app), false, `${name} writes only the task-owned artifact store`);
    }
  });

  await test('COWORK: staged bytes become opaque task-owned inputs without leaking a path', () => {
    const app = appAt(tmpdir('cowork-')); start(app);
    assert.strictEqual(attachments.stage(app, { name: 'bad.txt', data: 'YQ' }).ok, false);
    const staged = attachments.stage(app, { name: '../sales data.csv', mime: 'text/csv', data: Buffer.from('a,b\n1,2\n').toString('base64') });
    assert.strictEqual(staged.ok, true); assert.match(staged.attachment.ref, /^cwi_[a-f0-9]{24}$/);
    const prompt = attachments.promote(app); assert.match(prompt, /cwa_[a-f0-9]{28}/); assert.ok(!prompt.includes(app.session.cwd));
    const list = artifacts.list(app); assert.strictEqual(list.length, 1); assert.strictEqual(list[0].name, 'sales_data.csv');
    assert.ok(!Object.prototype.hasOwnProperty.call(list[0], 'path')); assert.ok(!Object.prototype.hasOwnProperty.call(list[0], 'taskId'));
    assert.strictEqual(artifacts.bytes(app, list[0].ref).toString(), 'a,b\n1,2\n');
  });

  await test('COWORK: the staged attachment bound evicts bytes as well as metadata', () => {
    const app = appAt(tmpdir('cowork-')); start(app);
    const first = attachments.stage(app, { name: 'first.txt', data: 'MQ==' });
    const firstRow = attachments.pending(app.session)[0], firstPath = attachments.pathFor(app, firstRow);
    assert.strictEqual(first.ok, true); assert.ok(require('fs').existsSync(firstPath));
    for (let index = 0; index < attachments.MAX_INPUTS; index++) {
      assert.strictEqual(attachments.stage(app, { name: `${index}.txt`, data: 'Mg==' }).ok, true);
    }
    assert.strictEqual(attachments.list(app).length, attachments.MAX_INPUTS);
    assert.strictEqual(require('fs').existsSync(firstPath), false, 'evicted staged bytes must not accumulate in scratch');
  });

  await test('COWORK: artifact references deny another session and survive exact resume', () => {
    const cwd = tmpdir('cowork-'), primaryApp = appAt(cwd); start(primaryApp);
    const kept = artifacts.keep(primaryApp, { name: 'receipt.txt', body: Buffer.from('durable') }); primaryApp.session.save();
    const other = appAt(cwd); start(other); assert.strictEqual(artifacts.bytes(other, kept.ref), null);
    const { App } = require('../../src/app');
    const resumed = new App({ out: { write() {}, on() {}, isTTY: false }, interactive: false, cwd, resume: primaryApp.session.id });
    assert.strictEqual(artifacts.bytes(resumed, kept.ref).toString(), 'durable');
  });

  await test('COWORK: the frontend projection contains task, activity, artifacts, jobs and honest capability states', () => {
    const app = appAt(tmpdir('cowork-')), task = start(app);
    const kept = artifacts.keep(app, { name: 'result.txt', body: Buffer.from('result') });
    const value = runtime.project(app);
    assert.strictEqual(value.currentTask.id, task.id); assert.strictEqual(value.artifacts[0].ref, kept.ref);
    assert.strictEqual(value.capabilities.artifacts.state, 'AVAILABLE'); assert.strictEqual(value.capabilities.email.state, 'UNCONFIGURED');
    assert.ok(Object.values(contract.FAILURE).includes('INCONCLUSIVE')); assert.ok(!JSON.stringify(value).includes(app.session.cwd));
  });

  await test('COWORK: Harness routes bind empty sessions, stage inputs and retrieve only owned bytes', async () => {
    const app = appAt(tmpdir('cowork-'));
    assert.strictEqual((await routes.dispatch(app, 'POST', '/api/cowork/attachment', { name: 'x', data: 'eA==' })).code, 403);
    assert.strictEqual((await routes.dispatch(app, 'POST', '/api/cowork/bind', {})).code, 200); start(app);
    const kept = artifacts.keep(app, { name: 'route.txt', body: Buffer.from('route') });
    const fetched = await routes.dispatch(app, 'POST', '/api/cowork/artifact', { ref: kept.ref });
    assert.strictEqual(fetched.code, 200); assert.strictEqual(Buffer.from(fetched.body.artifact.data, 'base64').toString(), 'route');
    assert.ok(!Object.prototype.hasOwnProperty.call(fetched.body.artifact, 'path'));
    assert.strictEqual((await routes.dispatch(app, 'POST', '/api/cowork/artifact', { ref: 'cwa_' + '0'.repeat(28) })).code, 404);
  });

  await test('COWORK: Harness background controls delegate to the existing App job authority', async () => {
    const app = appAt(tmpdir('cowork-'));
    assert.strictEqual((await routes.dispatch(app, 'POST', '/api/cowork/background', { text: 'prepare report' })).code, 403);
    await routes.dispatch(app, 'POST', '/api/cowork/bind', {});
    let cancelled = false, answered = '';
    const job = { id: '7', primary: false, state: 'RUNNING', needsInput: false, summary() { return this; },
      cancel() { cancelled = true; return true; }, reply(value) { answered = value; return true; } };
    app.jobs = { running: () => [], all: () => [job], get: id => String(id) === job.id ? job : null };
    app.startBackground = text => { assert.strictEqual(text, 'prepare report'); return job; };
    const started = await routes.dispatch(app, 'POST', '/api/cowork/background', { text: 'prepare report' });
    assert.strictEqual(started.code, 200); assert.strictEqual(started.body.job.id, '7');
    assert.strictEqual((await routes.dispatch(app, 'POST', '/api/cowork/cancel', { id: '7' })).code, 200); assert.strictEqual(cancelled, true);
    job.needsInput = true;
    assert.strictEqual((await routes.dispatch(app, 'POST', '/api/cowork/answer', { id: '7', answer: 'Friday' })).code, 200); assert.strictEqual(answered, 'Friday');
  });

  await test('COWORK: remote delivery uses the originating interaction and remains idempotently addressable', async () => {
    const app = appAt(tmpdir('cowork-')); start(app);
    const kept = artifacts.keep(app, { name: 'send.txt', body: Buffer.from('send') }); let delivered = null;
    const result = await interaction.run(app, { deliverArtifact: async ref => { delivered = ref; return [{ state: 'delivered' }]; } },
      () => tools.execute('cowork_deliver_artifact', { input_ref: kept.ref }, { app, cwd: app.session.cwd }));
    assert.strictEqual(delivered, kept.ref); assert.match(result.output, /delivered/);
  });

  await test('COWORK: operation and workbook inputs are closed and bounded', () => {
    assert.deepStrictEqual(worker.cleanOperations('image', [{ op: 'resize', width: 20, ignored: 'no' }]), [{ op: 'resize', width: 20 }]);
    assert.strictEqual(worker.cleanOperations('image', [{ op: 'run_anything' }]), null);
    assert.strictEqual(worker.cleanOperations('document', []), null);
    assert.strictEqual(worker.cleanSheetsData([{ name: 'x', rows: [[1, '=A1']] }])[0].rows[0][1], '=A1');
    assert.strictEqual(worker.outputName('spreadsheet', 'sales.xlsx', '', 'create'), 'sales-created.xlsx');
  });
};
