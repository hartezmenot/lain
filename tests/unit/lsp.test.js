'use strict';

/**
 * LANGUAGE SERVERS — deterministic answers, from a real LSP process.
 *
 * tests/fixtures/lsp/fakels.js is a small language server speaking the real
 * protocol over stdio. It is attached the way a person attaches any server
 * (`lsp.servers` in config), and every answer below comes from it — no text
 * search, no model.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');
const isolation = require('../harness/isolation');

const FAKE = path.join(__dirname, '..', 'fixtures', 'lsp', 'fakels.js');

async function until(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; }

module.exports = async function () {
  const lsp = require('../../src/lsp/manager');
  const root = isolation.tmp('lsp-proj-');
  fs.mkdirSync(path.join(root, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ui', 'button.lt'), 'let fixButton = 1\n# fixButton is the toolbar action\nprint "fixButton"\n');
  fs.writeFileSync(path.join(root, 'app.lt'), 'fn main()\n  return fixButton\nlet other = 2 # ERROR here\n');
  const { Session } = require('../../src/session');
  const session = new Session({ id: 'lsp-unit', cwd: root });
  require('../../src/sessionviews').views(session).project = { attached: true, attachedAt: new Date().toISOString() };
  const app = { session, cfg: { lsp: { servers: [{ id: 'fake', name: 'Fake LS', command: process.execPath, args: [FAKE], extensions: ['.lt'], languages: [] }] } } };
  try {
    await test('LSP: a configured server is attached, started and recorded as an owned process', async () => {
      const s = lsp.status(app).find((x) => x.id === 'fake');
      assert.ok(s && s.available, JSON.stringify(s));
      const r = await lsp.ensure(app, path.join(root, 'app.lt'));
      assert.ok(r.ok, r.why);
      const st = lsp.status(app).find((x) => x.id === 'fake');
      assert.strictEqual(st.state, 'READY');
      assert.ok(st.capabilities.includes('rename') && st.capabilities.includes('references'));
      assert.ok(require('../../src/runtimeregistry').list().some((x) => x.pid === st.pid && x.purpose === 'language-server'));
    });

    await test('LSP: definition and references come from the server — strings and comments are not references', async () => {
      const def = await lsp.definition(app, { path: 'app.lt', line: 2, col: 12 });
      assert.ok(def.ok, def.why);
      assert.deepStrictEqual(def.locations.map((l) => `${l.path}:${l.line}`), ['ui/button.lt:1']);
      const refs = await lsp.references(app, { path: 'ui/button.lt', line: 1, col: 6 });
      assert.deepStrictEqual(refs.locations.map((l) => `${l.path}:${l.line}`).sort(), ['app.lt:2', 'ui/button.lt:1']);
    });

    await test('LSP: hover, document and workspace symbols, diagnostics', async () => {
      const h = await lsp.hover(app, { path: 'app.lt', line: 2, col: 12 });
      assert.ok(/fixButton/.test(h.contents), JSON.stringify(h));
      const ds = await lsp.documentSymbols(app, { path: 'app.lt' });
      assert.deepStrictEqual(ds.symbols.map((s) => s.name), ['main', 'other']);
      const ws = await lsp.workspaceSymbols(app, { query: 'fix' });
      assert.ok(ws.symbols.some((s) => s.name === 'fixButton' && s.path === 'ui/button.lt'), JSON.stringify(ws));
      await lsp.document(app, { event: 'open', path: path.join(root, 'app.lt'), text: fs.readFileSync(path.join(root, 'app.lt'), 'utf8') });
      const d = await until(() => lsp.diagnostics(app).find((x) => x.path === 'app.lt'));
      assert.ok(d && d.line === 3 && d.severity === 'error' && d.source === 'fakels', JSON.stringify(d));
    });

    await test('LSP: semantic rename changes identifiers across files and leaves strings and comments', async () => {
      const plan = await lsp.rename(app, { path: 'ui/button.lt', line: 1, col: 6, newName: 'ButtonFix' });
      assert.ok(plan.ok, plan.why);
      assert.strictEqual(plan.count, 2);
      assert.ok(!(await lsp.rename(app, { path: 'app.lt', line: 1, col: 1, newName: 'x' })).ok, 'a keyword cannot be renamed (prepareRename)');
      const done = await lsp.applyRename(app, plan, { actor: 'USER' });
      assert.deepStrictEqual(done.files.sort(), ['app.lt', 'ui/button.lt']);
      const btn = fs.readFileSync(path.join(root, 'ui', 'button.lt'), 'utf8');
      assert.ok(/let ButtonFix = 1/.test(btn) && /# fixButton is/.test(btn) && /"fixButton"/.test(btn), btn);
      assert.ok(/return ButtonFix/.test(fs.readFileSync(path.join(root, 'app.lt'), 'utf8')));
      const e = require('../../src/editledger').entries(root, { rel: 'app.lt' }).pop();
      assert.ok(e && e.source === 'USER' && e.tool === 'lsp.rename', JSON.stringify(e));
    });

    await test('LSP: a crashed server is restarted; LAIN keeps answering', async () => {
      const pid = lsp.status(app).find((x) => x.id === 'fake').pid;
      process.kill(pid);
      assert.ok(await until(() => { const s = lsp.status(app).find((x) => x.id === 'fake'); return s.state === 'READY' && s.pid && s.pid !== pid; }, 15000), 'restarted');
      const def = await lsp.definition(app, { path: 'app.lt', line: 2, col: 12 });
      assert.ok(def.ok && def.locations.length === 1, JSON.stringify(def));
    });

    await test('LSP: a language with no server says so — nothing is guessed', async () => {
      fs.writeFileSync(path.join(root, 'x.go'), 'package main\n');
      const r = await lsp.definition(app, { path: 'x.go', line: 1, col: 1 });
      assert.ok(!r.ok && /gopls|language server/.test(r.why), JSON.stringify(r));
    });
  } finally {
    await lsp.stopAll();
  }
};
