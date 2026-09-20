'use strict';

/**
 * WHAT THE MODEL IS TOLD IS ALREADY ESTABLISHED.
 *
 * Auditing the real payload showed the gap: `session.evidence.digest()` existed
 * and was never used, and the lifecycle's files-changed and last-check never
 * reached the model at all. A resumed session therefore restored a SCREEN — the
 * conversation came back, but the conclusions drawn from it did not.
 *
 * The rule these encode: carry CONCLUSIONS, never the evidence behind them. A
 * file can be re-read; a decision the user made an hour ago cannot be
 * re-derived from the repository.
 */

const assert = require('assert');
const { test } = require('../helpers');

const prompt = require('../../src/prompt');

function sess(over = {}) {
  return {
    task: { objective: 'fix the toggle', steers: [] },
    lifecycle: { evidence: { filesChanged: new Set() }, lastCommand: null },
    evidence: { digest: () => '' },
    ...over,
  };
}

module.exports = async function () {
  await test('CTX: the user\'s later decisions are carried, and marked as overriding', () => {
    const s = sess({ task: { objective: 'x', steers: [{ text: 'Actually make it disabled by default.' }] } });
    const out = prompt.workingContext({ session: s });
    assert.match(out, /disabled by default/);
    assert.match(out, /override/i, 'a correction must be stated as outranking the original request');
  });

  await test('CTX: only the most recent decisions are carried, newest kept', () => {
    const steers = Array.from({ length: 9 }, (_, i) => ({ text: `decision ${i}` }));
    const out = prompt.workingContext({ session: sess({ task: { objective: 'x', steers } }) });
    assert.match(out, /decision 8/, 'the newest must survive');
    assert.ok(!/decision 0/.test(out), 'the oldest are dropped rather than growing without bound');
  });

  await test('CTX: files changed and the last check are stated as conclusions', () => {
    const s = sess({
      lifecycle: {
        evidence: { filesChanged: new Set(['C:/p/web/settings.js', 'C:/p/api/settings.js']) },
        lastCommand: { command: 'npm test', ok: false, exitCode: 1 },
      },
    });
    const out = prompt.workingContext({ session: s });
    assert.match(out, /settings\.js/);
    assert.match(out, /npm test/);
    assert.match(out, /FAILED/, 'a red check must be stated as red');
  });

  await test('CTX: a passing check reads as passing', () => {
    const s = sess({ lifecycle: { evidence: { filesChanged: new Set() }, lastCommand: { command: 'npm test', ok: true, exitCode: 0 } } });
    assert.match(prompt.workingContext({ session: s }), /npm test — passed/);
  });

  await test('CTX: what has already been read is carried, so a resumed turn does not re-read it', () => {
    const s = sess({ evidence: { digest: () => 'Already inspected this session (unchanged since):\n  - settings.js (420 lines)' } });
    assert.match(prompt.workingContext({ session: s }), /Already inspected/);
  });

  await test('CTX: a fresh session adds NOTHING — no empty headings', () => {
    assert.strictEqual(prompt.workingContext({ session: sess() }), '');
    assert.strictEqual(prompt.workingContext({}), '');
    assert.strictEqual(prompt.workingContext(), '');
  });

  await test('CTX: it reaches the built prompt, and only when there is something to say', () => {
    const bare = prompt.build({ cwd: '/p', platform: 'linux', model: 'm' });
    assert.ok(!/Already established/.test(bare), 'an empty block must not be sent');
    const withState = prompt.build({
      cwd: '/p', platform: 'linux', model: 'm',
      session: sess({ task: { objective: 'x', steers: [{ text: 'disabled by default' }] } }),
    });
    assert.match(withState, /# Already established/);
    assert.match(withState, /disabled by default/);
  });

  // ---- DURABLE PROJECT TRUTH, WHICH HAD NO READER --------------------------
  //
  // memory.js stores DECISION / SOURCE_OF_TRUTH / FACT / LIMITATION / NOTE per
  // project, on disk, surviving compaction and `/new`. It was reachable from
  // `/note` and a UI pane only — so the one reader that could act on it was the
  // only one that never saw it, and every session re-derived what was already
  // known. These check that it now rides the prompt, and stays bounded.
  await test('CTX: what is durably KNOWN about the project reaches the model', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const path2 = require('path');
    const mem = require('../../src/memory');
    const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'lain-mem-ctx-'));
    try {
      mem.add(root, 'External JSON is the source of truth for enemy data.', { kind: mem.KIND.DECISION });
      mem.add(root, 'lain-probe takes decimal PIDs, not hex.', { kind: mem.KIND.FACT });
      const out = prompt.workingContext({ session: sess({ cwd: root }) });
      assert.ok(/source of truth for enemy data/.test(out),
        `a recorded decision must reach the model:
${out}`);
      assert.ok(/decimal PIDs/.test(out), 'so must a recorded fact');
      assert.ok(/do not re-derive/i.test(out), 'and it must say what they are FOR');
    } finally {
      for (const i of mem.all(root)) mem.drop(root, i.id);
    }
  });

  await test('CTX: a project with nothing recorded says nothing about it', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const path2 = require('path');
    const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'lain-mem-empty-'));
    const out = prompt.workingContext({ session: sess({ cwd: root }) });
    assert.ok(!/Known about this project/.test(out), 'an empty store must add no heading');
  });

  await test('CTX: recorded truths are CAPPED — this rides on every request', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const path2 = require('path');
    const mem = require('../../src/memory');
    const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'lain-mem-cap-'));
    try {
      for (let i = 0; i < 25; i++) mem.add(root, `recorded truth number ${i} about this project`, { kind: mem.KIND.FACT });
      const out = prompt.workingContext({ session: sess({ cwd: root }) });
      const shown = (out.match(/^- (?:decision|fact|limitation|note|source-of-truth):/gm) || []).length;
      assert.ok(shown <= 6, `carried ${shown} rows — the block is sent on every step`);
      assert.ok(/more, see \/note/.test(out), 'and it must say that there are more');
    } finally {
      for (const i of mem.all(root)) mem.drop(root, i.id);
    }
  });

  await test('CTX: the block stays small — it is sent once, at turn open', () => {
    const s = sess({
      task: { objective: 'x', steers: Array.from({ length: 9 }, (_, i) => ({ text: 'a decision '.repeat(30) + i })) },
      lifecycle: {
        evidence: { filesChanged: new Set(Array.from({ length: 40 }, (_, i) => `C:/p/file${i}.js`)) },
        lastCommand: { command: 'x'.repeat(400), ok: false, exitCode: 2 },
      },
    });
    const out = prompt.workingContext({ session: s });
    assert.ok(out.length < 1800, `the block grew to ${out.length} chars`);
  });

  // ---- THE RE-ENTRY / REPEATED-STEER DEFECT --------------------------------
  //
  // This block used to ride on EVERY request of a turn, per the test this
  // replaces ("rides on every request of the turn" — that was the documented
  // design, not an accident). Traced to a real, reported symptom: a single
  // focused correction produced repeated mid-task restatement — "The steer
  // is...", "Back on the two router bugs..." — between ordinary reads, many
  // steps into a task nobody had corrected again. The block was
  // authority-correct and small; it was still an announcement repeated
  // verbatim at the tail of context on every step, and a model handed the
  // same announcement every step treated it as news every time. `opened`
  // already existed for exactly two OTHER once-per-turn facts (a cut-off
  // previous turn, a blocked state) — this closes the gap for the rest.
  await test('CTX: on a CONTINUATION step (opened:true), the whole recap is silent — a correction already delivered once is not news twice', () => {
    const s = sess({
      task: { objective: 'x', steers: [{ text: 'Actually make it disabled by default.' }] },
      lifecycle: {
        evidence: { filesChanged: new Set(['C:/p/settings.js']) },
        lastCommand: { command: 'npm test', ok: false, exitCode: 1 },
      },
      evidence: { digest: () => 'Already inspected this session (unchanged since):\n  - settings.js (420 lines)' },
    });
    assert.strictEqual(prompt.workingContext({ session: s, opened: true }), '');
    // AND UNCHANGED ON THE OPENING STEP — this is a gate on repetition, not a
    // removal of the fact.
    assert.match(prompt.workingContext({ session: s, opened: false }), /disabled by default/);
  });

  await test('CTX: a live, mid-turn correction is unaffected — it travels through app.queueSteer\'s consume-once callback, not this recap', () => {
    // Structural: the recap being silent on a continuation step must not be
    // mistaken for "corrections cannot reach the model mid-turn" — that path
    // is jobrunner.js's `steer()` callback (app.js), asserted here to still
    // exist and remain independent of workingContext/opened.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'app.js'), 'utf8');
    assert.match(src, /steer:\s*\(\)\s*=>/, 'the live per-step steer callback must still exist');
  });
};
