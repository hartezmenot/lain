'use strict';

/**
 * THE HIGH-END COMPLETION CONTRACT (2026-10-02) — proportionality decides, evidence is measured against it, and only
 * a failure CAUSED BY THIS CHANGE keeps a task open. Everything else is disclosed, never a repair order.
 *
 * Measured before this pass (same GLM model, same project): a one-word label edit took 196 s and 13 model requests in
 * NORMAL, and with an unrelated red test the model edited an UNRELATED file just to get past the gate.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const { Lifecycle } = require('../../src/lifecycle');
const arbiter = require('../../src/discipline/arbiter');

const run = (life, command, ok, output = '') => life.observeTool({ name: 'run_bash', input: { command }, output: output || (ok ? 'ok' : 'FAIL'), isError: !ok, exitCode: ok ? 0 : 1 });
const write = (life, file) => life.observeTool({ name: 'edit_file', input: { path: file }, output: 'ok', mutated: [file] });

function project() {
  const root = tmpdir('cc-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(root, 'src'));
  try { require('../../src/finalsmoke')._cache.clear(); } catch { /* no cache */ }
  return root;
}

module.exports = async function () {
  await test('COMPLETION 1.1: a read-only answer finishes on request — no mutation, command or proof is owed', () => {
    const life = new Lifecycle('Read package.json and tell me the package name.');
    const v = arbiter.evaluate(life, { cwd: project(), requested: true, request: {} });
    assert.strictEqual(v.state, 'DONE', v.why);
    assert.match(v.why, /answered — nothing changed/);
  });

  await test('COMPLETION 1.1: a change request that changed nothing finishes honestly as DONE_UNVERIFIED, never a loop', () => {
    const life = new Lifecycle('Fix the parser so empty input is allowed.');
    const v = arbiter.evaluate(life, { cwd: project(), requested: true, request: {} });
    assert.strictEqual(v.state, 'DONE_UNVERIFIED');
    assert.match(v.why, /nothing was changed/);
  });

  await test('COMPLETION 1.2: a DIRECT edit is proved by a clean parse of what it touched — no test file, no suite', () => {
    const cwd = project();
    const life = new Lifecycle('Change the button label from Save to Apply.');
    write(life, path.join(cwd, 'src', 'Toolbar.jsx'));
    life.discipline.checks.parse({ rel: 'src/Toolbar.jsx', ok: true, gen: life.mutationSeq });
    const direct = arbiter.evaluate(life, { cwd, requested: true, request: {}, changeClass: 'DIRECT' });
    assert.strictEqual(direct.state, 'DONE', direct.why);
    // The same parse is NOT behavioural proof for an AGENT-class change: disclosed, not blocked.
    const agent = arbiter.evaluate(life, { cwd, requested: true, request: {}, changeClass: 'AGENT' });
    assert.strictEqual(agent.state, 'DONE_UNVERIFIED');
    assert.match(agent.why, /no current check exercises what changed/);
  });

  await test('COMPLETION 1.3: a pre-existing unrelated failure is DISCLOSED — it can never force scope creep', () => {
    const cwd = project();
    const life = new Lifecycle('Change the button label from Save to Apply.');
    run(life, 'npm test', false, 'not ok 1 - merges overlapping ranges');            // baseline: already failing
    write(life, path.join(cwd, 'src', 'Toolbar.jsx'));
    life.discipline.checks.parse({ rel: 'src/Toolbar.jsx', ok: true, gen: life.mutationSeq });
    run(life, 'npm test', false, 'not ok 1 - merges overlapping ranges');            // still failing, unrelated
    const v = arbiter.evaluate(life, { cwd, requested: true, request: {}, changeClass: 'DIRECT' });
    assert.strictEqual(v.state, 'DONE_UNVERIFIED', 'finished, with the failure reported');
    assert.match(v.why, /npm test fails \(preexisting, already failing before this task\)/);
  });

  await test('COMPLETION 1.3: a failure CAUSED by this change keeps the task open', () => {
    const cwd = project();
    const life = new Lifecycle('fix the parser');
    run(life, 'node test/parser.test.js', true);                                      // baseline: passing
    write(life, path.join(cwd, 'src', 'parser.js'));
    run(life, 'node test/parser.test.js', false, 'AssertionError: expected 2');      // now failing: ours
    const v = arbiter.evaluate(life, { cwd, requested: true, request: {} });
    assert.strictEqual(v.state, 'ACTIVE');
    assert.match(v.why, /a check that exercises this change fails/);
  });

  await test('COMPLETION 1.3: a check that names a changed file and fails (no baseline) is treated as this change\'s', () => {
    const cwd = project();
    const life = new Lifecycle('fix the parser');
    write(life, path.join(cwd, 'src', 'parser.js'));
    run(life, 'node --test test/parser.test.js', false, 'AssertionError');
    const v = arbiter.evaluate(life, { cwd, requested: true, request: {} });
    assert.strictEqual(v.state, 'ACTIVE');
  });

  await test('COMPLETION 1.5: a file the task just broke (parse FAIL) is the task\'s own failure', () => {
    const cwd = project();
    const life = new Lifecycle('Change the button label from Save to Apply.');
    write(life, path.join(cwd, 'src', 'a.js'));
    life.discipline.checks.parse({ rel: 'src/a.js', ok: false, message: 'Unexpected token', gen: life.mutationSeq });
    const v = arbiter.evaluate(life, { cwd, requested: true, request: {}, changeClass: 'DIRECT' });
    assert.strictEqual(v.state, 'ACTIVE');
    assert.match(v.why, /parse src\/a\.js/);
  });

  await test('COMPLETION: request_completion settles DONE_UNVERIFIED at once — no second accept_unverified turn', async () => {
    const { tools } = require('../../src/tools/contract');
    const cwd = project();
    const life = new Lifecycle('Refactor the parser for clarity.');
    write(life, path.join(cwd, 'src', 'parser.js'));
    const session = { cwd, lifecycle: life, _changeClass: { class: 'AGENT' } };
    const r = await tools.request_completion.run({ claims: [{ type: 'CHANGED', text: 'parser refactored' }] }, { cwd, session });
    assert.match(r.output, /^DONE_UNVERIFIED — /);
    assert.strictEqual(life.state, 'DONE_UNVERIFIED');
    assert.ok(life._closed, 'the settled verdict ends the turn');
  });

  await test('COMPLETION 1.6: a deliberate retry with a stated reason runs; a blind one is refused', () => {
    const life = new Lifecycle('fix it');
    write(life, '/p/src/a.js');
    run(life, 'npm test', false, 'ECONNREFUSED 127.0.0.1:5432');
    const retry = require('../../src/discipline/retry');
    // ENVIRONMENT failures are explained; use an UNKNOWN one for the refusal.
    run(life, 'node t.js', false, 'AssertionError');
    assert.match(retry.check(life, 'run_bash', { command: 'node t.js' }), /NOT RE-RUN/);
    assert.strictEqual(retry.check(life, 'run_bash', { command: 'node t.js', retry_reason: 'started the database service it needs' }), null);
  });

  await test('COMPLETION 1.5: diagnostics no longer misparse JSX as JavaScript', async () => {
    const dir = tmpdir('jsx-');
    const file = path.join(dir, 'Toolbar.jsx');
    fs.writeFileSync(file, 'export function Toolbar() {\n  return (<div className="t"><button>Apply</button></div>);\n}\n');
    const r = await require('../../src/diagnostics').checkFile(file);
    assert.notStrictEqual(r.ok, false, 'a valid component must never be reported broken');
    const report = await require('../../src/diagnostics').reportFor([file], dir);
    assert.doesNotMatch(report, /SYNTAX ERROR/);
  });

  await test('COMPLETION 1.7: closing words alone no longer start another turn; open asks do', () => {
    const ac = require('../../src/autocontinue');
    const T = require('../../src/turnoutcome');
    const cls = { outcome: T.OUTCOME.COMPLETED, continuable: true, why: 'ended' };
    const words = { from: null, text: 'I changed the label. Next I will look at the other buttons.', narration: [{ text: 'I changed the label. Next I will look at the other buttons.' }] };
    const plain = { lifecycle: new Lifecycle('change the label'), turns: [] };
    assert.strictEqual(ac.decide(plain, words, cls).continue, false, 'no durable unfinished work → stop');
    const asks = { lifecycle: new Lifecycle('Do these:\n1. change the label\n2. update the docs'), turns: [] };
    assert.strictEqual(ac.decide(asks, words, cls).continue, true, 'an explicit ask still open → continue');
  });

  await test('PHASE 0: plaintext credential leftovers are COUNTED, never shown and never deleted', () => {
    const dir = tmpdir('legacy-');
    const key = `sk-${'a'.repeat(30)}`;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ connections: { x: { credentialRef: 'cred:x:api_key' } } }));
    fs.writeFileSync(path.join(dir, 'config.json.pre-move-1'), JSON.stringify({ connections: { a: { apiKey: key }, b: { apiKey: key }, c: { token: 'zzzzzzzzzzzzzzzz' } } }));
    const s = require('../../src/legacysecrets').summary(dir);
    assert.ok(s, 'the leftover is found');
    assert.match(s.text, /Sensitive legacy file detected · config\.json\.pre-move-1 · 3 credential-like values/);
    assert.ok(!s.text.includes(key) && !JSON.stringify(s.found).includes(key), 'no value ever leaves the scan');
    assert.ok(fs.existsSync(path.join(dir, 'config.json.pre-move-1')), 'nothing is deleted for the person');
    assert.strictEqual(require('../../src/legacysecrets').summary(tmpdir('clean-')), null);
  });
};
