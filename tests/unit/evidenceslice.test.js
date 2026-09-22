'use strict';

/**
 * EVIDENCE SLICE + NARROW WORKERS (evidenceslice.js, workers.js — 2026-09-23).
 *
 * The Computer ui_tree used to hand the model up to 20,000 chars and silently
 * drop everything past 200 rows. These pin: a focused slice of the relevant
 * controls with region and receipt; the raw tree recoverable and a re-read
 * counted as false narrowing; an honest ABSTAIN on no match; and the decision
 * cascade's invariants (deterministic first, one inference, abstain escalates,
 * cache, no worker calling a worker).
 */

const assert = require('assert');
const { test } = require('../helpers');
const ev = require('../../src/evidenceslice');
const workers = require('../../src/workers');
const { Session } = require('../../src/session');

/** A Settings-like window: 20 panes × 20 controls, one network combo box. */
function bigTree() {
  const panes = [];
  for (let p = 0; p < 20; p++) {
    const kids = [];
    for (let k = 0; k < 20; k++) kids.push({ controlType: k % 3 ? 'Text' : 'Button', name: `Option ${p}.${k}`, automationId: `opt_${p}_${k}`, rect: { x: 10, y: 10 + k * 20, width: 200, height: 18 }, enabled: true, children: [] });
    if (p === 13) {
      kids.push({ controlType: 'ComboBox', name: 'Network mode', automationId: 'NetworkMode', value: 'Auto', rect: { x: 1640, y: 88, width: 300, height: 24 }, enabled: true, children: [] });
      kids.push({ controlType: 'Button', name: 'Apply', automationId: 'ApplyButton', rect: { x: 2050, y: 990, width: 80, height: 30 }, enabled: true, children: [] });
    }
    panes.push({ controlType: 'Pane', name: p === 13 ? 'Network' : `Section ${p}`, rect: { x: 0, y: 0, width: 2400, height: 1200 }, enabled: true, children: kids });
  }
  return { controlType: 'Window', name: 'Settings', rect: { x: 0, y: 0, width: 2400, height: 1200 }, enabled: true, children: panes };
}

function fakeComputer(tree) {
  return { connected: true, authorized: true, async tree() { return { ok: true, result: { tree, nodes: ev.flatten(tree).length, truncated: false } }; } };
}

