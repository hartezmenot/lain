'use strict';

/**
 * LIVE EVIDENCE: observation receipts and Laya's `ui_evidence_narrower`
 * role (2026-09-24).
 *
 *   - a captured observation is a receipt: paged, queried, selected, expanded
 *     by ref; every read is recorded (narrowing debt is measured);
 *   - preparation (embedding the nodes) happens once, off the task's clock; a
 *     task's Laya inference is the QUERY only;
 *   - FORCE attaches the slice as ordinary evidence; SHADOW records it and
 *     attaches nothing; unprepared is bypassed without waiting;
 *   - the slice narrows observations only and keeps every ref recoverable.
 *
 * The embedder is a stub (word-hash vectors) standing in for the adapter's
 * `embed` op, so these run without a model.
 */

const assert = require('assert');
const { test, tmpdir } = require('../helpers');

process.env.LAIN_CONFIG_DIR = process.env.LAIN_CONFIG_DIR || tmpdir('lain-le-home-');

const store = require('../../src/observationstore');
const le = require('../../src/layaevidence');
const rt = require('../../src/workerruntime');
const dispatch = require('../../src/dispatch');

const DIM = 32;
function vec(t) {
  const a = new Float32Array(DIM);
  for (const w of String(t).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) a[[...w].reduce((s, c) => s + c.charCodeAt(0), 0) % DIM] += 1;
  let n = 0; for (const x of a) n += x * x; n = Math.sqrt(n) || 1;
  return a.map((x) => x / n);
}

let embedCalls = [];
const real = {};
function stub(mode) {
  for (const k of ['call', 'uses', 'roleMode', 'isHot']) real[k] = real[k] || rt[k];
  embedCalls = [];
  rt.call = async (app, id, req) => {
    if (req.op !== 'embed') return null;
    embedCalls.push(req.texts.length);
    const b = Buffer.alloc(req.texts.length * DIM * 4);
    req.texts.forEach((t, i) => Buffer.from(vec(t).buffer).copy(b, i * DIM * 4));
    return { dim: DIM, n: req.texts.length, vectors: b.toString('base64'), model: 'stub', schema: 'stub-v1', usage: { tokens_in: 3 * req.texts.length }, ms: 1 };
  };
  rt.uses = () => true;
  rt.roleMode = () => mode;
  rt.isHot = () => true;
}
function unstub() { for (const [k, v] of Object.entries(real)) rt[k] = v; }

/** A Toralink-shaped page: a search form, a sort select, a status line, results with a Get button, and noise. */
function snapshot() {
  const nodes = [];
  let i = 0;
  const add = (tag, extra = {}, parent = null, depth = 0) => { const n = { ref: `n${i++}`, tag, classes: [], attrs: {}, depth, parent, visible: true, ...extra }; nodes.push(n); return n.ref; };
  const body = add('body');
  const app = add('div', { classes: ['app'] }, body, 1);
  const tabs = add('nav', { classes: ['tabs'] }, app, 2);
  for (const t of ['Search', 'Downloads', 'Settings']) add('button', { classes: ['tab'], name: t, text: t, role: 'button' }, tabs, 3);
  const bar = add('div', { classes: ['searchbar'] }, app, 2);
  const form = add('form', { role: 'search' }, bar, 3);
  add('input', { classes: ['search-input'], role: 'searchbox', attrs: { placeholder: 'Search all sources or leave blank to browse' }, bounds: { x: 16, y: 80, w: 600, h: 40 } }, form, 4);
  add('div', { classes: ['search-hint'], text: '12 results - 3/4 sources - 1 down' }, bar, 3);
  const sort = add('select', { classes: ['sort-select'], role: 'combobox', name: 'Sort' }, bar, 3);
  for (const o of ['Best match', 'Newest upload', 'Most seeders', 'Source']) add('option', { text: o }, sort, 4);
  const results = add('div', { classes: ['results'] }, app, 2);
  for (let k = 0; k < 12; k++) {
    const r = add('div', { classes: ['result'] }, results, 3);
    const main = add('div', { classes: ['result-main'] }, r, 4);
    add('div', { classes: ['result-title'], text: `Big Buck Bunny ${k}` }, main, 5);
    const meta = add('div', { classes: ['result-meta'] }, main, 5);
    add('span', { classes: ['source-chip'], text: 'EZTV' }, meta, 6);
    add('span', { classes: ['seeders'], text: `▲ ${k}` }, meta, 6);
    add('button', { classes: ['dl-btn'], text: 'Get', role: 'button', name: 'Get' }, r, 4);
  }
  const foot = add('footer', {}, app, 2);
  for (let k = 0; k < 30; k++) add('span', { classes: ['legal'], text: `footer note ${k}` }, foot, 3);
  return {
    kind: 'dom', url: 'http://localhost:5173/', capturedAt: '2026-09-24T00:00:00Z', nodes,
    network: [{ method: 'GET', url: '/api/search?q=big%20buck%20bunny', status: 200, type: 'fetch', ms: 812 }, { method: 'GET', url: '/assets/index.js', status: 200, type: 'script' }],
    console: [{ level: 'warning', text: 'React DevTools' }], runtime: { server: 'express :4000', web: 'vite :5173 (proxy /api → :4000)' },
  };
}

function appFor() {
  return { cfg: { workers: {} }, session: { id: 's-le', cwd: tmpdir('lain-le-cwd-'), messages: [] } };
}

