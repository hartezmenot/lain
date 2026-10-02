'use strict';

/**
 * PROJECT FRESHNESS, FOREIGN-PROJECT BOOTSTRAP, EXTERNAL DIRTY TRACKING and the
 * `.lain` SCHEMA — all derived from the disk, none of it from a model.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const freshness = require('../../src/freshness');
const bootstrap = require('../../src/bootstrap');
const projectindex = require('../../src/projectindex');
const lainstore = require('../../src/lainstore');
const lainschema = require('../../src/lainschema');

function write(root, rel, body) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

/** A project written by other tools: Codex and Cursor leave their own dotfiles, and there is no .lain. */
function foreignProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-foreign-'));
  write(root, 'package.json', JSON.stringify({ name: 'shop', main: 'src/index.js' }));
  write(root, '.cursor/rules/style.mdc', 'prefer small functions');
  write(root, 'AGENTS.md', '# written for Codex');
  write(root, 'src/index.js', 'const cart = require("./cart");\nconst { price } = require("./pricing");\nmodule.exports = { cart, price };\n');
  write(root, 'src/cart.js', 'const { price } = require("./pricing");\nfunction total(items) { return items.reduce((n, i) => n + price(i), 0); }\nmodule.exports = { total };\n');
  write(root, 'src/pricing.js', 'function price(item) { return item.cents / 100; }\nmodule.exports = { price };\n');
  write(root, 'scripts/report.py', 'def main():\n    print("report")\n');
  write(root, 'tests/cart.test.js', 'require("../src/cart");\n');
  return root;
}

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return cond();
}