module.exports = async function () {
  await test('EVIDENCE SLICE: a focused ui_tree returns the relevant controls, their path, the region and a receipt — not 400 rows', async () => {
    const session = new Session({ cwd: process.cwd() });
    const app = { _computerMcp: fakeComputer(bigTree()) };
    const tool = require('../../src/tools/computermcp');
    const { run } = tool.tools.computer;
    const full = await run({ op: 'ui_tree', target: { window: 'Settings' } }, { app, session });
    const sliced = await run({ op: 'ui_tree', target: { window: 'Settings' }, focus: 'network mode dropdown' }, { app, session });
    assert.match(full.output, /more row\(s\) not shown — kept as receipt ev_[0-9a-f]{10}/, 'a long tree says what it held back and keeps it');
    assert.match(sliced.output, /EVIDENCE SLICE · ui_tree · focus "network mode dropdown"/);
    assert.match(sliced.output, /▸\s+ComboBox\s+"Network mode"\s+#NetworkMode/);
    assert.match(sliced.output, /\n\s+Pane\s+"Network"/, 'its ancestor path, so it can be aimed at — as PATH, not a match');
    assert.match(sliced.output, /region 1640,88 300×24/);
    assert.match(sliced.output, /confidence 0\.9/);
    assert.match(sliced.output, /receipt ev_[0-9a-f]{10}/);
    assert.ok(sliced.output.length * 10 < full.output.length + 20000, 'an order of magnitude smaller than the tree');
    const row = session.workerLedger.find((r) => r.contract === 'evidence_narrower');
    assert.ok(row && row.rawChars > row.outChars * 10, `compression measured: ${row && row.rawChars}→${row && row.outChars}`);
    const s = workers.summary(session).evidence_narrower;
    assert.ok(s.avoidedTokens > 1000, `flagship tokens avoided: ${s.avoidedTokens}`);
  });

  await test('EVIDENCE SLICE: RAW STAYS RECOVERABLE — expand returns the stored tree, and counts as a re-read (false narrowing)', async () => {
    const session = new Session({ cwd: process.cwd() });
    const app = { _computerMcp: fakeComputer(bigTree()) };
    const { run } = require('../../src/tools/computermcp').tools.computer;
    const sliced = await run({ op: 'ui_tree', target: { window: 'Settings' }, focus: 'apply' }, { app, session });
    const receipt = /receipt (ev_[0-9a-f]{10})/.exec(sliced.output)[1];
    const page = await run({ op: 'expand', receipt }, { app, session });
    assert.match(page.output, /^UI TREE · 423 node\(s\)/);
    assert.match(page.output, /expand \{receipt:"ev_[0-9a-f]{10}", offset:201\}/, 'paged, never dumped');
    const again = await run({ op: 'expand', receipt, query: 'network' }, { app, session });
    assert.match(again.output, /Network mode/, 'or re-sliced for another focus');
    const row = session.workerLedger.find((r) => r.receipt === receipt);
    assert.ok(row.reread > 0, 'the re-read is charged against the slice');
    const s = workers.summary(session).evidence_narrower;
    assert.strictEqual(s.rereadChars, row.reread);
  });

  await test('EVIDENCE SLICE: no match ABSTAINS — nothing is guessed', () => {
    const s = ev.slice(bigTree(), { focus: 'bluetooth pairing', receipt: 'ev_0123456789', totalChars: 1, describe: (n) => n.name });
    assert.strictEqual(s.abstain, true);
    assert.strictEqual(s.matched, 0);
    assert.match(s.text, /NOTHING matches that focus — nothing was guessed/);
  });

  await test('WORKERS: deterministic first; ONE inference only when uncertain; ABSTAIN escalates to the deterministic default; cached', async () => {
    workers._resetCache();
    let asked = 0;
    const infer = async () => { asked++; return 'EXPLAIN'; };
    const pk = { decision: 'kind?', facts: ['request: "x"'], candidates: ['CHAT', 'EXPLAIN', 'CHANGE'] };
    const certain = await workers.decide({ contract: 'decision_intent', fingerprint: 'a', packet: pk, deterministic: () => ({ label: 'CHAT', certain: true }), infer });
    assert.strictEqual(certain.by, 'deterministic'); assert.strictEqual(asked, 0, 'a certain rule never wakes a model');
    const tie = await workers.decide({ contract: 'decision_intent', fingerprint: 'b', packet: pk, deterministic: () => ({ label: 'CHANGE', certain: false }), infer });
    assert.strictEqual(tie.label, 'EXPLAIN'); assert.strictEqual(tie.by, 'JEV'); assert.strictEqual(asked, 1);
    const again = await workers.decide({ contract: 'decision_intent', fingerprint: 'b', packet: pk, deterministic: () => ({ label: 'CHANGE', certain: false }), infer });
    assert.strictEqual(again.cached, true); assert.strictEqual(asked, 1, 'same state, same question: never asked twice');
    const abstain = await workers.decide({ contract: 'decision_intent', fingerprint: 'c', packet: pk, deterministic: () => ({ label: 'CHANGE', certain: false }), infer: async () => 'ABSTAIN' });
    assert.deepStrictEqual([abstain.label, abstain.escalated], ['CHANGE', true]);
    const junk = await workers.decide({ contract: 'decision_intent', fingerprint: 'd', packet: pk, deterministic: () => ({ label: 'CHANGE', certain: false }), infer: async () => 'I think it is probably chat or maybe explain' });
    assert.strictEqual(junk.escalated, true, 'prose is not an answer');
    const boom = await workers.decide({ contract: 'decision_intent', fingerprint: 'e', packet: pk, deterministic: () => ({ label: 'CHANGE', certain: false }), infer: async () => { throw new Error('down'); } });
    assert.strictEqual(boom.escalated, true);
  });

  await test('WORKERS: the packet is small; no model is bound until the gate passed; no worker can reach another', () => {
    const text = workers.packet({ decision: 'd', facts: ['x'.repeat(5000)], candidates: ['A', 'B'] });
    assert.ok(text.length <= 900, 'a decision packet is a tiny projection, never context');
    assert.strictEqual(workers.binding({}, 'decision_intent'), null);
    assert.strictEqual(workers.binding({ workers: { decision_intent: { model: 'm', gate: { pass: false } } } }, 'decision_intent'), null, 'a failed gate binds nothing');
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/workers'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const forbidden of ['delegate', 'runTurn', 'plan_write', 'startPrimary', 'submit(', 'grant', 'execmode', 'profile.set']) {
      assert.ok(!src.includes(forbidden), `workers.js must not reach ${forbidden}`);
    }
    for (const c of Object.values(workers.CONTRACTS)) {
      assert.ok(c.owns.length && c.forbidden.length && c.input && c.output && c.escalate_when.length, `${c.id} is a complete contract`);
      assert.ok(c.forbidden.some((f) => /another worker/.test(f)) || c.id === 'geometry_solver', `${c.id} forbids calling another worker`);
    }
  });
};
