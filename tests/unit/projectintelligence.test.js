'use strict';

/**
 * DURABLE PROJECT INTELLIGENCE — the reread-loop regression suite.
 *
 * ------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS FOR, as it was actually observed.
 *
 * A settled implementation decision, and then the same project regions read
 * again and again: "one last read", "final anchors", "one decisive batch".
 * Context boundary, resume, and the same evidence reacquired. The plan step
 * survived; the project understanding did not.
 *
 * THE CAUSE WAS NOT MEMORY, AND IT WAS NOT RUST. `rust/lain-supervisor` never
 * owned project intelligence — `projects.rs` stores identity, counts and a
 * digest, and has its own test forbidding per-file data. The intelligence is
 * `<project>/.lain/index.json`, written by projectindex.js.
 *
 * What was broken was that the index CONTAINED NOTHING for a TypeScript
 * project. `jsscan.SUPPORTED` listed `js|cjs|mjs`; projectindex kept its own
 * wider list including `ts|tsx`. So a `.ts` file was admitted, marked
 * `lang: 'js'`, handed to a scanner that answered "not JavaScript", and stored
 * with no symbols and no imports — silently, with no error and no degraded
 * state. Measured on a real project: 47 files indexed, ZERO symbols.
 *
 * With nothing in the index, `definitionsOf`, `importersOf` and `outlineOf`
 * answer "unknown" forever, so every question about the project falls back to
 * grep and whole-file reads — the same regions, every turn, across every
 * resume. That is the loop.
 *
 * These tests fail against that state and pass against the repair.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const projectindex = require('../../src/projectindex');

/** A small TypeScript project, of the shape the failure was measured on. */
function project() {
  const root = tmpdir('lain-intel-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'api.ts'), [
    'import { cfg } from "./cfg";',
    'export interface Row { id: number; name: string }',
    'export async function addMovie(m: Row): Promise<void> { await cfg.post("/m", m); }',
    'export function grabMovie(id: number): Promise<Row> { return cfg.get(`/m/${id}`); }',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'cfg.ts'), 'export const cfg = { post(){}, get(){} };\n');
  fs.writeFileSync(path.join(root, 'src', 'App.tsx'), [
    'import { addMovie } from "./api";',
    'export function StatusChip(p: { s: string }): JSX.Element { return <span>{p.s}</span>; }',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'readme.md'), 'not source\n');
  return root;
}

