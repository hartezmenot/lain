'use strict';

/**
 * SIMPLIFY S5.1 — thinking folds and never becomes the answer, the request trace says what was sent and where the time
 * went, one computer tool, Auto picks its target by handle, MCP in Plan only by the person's Read-only trust, diagrams
 * and tables keep their shape, and a profile never changes what is sent.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');
const mcp = require('../../src/mcp');
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function rig() {
  const permissionsMod = require('../../src/permissions');
  const perms = new permissionsMod.Permissions();
  const wins = [
    { handle: 777, pid: 4242, title: 'Untitled - Notepad', process: 'notepad', rect: { x: 100, y: 100, width: 800, height: 600 } },
    { handle: 888, pid: 5151, title: 'LAIN Harness', process: 'LainHost', rect: { x: 0, y: 0, width: 400, height: 300 } },
  ];
  const app = { session: { id: 's51', turns: [], cwd: tmpdir('s51-'), execMode: 'AUTO' }, cfg: { trustedPaths: [] }, desktop: () => ({ permissions: perms }), ui: { enabled: false }, render: { notice() {} } };
  app.cfg.trustedPaths = [{ path: app.session.cwd, level: 'TRUSTED' }];
  const cm = require('../../src/computermcp').forApp(app);
  cm.bridge = {
    state: mcp.STATE.CONNECTED, capabilities: Object.keys(mcp.OPS),
    async call(op, params = {}) {
      if (op === 'control.arm') return { ok: true, result: { armed: wins.find((w) => w.handle === params.handle) || wins[0] } };
      if (op === 'window.list') return { ok: true, result: { windows: wins } };
      return { ok: true, result: { foreground: wins[0] } };
    },
    close() {},
  };
  perms.grant(require('../../src/computermcp').CAPS, { scope: permissionsMod.SCOPE.COMPUTER });
  return { app };
}

module.exports = async function () {
  await test('F1/F2: a thought folds to one line; an interrupted think is `Thinking (interrupted)`; reasoning-only is said as such', () => {
    const th = require('../../src/ui/thoughtrow');
    assert.strictEqual(th.label({ ms: 143000, tokens: 8195 }), '▸ Thought for 2m 23s · 8.2k tokens');
    assert.strictEqual(th.label({ ms: 4000, chars: 3036, interrupted: true }), '▸ Thinking (interrupted) · ~759 tokens');
    const conv = require('../../src/ui/conversation');
    const draw = (turn) => conv.activity({ session: { turns: [turn], cwd: '.' }, width: 100 }).map(strip).join('\n');
    const interrupted = draw({ turnId: 't1', userInput: 'q', text: '', actions: [], narration: [], reasoning: 'REASONING_SECRET the person wants', stopReason: 'aborted', thinking: [{ step: 1, ms: 3000, chars: 3036, tokens: null, interrupted: true, text: 'REASONING_SECRET the person wants' }] });
    assert.match(interrupted, /▸ Thinking \(interrupted\) · ~759 tokens/);
    assert.ok(!/REASONING_SECRET/.test(interrupted), `an interrupted think is never the answer:\n${interrupted}`);
    const only = draw({ turnId: 't2', userInput: 'q', text: '', actions: [], narration: [], reasoning: 'ROUTE_QUIRK all my words', stopReason: 'end', thinking: [{ step: 1, ms: 1000, chars: 24, tokens: 6, text: 'ROUTE_QUIRK all my words' }] });
    assert.match(only, /The model returned only its reasoning:[\s\S]*ROUTE_QUIRK/);
  });

  await test('F6: the trace records the effort put on the wire, time to first byte, reasoning and text time, reasoning tokens', () => {
    const t = require('../../src/reqtiming');
    const timing = t.start();
    timing.wireOut.effort = 'low';
    t.see(timing, { type: 'reasoning', chunk: 'x' });
    t.see(timing, { type: 'text', chunk: 'y' });
    const rec = { protocol: 'chat' };
    t.stamp(timing, rec, { reasoningTokens: 42 });
    assert.strictEqual(rec.effort, 'low');
    for (const k of ['firstByteMs', 'reasoningMs', 'textMs']) assert.ok(Number.isFinite(rec[k]), k);
    assert.strictEqual(rec.reasoningTokens, 42);
    const runtime = { protocol: 'runtime', effort: 'xhigh' };
    t.stamp(t.start(), runtime, null);
    assert.strictEqual(runtime.effort, 'xhigh', 'a runtime\'s effort (a CLI flag) is kept');
    assert.ok(require('../../src/reqtrace').forSession && true);
  });

  await test('F4: one `computer` tool under 2.5 KB, every action through the same guarded input; Auto picks by exact handle, never LAIN\'s own window', async () => {
    const one = require('../../src/tools/computerone');
    assert.ok(JSON.stringify(one.tools.computer.schema).length < 2500);
    const { app } = rig();
    const cc = require('../../src/computercontrol');
    await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
    const ctx = { app, session: app.session };
    const own = await one.tools.computer.run({ action: 'click', x: 10, y: 10, window: '888' }, ctx);
    assert.ok(own.isError && /LAIN's own window/.test(own.output), own.output);
    const picked = await one.tools.computer.run({ action: 'click', x: 300, y: 300, window: '777' }, ctx);
    assert.ok(!picked.isError, picked.output);
    assert.strictEqual(cc.view(app).target.handle, 777, 'the exact handle is the target, and the focus lock applies to it');
    app.session.execMode = 'ACCEPT_EDITS';
    await cc.disable(app); await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
    const notAuto = await one.tools.computer.run({ action: 'click', x: 300, y: 300, window: '777' }, ctx);
    assert.ok(notAuto.isError && /needs a target/.test(notAuto.output), 'outside Auto the person picks the target');
  });

  await test('A3: an MCP tool runs in Plan mode only when the person set that server Read-only', async () => {
    const execmode = require('../../src/execmode');
    const { Session } = require('../../src/session');
    const s = new Session({ cwd: tmpdir('s51-mcp-') });
    execmode.set(s, 'PLAN');
    const app = { session: s, cfg: { trustedPaths: [{ path: s.cwd, level: 'TRUSTED' }], integrations: { mcp: { docs: { name: 'Docs', trust: 'READ_ONLY' }, web: { name: 'Web', trust: 'ASK' } } } }, ui: { enabled: false } };
    const integ = require('../../src/integrations');
    const real = integ.store;
    integ.store = (a) => (a === app ? app.cfg.integrations : real(a));
    try {
      assert.strictEqual((await execmode.gate({ app, session: s }, 'call_tool', { mutates: true }, { name: 'docs/search' })).ok, true);
      assert.strictEqual((await execmode.gate({ app, session: s }, 'call_tool', { mutates: true }, { name: 'web/post' })).output, execmode.PLAN_REFUSAL);
    } finally { integ.store = real; }
  });

  await test('D1/D2: a diagram, tree or ASCII row keeps its spacing on either path; a pipe table is a grid, stacked when narrow', () => {
    const md = require('../../src/ui/markdown');
    const feed = require('../../src/ui/feed');
    const diagram = ['│  Input   │ ──▶ │  Router  │', '│   ├── status.js', '+-------+      +--------+'];
    assert.deepStrictEqual(md.render(['- a', ...diagram], 80).map(strip).slice(1), diagram);
    const e = [];
    feed.pushModel(e, diagram.join('\n'));
    assert.deepStrictEqual(feed.renderFeed(e, 80).map(strip).filter(Boolean), diagram);
    assert.deepStrictEqual(require('../../src/ui/views').wrap('│   ├── status.js', 110), ['│   ├── status.js'], 'a line that fits keeps every space');
    const t = ['| Layer | Owner |', '|---|---|', '| CLI | src/ui |'];
    assert.deepStrictEqual(md.render(t, 80).map(strip), ['Layer │ Owner ', '──────┼───────', 'CLI   │ src/ui']);
    const wide = ['| Layer | Owner |', '|---|---|', '| CLI | src/ui/conversation.js |'];
    assert.deepStrictEqual(md.render(wide, 20).map(strip), ['Layer  CLI', 'Owner  src/ui/conver', '       sation.js'], 'too narrow for a grid: key: value rows, a long value folded under its key');
  });

  await test('F5: toggling the profile leaves the tools array and the system prompt byte-identical', async () => {
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('s51-prof-') });
    const profile = require('../../src/profile');
    const dialect = require('../../src/discipline/dialect');
    const tools = require('../../src/tools');
    const sp = require('../../src/simpleprompt');
    const snap = () => JSON.stringify([dialect.forTurn(app.session, tools.schemas(app, { turn: true, session: app.session }), 'glm-5.3', app.cfg), sp.of(app, {}).stable]);
    const base = snap();
    for (const p of ['FAST', 'ECO', 'NORMAL']) { profile.set(app.session, p); assert.strictEqual(snap(), base, `${p}: same bytes`); }
  });
};
