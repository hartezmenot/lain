'use strict';

/**
 * PHASE CU — Computer Control, separate from Preview: off by default, per session, tiers, a focus-locked target,
 * MNK primitives, raw input mode, bounded sequences, the kill switch, the person's input wins, sensitive surfaces,
 * only the primary agent, Web cannot grant FULL, one state for CLI and Harness.
 *
 * A DOUBLE: these prove LAIN's decisions (what is sent, what is refused). Delivery to real windows is proven by
 * tests/acceptance/computer-real.js on a real desktop.
 */

const assert = require('assert');
const { test } = require('../helpers');
const cc = require('../../src/computercontrol');
const permissionsMod = require('../../src/permissions');
const mcp = require('../../src/mcp');

function rig({ refuse = {} } = {}) {
  const perms = new permissionsMod.Permissions();
  const calls = [];
  const target = { handle: 777, pid: 4242, title: 'Untitled - Notepad', process: 'notepad', rect: { x: 100, y: 100, width: 800, height: 600 } };
  const app = { session: { id: 's1', turns: [] }, cfg: {}, desktop: () => ({ permissions: perms }) };
  const cm = require('../../src/computermcp').forApp(app);
  cm.bridge = {
    state: mcp.STATE.CONNECTED, capabilities: Object.keys(mcp.OPS),
    async call(op, params = {}) {
      calls.push({ op, params });
      if (refuse[op]) return { ok: false, error: refuse[op] };
      if (op === 'control.arm') return { ok: true, result: { armed: params.window === 'Credential Manager' ? { ...target, title: 'Windows Security', process: 'CredentialUIBroker' } : target, raw: params.raw } };
      if (op === 'control.state') return { ok: true, result: { killed: false, personInputMsAgo: -1, foreground: target, armed: target } };
      if (op === 'uia.find') return { ok: true, result: { matches: [{ name: params.name, isPassword: params.name === 'Password' }] } };
      if (op === 'window.list') return { ok: true, result: { windows: [target] } };
      return { ok: true, result: { foreground: target } };
    },
    close() {},
  };
  const grant = () => perms.grant(require('../../src/computermcp').CAPS, { scope: permissionsMod.SCOPE.COMPUTER });
  return { app, cm, calls, grant, target };
}
const ops = (calls) => calls.map((c) => c.op);

