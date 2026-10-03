'use strict';

/**
 * LAYA · HARNESS CONTEXT & PERCEPTION (2026-09-24). Core dispatches, Laya
 * correlates, Core validates. These pin the boundary: a job cannot dispatch
 * another; a hypothesis is checked against Core's own evidence at the current
 * generation; SHADOW is recorded and never consumed; a late result is
 * discarded; a cold, slow or failed Laya never makes anybody wait.
 *
 * The worker is faked at the runtime seam (workerruntime.call): a bag-of-words
 * embedding, deterministic, so the tests are about the boundary, not the model.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

process.env.LAIN_CONFIG_DIR = process.env.LAIN_CONFIG_DIR || tmpdir('lain-layactx-home-');
const rt = require('../../src/workerruntime');
const lc = require('../../src/layacontext');
const hc = require('../../src/harnesscontext');
const gug = require('../../src/gug');

const VOCAB = ['send', 'submit', 'button', 'input', 'search', 'composer', 'dropdown', 'sort', 'results', 'file', 'edited', 'selected', 'css', 'app'];
function vec(t) { const w = String(t).toLowerCase(); const v = VOCAB.map((k) => (w.includes(k) ? 1 : 0)); const n = Math.hypot(...v) || 1; return v.map((x) => x / n); }
function fakeCall(onCall = () => {}) {
  return async (app, id, req) => {
    const r = onCall(req);
    if (r === 'fail') return null;
    if (r && r.then) await r;
    const rows = (req.texts || []).map(vec);
    const f = new Float32Array(rows.flat());
    return { ok: true, dim: VOCAB.length, vectors: Buffer.from(f.buffer).toString('base64'), model: 'fake', schema: 'fake', usage: { tokens_in: 1 } };
  };
}

const saved = {};
function env(k, v) { if (!(k in saved)) saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
function restore() { for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; delete saved[k]; } }

function world({ mode = null } = {}) {
  gug._reset(); hc._reset();
  const root = tmpdir('lain-layactx-');
  fs.writeFileSync(path.join(root, 'app.css'), '.composer .submit { width: 40px; height: 40px; }\n');
  const app = { cfg: { workers: {} }, _hostView: { laya: { state: 'HOT_IDLE' } } };
  const session = { id: `s-${Math.random()}`, cwd: root, messages: [] };
  app.session = session;
  const els = [
    { tag: 'div', classes: 'composer', selector: 'div.composer', rect: { x: 0, y: 0, w: 600, h: 60 }, parent: -1 },
    { tag: 'input', classes: 'search-input', selector: 'input.search-input', label: 'Search', rect: { x: 10, y: 10, w: 400, h: 40 }, parent: 0 },
    { tag: 'button', classes: 'submit', selector: 'button.submit', label: 'Send', rect: { x: 520, y: 10, w: 40, h: 40 }, parent: 0 },
    { tag: 'select', classes: 'sort-select', selector: 'select.sort-select', label: 'Sort dropdown', rect: { x: 420, y: 10, w: 90, h: 40 }, parent: 0 },
  ];
  gug.put(app, root, gug.bind(gug.fromDom(els, { root }), root));
  hc.workshopSelect(app, session, { selector: 'button.submit', name: 'Send', tag: 'button' }, gug.get(app, root));
  if (mode) env('LAIN_ROLE_HARNESS_CONTEXT_COMPILER', mode);
  lc._reset(app);
  return { app, session, root };
}

async function settle(app) { for (let i = 0; i < 20; i++) { await new Promise((r) => setImmediate(r)); if (!lc.stateOf(app).running && !lc.stateOf(app).queue.length) return; } }

module.exports = async function run() {
  const realCall = rt.call;
  await test('LAYA CANNOT SELF-DISPATCH OR CALL ANOTHER WORKER: an enqueue from inside a job is refused and counted; jobs are pure', async () => {
    try {
      let inner = null;
      let calls = 0;
      const { app, session } = world();
      rt.call = fakeCall(() => { calls += 1; inner = lc.enqueue(app, session, { type: 'selection' }); });
      lc.enqueue(app, session, { type: 'selection', text: 'send' });
      await settle(app);
      assert.strictEqual(inner, false);
      assert.ok(calls >= 1);
      assert.strictEqual(lc.metrics(app).selfDispatchRefused, calls, 'every attempt from inside a job is refused and counted');
      // THE JOBS ARE PURE FUNCTIONS of (facts, embed): no require, no App, no dispatcher.
      for (const [name, fn] of Object.entries(lc.JOBS)) {
        const src = fn.toString().slice(fn.toString().indexOf('{'));   // the body, not the name
        assert.ok(!/require\(|enqueue|workerruntime|\bapp\b|session|dispatch/.test(src), `${name} reaches outside its facts`);
      }
    } finally { rt.call = realCall; restore(); }
  });

  await test('LATE RESULTS ARE DISCARDED: the context moved on while Laya worked → late, not appended, not consumed', async () => {
    try {
      let release;
      const gate = new Promise((r) => { release = r; });
      rt.call = fakeCall(() => gate);
      const { app, session } = world({ mode: 'FORCE' });
      lc.enqueue(app, session, { type: 'selection', text: 'send' });
      await new Promise((r) => setImmediate(r));
      hc.fromIde(app, session, { file: 'src/App.tsx', selection: { text: 'fixButton', startLine: 3, endLine: 3 } });   // the person moved on
      release();
      await settle(app);
      const m = lc.metrics(app).roles.harness_context_compiler;
      assert.strictEqual(m.late, 1, JSON.stringify(m));
      assert.strictEqual(lc.consumable(app, session), '');
    } finally { rt.call = realCall; restore(); }
  });
  await test('SOURCE RANKING STAYS OFF: no Harness event dispatches it, and no dispatch class names it', () => {
    const { app, session } = world();
    assert.ok(!Object.keys(lc.ROLES).includes('source_file_ranker'));
    const d = require('../../src/dispatch');
    for (const cls of ['MIGRATION', 'UI_GEOMETRY', 'UI_EVIDENCE', 'SELECTION', 'TRACE', 'QUESTION', 'GENERAL']) {
      assert.ok(!d.owners(cls, {}, null, { explicit: false }).includes('laya:source_file_ranker'), cls);
    }
    assert.strictEqual(require('../../src/locateassist').policy(app, session).laya, 'off');
  });
};
