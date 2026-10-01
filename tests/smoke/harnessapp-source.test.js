'use strict';

/**
 * THE SOURCE WORKSPACE AND THE UI<->SOURCE LOOP, DRIVEN AS THE APPLICATION DRIVES IT.
 *
 * ------------------------------------------------------------------------
 * EVERY CALL HERE IS ONE THE PAGE MAKES.
 *
 * Nothing reaches into `harnessapp/source.js` directly: every step goes through
 * `routes.dispatch` — the single entry the native channel uses for every
 * request the window sends (harnessapp/ipc.js). What passes here is what the
 * product does.
 *
 * IT USED TO GO OVER HTTP, through a loopback listener and a session cookie.
 * That transport was the browser Harness's, and it was removed with it
 * (2026-09-15); the two cases that tested the transport rather than the feature
 * went with it — a launch token, and a 401 without a session. The native
 * channel's own refusal is proved against a real pipe in
 * tests/smoke/desktop-real.test.js.
 *
 * ------------------------------------------------------------------------
 * IT IS ITS OWN FIXTURE, DELIBERATELY.
 *
 * The dogfood run (Harness editing Harness) happens against the real tree and
 * is recorded in docs/STATUS.md. This runs against a temporary project so it
 * can WRITE, be refused, and be written under, without touching the repository
 * - a test that mutates the source it is testing is a test that fails
 * differently on the second run.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const routes = require('../../src/harnessapp/routes');

module.exports = async function () {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-srcsmoke-'));
  fs.mkdirSync(path.join(proj, 'ui'));
  fs.writeFileSync(path.join(proj, 'ui', 'checkout.css'), '.pay-row {\n  display: block;\n  opacity: 0.2;\n}\n');
  fs.writeFileSync(path.join(proj, 'index.html'), '<div class="pay-row"><button id="payNow">Pay now</button></div>\n');
  fs.writeFileSync(path.join(proj, 'node_modules-decoy.txt'), 'not a directory');
  fs.mkdirSync(path.join(proj, 'node_modules'));
  fs.writeFileSync(path.join(proj, 'node_modules', 'junk.js'), 'module.exports=1');

  const app = { session: { id: 'smoke', cwd: proj, turns: [], messages: [] }, ui: null, checkpoints: null, events: null };
  const req = (method, p, body) => routes.dispatch(app, method, p, body);

  try {
    await test('SOURCE LIVE: the tree is the project, and its dependencies are one dim row', async () => {
      const r = await req('POST', '/api/files/tree', { path: '' });
      const names = r.body.entries.map((e) => e.name);
      assert.ok(names.includes('ui'), 'the project directories are there');
      assert.ok(names.includes('index.html'));
      // THERE, AS IN ANY EDITOR — a person opens node_modules to read a
      // dependency — but dim and unexpanded: the tree is lazy, so its 40,000
      // files are listed only when someone asks for them.
      const nm = r.body.entries.find((e) => e.name === 'node_modules');
      assert.ok(nm && nm.dir && nm.dim, 'node_modules is a dim folder row');
      assert.ok(!r.body.entries.some((e) => e.path.startsWith('node_modules/')), 'and nothing inside it is listed until it is opened');
      // Paths are project-relative, never absolute — an absolute path here
      // would put the person's directory layout in the page.
      for (const e of r.body.entries) assert.ok(!path.isAbsolute(e.path), `${e.path} is absolute`);
    });

    await test('SOURCE LIVE: quick open finds a file by name', async () => {
      const r = await req('POST', '/api/files/find', { q: 'checkout' });
      assert.deepStrictEqual(r.body.matches.map((m) => m.path), ['ui/checkout.css']);
    });

    await test('SOURCE LIVE: opening a file reports its language and its save token', async () => {
      const r = await req('POST', '/api/files/open', { path: 'ui/checkout.css' });
      assert.strictEqual(r.body.language, 'css');
      assert.match(r.body.body, /opacity: 0\.2/);
      assert.ok(r.body.hash, 'without a content hash a save cannot be conditional');
      assert.ok(r.body.mtimeMs > 0);
    });

    await test('SOURCE LIVE: a person edits and saves, and the bytes land on disk', async () => {
      const open = await req('POST', '/api/files/open', { path: 'ui/checkout.css' });
      const edited = open.body.body.replace('opacity: 0.2', 'opacity: 0.5');
      const saved = await req('POST', '/api/files/save', {
        path: 'ui/checkout.css', body: edited, hash: open.body.hash,
      });
      assert.strictEqual(saved.body.ok, true, saved.body.why);
      assert.match(fs.readFileSync(path.join(proj, 'ui', 'checkout.css'), 'utf8'), /opacity: 0\.5/);
      assert.notStrictEqual(saved.body.hash, open.body.hash, 'the identity moves with the content');
    });

    await test('SOURCE LIVE: a save over Noema edit is REFUSED, and nothing is lost', async () => {
      // THE INTERACTION THIS PRODUCT CREATES CONSTANTLY: the person has a file
      // open, LAIN edits it, and the person saves. Last-write-wins would
      // silently destroy the model's work, often, and quietly.
      const open = await req('POST', '/api/files/open', { path: 'ui/checkout.css' });
      fs.writeFileSync(path.join(proj, 'ui', 'checkout.css'), '.pay-row {\n  display: flex;\n  opacity: 0.9;\n}\n');
      const clash = await req('POST', '/api/files/save', {
        path: 'ui/checkout.css', body: '.pay-row { MINE }\n', hash: open.body.hash,
      });
      assert.notStrictEqual(clash.body.ok, true, 'the save must be refused');
      assert.strictEqual(Boolean(clash.body.stale), true, 'it must be reported as stale');
      assert.match(fs.readFileSync(path.join(proj, 'ui', 'checkout.css'), 'utf8'), /opacity: 0\.9/,
        'the disk must still hold what Noema wrote');
      assert.match(clash.body.current, /opacity: 0\.9/,
        'and the current bytes come back so the person can compare rather than guess');
    });

    await test('SOURCE LIVE: the editor notices what Noema changed underneath it', async () => {
      const open = await req('POST', '/api/files/open', { path: 'ui/checkout.css' });
      let fresh = await req('POST', '/api/files/freshness', {
        open: [{ path: 'ui/checkout.css', hash: open.body.hash }],
      });
      assert.strictEqual(fresh.body.files[0].changed, false, 'nothing has moved yet');

      fs.writeFileSync(path.join(proj, 'ui', 'checkout.css'), '.pay-row {\n  display: flex;\n  opacity: 0.7;\n}\n');
      fresh = await req('POST', '/api/files/freshness', {
        open: [{ path: 'ui/checkout.css', hash: open.body.hash }],
      });
      assert.strictEqual(fresh.body.files[0].changed, true, 'a Noema edit must be noticed');
    });

    await test('SOURCE LIVE: UI -> source correlates a real element to the file that defines it', async () => {
      const r = await req('POST', '/api/files/from-element', {
        element: { tag: 'button', id: 'payNow', classes: [], text: 'Pay now' },
      });
      assert.ok(['EXACT', 'LIKELY', 'MULTIPLE'].includes(r.body.confidence), r.body.why);
      const files = r.body.candidates.map((c) => c.rel);
      assert.ok(files.includes('index.html'), `expected index.html among ${files.join(', ')}`);
      // THE EVIDENCE TRAVELS WITH THE ANSWER. A candidate a person cannot
      // dismiss in a second is a candidate they have to investigate.
      assert.ok(r.body.searched.length, 'it must say what it searched for');
      assert.ok(r.body.candidates[0].hits || r.body.candidates[0].score >= 0);
    });

    await test('SOURCE LIVE: it says UNKNOWN rather than inventing a mapping', async () => {
      const r = await req('POST', '/api/files/from-element', {
        element: { tag: 'div', id: '', classes: ['css-1a2b3c4'], text: '' },
      });
      assert.strictEqual(r.body.confidence, 'UNKNOWN');
      assert.ok(r.body.why, 'and it says why there is no answer');
      assert.deepStrictEqual(r.body.candidates, []);
    });

    await test('SOURCE LIVE: source -> UI offers selectors, ranked, from real evidence', async () => {
      const r = await req('POST', '/api/files/to-ui', { path: 'ui/checkout.css', line: 3 });
      assert.ok(['LIKELY', 'MULTIPLE'].includes(r.body.confidence), JSON.stringify(r.body));
      const sels = r.body.selectors.map((s) => s.selector);
      assert.ok(sels.includes('.pay-row'), `expected .pay-row among ${sels.join(', ')}`);
      assert.ok(r.body.selectors[0].why, 'each selector says what produced it');
    });

    await test('SOURCE LIVE: the workspace boundary holds', async () => {
      for (const p of ['../escape.txt', '../../../etc/passwd', '/etc/passwd', 'C:\\Windows\\win.ini']) {
        const r = await req('POST', '/api/files/open', { path: p });
        assert.notStrictEqual(r.code, 200, `${p} was served`);
        assert.match(String(r.body.why || ''), /outside the project/, `${p}: ${JSON.stringify(r.body)}`);
      }
      // And a write is refused the same way, not merely the read.
      const w = await req('POST', '/api/files/save', { path: '../escape.txt', body: 'x' });
      assert.ok(!w.body.ok);
      assert.match(String(w.body.why || ''), /outside the project/);
      assert.strictEqual(fs.existsSync(path.join(path.dirname(proj), 'escape.txt')), false);
    });
  } finally {
    try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* windows holds it briefly */ }
  }
};
