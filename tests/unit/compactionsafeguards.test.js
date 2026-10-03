'use strict';

/**
 * THE COMPACTION SAFEGUARDS — read receipts that survive a fold, non-progress
 * by state equivalence, and the once-per-turn opening that stopped repeating.
 *
 * Measured origin: a saved session re-read `sed -n '294,314p' paper_broker.py`
 * about fifteen times (reads the ledger never knew about), and 104 of 245
 * assistant messages acknowledged a NEEDS_AUTH that had not been true for 79
 * turns, because the prompt restated it on every step.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const toolstep = require('../../src/toolstep');
const tools = require('../../src/tools');
const progress = require('../../src/progress');
const receipts = require('../../src/readreceipts');
const { Session } = require('../../src/session');
const { Task } = require('../../src/task');
const { Plan } = require('../../src/plan');
const { Lifecycle } = require('../../src/lifecycle');

/** Replace the tool door with a counter for shell reads; everything above it is real. */
function countingDoor(root) {
  const real = tools.execute;
  const calls = [];
  tools.execute = async (name, input, ctx) => {
    if (name === 'run_bash') {
      calls.push(input.command);
      const m = /sed -n '(\d+),(\d+)p' (\S+)/.exec(input.command);
      const lines = fs.readFileSync(path.join(root, m[3]), 'utf8').split('\n').slice(Number(m[1]) - 1, Number(m[2]));
      return { output: lines.join('\n'), exitCode: 0 };
    }
    return real(name, input, ctx);
  };
  return { calls, restore: () => { tools.execute = real; } };
}

function world() {
  const root = tmpdir('lain-receipt-');
  const body = Array.from({ length: 60 }, (_, i) => `def f${i}(): return ${i}`).join('\n');
  fs.writeFileSync(path.join(root, 'paper_broker.py'), body);
  const s = new Session({ cwd: root });
  s.task = new Task('fix the paper dropdown');
  s.plan = Plan.from({ objective: 'fix the paper dropdown', steps: [{ text: 'read the seeder gate' }, { text: 'patch the gate' }] })
    || new Plan('fix the paper dropdown', ['read the seeder gate', 'patch the gate']);
  s.lifecycle = new Lifecycle('fix the paper dropdown');
  return { root, s };
}

/** One call as turn.js makes it: the protocol goes into the conversation. */
async function call(s, id, name, input) {
  s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id, name, arguments: JSON.stringify(input) }] });
  const out = await toolstep.run({ id, name, input }, { session: s, evidence: s.evidence, toolCtx: { cwd: s.cwd, session: s } });
  s.messages.push({ role: 'tool', tool_call_id: id, content: String(out.result.output) });
  return out;
}

const READ = { command: "sed -n '10,20p' paper_broker.py" };

