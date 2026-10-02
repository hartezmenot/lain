'use strict';

/**
 * LAYA PROJECT READINESS — model HOT is not project READY (2026-09-24).
 *
 * The Toralink run that motivated this: Laya was hot, a ranking was asked, the
 * adapter embedded every project file inside the 2 s task deadline, missed it,
 * and lexical fallback answered — 0 inferences. These pin the fix, against the
 * REAL worker host and a fake Laya that speaks the adapter protocol (serial,
 * like the Python one; `embed` hashes words into a vector, so a ranking can be
 * checked; load and per-text embedding times are tunable):
 *
 *   - the index is built in the BACKGROUND at attach; a task that arrives while
 *     it builds is BYPASSED at once, and the build is not restarted by it;
 *   - once READY a ranking embeds the QUERY only — no project re-embedding;
 *   - a new host RESTORES the persisted index (no re-embed); one edited file
 *     re-embeds one file; a deleted file leaves the ranking space; a content
 *     change behind an unchanged mtime is still caught; a different embedding
 *     identity rejects the old store;
 *   - the store lives in LAIN's cache, never the project: the project stays
 *     byte-identical, `.lain/` included;
 *   - a dead Laya costs the turn nothing but Laya: deterministic ranking, no retry.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { test, tmpdir } = require('../helpers');

const host = require('../../src/workerhost');
const rt = require('../../src/workerruntime');
const layaindex = require('../../src/layaindex');

const saved = {};
const KEYS = ['LAIN_ROLE_SOURCE_FILE_RANKER', 'LAIN_WORKERHOST_DIR', 'LAIN_WORKERHOST', 'LAIN_WORKER_LAYA', 'LAIN_WORKERS', 'LAIN_LOCATE', 'LAIN_WORKERHOST_GRACE_MS', 'FAKE_LOAD_MS', 'FAKE_EMBED_MS', 'FAKE_SCHEMA'];
function env(k, v) { if (!(k in saved)) saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
function restore() { for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; delete saved[k]; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(40); } return false; }

/** A fake Laya: serial like the Python adapter; `embed` = hashed bag of words, unit length. */
function fakeLaya() {
  const dir = tmpdir('laya-fake-');
  const adapter = path.join(dir, 'fake.js');
  fs.writeFileSync(adapter, [
    "const crypto = require('crypto'); const DIM = 32;",
    "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
    "function vec(t) { const a = new Float32Array(DIM); for (const w of String(t).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) { a[crypto.createHash('md5').update(w).digest()[0] % DIM] += 1; } let n = 0; for (const x of a) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < DIM; i++) a[i] /= n; return a; }",
    "let q = Promise.resolve();",
    "require('readline').createInterface({ input: process.stdin }).on('line', (l) => { const r = JSON.parse(l); q = q.then(() => handle(r)); });",
    "async function handle(r) {",
    "  if (r.op === 'ping') { await sleep(Number(process.env.FAKE_LOAD_MS || 0)); return out({ id: r.id, ok: true, model: 'fake-laya', schema: process.env.FAKE_SCHEMA || 'fake-embed-v1' }); }",
    "  if (r.op === 'crash') process.exit(3);",
    "  if (r.op === 'embed') { const t = r.texts || []; await sleep(Number(process.env.FAKE_EMBED_MS || 0) * t.length); const b = Buffer.alloc(t.length * DIM * 4); t.forEach((x, i) => Buffer.from(vec(x).buffer).copy(b, i * DIM * 4)); return out({ id: r.id, ok: true, dim: DIM, n: t.length, vectors: b.toString('base64'), usage: { embedded: t.length, tokens_in: t.length * 10, input_chars: t.join('').length } }); }",
    "  out({ id: r.id, ok: true });",
    "}",
  ].join('\n'));
  fs.mkdirSync(path.join(dir, 'store'));
  return { adapter, store: path.join(dir, 'store') };
}

