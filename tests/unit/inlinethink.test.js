'use strict';

/**
 * INLINE <thinking> IN CONTENT NEVER REACHES THE TRANSCRIPT AS THE ANSWER.
 *
 * Live, 2026-09-18: kr/claude-sonnet-4.5-agentic via 9router streamed
 * "<thinking>…I need to report this clearly to the user.\n</thinking>\n\nThe
 * page shows: …" in `delta.content`; LAIN drew the working-out and the stray
 * closing tag as the answer.
 */

const assert = require('assert');
const { test } = require('../helpers');
const { InlineThink } = require('../../src/inlinethink');

function run(chunks) {
  const t = new InlineThink();
  const out = [];
  for (const c of chunks) out.push(...t.push(c));
  out.push(...t.flush());
  const join = (type) => out.filter((e) => e.type === type).map((e) => e.chunk).join('');
  return { text: join('text'), reasoning: join('reasoning') };
}

module.exports = async function () {
  await test('INLINE THINK: a leading <thinking> block is reasoning, the rest is the answer', () => {
    const r = run(['<thinking>\nI should report it.\n</thinking>\n\nThe page shows: 28.50']);
    assert.strictEqual(r.text.trim(), 'The page shows: 28.50');
    assert.match(r.reasoning, /I should report it\./);
    assert.doesNotMatch(r.text, /thinking>/);
  });

  await test('INLINE THINK: tags split across stream chunks are still recognised; nothing is lost', () => {
    const whole = '<thinking>plan A</thinking>Answer <b>bold</b> <think>more</think>end';
    const chunks = whole.match(/.{1,3}/gs);
    const r = run(chunks);
    assert.strictEqual(r.text, 'Answer <b>bold</b> end');
    assert.strictEqual(r.reasoning, 'plan Amore');
  });

  await test('INLINE THINK: ordinary text, including a lone "<", passes through untouched', () => {
    const r = run(['if a < b then ', 'x<', 'y']);
    assert.strictEqual(r.text, 'if a < b then x<y');
    assert.strictEqual(r.reasoning, '');
  });
};