module.exports = async function () {
  await test('RECEIPT: a shell read produces a receipt naming file, range, fingerprint, task and step', async () => {
    const { root, s } = world();
    const door = countingDoor(root);
    try {
      await call(s, 'c1', 'run_bash', READ);
      const [r] = receipts.all(s.evidence);
      assert.ok(r, 'the ledger now knows about a read that was not read_file');
      assert.strictEqual(r.rel, 'paper_broker.py');
      assert.deepStrictEqual([r.from, r.to], [10, 20]);
      assert.ok(/^[0-9a-f]{16}$/.test(r.fp));
      assert.strictEqual(r.taskId, s.task.id);
      assert.strictEqual(r.planStep, 1);
      assert.strictEqual(receipts.status(r), receipts.STATUS.FRESH);
    } finally { door.restore(); }
  });

  await test('RECEIPT F: read → compact folds it away → continue → the unchanged source is NOT re-read', async () => {
    const { root, s } = world();
    const door = countingDoor(root);
    try {
      await call(s, 'c1', 'run_bash', READ);
      // Compaction removes the result from what the model is sent.
      const res = s.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
      res.content = '[elided to fit the context window] run_bash returned 400 chars.';
      res.elided = 'stub';
      const again = await call(s, 'c2', 'run_bash', READ);
      assert.strictEqual(door.calls.length, 1, 'the command was not run a second time');
      assert.strictEqual(again.gate.verdict, progress.VERDICT.RECHECK);
      assert.match(again.result.output, /served from the receipt, not re-run/);
      assert.ok(again.result.output.includes('def f9(): return 9'), 'and the model gets the bytes back');
    } finally { door.restore(); }
  });

  await test('RECEIPT: a repeat while the output is still in context is not re-run, is still SERVED, and still looks repeated to liveness', async () => {
    const { root, s } = world();
    const door = countingDoor(root);
    try {
      const first = await call(s, 'c1', 'run_bash', READ);
      const again = await call(s, 'c2', 'run_bash', READ);
      assert.strictEqual(door.calls.length, 1, 'the command was not run again');
      assert.strictEqual(again.gate.verdict, progress.VERDICT.REDUNDANT);
      assert.ok(again.result.output.includes('def f9(): return 9'), 'a read is always served — the evidence ledger\'s promise');
      assert.strictEqual(again.result.observedOutput, first.result.output,
        'the repetition detectors see the identical result, so the looping advisory still fires');
    } finally { door.restore(); }
  });

  await test('RECEIPT: when the source CHANGES, the receipt is stale and the read runs again', async () => {
    const { root, s } = world();
    const door = countingDoor(root);
    try {
      await call(s, 'c1', 'run_bash', READ);
      fs.appendFileSync(path.join(root, 'paper_broker.py'), '\n# edited in an editor\n');
      const again = await call(s, 'c2', 'run_bash', READ);
      assert.strictEqual(door.calls.length, 2, 'rereading changed source is legitimate');
      assert.strictEqual(again.gate.verdict, progress.VERDICT.DISCOVERY);
    } finally { door.restore(); }
  });

  await test('NON_PROGRESS E: the same discovery three times under identical state is classified and steered', async () => {
    const { root, s } = world();
    const door = countingDoor(root);
    try {
      const stub = (id) => { const m = s.messages.find((x) => x.tool_call_id === id); m.elided = 'stub'; m.content = '[elided]'; };
      await call(s, 'c1', 'run_bash', READ); stub('c1');
      const second = await call(s, 'c2', 'run_bash', READ); stub('c2');
      const third = await call(s, 'c3', 'run_bash', READ);
      assert.notStrictEqual(second.gate.verdict, progress.VERDICT.NON_PROGRESS, 'one recheck after a compaction is legitimate');
      assert.strictEqual(third.gate.verdict, progress.VERDICT.NON_PROGRESS);
      assert.match(third.result.output, /NON_PROGRESS/);
      assert.match(third.result.output, /Pending: plan step 1: read the seeder gate/, 'steered toward the pending action');
      assert.strictEqual(door.calls.length, 1, 'rediscovery was prevented — the shell ran once');
      assert.ok(!s.messages.some((m) => m.role === 'user' && /NON_PROGRESS/.test(m.content)), 'never written in the user\'s voice');
    } finally { door.restore(); }
  });

  await test('NON_PROGRESS: a write between the reads moves the state — the repeat is not non-progress', async () => {
    const { root, s } = world();
    const door = countingDoor(root);
    try {
      await call(s, 'c1', 'run_bash', READ);
      await call(s, 'c2', 'run_bash', READ);
      progress.after(s, 'write_file', { path: 'other.py' }, { mutated: [path.join(root, 'other.py')] }, null);
      const third = await call(s, 'c3', 'run_bash', READ);
      assert.notStrictEqual(third.gate.verdict, progress.VERDICT.NON_PROGRESS);
    } finally { door.restore(); }
  });

  await test('RECEIPT: receipts persist with the session (without outputs) and restore', async () => {
    const { root, s } = world();
    const door = countingDoor(root);
    try {
      await call(s, 'c1', 'run_bash', READ);
      const data = JSON.parse(JSON.stringify(s.toJSON()));
      assert.ok(Array.isArray(data.evidence.receipts) && data.evidence.receipts.length === 1);
      assert.ok(!('output' in data.evidence.receipts[0]), 'outputs are never written to the session file');
      const back = require('../../src/evidence').EvidenceLedger.from(data.evidence, root, s.id);
      assert.strictEqual(receipts.all(back).length, 1);
      assert.strictEqual(require('../../src/evidence').EvidenceLedger.from([], root).size(), 0, 'an old bare-array ledger still restores');
    } finally { door.restore(); }
  });

  await test('OPENING: NEEDS_AUTH clears once a provider answers, instead of being restated for 79 turns', () => {
    const life = new Lifecycle('x');
    life.noteAuthFailure('api.b.ai', '403 Forbidden');
    assert.strictEqual(life.state, 'NEEDS_AUTH');
    const turnclose = require('../../src/turnclose');
    const record = { toolCalls: 1, text: '', mutations: [], usage: { requests: 2 }, providerFailure: null };
    turnclose.accountTo(life, record);
    assert.strictEqual(life.state, 'ACTIVE');
  });
  await test('OPENING: the real turn loop sends the opening on step 0 and the continuing tail afterwards', async () => {
    const { runTurn } = require('../../src/turn');
    process.env.LAIN_PROVIDER = 'mock';
    process.env.LAIN_MOCK_SCRIPT = require('../helpers').writeScript(tmpdir('open-script-'), [
      { text: 'looking', tool_calls: [{ name: 'list_dir', input: { path: '.' } }] },
      { text: 'done' },
    ]);
    require('../../src/mockprovider')._reset();   // this test's own script, whatever ran before it
    try {
      const s = new Session({ cwd: tmpdir('open-cwd-') });
      const tails = [];
      const realProject = s.contextAuthority.project.bind(s.contextAuthority);
      s.contextAuthority.project = (pc, build, o) => { tails.push(o.live); return realProject(pc, build, o); };
      for await (const ev of runTurn(s, 'go', { cfg: {}, live: 'OPENING: previous turn did NOT finish', liveContinuing: 'CONTINUING' })) { void ev; }
      assert.strictEqual(tails[0], 'OPENING: previous turn did NOT finish');
      assert.ok(tails.slice(1).length && tails.slice(1).every((t) => t === 'CONTINUING'), JSON.stringify(tails));
    } finally {
      delete process.env.LAIN_PROVIDER;
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });
};
