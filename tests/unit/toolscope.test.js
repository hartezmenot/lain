'use strict';

/**
 * TOOL SCOPING (2026-10-02) — core tools plus the capability packs a task needs; subagents get their role's tools.
 * Measured before: NORMAL described all 63 schemas / 60 KB on every request (a label edit used four of them), and
 * every SCOUT was described the parent's whole registry (~74 KB per request).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

function appFor() {
  const { App } = require('../../src/app');
  return new App({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'scope-')), interactive: false, out: { write() {}, on() {}, columns: 100, isTTY: false } });
}
function turnTools(app, { cls = null, thread = 'coding', text = '' } = {}) {
  const s = app.session;
  s._toolFunnel = null; s._funnelSticky = null; s._funnelNext = []; s._funnelKey = null;
  s.thread = thread; s._changeClass = cls ? { class: cls, text, at: Math.random() } : null; s.turns = [];
  return require('../../src/tools').schemas(app, { turn: true }).map((t) => t.name);
}

module.exports = async function () {
  await test('TOOL SCOPE: a small DIRECT edit gets the core set only — no account, Preview, computer, release, agent or ceremony tools', () => {
    const names = turnTools(appFor(), { cls: 'DIRECT', text: 'Change the button label from Save to Apply.' });
    assert.ok(names.length <= 15, `${names.length} tools: ${names.join(', ')}`);
    for (const must of ['read_file', 'grep', 'edit_file', 'run_bash', 'request_completion']) assert.ok(names.includes(must), must);
    for (const never of ['delegate', 'engineering_brief', 'architecture', 'concept', 'task_contract', 'verify_task', 'lain_workspace', 'request_computer', 'service_start', 'job_wait']) {
      assert.ok(!names.includes(never), `${never} must not ride a label edit`);
    }
    assert.ok(!names.some((n) => /^preview_/.test(n)), 'no Preview tools without a Preview');
  });

  await test('TOOL SCOPE: Chat gets conversation and research — never the editors', () => {
    const names = turnTools(appFor(), { thread: 'chat', text: 'what does a closure capture?' });
    assert.ok(names.includes('read_file') && names.includes('web_fetch'));
    assert.ok(!names.includes('edit_file') && !names.includes('run_bash'), names.join(', '));
  });

  await test('TOOL SCOPE: the request\'s own words load packs — web, release, delegation', () => {
    const app = appFor();
    assert.ok(turnTools(app, { cls: 'AGENT', text: 'check the latest version in the docs at https://vitejs.dev' }).includes('web_fetch'));
    assert.ok(turnTools(app, { cls: 'AGENT', text: 'publish the release and build the installer' }).includes('run_background'));
    assert.ok(turnTools(app, { cls: 'AGENT', text: 'investigate these four questions in parallel with scouts' }).includes('delegate'));
    assert.ok(!turnTools(app, { cls: 'AGENT', text: 'fix the off-by-one in mergeRanges' }).includes('delegate'), 'a plain bug fix does not get delegation');
  });

  await test('TOOL SCOPE: a PHASED task gets the whole registry; the set never narrows mid-session (cache-stable prefix)', () => {
    const app = appFor();
    const all = turnTools(app, { cls: 'PHASED', text: 'migrate the whole app to TypeScript' });
    assert.ok(all.length >= 50, `${all.length}`);
    const s = app.session;
    s._changeClass = { class: 'DIRECT', text: 'rename the label', at: Math.random() };
    const after = require('../../src/tools').schemas(app, { turn: true }).map((t) => t.name);
    assert.strictEqual(after.length, all.length, 'once the session needed everything, it keeps everything');
  });

  await test('TOOL SCOPE: a subagent is described its ROLE\'s tools, never the parent\'s registry', () => {
    const app = appFor();
    const { Session } = require('../../src/session');
    const reg = require('../../src/tools');
    const scout = new Session({ cwd: app.session.cwd }); scout._agentRole = 'SCOUT';
    const s = reg.schemas(app, { turn: true, session: scout }).map((t) => t.name);
    assert.ok(s.includes('read_file') && s.includes('grep'));
    assert.ok(!s.includes('edit_file') && !s.includes('run_bash') && !s.includes('delegate'), s.join(', '));
    const verifier = new Session({ cwd: app.session.cwd }); verifier._agentRole = 'VERIFIER';
    const v = reg.schemas(app, { turn: true, session: verifier }).map((t) => t.name);
    assert.ok(v.includes('run_tests') && v.includes('run_bash') && !v.includes('edit_file'), v.join(', '));
  });
};