module.exports = async function run() {
  await test('OBSERVATION RECEIPT: page, element by ref / query / selector, requests — every read recorded', () => {
    const id = store.keep(snapshot());
    assert.match(id, /^obs_[0-9a-f]{10}$/);
    assert.deepStrictEqual(store.mentioned(`look at ${id} and obs_0000000000`), [id], 'only receipts that exist');
    const session = { messages: [] };
    const page = store.answer('page', { receipt: id }, session);
    assert.ok(page.ok && /nodes; showing 0–/.test(page.summary));
    const q = store.answer('element', { receipt: id, query: 'search input' }, session);
    assert.match(q.value, /▸\s+n\d+ searchbox\/input\.search-input/);
    const sel = store.answer('element', { receipt: id, selector: 'button.dl-btn' }, session);
    assert.match(sel.summary, /12 match/);
    const one = store.answer('element', { receipt: id, ref: 'n7' }, session);
    assert.match(one.value, /child/);
    const net = store.answer('requests', { receipt: id }, session);
    assert.match(net.value, /GET \/api\/search\?q=big%20buck%20bunny → 200/);
    assert.strictEqual(session.observationReads.length, 5);
    assert.ok(session.observationReads.every((r) => r.receipt === id && r.chars > 0));
    assert.strictEqual(store.answer('page', { receipt: 'obs_ffffffffff' }).ok, false);
  });

  await test('PREPARATION IS ONCE, OFF THE CLOCK: every node embedded in batches, then cached; a compile embeds the query only', async () => {
    stub('FORCE');
    try {
      const app = appFor();
      const id = store.keep(snapshot());
      const p = await le.prepare(app, id);
      assert.ok(p.ok && !p.cached && p.nodes === store.load(id).nodes.length, JSON.stringify(p));
      assert.ok(embedCalls.length >= 2 && embedCalls.every((n) => n <= 64), 'batched');
      assert.strictEqual((await le.prepare(app, id)).cached, true);
      embedCalls = [];
      const r = await le.compile(app, id, 'the search input, the results and the Get download button');
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual(embedCalls, [1], 'one inference: the query');
      assert.match(r.slice.text, /It narrows OBSERVATIONS only; the request, its read-only status, the output it asks for and its acceptance criteria are unchanged/);
      assert.match(r.slice.text, /observe \{goal:"element", receipt:"obs_[0-9a-f]{10}", ref:"n…"\}/, 'raw stays recoverable');
      assert.match(r.slice.text, /GET \/api\/search/, 'the API request is kept');
      assert.doesNotMatch(r.slice.text, /laya/i, 'ordinary evidence');
      const obs = store.load(id);
      const byRef = new Map(obs.nodes.map((n) => [n.ref, n]));
      assert.ok(r.slice.refs.some((ref) => (byRef.get(ref).classes || []).includes('search-input')), 'the search input is in the slice');
      assert.ok(r.slice.refs.length <= le.KEEP && r.slice.total === obs.nodes.length);
    } finally { unstub(); }
  });

  await test('FORCE: Core assigns the job for a request naming a receipt; the slice is attached once per turn; reads outside it are debt', async () => {
    stub('FORCE');
    try {
      const app = appFor();
      const id = store.keep(snapshot());
      await le.prepare(app, id);
      const text = `READ-ONLY. Using observation ${id}, identify the search input, the results and the download action.`;
      app.session.messages.push({ role: 'user', content: text });
      const d = dispatch.assign(app, text, { mode: 'EXPLAIN' });
      assert.strictEqual(d.cls, 'UI_EVIDENCE');
      assert.deepStrictEqual(d.observations, [id]);
      embedCalls = [];
      const slice = await le.take(app, app.session, 0);
      assert.match(slice, /^EVIDENCE SLICE · observation /);
      assert.strictEqual(await le.take(app, app.session, 1), slice, 'later steps reuse it');
      assert.deepStrictEqual(embedCalls, [1], 'one Laya job per turn');
      const job = d.jobs.find((j) => j.role === 'ui_evidence_narrower');
      assert.ok(job && job.consumed && job.mode === 'FORCE' && job.facts === store.load(id).nodes.length, JSON.stringify(job));
      store.answer('element', { receipt: id, query: 'footer note' }, app.session);
      const settled = le.settle(app.session);
      assert.strictEqual(settled.outsideCalls, 1);
      assert.ok(settled.outsideChars > 0 && settled.outsideRefs.length > 0);
    } finally { unstub(); }
  });

  await test('SHADOW: the job runs and is recorded, and NOTHING is attached; unprepared FORCE is bypassed without waiting', async () => {
    stub('SHADOW');
    try {
      const app = appFor();
      const id = store.keep(snapshot());
      await le.prepare(app, id);
      const text = `inspect observation ${id}: where is the search input?`;
      app.session.messages.push({ role: 'user', content: text });
      const d = dispatch.assign(app, text, { mode: 'EXPLAIN' });
      assert.strictEqual(await le.take(app, app.session, 0), '', 'never attached');
      await new Promise((r) => setTimeout(r, 20));
      const job = d.jobs.find((j) => j.role === 'ui_evidence_narrower');
      assert.ok(job && job.consumed === false && job.ok === true, JSON.stringify(d.jobs));
    } finally { unstub(); }
    stub('FORCE');
    try {
      const app = appFor();
      const obs = snapshot(); obs.url = 'http://unprepared/';
      const id = store.keep(obs);
      const text = `observation ${id}: find the results container`;
      app.session.messages.push({ role: 'user', content: text });
      dispatch.assign(app, text, { mode: 'EXPLAIN' });
      rt.isHot = () => false;   // the background preparation must not start on a cold model
      const t0 = Date.now();
      assert.strictEqual(await le.take(app, app.session, 0), '');
      assert.ok(Date.now() - t0 < 200, 'no wait');
      assert.strictEqual(app.session.dispatch.jobs[0].bypass, 'NOT_PREPARED');
      assert.deepStrictEqual(embedCalls, [], 'nothing embedded on the task path');
    } finally { unstub(); }
  });
};
