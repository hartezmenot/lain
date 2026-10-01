'use strict';

/**
 * ONE ENGINEERING SESSION, TWO VIEWS — the Core contracts behind Chat/Coding.
 *
 * Real Apps and real sessions on disk. What is pinned:
 *   · the eight public statuses, each read from the authority that owns it
 *   · a status change is an event, emitted once per change
 *   · Chat and Coding threads never share a wire; a terminal-only session is untouched
 *   · Chat and Coding choose models apart, and neither writes the process config
 *   · a Chat-view turn cannot run a mutating tool
 *   · project attachment never treats LAIN's own folder as a project
 *   · pins are explicit, bounded and current; browsing injects nothing
 *   · panel state is Core-held and survives a resume
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');
const sv = require('../../src/sessionviews');
const sessionstatus = require('../../src/sessionstatus');

function appAt(cwd) {
  const { App } = require('../../src/app');
  return new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd });
}

module.exports = async function () {
  // ------------------------------------------------------------ statuses --

  await test('STATUS: each of the eight words comes from its owner', () => {
    const app = appAt(tmpdir('status-'));
    const of = () => sessionstatus.of(app);
    assert.strictEqual(of().state, 'IDLE');

    app.abort = new AbortController();
    app._turnStartedAt = Date.now() - 5000;
    app._turnId = 't1';
    assert.strictEqual(of().state, 'RUNNING');
    assert.ok(of().elapsed >= 5000, 'elapsed comes from the turn-start stamp');
    assert.strictEqual(of().activeTurnId, 't1');

    app._phase = { phase: 'RETRYING', rateLimited: true };
    assert.strictEqual(of().state, 'WAITING');
    assert.match(of().summary, /rate limited/);

    app._phase = { phase: 'RUNNING_TOOL', tool: 'run_tests' };
    assert.strictEqual(of().state, 'VERIFYING');

    app._phase = null;
    app._harnessAsk = { id: 'q1', question: 'Which export style?' };
    assert.strictEqual(of().state, 'NEEDS_INPUT');
    assert.strictEqual(of().needsUserAction, true);
    app._harnessAsk = null;

    app.abort = null;
    app.dispatching = 1;
    assert.strictEqual(of().state, 'QUEUED');
    app.dispatching = 0;

    app.session.turns.push({ text: 'ok', stopReason: 'end' });
    assert.strictEqual(of().state, 'DONE');
    assert.strictEqual(of().elapsed, null, 'no clock at rest');
    app.session.turns.push({ text: '', providerFailure: { kind: 'timeout', message: 'no answer' } });
    assert.strictEqual(of().state, 'FAILED');
    assert.match(of().summary, /did not finish/);
  });

  await test('STATUS: a change is emitted once, for the session it belongs to', () => {
    const ipc = require('../../src/harnessapp/ipc');
    const sent = [];
    const real = ipc.emit;
    ipc.emit = (e) => { sent.push(e); return { ok: true }; };
    try {
      const app = appAt(tmpdir('status-ev-'));
      sessionstatus.touch(app);
      sessionstatus.touch(app);
      assert.strictEqual(sent.length, 1, 'IDLE twice is one event');
      app.abort = new AbortController();
      sessionstatus.touch(app, { phase: { phase: 'WAITING_MODEL' } });
      assert.strictEqual(sent.length, 2);
      assert.strictEqual(sent[1].type, 'session.status');
      assert.strictEqual(sent[1].session, app.session.id);
      assert.strictEqual(sent[1].status.state, 'RUNNING');
      app.abort = null;
      app.session.turns.push({ text: 'done' });
      sessionstatus.touch(app, { ended: true });
      assert.strictEqual(sent[2].status.state, 'DONE', 'the ending reaches the window without anyone opening the session');
    } finally { ipc.emit = real; }
  });

  // ------------------------------------------------------------- threads --

  await test('THREADS: a terminal-only session reaches the wire untouched', () => {
    const app = appAt(tmpdir('thr-'));
    app.session.messages.push({ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' });
    const wire = require('../../src/contextfit').buildWire(app.session, 'SYS');
    assert.strictEqual(wire.length, 3);
    assert.ok(app.session.messages.every((m) => m.thread === undefined), 'no tags written for a session that never used views');
  });

  await test('THREADS: the Coding wire never carries the Chat transcript, and Chat never carries Coding', () => {
    const app = appAt(tmpdir('thr2-'));
    const s = app.session;
    s.messages.push({ role: 'user', content: 'old engineering request' });
    sv.settle(s, 'coding');
    s.thread = 'chat';
    s.messages.push({ role: 'user', content: 'CHAT: plan the fix' }, { role: 'assistant', content: 'CHAT-REPLY: 1. a 2. b' });
    sv.settle(s, 'chat');
    s.thread = 'coding';
    s.messages.push({ role: 'user', content: 'implement it' });
    const codingWire = require('../../src/contextfit').buildWire(s, 'SYS').map((m) => m.content).join('\n');
    assert.ok(!/CHAT/.test(codingWire), `no chat text in the coding wire: ${codingWire}`);
    assert.match(codingWire, /old engineering request/);
    assert.match(codingWire, /implement it/);
    s.thread = 'chat';
    const chatWire = require('../../src/contextfit').buildWire(s, 'SYS').map((m) => m.content).join('\n');
    assert.ok(!/implement it|old engineering/.test(chatWire), 'and the chat wire carries no coding thread');
    assert.match(chatWire, /CHAT-REPLY/);
  });

  // -------------------------------------------------------------- models --

  await test('MODELS: Chat and Coding choose apart, and the process config is never written', () => {
    const app = appAt(tmpdir('mdl-'));
    app.cfg.model = 'process-default';
    const s = app.session;
    s.sourceSelections = { lain: 'chat-model' };
    sv.views(s).coding.model = 'coding-model';
    s.thread = 'chat';
    assert.strictEqual(sv.turnCfg(app, s).model, 'chat-model');
    s.thread = 'coding';
    assert.strictEqual(sv.turnCfg(app, s).model, 'coding-model');
    s.thread = null;
    assert.strictEqual(sv.turnCfg(app, s).model, 'coding-model', 'a terminal turn is a Coding turn');
    assert.strictEqual(app.cfg.model, 'process-default', 'nothing was written into the shared config');
    const opts = require('../../src/jobrunner').turnOptions(app, { session: s, signal: null });
    assert.strictEqual(opts.cfg.model, 'coding-model', 'the turn runs with the view model');
  });

  await test('CHAT VIEW: a mutating tool is refused, whatever model asked', async () => {
    const dir = tmpdir('chatro-');
    const app = appAt(dir);
    app.session.thread = 'chat';
    const tools = require('../../src/tools');
    const r = await tools.execute('write_file', { path: 'x.txt', content: 'nope' }, { app, cwd: dir });
    assert.strictEqual(r.isError, true);
    assert.match(r.output, /CHAT_VIEW_READ_ONLY/);
    assert.strictEqual(fs.existsSync(path.join(dir, 'x.txt')), false, 'nothing was written');
    app.session.thread = 'coding';
    const read = await tools.execute('read_file', { path: 'nothing-here.txt' }, { app, cwd: dir });
    assert.ok(!/CHAT_VIEW_READ_ONLY/.test(read.output), 'Coding is not affected by the Chat gate');
  });

  // ------------------------------------------------------------ projects --

  await test('PROJECT: Noema\'s own folder, the config home and the placeholder are never a project', () => {
    const app = appAt(ROOT);
    assert.strictEqual(sv.project(app.session).attached, false, 'the Noema checkout is not the project');
    app.session.cwd = sv.unattachedDir();
    assert.strictEqual(sv.project(app.session).attached, false);
    const real = tmpdir('proj-');
    app.session.cwd = real;
    assert.strictEqual(sv.project(app.session).attached, true, 'a legacy session in a real folder is attached');
    sv.views(app.session).project.attached = false;
    assert.strictEqual(sv.project(app.session).attached, false, 'explicit wins');
    assert.strictEqual(sv.checkRoot(ROOT).ok, false);
    assert.strictEqual(sv.checkRoot('relative/path').ok, false);
    assert.strictEqual(sv.checkRoot(real).ok, true);
  });

  await test('PROJECT FILES: with no project the tree is refused structurally, never Noema\'s folder', async () => {
    const routes = require('../../src/harnessapp/routes');
    const app = appAt(ROOT);
    const r = await routes.dispatch(app, 'POST', '/api/files/tree', { path: '' });
    assert.strictEqual(r.code, 409);
    assert.strictEqual(r.body.projectRequired, true);
    const turn = await routes.dispatch(app, 'POST', '/api/turn', { view: 'coding', text: 'change something' });
    assert.strictEqual(turn.code, 409);
    assert.strictEqual(turn.body.projectRequired, true, 'Coding needs an attached project');
  });

  await test('PROJECT: a new session inherits only an ATTACHED project, and attach validates', async () => {
    const routes = require('../../src/harnessapp/routes');
    const lainApp = appAt(ROOT);
    const blank = await routes.dispatch(lainApp, 'POST', '/api/session/new', { lane: 'engineering' });
    assert.strictEqual(blank.code, 200);
    assert.strictEqual(blank.body.project.attached, false, 'viewing Noema\'s folder gives a session with no project');
    const bad = await routes.dispatch(lainApp, 'POST', '/api/project/attach', { path: ROOT, session: blank.body.id });
    assert.strictEqual(bad.code, 400);
    const proj = tmpdir('attach-');
    fs.writeFileSync(path.join(proj, 'a.js'), 'function alpha() {}\n');
    const ok = await routes.dispatch(lainApp, 'POST', '/api/project/attach', { path: proj, session: blank.body.id });
    assert.strictEqual(ok.code, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.project.attached, true);
    const tree = await routes.dispatch(lainApp, 'POST', '/api/files/tree', { path: '', session: blank.body.id });
    assert.deepStrictEqual(tree.body.entries.map((e) => e.name), ['a.js'], 'Project Files is the attached project');
    const inherit = await routes.dispatch(lainApp, 'POST', '/api/session/new', { lane: 'engineering', session: blank.body.id });
    // `session` names the acting App, so the NEW session inherits from the attached one.
    assert.strictEqual(inherit.body.project.attached, true);
    for (const id of [blank.body.id, inherit.body.id]) require('../../src/sessionstore').forget(id);
  });

  // ---------------------------------------------------------------- pins --

  await test('PINS: browsing puts nothing in the prompt; a pin puts a bounded, current excerpt', async () => {
    const routes = require('../../src/harnessapp/routes');
    const proj = tmpdir('pins-');
    fs.writeFileSync(path.join(proj, 'big.js'), Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n'));
    const app = appAt(proj);
    await routes.dispatch(app, 'POST', '/api/files/open', { path: 'big.js' });
    assert.strictEqual(sv.views(app.session).panel.file, 'big.js', 'the open file is panel state');
    assert.strictEqual(sv.pinnedContext(app.session), '', 'opening is not pinning');
    const pinned = await routes.dispatch(app, 'POST', '/api/files/pin', { path: 'big.js', from: 10, to: 20 });
    assert.strictEqual(pinned.code, 200);
    const ctx = sv.pinnedContext(app.session);
    assert.match(ctx, /Pinned by the user/);
    assert.match(ctx, /line9 = 9/);
    assert.ok(!/line30 = 30/.test(ctx), 'only the pinned region');
    fs.writeFileSync(path.join(proj, 'big.js'), Array.from({ length: 400 }, (_, i) => `const edited${i} = ${i};`).join('\n'));
    assert.match(sv.pinnedContext(app.session), /edited9/, 'read at prompt time, not at pin time');
    const live = require('../../src/promptparts').of(app, {}).live;
    assert.match(live, /Pinned by the user/, 'and it reaches the prompt');
    await routes.dispatch(app, 'POST', '/api/files/unpin', { path: 'big.js' });
    assert.strictEqual(sv.pinnedContext(app.session), '');
    const outside = await routes.dispatch(app, 'POST', '/api/files/pin', { path: '../../etc/hosts' });
    assert.strictEqual(outside.code, 400, 'a pin cannot leave the project');
  });

  // --------------------------------------------------------------- panel --

  await test('PANEL: open, close and toggle are Core state; width and file survive; a resume keeps them', () => {
    const app = appAt(tmpdir('panel-'));
    const s = app.session;
    assert.strictEqual(sv.panel(s, { action: 'toggle', panel: 'PROJECT_FILES', width: 520 }).panel.open, 'PROJECT_FILES');
    sv.panel(s, { action: 'set', file: 'src/a.js' });
    assert.strictEqual(sv.panel(s, { action: 'toggle', panel: 'PROJECT_FILES' }).panel.open, 'NONE', 'toggling the open panel closes it');
    assert.strictEqual(sv.panel(s, { action: 'open', panel: 'WORKSHOP' }).panel.open, 'WORKSHOP');
    assert.strictEqual(sv.panel(s, { action: 'close' }).panel.open, 'NONE');
    assert.strictEqual(sv.views(s).panel.width, 520);
    assert.strictEqual(sv.views(s).panel.file, 'src/a.js');
    assert.strictEqual(sv.panel(s, { action: 'open', panel: 'NOPE' }).ok, false);
    assert.strictEqual(sv.panel(s, { action: 'set', width: 12 }).ok, false);
    sv.panel(s, { action: 'open', panel: 'CHANGES' });
    s.save();
    const back = require('../../src/session').Session.resume(s.id);
    assert.strictEqual(back.views.panel.open, 'CHANGES');
    assert.strictEqual(back.views.panel.file, 'src/a.js');
    require('../../src/sessionstore').forget(s.id);
  });
};