module.exports = async function () {
  await test('BOOTSTRAP: a project with no .lain becomes usable intelligence, deterministically, with a baseline', () => {
    const root = foreignProject();
    assert.ok(!(fs.existsSync(path.join(root, '.lain')) || fs.existsSync(path.join(root, '.lain'))), 'precondition: nothing of LAIN\'s is there');
    const b = bootstrap.bootstrap(root);
    assert.strictEqual(b.priorLain, false);
    assert.strictEqual(b.llm, false, 'no model was asked anything');
    assert.ok(b.languages.js >= 4 && b.languages.py === 1, JSON.stringify(b.languages));
    assert.ok(b.parsed >= 4 && b.symbols >= 3);
    assert.deepStrictEqual(b.dependents['src/pricing.js'].sort(), ['src/cart.js', 'src/index.js']);
    assert.ok(b.entryPoints.includes('src/index.js'));
    assert.ok(b.topology.some((t) => t.dir === 'src' && t.files === 3));
    assert.ok(b.baseline.written && b.baseline.files >= 7);
    const base = lainstore.read(root, 'baseline', null);
    assert.ok(base.files['src/cart.js'].fp && base.files['scripts/report.py'].fp, 'every source file is fingerprinted');
    assert.strictEqual(lainschema.detect(root), lainschema.CURRENT, 'a new .lain is created at the current schema');
    const locate = projectindex.definitionsOf(projectindex.load(root), 'total');
    assert.strictEqual(locate[0].file, 'src/cart.js', 'and the index answers questions immediately');
  });

  await test('FRESHNESS: observed layers are FRESH against the disk, STALE the moment a file moves', () => {
    const root = foreignProject();
    bootstrap.bootstrap(root);
    let r = freshness.report(root);
    assert.ok(r.index.FRESH >= 4 && r.index.STALE === 0, JSON.stringify(r.index));
    assert.strictEqual(r.fingerprints.STALE, 0);
    assert.ok(r.index.PARTIAL >= 1, 'a file indexed by identity only (python, json) is PARTIAL, not FRESH');
    write(root, 'src/pricing.js', 'function price(item) { return item.cents / 100 + 1; }\nmodule.exports = { price };\n');
    r = freshness.report(root);
    assert.strictEqual(r.index.STALE, 1);
    assert.strictEqual(r.fingerprints.STALE, 1, 'the baseline fingerprint of the edited file is stale');
    assert.match(freshness.describe(r), /index\s+.*1 STALE/);
  });

  await test('FRESHNESS: semantic knowledge carries proof and goes STALE when its evidence changes', () => {
    const root = foreignProject();
    const dictionary = require('../../src/dictionary');
    const dict = dictionary.load(root);
    dictionary.define(dict, { term: 'pricing', purpose: 'converts cents to currency', location: 'src/pricing.js' });
    dictionary.save(root, dict);
    const entry = dictionary.load(root).terms[dictionary.keyOf('pricing')];
    assert.strictEqual(freshness.ofRecord(root, entry), freshness.STATE.FRESH);
    write(root, 'src/pricing.js', '// rewritten\n');
    assert.strictEqual(freshness.ofRecord(root, entry), freshness.STATE.STALE, 'interpretation is stale until re-established');
    assert.strictEqual(freshness.ofRecord(root, { text: 'no proof' }), freshness.STATE.UNKNOWN);
    const scratch = require('../../src/scratch');
    const fact = scratch.promote(root, 's1', { text: 'total() sums prices', evidence: 'read src/cart.js and ran tests/cart.test.js' }).fact;
    assert.deepStrictEqual(fact.proof.map((p) => p.path).sort(), ['src/cart.js', 'tests/cart.test.js']);
    assert.strictEqual(freshness.ofRecord(root, fact), freshness.STATE.FRESH);
  });

  await test('DIRTY: an external edit marks one path dirty and the next query re-measures only it', async () => {
    const root = foreignProject();
    bootstrap.bootstrap(root);
    const t = freshness.track(root);
    try {
      if (!t.available) return; // a platform without recursive watch: the stat walk path is covered elsewhere
      projectindex.refresh(root);                         // the index is now newer than the watcher
      write(root, 'src/cart.js', 'function total() { return 0; }\nfunction discount() { return 1; }\nmodule.exports = { total, discount };\n');
      assert.ok(await waitFor(() => freshness.isDirty(root, 'src/cart.js')), 'the editor save was observed');
      assert.strictEqual(freshness.ofIndexFile(root, projectindex.load(root), 'src/cart.js'), freshness.STATE.STALE);
      const r = projectindex.refresh(root);
      assert.strictEqual(r.targeted, true, 'no tree walk — a targeted refresh');
      assert.ok(r.scanned <= 3, `only the dirty path(s) were measured, not ${Object.keys(r.index.files).length} files (${r.scanned})`);
      assert.ok(projectindex.definitionsOf(r.index, 'discount').length === 1, 'and the new symbol is known');
      assert.strictEqual(freshness.isDirty(root, 'src/cart.js'), false, 'absorbed');
    } finally {
      freshness.untrack(root);
    }
  });

  await test('DIRTY: with no watcher, the index still re-measures by stat — correct, merely slower', () => {
    const root = foreignProject();
    projectindex.refresh(root);
    write(root, 'src/pricing.js', 'function price() { return 2; }\nfunction tax() { return 3; }\nmodule.exports = { price, tax };\n');
    const r = projectindex.refresh(root);
    assert.strictEqual(r.targeted, false);
    assert.strictEqual(projectindex.definitionsOf(r.index, 'tax').length, 1);
  });

  await test('SCHEMA: an old .lain is backed up, migrated, validated and stamped', () => {
    const root = foreignProject();
    fs.mkdirSync(path.join(root, '.lain', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(root, '.lain', 'memory', 'facts.json'),
      JSON.stringify({ version: 1, slot: 'memory', updatedAt: 1, body: { facts: [{ text: 'old fact', evidence: 'ran tests' }] } }));
    assert.strictEqual(lainschema.detect(root), 1);
    const r = lainschema.ensure(root, { force: true });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(lainschema.detect(root), 2);
    const fact = lainstore.read(root, 'memory', null).facts[0];
    assert.deepStrictEqual(fact.proof, [], 'no fingerprints are invented for a record made before they existed');
    assert.strictEqual(fact.proofOrigin, 'pre-schema-2');
    assert.strictEqual(freshness.ofRecord(root, fact), freshness.STATE.UNKNOWN);
    assert.ok(fs.existsSync(path.join(root, '.lain', 'backups', r.backup, 'memory', 'facts.json')), 'the backup holds the original');
  });

  await test('SCHEMA: a failed migration restores the backup and does not brick the project', () => {
    const root = foreignProject();
    fs.mkdirSync(path.join(root, '.lain', 'graph'), { recursive: true });
    const original = JSON.stringify({ version: 1, slot: 'wiring', updatedAt: 1, body: { edges: [{ from: 'a', to: 'b', rel: 'DEPENDS_ON' }] } });
    fs.writeFileSync(path.join(root, '.lain', 'graph', 'wiring.json'), original);
    const broken = { 1: (r) => { fs.writeFileSync(path.join(r, '.lain', 'graph', 'wiring.json'), '{ half written'); } };
    const res = lainschema.ensure(root, { force: true, migrations: broken });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.restored, true);
    assert.strictEqual(fs.readFileSync(path.join(root, '.lain', 'graph', 'wiring.json'), 'utf8'), original, 'restored byte for byte');
    assert.strictEqual(lainschema.detect(root), 1, 'the version did not move');
    const edges = require('../../src/wiring').load(root).edges;
    assert.strictEqual(edges.length, 1, 'and the project still reads its records');
  });

  await test('SCHEMA: rollback puts an explicit backup back, removing documents created since', () => {
    const root = foreignProject();
    fs.mkdirSync(path.join(root, '.lain'), { recursive: true });
    fs.writeFileSync(path.join(root, '.lain', 'schema-version.json'), JSON.stringify({ version: 2 }));
    const name = lainschema.backup(root, 2);
    lainstore.write(root, 'validation', { checks: [] });
    const back = lainschema.rollback(root, name);
    assert.ok(back.ok);
    assert.ok(!lainstore.has(root, 'validation'));
  });
};
