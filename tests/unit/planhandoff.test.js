'use strict';

/**
 * PLAN → CODING HANDOFF, AND THE CONTRACTS BESIDE IT (models, settings).
 *
 * What is pinned:
 *   · plan states are explicit and move only on the named actions
 *   · accepting FREEZES, supersedes and PREFILLS — it never executes
 *   · the handoff is structured facts; no Chat assistant text, no reasoning
 *   · the Coding prompt carries the accepted plan; the Chat prompt says Chat
 *   · a website model is never offered to Coding, and search opens no browser
 *   · settings list only what has a backend, validate, and refuse unknown keys
 *   · notification preferences are honoured by notify.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const plans = require('../../src/planhandoff');

function appAt(cwd) {
  const { App } = require('../../src/app');
  return new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd });
}

const PLAN = '## Plan: stop stalled downloads\n1. Add a stall timer to `DownloadQueue` in queue.js\n2. Retry once\n3. Add a test';

module.exports = async function () {
  await test('PLAN: detection is deterministic — steps AND (called a plan OR asked for one)', () => {
    assert.strictEqual(plans.detect(PLAN, 'why is it slow').ok, true, 'titled plan');
    assert.strictEqual(plans.detect('1. first\n2. second', 'make a plan for this').ok, true, 'asked for one');
    assert.strictEqual(plans.detect('1. first\n2. second', 'explain the queue').ok, false, 'a numbered explanation is not a plan');
    assert.strictEqual(plans.detect('## Plan\n1. only one step', 'plan').ok, false, 'one step is not a plan');
  });

  await test('PLAN: states move only on actions — draft, supersede, accept, edit, complete', () => {
    const app = appAt(tmpdir('plan-'));
    const s = app.session;
    const d1 = plans.capture(s, { reply: PLAN, asked: 'plan the fix' }).plan;
    assert.strictEqual(d1.state, 'DRAFT');
    const d2 = plans.draft(s, { text: '## Plan v2\n1. a\n2. b' }).plan;
    assert.strictEqual(plans.find(s, d1.id).state, 'SUPERSEDED', 'one pending draft at a time');
    assert.strictEqual(plans.edit(s, d2.id, '## Plan v2\n1. a\n2. b\n3. c').plan.steps.length, 3);
    const acc = plans.accept(app, d2.id);
    assert.strictEqual(acc.ok, true);
    assert.strictEqual(acc.plan.state, 'ACCEPTED');
    assert.ok(acc.plan.digest, 'frozen with a digest');
    assert.strictEqual(plans.accept(app, d2.id).ok, false, 'an accepted plan is not accepted twice');
    const reopened = plans.edit(s, d2.id, '## Plan v3\n1. x\n2. y');
    assert.strictEqual(reopened.plan.state, 'DRAFT', 'editing an accepted plan opens a new draft');
    assert.strictEqual(plans.find(s, d2.id).state, 'ACCEPTED', 'and leaves what was agreed untouched');
    plans.accept(app, reopened.plan.id);
    assert.strictEqual(plans.find(s, d2.id).state, 'SUPERSEDED', 'a newer acceptance supersedes');
    assert.strictEqual(plans.complete(s, reopened.plan.id).plan.state, 'COMPLETED');
  });

  await test('HANDOFF: accept prefills and executes nothing; the brief is facts, not the chat transcript', async () => {
    const proj = tmpdir('handoff-');
    fs.writeFileSync(path.join(proj, 'queue.js'), 'class DownloadQueue {}\nmodule.exports = DownloadQueue;\n');
    const app = appAt(proj);
    require('../../src/projectindex').refresh(proj);
    const s = app.session;
    s.messages.push(
      { role: 'user', content: 'Plan how to fix stalled downloads. It must not add dependencies.', thread: 'chat' },
      { role: 'assistant', content: `PRIVATE-CHAT-PROSE ${PLAN}`, thread: 'chat', reasoning: 'SECRET-REASONING' },
    );
    const d = plans.capture(s, { reply: PLAN, asked: 'plan it' }).plan;
    const turnsBefore = s.turns.length;
    const acc = plans.accept(app, d.id);
    assert.strictEqual(s.turns.length, turnsBefore, 'no turn ran');
    assert.strictEqual(app.abort, null, 'nothing is executing');
    assert.strictEqual(require('../../src/sessionviews').views(s).active, 'coding');
    const h = acc.handoff;
    assert.strictEqual(h.state, 'PREFILLED');
    assert.match(h.prompt, /Implement the accepted plan p\d/);
    assert.match(h.prompt, /1\. Add a stall timer/);
    const brief = JSON.stringify(h.brief);
    assert.ok(!/PRIVATE-CHAT-PROSE|SECRET-REASONING/.test(brief), 'no chat assistant prose and no reasoning cross over');
    assert.deepStrictEqual(h.brief.userRequirements, ['Plan how to fix stalled downloads. It must not add dependencies.']);
    assert.ok(h.brief.constraints.some((c) => /must not add dependencies/.test(c)), 'constraints are the person\'s own words');
    assert.ok(h.brief.relevantFiles.includes('queue.js'), 'files named in the plan that exist');
    assert.deepStrictEqual(h.brief.projectIntelligenceRefs.symbols[0], { name: 'DownloadQueue', at: ['queue.js:1'] });
    assert.strictEqual(h.brief.projectRoot, proj);
    assert.ok(h.prompt.length < 2000, 'the composer instruction is bounded');
    assert.ok(plans.noteSubmitted(s), 'sending marks it submitted');
    assert.strictEqual(plans.handoff(s).state, 'SUBMITTED');
  });
  await test('HANDOFF: persisted with the session and restored by resume', () => {
    const app = appAt(tmpdir('persist-'));
    const s = app.session;
    plans.accept(app, plans.draft(s, { text: PLAN }).plan.id);
    s.save();
    const back = require('../../src/session').Session.resume(s.id);
    assert.strictEqual(back.planDocs[0].state, 'ACCEPTED');
    assert.strictEqual(plans.handoff(back).state, 'PREFILLED');
    require('../../src/sessionstore').forget(s.id);
  });

  await test('ROUTES: Yes/Edit/Not yet map to accept/edit/defer, and the state carries the prompt and prefill', async () => {
    const routes = require('../../src/harnessapp/routes');
    const app = appAt(tmpdir('proutes-'));
    const d = plans.draft(app.session, { text: PLAN }).plan;
    let st = (await routes.dispatch(app, 'GET', '/api/state', {})).body.state;
    assert.deepStrictEqual(st.plans.prompt, { planId: d.id, title: d.title, actions: ['accept', 'edit', 'defer'] });
    await routes.dispatch(app, 'POST', '/api/plan/defer', { id: d.id });
    st = (await routes.dispatch(app, 'GET', '/api/state', {})).body.state;
    assert.strictEqual(st.plans.prompt, null, 'Not yet stops asking');
    assert.strictEqual(st.plans.plans[0].state, 'DRAFT', 'and accepts nothing');
    const acc = await routes.dispatch(app, 'POST', '/api/plan/accept', { id: d.id });
    assert.strictEqual(acc.body.view, 'coding');
    st = (await routes.dispatch(app, 'GET', '/api/state', {})).body.state;
    assert.strictEqual(st.composer.coding.prefill.planId, d.id);
    assert.strictEqual(st.views.active, 'coding');
  });

  // -------------------------------------------------------------- models --

  await test('MODELS: Coding refuses a website model; Chat selection of a runtime model stays in the session', async () => {
    const inv = require('../../src/modelinventory');
    const app = appAt(tmpdir('inv-'));
    const r = await inv.select(app, { lane: 'coding', source: 'chatgpt-web', modelId: 'gpt-x' });
    assert.strictEqual(r.ok, false);
    // ChatGPT Chat is CHAT ONLY (modelroles.js) — refused by capability, before any lane rule.
    assert.match(r.why, /CHAT ONLY/);
    const sel = inv.selections(app);
    assert.strictEqual(sel.coding.source, 'lain');
    assert.strictEqual(sel.chat.source, 'lain');
  });

  await test('MODELS: search never opens a browser — and lists no website source (retired in Phase 8.1)', async () => {
    const inv = require('../../src/modelinventory');
    const app = appAt(tmpdir('inv2-'));
    const chat = await inv.search(app, { lane: 'chat', query: '' });
    assert.ok(chat.rows.every((x) => x.source === 'lain'), 'every chat row is a LAIN route');
    const coding = await inv.search(app, { lane: 'coding', query: '' });
    assert.ok(coding.rows.every((x) => x.source === 'lain'), 'Coding offers runtime models only');
    assert.strictEqual(require('../../src/modelsource/registry').get(app, 'chatgpt-web'), null, 'no website source is constructed');
  });

  // ------------------------------------------------------------ settings --

  await test('SETTINGS: a schema of settings with backends; updates validate; unknown keys are refused', async () => {
    const settings = require('../../src/settings');
    const app = appAt(tmpdir('set-'));
    const s = await settings.schema(app);
    const keys = s.sections.flatMap((x) => x.fields.map((f) => f.key));
    for (const k of ['general.startup.harness', 'general.startup.minimized', 'general.startup.restoreWorkspace', 'general.maxSteps', 'models.defaultChat', 'models.defaultCoding', 'paths.defaultProjectRoot', 'paths.nodePath', 'notifications.errors', 'privacy.trustedDirectories']) {
      assert.ok(keys.includes(k), `${k} is in the schema`);
    }
    assert.ok(!keys.some((k) => /theme|accent|update/i.test(k)), 'nothing without a backend');
    assert.strictEqual((await settings.update(app, 'nope.key', 1)).ok, false);
    assert.strictEqual((await settings.update(app, 'general.closeToTray', false)).ok, false, 'a fixed behaviour cannot be flipped');
    assert.strictEqual((await settings.update(app, 'general.maxSteps', -3)).ok, false);
    assert.strictEqual((await settings.update(app, 'general.maxSteps', 40)).ok, true);
    assert.strictEqual(app.cfg.maxSteps, 40);
    assert.strictEqual((await settings.update(app, 'paths.defaultProjectRoot', path.join(__dirname, '..', '..'))).ok, false, 'LAIN\'s folder is not a project root');
    const dir = tmpdir('projroot-');
    assert.strictEqual((await settings.update(app, 'paths.defaultProjectRoot', dir)).ok, true);
    assert.strictEqual((await settings.update(app, 'paths.nodePath', 'C:/definitely/not/node.exe')).ok, false);
    const n = await settings.update(app, 'paths.nodePath', process.execPath);
    assert.strictEqual(n.ok, true);
    assert.strictEqual(n.restartRequired, true);
    assert.strictEqual((await settings.update(app, 'models.defaultChat', { source: 'nope' })).ok, false);
    assert.strictEqual((await settings.update(app, 'models.defaultChat', { source: 'gemini-web', modelId: 'g-1' })).ok, false, 'a retired website source is refused');
    assert.strictEqual((await settings.update(app, 'models.defaultChat', { source: 'lain' })).ok, true);
    const saved = JSON.parse(fs.readFileSync(require('../../src/config').configFile(), 'utf8'));
    assert.strictEqual(saved.defaultChat.source, 'lain', 'written through config.save');
  });

  await test('SETTINGS: notification preferences are honoured where notifications are sent', async () => {
    const notify = require('../../src/notify');
    const app = appAt(tmpdir('notif-'));
    const ipc = require('../../src/harnessapp/ipc');
    const real = ipc.toHost;
    const sent = [];
    ipc.toHost = (v) => { sent.push(v); return { ok: true }; };
    try {
      app.session.lifecycle = { state: 'NEEDS_USER', reason: 'a decision' };
      assert.strictEqual(notify.turnEnded(app, null).sent, true);
      app.cfg.notifications = { needsInput: false };
      const r = notify.turnEnded(app, null);
      assert.strictEqual(r.sent, false);
      assert.match(r.why, /needsInput notifications are off/);
      assert.strictEqual(sent.length, 1);
    } finally { ipc.toHost = real; }
  });
};
