'use strict';

/**
 * PHASE 4 — agents: read-only roles in parallel when worthwhile, foreground and background, small structured results,
 * per-agent model / effort / skills / tools, and no agent teams.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const subagents = require('../../src/subagents');
const { Session } = require('../../src/session');
const { AgentJobs } = require('../../src/agentjob');

function fakeApp(root) {
  const session = new Session({ cwd: root });
  return { session, cfg: {}, jobs: new AgentJobs(), ui: { enabled: false }, render: { notice() {} } };
}
const scout = (objective, over = {}) => ({ role: 'SCOUT', objective, readScope: ['src/**'], writeScope: [], expectedOutput: 'findings', verification: 'cite file:line', completion: 'answered', ...over });
const RESULT = (who) => `I looked around.\nRESULT\nsummary: ${who} found the owner.\nfindings:\n- src/${who}.js:7 owns the retry\nchanged: none\nverified: read src/${who}.js\nopen: none\n${'(long narrative) '.repeat(400)}`;

module.exports = async function () {
  await test('PARALLEL: independent read-only agents run together; a later stage gets their digests, not their essays', async () => {
    const app = fakeApp(tmpdir('ag-par-'));
    const spans = [];
    const briefs = [];
    const runner = async ({ contract, brief }) => {
      const s = { role: contract.role, objective: contract.objective, start: Date.now() };
      briefs.push({ objective: contract.objective, brief });
      await new Promise((r) => setTimeout(r, 120));
      s.end = Date.now(); spans.push(s);
      return { text: RESULT(contract.objective.split(' ')[0]), stopReason: 'end', toolCalls: 2 };
    };
    const out = await subagents.run(app, [scout('alpha map the retry path'), scout('beta map the config path'), scout('gamma map the tests', { role: 'RESEARCHER' })], { runner });
    assert.ok(out.ok, JSON.stringify(out).slice(0, 300));
    assert.strictEqual(out.mode, 'parallel', 'all read-only → parallel');
    const [a, b] = spans;
    assert.ok(a.start < b.end && b.start < a.end, 'their runs overlapped');
    const rep = subagents.report(out);
    assert.match(rep, /alpha found the owner/);
    assert.match(rep, /src\/alpha\.js:7 owns the retry/);
    assert.ok(!/\(long narrative\)/.test(rep), 'the narrative stays out of the main conversation');
    assert.match(rep, /recall_evidence \{"id":"e\d+"\}/, 'the full report is one recall away');
    const e = require('../../src/evidencerefs').get(app.session, out.results[0].evidence);
    assert.ok(e.entry && /\(long narrative\)/.test(e.entry.content), 'and it is kept whole as evidence');
  });

  await test('AUTO: read-only head in parallel, then the rest in order — the next stage is briefed with the head\'s digests', async () => {
    const app = fakeApp(tmpdir('ag-auto-'));
    const briefs = [];
    const runner = async ({ contract, brief }) => { briefs.push({ role: contract.role, brief }); return { text: RESULT(contract.role.toLowerCase()), stopReason: 'end' }; };
    const v = { role: 'VERIFIER', objective: 'run the tests', readScope: ['**'], writeScope: [], expectedOutput: 'pass/fail', verification: 'npm test', completion: 'ran' };
    const out = await subagents.run(app, [scout('alpha one'), scout('beta two'), v], { runner });
    assert.strictEqual(out.mode, 'auto');
    assert.strictEqual(out.parallelHead, 2);
    const vb = briefs.find((x) => x.role === 'VERIFIER').brief;
    assert.match(vb, /From SCOUT \(stage 1\):\nscout found the owner/);
    assert.ok(!/\(long narrative\)/.test(vb), 'a stage is handed digests, not the essays');
    assert.match(subagents.report(out), /auto \(first 2 in parallel\)/);
    const single = await subagents.run(app, [scout('only one')], { runner });
    assert.strictEqual(single.mode, 'pipeline', 'one agent is not worth a parallel wave');
  });

  await test('PER AGENT: effort, skills and tools are its own — tools narrow its role, never widen it', () => {
    const v = subagents.validate(scout('x', { effort: 'LOW', skills: ['house-style'], tools: ['read', 'edit'], model: 'glm-5.3' }));
    assert.ok(v.ok);
    assert.strictEqual(v.contract.effort, 'low');
    assert.deepStrictEqual(v.contract.skills, ['house-style']);
    assert.strictEqual(v.contract.model, 'glm-5.3');
    assert.strictEqual(subagents.validate(scout('x', { effort: 'turbo' })).contract.effort, null, 'an unknown effort is dropped, not passed on');
    const tf = require('../../src/toolfunnel');
    const s = {}; tf.openForRole(s, 'SCOUT', { only: ['read', 'edit'] });
    assert.ok(tf.shows(s, 'read_file') && !tf.shows(s, 'edit_file'), 'edit is not a SCOUT family — asking for it grants nothing');
    assert.ok(!tf.shows(s, 'symbols'), 'and intel, not asked for, is narrowed away');
    const home = require('../../src/home').resolve();
    const dir = path.join(home, 'skills', 'house-style');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: house-style\ndescription: House style\n---\nAlways name the owner.\n');
    require('../../src/skills').clearCache();
    const brief = subagents.brief(v.contract);
    assert.match(brief, /Skill "house-style":\nAlways name the owner\./);
    assert.match(brief, /FINISH WITH THIS BLOCK/);
    fs.rmSync(dir, { recursive: true, force: true });
    require('../../src/skills').clearCache();
  });

  await test('BACKGROUND: the turn is not held; one result rejoins the session by itself — nothing to wait on', async () => {
    const app = fakeApp(tmpdir('ag-bg-'));
    let release;
    const gate = new Promise((r) => { release = r; });
    const runner = async ({ contract }) => { await gate; return { text: RESULT(contract.objective.split(' ')[0]), stopReason: 'end' }; };
    const t0 = Date.now();
    const out = await subagents.run(app, [scout('alpha bg'), scout('beta bg')], { runner, background: true });
    assert.ok(Date.now() - t0 < 500, 'returned at once');
    assert.strictEqual(out.background, true);
    assert.match(subagents.report(out), /their result rejoins this session.*do not wait or poll/);
    assert.strictEqual(require('../../src/bgdetach').takeContext(app.session), '', 'nothing yet');
    release();
    await out.promise;
    await new Promise((r) => setImmediate(r));
    const ctx = require('../../src/bgdetach').takeContext(app.session);
    assert.match(ctx, /# Background results \(rejoined\)\n#[^\n]* agents · 2 agents · OK · 2\/2 agents done/);
    assert.match(ctx, /alpha found the owner/);
    assert.strictEqual(require('../../src/bgdetach').takeContext(app.session), '', 'delivered once');
  });

  await test('NO TEAMS: a subagent cannot delegate, and agents only ever report to the main agent', () => require('../helpers').legacyOnly(async () => {   // LEGACY path only
    const r = await require('../../src/tools').execute('delegate', { agents: [scout('x')] }, { app: fakeApp(tmpdir('ag-team-')), workOrder: { bounded: true } });
    assert.ok(r.denied && /a subagent cannot use delegate/.test(r.output));
    assert.ok(!require('../../src/toolfunnel').ROLE_PACKS.SCOUT.includes('delegation'));
    for (const role of Object.keys(require('../../src/toolfunnel').ROLE_PACKS)) assert.ok(!require('../../src/toolfunnel').ROLE_PACKS[role].includes('delegation'), `${role} has no delegation tools`);
  }));
};