/** A small project: 14 source files, a test, docs — enough for the shortlist to engage. */
function project() {
  const root = tmpdir('laya-proj-');
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  put('src/search.js', '// Search handler: runs the title search against every provider\nfunction searchTitles(q) { return q; }\nmodule.exports = { searchTitles };\n');
  put('src/api.js', "// API client: sends the search query to the backend\nconst { searchTitles } = require('./search');\nfunction apiSearch(q) { return searchTitles(q); }\nmodule.exports = { apiSearch };\n");
  for (let i = 0; i < 12; i += 1) put(`src/mod${i}.js`, `// Module ${i}: unrelated bookkeeping for widgets and colours\nfunction helper${i}() { return ${i}; }\nmodule.exports = { helper${i} };\n`);
  put('tests/search.test.js', "// test: search\nrequire('../src/search');\n");
  put('README.md', '# Demo\nA demo project.\n');
  return root;
}

function treeHash(root) {
  const h = crypto.createHash('sha1');
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      h.update(path.relative(root, p));
      if (e.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
    }
  })(root);
  return h.digest('hex');
}

async function fresh({ loadMs = 0, embedMs = 0, schema = null } = {}) {
  const base = tmpdir('laya-host-');
  const d = path.join(base, 'workerhost');
  env('LAIN_WORKERHOST_DIR', d);
  env('LAIN_WORKERHOST', null);
  env('LAIN_WORKERS', null);
  env('LAIN_WORKER_LAYA', 'on');
  env('LAIN_LOCATE', 'on');
  // THE REJECTED RANKER, replayed: only an explicit role override reaches it now.
  env('LAIN_ROLE_SOURCE_FILE_RANKER', 'FORCE');
  env('LAIN_WORKERHOST_GRACE_MS', null);
  env('FAKE_LOAD_MS', String(loadMs));
  env('FAKE_EMBED_MS', String(embedMs));
  env('FAKE_SCHEMA', schema);
  return d;
}

async function kill() {
  await host.pending();
  const ep = host.endpoint();
  await host.shutdown('test over');
  if (ep) { const end = Date.now() + 3000; while (host.alive(ep.pid) && Date.now() < end) await sleep(25); try { process.kill(ep.pid); } catch { /* gone */ } }
}

function appFor(f, root) {
  return { cfg: { workers: { laya: { python: process.execPath, adapter: f.adapter, hfHome: f.store }, locate: 'on' } }, session: { cwd: root, id: 's1', messages: [] } };
}

