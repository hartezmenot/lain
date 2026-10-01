'use strict';

/**
 * THE SESSION JOURNEY — one house, one path through it.
 *
 * What each test pins was a real gap in the window:
 *   - a question in Chat retired the Coding Agent's task (the aside rule);
 *   - the BOT silently turned into Coding Agent output (Move to Agent?);
 *   - nobody could say who changed which lines (the provenance ledger);
 *   - the Agent started every change by re-surveying the project (focus packet);
 *   - the BOT navigated by prose, not by the application's own doors;
 *   - a website sign-in ran inside an automation-controlled browser;
 *   - an identity-only OAuth could be mistaken for model access.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');
const isolation = require('../harness/isolation');

const { Session } = require('../../src/session');
const journey = require('../../src/journey');
const T = require('../../src/task');
const ledger = require('../../src/editledger');
const focuspacket = require('../../src/focuspacket');
const house = require('../../src/house');
const botroute = require('../../src/harnessapp/botroute');
const routes = require('../../src/harnessapp/routes');

function project() {
  const root = isolation.tmp('journey-proj-');
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  w('package.json', '{"name":"demo"}\n');
  w('src/ui/button.js', [
    "'use strict';",
    '// fixButton is the toolbar fix action',
    'const fixButton = { label: "Fix", key: "fix_button" };',
    'function render() { return fixButton.label; }',
    'module.exports = { fixButton, render };',
    '',
  ].join('\n'));
  w('src/ui/actions.js', "const { fixButton } = require('./button');\nfunction press() { return fixButton.key; }\nmodule.exports = { press };\n");
  w('src/backend/ui-actions.js', "const { fixButton } = require('../ui/button');\nconst ROUTE = '/api/fix_button';\nmodule.exports = { handler: () => fixButton, ROUTE };\n");
  w('tests/button.test.js', "const { fixButton } = require('../src/ui/button');\nif (!fixButton) throw new Error('missing');\n");
  w('src/unrelated.js', 'const other = 1;\nmodule.exports = other;\n');
  w('src/styles/search.css', '.search-bar {\n  position: relative;\n  top: 12px;\n  margin-top: 4px;\n}\n');
  w('src/search.jsx', 'export function Search() {\n  return <input className="search-bar" />;\n}\n');
  return root;
}

function sessionFor(root) {
  const s = new Session({ id: `journey-${crypto.randomBytes(3).toString('hex')}`, cwd: root });
  require('../../src/sessionviews').views(s).project = { attached: true, attachedAt: new Date().toISOString() };
  return s;
}

module.exports = async function () {
  const root = project();

  await test('JOURNEY: the path records transitions once, with the task id, and survives save/restore', () => {
    const s = sessionFor(root);
    s.task = new T.Task('fix the provider retry bug');
    const app = { session: s };
    journey.surface(app, { surface: 'chat' });
    journey.surface(app, { surface: 'chat' });
    journey.surface(app, { surface: 'ide', pane: 'bot' });
    journey.surface(app, { surface: 'ide', pane: 'agent' });
    const kinds = s.journey.path.map((e) => `${e.kind}:${e.surface || ''}:${e.pane || ''}`);
    assert.deepStrictEqual(kinds, ['surface:chat:', 'surface:ide:bot', 'surface:ide:agent'], 'a repeat is not a step');
    assert.ok(s.journey.path.every((e) => e.taskId === s.task.id));
    assert.ok(!journey.surface(app, { surface: 'focus' }).ok, 'there is no /focus surface besides the IDE');
    const back = new Session({ id: s.id, cwd: root });
    journey.restore(back, JSON.parse(JSON.stringify(s.toJSON())));
    assert.strictEqual(back.journey.path.length, 3, 'the path is part of the session file');
  });

  await test('JOURNEY: one task across Chat → Agent → IDE — a read-only aside does not replace it', () => {
    const s = sessionFor(root);
    const app = { session: s, cfg: { model: 'mock-coder', connection: 'mock' }, ui: { enabled: false }, projectIsEmpty: () => false, checkpoints: null };
    const { identify } = require('../../src/identify');
    s._agentVia = { via: 'chat', reason: 'implementation work from Chat' };
    identify(app, 'Fix the provider retry bug in src/provider.js', false, null);
    s._agentVia = null;
    const id = s.task.id;
    assert.ok(s.task.agentic && s.task.origin === 'chat', 'the Agent carries it, and it began in Chat');
    journey.agentEnded(app);
    s._asideTurn = true;
    const v = identify(app, 'How much of my ChatGPT account is available?', false, 'EXPLAIN');
    s._asideTurn = false;
    assert.ok(v.aside, 'a question while the Agent carries work is an aside');
    assert.strictEqual(s.task.id, id, 'the same task is still in hand');
    identify(app, 'continue', false, null);
    assert.strictEqual(s.task.id, id, '"continue" continues it — no duplicate task');
    assert.ok(!s.task.steers.some((x) => /ChatGPT account/.test(x.text)), 'the aside was not written into the task as a correction');
    // Without the aside flag (a turn in the Agent's own thread) the same kind of
    // sentence steers the task — task.js's rule, unchanged.
    identify(app, 'also keep the old retry count', false, null);
    assert.strictEqual(s.task.id, id);
    assert.ok(s.task.steers.some((x) => /old retry count/.test(x.text)));
    assert.strictEqual(journey.reseat(app), false, 'nothing to re-seat while the Agent task is in hand');
    s.task = new T.Task('what does this do?');
    assert.ok(journey.reseat(app), 'the Agent task is re-seated if anything else ever replaced it');
    assert.strictEqual(s.task.id, id);
    const view = journey.project(app);
    assert.strictEqual(view.agentTask.id, id);
    assert.strictEqual(view.ids.session, s.id);
    assert.ok(view.ids.project && view.ids.project.startsWith('P'));
  });

  await test('JOURNEY: work the Agent takes up after a BOT question is a new task, not a steer of the question', () => {
    const s = sessionFor(root);
    const app = { session: s, cfg: { model: 'mock-coder', connection: 'mock' }, ui: { enabled: false }, projectIsEmpty: () => false, checkpoints: null };
    const { identify } = require('../../src/identify');
    identify(app, 'what does this function do?', false, 'EXPLAIN');
    const q = s.task.id;
    s._agentVia = { via: 'ide' };
    identify(app, 'Rename fixButton to ButtonFix everywhere.', false, null);
    s._agentVia = null;
    assert.notStrictEqual(s.task.id, q, 'a new task');
    assert.ok(/Rename fixButton/.test(s.task.objective) && s.task.agentic);
    s._agentVia = { via: 'ide' };
    identify(app, 'continue', false, null);
    s._agentVia = null;
    assert.ok(/Rename fixButton/.test(s.task.objective), 'continue still continues it');
  });

  await test('BOT → AGENT: code changes are PROPOSED in the BOT tab; questions answered; the AGENT tab and Chat go straight', () => {
    const s = sessionFor(root);
    const app = { session: s };
    assert.strictEqual(botroute.decide(app, 'What does this function do?', { from: 'ide' }).role, 'bot');
    assert.strictEqual(botroute.decide(app, 'Why is this error happening?', { from: 'ide' }).role, 'bot');
    assert.strictEqual(botroute.decide(app, 'Rename fixButton to ButtonFix everywhere.', { from: 'ide' }).role, 'propose');
    assert.strictEqual(botroute.decide(app, 'Implement this API.', { from: 'ide' }).role, 'propose');
    assert.strictEqual(botroute.decide(app, 'Rename fixButton to ButtonFix everywhere.', { from: 'ide', pane: 'agent' }).role, 'agent');
    assert.strictEqual(botroute.decide(app, 'Rename fixButton to ButtonFix everywhere.', { from: 'chat', via: 'chat' }).role, 'agent');
    // Walking the house is the BOT's, never a proposal for the Agent.
    for (const t of ['open the MCP settings', 'Open router.ts.', "open yesterday's session", 'Use Opus for the Coding Agent.', 'Add Telegram.', 'Go back to the code.']) {
      assert.strictEqual(botroute.decide(app, t, { from: 'ide' }).role, 'bot', t);
    }
    assert.strictEqual(botroute.decide(app, 'Open router.ts and rename route to dispatch', { from: 'ide' }).role, 'propose', 'opening AND changing is a change');
    // Planning is answered, not implemented — in Chat and in the BOT tab.
    for (const t of ['Plan how to fix Toradb stalled downloads', 'Investigate why login fails', "Let's design the cache", 'Make a plan for the migration']) {
      assert.strictEqual(botroute.decide(app, t, { from: 'chat', via: 'chat' }).role, 'bot', t);
      assert.strictEqual(botroute.decide(app, t, { from: 'ide' }).role, 'bot', t);
    }
  });

  await test('BOT → AGENT: a proposal runs nothing until answered, is single-use, and accepting starts the Agent on the same session', async () => {
    const s = sessionFor(root);
    const ran = [];
    const app = { session: s, handle: async (text, o) => { ran.push({ text, mode: o.forceMode, bot: s._botTurn, aside: s._asideTurn }); }, checkpoints: null };
    const r = botroute.start(app, 'Rename fixButton to ButtonFix everywhere.', { role: 'propose', reason: 'changes code' });
    assert.strictEqual(r.body.route, 'propose');
    assert.strictEqual(ran.length, 0, 'no model call for a proposal');
    const p = journey.project(app).proposal;
    assert.ok(p && p.text.includes('ButtonFix'));
    assert.strictEqual(botroute.answer(app, { id: 'wrong', accept: true }).code, 409, 'an unknown id takes nothing');
    const ok = botroute.answer(app, { id: p.id, accept: true });
    assert.ok(ok.body.ok && ok.body.route === 'agent', JSON.stringify(ok.body));
    // The focus research (deterministic, before the model) runs first.
    for (let i = 0; i < 100 && !ran.length; i++) await new Promise((res) => setTimeout(res, 30));
    assert.strictEqual(ran.length, 1);
    assert.strictEqual(ran[0].bot, false, 'the Agent runs, not the BOT');
    assert.strictEqual(botroute.answer(app, { id: p.id, accept: true }).code, 409, 'single use');
    assert.ok(s.journey.path.some((e) => e.kind === 'moved'));
  });

  await test('BOT stays read-only: a mutating tool on a BOT turn is refused by the gate', async () => {
    const tools = require('../../src/tools');
    const s = sessionFor(root);
    s._botTurn = true;
    const out = await tools.execute('write_file', { path: 'x.txt', content: 'no' }, { app: { session: s }, session: s, cwd: root });
    assert.ok(out.isError && /BOT_READ_ONLY/.test(out.output), JSON.stringify(out).slice(0, 200));
    assert.ok(!fs.existsSync(path.join(root, 'x.txt')));
  });

  await test('PROVENANCE: USER and AGENT lines are told apart, shift with later edits, and survive a restart', () => {
    ledger.reset();
    const rel = 'src/ui/button.js';
    const abs = path.join(root, rel);
    const v0 = fs.readFileSync(abs, 'utf8');
    const v1 = v0.replace('function render() { return fixButton.label; }', 'function render() {\n  return fixButton.label.trim();\n}');
    ledger.record(root, { source: 'USER', path: abs, before: v0, after: v1, sessionId: 's1' });
    const v2 = `// generated header\n// second line\n${v1}`;
    ledger.record(root, { source: 'AGENT', path: abs, before: v1, after: v2, sessionId: 's1', taskId: 'T1' });
    ledger.reset();   // a restart: only the files on disk remain
    const r = ledger.regions(root, rel);
    const user = r.regions.find((g) => g.source === 'USER');
    const agent = r.regions.find((g) => g.source === 'AGENT');
    assert.ok(user && agent, JSON.stringify(r));
    assert.deepStrictEqual([user.startLine, user.endLine], [6, 8], 'the person\'s lines moved down by the two the Agent added above');
    assert.deepStrictEqual([agent.startLine, agent.endLine], [1, 2]);
    assert.ok(/USER/.test(ledger.summary(root, { source: 'USER' }).text));
    assert.ok(/AGENT/.test(ledger.summary(root, { source: 'Noema' }).text));
    assert.ok(!/AGENT/.test(ledger.summary(root, { source: 'USER' }).text), '"what did I change" is only mine');
    const recent = ledger.recentUserEdits(root, [rel]);
    assert.strictEqual(recent.length, 1);
    // A change LAIN did not make is EXTERNAL, lines unknown.
    const ext = ledger.observe(root, abs, `${v2}// someone else\n`);
    assert.ok(ext && ext.source === 'EXTERNAL' && ext.linesUnknown);
    assert.ok(ledger.regions(root, rel).approximate);
    assert.strictEqual(ledger.record(root, { path: abs, before: 'a', after: 'b' }).source, 'UNKNOWN', 'a caller that cannot say is UNKNOWN, never guessed');
    fs.writeFileSync(abs, v0);
  });

  await test('PROVENANCE: an editor save is recorded as USER; a formatter-only save as FORMATTER', async () => {
    ledger.reset();
    const s = sessionFor(root);
    const app = { session: s, ui: null, checkpoints: null, events: null };
    const req = async (p, body) => (await routes.dispatch(app, 'POST', p, body)).body;
    const o = await req('/api/files/open', { path: 'src/unrelated.js' });
    const sv = await req('/api/files/save', { path: 'src/unrelated.js', body: `${o.body}// mine\n`, hash: o.hash });
    assert.ok(sv.ok, sv.why);
    const o2 = await req('/api/files/open', { path: 'src/unrelated.js' });
    await req('/api/files/save', { path: 'src/unrelated.js', body: o2.body.replace('const other = 1;', 'const other = 1;  '), hash: o2.hash, origin: 'FORMATTER' });
    const h = ledger.entries(root, { rel: 'src/unrelated.js' });
    assert.deepStrictEqual(h.slice(-2).map((e) => e.source), ['USER', 'FORMATTER']);
    assert.ok(s.journey.path.some((e) => e.kind === 'user.edit' && e.file === 'src/unrelated.js'), 'one journey note, from the transaction');
  });

  await test('PROVENANCE: a kept Noema write through the mutation transaction is recorded as AGENT with its task', async () => {
    ledger.reset();
    const s = sessionFor(root);
    s.task = new T.Task('touch a file');
    const abs = path.join(root, 'src', 'agentfile.js');
    fs.writeFileSync(abs, 'a\n');
    const mutation = require('../../src/mutation');
    const r = await mutation.transact({
      name: 'write_file', input: { path: abs, content: 'a\nb\n' }, ctx: { session: s, cwd: root, checkpoints: null },
      targets: [abs], apply: async () => { fs.writeFileSync(abs, 'a\nb\n'); return { output: 'ok', mutated: [abs] }; },
    });
    assert.ok(r && !r.isError, JSON.stringify(r).slice(0, 300));
    const e = ledger.entries(root, { rel: 'src/agentfile.js' }).pop();
    assert.ok(e && e.source === 'AGENT' && e.taskId === s.task.id, JSON.stringify(e));
  });

  await test('FOCUS PACKET: consumes the ONE canonical Selection — references, not the repository; wire names preserved', async () => {
    ledger.reset();
    const abs = path.join(root, 'src/ui/button.js');
    const before = fs.readFileSync(abs, 'utf8');
    ledger.record(root, { source: 'USER', path: abs, before: before.replace('render()', 'renderOld()'), after: before });
    const s = sessionFor(root);
    const app = { session: s };
    // The editor's report, recorded the one way: idecontext holds the facts,
    // harnesscontext derives the Selection from them.
    require('../../src/idecontext').record(s, { file: 'src/ui/button.js', selection: { text: 'fixButton', startLine: 3, endLine: 3 }, cursor: { line: 3, col: 7 }, tabs: [] });
    require('../../src/harnesscontext').fromIde(app, s, { file: 'src/ui/button.js', selection: { text: 'fixButton', startLine: 3, endLine: 3 } });
    const sel = require('../../src/harnesscontext').selection(app, s);
    assert.ok(sel && sel.symbol && sel.symbol.name === 'fixButton', JSON.stringify(sel && sel.symbol));
    assert.strictEqual(require('../../src/harnesscontext').selection(app, s), sel, 'resolved once: the same object until the selection or the project changes');
    const pk = await focuspacket.build(app, s, { task: 'Change this variable from fixButton to ButtonFix including whatever relies on it.' });
    assert.ok(pk.intent.rename && pk.intent.symbol === 'fixButton' && pk.intent.to === 'ButtonFix', JSON.stringify(pk.intent));
    assert.ok(pk.metrics.fromCanonicalSelection && pk.metrics.selection.id === sel.id, 'the packet names the canonical selection it consumed');
    assert.ok(pk.text.includes(`SELECTION ${sel.id}`));
    for (const f of ['src/ui/button.js', 'src/ui/actions.js', 'src/backend/ui-actions.js', 'tests/button.test.js']) assert.ok(pk.relevant.includes(f), `${f} is relevant`);
    assert.ok(!pk.relevant.includes('src/unrelated.js'), 'an unrelated file is not sent');
    assert.ok(/preserve serialized\/wire names "fix_button"/.test(pk.text), pk.text);
    assert.ok(/STRINGS AND COMMENTS/.test(pk.text), 'the comment naming it is listed, not renamed');
    assert.ok(/PROVENANCE/.test(pk.text) && /by hand/.test(pk.text), 'the person\'s recent edit is carried');
    assert.ok(pk.metrics.filesSelected < pk.metrics.projectFiles, JSON.stringify(pk.metrics));
    assert.ok(!/const other = 1/.test(pk.text), 'no file bodies travel in the packet');
    const hctx = require('../../src/harnesscontext').packet(app, s);
    assert.ok(hctx.includes(`selection ${sel.id}`) && /selected text/.test(hctx), 'the Harness packet renders the same Selection');
    assert.ok(!/Selected text/.test(require('../../src/idecontext').section(app, Object.assign(s, { _ideTurn: true }))), 'the IDE section no longer renders a second copy');
  });

  await test('FOCUS PACKET: a layout request uses the GUG binding of the selected element, with its current value', async () => {
    const s = sessionFor(root);
    const app = { session: s };
    const gug = require('../../src/gug');
    const g = gug.bind(gug.fromDom([{ tag: 'input', classes: 'search-bar', selector: 'input.search-bar', rect: { x: 0, y: 20, w: 200, h: 30 }, parent: -1 }], { root }), root);
    gug.put(app, root, g);
    require('../../src/harnesscontext').workshopSelect(app, s, { selector: 'input.search-bar', tag: 'input', rect: { x: 0, y: 20, w: 200, h: 30 } }, g);
    const pk = await focuspacket.build(app, s, { task: 'Move this search bar a little lower.' });
    assert.ok(pk.intent.geometry, JSON.stringify(pk.intent));
    assert.ok(/VISUAL TARGET/.test(pk.text) && /style owner: \S*search\.css:\d+ \.search-bar/.test(pk.text) && /top: 12px/.test(pk.text), pk.text);
    const none = await focuspacket.build({ session: sessionFor(root) }, sessionFor(root), { task: 'Move this search bar a little lower.' });
    assert.ok(/pick it in the preview/.test(none.text), 'without a bound element nothing is guessed from class names');
  });

  await test('HOUSE: BOT navigation goes through named doors; arguments are checked against the project', async () => {
    const s = sessionFor(root);
    const app = { session: s };
    const ids = house.list().map((d) => d.id);
    for (const id of ['ide.open_file', 'settings.open_mcp', 'model.assign', 'session.open', 'bot.add_telegram', 'model.add_api_key', 'task.status', 'changes.who']) assert.ok(ids.includes(id), id);
    const r = await house.run(app, 'settings.open_mcp', {});
    assert.ok(r.ok && app._uiNavigate.capability === 'settings.open_mcp' && app._uiNavigate.section === 'mcp');
    const f = await house.run(app, 'ide.open_file', { path: 'button.js' });
    assert.ok(f.ok && app._uiNavigate.args.path === 'src/ui/button.js', JSON.stringify(f));
    assert.ok(!(await house.run(app, 'ide.open_file', { path: '../../etc/passwd' })).ok, 'nothing outside the project');
    const sym = await house.run(app, 'ide.open_symbol', { name: 'fixButton' });
    assert.ok(sym.ok && app._uiNavigate.args.path === 'src/ui/button.js', JSON.stringify(sym));
    assert.ok(!(await house.run(app, 'model.assign', { role: 'pilot', model: 'x' })).ok, 'only the two real roles');
    assert.ok(!(await house.run(app, 'no.such.door', {})).ok);
    const st = await house.run(app, 'task.status', {});
    assert.ok(st.ok && /Session/.test(st.text));
  });

  await test('BROWSER SAFETY: the automated window carries no automation or insecure flag (8.3: the website sign-in window is gone)', () => {
    assert.ok(!fs.existsSync(path.join(__dirname, '../../src/modelsource/signin.js')), 'no website sign-in window any more');
    const src = fs.readFileSync(path.join(__dirname, '../../src/env/chromium.js'), 'utf8');
    for (const bad of ['disable-web-security', 'ignore-certificate-errors', 'allow-running-insecure-content', 'enable-automation']) assert.ok(!src.includes(`'--${bad}`), bad);
  });

  await test('CHATGPT IDENTITY IS GONE (2026-10-02): it granted no model access, so nothing replaced it', () => {
    assert.ok(!fs.existsSync(path.join(__dirname, '../../src/chatgptauth.js')), 'no ChatGPT identity sign-in');
    const routes = fs.readFileSync(path.join(__dirname, '../../src/harnessapp/journeyroutes.js'), 'utf8');
    assert.ok(!routes.includes('/api/accounts/chatgpt'), 'no ChatGPT identity routes');
  });

  await test('ARCHITECTURE: seven rooms; IDE is /focus, the Agent is its sidecar, quick actions own no state, tests use no real store', () => {
    const page = (f) => fs.readFileSync(path.join(__dirname, '../../../lain-harness/page', ...f.split('/')), 'utf8');
    let shell = '';
    try { shell = page('shell/shell.js'); } catch { return; }   // the Harness repo is a sibling checkout; absent in Core-only runs
    const tabs = (shell.match(/data-tab="([a-z]+)"/g) || []).map((x) => x.slice(10, -1));
    // PHASE 8: BOT is Settings › Assistant and SESSION lives in Chat — neither is a room of its own.
    // PHASE 8.1: MCP & SKILLS is a room of its own.
    assert.deepStrictEqual(tabs, ['home', 'ide', 'chat', 'model', 'usage', 'mcp', 'settings'], 'seven rooms; no Focus tab, no Agent tab');
    const ide = page('workbench/ide.js');
    // 2026-09-30: the right panel is the sidecar with two tabs over the same session — Chat | Coding Agent.
    assert.ok(/id="ideBot"[\s\S]*id="sideTabs"/.test(ide) && /\['agent', 'Coding Agent'\]/.test(ide), 'AGENT lives inside the IDE\'s right panel (its sidecar tab)');
    const quick = page('shell/quick.js');
    assert.ok(!/L\.api\(|localStorage/.test(quick), 'hover menus keep no state and call no API of their own');
    assert.ok(/L\.house\.run/.test(quick), 'hover menus walk through the house doors');
    const cfgDir = require('../../src/config').configDir();
    assert.ok(!path.resolve(cfgDir).startsWith(path.resolve(isolation.REAL_HOME)), 'tests never touch the real profile');
    assert.ok(!path.resolve(ledger.logFile(root)).startsWith(path.resolve(isolation.REAL_HOME)), 'the provenance ledger is in the run-owned profile');
  });
};
