'use strict';

/** `lain -p` waiting (printwait.js): only this run's jobs; Ctrl+C stops them and ends the wait. */

const assert = require('assert');
const { test } = require('../helpers');
const pw = require('../../src/printwait');
const { AgentJobs } = require('../../src/agentjob');

module.exports = async function () {
  await test('PRINT WAIT: a job that existed before the run is not waited for; one started in it is', async () => {
    const app = { jobs: new AgentJobs() };
    const old = app.jobs.create({ request: 'an older background agent' });
    const before = pw.jobIds(app);
    const mine = app.jobs.create({ request: 'started in this run' });
    assert.deepStrictEqual(pw.startedSince(app, before).map((x) => x.job.id), [mine.id]);
    setTimeout(() => { mine.resultSummary = 'found it'; mine._finish('SUCCEEDED', { result: 'found it' }); }, 30);
    const out = [];
    const r = await pw.waitAndReport(app, before, { write: (s) => out.push(s) });
    assert.deepStrictEqual([r.waited, r.interrupted], [1, false]);
    assert.match(out.join(''), /agent #2 · DONE · started in this run\n  found it/);
    assert.strictEqual(old.done, false, 'the older job is left alone');
  });

  await test('PRINT WAIT: Ctrl+C stops every job and ends the wait', async () => {
    const app = { jobs: new AgentJobs() };
    const before = pw.jobIds(app);
    const job = app.jobs.create({ request: 'never ends' });
    setTimeout(() => process.emit('SIGINT'), 30);
    const r = await pw.waitAndReport(app, before, { write: () => {} });
    assert.strictEqual(r.interrupted, true);
    assert.strictEqual(job.state, 'CANCELLED');
    assert.strictEqual(process.listenerCount('SIGINT'), 0, 'the handler is removed after the wait');
  });
};