async function statusOf(root) { const s = await rt.projectIndex({ cfg: {} }, 'laya', root); return s && s.projects && s.projects[0]; }
const rankReq = (root, q = 'search api query backend', gen = null) => {
  const built = layaindex.items(root);
  return { op: 'rank_project', root, query: q, k: 4, generation: gen || built.generation,
    candidates: built.items.filter((i) => /^src\//.test(i.id)).map((i) => ({ id: i.id, textHash: i.textHash })) };
};

module.exports = async function run() {
  // ---- the pure parts ----------------------------------------------------------

  await test('LAYA INDEX: items come from the in-memory index; output, lockfiles and .lain are never embedded; nothing is written', () => {
    const root = project();
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'x');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(root, 'app.min.js'), 'x');
    const before = treeHash(root);
    const b = layaindex.items(root);
    const ids = b.items.map((i) => i.id);
    assert.ok(ids.includes('src/search.js') && ids.includes('src/api.js'));
    for (const no of ['dist/bundle.js', 'package-lock.json', 'app.min.js']) assert.ok(!ids.includes(no), `${no} excluded`);
    // (the walk itself already skips `dist/`; the lockfile and the minified bundle are this filter's)
    assert.ok(b.excluded.generated >= 2, JSON.stringify(b.excluded));
    assert.strictEqual(treeHash(root), before, 'building items wrote nothing into the project (no .lain/)');
    assert.strictEqual((fs.existsSync(path.join(root, '.lain')) || fs.existsSync(path.join(root, '.lain'))), false);
  });

  await test('LAYA INDEX: keyed by CONTENT — an edit, even behind an unchanged mtime, changes the key; a rename is a re-embed', () => {
    const root = project();
    const a = layaindex.items(root);
    const f = path.join(root, 'src', 'api.js');
    const st = fs.statSync(f);
    const src = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, src.replace('apiSearch', 'apiFind__'));   // same length
    fs.utimesSync(f, st.atime, st.mtime);                          // misleading timestamp preserved
    const b = layaindex.items(root);
    const byId = (x) => new Map(x.items.map((i) => [i.id, i]));
    assert.notStrictEqual(byId(a).get('src/api.js').contentHash, byId(b).get('src/api.js').contentHash, 'content fingerprint, not mtime');
    assert.notStrictEqual(a.generation, b.generation);
    const p = layaindex.plan(new Map(a.items.map((i) => [i.id, i])), new Map(a.items.map((i) => [i.id, new Float32Array(2)])), b.items);
    assert.deepStrictEqual(p.embed.map((i) => i.id), ['src/api.js'], 'exactly the edited file');
    fs.renameSync(path.join(root, 'src', 'mod0.js'), path.join(root, 'src', 'moved0.js'));
    const c = layaindex.items(root);
    const q = layaindex.plan(new Map(b.items.map((i) => [i.id, i])), new Map(b.items.map((i) => [i.id, new Float32Array(2)])), c.items);
    assert.deepStrictEqual(q.embed.map((i) => i.id), ['src/moved0.js'], 'the renamed file is re-embedded (its path is part of its text)');
    assert.deepStrictEqual(q.removed, ['src/mod0.js'], 'and the old path leaves the ranking space');
  });

  await test('LAYA INDEX: the store round-trips; a different embedding identity or tampered vectors are REJECTED', () => {
    const dir = path.join(tmpdir('laya-store-'), 'p');
    const byId = new Map([['a.js', { contentHash: 'c1', textHash: 't1' }], ['b.js', { contentHash: 'c2', textHash: 't2' }]]);
    const vecs = new Map([['a.js', Float32Array.from([1, 0, 0])], ['b.js', Float32Array.from([0, 1, 0])]]);
    layaindex.writeStore(dir, { key: 'm|s1|x', dim: 3, root: dir, projectKey: 'k', generation: 'g', byId, vecs });
    const r = layaindex.readStore(dir, 'm|s1|x');
    assert.ok(r.ok);
    assert.deepStrictEqual([...r.vecs.get('b.js')], [0, 1, 0]);
    assert.match(layaindex.readStore(dir, 'm|s2|x').why, /embedding identity changed/);
    const f = path.join(dir, 'vectors.f32');
    const b = fs.readFileSync(f); b[0] ^= 1; fs.writeFileSync(f, b);
    assert.match(layaindex.readStore(dir, 'm|s1|x').why, /do not match/);
  });

  // ---- the host: readiness, bypass, persistence --------------------------------

  await test('LAYA READY: model HOT + index BUILDING → the task is BYPASSED at once and the build is not restarted; then READY → one QUERY inference, no re-embedding', async () => {
    await fresh({ embedMs: 120 });
    const f = fakeLaya();
    const root = project();
    const app = appFor(f, root);
    try {
      assert.ok(rt.indexProject(app, 'laya', root), 'indexing starts without waiting');
      assert.ok(await until(async () => { const p = await statusOf(root); return p && p.state === 'BUILDING'; }), 'BUILDING in the background');
      const t0 = Date.now();
      const r = await rt.call(app, 'laya', rankReq(root), { timeoutMs: 2000 });
      assert.strictEqual(r, null, 'bypassed');
      assert.ok(Date.now() - t0 < 1000, `FAST did not wait for embedding (${Date.now() - t0} ms)`);
      assert.match(String((rt.stats(app, 'laya').bypassStates || []).slice(-1)[0]), /^INDEX_BUILDING$/);
      const runsBefore = (await statusOf(root)).runs;
      assert.ok(await until(async () => { const p = await statusOf(root); return p && p.state === 'READY'; }, 20000), 'READY after the background build');
      const p = await statusOf(root);
      assert.ok(p.runs <= runsBefore + 1, `the bypass did not restart the build (runs ${runsBefore} → ${p.runs})`);
      assert.ok(layaindex.readyForTask('HOT_IDLE', p, null));
      const embeddedSoFar = p.metrics.embedded;
      const r2 = await rt.call(app, 'laya', rankReq(root), { timeoutMs: 2000 });
      assert.ok(r2 && r2.ranked.length, 'a real ranking');
      assert.strictEqual(r2.usage.embedded, 1, 'the query, and only the query, was embedded');
      assert.ok(r2.ranked.slice(0, 2).some((x) => /src\/(api|search)\.js/.test(x.id)), JSON.stringify(r2.ranked));
      assert.strictEqual(rt.stats(app, 'laya').inferences, 1);
      assert.strictEqual((await statusOf(root)).metrics.embedded, embeddedSoFar, 'no project re-embedding');
    } finally { await kill(); restore(); }
  });

  await test('LAYA PERSIST: a new host RESTORES the index (0 embedded); one edited file re-embeds ONE; a deleted file is removed', async () => {
    const d = await fresh();
    const f = fakeLaya();
    const root = project();
    const app = appFor(f, root);
    try {
      rt.indexProject(app, 'laya', root);
      assert.ok(await until(async () => { const p = await statusOf(root); return p && p.state === 'READY'; }));
      const first = (await statusOf(root)).metrics;
      assert.strictEqual(first.restored, false);
      assert.ok(first.embedded >= 14, JSON.stringify(first));
      const cache = layaindex.cacheRoot(d);
      assert.ok(fs.existsSync(path.join(cache, layaindex.projectKey(root), 'vectors.f32')), 'persisted in LAIN\'s cache');
      assert.ok(!path.resolve(cache).toLowerCase().startsWith(path.resolve(root).toLowerCase()), 'never inside the project');
      await kill();
      // REOPEN: a brand-new host, the same unchanged project.
      await fresh();
      env('LAIN_WORKERHOST_DIR', d);
      rt.indexProject(app, 'laya', root);
      assert.ok(await until(async () => { const p = await statusOf(root); return p && p.state === 'READY'; }));
      const again = (await statusOf(root)).metrics;
      assert.strictEqual(again.restored, true);
      assert.strictEqual(again.embedded, 0, 'no re-index on reopen');
      assert.strictEqual(again.reused, first.embedded);
      // ONE FILE CHANGES.
      fs.appendFileSync(path.join(root, 'src', 'mod3.js'), 'function extraSymbol() {}\n');
      fs.unlinkSync(path.join(root, 'src', 'mod4.js'));
      const r = await rt.call(app, 'laya', rankReq(root), { timeoutMs: 2000 });
      assert.ok(r, 'the stale-but-usable index still answers, from unchanged files only');
      assert.ok(await until(async () => { const p = await statusOf(root); return p && p.state === 'READY' && p.metrics && p.metrics.embedded === 1; }), 'the refresh ran after the answer');
      const inc = (await statusOf(root)).metrics;
      assert.strictEqual(inc.embedded, 1, 'one embedding refreshed');
      assert.strictEqual(inc.removed, 1, 'the deleted file left the index');
      assert.strictEqual(inc.reused, first.embedded - 2);
      const r2 = await rt.call(app, 'laya', rankReq(root, 'bookkeeping widgets helper'), { timeoutMs: 2000 });
      assert.ok(!r2.ranked.some((x) => x.id === 'src/mod4.js'), 'no dead candidate');
    } finally { await kill(); restore(); }
  });

  await test('LAYA VERSION: a changed embedding identity rejects the stored index and rebuilds it', async () => {
    const d = await fresh();
    const f = fakeLaya();
    const root = project();
    const app = appFor(f, root);
    try {
      rt.indexProject(app, 'laya', root);
      assert.ok(await until(async () => { const p = await statusOf(root); return p && p.state === 'READY'; }));
      await kill();
      await fresh({ schema: 'fake-embed-v2' });
      env('LAIN_WORKERHOST_DIR', d);
      rt.indexProject(app, 'laya', root);
      assert.ok(await until(async () => { const p = await statusOf(root); return p && p.state === 'READY'; }));
      const m = (await statusOf(root)).metrics;
      assert.match(String(m.rejected), /embedding identity changed/);
      assert.strictEqual(m.restored, false);
      assert.ok(m.embedded >= 14, 'every file re-embedded by the new encoder');
    } finally { await kill(); restore(); }
  });

  await test('LAYA THROUGH THE TURN HOOK: READY → by "laya", one inference, the slice recorded; the project stays byte-identical (.lain included)', async () => {
    await fresh();
    const f = fakeLaya();
    const root = project();
    const before = treeHash(root);
    const app = appFor(f, root);
    const la = require('../../src/locateassist');
    try {
      la.prewarm(app);
      assert.ok(await until(async () => { const p = await statusOf(root); return p && p.state === 'READY'; }), 'prewarm prepared the project');
      app.session.messages = [{ role: 'user', content: 'READ-ONLY. Trace how the search query goes from the API client to the search handler.\nDo not:\n\n- add tests\n- change widgets\n' }];
      const text = await la.take(app, app.session, 0);
      // ORDINARY EVIDENCE: the flagship is not told which worker produced it (dispatch.js); the ledger row is.
      assert.match(text, /^# Likely relevant files \(\d+ ranked\)/);
      assert.doesNotMatch(text, /laya|locate assist/i);
      assert.match(text, /narrows project EVIDENCE; the request, its constraints and the output it asks for are unchanged/);
      const row = app.session.workerLedger.slice(-1)[0];
      assert.strictEqual(row.tier, 'laya');
      assert.ok(row.candidateCount >= 2 && row.layaRanked.length >= 2, JSON.stringify(row));
      assert.strictEqual(row.layaIndex.queryOnly, true);
      assert.strictEqual(rt.stats(app, 'laya').inferences, 1);
      assert.ok(row.slice.slice(0, 3).some((id) => /src\/(api|search)\.js/.test(id)), JSON.stringify(row.slice));
      assert.ok(!row.slice.slice(0, 2).includes('tests/search.test.js'), 'the test file is not the lead for a behaviour trace');
      assert.strictEqual(treeHash(root), before, 'project byte-identical');
      assert.strictEqual((fs.existsSync(path.join(root, '.lain')) || fs.existsSync(path.join(root, '.lain'))), false);
    } finally { await kill(); restore(); }
  });

  await test('LAYA FAILURE: a dead worker costs the turn nothing but Laya — deterministic slice, no retry', async () => {
    await fresh();
    const f = fakeLaya();
    const root = project();
    const app = appFor(f, root);
    const la = require('../../src/locateassist');
    try {
      rt.indexProject(app, 'laya', root);
      assert.ok(await until(async () => { const p = await statusOf(root); return p && p.state === 'READY'; }));
      await rt.call(app, 'laya', { op: 'crash' }, { timeoutMs: 500 });
      assert.ok(await until(async () => { const s = await host.status(); return s.ok && s.workers.laya.state === 'FAILED'; }));
      app.session.messages = [{ role: 'user', content: 'Trace how the search query goes from the API client to the search handler.' }];
      const callsBefore = rt.stats(app, 'laya').calls;
      const t0 = Date.now();
      const text = await la.take(app, app.session, 0);
      assert.ok(Date.now() - t0 < 1500, 'no wait');
      assert.match(text, /^# Likely relevant files/);
      assert.notStrictEqual(app.session.workerLedger.slice(-1)[0].tier, 'laya', 'answered without Laya');
      assert.strictEqual(rt.stats(app, 'laya').calls - callsBefore, 1, 'one attempt, no retry');
    } finally { await kill(); restore(); }
  });
};
