'use strict';

/**
 * THE MUTATION TRANSACTION — one lifecycle, and a REVERT that is real.
 *
 * Every case drives the real tool door (tools/index.js execute) or the real
 * transaction, against real files in a temp tree.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const tools = require('../../src/tools');
const mutation = require('../../src/mutation');
const { Session } = require('../../src/session');
const { Checkpoints } = require('../../src/checkpoint');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-tx-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

function ctxFor(root, extra = {}) {
  const session = new Session({ cwd: root });
  session.task = new (require('../../src/task').Task)('fix the parser');
  return { cwd: root, session, checkpoints: new Checkpoints(session.id, root), turnId: 't1', ...extra };
}

const SRC = [
  'function alpha() {',
  '  return 1;',
  '}',
  '',
  'function beta() {',
  '  return 2;',
  '}',
  '',
  'module.exports = { alpha, beta };',
  '',
].join('\n');

module.exports = async function () {
  await test('TX: an ordinary write runs the whole lifecycle and is KEPT, with a receipt', async () => {
    const root = tree({ 'a.js': SRC });
    const ctx = ctxFor(root);
    ctx.session.evidence.observe('read_file', { path: 'a.js' }, { output: SRC, meta: { size: Buffer.byteLength(SRC), mtimeMs: Math.floor(fs.statSync(path.join(root, 'a.js')).mtimeMs), lines: 10 } });
    const r = await tools.execute('apply_patch', { path: 'a.js', expect: '  return 1;', replace: '  return 11;' }, ctx);
    assert.ok(!r.isError, r.output);
    const tx = r.transaction;
    assert.strictEqual(tx.verdict, mutation.VERDICT.KEEP);
    assert.deepStrictEqual(tx.stages.map((s) => s.split(':')[0]),
      ['BASELINE', 'STALE', 'CHECKPOINT', 'APPLY', 'STRUCTURAL', 'REFRESH', 'VERIFY', 'SETTLE']);
    assert.notStrictEqual(tx.baseline['a.js'], tx.after['a.js'], 'the baseline and the result are both fingerprinted');
    assert.ok(r.checkpoint && r.checkpoint.id, 'the checkpoint is captured by the transaction');
    assert.strictEqual(ctx.session.mutationReceipts.length, 1, 'the receipt is on the session');
    assert.ok(tx.verification.level, 'a verification level is selected');
  });

  await test('TX: move_file now has a checkpoint for BOTH ends, so /undo can put it back', async () => {
    const root = tree({ 'old.js': 'module.exports = 1;\n' });
    const ctx = ctxFor(root);
    // The existing no-inspection guard still applies: read before moving.
    await tools.execute('read_file', { path: 'old.js' }, ctx).then((res) => ctx.session.evidence.observe('read_file', { path: 'old.js' }, res));
    const r = await tools.execute('move_file', { from: 'old.js', to: 'new.js' }, ctx);
    assert.ok(!r.isError, r.output);
    assert.strictEqual(r.checkpoint.files.length, 2);
    const undone = ctx.checkpoints.undo();
    assert.ok(undone.ok, undone.error);
    assert.ok(fs.existsSync(path.join(root, 'old.js')) && !fs.existsSync(path.join(root, 'new.js')));
  });

  await test('TX J: a failed verification REVERTS, and a concurrent change to the same file survives', async () => {
    const root = tree({ 'a.js': SRC, 'other.js': 'module.exports = "untouched";\n' });
    const target = path.join(root, 'a.js');
    const ctx = ctxFor(root, {
      // THE CONCURRENT EDIT lands while verification is running: someone else
      // changes beta() in the SAME file and writes another file entirely.
      async verify() {
        fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('return 2;', 'return 22; // concurrent'));
        fs.writeFileSync(path.join(root, 'other.js'), 'module.exports = "changed by someone else";\n');
        return { ok: false, why: 'alpha() test failed' };
      },
    });
    const apply = async () => {
      fs.writeFileSync(target, SRC.replace('return 1;', 'return 111;'));
      return { output: 'wrote', mutated: [target] };
    };
    const r = await mutation.transact({ name: 'write_file', input: { path: 'a.js' }, ctx, apply });
    const now = fs.readFileSync(target, 'utf8');
    assert.strictEqual(r.transaction.verdict, mutation.VERDICT.REVERT, r.output);
    assert.ok(now.includes('return 1;'), 'the transaction\'s own hunk was reversed');
    assert.ok(now.includes('return 22; // concurrent'), 'the concurrent change in the same file was NOT destroyed');
    assert.strictEqual(fs.readFileSync(path.join(root, 'other.js'), 'utf8'), 'module.exports = "changed by someone else";\n',
      'an unrelated file is untouched by the revert');
    assert.ok(r.isError, 'a reverted change is reported as not standing');
  });

  await test('TX J: when nobody else touched the file, REVERT restores it byte for byte', async () => {
    const root = tree({ 'a.js': SRC });
    const target = path.join(root, 'a.js');
    const ctx = ctxFor(root, { verify: async () => ({ ok: false, why: 'failed' }) });
    const r = await mutation.transact({
      name: 'write_file', input: { path: 'a.js' }, ctx,
      apply: async () => { fs.writeFileSync(target, 'garbage'); return { mutated: [target] }; },
    });
    assert.strictEqual(r.transaction.verdict, mutation.VERDICT.REVERT);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), SRC);
  });

  await test('TX: a revert that cannot isolate its hunk leaves the file alone and says REVERT_CONFLICT', async () => {
    const root = tree({ 'a.js': SRC });
    const target = path.join(root, 'a.js');
    const ctx = ctxFor(root, {
      async verify() { fs.writeFileSync(target, 'completely rewritten by someone else\n'); return { ok: false }; },
    });
    const r = await mutation.transact({
      name: 'write_file', input: { path: 'a.js' }, ctx,
      apply: async () => { fs.writeFileSync(target, SRC.replace('return 1;', 'return 9;')); return { mutated: [target] }; },
    });
    assert.strictEqual(r.transaction.verdict, mutation.VERDICT.REVERT_CONFLICT);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'completely rewritten by someone else\n', 'no guess was written over it');
  });

  await test('TX: the main executor KEEPS a write that does not parse, and says so (refactors pass through that state)', async () => {
    const root = tree({ 'a.js': SRC });
    const ctx = ctxFor(root);
    ctx.session.evidence.observe('read_file', { path: 'a.js' }, { output: SRC, meta: { size: Buffer.byteLength(SRC), mtimeMs: Math.floor(fs.statSync(path.join(root, 'a.js')).mtimeMs), lines: 10 } });
    const r = await tools.execute('apply_patch', { path: 'a.js', expect: 'function beta() {', replace: 'function beta( {' }, ctx);
    assert.strictEqual(r.transaction.verdict, mutation.VERDICT.KEEP);
    assert.strictEqual(r.transaction.structural.parse, false);
    assert.ok(r.syntaxError, 'the parse failure is still reported to the model');
  });

  await test('TX: a tool that refuses changes nothing and the verdict is NOT_APPLIED', async () => {
    const root = tree({ 'a.js': SRC });
    const ctx = ctxFor(root);
    const r = await tools.execute('apply_patch', { path: 'a.js', expect: 'no such text', replace: 'x' }, ctx);
    assert.ok(r.isError);
    assert.strictEqual(r.transaction.verdict, mutation.VERDICT.NOT_APPLIED);
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), SRC);
  });

  await test('TX: reverseHunk is exact about ambiguity', () => {
    assert.strictEqual(mutation.reverseHunk('a X b', 'a Y b', 'zz a Y b zz'), 'zz a X b zz');
    assert.strictEqual(mutation.reverseHunk('X', 'Y', 'Y and Y'), null, 'two candidate places is no place');
  });

  await test('TX: the first LAIN write to a project measures a fingerprint baseline first', async () => {
    const root = tree({ 'a.js': SRC, 'b.py': 'print(1)\n' });
    const ctx = ctxFor(root);
    await tools.execute('write_file', { path: 'new.js', content: 'module.exports = 3;\n' }, ctx);
    const base = require('../../src/lainstore').read(root, 'baseline', null);
    assert.ok(base && base.files['a.js'] && base.files['b.py'], 'the pre-existing files were fingerprinted');
    assert.ok(!base.files['new.js'], 'measured BEFORE the write, so the new file is not in it');
  });
};
