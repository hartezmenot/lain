'use strict';

/**
 * VS CODE / CURSOR EXTENSIONS: FOUND READ-ONLY, REUSED BY ONE VERIFIED COPY.
 *
 *   · discovery lists id, publisher, version, location, manifest hash and an
 *     honest FULL / PARTIAL / UNSUPPORTED — and writes nothing in the editors
 *   · reuse copies the package once into the content-addressed store; the same
 *     package from the other editor is the same directory
 *   · the editor changing its copy afterwards does not change what LAIN has
 *   · UNSUPPORTED is not reused; uninstall unregisters and keeps the store copy
 *     until orphans are removed on request
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

function snapshotTree(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${path.relative(dir, p)}:${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`); } };
  walk(dir); return out.sort().join('|');
}

module.exports = async function () {
  const ep = require('../../src/extpackages');
  const ext = require('../../src/extensions');
  const home = tmpdir('vsc-home-');
  const env = { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') };
  const mk = (product, dir, pkg, files = {}) => {
    const d = path.join(home, product, 'extensions', dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(pkg));
    for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
    return d;
  };
  const SNIP = { publisher: 'acme', name: 'snip', version: '1.0.0', displayName: 'Acme Snippets', contributes: { snippets: [{ language: 'javascript', path: './s.json' }] } };
  const vsc = mk('.vscode', 'acme.snip-1.0.0', SNIP, { 's.json': '{"log":{"prefix":"log","body":"console.log($1)"}}' });
  mk('.cursor', 'acme.snip-1.0.0', SNIP, { 's.json': '{"log":{"prefix":"log","body":"console.log($1)"}}' });
  // A VIEWS-ONLY extension: nothing in it works in LAIN (colour themes do since Phase 8 — see exttheme.js).
  mk('.vscode', 'acme.views-2.0.0', { publisher: 'acme', name: 'views', version: '2.0.0', contributes: { views: { explorer: [{ id: 'acme.tree', name: 'Tree' }] } } }, {});
  const before = snapshotTree(home);
  let ref = null;

  await test('DISCOVER: what VS Code and Cursor have, with honest compatibility — and nothing written', () => {
    const rows = ep.discover({ env });
    const ids = rows.map((r) => `${r.product}:${r.id}`);
    assert.deepStrictEqual(ids, ['cursor:acme.snip', 'vscode:acme.snip', 'vscode:acme.views']);
    const s = rows.find((r) => r.product === 'vscode' && r.id === 'acme.snip');
    assert.strictEqual(s.version, '1.0.0'); assert.strictEqual(s.publisher, 'acme'); assert.strictEqual(s.location, vsc);
    assert.ok(/^[0-9a-f]{16}$/.test(s.manifestHash));
    assert.strictEqual(s.compatibility.level, 'FULL');
    assert.strictEqual(rows.find((r) => r.id === 'acme.views').compatibility.level, 'UNSUPPORTED');
    assert.strictEqual(snapshotTree(home), before, 'the editors’ folders are untouched');
  });

  await test('REUSE: one verified copy in the content-addressed store; the other editor’s identical package is the same copy', () => {
    const a = ep.reuse({ product: 'vscode', id: 'acme.snip', env });
    assert.ok(a.ok, a.why);
    assert.ok(a.copied && /^[0-9a-f]{64}$/.test(a.packageRef));
    ref = a.packageRef;
    const stored = path.join(ep.storeDir(), ref);
    assert.strictEqual(ep.contentHash(stored).sha256, ref, 'the store copy is exactly the package');
    const b = ep.reuse({ product: 'cursor', id: 'acme.snip', env });
    assert.ok(b.ok, b.why);
    assert.strictEqual(b.copied, false, 'same bytes, same directory');
    assert.strictEqual(b.packageRef, ref);
    const e = ext.list({}).find((x) => x.id === 'acme.snip');
    assert.strictEqual(e.packageRef, ref);
    assert.strictEqual(e.source.kind, 'reused');
    assert.strictEqual(snapshotTree(home), before, 'reusing wrote nothing in the editors');
    assert.ok(ext.snippets({}).javascript || Object.keys(ext.snippets({})).length, 'Noema uses the snippets from its own copy');
  });

  await test('REUSE: the editor changing its copy later does not change Noema’s; unsupported is not reused', () => {
    fs.writeFileSync(path.join(vsc, 's.json'), '{"changed":true}');
    assert.strictEqual(ep.contentHash(path.join(ep.storeDir(), ref)).sha256, ref);
    const t = ep.reuse({ product: 'vscode', id: 'acme.views', env });
    assert.strictEqual(t.ok, false);
    assert.ok(/nothing in this extension/.test(t.why));
  });

  await test('UNINSTALL: unregisters, keeps the store copy; orphans are removed only when asked', () => {
    const r = ext.uninstall('acme.snip', { scope: 'global' });
    assert.ok(r.ok && r.packageKept === ref);
    assert.ok(fs.existsSync(path.join(ep.storeDir(), ref)));
    assert.deepStrictEqual(ep.orphans({}), [ref]);
    ep.orphans({ remove: true });
    assert.ok(!fs.existsSync(path.join(ep.storeDir(), ref)));
  });
};
