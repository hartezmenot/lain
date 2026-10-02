'use strict';

/**
 * EXECUTION DISCIPLINE (src/discipline/) — LAIN owns the discipline, the model owns judgment.
 *
 * Proven here against the real modules: asks and acceptance criteria as state · CheckState with baselines,
 * generations, realism and discrimination · test-integrity detection from real before/after text · typed claims
 * cross-checked and downgraded · the completion arbiter's states · verification proportional to the change, with
 * verifycontract as the one authority (no universal final smoke) · OUTCOME SATISFIED stopping further edits ·
 * no blind retries · tool dialects run through the canonical door · capability profiles reduce discretion, never
 * the standard · the continuity digest · LAIN.md as the canonical constitution.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const { Lifecycle, STATE } = require('../../src/lifecycle');
const { extractAsks } = require('../../src/discipline/contract');
const integrity = require('../../src/discipline/integrity');
const claims = require('../../src/discipline/claims');
const arbiter = require('../../src/discipline/arbiter');
const dialect = require('../../src/discipline/dialect');
const profile = require('../../src/discipline/profile');

const run = (life, command, ok, output = '') => life.observeTool({ name: 'run_bash', input: { command }, output: output || (ok ? 'ok' : 'FAIL'), isError: !ok, exitCode: ok ? 0 : 1 });
const write = (life, file) => life.observeTool({ name: 'edit_file', input: { path: file }, output: 'ok', mutated: [file] });
const preview = (life, name, input, text) => life.observeTool({ name, input, output: text, isError: false });

function project() {
  const root = tmpdir('discipline-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node test.js', smoke: 'node smoke.js' } }));
  fs.mkdirSync(path.join(root, 'src'));
  require('../../src/finalsmoke')._cache.clear();
  return root;
}

module.exports = () => require('../helpers').legacyOnly(async () => {   // LEGACY path only (Simplify S10 deletes)
  await test('DISCIPLINE: explicit asks are only what the person enumerated; anything else is one ask', () => {
    const asks = extractAsks('Do these:\n1. startup setting\n2. remove old executable\n3. keep the virtual mouse\n- rerun the tests');
    assert.deepStrictEqual(asks.map((a) => a.id), ['A1', 'A2', 'A3', 'A4']);
    assert.strictEqual(asks[2].text, 'keep the virtual mouse');
    assert.strictEqual(extractAsks('Fix Save so the value survives a reload, and add a test').length, 1, 'no guessed split');
    const life = new Lifecycle('A1 startup\nA2 remove lain.exe');
    assert.strictEqual(life.discipline.contract.asks.length, 2);
  });

  await test('CHECKSTATE: baseline before the change, latest after it — FAIL→PASS is HIGH, an unrelated pass is LOW, a stale one NIL', () => {
    const life = new Lifecycle('fix the parser');
    run(life, 'node test/parser.test.js', false, 'AssertionError: expected 2');      // baseline: failing
    write(life, '/p/src/parser.js');
    run(life, 'node test/parser.test.js', true);
    run(life, 'npm run lint', true);
    const d = life.discipline; const gen = life.mutationSeq;
    const k = d.checks.commands();
    assert.strictEqual(k[0].baseline, 'FAIL');
    assert.strictEqual(d.checks.discrimination(k[0], gen), 'HIGH', 'failed before, passes after');
    assert.strictEqual(k[1].realism, 'STATIC');
    assert.strictEqual(d.checks.discrimination(k[1], gen), 'LOW', 'passing, but would have passed before');
    write(life, '/p/src/parser.js');
    assert.strictEqual(d.checks.discrimination(k[0], life.mutationSeq), 'NIL', 'a change after it makes it stale');
  });

  await test('CHECKSTATE: RED is not automatically "wrong" — an environmental failure is information, not a contradiction', () => {
    const life = new Lifecycle('fix');
    write(life, '/p/src/a.js');
    run(life, 'node src/a.js', true);
    run(life, 'npm run e2e', false, 'Error: connect ECONNREFUSED 127.0.0.1:5432');
    assert.strictEqual(life.discipline.checks.commands()[1].latest.classification, 'ENVIRONMENT');
    assert.deepStrictEqual(life.discipline.checks.contradictions(life.mutationSeq), []);
    assert.strictEqual(life.complete({ cwd: tmpdir('d-') }).ok, true, 'the change is evidenced; the database being down is not its verdict');
  });

  await test('INTEGRITY: removed assertions, skips, xfail, inflated timeouts, weakened checks, snapshots, test-only branches, mocks', () => {
    const before = "it('adds', () => {\n  assert.strictEqual(add(1, 2), 3);\n  assert.strictEqual(add(2, 2), 4);\n}, 2000);\n";
    const kinds = (rel, b, a) => integrity.analyze(rel, b, a).map((f) => f.kind).sort();
    assert.deepStrictEqual(kinds('test/add.test.js', before, "it('adds', () => {\n  assert.strictEqual(add(1, 2), 3);\n}, 2000);\n"), ['ASSERTION_REMOVED']);
    assert.deepStrictEqual(kinds('test/add.test.js', before, before.replace("it('adds'", "it.skip('adds'")), ['SKIP_ADDED']);
    assert.deepStrictEqual(kinds('test/add.test.js', before, before.replace('2000);', '60000);')), ['TIMEOUT_INFLATED']);
    assert.ok(kinds('test/add.test.js', before, before.split('strictEqual').join('equal')).includes('ASSERTION_WEAKENED'));
    assert.deepStrictEqual(kinds('tests/test_x.py', 'def test_a():\n    assert f() == 1\n', '@pytest.mark.xfail\ndef test_a():\n    assert f() == 1\n'), ['XFAIL_ADDED']);
    assert.deepStrictEqual(kinds('src/__snapshots__/a.test.js.snap', 'old', 'new'), ['SNAPSHOT_UPDATED']);
    assert.deepStrictEqual(kinds('src/pay.js', 'return charge(x);\n', "if (process.env.NODE_ENV === 'test') return true;\nreturn charge(x);\n"), ['TEST_ONLY_BRANCH']);
    assert.deepStrictEqual(kinds('test/pay.test.js', "test('x', () => { expect(pay()).toBe(1); });\n", "jest.mock('../src/bank');\ntest('x', () => { expect(pay()).toBe(1); });\n"), ['MOCK_ADDED']);
    assert.deepStrictEqual(kinds('test/new.test.js', null, "it('x', () => assert.ok(1));\n"), [], 'adding a test is not a flag');
  });

  await test('INTEGRITY: an undisclosed test change is never plain DONE — LAIN discloses it; disclosed by the model, it may finish', () => {
    const life = new Lifecycle('make the test pass');
    life.discipline.noteWrite('test/add.test.js', "it('a', () => { assert.ok(x); assert.ok(y); });", "it.skip('a', () => { assert.ok(x); });");
    write(life, '/p/test/add.test.js');
    run(life, 'node test/add.test.js', true);
    const r = life.complete({ cwd: tmpdir('d-') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.verdict, 'DONE_UNVERIFIED', 'the outcome carries the disclosure instead of costing a turn');
    assert.match(r.why, /test change affects verification.*(SKIP_ADDED|ASSERTION_REMOVED)/);
    life.discipline.disclose(['all'], 'the assertion was wrong: y is optional by spec');
    assert.strictEqual(life.complete({ cwd: tmpdir('d-') }).ok, true);
  });

  await test('CLAIMS: "Windows package verified" with no packaging run is downgraded to NOT_CHECKED', () => {
    const life = new Lifecycle('fix the parser');
    write(life, '/p/src/parser.js');
    run(life, 'node test/parser.test.js', true);
    const said = life.contradiction('Fixed the parser. The Windows package is verified and the installer works.');
    assert.match(said, /Not verified by LAIN/);
    assert.match(said, /packaging/);
    const typed = claims.crossCheck([{ type: 'VERIFIED', text: 'parser tests pass', check: life.discipline.checks.commands()[0].id }, { type: 'VERIFIED', text: 'release build works', check: 'K99' }],
      { ledger: life.discipline.checks, gen: life.mutationSeq, changed: ['/p/src/parser.js'] });
    assert.deepStrictEqual(typed.map((c) => c.as), ['VERIFIED', 'NOT_CHECKED']);
    assert.strictEqual(life.contradiction('Fixed the parser; the parser tests pass.'), null, 'a supported claim is left alone');
  });

  await test('ARBITER: DONE · DONE_UNVERIFIED · PARTIAL · BLOCKED · NEEDS_DECISION — the model requests, LAIN decides', () => {
    const cwd = tmpdir('d-');
    const life = new Lifecycle('1. add the setting\n2. document it');
    write(life, '/p/src/settings.js');
    run(life, 'node test/settings.test.js', true);
    let v = arbiter.evaluate(life, { cwd, requested: true });
    assert.strictEqual(v.state, 'PARTIAL');
    assert.match(v.why, /A1.*A2|A2/);
    life.discipline.contract.ask('A1', { status: 'ADDRESSED' }); life.discipline.contract.ask('A2', { status: 'DEFERRED', note: 'docs next' });
    life.discipline.contract.criterion(null, { text: 'the setting survives a restart', status: 'MET' });
    v = arbiter.evaluate(life, { cwd, requested: true });
    assert.strictEqual(v.state, 'DONE_UNVERIFIED', 'a criterion marked MET without evidence');
    const k = life.discipline.checks.commands()[0];
    life.discipline.contract.criterion('C1', { status: 'MET', evidence: { check: k.id } });
    assert.strictEqual(arbiter.evaluate(life, { cwd, requested: true }).state, 'DONE');
    assert.strictEqual(arbiter.evaluate(life, { cwd, requested: true, request: { state: 'BLOCKED', layer: 'provider', reason: 'quota exhausted' } }).state, 'BLOCKED');
    assert.strictEqual(arbiter.evaluate(life, { cwd, requested: true, request: { state: 'NEEDS_DECISION', question: 'Keep the old setting name?' } }).state, 'NEEDS_DECISION');
    assert.ok(STATE.DONE_UNVERIFIED && STATE.PARTIAL, 'both are lifecycle states');
  });

  await test('VERIFYCONTRACT IS THE AUTHORITY: a UI nudge is proved by Preview geometry — no final smoke; a release task needs packaging', () => {
    const root = project();
    const ui = new Lifecycle('Move the Preview button down by 6px');
    preview(ui, 'preview_read', { target: { selector: '#play' } }, 'button "Play" #play rect y=120');
    write(ui, path.join(root, 'src', 'player.css'));
    preview(ui, 'preview_read', { target: { selector: '#play' } }, 'button "Play" #play rect y=126');
    const v = arbiter.evaluate(ui, { cwd: root });
    assert.strictEqual(v.state, 'DONE', v.why);
    assert.strictEqual(require('../../src/finalsmoke').state(ui, root), 'NOT_REQUIRED', 'no universal final smoke');

    const rel = new Lifecycle('Build the production Windows package');
    write(rel, path.join(root, 'package.json'));
    run(rel, 'node test.js', true);
    const v2 = arbiter.evaluate(rel, { cwd: root });
    assert.strictEqual(v2.ok, false);
    assert.match(v2.why, /final smoke has not run/, 'project-wide change: broad proof first');
    rel.observeTool({ name: 'run_tests', input: { which: 'smoke' }, output: 'ok', exitCode: 0, finalSmoke: true });
    const v3 = arbiter.evaluate(rel, { cwd: root });
    assert.strictEqual(v3.state, 'DONE_UNVERIFIED');
    assert.match(v3.why, /packaging run/);
    run(rel, 'node distribution/release.js --unsigned', true);
    assert.strictEqual(arbiter.evaluate(rel, { cwd: root }).state, 'DONE');
  });

  await test('OUTCOME SATISFIED: once every criterion is evidenced, further file changes are refused at the tool door', async () => {
    const tools = require('../../src/tools');
    const cwd = tmpdir('d-');
    fs.writeFileSync(path.join(cwd, 'index.html'), '<p>Count: 0</p>');
    const life = new Lifecycle('Open Preview, click Add one twice, verify Count becomes 2, stop.');
    const session = { cwd, lifecycle: life, messages: [] };
    preview(life, 'preview_read', {}, 'Count: 0');
    preview(life, 'preview_click', { target: { text: 'Add one' } }, 'done on button "Add one"');
    preview(life, 'preview_click', { target: { text: 'Add one' } }, 'done on button "Add one"');
    preview(life, 'preview_read', {}, 'visible text: Count: 2');
    const obs = life.discipline.checks.all().pop();
    life.discipline.contract.criterion(null, { text: 'Count becomes 2', status: 'MET', evidence: { check: obs.id, expect: 'Count: 2' } });
    assert.ok(arbiter.outcomeSatisfied(life));
    const r = await tools.execute('write_file', { path: 'index.html', content: '<p>Count: 0</p><script>localStorage</script>' }, { cwd, session, app: { session } });
    assert.ok(r.isError && r.outcomeSatisfied, r.output);
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'index.html'), 'utf8'), '<p>Count: 0</p>', 'the project was not touched');
    assert.strictEqual(life.complete({ cwd }).ok, true, 'and the task completes on the evidence');
  });

  await test('NO BLIND RETRIES: the same failing command with nothing changed is refused with its evidence; a change re-opens it', async () => {
    const tools = require('../../src/tools');
    const cwd = tmpdir('d-');
    const life = new Lifecycle('fix');
    const session = { cwd, lifecycle: life, messages: [] };
    run(life, 'node missing.js', false, "Error: Cannot find module 'x'");
    const r = await tools.execute('run_bash', { command: 'node missing.js' }, { cwd, session, app: { session } });
    assert.ok(r.isError && r.blindRetry, r.output);
    assert.match(r.output, /already failed at this exact state/);
    write(life, path.join(cwd, 'missing.js'));
    assert.strictEqual(require('../../src/discipline/retry').check(life, 'run_bash', { command: 'node missing.js' }), null, 'something changed: a new observation');
    const t = new Lifecycle('fix');
    run(t, 'curl https://x', false, 'ETIMEDOUT');
    assert.strictEqual(require('../../src/discipline/retry').check(t, 'run_bash', { command: 'curl https://x' }), null, 'a transient failure may be retried (bounded)');
  });

  await test('DIALECTS: Claude, Codex and GLM vocabularies render and resolve to the canonical tools', () => {
    const schemas = require('../../src/tools').schemas();
    const claude = dialect.render(schemas, 'claude').map((s) => s.name);
    assert.ok(['Read', 'Edit', 'Grep', 'Bash'].every((n) => claude.includes(n)) && !claude.includes('read_file'));
    const codex = dialect.render(schemas, 'codex').map((s) => s.name);
    assert.ok(codex.includes('shell') && codex.includes('rg') && codex.includes('apply_patch'));
    assert.ok(dialect.render(schemas, 'glm').some((s) => s.name === 'str_replace'));
    assert.ok(dialect.render(schemas, 'local').every((s) => s.parameters.additionalProperties === false));
    assert.deepStrictEqual(dialect.resolve('Edit', { file_path: 'a.js', old_string: 'x', new_string: 'y' }, 'claude').calls, [{ name: 'edit_file', input: { path: 'a.js', old: 'x', new: 'y', replace_all: false } }]);
    assert.strictEqual(dialect.resolve('shell', { command: ['bash', '-lc', 'npm test'] }, 'codex').calls[0].input.command, 'npm test');
    const calls = dialect.patchToCalls('*** Begin Patch\n*** Update File: src/a.js\n@@\n-old line\n+new line\n*** Add File: src/b.js\n+hello\n*** Delete File: src/c.js\n*** End Patch');
    assert.deepStrictEqual(calls.map((c) => c.name), ['apply_patch', 'write_file', 'delete_file']);
    assert.strictEqual(calls[0].input.expect, 'old line');
    assert.strictEqual(calls[0].input.replace, 'new line');
    assert.strictEqual(dialect.familyOf('mock-model'), 'canonical');
    assert.strictEqual(dialect.familyOf('glm-5.3-flash'), 'glm');
  });

  await test('PROFILES: measured behaviour sets discretion; a weaker model gets less latitude, never a lower standard', () => {
    const home = tmpdir('d-home-');
    const saved = process.env.LAIN_CONFIG_DIR; process.env.LAIN_CONFIG_DIR = home;
    try {
      assert.strictEqual(profile.discretion('claude-opus-5-5').basis, 'prior');
      for (let i = 0; i < 4; i++) profile.record('tiny-local', { calls: 10, invalidCalls: 3, patches: 2, patchFailures: 1, completionRequests: 1, falseCompletions: 1 });
      const d = profile.discretion('tiny-local');
      assert.strictEqual(d.level, 'WEAK'); assert.strictEqual(d.basis, 'measured');
      const life = new Lifecycle('fix');
      write(life, '/p/src/a.js');
      run(life, 'npm run lint', true);                         // LOW: does not exercise the change
      const cwd = tmpdir('d-');
      assert.strictEqual(arbiter.evaluate(life, { cwd, discretion: 'STRONG' }).state, 'DONE');
      const weak = arbiter.evaluate(life, { cwd, discretion: 'WEAK' });
      assert.strictEqual(weak.state, 'DONE_UNVERIFIED');
      assert.match(weak.why, /independent check that exercises the change/);
    } finally { if (saved == null) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = saved; }
  });

  await test('CONTINUITY: the digest carries outcome, asks, facts with freshness, checks baseline→latest, questions, blockers, flags', () => {
    const life = new Lifecycle('1. fix save\n2. add a test');
    const c = life.discipline.contract;
    c.setOutcome('After pressing Save the value survives a reload');
    c.fact('preferences/store.ts owns persistence', { kind: 'STRUCTURAL', owner: 'src/store.ts' });
    c.fact('dev server is running on :5173', { kind: 'EXECUTION' });
    c.facts[1].at = Date.now() - 10 * 60 * 1000;
    c.note('questions', 'Should Save debounce?'); c.note('blockers', 'API key missing for e2e');
    run(life, 'node test/save.test.js', false, 'AssertionError');
    write(life, '/p/src/store.ts');
    run(life, 'node test/save.test.js', true);
    const text = require('../../src/discipline/digest').digest(life, { cwd: '/p' });
    for (const want of ['OUTCOME: After pressing Save', 'ASKS: A1', 'FACT F1 (STALE', 'FACT F2 (STALE', 'CHECK K1 node test/save.test.js: FAIL → PASS · HIGH', 'OPEN QUESTION', 'BLOCKER']) assert.ok(text.includes(want), `${want}\n${text}`);
    const restored = Lifecycle.from(JSON.parse(JSON.stringify(life.toJSON())));
    assert.strictEqual(restored.discipline.contract.outcome.text, 'After pressing Save the value survives a reload');
    assert.strictEqual(restored.discipline.checks.commands()[0].baseline, 'FAIL', 'it survives a resume');
  });

  await test('CONSTITUTION: the standing policy is short; LAIN.md is canonical, AGENTS.md is read only until it exists', () => {
    const { POLICY, render } = require('../../src/discipline/constitution');
    assert.ok(POLICY.length / 4 < 650, `the policy is ~${Math.round(POLICY.length / 4)} tokens`);
    assert.ok(require('../../src/prompt').build({ cwd: process.cwd() }).length / 4 < 1200, 'the whole standing prompt stays small');
    const root = tmpdir('d-proj-');
    const md = require('../../src/agentsmd');
    fs.mkdirSync(path.join(root, '.lain'));
    fs.writeFileSync(path.join(root, '.lain', 'AGENTS.md'), 'old rules');
    assert.match(md.projectFile(root), /AGENTS\.md$/, 'an existing AGENTS.md is read while there is no LAIN.md');
    md.write('project', root, 'Use pnpm.');
    assert.strictEqual(fs.readFileSync(path.join(root, '.lain', 'LAIN.md'), 'utf8'), 'Use pnpm.', 'writes go to LAIN.md');
    assert.match(md.projectFile(root), /LAIN\.md$/);
    assert.match(md.forPrompt(root), /Project constitution \(LAIN\.md\)/);
    assert.match(render('claude-code', root), /CLAUDE\.md[\s\S]*Use pnpm\./, 'provider-native forms are rendered from it');
    assert.match(render('codex', root), /<developer_instructions source="LAIN">[\s\S]*Use pnpm\./);
  });

  await test('OBSERVE: a live DOM measurement through `observe` is ledger evidence; its file/code reads are not', () => {
    const life = new Lifecycle('Move the button down 6px');
    life.observeTool({ name: 'observe', input: { goal: 'element', selector: '#add', url: 'http://127.0.0.1:5173/' }, output: '{"rect":{"y":116}}', isError: false });
    write(life, '/p/index.html');
    life.observeTool({ name: 'observe', input: { goal: 'element', selector: '#add', url: 'http://127.0.0.1:5173/' }, output: '{"rect":{"y":122}}', isError: false });
    life.observeTool({ name: 'observe', input: { goal: 'file', path: 'index.html' }, output: '<button>', isError: false });
    const obs = life.discipline.checks.all().filter((c) => c.kind === 'OBSERVATION');
    assert.strictEqual(obs.length, 2, 'two measurements, and the file read is not one');
    assert.strictEqual(obs[1].realism, 'RUNTIME');
    life.discipline.contract.criterion(null, { text: '#add is 6px lower', status: 'MET', evidence: { check: obs[1].id, expect: '"y":122' } });
    assert.strictEqual(arbiter.evaluate(life, { cwd: tmpdir('d-') }).state, 'DONE', 'the criterion is evidenced by the after-measurement');
  });

  await test('COMPLETION ENDS THE TURN: a granted request_completion stops the loop — no re-verifying a finished task', async () => {
    // A real GLM run (2026-10-01) got DONE back as a tool result and kept going: four DONEs and more reads after it.
    const mock = require('../../src/mockprovider');
    const dir = tmpdir('d-close-');
    const file = path.join(dir, 'script.json');
    fs.writeFileSync(file, JSON.stringify([
      { text: 'Looking.', tool_calls: [{ name: 'run_bash', input: { command: 'node -e "console.log(2)"' } }] },
      { text: 'Checked it.', tool_calls: [{ name: 'request_completion', input: { claims: [{ type: 'INFERRED', text: 'nothing needed changing' }] } }] },
      { text: 'Verifying again.', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
      { text: 'Still done.' },
    ]));
    const saved = { p: process.env.LAIN_PROVIDER, s: process.env.LAIN_MOCK_SCRIPT };
    Object.assign(process.env, { LAIN_PROVIDER: 'mock', LAIN_MOCK_SCRIPT: file });
    mock._reset();
    try {
      const { App } = require('../../src/app');
      const app = new App({ interactive: false, cwd: dir });
      for (const k of ['write', 'notice', 'turnSummary', 'nl']) app.render[k] = () => {};
      app.session.save = () => {};
      await app.once('Is anything wrong here? Stop when you know.');
      const calls = app.session.messages.flatMap((m) => (m && m.tool_calls) || []).map((c) => c.name);
      assert.deepStrictEqual(calls, ['run_bash', 'request_completion'], `the turn went on after DONE: ${calls.join(' → ')}`);
      assert.ok(app.session.messages.some((m) => m.role === 'tool' && /^DONE/.test(String(m.content))), 'and it was granted');
    } finally {
      for (const [k, v] of [['LAIN_PROVIDER', saved.p], ['LAIN_MOCK_SCRIPT', saved.s]]) { if (v == null) delete process.env[k]; else process.env[k] = v; }
      mock._reset();
    }
  });
});
