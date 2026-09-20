'use strict';

/**
 * §24/§25 — THE BATCH ACTION BUG: "there is no action \"\"".
 *
 * ------------------------------------------------------------------------
 * ROOT CAUSE, traced to the exact two lines. A single action goes through
 * `tools/computermcp.js`'s `default` case, which translates the model's
 * vocabulary field `op` into the internal field `ComputerMCP.act()` actually
 * reads, `action`:
 *
 *     const r = await c.act({ ...input, action: op, target });
 *
 * `batch`'s steps are documented as "these same specs" — so a model
 * reasonably writes each step with `op`, exactly like a single call. But the
 * batch case passed `input.steps` straight through with NO translation:
 *
 *     const r = await c.batch(input.steps || [], { ... });
 *
 * and `ComputerMCP.batch()` calls `this.act(list[i])` directly, which reads
 * `spec.action` — undefined on a model-shaped step — so `_perform()` falls
 * to its default case: `there is no action ""`. Single actions worked
 * because only they got the translation; batch never did.
 *
 * THE FIX: `tools/computermcp.js`'s `batch` case now translates every step
 * the same way the single-action path always has, and refuses — before
 * anything reaches the bridge — any step whose resolved action is empty or
 * not a real one, per §25's "reject malformed/empty steps before sending to
 * the bridge, fail-fast".
 */

const assert = require('assert');
const { test } = require('../helpers');

const cm = require('../../src/computermcp');
const computerTool = require('../../src/tools/computermcp');

function fakeConnected(batchImpl) {
  return {
    connected: true,
    authorized: true,
    batch: batchImpl,
  };
}

async function withFakeMcp(fake, fn) {
  const orig = cm.existing;
  cm.existing = () => fake;
  try { return await fn(); } finally { cm.existing = orig; }
}

module.exports = async function () {
  await test('BATCH: a step written the same way a single call is (`op`, not `action`) actually runs', async () => {
    let received = null;
    const fake = fakeConnected(async (steps) => {
      received = steps;
      return { verdict: cm.VERDICT.PASSED, why: `${steps.length} step(s), each observed`, steps: steps.map((s, i) => ({ step: i + 1, action: s.action, verdict: 'PASSED', why: 'ok' })) };
    });
    const result = await withFakeMcp(fake, () => computerTool.tools.computer.run(
      { op: 'batch', steps: [{ op: 'click', target: { name: 'OK' }, expect: { control: { name: 'OK' } } }] },
      { app: {} },
    ));
    assert.ok(!result.isError, `batch must not fail: ${result.output}`);
    assert.ok(!/there is no action ""/.test(result.output), 'the exact regression string must never reappear');
    assert.strictEqual(received[0].action, 'click', 'the model\'s `op` field must be translated to the internal `action` field, exactly as a single call is');
  });

  await test('BATCH: a step with no op/action at all is refused BEFORE reaching the bridge', async () => {
    let bridgeWasCalled = false;
    const fake = fakeConnected(async () => { bridgeWasCalled = true; return { verdict: cm.VERDICT.PASSED, why: '', steps: [] }; });
    const result = await withFakeMcp(fake, () => computerTool.tools.computer.run(
      { op: 'batch', steps: [{ target: { name: 'OK' } }] },
      { app: {} },
    ));
    assert.strictEqual(result.isError, true);
    assert.strictEqual(bridgeWasCalled, false, 'a malformed step must never reach the bridge — fail fast, per §25');
    assert.match(result.output, /empty|not a valid/i);
  });

  await test('BATCH: a step naming something that is not a real action is refused before the bridge, not sent as ""', async () => {
    let bridgeWasCalled = false;
    const fake = fakeConnected(async () => { bridgeWasCalled = true; return { verdict: cm.VERDICT.PASSED, why: '', steps: [] }; });
    const result = await withFakeMcp(fake, () => computerTool.tools.computer.run(
      { op: 'batch', steps: [{ op: 'teleport', target: {} }] },
      { app: {} },
    ));
    assert.strictEqual(result.isError, true);
    assert.strictEqual(bridgeWasCalled, false);
    assert.match(result.output, /teleport/);
  });

  await test('BATCH: an empty steps array is refused with a clear message, not a silent no-op', async () => {
    const fake = fakeConnected(async () => { throw new Error('must not be called'); });
    const result = await withFakeMcp(fake, () => computerTool.tools.computer.run({ op: 'batch', steps: [] }, { app: {} }));
    assert.strictEqual(result.isError, true);
    assert.match(result.output, /at least one step/);
  });

  await test('BATCH: multiple valid steps, mixed with one bad one, are ALL refused together (fail fast, not partial)', async () => {
    let bridgeWasCalled = false;
    const fake = fakeConnected(async () => { bridgeWasCalled = true; return { verdict: cm.VERDICT.PASSED, why: '', steps: [] }; });
    const result = await withFakeMcp(fake, () => computerTool.tools.computer.run(
      { op: 'batch', steps: [{ op: 'click', target: {} }, { op: '' }, { op: 'type', text: 'hi' }] },
      { app: {} },
    ));
    assert.strictEqual(result.isError, true);
    assert.strictEqual(bridgeWasCalled, false, 'one bad step in the batch must stop the whole thing before any of it runs');
  });

  await test('BATCH: PERFORM_ACTIONS matches _perform\'s real switch labels exactly — no drift', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../src/computermcp.js'), 'utf8');
    const body = src.slice(src.indexOf('async _perform('), src.indexOf('\n  }', src.indexOf('async _perform(')));
    const labels = [...body.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
    assert.ok(labels.length > 5, 'sanity: the switch body was actually found');
    assert.deepStrictEqual([...cm.PERFORM_ACTIONS].sort(), labels.sort());
  });

  await test('BATCH: `wait`/`open_app` (real top-level ops, not _perform actions) are refused as batch steps, not silently mis-run', async () => {
    let bridgeWasCalled = false;
    const fake = fakeConnected(async () => { bridgeWasCalled = true; return { verdict: cm.VERDICT.PASSED, why: '', steps: [] }; });
    const result = await withFakeMcp(fake, () => computerTool.tools.computer.run(
      { op: 'batch', steps: [{ op: 'wait', expect: { window: 'x' } }] },
      { app: {} },
    ));
    assert.strictEqual(result.isError, true);
    assert.strictEqual(bridgeWasCalled, false);
    assert.match(result.output, /wait/);
  });

  await test('BATCH: `batch` itself may never be nested as a step\'s op', async () => {
    let bridgeWasCalled = false;
    const fake = fakeConnected(async () => { bridgeWasCalled = true; return { verdict: cm.VERDICT.PASSED, why: '', steps: [] }; });
    const result = await withFakeMcp(fake, () => computerTool.tools.computer.run(
      { op: 'batch', steps: [{ op: 'batch', steps: [] }] },
      { app: {} },
    ));
    assert.strictEqual(result.isError, true);
    assert.strictEqual(bridgeWasCalled, false);
  });
};
