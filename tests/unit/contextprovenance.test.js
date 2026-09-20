'use strict';

/**
 * GENERATED CONTEXT MUST NEVER IMPERSONATE THE USER.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT, reproduced and traced to the exact line.
 *
 * `contextfit.buildWire` sends LAIN's own generated state — mode guidance,
 * session handover, the plan digest — as a plain `{ role: 'user', ... }`
 * message, appended after the person's real request. Anthropic concatenates
 * consecutive same-role turns, so the model reads generated prose as part of
 * the SAME, more recent user turn — and `MODE_GUIDANCE.CHAT`'s old text,
 * "Answer the user. This does not need the project inspected or any files
 * changed.", overrode an actual diagnostic request that mode.js had
 * misclassified as CHAT.
 *
 * This is pinned at both ends: the wire framing (this file) and the
 * classifier that produced the wrong mode in the first place (taskclass.js).
 */

const assert = require('assert');
const { test } = require('../helpers');

const contextprovenance = require('../../src/contextprovenance');
const contextfit = require('../../src/contextfit');
const prompt = require('../../src/prompt');

module.exports = async function () {
  await test('PROVENANCE: generated context is framed, never a bare user turn', () => {
    const wire = contextfit.buildWire({ contextChars() { return 0; }, messages: [] }, 'SYSTEM', 'the live block');
    const tail = wire[wire.length - 1];
    assert.strictEqual(tail.role, 'user', 'still a user-role turn — the caching architecture is unchanged');
    assert.strictEqual(tail.content, '<lain-context>\nthe live block\n</lain-context>',
      'wrapped in the structural marker, not sent bare');
  });

  await test('PROVENANCE: an empty live block produces no tail message at all', () => {
    const wire = contextfit.buildWire({ contextChars() { return 0; }, messages: [] }, 'SYSTEM', '');
    assert.strictEqual(wire.length, 1, 'only the system message — nothing was invented to wrap');
  });

  await test('PROVENANCE: the stable prompt teaches the tag before any turn uses it', () => {
    const built = prompt.build({ cwd: '/x', platform: 'win32', model: 'm', separate: true });
    assert.ok(built.stable.includes('<lain-context>'), 'the stable half names the exact tag it wraps context in');
    assert.match(built.stable, /never the person speaking/);
    assert.match(built.stable, /never a newer instruction than their own message/);
  });

  await test('PROVENANCE: CHAT guidance no longer addresses "the user" in second person', () => {
    // THE EXACT STRING FROM THE REPORT. If this substring ever comes back,
    // the P0 bug comes back with it, framed tag or not — a second-person
    // imperative reads as an instruction wherever it sits.
    const chat = prompt.MODE_GUIDANCE.CHAT;
    assert.ok(!/answer the user/i.test(chat), `CHAT guidance still says "Answer the user": ${chat}`);
    assert.ok(!/\bthe user\b/i.test(chat), `CHAT guidance still addresses "the user": ${chat}`);
  });

  await test('PROVENANCE: every other MODE_GUIDANCE entry is unaffected', () => {
    // §13 — fixing the authority bug must not touch the actual guidance
    // wording for genuine project work.
    for (const [mode, text] of Object.entries(prompt.MODE_GUIDANCE)) {
      if (mode === 'CHAT') continue;
      assert.ok(text.length > 20, `${mode} guidance is unexpectedly short`);
    }
    assert.match(prompt.MODE_GUIDANCE.BUGFIX, /Do not rewrite the thing the user named/);
    assert.match(prompt.MODE_GUIDANCE.IMPLEMENT, /Find the existing architecture/);
  });

  await test('PROVENANCE: section() tags authority correctly, and skips empty text', () => {
    const s1 = contextprovenance.section(contextprovenance.SOURCE.PLAN, contextprovenance.AUTHORITY.CONTEXT, 'plan text');
    assert.strictEqual(s1.generated, true);
    assert.strictEqual(s1.authority, 'context');
    const s2 = contextprovenance.section(contextprovenance.SOURCE.PLAN, contextprovenance.AUTHORITY.CONTEXT, '   ');
    assert.strictEqual(s2, null, 'whitespace-only text produces no section');
    const s3 = contextprovenance.section('x', contextprovenance.AUTHORITY.ACTUAL_USER, 'hi');
    assert.strictEqual(s3.generated, false, 'ACTUAL_USER authority is never marked generated');
  });

  await test('PROVENANCE: end to end — a live-diagnostic turn is framed and never overrides the request', () => {
    // Full pipeline: taskclass -> prompt guidance -> contextfit wire.
    const taskclass = require('../../src/taskclass');
    const verdict = taskclass.classify('Is Calculator responding to clicks?', { mode: 'CHAT' });
    assert.strictEqual(verdict.cls, 'LIVE_EXTERNAL_DIAGNOSTIC', 'no longer misclassified as pure chat');
    const session = { task: null, lifecycle: null, turns: [], evidence: null, taskClassVerdict: verdict };
    const built = prompt.build({ cwd: '/x', platform: 'win32', model: 'm', mode: 'CHAT', session, separate: true });
    assert.match(built.live, /LIVE_EXTERNAL_DIAGNOSTIC/);
    assert.ok(!/Answer the user\. This does not need/.test(built.live));
    const wire = contextfit.buildWire({ contextChars() { return 0; }, messages: [] }, built.stable, built.live);
    const tail = wire[wire.length - 1];
    assert.ok(tail.content.startsWith('<lain-context>'), 'the whole live block is framed on the wire');
  });
};
