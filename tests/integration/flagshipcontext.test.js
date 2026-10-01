'use strict';

/**
 * THE FLAGSHIP CONTEXT PATH, THROUGH A REAL APP (2026-09-24).
 *
 * Real App, real routes, real tools and gates; the model is the mock
 * provider, wrapped so every request's exact messages and tool schemas are
 * kept. Where the claims are true or false:
 *
 *   · the stable prefix (tools + system) is BYTE-IDENTICAL across turns while
 *     nothing durable changed, and the tool order is stable
 *   · Harness / GUG / project-delta context rides ONLY the volatile tail
 *   · an IDE selection and a manual save become Core state (referent,
 *     generation, PROJECT_DELTA) — never transcript
 *   · "rename this to ButtonFix" and "move this down 6px" finish with NO
 *     model request when Core can do them exactly; a rename that needs
 *     judgement goes to the flagship with the packet
 *   · every request is settled in the cache ledger: COLD first, then WARM
 *   · a read-only project stays byte-identical
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');
const { setTimeout: delay } = require('timers/promises');

function treeHash(root) {
  const h = crypto.createHash('sha1');
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else h.update(`${path.relative(root, p)}\0`).update(fs.readFileSync(p)); } };
  walk(root);
  return h.digest('hex');
}

function project() {
  const proj = tmpdir('flagctx-');
  fs.mkdirSync(path.join(proj, 'src'));
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"flagctx","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'function fixButton() { return 1; }\nmodule.exports = { fixButton };\n');
  fs.writeFileSync(path.join(proj, 'src', 'use.js'), "const { fixButton } = require('./app');\nconsole.log(fixButton());\n");
  fs.writeFileSync(path.join(proj, 'src', 'style.css'), '.composer .submit {\n  width: 40px;\n  height: 40px;\n  margin-top: 4px;\n}\n');
  return proj;
}

function harness(proj, steps) {
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = writeScript(tmpdir('flagctx-script-'), steps);
  const mock = require('../../src/mockprovider');
  mock._reset();
  const calls = [];
  const real = mock.chat;
  mock.chat = function (pc, messages, opts) {
    calls.push({ messages: messages.map((m) => ({ role: m.role, content: String(m.content || ''), live: Boolean(m._live), ctx: m._ctx || null })), tools: JSON.stringify((opts.tools || []).map((t) => [t.name, t.description, t.parameters])) });
    return real(pc, messages, opts);
  };
  const { App } = require('../../src/app');
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: proj });
  const routes = require('../../src/harnessapp/routes');
  return { app, calls, d: (m, p, b = {}) => routes.dispatch(app, m, p, b), restore: () => { mock.chat = real; } };
}

async function turn(app, text) { await app.handle(text, { from: 'harness-app' }); for (let i = 0; i < 50 && app.abort; i++) await delay(20); }

module.exports = async () => {
  const prev = { p: process.env.LAIN_PROVIDER, s: process.env.LAIN_MOCK_SCRIPT };
  const back = () => { process.env.LAIN_PROVIDER = prev.p || ''; if (!prev.p) delete process.env.LAIN_PROVIDER; if (prev.s) process.env.LAIN_MOCK_SCRIPT = prev.s; else delete process.env.LAIN_MOCK_SCRIPT; };
  require('../../src/gug')._reset(); require('../../src/harnesscontext')._reset();

  await test('STABLE PREFIX: tools and system are byte-identical across turns; Harness context and PROJECT_DELTA ride only the volatile tail', async () => {
    const proj = project();
    const h = harness(proj, [{ text: 'It returns 1.' }, { text: 'Still 1.' }, { text: 'Noted.' }]);
    try {
      await turn(h.app, 'what does fixButton return?');
      await turn(h.app, 'and now?');
      // The person selects in the IDE and saves a manual edit: Core state, not transcript.
      const ctx = await h.d('POST', '/api/ide/context', { file: 'src/app.js', selection: { text: 'fixButton', startLine: 1, endLine: 1 } });
      assert.strictEqual(ctx.code, 200);
      const save = await h.d('POST', '/api/files/save', { path: 'src/style.css', body: '.composer .submit {\n  width: 40px;\n  height: 40px;\n  margin-top: 6px;\n}\n' });
      assert.strictEqual(save.body.ok, true, JSON.stringify(save.body));
      const hs = h.app.session._harness;
      assert.ok(hs.textSelection && hs.textSelection.head === 'fixButton', 'the selection is Core state');
      assert.ok(hs.actions.some((a) => a.kind === 'edit' && /manually edited src\/style\.css/.test(a.text)), 'the manual edit is a recent action');
      assert.strictEqual(require('../../src/projectgen').current(proj).n >= 1, true, 'the project generation advanced');
      await turn(h.app, 'thanks');
      assert.strictEqual(h.calls.length, 3);
      const [a, b, c] = h.calls;
      assert.strictEqual(a.tools, b.tools); assert.strictEqual(b.tools, c.tools);
      assert.strictEqual(a.messages[0].content, b.messages[0].content);
      assert.strictEqual(b.messages[0].content, c.messages[0].content, 'the system prompt did not move although Harness state did');
      const lastLive = c.messages[c.messages.length - 1];
      assert.ok(lastLive.live, 'the last message is the volatile tail');
      assert.doesNotMatch(lastLive.content, /# Harness context \(Core\)/, 'the Harness packet is NOT re-sent in the tail');
      // APPEND-ONLY: the packet was recorded once, just before the request it belongs to.
      const packets = c.messages.filter((m) => m.ctx === 'harness');
      assert.strictEqual(packets.length, 1, 'one packet, once');
      const at = c.messages.indexOf(packets[0]);
      assert.deepStrictEqual([c.messages[at + 1].role, c.messages[at + 1].content], ['user', 'thanks'], 'anchored before the turn it was recorded for');
      assert.match(packets[0].content, /^<lain-context>/, 'framed as context, not as the person speaking');
      assert.match(packets[0].content, /# Harness context \(Core\) · generation \d+ — supersedes any earlier Harness context/);
      assert.match(packets[0].content, /identifier fixButton declared at src\/app\.js:1/);
      assert.match(packets[0].content, /PROJECT_DELTA \d+ → \d+: changed src\/style\.css \(by the person\)/);
      assert.match(packets[0].content, /manually edited src\/style\.css/);
      assert.doesNotMatch(c.messages[0].content, /# Harness context \(Core\) ·|PROJECT_DELTA|GUG_SLICE/, 'nothing volatile in the system prompt');
      // The cache ledger settled every request: COLD first, WARM after.
      const rows = require('../../src/cacheledger').rows(h.app.session);
      assert.strictEqual(rows.length, 3);
      assert.strictEqual(rows[0].warmth, 'COLD');
      assert.deepStrictEqual(rows.slice(1).map((r) => r.warmth), ['WARM', 'WARM']);
      assert.ok(rows.every((r) => r.epoch === rows[0].epoch), 'one epoch');
      assert.ok(rows.every((r) => r.actual.reported === false && r.actual.ratio === null), 'the mock reports no cache: null, never zero');
      assert.ok(rows[1].expected.ratio < 0.05, `expected warm ratio: ${rows[1].expected.ratio}`);
    } finally { h.restore(); back(); }
  });

  await test('"rename this to ButtonFix" with the identifier selected: Core renames by AST, verifies, and asks NO model', async () => {
    const proj = project();
    const h = harness(proj, [{ text: 'SHOULD NOT BE ASKED' }]);
    try {
      await h.d('POST', '/api/ide/context', { file: 'src/app.js', selection: { text: 'fixButton', startLine: 1, endLine: 1 } });
      await turn(h.app, 'rename this to ButtonFix');
      assert.strictEqual(h.calls.length, 0, 'no flagship request');
      assert.match(fs.readFileSync(path.join(proj, 'src', 'app.js'), 'utf8'), /function ButtonFix\(\)/);
      assert.match(fs.readFileSync(path.join(proj, 'src', 'use.js'), 'utf8'), /const \{ ButtonFix \} = require/);
      const rec = h.app.session.turns[h.app.session.turns.length - 1];
      assert.match(rec.text, /Renamed fixButton → ButtonFix across 2 file\(s\)[\s\S]*Verified: no identifier named fixButton remains/);
      const d = h.app.session.dispatch;
      const job = d.jobs.find((j) => j.role === 'selection_rename');
      assert.ok(job && job.worker === 'CORE' && job.verified === true, JSON.stringify(d.jobs));
      assert.strictEqual(d.cls, 'SELECTION');
      assert.strictEqual(d.migration.eligible, false, 'a rename is not a migration');
      assert.ok(!d.jobs.some((j) => j.worker === 'LAYA' && j.consumed), 'no Laya consumed');
    } finally { h.restore(); back(); }
  });

  await test('a rename that needs judgement (the name also lives in a string) goes to the flagship WITH the selection packet', async () => {
    const proj = project();
    fs.writeFileSync(path.join(proj, 'src', 'wire.js'), "module.exports = { event: 'fixButton' };\n");
    const h = harness(proj, [{ text: 'I will rename the identifier and keep the wire name.' }]);
    try {
      await h.d('POST', '/api/ide/context', { file: 'src/app.js', selection: { text: 'fixButton', startLine: 1, endLine: 1 } });
      await turn(h.app, 'rename this to ButtonFix');
      assert.ok(h.calls.length >= 1, 'the flagship took it');
      assert.match(h.app.session.dispatch.selection.why, /needs judgement: 1 string\/comment/);
      assert.match(h.calls[0].messages.find((m) => m.ctx === 'harness').content, /selection S[0-9a-f]{10}: src\/app\.js lines 1-1 · identifier fixButton/);
      assert.match(fs.readFileSync(path.join(proj, 'src', 'app.js'), 'utf8'), /fixButton/, 'Core wrote nothing');
    } finally { h.restore(); back(); }
  });

  await test('"move this down 6px" on a Workshop selection: GUG → its one binding → margin-top +6, verified, NO model request', async () => {
    const proj = project();
    const h = harness(proj, [{ text: 'SHOULD NOT BE ASKED' }]);
    try {
      const els = [
        { tag: 'div', classes: 'composer', selector: 'div.composer', rect: { x: 0, y: 0, w: 600, h: 60 }, parent: -1, style: {} },
        { tag: 'button', classes: 'submit', selector: 'button.submit', label: 'Send', rect: { x: 540, y: 14, w: 40, h: 40 }, parent: 0, style: { position: 'static' } },
      ];
      const ws = { measure: async () => ({ ok: true, url: 'http://localhost:5173/', viewport: { w: 1280, h: 800 }, elements: els }) };
      const g = await require('../../src/harnesscontext').workshopPicked(h.app, h.app.session, ws, { selector: 'button.submit', tag: 'button' });
      assert.strictEqual(g.id, 'composer.submit');
      await turn(h.app, 'move this down 6px');
      assert.strictEqual(h.calls.length, 0, 'no flagship request');
      assert.match(fs.readFileSync(path.join(proj, 'src', 'style.css'), 'utf8'), /margin-top: 10px;/);
      const rec = h.app.session.turns[h.app.session.turns.length - 1];
      assert.match(rec.text, /margin-top 4px → 10px[\s\S]*Verified: the file now holds the new values[\s\S]*Resolved from the selected Workshop node \(GUG generation 1\)/);
      assert.strictEqual(h.app.session.dispatch.migration.eligible, false, '"move this down" is not a migration');
      // The source edit staled the node it sizes (reverse mapping).
      assert.ok(require('../../src/gug').get(h.app, proj).stale['composer.submit']);
    } finally { h.restore(); back(); }
  });

  await test('READ-ONLY PROJECT: a turn with Harness context, a GUG measurement and bounded tool output leaves the tree byte-identical', async () => {
    const proj = project();
    const before = treeHash(proj);
    const h = harness(proj, [{ text: 'Reading.', tool_calls: [{ name: 'read_file', input: { path: 'src/app.js' } }] }, { text: 'It returns 1.' }]);
    try {
      await h.d('POST', '/api/ide/context', { file: 'src/app.js', selection: { text: 'fixButton', startLine: 1, endLine: 1 } });
      const ws = { measure: async () => ({ ok: true, url: 'x', viewport: null, elements: [{ tag: 'div', classes: 'composer', rect: { x: 0, y: 0, w: 10, h: 10 }, parent: -1 }] }) };
      await require('../../src/harnesscontext').measureWorkshop(h.app, h.app.session, ws);
      await turn(h.app, 'READ-ONLY. Do not change anything. What does this function return?');
      assert.ok(h.calls.length >= 1);
      assert.strictEqual(treeHash(proj), before, 'byte-identical (.lain included)');
    } finally { h.restore(); back(); }
  });
};
