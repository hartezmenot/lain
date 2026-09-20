'use strict';

/**
 * SUBAGENTS ARE VISIBLE WITHOUT A DASHBOARD, AND CONTROLLABLE WITH ONE SETTING.
 *
 *   AGENTS N in the run state and the activity box — from the job registry,
 *   only while workers actually run; `/subagents auto|off|max N`; a transient
 *   AGENT COMPLETE note; OFF refuses delegation; max N caps concurrency.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');
const { AgentJobs } = require('../../src/agentjob');
const { Session } = require('../../src/session');
const sub = require('../../src/subagents');

const contract = (o, file) => ({ role: 'IMPLEMENTER', objective: o, readScope: ['src/**'], writeScope: [file], expectedOutput: 'x', verification: 'npm test', completion: 'passes' });

module.exports = async function () {
  await test('AGENTS I: the counter reflects the ACTUAL number of running workers — and is absent when none run', async () => {
    const session = new Session({ cwd: tmpdir('agents-') });
    const app = { session, cfg: {}, jobs: new AgentJobs(), render: { notice() {}, write() {} }, ui: { enabled: false } };
    const header = () => require('../../src/ui/headerstate').run({ app, busy: true, phase: { phase: 'RUNNING_TOOL' }, clock: null });
    let peakHeader = '';
    let release;
    const gate = new Promise((r) => { release = r; });
    const runner = async () => { peakHeader = header().parts.join(' '); await gate; return { text: 'done', mutations: [], toolCalls: 1 }; };
    const pending = sub.run(app, [contract('backend', 'src/api.js'), contract('frontend', 'src/ui.js')], { mode: 'parallel', runner });
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(sub.running(app).length, 2);
    assert.match(peakHeader, /AGENTS 2/, peakHeader);
    const box = require('../../src/ui/activitybox');
    const st = { busy: true, phase: { phase: 'RUNNING_TOOL', tool: 'delegate', target: '2 agents' }, recent: [], jobs: app.jobs.all().map((j) => j.summary()) };
    assert.match(box.agentsLine(st), /^AGENTS 2 · IMPLEMENTER · IMPLEMENTER$/);
    release();
    await pending;
    assert.strictEqual(sub.running(app).length, 0);
    assert.doesNotMatch(header().parts.join(' '), /AGENTS/, 'no counter when nothing runs');
  });

  await test('AGENTS: /subagents max N caps concurrency; OFF refuses delegation; AUTO is the default', async () => {
    const session = new Session({ cwd: tmpdir('agents-max-') });
    const app = { session, cfg: { subagents: { maxConcurrent: 1 } }, jobs: new AgentJobs(), render: { notice() {}, write() {} }, ui: { enabled: false } };
    let peak = 0;
    const runner = async () => { peak = Math.max(peak, sub.running(app).length); await new Promise((r) => setTimeout(r, 20)); return { text: 'ok', mutations: [] }; };
    const r = await sub.run(app, [contract('a', 'src/a.js'), contract('b', 'src/b.js'), contract('c', 'src/c.js')], { mode: 'parallel', runner });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(peak, 1, 'max 1 → one at a time');
    assert.deepStrictEqual(sub.settings({ cfg: {} }), { mode: 'auto', maxConcurrent: sub.DEFAULT_MAX });
    app.cfg.subagents = { mode: 'off' };
    const denied = await require('../../src/tools/delegate').tools.delegate.run({ agents: [] }, { session, app });
    assert.ok(denied.denied && /SUBAGENTS_OFF/.test(denied.output), denied.output);
  });
};
