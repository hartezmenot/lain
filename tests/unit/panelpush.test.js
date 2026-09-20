'use strict';

/**
 * A DRILLED-IN PANEL LEVEL OPENS ON SOMETHING CHOOSABLE.
 *
 * Live, 2026-09-18: `/model kr/claude-sonnet-4.5` → Enter opened the route
 * detail (connection, provider, credential, readiness, availability, then the
 * EFFORT rows). `push` left the cursor at row 0 — an info row — so no marker
 * was drawn and Enter did nothing until the user happened to press ↓.
 * `open` and `replace` already landed on a selectable row; `push` did not.
 */

const assert = require('assert');
const { test } = require('../helpers');
const { InteractionPanel, routeDetailAdapter } = require('../../src/ui/panel');

module.exports = async function () {
  await test('PANEL: push lands the cursor on the first selectable row, and Enter uses it', () => {
    const p = new InteractionPanel();
    p.open({ title: 'models', items: [{ label: 'a model', value: 1 }] });
    const connection = { connectionId: 'lain:localhost:kr', provider: 'localhost', via: 'native', auth: 'api_key', efforts: ['agentic', 'thinking'] };
    let picked = null;
    const detail = routeDetailAdapter({ model: { id: 'm', displayName: 'M' }, connection, onPickRoute: (m, c, e) => { picked = e; } });
    p.push(detail);
    assert.ok(p.current, 'something is highlighted');
    assert.strictEqual(p.current.effort, 'agentic', 'the first effort, not the connection row');
    const out = detail.onSelect(p.current);
    assert.ok(out && out.close, 'Enter on it selects');
    assert.strictEqual(picked, 'agentic');
  });

  await test('PANEL: push still honours an explicit selectable cursor', () => {
    const p = new InteractionPanel();
    p.open({ items: [{ label: 'x' }] });
    p.push({ items: [{ label: 'h', selectable: false }, { label: 'a' }, { label: 'b' }], cursor: 2 });
    assert.strictEqual(p.current.label, 'b');
  });
};
