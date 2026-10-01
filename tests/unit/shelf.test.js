'use strict';

/**
 * THE CONTEXT ACTION SHELF — ui/shelf.js, driven through the real panel.
 */

const assert = require('assert');
const { test } = require('../helpers');
const { InteractionPanel, KIND } = require('../../src/ui/panel');
const { shelf, actionRow } = require('../../src/ui/shelf');

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function open(o) {
  const panel = new InteractionPanel();
  const frame = shelf(o);
  const answer = panel.open(frame);
  return { panel, frame, answer };
}

const GOAL = {
  title: 'Goal',
  context: ['Finish Noema Harness application'],
  actions: [
    { label: 'Continue', value: 'continue' },
    { label: 'Edit', value: 'edit' },
    { label: 'New', value: 'new' },
    { label: 'Delete', value: 'delete', confirm: 'Delete this goal?' },
  ],
};

module.exports = async function () {
  await test('SHELF: renders title, context and one row of actions, compact', () => {
    const { panel } = open(GOAL);
    assert.strictEqual(panel.kind, KIND.SHELF);
    const rows = panel.render(80, 8).map(plain);
    assert.ok(rows.some((r) => /Goal/.test(r)), rows.join('\n'));
    assert.ok(rows.some((r) => /Finish Noema Harness application/.test(r)));
    const actions = rows.find((r) => /Continue/.test(r));
    assert.match(actions, /Continue\s+Edit\s+New\s+Delete/, 'actions sit on one row');
  });

  await test('SHELF: ←/→ move focus and Enter resolves the focused action', async () => {
    const { panel, frame, answer } = open(GOAL);
    frame.onKey('right', { panel });
    frame.onKey('enter', { panel });
    assert.deepStrictEqual(await answer, { action: 'edit', choice: null });
  });

  await test('SHELF: a destructive action asks in place, defaults to Cancel, and Esc backs out', async () => {
    const { panel, frame, answer } = open(GOAL);
    frame.onKey('left', { panel });                     // wraps to Delete
    frame.onKey('enter', { panel });
    assert.ok(panel.visible, 'asking, not deleting');
    assert.ok(panel.render(80, 8).map(plain).some((r) => /Delete this goal\?/.test(r)), 'the question is on the shelf');
    frame.onKey('enter', { panel });                    // focus is on Cancel
    assert.ok(panel.visible, 'Enter on the default does not delete');
    frame.onKey('enter', { panel });                    // Delete again → asks again
    frame.onKey('escape', { panel });
    assert.ok(panel.visible && !frame.shelf.confirming, 'Esc backs out of the question only');
    frame.onKey('enter', { panel });
    frame.onKey('left', { panel });                     // to Yes
    frame.onKey('enter', { panel });
    assert.deepStrictEqual(await answer, { action: 'delete', choice: null });
  });

  await test('SHELF: with choices, ↑/↓ choose what the action applies to', async () => {
    const { panel, frame, answer } = open({
      title: 'Resume session',
      choices: [{ label: 'toradb · Fix startup race', value: 's1' }, { label: 'lain-v2 · Harness', value: 's2' }],
      actions: [{ label: 'Continue', value: 'continue' }],
    });
    panel.move(1);
    frame.onKey('enter', { panel });
    assert.deepStrictEqual(await answer, { action: 'continue', choice: 's2' });
  });

  await test('SHELF: a unique first letter runs its action; a click on a button runs it', async () => {
    let t = open(GOAL);
    t.panel.shortcut('n');
    assert.deepStrictEqual(await t.answer, { action: 'new', choice: null });
    t = open(GOAL);
    const { spans } = actionRow(t.frame.shelf);
    const row = t.panel.items[t.frame.actionRowIndex];
    t.frame.onClick(row, spans[1].start + 1, { panel: t.panel, index: t.frame.actionRowIndex });
    assert.deepStrictEqual(await t.answer, { action: 'edit', choice: null });
  });
};