module.exports = async function () {
  // ---------------------------------------------------------------------
  await test('INTEL: a TypeScript project indexes with real symbols, not empty entries', () => {
    const root = project();
    const r = projectindex.refresh(root);
    assert.strictEqual(r.persisted, true, 'and it reaches disk');
    assert.ok(fs.existsSync(path.join(root, '.lain', 'index.json')), '.lain/index.json exists');

    const files = r.index.files;
    const sources = Object.entries(files).filter(([, e]) => e.lang === 'js');
    assert.strictEqual(sources.length, 3, `three sources admitted: ${Object.keys(files).join(', ')}`);

    // THE ASSERTION THE OLD BEHAVIOUR FAILED: admitted AND scanned.
    const empty = sources.filter(([, e]) => !Array.isArray(e.symbols) || !e.symbols.length);
    assert.deepStrictEqual(empty.map(([k]) => k), [],
      'a file the index admits as source must come back WITH symbols');

    const total = sources.reduce((n, [, e]) => n + e.symbols.length, 0);
    assert.ok(total >= 5, `real symbols, not a token few: ${total}`);
  });

  // ---------------------------------------------------------------------
  await test('INTEL: a TypeScript TYPE is a declaration, and an ordinary `type` is not', () => {
    // ---- THE GAP THIS CLOSES (2026-09-15) -------------------------------
    //
    // Functions and classes were indexed; `interface Row` was not. So a TS
    // project answered "where is Row defined?" with nothing, and the only way
    // left to find it was a grep — which is precisely the reread loop the index
    // exists to end. A type is looked up by name as often as a class is.
    const root = project();
    const { index } = projectindex.refresh(root);
    const rows = projectindex.definitionsOf(index, 'Row');
    assert.strictEqual(rows.length, 1, 'the interface is located exactly once');
    assert.strictEqual(rows[0].kind, 'interface');
    assert.ok(rows[0].line > 0, 'with a line to go to');

    // ---- AND `type` IS NOT A RESERVED WORD, WHICH IS THE WHOLE RISK -----
    //
    // Matching the keyword alone would turn `const type = 4`, `obj.type` and
    // `{ type: 'x' }` into declarations — noise that looks authoritative, in
    // every JavaScript file in the world. The match is on the SHAPE, so these
    // stay silent while the real ones are found.
    const codemodel = require('../../src/codemodel');
    const kinds = (src) => codemodel.scan(src, 'p.ts').symbols
      .filter((x) => ['type', 'interface', 'enum'].includes(x.kind))
      .map((x) => `${x.name}:${x.kind}`);
    for (const noise of [
      'const type = 4; obj.type = 5;',
      '({ type: 1 });',
      'function f(type) { return type; }',
      'if (type < 4) { x = 1; }',
    ]) {
      assert.deepStrictEqual(kinds(noise), [], `ordinary code must not declare a type: ${noise}`);
    }
    assert.deepStrictEqual(kinds('export type A = { x: 1 };'), ['A:type']);
    assert.deepStrictEqual(kinds('type Fn<T> = (x: T) => void;'), ['Fn:type'], 'a generic alias too');
    assert.deepStrictEqual(kinds('interface B extends C { y: number }'), ['B:interface']);
    assert.deepStrictEqual(kinds('enum E { A, B }'), ['E:enum']);

    // AND IT ADDS NOTHING TO A PLAIN JS TREE — measured on LAIN itself, where
    // 754 files produced zero type-level declarations and zero false ones.
    assert.deepStrictEqual(kinds('const type = require("./type"); module.exports = { type };'), []);
  });

  // ---------------------------------------------------------------------
  await test('INTEL: an index that scanned everything and learned nothing is NOT reported healthy', () => {
    // ---- THE SILENT CATEGORY §19 FORBIDS --------------------------------
    //
    // This is the exact shape of the original defect: 47 files admitted, all of
    // them "scanned", ZERO declarations between them — because the scanner took
    // the extension and then refused to parse it. Every count was green, the
    // state said FRESH, and every structural question fell back to grep for the
    // rest of the session with nothing saying why.
    //
    // "We missed it" must never be spelled FRESH.
    const root = project();
    projectindex.refresh(root);
    const file = path.join(root, '.lain', 'index.json');
    const ix = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of Object.keys(ix.files)) { ix.files[k].symbols = []; ix.files[k].imports = []; }

    const c = projectindex.coverage(root, { index: ix });
    assert.strictEqual(c.symbols, 0, 'the fixture really is the collapsed case');
    assert.notStrictEqual(c.state, 'FRESH', 'a project of source files that declares nothing is not FRESH');
    assert.strictEqual(c.state, 'PARTIAL');
    // AND IT SAYS WHAT HAPPENED, naming files rather than a bare count.
    const reasons = Object.keys(c.why).join(' ');
    assert.match(reasons, /nothing was declared/, `the reason is stated: ${reasons}`);

    // ---- AND IT DOES NOT CRY WOLF ---------------------------------------
    //
    // A file with no declarations is ordinary — a config, a barrel, a constant.
    // The accusation needs enough files for "none of them declares anything" to
    // be evidence rather than coincidence.
    const tiny = tmpdir('lain-intel-tiny-');
    fs.writeFileSync(path.join(tiny, 'index.js'), 'module.exports = 1;\n');
    projectindex.refresh(tiny);
    assert.strictEqual(projectindex.coverage(tiny).state, 'FRESH',
      'a one-file project with nothing to declare is not a broken scanner');

    // AND A HEALTHY PROJECT IS STILL FRESH — the guard must not make every
    // project PARTIAL, which would be the same silence wearing a warning label.
    assert.strictEqual(projectindex.coverage(root).state, 'FRESH');
  });

  // ---------------------------------------------------------------------
  await test('INTEL: the questions that replace rereading can actually be answered', () => {
    const root = project();
    const { index } = projectindex.refresh(root);

    // "Where is X?" — the question that otherwise becomes a grep.
    for (const name of ['addMovie', 'grabMovie', 'StatusChip']) {
      const defs = projectindex.definitionsOf(index, name);
      assert.strictEqual(defs.length, 1, `${name} is located exactly once`);
      assert.ok(defs[0].line > 0, `${name} has a line number`);
    }
    // A RETURN TYPE MUST NOT HIDE A FUNCTION. `function f(): Promise<void> {`
    // was invisible: both call sites required the `{` to follow the `)`.
    assert.match(projectindex.definitionsOf(index, 'addMovie')[0].file, /api\.ts$/);

    // "Who imports this?" — the question that otherwise becomes a tree-wide grep.
    const importers = projectindex.importersOf(index, 'src/api.ts');
    assert.deepStrictEqual(importers, ['src/App.tsx']);

    // "What does this file declare?" — the question that otherwise becomes a read.
    const outline = projectindex.outlineOf(index, 'src/api.ts');
    assert.ok(outline.some((s) => s.name === 'addMovie'), 'the outline names the function');
  });

  // ---------------------------------------------------------------------
  // THE FAILURE SHAPE ITSELF: settle, cross a boundary, resume, and do NOT
  // reacquire what has not changed.
  await test('INTEL: after a restart nothing unchanged is rescanned, and one edit invalidates only itself', () => {
    const root = project();
    projectindex.refresh(root);

    // A NEW PROCESS would `load()` from disk. Prove the durable file carries it.
    const reloaded = projectindex.load(root);
    assert.ok(Object.keys(reloaded.files).length >= 4, 'the durable file holds the tree');
    assert.ok(projectindex.definitionsOf(reloaded, 'addMovie').length === 1,
      'and the symbols survived the process that wrote them');

    // NOTHING CHANGED: nothing is re-parsed.
    const again = projectindex.refresh(root, { index: reloaded });
    assert.strictEqual(again.changed, 0, 'nothing changed');
    assert.strictEqual(again.added, 0, 'nothing was added');
    assert.ok(again.reused >= 4, `everything was reused, not re-parsed: reused=${again.reused}`);

    // ONE EXTERNAL EDIT: only that file becomes stale.
    const api = path.join(root, 'src', 'api.ts');
    const later = new Date(Date.now() + 4000);
    fs.writeFileSync(api, 'export function renamedNow(): Promise<void> { return Promise.resolve(); }\n');
    fs.utimesSync(api, later, later);

    const after = projectindex.refresh(root);
    assert.strictEqual(after.changed, 1, 'exactly one file was re-read');
    assert.strictEqual(projectindex.definitionsOf(after.index, 'addMovie').length, 0,
      'the symbol that no longer exists is gone');
    assert.strictEqual(projectindex.definitionsOf(after.index, 'renamedNow').length, 1,
      'and the new one is known without anything else being re-read');
    assert.strictEqual(projectindex.definitionsOf(after.index, 'StatusChip').length, 1,
      'the untouched file is still known');
  });

  // ---------------------------------------------------------------------
  // MISSING OR CORRUPT STATE MUST SELF-HEAL, never half-trust what it read.
  await test('INTEL: missing, empty, corrupt and stale state all rebuild rather than half-answer', () => {
    const root = project();
    projectindex.refresh(root);
    const file = path.join(root, '.lain', 'index.json');
    const good = fs.readFileSync(file, 'utf8');

    const damaged = {
      missing: () => fs.rmSync(file, { force: true }),
      empty: () => fs.writeFileSync(file, ''),
      truncated: () => fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2))),
      'not json': () => fs.writeFileSync(file, 'this is not json at all'),
      'wrong shape': () => fs.writeFileSync(file, JSON.stringify({ version: 1, files: 'nope' })),
      'old version': () => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(good), version: 0 })),
    };

    for (const [how, breakIt] of Object.entries(damaged)) {
      breakIt();
      // READ: never a partial answer built on a file that did not parse.
      const loaded = projectindex.load(root);
      assert.ok(loaded && loaded.files && typeof loaded.files === 'object',
        `${how}: load still returns a usable index`);
      if (how !== 'old version') {
        assert.strictEqual(Object.keys(loaded.files).length, 0,
          `${how}: a damaged index is an EMPTY one, never half-trusted`);
      }
      // REBUILD: and the next refresh restores the whole thing and persists it.
      const healed = projectindex.refresh(root);
      assert.strictEqual(healed.persisted, true, `${how}: the rebuild reaches disk`);
      assert.strictEqual(projectindex.definitionsOf(healed.index, 'addMovie').length, 1,
        `${how}: the intelligence is whole again`);
      assert.strictEqual(projectindex.load(root).version, 1, `${how}: and readable afterwards`);
    }
  });

  // ---------------------------------------------------------------------
  await test('INTEL: an interrupted write leaves no temporary file and no half-index', () => {
    const root = project();
    projectindex.refresh(root);
    const dir = path.join(root, '.lain');
    fs.writeFileSync(path.join(dir, 'index.json.tmp'), '{"half":');   // a crash mid-write
    const r = projectindex.refresh(root);
    assert.strictEqual(r.persisted, true);
    assert.ok(!fs.existsSync(path.join(dir, 'index.json.tmp')),
      'the temporary file is replaced by the rename, never left behind');
    assert.strictEqual(projectindex.definitionsOf(projectindex.load(root), 'addMovie').length, 1);
  });

  // ---------------------------------------------------------------------
  // ONE PHYSICAL FILE IS ONE ENTRY, however the root was spelt.
  await test('INTEL: path spellings do not multiply a file into several entries', () => {
    const root = project();
    const spellings = [
      root,
      root.split(path.sep).join('/'),
      root.replace(/^([a-zA-Z]):/, (m, d) => `${d.toLowerCase()}:`),
      root.replace(/^([a-zA-Z]):/, (m, d) => `${d.toUpperCase()}:`),
      `${root}${path.sep}`,
      path.join(root, 'src', '..'),
    ];
    let expected = null;
    for (const spelling of spellings) {
      const keys = Object.keys(projectindex.refresh(spelling).index.files).sort();
      if (expected === null) expected = keys;
      assert.deepStrictEqual(keys, expected, `root spelt ${JSON.stringify(spelling)} indexed differently`);
      for (const k of keys) {
        assert.ok(!k.includes('\\'), `${k}: a key must not carry a backslash`);
        assert.ok(!/^[a-zA-Z]:/.test(k), `${k}: a key must be relative, never absolute`);
      }
    }
  });
};
