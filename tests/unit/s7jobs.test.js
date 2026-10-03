'use strict';

/** SIMPLIFY S7 — background work in one place: in-process, output in a file under the session, one result, ends with LAIN. */

const assert = require('assert');
const fs = require('fs');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  await test('JOB: shell background:true runs in-process, streams to sessions/<id>/jobs/<job>.log, rejoins once', async () => {
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('s7-') });
    const tools = require('../../src/tools');
    const ctx = { app, session: app.session, cwd: app.session.cwd };
    const r = await tools.execute('shell', { command: 'node -e "for (let i = 0; i < 3; i++) console.log(\'LINE\' + i)"', background: true, description: 'print three lines' }, ctx);
    assert.ok(!r.isError, r.output);
    const id = r.meta && r.meta.job;
    const job = app._jobs.get(id);
    assert.strictEqual(job.label, 'print three lines');
    await job.wait();
    for (let i = 0; i < 50 && !(app.session._bgResults || []).length; i++) await new Promise((x) => setTimeout(x, 20));
    assert.ok(job.logFile && job.logFile.includes(app.session.id) && /[\\/]jobs[\\/]/.test(job.logFile), job.logFile);
    assert.match(fs.readFileSync(job.logFile, 'utf8'), /LINE0[\s\S]*LINE2/);
    const st = await tools.execute('job_status', { id }, ctx);
    assert.match(st.output, /full output: .*\.log/);
    assert.strictEqual((app.session._bgResults || []).length, 1, 'one result, once');
    assert.strictEqual(app.session._bgResults[0].label, 'print three lines');
  });

  await test('NO SUPERVISED JOBS: nothing offers to outlive LAIN, and /jobs says jobs end when it exits', async () => {
    const schema = require('../../src/tools/jobs').tools.run_background.schema;
    assert.ok(!('survive_restart' in schema.parameters.properties) && !('for_seconds' in schema.parameters.properties));
    assert.doesNotMatch(fs.readFileSync(require.resolve('../../src/tools/jobs'), 'utf8'), /require\('\.\.\/supervisor'\)/);
    const { App } = require('../../src/app');
    let printed = '';
    const app = new App({ out: { write(s) { printed += s; }, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('s7b-') });
    await require('../../src/commands').run(app, '/jobs');
    assert.match(printed, /Background jobs end when LAIN exits\./);
  });
};
