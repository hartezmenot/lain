'use strict';

/**
 * PROJECT SYNC (2026-10-02: Node's own record, no supervisor) — what the last session saw of a tree.
 * Counts and a digest per project root in <config>/projects.json, never the index itself.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const ps = require('../../src/projectsync');

  const tree = () => {
    const d = tmpdir('psync-');
    fs.writeFileSync(path.join(d, 'a.js'), 'function alpha() { return 1; }\n');
    fs.writeFileSync(path.join(d, 'b.js'), 'const beta = () => 2;\n');
    return d;
  };

  await test('PSYNC: a project is NEW once, then UNCHANGED, then MODIFIED', async () => {
    const root = tree();
    assert.strictEqual((await ps.open(root)).verdict, 'NEW');
    assert.strictEqual((await ps.open(root)).verdict, 'UNCHANGED');
    fs.writeFileSync(path.join(root, 'c.js'), 'let gamma = 3;\n');
    assert.strictEqual((await ps.open(root)).verdict, 'MODIFIED');
  });

  await test('PSYNC: the record holds counts and a digest — never the index', async () => {
    const root = tree();
    await ps.open(root);
    const book = JSON.parse(fs.readFileSync(path.join(require('../../src/config').configDir(), 'projects.json'), 'utf8'));
    const rec = book.projects[path.resolve(root).toLowerCase()];
    assert.ok(rec && rec.digest && rec.files >= 2);
    assert.ok(!JSON.stringify(rec).includes('alpha'), 'no symbol leaks into the record');
  });

  await test('PSYNC: two projects keep independent state', async () => {
    const a = tree(); const b = tree();
    await ps.open(a);
    assert.strictEqual((await ps.open(b)).verdict, 'NEW');
    assert.strictEqual((await ps.open(a)).verdict, 'UNCHANGED');
  });

  await test('PSYNC: the digest is stable for a tree and moves when the tree does', async () => {
    const root = tree();
    const d1 = (await ps.open(root)).digest;
    const d2 = (await ps.open(root)).digest;
    assert.strictEqual(d1, d2);
    fs.writeFileSync(path.join(root, 'a.js'), 'function alpha() { return 42; }\n');
    assert.notStrictEqual((await ps.open(root)).digest, d1);
  });

  await test('PSYNC: say() words every verdict', () => {
    const r = { added: 2, changed: 1, removed: 0, reused: 3 };
    assert.match(ps.say('NEW', r), /First time/);
    assert.match(ps.say('UNCHANGED', r), /Unchanged/);
    assert.match(ps.say('MODIFIED', r), /re-read/);
    assert.match(ps.say('UNKNOWN', r), /no record/);
  });
};
