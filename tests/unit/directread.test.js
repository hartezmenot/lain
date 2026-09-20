'use strict';

/**
 * §18 — AN EXPLICIT READ REQUEST GOES TO THE FILE, NOT TO WHAT LAIN ALREADY
 * THINKS IT KNOWS.
 *
 * ------------------------------------------------------------------------
 * THE SCENARIO. fixture.txt contains OLD. The user says "Read fixture.txt,
 * replace OLD with NEW, then verify." The evidence ledger (evidence.js)
 * exists precisely to avoid re-injecting a file's bytes when nothing about
 * it changed — but a WRITE must retire that claim immediately, so the
 * VERIFY read is a real read of what is on disk now, never a substitution
 * that would still say OLD.
 *
 * This drives the real tools (read_file/write_file from tools/fs.js) through
 * toolstep.js exactly as turn.js does, against a real file on real disk —
 * not a mock — because the property under test is "the second read touches
 * the filesystem", which a mock cannot fail to demonstrate.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const toolstep = require('../../src/toolstep');
const { Session } = require('../../src/session');

// Large enough to cross evidence.js's LARGE_FILE_LINES=250 threshold, so a
// small fixture could never exercise the substitution path either way.
function bigFixture(marker) {
  const lines = Array.from({ length: 260 }, (_, i) => (i === 130 ? marker : `filler line ${i}`));
  return lines.join('\n');
}

function ctxFor(session) {
  return { cwd: session.cwd, session, signal: null };
}

module.exports = async function () {
  await test('DIRECT READ: a write invalidates the ledger, so the verify read is genuine, not cached', async () => {
    const root = tmpdir('directread-');
    const file = path.join(root, 'fixture.txt');
    fs.writeFileSync(file, bigFixture('OLD'));
    const session = new Session({ cwd: root });
    const toolCtx = ctxFor(session);

    // 1) THE FIRST READ — establishes evidence.
    const r1 = await toolstep.run({ id: 'c1', name: 'read_file', input: { path: 'fixture.txt' } }, { session, evidence: session.evidence, toolCtx });
    assert.match(r1.result.output, /OLD/);
    assert.ok(!r1.result.fromEvidence, 'the first read is never a substitution');
    // THE BODY IS ON THE WIRE, as turn.js puts it there — the only condition under
    // which the ledger may say "you already have this" (toolstep.bodyOnWire).
    session.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt' }) }] },
      { role: 'tool', tool_call_id: 'c1', content: r1.result.output });

    // 2) A RE-READ WITH NOTHING CHANGED may legitimately be served from evidence
    //    — this is the behaviour the ledger exists for, and it must still work.
    const r1b = await toolstep.run({ id: 'c1b', name: 'read_file', input: { path: 'fixture.txt' } }, { session, evidence: session.evidence, toolCtx });
    assert.ok(r1b.result.fromEvidence, 'an immediate unchanged re-read of a large file is the evidence ledger\'s actual job');

    // 3) THE MUTATION — replaces OLD with NEW on real disk.
    const content = fs.readFileSync(file, 'utf8').replace('OLD', 'NEW');
    const r2 = await toolstep.run({ id: 'c2', name: 'write_file', input: { path: 'fixture.txt', content } }, { session, evidence: session.evidence, toolCtx });
    assert.ok(!r2.result.isError, `write must succeed: ${r2.result.output}`);

    // 4) THE VERIFY READ — must be a REAL read reflecting NEW, never a stale
    //    substitution still claiming OLD. This is the exact property §18 pins.
    const r3 = await toolstep.run({ id: 'c3', name: 'read_file', input: { path: 'fixture.txt' } }, { session, evidence: session.evidence, toolCtx });
    assert.ok(!r3.result.fromEvidence, 'a write must retire the ledger entry — the verify read is not served from cache');
    assert.match(r3.result.output, /NEW/, 'the verify read must see the new content');
    assert.ok(!/\bOLD\b/.test(r3.result.output), 'the verify read must not still claim OLD');

    // 5) DISK ITSELF AGREES — the mutation actually landed, independent of LAIN's bookkeeping.
    assert.strictEqual(fs.readFileSync(file, 'utf8').includes('NEW'), true);
  });

  await test('DIRECT READ: after the body leaves the wire (/clear), an unchanged re-read is REAL, never the stub', async () => {
    const root = tmpdir('directread-clear-');
    fs.writeFileSync(path.join(root, 'fixture.txt'), bigFixture('KEEP'));
    const session = new Session({ cwd: root });
    const toolCtx = ctxFor(session);
    const r1 = await toolstep.run({ id: 'k1', name: 'read_file', input: { path: 'fixture.txt' } }, { session, evidence: session.evidence, toolCtx });
    session.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'k1', name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt' }) }] },
      { role: 'tool', tool_call_id: 'k1', content: r1.result.output });
    session.contextAuthority.clearContext();
    const r2 = await toolstep.run({ id: 'k2', name: 'read_file', input: { path: 'fixture.txt' } }, { session, evidence: session.evidence, toolCtx });
    assert.ok(!r2.result.fromEvidence, 'the model no longer holds the body, so the ledger must not claim it does');
    assert.match(r2.result.output, /KEEP/, 'the real bytes come back');
  });

  await test('DIRECT READ: a read that was never on this wire (another view, a lost message) is served for real', async () => {
    const root = tmpdir('directread-wire-');
    fs.writeFileSync(path.join(root, 'fixture.txt'), bigFixture('WIRE'));
    const session = new Session({ cwd: root });
    const toolCtx = ctxFor(session);
    await toolstep.run({ id: 'w1', name: 'read_file', input: { path: 'fixture.txt' } }, { session, evidence: session.evidence, toolCtx });
    const r2 = await toolstep.run({ id: 'w2', name: 'read_file', input: { path: 'fixture.txt' } }, { session, evidence: session.evidence, toolCtx });
    assert.ok(!r2.result.fromEvidence);
    assert.match(r2.result.output, /WIRE/);
  });

  await test('DIRECT READ: project intelligence alone (a fingerprint) is not a substitute for reading the file', () => {
    // readreceipts.contentFingerprint reads the file to hash it, but a
    // fingerprint is a change-detector, not file content — nothing in the
    // codebase may treat "we have a fingerprint for this path" as equivalent
    // to "the model has read this file". Confirmed structurally: the evidence
    // ledger's substitution path (`check`) is keyed ONLY off `BODY_READS`
    // (read_file) having actually run in this session — see evidence.js.
    const root = tmpdir('directread-fp-');
    const file = path.join(root, 'fixture2.txt');
    fs.writeFileSync(file, bigFixture('OLD'));
    const session = new (require('../../src/session').Session)({ cwd: root });
    // Compute a fingerprint WITHOUT ever calling read_file.
    require('../../src/readreceipts').contentFingerprint(file);
    // The ledger must have NO entry for this path — a fingerprint lookup is
    // not a whole-file read and must not be able to satisfy `check()`.
    const stampNow = (() => { const st = fs.statSync(file); return { size: st.size, mtime: Math.floor(st.mtimeMs) }; })();
    assert.strictEqual(session.evidence.lookup('fixture2.txt', stampNow), null);
  });
};
