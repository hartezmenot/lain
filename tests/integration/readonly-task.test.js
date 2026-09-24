'use strict';

/**
 * A PASTED READ-ONLY BRIEF, THROUGH THE REAL TURN LOOP (Toralink, 2026-09-24).
 *
 * The live failure, reproduced on the wire against gpt-oss:120b and Claude
 * Haiku 4.5 alike: a pasted "READ-ONLY PROJECT INSPECTION" brief classified as
 * IMPLEMENT (the paste rule), the model was told "This is an implementation
 * request … Final smoke: npm test", the hidden wake-up said "the request asks
 * for a change … make the change", and the model refused the inspection
 * ("I'm unable to fulfill this request because it requires making code
 * changes"). Every model-emitted call reached the tools unaltered, so the
 * owner was LAIN, and this proves LAIN's half is closed:
 *
 *   · the paste that STARTS a task is classified by its words → AUDIT
 *   · the task carries a READ_ONLY capability mask: writers are not offered,
 *     a write is refused — the task is not
 *   · `.lain/` is not written at all (no task record, index, scratch, schema)
 *   · the model's own mistakes are recovered deterministically: a namespaced
 *     name (`functions/grep`), a foreign tool (`print_tree`), a FILE listed as
 *     a folder, a regex-escaped path
 *   · a refusal "because it cannot modify code" gets one wake-up saying no
 *     modification was requested, and the report ends the task
 *
 * Real App, real tools, real gates; the model is the scripted mock, wrapped to
 * record what was on the wire for each request.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');

const BRIEF = [
  'READ-ONLY PROJECT INSPECTION.',
  '',
  'Do not modify any file.',
  'Do not write to `.lain`.',
  '',
  'Trace the existing flow: a user searches for a title → the frontend sends the query → the backend search runs → results render.',
  '',
  'Do not:',
  '',
  '- fix findings',
  '- add tests',
  '- change frontend',
  '- update `.lain`',
  '',
  'If the project is understandable from source evidence, simply report what exists.',
].join('\n');

module.exports = async () => {
  await test('READ-ONLY: a pasted brief is AUDIT with a write mask; writes refused, .lain untouched, model slips recovered, refusal woken, report ends it', async () => {
    const proj = tmpdir('readonly-task-');
    fs.mkdirSync(path.join(proj, 'webapp', 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"toralink-fixture","scripts":{"test":"node -e 0"}}\n');
    fs.writeFileSync(path.join(proj, 'web'), 'a file named like a folder\n');
    fs.writeFileSync(path.join(proj, 'webapp', 'src', 'App.tsx'), 'export function SearchView() { return api.search(q); }\n');
    fs.writeFileSync(path.join(proj, 'webapp', 'src', 'api.ts'), 'export const api = { search: (q) => fetch(`/api/search?q=${q}`) };\n');

    const prev = { p: process.env.LAIN_PROVIDER, s: process.env.LAIN_MOCK_SCRIPT };
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('ro-script-'), [
      { text: 'Looking around.', tool_calls: [
        { name: 'write_file', input: { path: 'hack.txt', content: 'must never exist' } },
        { name: 'functions/grep', input: { pattern: 'search', path: 'webapp' } },
        { name: 'print_tree', input: { path: 'webapp' } },
        { name: 'list_dir', input: { path: 'web' } },
        { name: 'read_file', input: { path: 'webapp/src/api\\.ts' } },
        { name: 'run_bash', input: { command: 'npm install left-pad' } },
        { name: 'architecture', input: { op: 'declare', id: 'search', purpose: 'guessed' } },
      ] },
      { text: "I'm unable to fulfill this request because it requires making code changes, and this session is read-only." },
      { text: 'REPORT: the search originates in webapp/src/App.tsx (SearchView) and calls api.search in webapp/src/api.ts.' },
    ]);
    const mock = require('../../src/mockprovider');
    mock._reset();
    const wire = [];
    const realChat = mock.chat;
    mock.chat = function (pc, messages, opts) {
      wire.push({ tools: ((opts && opts.tools) || []).map((t) => t.name), tail: String((messages[messages.length - 1] || {}).content || ''), all: messages.map((m) => String(m.content || '')).join('\n') });
      return realChat(pc, messages, opts);
    };
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: proj });
    try {
      await app.prepare();
      await app.handle(BRIEF, { isPaste: true });

      // ---- classification and the mask ---------------------------------------
      assert.strictEqual(app.session.mode, 'AUDIT', 'a pasted brief that STARTS a task is classified by its words');
      assert.strictEqual(app.session.taskClassVerdict.cls, 'PROJECT_DIAGNOSTIC');
      assert.strictEqual(app.session.capabilityMask && app.session.capabilityMask.kind, 'READ_ONLY');

      // ---- what the model was told and offered --------------------------------
      assert.ok(wire.length >= 3, `three requests: calls, refusal, report (got ${wire.length})`);
      const first = wire[0];
      assert.ok(!/implementation request/i.test(first.all), 'never framed as an implementation request');
      assert.ok(!/Final smoke/.test(first.all), 'no final-smoke demand on a read-only task');
      assert.ok(/Capability mask: READ-ONLY/.test(first.all), 'the mask is stated');
      assert.ok(/Project state: EXISTING_UNINDEXED/.test(first.all), 'an existing project without recorded intelligence is EXISTING');
      for (const w of ['write_file', 'edit_file', 'apply_patch', 'delete_file']) assert.ok(!first.tools.includes(w), `${w} is not offered`);
      for (const r of ['read_file', 'list_dir', 'grep', 'symbols']) assert.ok(first.tools.includes(r), `${r} stays offered`);

      // ---- every call's result ------------------------------------------------
      const results = app.session.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
      const has = (re, why) => assert.ok(results.some((r) => re.test(r)), `${why}\n${results.join('\n---\n')}`);
      has(/^DENIED READ_ONLY_TASK: write_file changes things[\s\S]*refuses the WRITE, not the task/, 'the write is refused, the task is not');
      has(/^NOTE: "functions\/grep" is not a tool name here — ran "grep"[\s\S]*api\.search|^NOTE: "functions\/grep"[\s\S]*App\.tsx/, 'a namespaced name runs the tool it names');
      has(/^NOTE: "print_tree" is not a LAIN tool — ran a recursive listing[\s\S]*src\/App\.tsx/, 'print_tree recovers as a bounded recursive listing');
      has(/^web is a FILE \(\d+ bytes\), not a directory — read it with read_file/, 'a file listed as a folder is named a file');
      has(/regular-expression escape[\s\S]*"webapp\/src\/api\.ts" exists[\s\S]*Nearest existing folder: webapp\/src\//, 'a regex-escaped path is reported with the literal file, never rewritten');
      has(/^DENIED READ_ONLY_TASK: that command is not a read-only inspection/, 'an install is refused');
      has(/^DENIED READ_ONLY_TASK: architecture declare records project intelligence/, 'recording architecture is refused');
      assert.strictEqual(fs.existsSync(path.join(proj, 'hack.txt')), false, 'nothing was written');

      // ---- the refusal is woken once, the report ends it ----------------------
      assert.ok(/READ-ONLY and nothing is to be changed — no modification was requested/.test(wire[2].tail), 'the wake-up says no modification was requested');
      assert.ok(!wire.some((w) => /The request asks for a change/.test(w.tail)), 'never told to make a change');
      const turn = app.session.turns[app.session.turns.length - 1];
      assert.strictEqual(turn.stopReason, 'end');
      assert.strictEqual(turn.wakeups, 1);
      assert.ok(/^REPORT:/.test(String(turn.text || '').trim().split('\n').pop()), 'the task ended with its report');

      // ---- .lain untouched ----------------------------------------------------
      assert.strictEqual(fs.existsSync(path.join(proj, '.lain')), false, 'no .lain/ was created: no task record, index, scratch or schema');
    } finally {
      mock.chat = realChat;
      try { require('../../src/lainstore').hold(proj, app.session.id, false); } catch { /* released */ }
      if (prev.p === undefined) delete process.env.LAIN_PROVIDER; else process.env.LAIN_PROVIDER = prev.p;
      if (prev.s === undefined) delete process.env.LAIN_MOCK_SCRIPT; else process.env.LAIN_MOCK_SCRIPT = prev.s;
    }
  });

  await test('READ-ONLY: "continue" keeps the mask and the hold; a typed request for a change lifts both, and that task can write', async () => {
    const proj = tmpdir('readonly-lift-');
    fs.writeFileSync(path.join(proj, 'a.js'), 'module.exports = 1;\n');
    const prev = { p: process.env.LAIN_PROVIDER, s: process.env.LAIN_MOCK_SCRIPT };
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('ro-lift-'), [
      { text: 'Reported: a.js exports 1.' },
      { text: 'Still read-only; nothing else to report.' },
      { text: 'Editing.', tool_calls: [{ name: 'write_file', input: { path: 'b.js', content: 'module.exports = 2;\n' } }] },
      { text: 'Wrote b.js.' },
    ]);
    const mock = require('../../src/mockprovider');
    mock._reset();
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: proj });
    try {
      await app.prepare();
      await app.handle('Read only please. What does a.js export?');
      assert.strictEqual(app.session.capabilityMask && app.session.capabilityMask.kind, 'READ_ONLY');
      assert.strictEqual(require('../../src/lainstore').held(proj), true, 'the project is held while the mask is on');
      await app.handle('continue');
      assert.strictEqual(app.session.capabilityMask && app.session.capabilityMask.kind, 'READ_ONLY', '"continue" keeps it');
      await app.handle('Now add b.js exporting 2.');
      assert.strictEqual(app.session.capabilityMask, null, 'a request for a change lifts it');
      assert.strictEqual(require('../../src/lainstore').held(proj), false, 'and releases the project');
      assert.strictEqual(fs.readFileSync(path.join(proj, 'b.js'), 'utf8'), 'module.exports = 2;\n', 'the unmasked task can write');
    } finally {
      try { require('../../src/lainstore').hold(proj, app.session.id, false); } catch { /* released */ }
      if (prev.p === undefined) delete process.env.LAIN_PROVIDER; else process.env.LAIN_PROVIDER = prev.p;
      if (prev.s === undefined) delete process.env.LAIN_MOCK_SCRIPT; else process.env.LAIN_MOCK_SCRIPT = prev.s;
    }
  });
};
