'use strict';

/**
 * READ-ONLY IS A CAPABILITY MASK, NOT A SENTENCE (Toralink, 2026-09-24).
 *
 * The pieces, one boundary at a time. The end-to-end turn lives in
 * tests/integration/readonly-task.test.js; the ownership evidence (raw router
 * bytes vs what LAIN executed, four isolation cases, two models) is in
 * docs/STATUS.md under the same date.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const mode = require('../../src/mode');
const wakeup = require('../../src/wakeup');
const readonly = require('../../src/readonly');
const toolalias = require('../../src/toolalias');
const lainstore = require('../../src/lainstore');

const TORALINK_BRIEF = [
  'READ-ONLY PROJECT INSPECTION.', '', 'Do not modify any file.', 'Do not create any file.', 'Do not write to `.lain`.', '',
  'I want you to inspect the existing Toralink project and explain how one specific user flow currently works.', '',
  '9. NO IMPLEMENTATION', '', 'This task ends after the read-only report.', '', 'Do not:', '',
  '- fix findings', '- add tests', '- change frontend', '- change backend', '- update `.lain`', '- create architecture records', '',
  'If the project is understandable from source evidence, simply report what exists.',
].join('\n');

module.exports = async () => {
  // ---- mode.js ------------------------------------------------------------------

  await test('READ-ONLY: a DECLARATION is recognised; the same words as an object of work are not', () => {
    for (const yes of ['READ-ONLY PROJECT INSPECTION.\n\nTrace the search flow.', 'read only please', 'Read-only: how does auth work',
      'Explain the router. Do not modify any file.', "Walk me through it without changing anything.", "Don't make any changes.",
      'This is a read-only review of the payment code', 'Keep this read-only and tell me what calls save()']) {
      assert.ok(mode.declaresReadOnly(yes), `declared: ${yes}`);
    }
    for (const no of ['Make the config file read-only', 'Fix the read-only flag on the settings form', 'Read-only mode for the settings page: add a toggle',
      "Implement the retry, but don't change anything else.", 'Add the endpoint. Do not modify any file in src/legacy.',
      "Refactor the parser without changing any code behaviour", "Don't make any changes to the public API; add the helper internally.",
      'Do not create any new files — put it in utils.js']) {
      assert.ok(!mode.declaresReadOnly(no), `not declared: ${no}`);
    }
  });

  await test('READ-ONLY: a paste that STARTS a task is classified by its words; one that joins work is content', () => {
    const fresh = mode.classify(TORALINK_BRIEF, { isPaste: true, joinsActiveTask: false });
    // AUDIT or EXPLAIN — both read-only; which one depends on words the brief
    // negates ("- create architecture records" still reads as a build verb to
    // the word rules, and the declaration overrides that answer).
    assert.ok(['AUDIT', 'EXPLAIN'].includes(fresh.mode), `the Toralink brief, pasted into a fresh session: ${fresh.mode}`);
    assert.strictEqual(fresh.declaredReadOnly, true);
    assert.strictEqual(fresh.readOnly, true);
    // Unchanged: a stack trace pasted INTO running work stays that work's evidence.
    const trace = 'TypeError: x is undefined\n    at run (src/a.js:3:1)\nError: failed';
    assert.strictEqual(mode.classify(trace, { isPaste: true, joinsActiveTask: true, activeMode: 'IMPLEMENT' }).mode, 'IMPLEMENT');
    assert.strictEqual(mode.classify(trace, { isPaste: true, activeMode: 'IMPLEMENT' }).mode, 'IMPLEMENT', 'a caller that does not say keeps the old rule');
    // A declared read-only task whose words look like work is still read-only.
    const v = mode.classify('read only please — add up what the tests cover and fix nothing', {});
    assert.ok(mode.READ_ONLY.has(v.mode) && v.mode !== 'CHAT' && v.declaredReadOnly, JSON.stringify(v));
  });

  // ---- wakeup.js ----------------------------------------------------------------

  await test('READ-ONLY: a "Do not:" LIST negates its items — the Toralink brief asks for no change', () => {
    assert.strictEqual(wakeup.asksForChange(TORALINK_BRIEF), false);
    // Unchanged for a real request with a negated clause beside it.
    assert.strictEqual(wakeup.asksForChange('Fix the login bug. Do not change the tests.'), true);
    assert.strictEqual(wakeup.asksForChange('Do not:\n\n- add tests\n\nThen add the retry to queue.js.'), true, 'the list ends at its blank line');
  });

  await test('READ-ONLY: decide() — a refusal "because it cannot modify code" and an empty reply are woken once; a report ends it', () => {
    const rec = () => ({ userInput: TORALINK_BRIEF, toolCalls: 12, actions: [], mutations: [], text: '' });
    const o = { required: true, cls: 'PROJECT_DIAGNOSTIC', readOnly: true };
    const r1 = rec();
    assert.strictEqual(wakeup.decide(r1, "I'm unable to fulfill this request because it requires making code changes.", o), 'wake');
    assert.match(wakeup.noteFor(r1), /no modification was requested/);
    assert.doesNotMatch(wakeup.noteFor(r1), /asks for a change/);
    assert.strictEqual(wakeup.decide(rec(), "I'm sorry, but I can't fulfill that request.", { ...o, wakeups: 1 }), 'no-progress', 'bounded to one');
    const r2 = rec();
    assert.strictEqual(wakeup.decide(r2, '', o), 'wake', 'silence is not a report');
    assert.strictEqual(r2.wakeFor, 'report');
    assert.strictEqual(wakeup.decide(rec(), 'ENTRY POINT: webapp/src/App.tsx SearchView …', o), null, 'the report ends the task');
    // Before: the SAME brief on the implementation class was told to make a change.
    const old = rec();
    assert.strictEqual(wakeup.decide(old, 'Findings: …', { required: true, cls: 'PROJECT_IMPLEMENTATION' }), null, 'no longer "asks for a change"');
  });

  // ---- readonly.js --------------------------------------------------------------

  await test('READ-ONLY: shell under the mask — inspection commands run, anything else is refused', () => {
    for (const ok of ['git status', 'git log --oneline -5', 'git diff HEAD~1 -- src/a.js', 'git branch -a', 'ls -la webapp', 'Get-ChildItem webapp | Select-Object Name',
      'rg -n "search" webapp/src', 'tasklist', 'netstat -ano | findstr 3000', 'node --version', 'npm ls --depth 0', 'cat package.json 2>/dev/null', 'find . -name "*.ts"']) {
      assert.ok(readonly.looksOnly(ok), `allowed: ${ok}`);
    }
    for (const no of ['npm install left-pad', 'git commit -am x', 'git checkout -- .', 'git branch -D old', 'npx prettier --write .', 'rm -rf dist',
      'echo x > a.txt', 'cat a >> b', 'ls; rm a', 'ls && npm test', 'find . -name "*.tmp" -delete', 'echo $(rm a)', 'node build.js', 'git config user.name x', '']) {
      assert.ok(!readonly.looksOnly(no), `refused: ${no}`);
    }
  });

  await test('READ-ONLY: the gate refuses writes and intelligence RECORDS, keeps reads; the offer hides writers; off without a mask', () => {
    const s = { capabilityMask: { kind: 'READ_ONLY' } };
    assert.match(readonly.denies('write_file', { path: 'a' }, s, true), /^DENIED READ_ONLY_TASK: write_file changes things.*refuses the WRITE, not the task/s);
    assert.match(readonly.denies('architecture', { op: 'declare' }, s, false), /architecture declare records project intelligence/);
    assert.match(readonly.denies('wiring', { op: 'connect' }, s, false), /wiring connect/);
    assert.match(readonly.denies('concept', { op: 'define' }, s, false), /concept define/);
    assert.match(readonly.denies('delegate', {}, s, false), /would not inherit/);
    assert.strictEqual(readonly.denies('architecture', { op: 'show' }, s, false), null, 'reading architecture is allowed');
    assert.strictEqual(readonly.denies('read_file', { path: 'a' }, s, false), null);
    assert.strictEqual(readonly.denies('run_bash', { command: 'git log -3' }, s, true), null);
    assert.strictEqual(readonly.denies('write_file', { path: 'a' }, {}, true), null, 'no mask, no gate');
    const names = ['read_file', 'write_file', 'edit_file', 'grep', 'run_bash', 'apply_patch'];
    assert.deepStrictEqual(readonly.offered(names, s), ['read_file', 'grep', 'run_bash']);
    assert.deepStrictEqual(readonly.offered(names, {}), names);
  });

  // ---- toolalias.js -------------------------------------------------------------

  await test('READ-ONLY: a foreign NAME with a known meaning is recovered; anything fuzzier is not', () => {
    const known = new Set(['grep', 'symbols', 'list_dir', 'read_file']);
    const has = (n) => known.has(n);
    assert.deepStrictEqual(toolalias.resolve('functions/grep', { pattern: 'x' }, has).name, 'grep');
    assert.deepStrictEqual(toolalias.resolve('functions.symbols', {}, has).name, 'symbols');
    const t = toolalias.resolve('print_tree', { path: 'webapp/src' }, has);
    assert.deepStrictEqual(t.input, { path: 'webapp/src', depth: 2 });
    assert.strictEqual(t.name, 'list_dir');
    assert.deepStrictEqual(toolalias.resolve('repo_browser.open_file', { path: 'a.ts', line_start: 10, line_end: 19 }, has).input, { path: 'a.ts', offset: 10, limit: 10 });
    assert.strictEqual(toolalias.resolve('functions/print_tree', {}, has).name, 'list_dir');
    assert.strictEqual(toolalias.resolve('grepp', {}, has), null, 'no near-miss guessing');
    assert.strictEqual(toolalias.resolve('functions/nope', {}, has), null);
    // `search` takes literal text: it becomes an ESCAPED grep pattern, never a raw one.
    const q = toolalias.resolve('search', { query: 'runSearch(q.trim())', path: 'webapp/src/App.tsx' }, has);
    assert.strictEqual(q.name, 'grep');
    assert.strictEqual(q.input.pattern, 'runSearch\\(q\\.trim\\(\\)\\)');
    assert.ok(new RegExp(q.input.pattern).test('await runSearch(q.trim());'), 'the escaped pattern finds the literal text');
  });

  await test('READ-ONLY: an unknown name repeated in one turn does not re-send the catalogue', async () => {
    const tools = require('../../src/tools');
    const session = { id: 's', messages: [] };
    const ctx = { cwd: tmpdir('ro-unknown-'), session, turnId: 't1' };
    const a = await tools.execute('frobnicate', {}, ctx);
    assert.match(a.output, /^unknown tool "frobnicate"\. Available: .*read_file/);
    const b = await tools.execute('frobnicate', {}, ctx);
    assert.match(b.output, /already reported this turn; do not call it again/);
    assert.doesNotMatch(b.output, /Available:/);
    const c = await tools.execute('frobnicate', {}, { ...ctx, turnId: 't2' });
    assert.match(c.output, /Available:/, 'a new turn lists again');
  });

  // ---- fs.js --------------------------------------------------------------------

  await test('READ-ONLY: a missing path reports the nearest real folder; a FILE is named a file; a regex escape is reported, not rewritten', async () => {
    const { tools } = require('../../src/tools/fs');
    const cwd = tmpdir('ro-paths-');
    fs.mkdirSync(path.join(cwd, 'webapp', 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'web'), '4 KB of something');
    fs.writeFileSync(path.join(cwd, 'webapp', 'src', 'App.tsx'), 'x');
    fs.writeFileSync(path.join(cwd, 'webapp', 'src', 'api.ts'), 'y');
    const run = (n, i) => tools[n].run(i, { cwd });
    assert.match((await run('list_dir', { path: 'web' })).output, /^web is a FILE \(\d+ bytes\), not a directory — read it with read_file/);
    const deep = (await run('read_file', { path: 'webapp/src/SearchView.tsx' })).output;
    assert.match(deep, /^no such file: webapp\/src\/SearchView\.tsx\nNearest existing folder: webapp\/src\/ — contains: .*App\.tsx/);
    const deeper = (await run('list_dir', { path: 'webapp/nope/deeper' })).output;
    assert.match(deeper, /Nearest existing folder: webapp\/ — contains: src\//, 'climbs to the nearest folder that exists');
    const esc = (await run('read_file', { path: 'webapp/src/api\\.ts' }));
    assert.strictEqual(esc.isError, true, 'the escaped path is NOT silently read');
    assert.match(esc.output, /regular-expression escape; tool paths are literal, not patterns\. The literal path "webapp\/src\/api\.ts" exists/);
    const noLit = (await run('read_file', { path: 'webapp/src/SearchView\\.tsx' })).output;
    assert.doesNotMatch(noLit, /literal path/, 'the literal file is named only when it exists');
    if (process.platform === 'win32') assert.strictEqual((await run('read_file', { path: 'webapp\\src\\api.ts' })).isError, undefined, 'a genuine Windows path is untouched');
    const tree = (await run('list_dir', { path: '.', depth: 3 })).output;
    assert.match(tree, /webapp\/src\/App\.tsx/);
  });

  // ---- the hold -----------------------------------------------------------------

  await test('READ-ONLY: a HELD project writes nothing into .lain — store, index, schema, scratch (kept in memory), task records', () => {
    const root = tmpdir('ro-hold-');
    fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 1;\n');
    lainstore.hold(root, 'sess-1', true);
    try {
      assert.strictEqual(lainstore.held(root), true);
      assert.strictEqual(lainstore.held(path.join(root, '.lain', 'tasks', 't1')), true, 'a path inside the project is held too');
      assert.strictEqual(lainstore.write(root, 'architecture', { nodes: { a: 1 } }), false);
      assert.strictEqual(require('../../src/projectindex').save(root, { files: {} }), false);
      assert.strictEqual(require('../../src/lainschema').stampNew(root), false);
      const scratch = require('../../src/scratch');
      assert.strictEqual(scratch.note(root, 'sess-1', { text: 'SearchView lives in App.tsx', by: 'model' }).ok, true, 'notes still work');
      assert.strictEqual(scratch.notes(root, 'sess-1').length, 1, 'kept in memory');
      const { ArtifactStore } = require('../../src/harness/artifacts');
      if (ArtifactStore) {
        const store = new ArtifactStore(root);
        assert.strictEqual(store.appendEvent('t1', { type: 'x' }), false);
        assert.strictEqual(store.saveTask({ id: 't1' }), false);
      }
      assert.strictEqual(fs.existsSync(path.join(root, '.lain')), false, 'no .lain/ at all');
      lainstore.hold(root, 'sess-2', true);
      lainstore.hold(root, 'sess-1', false);
      assert.strictEqual(lainstore.held(root), true, 'another session still holds it');
    } finally {
      lainstore.hold(root, 'sess-1', false);
      lainstore.hold(root, 'sess-2', false);
    }
    assert.strictEqual(lainstore.held(root), false);
    assert.strictEqual(lainstore.write(root, 'architecture', { nodes: { a: 1 } }), true, 'released, it writes again');
  });

  await test('READ-ONLY: project state comes from evidence — an empty architecture record is EXISTING_UNINDEXED', () => {
    const pc = require('../../src/projectcache');
    const app = (cwd) => ({ session: { cwd } });
    assert.strictEqual(pc.state(app(tmpdir('ro-empty-'))), 'EMPTY');
    const root = tmpdir('ro-existing-');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'index.js'), 'module.exports = 1;\n');
    assert.strictEqual(pc.state(app(root)), 'EXISTING_UNINDEXED');
    lainstore.write(root, 'architecture', { nodes: {} });
    assert.strictEqual(pc.state(app(root)), 'EXISTING_UNINDEXED', '{"nodes":{}} records nothing');
    lainstore.write(root, 'architecture', { nodes: { search: { purpose: 'search' } } });
    assert.strictEqual(pc.state(app(root)), 'EXISTING_INDEXED');
  });
};