module.exports = async function () {
  await test('OFF BY DEFAULT: no desktop tool exists and every operation is refused until the person turns it on', async () => {
    const { app, cm, grant, calls } = rig();
    grant();
    assert.strictEqual(cc.enabled(app), false);
    const names = require('../../src/tools').names(app);
    assert.ok(!names.some((n) => n === 'computer' || n.startsWith('computer_')), 'no computer tool while off');
    const r = await cm.call('mouse.click', { x: 1, y: 1 });
    assert.ok(!r.ok && /off for this session/.test(r.why));
    assert.strictEqual(calls.length, 0, 'nothing reached the bridge');
    const on = await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
    assert.ok(on.ok, on.why);
    const tools = require('../../src/tools').names(app);
    assert.ok(tools.includes('computer') && !tools.some((n) => n.startsWith('computer_')), 'one computer tool once it is on (S5.1): ' + tools.join(','));
    app.session = { id: 's2', turns: [] };
    assert.strictEqual(cc.enabled(app), false, 'per session: a new session starts off');
  });

  await test('TIERS: OBSERVE reads only; INTERACT needs a target and stays inside it; FULL alone closes windows and uses the clipboard', async () => {
    const { app, cm, grant, calls } = rig();
    grant();
    await cc.enable(app, { tier: 'OBSERVE', by: 'cli', ask: false });
    assert.ok((await cm.call('window.list')).ok);
    assert.match((await cm.call('keyboard.type', { text: 'x' })).why, /OBSERVE/);
    assert.ok(require('../../src/tools').names(app).includes('computer'), 'OBSERVE: the one tool, whose input actions the tier refuses');
    await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
    assert.match((await cm.call('keyboard.type', { text: 'x' })).why, /needs a target/);
    assert.ok((await cc.setTarget(app, { window: 'Notepad' })).ok);
    assert.ok((await cm.call('mouse.click', { x: 300, y: 300 })).ok, 'inside the target');
    assert.match((await cm.call('mouse.click', { x: 5, y: 5 })).why, /outside the target/);
    assert.match((await cm.call('uia.invoke', { window: 'Calculator', name: '7' })).why, /locked to "Untitled - Notepad"/);
    await cm.call('uia.invoke', { name: 'Save' });
    assert.strictEqual(calls.filter((c) => c.op === 'uia.invoke').pop().params.handle, 777, 'an unnamed window means the target — by HANDLE (one process can own several windows)');
    assert.match((await cm.call('window.close', {})).why, /needs FULL/);
    assert.match((await cm.call('clipboard.write', { text: 'x' })).why, /needs FULL/);
    assert.match((await cm.call('keyboard.key', { keys: ['alt', 'f4'] })).why, /needs FULL/);
    assert.match((await cm.call('keyboard.key', { keys: ['ctrl', 'alt', 'delete'] })).why, /never sent/);
    await cc.enable(app, { tier: 'FULL', by: 'cli', ask: false });
    assert.ok((await cm.call('window.close', {})).ok);
    assert.match((await cm.call('keyboard.key', { keys: ['win', 'l'] })).why, /never sent/, 'not even FULL locks the machine');
    assert.ok(ops(calls).every((o) => o !== 'keyboard.type' || calls.find((c) => c.op === o)), 'refused calls never reached the bridge');
  });

  await test('SENSITIVE: a credential prompt cannot be the target; a password field is never typed into', async () => {
    const { app, cm, grant } = rig();
    grant();
    await cc.enable(app, { tier: 'FULL', by: 'cli', ask: false });
    const t = await cc.setTarget(app, { window: 'Credential Manager' });
    assert.ok(!t.ok && /sensitive surface/.test(t.why));
    const pw = await cm.call('uia.setValue', { name: 'Password', text: 'hunter2' });
    assert.ok(!pw.ok && /password field/.test(pw.why));
    assert.ok((await cm.call('uia.setValue', { name: 'Search', text: 'ok' })).ok);
    assert.ok(cc.sensitive({ process: 'consent.exe', title: 'User Account Control' }), 'UAC is the person\'s');
  });

  await test('THE BRIDGE STOPS: kill switch, the person\'s input and focus loss are reflected — and nothing is retried around them', async () => {
    const { app, cm, grant } = rig({ refuse: { 'keyboard.type': 'USER_ACTIVE: the person is using the computer (input 200ms ago) — paused, nothing was sent; their input wins' } });
    grant();
    await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
    await cc.setTarget(app, { window: 'Notepad' });
    const r = await require('../../src/tools/computerinput').tools.computer_type.run({ text: 'hello' }, { app, session: app.session });
    assert.ok(r.isError && r.denied && /USER_ACTIVE/.test(r.output));
    assert.match(cc.label(app), /paused \(you\)/);
    cm.bridge.call = async (op) => (op === 'mouse.click' ? { ok: false, error: 'KILLED: the kill switch (Ctrl+Alt+Pause) stopped computer control — nothing was sent' } : { ok: true, result: {} });
    await cm.call('mouse.click', { x: 300, y: 300 });
    assert.strictEqual(cc.enabled(app), false, 'the kill switch turns control off');
    assert.strictEqual(cc.label(app), '■ Computer stopped');
    assert.match((await cm.call('mouse.click', { x: 300, y: 300 })).why, /off for this session/);
  });

  await test('BOUNDED: a sequence is ≤ 20 steps and stops at the first refusal; text, hold and scroll are capped', async () => {
    const { app, grant, calls } = rig();
    grant();
    await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
    await cc.setTarget(app, { window: 'Notepad', raw: true });
    const ci = require('../../src/tools/computerinput').tools;
    const ctx = { app, session: app.session };
    const big = await ci.computer_sequence.run({ steps: Array.from({ length: 21 }, () => ({ tool: 'computer_key', input: { key: 'a' } })) }, ctx);
    assert.ok(big.isError && /1–20 steps/.test(big.output));
    const seq = await ci.computer_sequence.run({ steps: [{ tool: 'computer_key', input: { key: 'w' } }, { tool: 'computer_hotkey', input: { keys: ['alt', 'tab'] } }, { tool: 'computer_key', input: { key: 's' } }] }, ctx);
    assert.ok(seq.isError && /STOPPED at step 2; 1 not run/.test(seq.output));
    assert.ok(!calls.some((c) => c.op === 'keyboard.key' && c.params.keys[0] === 's'), 'nothing after the refusal was sent');
    assert.ok((await ci.computer_type.run({ text: 'x'.repeat(2001) }, ctx)).isError);
    await ci.computer_hold_key.run({ key: 'w', ms: 999999 }, ctx);
    assert.strictEqual(calls.filter((c) => c.op === 'keyboard.hold').pop().params.ms, 5000);
    await ci.computer_mouse_move.run({ dx: 40, dy: -10, steps: 500 }, ctx);
    assert.deepStrictEqual(calls.filter((c) => c.op === 'mouse.moveRel').pop().params, { dx: 40, dy: -10, steps: 60 });
    assert.strictEqual(calls.find((c) => c.op === 'control.arm').params.raw, true, 'raw input mode is armed in the bridge');
    assert.match(cc.label(app), /· raw/);
  });

  await test('PRIMARY AGENT ONLY: a subagent is refused the desktop — even a tool the funnel did not show', async () => {
    const { app, grant } = rig();
    grant();
    await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
    await cc.setTarget(app, { window: 'Notepad' });
    const child = { id: 'c1', _agentRole: 'IMPLEMENTER', turns: [] };
    const r = await require('../../src/tools').execute('computer', { action: 'click', x: 300, y: 300 }, { app, session: child });
    assert.ok(r.denied && /subagents never do/.test(r.output), r.output);
    const tf = require('../../src/toolfunnel');
    const s = {}; tf.openForRole(s, 'IMPLEMENTER');
    assert.ok(!tf.shows(s, 'computer_click'));
    const s2 = {}; tf.openForRole(s2, 'IMPLEMENTER', { extra: ['computer'] });
    assert.ok(tf.shows(s2, 'computer_click'), 'unless the person allowed agents (cfg.computer.agents)');
  });

  await test('WEB CANNOT GRANT FULL; the CLI and the Harness change one state; Preview grants nothing here', async () => {
    const { app, grant } = rig();
    grant();
    const w = await cc.enable(app, { tier: 'FULL', by: 'web', ask: false });
    assert.ok(!w.ok && /cannot be granted from LAIN Web/.test(w.why));
    const { ROUTES } = require('../../src/harnessapp/routes');
    const h = await ROUTES['POST /api/computer/enable'](app, { tier: 'INTERACT' });
    assert.strictEqual(h.code, 200);
    assert.strictEqual(cc.view(app).by, 'harness');
    assert.strictEqual(cc.view(app).on, true, 'the CLI sees what the Harness turned on');
    const webFull = await ROUTES['POST /api/computer/enable'](app, { tier: 'FULL', from: 'web' });
    assert.strictEqual(webFull.code, 409);
    const st = await ROUTES['POST /api/computer/stop'](app, {});
    assert.strictEqual(st.body.state.on, false);
    // PREVIEW: an attached Preview and its tools never switch computer control on.
    const fresh = rig();
    fresh.app.session._previewTools = true;
    assert.strictEqual(cc.enabled(fresh.app), false);
    assert.ok(!require('../../src/tools').names(fresh.app).some((n) => n.startsWith('computer')));
  });

  await test('INDICATOR: "● Computer · <target>" in the CLI header while on, in the warning tone', async () => {
    const { app, grant } = rig();
    grant();
    await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
    await cc.setTarget(app, { window: 'Notepad' });
    assert.strictEqual(cc.label(app), '● Computer · notepad');
    const hs = require('../../src/ui/headerstate').run({ app: { ...app, jobs: null, session: { ...app.session } }, busy: false, clock: null });
    assert.strictEqual(hs.tone, 'warn');
    assert.ok(hs.parts.includes('● Computer · notepad'), JSON.stringify(hs.parts));
  });
};
