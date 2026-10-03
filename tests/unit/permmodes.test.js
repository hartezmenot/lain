'use strict';

/**
 * SIMPLIFY S5 — permission modes (Ask · Accept edits · Plan · Auto) at the one tool door, allow/deny rules a project
 * can only narrow, Plan mode's exit_plan, and Computer in Auto.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const execmode = require('../../src/execmode');
const rules = require('../../src/permrules');
const { Session } = require('../../src/session');

/** A stand-in app: a person who answers from a queue, and the questions they were asked. */
function appFor(session, { answers = [], trusted = true, permissions = null } = {}) {
  const asked = [];
  return {
    session, asked, ui: { enabled: false },
    cfg: { trustedPaths: trusted ? [{ path: session.cwd, level: 'TRUSTED' }] : [], ...(permissions ? { permissions } : {}) },
    interaction: { ask: async (q) => { asked.push(q); return answers.length ? answers.shift() : null; } },
  };
}

module.exports = async function () {
  const tools = require('../../src/tools');

  await test('RULES: the person\'s allow/deny; a project file adds denies and a stricter default, never an allow', () => {
    const root = tmpdir('pr-');
    fs.mkdirSync(path.join(root, '.lain'), { recursive: true });
    fs.writeFileSync(path.join(root, '.lain', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(rm -rf:*)'], deny: ['Read(.env)'], defaultMode: 'plan' } }));
    const r = rules.of({ permissions: { allow: ['Bash(npm run:*)'], deny: ['Bash(git push:*)'], defaultMode: 'acceptEdits' } }, root);
    assert.deepStrictEqual(r.allow, ['Bash(npm run:*)'], 'a project allow never widens');
    assert.deepStrictEqual(r.ignored, ['Bash(rm -rf:*)']);
    assert.deepStrictEqual(r.deny, ['Bash(git push:*)', 'Read(.env)']);
    assert.strictEqual(r.defaultMode, 'PLAN', 'the stricter default wins');
    assert.strictEqual(rules.of({ permissions: { defaultMode: 'plan' } }, tmpdir('pr2-')).defaultMode, 'PLAN');
    fs.writeFileSync(path.join(root, '.lain', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }));
    assert.strictEqual(rules.of({ permissions: { defaultMode: 'ask' } }, root).defaultMode, 'ASK', 'a looser project default is ignored');
    assert.ok(rules.matches('Bash(npm run:*)', 'shell', { command: 'npm run test' }, root));
    assert.ok(!rules.matches('Bash(npm run:*)', 'shell', { command: 'npm install' }, root));
    assert.ok(rules.matches('Edit(src/**)', 'apply_patch', { path: 'src/a/b.js' }, root));
    assert.ok(!rules.matches('Edit(src/**)', 'edit_file', { path: 'test/a.js' }, root));
    assert.ok(rules.matches('Read(.env)', 'read_file', { path: '.env' }, root));
    assert.ok(rules.matches('WebFetch(domain:example.com)', 'web_fetch', { url: 'https://example.com/x' }, root));
  });

  await test('PLAN: a write, a side-effecting command and computer input are refused in one line; reading and inspecting pass', async () => {
    const root = tmpdir('pm-plan-');
    const s = new Session({ cwd: root });
    execmode.set(s, 'PLAN');
    const app = appFor(s);
    const w = await tools.execute('write_file', { path: 'a.txt', content: 'x' }, { cwd: root, session: s, app });
    assert.strictEqual(w.output, execmode.PLAN_REFUSAL);
    assert.ok(!fs.existsSync(path.join(root, 'a.txt')));
    const install = await tools.execute('shell', { command: 'npm install left-pad' }, { cwd: root, session: s, app });
    assert.strictEqual(install.output, execmode.PLAN_REFUSAL);
    const look = await tools.execute('shell', { command: 'git status' }, { cwd: root, session: s, app });
    assert.ok(!look.denied, 'an inspecting command runs in Plan mode');
    const click = await execmode.gate({ session: s, app }, 'computer', { mutates: true }, { action: 'click', x: 1, y: 1 });
    assert.strictEqual(click.output, execmode.PLAN_REFUSAL);
    const shot = await execmode.gate({ session: s, app }, 'computer', { mutates: true }, { action: 'screenshot' });
    assert.ok(shot.ok, 'looking is reading');
    assert.strictEqual(app.asked.length, 0, 'Plan mode never asks — it refuses');
  });

  await test('ACCEPT EDITS and ASK: edits pass or ask; commands ask; an allow rule skips the question; a deny rule refuses in every mode', async () => {
    const root = tmpdir('pm-ae-');
    const s = new Session({ cwd: root });
    execmode.set(s, 'ACCEPT_EDITS');
    let app = appFor(s, { answers: ['Deny'] });
    const w = await tools.execute('write_file', { path: 'a.txt', content: 'x' }, { cwd: root, session: s, app });
    assert.ok(!w.isError, w.output);
    assert.strictEqual(app.asked.length, 0, 'an edit does not ask in Accept edits');
    const c = await tools.execute('shell', { command: 'node -e "require(\'fs\').writeFileSync(\'b.txt\',\'y\')"' }, { cwd: root, session: s, app });
    assert.ok(c.denied && /did not allow shell/.test(c.output), c.output);
    assert.strictEqual(app.asked.length, 1);
    assert.ok(!fs.existsSync(path.join(root, 'b.txt')));
    app = appFor(s, { permissions: { allow: ['Bash(node -e:*)'] } });
    const allowed = await tools.execute('shell', { command: 'node -e "require(\'fs\').writeFileSync(\'b.txt\',\'y\')"' }, { cwd: root, session: s, app });
    assert.ok(!allowed.denied && fs.existsSync(path.join(root, 'b.txt')), allowed.output);
    assert.strictEqual(app.asked.length, 0, 'the allow rule answered it');
    execmode.set(s, 'ASK');
    app = appFor(s, { answers: ['Allow once'] });
    const asked = await tools.execute('write_file', { path: 'c.txt', content: 'x' }, { cwd: root, session: s, app });
    assert.ok(!asked.isError && app.asked.length === 1 && /Ask · allow this\?/.test(app.asked[0].title), 'Ask mode asks before an edit');
    execmode.set(s, 'AUTO');
    app = appFor(s, { permissions: { deny: ['Write(secret.txt)'] } });
    const d = await tools.execute('write_file', { path: 'secret.txt', content: 'x' }, { cwd: root, session: s, app });
    assert.ok(d.denied && /Denied by your permission rules: Write\(secret\.txt\)/.test(d.output), d.output);
  });

  await test('AUTO: no question in a trusted project; an untrusted one behaves as Accept edits until it is trusted', async () => {
    const root = tmpdir('pm-auto-');
    const s = new Session({ cwd: root });
    execmode.set(s, 'AUTO');
    const trusted = appFor(s);
    const r = await tools.execute('shell', { command: 'node -e "process.exit(0)"' }, { cwd: root, session: s, app: trusted });
    assert.ok(!r.denied && trusted.asked.length === 0, r.output);
    const untrusted = appFor(s, { trusted: false, answers: ['Deny'] });
    assert.strictEqual(execmode.effective(untrusted), 'ACCEPT_EDITS');
    const v = await execmode.gate({ session: s, app: untrusted }, 'shell', { mutates: true }, { command: 'npm install' });
    assert.ok(!v.ok && untrusted.asked.length === 1, 'the command asked');
    const headless = { ...untrusted, interaction: null };
    assert.strictEqual(execmode.effective(headless), 'AUTO', 'with nobody to trust it, nothing changes');
  });

  await test('EXIT_PLAN: saved to .lain/plans, shown, approved → Accept edits and a seeded todo list; Edit opens $EDITOR; Keep planning stays', async () => {
    const root = tmpdir('pm-exit-');
    const s = new Session({ cwd: root });
    s.save = () => {};
    const plan = '# Add a dark mode\n\n- [ ] Add the theme token\n- [ ] Wire the toggle\n- [ ] Test it';
    const outside = await tools.execute('exit_plan', { plan }, { cwd: root, session: s, app: appFor(s) });
    assert.match(outside.output, /Not in Plan mode/);
    execmode.set(s, 'ASK');
    execmode.set(s, 'PLAN');   // from Ask, an approved plan builds in Accept edits
    let app = appFor(s, { answers: ['Keep planning'] });
    const keep = await tools.execute('exit_plan', { plan }, { cwd: root, session: s, app });
    assert.match(keep.output, /keep planning/);
    assert.strictEqual(execmode.of(s), 'PLAN');
    const editor = path.join(tmpdir('pm-ed-'), 'ed.js');
    fs.writeFileSync(editor, "require('fs').appendFileSync(process.argv[2], '- [ ] Update the docs\\n');");
    const was = process.env.EDITOR;
    process.env.EDITOR = `node "${editor}"`;
    try {
      app = appFor(s, { answers: ['Edit', 'Approve'] });
      const r = await tools.execute('exit_plan', { plan }, { cwd: root, session: s, app });
      assert.match(r.output, /^Approved\. Mode: Accept edits\./);
      assert.match(r.output, /4 step\(s\)/);
      assert.match(r.output, /The person edited the plan[\s\S]*Update the docs/);
      assert.strictEqual(app.asked.length, 2, 'shown again after the edit');
      assert.match(app.asked[1].question, /Update the docs/);
    } finally { if (was == null) delete process.env.EDITOR; else process.env.EDITOR = was; }
    assert.strictEqual(execmode.of(s), 'ACCEPT_EDITS');
    assert.deepStrictEqual(s.todos.map((t) => t.content), ['Add the theme token', 'Wire the toggle', 'Test it', 'Update the docs']);
    const saved = fs.readdirSync(path.join(root, '.lain', 'plans'));
    assert.ok(saved.some((f) => /-add-a-dark-mode\.md$/.test(f)), saved.join(','));
  });

  await test('EXIT_PLAN in the Harness: the plan is an editable document; Build writes it back and approves', async () => {
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('pm-h-') });
    const routes = require('../../src/harnessapp/sessionroutes');
    app.interaction = routes.portFor(app);
    app.cfg.trustedPaths = [{ path: app.session.cwd, level: 'TRUSTED' }];
    execmode.set(app.session, 'AUTO');
    execmode.set(app.session, 'PLAN');
    app.session.save = () => {};
    const run = tools.execute('exit_plan', { plan: '# Rename\n\n1. Rename the module\n2. Fix imports' }, { cwd: app.session.cwd, session: app.session, app });
    let q = null;
    for (let i = 0; i < 50 && !(q = routes.pendingAsk(app)); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(q && q.plan && /Rename the module/.test(q.plan.text), 'the plan reaches the Harness as a document');
    const res = await routes.ROUTES['POST /api/ask/answer'](app, { id: q.id, answer: 'Approve', text: '# Rename\n\n1. Rename the module\n2. Fix imports\n3. Run the tests' });
    assert.strictEqual(res.body.ok, true);
    const r = await run;
    assert.match(r.output, /^Approved\. Mode: Auto\./, 'the mode before Plan comes back');
    assert.deepStrictEqual(app.session.todos.map((t) => t.content), ['Rename the module', 'Fix imports', 'Run the tests']);
  });

  await test('COMPUTER IN AUTO: chosen Auto brings the computer tool from the start; agents never get it', async () => {
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('pm-cu-') });
    const names = () => tools.schemas(app, { turn: true, session: app.session }).map((x) => x.name);
    assert.ok(!names().includes('computer'), 'not in the default (unchosen) Auto');
    app.interaction = { ask: async () => null };
    app.cfg.trustedPaths = [{ path: app.session.cwd, level: 'TRUSTED' }];
    execmode.set(app.session, 'AUTO');
    assert.ok(names().includes('computer') && !names().some((n) => /^computer_/.test(n)), 'one computer tool (S5.1): ' + names().join(','));
    execmode.set(app.session, 'ACCEPT_EDITS');
    assert.ok(names().includes('computer'), 'kept once present: the tool list does not churn');
    const child = new Session({ cwd: app.session.cwd });
    child._agentType = 'general';
    const agentNames = tools.schemas(app, { turn: true, session: child }).map((x) => x.name);
    assert.ok(!agentNames.some((n) => n === 'computer' || /^computer_/.test(n)), agentNames.join(','));
    const d = await tools.execute('computer', { action: 'click', x: 1, y: 1 }, { cwd: app.session.cwd, session: child, app });
    assert.ok(d.denied && /subagents never do/.test(d.output), d.output);
  });
};
