'use strict';

/**
 * `/diff` — THE PERSISTENT INSPECTOR, and CTRL+PGDN.
 *
 * The key routing is driven through the real ui/keys.js router over a real
 * InteractionPanel, against real files and a real checkpoint store.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const { InteractionPanel, KIND } = require('../../src/ui/panel');
const { handleKey } = require('../../src/ui/keys');
const { inspector, STATE_PAINT } = require('../../src/ui/diffinspector');
const { Checkpoints } = require('../../src/checkpoint');
const { decodeEscape } = require('../../src/keydecode');
const T = require('../../src/ui/text');

/** A project with one new, one modified and one removed file, all captured. */
function changedProject() {
  const cwd = tmpdir('diffinsp-');
  const cp = new Checkpoints(`diff-${Date.now()}`, cwd);
  const w = (rel, body) => fs.writeFileSync(path.join(cwd, rel), body);
  w('provider.js', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'));
  w('oldprovider.js', 'module.exports = "old";\n');
  const e1 = cp.capture('t1', [path.join(cwd, 'newprovider.js'), path.join(cwd, 'provider.js'), path.join(cwd, 'oldprovider.js')]);
  w('newprovider.js', 'module.exports = "new";\nconst a = 1;\n');
  w('provider.js', Array.from({ length: 40 }, (_, i) => (i === 10 ? 'line ten, changed' : `line ${i}`)).join('\n'));
  fs.rmSync(path.join(cwd, 'oldprovider.js'));
  cp.settle(e1);
  return { cwd, app: { checkpoints: cp, session: { cwd } } };
}

function fakeUi(panel) {
  return {
    enabled: true,
    panel,
    phase: null,
    waitingUntil: null,
    app: { steerQueue: [], input: { line: '' } },
    screen: { geometry: () => ({ panelRows: 24, workspace: 20 }), stickToBottom: false, workspaceScroll: 0 },
    refreshed: 0,
    refresh() { this.refreshed += 1; },
  };
}

module.exports = async function () {
  await test('DIFF: the overview lists new, modified and removed files with real counts', () => {
    const { app } = changedProject();
    const panel = new InteractionPanel();
    panel.open(inspector(app));
    assert.strictEqual(panel.kind, KIND.INSPECTOR);
    const labels = panel.items.map((i) => i.label);
    assert.ok(labels.some((l) => /● newprovider\.js\s+\+2$/.test(l)), labels.join('\n'));
    assert.ok(labels.some((l) => /● provider\.js\s+\+1 −1$/.test(l)));
    assert.ok(labels.some((l) => /● oldprovider\.js\s+−1$/.test(l)));
    assert.match(panel.frame.title, /3 files changed\s+\+3 −2/, 'two new lines, one changed line, one removed line — no phantom trailing line');
  });

  await test('DIFF: the live activity counter and /diff count the same change the same way', () => {
    const { app } = changedProject();
    const entry = app.checkpoints.entries[0];
    const size = require('../../src/describe').editSize(app.checkpoints, entry);
    const panel = new InteractionPanel();
    panel.open(inspector(app));
    const total = panel.frame.title.match(/\+(\d+) −(\d+)/);
    assert.deepStrictEqual([size.added, size.removed], [Number(total[1]), Number(total[2])],
      'no surface counts a phantom trailing line');
  });

  await test('DIFF: file-state colour and line colour are separate semantics', () => {
    assert.strictEqual(STATE_PAINT.added.toString().includes('writing'), true, 'new files are blue');
    assert.strictEqual(STATE_PAINT.modified.toString().includes('ok'), true, 'modified files are green');
    assert.strictEqual(STATE_PAINT.deleted.toString().includes('bad'), true, 'removed files are red');
    const { app } = changedProject();
    const panel = new InteractionPanel();
    panel.open(inspector(app));
    const modified = panel.items.findIndex((i) => /● provider\.js/.test(i.label));
    panel.cursor = modified;
    const ui = fakeUi(panel);
    handleKey(ui, 'enter');
    const rows = panel.items;
    const removed = rows.find((r) => / - line 10$/.test(r.label));
    const added = rows.find((r) => / \+ line ten, changed$/.test(r.label));
    const context = rows.find((r) => /   line 9$/.test(r.label));
    assert.ok(removed && added && context, rows.map((r) => r.label).join('\n'));
    assert.ok(removed.paint.toString().includes('bad') && added.paint.toString().includes('ok') && context.paint.toString().includes('plain'),
      'a MODIFIED (green) file still shows its removed lines red and its context neutral');
  });

  await test('DIFF: Enter opens, ←/→ walk files, Esc returns to the overview on that file, Esc again closes', () => {
    const { app } = changedProject();
    const panel = new InteractionPanel();
    panel.open(inspector(app));
    const ui = fakeUi(panel);
    handleKey(ui, 'enter');
    assert.strictEqual(panel.stack.length, 2, 'detail is open');
    const first = panel.frame.title;
    handleKey(ui, 'right');
    assert.notStrictEqual(panel.frame.title, first, '→ moved to the next file');
    assert.strictEqual(panel.visible, true, '→ did not close it');
    handleKey(ui, 'escape');
    assert.strictEqual(panel.stack.length, 1, 'back to the overview');
    assert.strictEqual(panel.cursor, 1, 'on the file last looked at');
    handleKey(ui, 'down'); handleKey(ui, 'up'); handleKey(ui, 'pagedown'); handleKey(ui, 'left');
    assert.strictEqual(panel.visible, true, 'navigation never closes it');
    handleKey(ui, 'escape');
    assert.strictEqual(panel.visible, false, 'Esc from the overview closes');
  });

  await test('DIFF: it persists — command output, advisories and a working header cannot take it down', () => {
    const { app } = changedProject();
    const panel = new InteractionPanel();
    panel.open(inspector(app));
    assert.strictEqual(panel.isPassive, false, 'not replaceable like command output');
    assert.strictEqual(panel.isInspector, true);
    const { Renderer } = require('../../src/render');
    const r = Object.create(Renderer.prototype);
    r.screen = { panel, draw() {} };
    assert.strictEqual(r.openSurface('STATUS'), false, 'a command\'s output does not replace the inspector');
    assert.strictEqual(panel.kind, KIND.INSPECTOR);
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'index.js'), 'utf8');
    assert.match(src, /awaitingUser:[^\n]*!this\.panel\.isInspector/, 'the header does not claim Noema is waiting on you');
    const commands = require('../../src/commands');
    assert.strictEqual(commands.REGISTRY.get('/diff').flashMs || 0, 0, 'no timer takes it off the screen');
  });

  await test('DIFF: counters are live — they follow the real files, and only the real files', () => {
    const { cwd, app } = changedProject();
    const panel = new InteractionPanel();
    panel.open(inspector(app));
    const before = panel.frame.title;
    assert.strictEqual(panel.frame.title, before, 'nothing changed, nothing moves');
    fs.appendFileSync(path.join(cwd, 'newprovider.js'), 'const b = 2;\nconst c = 3;\n');
    assert.notStrictEqual(panel.frame.title, before);
    assert.ok(panel.items.some((i) => /● newprovider\.js\s+\+4$/.test(i.label)), 'the new lines are counted');
  });

  await test('DIFF: rows stay inside the frame at every width, CJK measured in cells', () => {
    const cwd = tmpdir('diffcjk-');
    const cp = new Checkpoints(`cjk-${Date.now()}`, cwd);
    const file = path.join(cwd, '鉴权服务.js');
    const e = cp.capture('t', [file]);
    fs.writeFileSync(file, `// 鉴权服务请求失败 ${'鉴'.repeat(80)}\n`);
    cp.settle(e);
    const panel = new InteractionPanel();
    panel.open(inspector({ checkpoints: cp, session: { cwd } }));
    for (const width of [60, 80, 100, 120, 160]) {
      for (const row of panel.render(width, 12)) {
        assert.ok(T.width(T.strip(row)) <= width, `overview row is ${T.width(T.strip(row))} cells at ${width}`);
      }
    }
    handleKey(fakeUi(panel), 'enter');
    for (const width of [60, 80, 100, 120, 160]) {
      for (const row of panel.render(width, 12)) {
        assert.ok(T.width(T.strip(row)) <= width, `detail row is ${T.width(T.strip(row))} cells at ${width}`);
      }
    }
  });

  await test('CTRL+PGDN B: decoded from both terminal spellings, jumps the conversation to the newest output', () => {
    assert.strictEqual(decodeEscape('\x1b[6;5~').key, 'ctrl-pagedown');
    assert.strictEqual(decodeEscape('\x1b[6^').key, 'ctrl-pagedown');
    assert.strictEqual(decodeEscape('\x1b[6~').key, 'pagedown', 'plain PgDn is unchanged');
    const ui = fakeUi(new InteractionPanel());
    ui.screen.workspaceScroll = 3; ui.screen.stickToBottom = false;
    assert.strictEqual(handleKey(ui, 'ctrl-pagedown'), true, 'consumed — nothing reaches the composer');
    assert.strictEqual(ui.screen.stickToBottom, true, 'following the newest output again');
  });

  await test('CTRL+PGDN: with the inspector open it still jumps the conversation, and leaves the inspector exactly as it was', () => {
    const { app } = changedProject();
    const panel = new InteractionPanel();
    panel.open(inspector(app));
    const ui = fakeUi(panel);
    handleKey(ui, 'down');
    const cursor = panel.cursor;
    ui.screen.stickToBottom = false;
    handleKey(ui, 'ctrl-pagedown');
    assert.strictEqual(ui.screen.stickToBottom, true);
    assert.strictEqual(panel.visible, true);
    assert.strictEqual(panel.cursor, cursor, 'inspector selection untouched');
  });
};
