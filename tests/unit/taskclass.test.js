'use strict';

/**
 * TASK CLASSES — WHAT GROUNDING DOES THIS REQUEST ACTUALLY NEED?
 *
 * See src/taskclass.js's header for the exact defect: a live desktop
 * diagnostic with no imperative mode.js recognises fell through to CHAT and
 * was told "this does not need the project inspected", which the model then
 * obeyed instead of running the diagnostic. This pins the classifier against
 * every example the steer gave, in both directions — the live/direct cases
 * that must NOT be forced into project implementation, and the project cases
 * that must keep every bit of their existing strictness.
 */

const assert = require('assert');
const { test } = require('../helpers');

const taskclass = require('../../src/taskclass');
const { CLASS, GROUNDING } = taskclass;

module.exports = async function () {
  await test('CLASS: a live desktop diagnostic is LIVE_EXTERNAL_DIAGNOSTIC, not CHAT or IMPLEMENT', () => {
    for (const text of [
      'Test whether Calculator control works.',
      'Is Calculator responding to clicks?',
      'Inspect this running app.',
      'Diagnose why OBS isn\'t seeing this device.',
      'Check this desktop process.',
      'Check my running Calculator',
    ]) {
      const v = taskclass.classify(text, { mode: 'CHAT' });
      assert.strictEqual(v.cls, CLASS.LIVE_EXTERNAL_DIAGNOSTIC, `misrouted: ${text} -> ${v.cls}`);
      assert.strictEqual(v.projectSourceRequired, false);
      assert.strictEqual(v.grounding, GROUNDING.LIVE_DESKTOP);
    }
  });

  await test('CLASS: Computer MCP named explicitly always wins, regardless of mode', () => {
    const v = taskclass.classify('diagnose Calculator using Computer MCP', { mode: 'IMPLEMENT' });
    assert.strictEqual(v.cls, CLASS.LIVE_EXTERNAL_DIAGNOSTIC);
    assert.strictEqual(v.surface, 'computer-mcp');
  });

  await test('CLASS: the person\'s own browser routes to LAIN for Chrome, not the project', () => {
    const v = taskclass.classify('Look at the Chrome tab I have open', { mode: 'CHAT' });
    assert.strictEqual(v.cls, CLASS.LIVE_EXTERNAL_DIAGNOSTIC);
    assert.strictEqual(v.surface, 'chrome');
    assert.strictEqual(v.projectSourceRequired, false);
  });

  await test('CLASS: one deterministic operation is DIRECT_TOOL_TASK, not a project task', () => {
    const v = taskclass.classify('Take a screenshot of my desktop', { mode: 'IMPLEMENT' });
    assert.strictEqual(v.cls, CLASS.DIRECT_TOOL_TASK);
    assert.strictEqual(v.projectSourceRequired, false);
  });

  await test('CLASS: an investigation verb keeps a live target OUT of DIRECT_TOOL_TASK', () => {
    // "diagnose" implies more than one step — it belongs to the diagnostic
    // class, not the single-operation one, even though both share a surface.
    const v = taskclass.classify('diagnose Calculator using Computer MCP', {});
    assert.strictEqual(v.cls, CLASS.LIVE_EXTERNAL_DIAGNOSTIC);
  });

  await test('CLASS: ordinary project work keeps FULL grounding — nothing is weakened', () => {
    for (const text of ['Change src/api.ts', 'Fix this bug in the parser', 'add a cancel button to the checkout form']) {
      const v = taskclass.classify(text, { mode: 'IMPLEMENT' });
      assert.strictEqual(v.cls, CLASS.PROJECT_IMPLEMENTATION, `wrongly routed away from project work: ${text}`);
      assert.strictEqual(v.projectSourceRequired, true);
      assert.strictEqual(v.grounding, GROUNDING.PROJECT_STRICT);
    }
  });

  await test('CLASS: a project mention that merely SOUNDS like a live noun stays project work', () => {
    // "the calculator function returns NaN" is a bug in a project's OWN code,
    // not a live diagnostic against the Windows Calculator app — no
    // running/my/this qualifier and no diagnostic verb, so it must not
    // false-positive on the word alone.
    const v = taskclass.classify('the calculator function returns NaN for negative input', { mode: 'BUGFIX' });
    assert.strictEqual(v.cls, CLASS.PROJECT_IMPLEMENTATION, `false-positived on the bare word: ${v.cls}`);
  });

  await test('CLASS: a frontend project task hints at the Workshop, without leaving PROJECT_IMPLEMENTATION', () => {
    const v = taskclass.classify('Fix this React button and test mobile', { mode: 'BUGFIX' });
    assert.strictEqual(v.cls, CLASS.PROJECT_IMPLEMENTATION, 'still project work — the project is still the target');
    assert.strictEqual(v.projectSourceRequired, true, 'still needs every project guard');
    assert.strictEqual(v.surface, 'workshop', 'but the natural surface is the Workshop');
  });

  await test('CLASS: project diagnostics do not imply "and now implement a fix"', () => {
    for (const [text, mode] of [
      ['Find why this project crashes.', 'TROUBLESHOOT'],
      ['Inspect this repository.', 'AUDIT'],
      ['Run tests and tell me what\'s wrong.', 'AUDIT'],
    ]) {
      const v = taskclass.classify(text, { mode });
      assert.strictEqual(v.cls, CLASS.PROJECT_DIAGNOSTIC, `${text} -> ${v.cls}`);
      assert.strictEqual(v.projectSourceRequired, false, 'reading and testing does not require a mutation target');
    }
  });

  await test('CLASS: plain conversation is its own class, not folded into a diagnostic', () => {
    const v = taskclass.classify('thanks!', { mode: 'CHAT' });
    assert.strictEqual(v.cls, CLASS.CONVERSATIONAL);
    assert.strictEqual(v.grounding, GROUNDING.NONE);
  });

  await test('CLASS: statusLine() renders the compact status the diagnostic surface (§56) shows', () => {
    const v = taskclass.classify('diagnose Calculator using Computer MCP', {});
    const line = taskclass.statusLine(v);
    assert.match(line, /Task class: LIVE_EXTERNAL_DIAGNOSTIC/);
    assert.match(line, /Grounding: LIVE_DESKTOP/);
    assert.match(line, /Project source required: NOT REQUIRED/);
    assert.match(line, /Suggested surface: computer-mcp/);
  });

  await test('CROSS-SURFACE (§47): every named example routes to the surface the steer specified', () => {
    const table = [
      ['Change src/api.ts', 'IMPLEMENT', CLASS.PROJECT_IMPLEMENTATION, 'project-tools'],
      ['Check my running Calculator', 'CHAT', CLASS.LIVE_EXTERNAL_DIAGNOSTIC, 'computer-mcp'],
      ['Fix this React button and test mobile', 'BUGFIX', CLASS.PROJECT_IMPLEMENTATION, 'workshop'],
      ['Look at the Chrome tab I have open', 'CHAT', CLASS.LIVE_EXTERNAL_DIAGNOSTIC, 'chrome'],
      ['Take a screenshot of my desktop', 'IMPLEMENT', CLASS.DIRECT_TOOL_TASK, 'computer-mcp'],
    ];
    for (const [text, mode, cls, surface] of table) {
      const v = taskclass.classify(text, { mode });
      assert.strictEqual(v.cls, cls, `${text}: class`);
      assert.strictEqual(v.surface, surface, `${text}: surface`);
    }
  });
};
