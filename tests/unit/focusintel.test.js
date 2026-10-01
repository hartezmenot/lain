'use strict';

/**
 * /focus INTELLIGENCE — one project truth across processes, the language
 * server feeding the canonical Selection, addressable evidence, the focus
 * artifact cache, the tool funnel, and semantic rename through the server.
 *
 * The language server is tests/fixtures/lsp/fakels.js (real LSP over stdio, for
 * *.lt files): every definition, reference and rename edit here comes from it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');
const isolation = require('../harness/isolation');

const FAKE = path.join(__dirname, '..', 'fixtures', 'lsp', 'fakels.js');

module.exports = async function () {
  const root = isolation.tmp('focusintel-');
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w('ui/button.lt', 'let fixButton = 1\n# fixButton is the toolbar action\nprint "fix_button"\n');
  w('app.lt', 'fn main()\n  return fixButton\n');
  w('api/routes.lt', 'let route = "/api/fix_button"\nlet handler = fixButton\n');
  w('other.lt', 'let unrelated = 2\n');
  const { Session } = require('../../src/session');
  const session = new Session({ id: `focusintel-${Date.now()}`, cwd: root });
  require('../../src/sessionviews').views(session).project = { attached: true, attachedAt: new Date().toISOString() };
  const app = { session, cfg: { lsp: { servers: [{ id: 'fake', name: 'Fake LS', command: process.execPath, args: [FAKE], extensions: ['.lt'], languages: [] }] } } };
  const hc = require('../../src/harnesscontext');
  const pg = require('../../src/projectgen');
  const ev = require('../../src/evidencerefs');
  const select = (file, line, text, col) => {
    require('../../src/idecontext').record(session, { file, selection: { text, startLine: line, endLine: line, startCol: col }, tabs: [] });
    hc.fromIde(app, session, { file, selection: { text, startLine: line, endLine: line, startCol: col } });
  };

  try {
    await test('PROJECT GENERATION: one number per project, shared through disk; another process\'s change is heard once', () => {
      const n0 = pg.current(root).n;
      const n1 = pg.advance(root, { file: 'other.lt', by: 'user' });
      assert.strictEqual(n1, n0 + 1);
      // Another process advanced it: simulated by writing the shared file with a foreign pid.
      const heard = [];
      pg.onForeign((r, changes) => { if (r === path.resolve(root)) heard.push(...changes.map((c) => c.file)); });
      const f = path.join(require('../../src/config').configDir(), 'provenance', `${require('../../src/journey').projectId(root)}.generation.json`);
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      d.n += 1; d.changes.push({ file: 'app.lt', by: 'agent', n: d.n, pid: 0, at: Date.now() });
      fs.writeFileSync(f, JSON.stringify(d));
      const t = new Date(Date.now() + 2000); fs.utimesSync(f, t, t);
      assert.strictEqual(pg.current(root).n, n1 + 1, 'the number the other process wrote');
      assert.deepStrictEqual(heard, ['app.lt']);
      pg.current(root);
      assert.deepStrictEqual(heard, ['app.lt'], 'heard once');
    });

    await test('SELECTION: the id names what was selected; an unrelated change carries it forward, a change under it re-resolves', () => {
      select('ui/button.lt', 1, 'fixButton', 5);
      const s1 = hc.selection(app, session);
      assert.ok(s1 && s1.symbol && s1.symbol.name === 'fixButton');
      const before = hc.selectionStats(session);
      pg.advance(root, { file: 'other.lt', by: 'user' });
      const s2 = hc.selection(app, session);
      assert.strictEqual(s2.id, s1.id, 'same selection, same id');
      assert.strictEqual(hc.selectionStats(session).carried, before.carried + 1, 'carried forward, not recomputed');
      fs.appendFileSync(path.join(root, 'ui/button.lt'), '# edited\n');
      pg.advance(root, { file: 'ui/button.lt', by: 'user' });
      const s3 = hc.selection(app, session);
      assert.strictEqual(s3.id, s1.id);
      assert.strictEqual(hc.selectionStats(session).resolved, before.resolved + 1, 'the selected file changed: resolved again');
    });

    await test('LANGUAGE FACTS: the Selection is asked of the language server — definition, references, rename — as addressable evidence', async () => {
      const sel = hc.selection(app, session);
      const f = await require('../../src/langfacts').forSelection(app, session, sel, { deadlineMs: 15000 });
      assert.strictEqual(f.via, 'lsp', JSON.stringify(f.ops));
      assert.deepStrictEqual(f.definition.map((l) => `${l.path}:${l.line}`), ['ui/button.lt:1']);
      const files = [...new Set(f.references.map((l) => l.path))].sort();
      assert.deepStrictEqual(files, ['api/routes.lt', 'app.lt', 'ui/button.lt'], 'identifiers only: the comment and the "fix_button" string are not references');
      assert.ok(f.rename && f.rename.renameable && f.rename.prepared);
      assert.ok(/^e\d+$/.test(f.evidence.references));
      const again = await require('../../src/langfacts').forSelection(app, session, sel);
      assert.ok(Object.values(again.ops).every((o) => o.cached), 'the same Selection at the same generation asks the server nothing');
      const e = ev.get(session, f.evidence.references);
      assert.strictEqual(e.state, 'exact');
      assert.ok(/3 reference\(s\) in 3 file\(s\)/.test(e.entry.summary), e.entry.summary);
    });

    await test('EVIDENCE: valid until what it read changes — an unrelated edit carries it, an edit to its file makes it stale', () => {
      const id = ev.view(session).entries.find((x) => x.kind === 'lsp.references').id;
      pg.advance(root, { file: 'other.lt', by: 'user' });
      assert.strictEqual(ev.get(session, id).state, 'carried');
      fs.appendFileSync(path.join(root, 'app.lt'), '# touched\n');
      pg.advance(root, { file: 'app.lt', by: 'user' });
      const r = ev.get(session, id);
      assert.strictEqual(r.state, 'stale');
      assert.ok(/app\.lt/.test(r.why), r.why);
    });

    await test('FOCUS PACKET: built from the language server, kept as an artifact, reused while valid, rebuilt when a dependency changes', async () => {
      const fp = require('../../src/focuspacket');
      const task = 'Change this to ButtonFix including anything related to it.';
      const a = await fp.build(app, session, { task });
      assert.strictEqual(a.kind, 'rename');
      assert.ok(/SYMBOL \(language server fake\)/.test(a.text) && /REFERENCES \(language server: 3 in 3 file\(s\)/.test(a.text), a.text);
      assert.strictEqual(a.metrics.artifact.state, 'built');
      assert.strictEqual(a.metrics.lsp.via, 'lsp');
      assert.ok(!a.relevant.includes('other.lt'), 'an unrelated file is not sent');
      const b = await fp.build(app, session, { task });
      assert.strictEqual(b.metrics.artifact.state, 'exact', 'same Selection, same generation: the artifact, not the research');
      pg.advance(root, { file: 'other.lt', by: 'user' });
      const c = await fp.build(app, session, { task });
      assert.strictEqual(c.metrics.artifact.state, 'carried');
      fs.appendFileSync(path.join(root, 'api/routes.lt'), '# again\n');
      pg.advance(root, { file: 'api/routes.lt', by: 'user' });
      const d = await fp.build(app, session, { task });
      assert.strictEqual(d.metrics.artifact.state, 'rebuilt-stale');
    });

    await test('FOCUS PACKET: a selection an earlier turn acted on steers a later request only when the request points at it', () => {
      const fp = require('../../src/focuspacket');
      const sel = { id: 'Sx', madeAt: 100, source: { file: 'a.ts' }, symbol: { name: 'fixButton' } };
      const consumed = { _selConsumed: { id: 'Sold', madeAt: 100, where: 'a.ts' } };
      assert.ok(fp.pointsAt('fix the bug', sel, {}), 'a fresh selection is "this"');
      assert.ok(!fp.pointsAt('Add a rate-limit note next to the health route.', sel, consumed), 'a used one is not, for an unrelated request');
      assert.ok(fp.pointsAt('Rename this ButtonFix', sel, consumed) && fp.pointsAt('update fixButton callers', sel, consumed), 'unless the request points at it');
      assert.ok(fp.pointsAt('fix the bug', { ...sel, madeAt: 200 }, consumed), 'selecting again makes it fresh');
    });

    await test('TOOL FUNNEL: the turn is shown its task\'s tools; a hidden tool still runs and is counted', async () => {
      const tf = require('../../src/toolfunnel');
      const tools = require('../../src/tools');
      tf.open(session, 'explain');
      const shown = tools.schemas(app).map((s) => s.name);
      assert.ok(shown.includes('read_file') && shown.includes('lain_workspace'));
      assert.ok(!shown.includes('write_file') && !shown.includes('delegate') && !shown.includes('download_file'));
      const r = await tools.execute('glob', { pattern: '*.lt' }, { app, session, cwd: root });
      assert.ok(!r.isError);
      const miss = await tools.execute('run_tests', {}, { app, session, cwd: root });
      assert.ok(miss, 'a hidden tool is not refused by the funnel');
      assert.strictEqual(tf.view(session).misses.length, 1);
      tf.close(session);
      assert.strictEqual(tools.schemas(app).length, tools.names(app).length, 'no funnel: the whole registry this session is offered');
    });

    await test('SEMANTIC RENAME: the language server renames the symbol across files; strings and comments stay', async () => {
      const sr = require('../../src/semanticrename');
      const r = await sr.rename(app, session, { from: 'fixButton', to: 'ButtonFix' });
      assert.ok(r.used && r.ok, r.why);
      assert.ok(/selection S/.test(r.via), 'positioned from the canonical Selection');
      assert.strictEqual(r.count, 3);
      assert.ok(/^let ButtonFix = 1/.test(fs.readFileSync(path.join(root, 'ui/button.lt'), 'utf8')));
      assert.ok(/return ButtonFix/.test(fs.readFileSync(path.join(root, 'app.lt'), 'utf8')));
      const routes = fs.readFileSync(path.join(root, 'api/routes.lt'), 'utf8');
      assert.ok(/handler = ButtonFix/.test(routes) && /"\/api\/fix_button"/.test(routes), 'the wire string is untouched');
      assert.ok(/# fixButton is the toolbar action/.test(fs.readFileSync(path.join(root, 'ui/button.lt'), 'utf8')), 'the comment is reported, not rewritten');
      assert.ok(/NOT renamed/.test(r.text) || r.strings.length === 0);
    });

    await test('REQUEST TRACE: a session\'s requests are readable from another process', () => {
      const rt = require('../../src/reqtrace');
      const rec = rt.begin({ reason: rt.REASON.MACHINERY, model: 'm' });
      rec.session = session.id;
      rt.end(rec, { ok: true, receipt: { inputTokens: 10, outputTokens: 2 } });
      assert.ok(new RegExp(`^r\\d+\\.${rt.PROC}$`).test(rec.id), 'the id names its process');
      rt.reset();   // "another process": nothing in memory
      const seen = rt.forSession(session.id);
      assert.ok(seen.some((x) => x.id === rec.id && x.receipt.inputTokens === 10));
      assert.ok(!seen.some((x) => 'messages' in x || 'content' in x), 'identity and accounting only');
    });
  } finally {
    await require('../../src/lsp/manager').stopAll();
  }
};
