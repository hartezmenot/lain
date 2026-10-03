'use strict';

/**
 * EVERY JOB ID THE MODEL IS TOLD ABOUT IS ONE THE JOB TOOLS CAN FIND.
 *
 * Live, 2026-09-18: `/bg` detached `npm run smoke` and told the model
 * "background job #2 (pid …) — do not start it again". The model called
 * job_wait {"id":"2"} and got `no job "2". Start one with run_background.` —
 * the detach registry (app.jobs) and the job tools (app._jobs) did not share
 * ids — so it started the 90-second smoke a second time in the foreground.
 */

const assert = require('assert');
const { test } = require('../helpers');
const { AgentJobs } = require('../../src/agentjob');
const jobTools = require('../../src/tools/jobs');

function tool(name) {
  const t = jobTools[name] || (jobTools.tools && jobTools.tools[name]);
  assert.ok(t, `tool ${name} exists`);
  return t;
}

module.exports = async function () {
  await test('BG: a /bg-detached process is found by the id the notice gave, and its result is readable', async () => {
    const app = { jobs: new AgentJobs() };
    const job = app.jobs.create({ request: 'npm run smoke', kind: 'process' });
    job.pid = 4242;
    job.state = 'RUNNING';
    setTimeout(() => { job.resultSummary = 'npm run smoke · exit 0 · smoke PASSED'; job._finish('SUCCEEDED', { result: { exitCode: 0 } }); }, 50);
    const r = await require('../../src/tools/jobs').collect.run({ id: job.id }, { app });
    assert.ok(!r.isError, r.output);
    assert.match(r.output, /SUCCEEDED/);
    assert.match(r.output, /smoke PASSED/, 'the result the model needs, so it does not re-run');
    const hashed = await tool('job_status').run({ id: `#${job.id}` }, { app });
    assert.ok(!hashed.isError, 'the "#2" spelling from the notice works too');
  });

  await test('BG: job_status on a still-running detached job says it is running and will rejoin', async () => {
    const app = { jobs: new AgentJobs() };
    const job = app.jobs.create({ request: 'npm run build', kind: 'process' });
    job.state = 'RUNNING';
    const r = await tool('job_status').run({ id: job.id }, { app });
    assert.ok(!r.isError, r.output);
    assert.match(r.output, /still running/);
  });
};
