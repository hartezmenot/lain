'use strict';

/**
 * SPECIALIST WORKERS — optional capabilities picked by policy (2026-09-23).
 *
 * Pins: the manifest's identities and the Jev exclusion; the switch semantics
 * (off beats everything, `auto` serves only a use whose gate PASSED, `on`
 * forces for experiments); an unusable worker answers null and never throws;
 * the locate ranker (deterministic tier, silence rules, one ranking per
 * turn, false narrowing measured at settle); `/workers` switching; and that no
 * specialist module can reach another specialist, the network, or authority.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const rt = require('../../src/workerruntime');
const la = require('../../src/locateassist');

const saveEnv = { ...process.env };
function env(k, v) { if (v == null) delete process.env[k]; else process.env[k] = v; }
function restore() { for (const k of ['LAIN_WORKERS', 'LAIN_WORKER_LAYA', 'LAIN_WORKER_PYTHON', 'LAIN_LOCATE', 'LAIN_WORKERHOST']) env(k, saveEnv[k]); }
// THESE PIN THE IN-PROCESS LIFETIME (the fallback); the hosted one is tests/unit/workerhost.test.js.
function inProcess() { env('LAIN_WORKERHOST', 'off'); }

/** An app whose Laya is "installed" at fake paths that exist. */
function fakeApp(workersCfg = {}) {
  const dir = tmpdir('lain-spec-');
  const py = path.join(dir, 'python.exe');
  fs.writeFileSync(py, '');
  fs.mkdirSync(path.join(dir, 'store'));
  return { cfg: { workers: { laya: { python: py, hfHome: path.join(dir, 'store'), ...(workersCfg.laya || {}) }, ...workersCfg, laya: { python: py, hfHome: path.join(dir, 'store'), ...(workersCfg.laya || {}) } } } };
}

function project(n = 16) {
  const root = tmpdir('lain-spec-proj-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'server'));
  fs.writeFileSync(path.join(root, 'server', 'store.js'), '// Workspace settings persisted to a JSON file.\nfunction putSettings() {}\nfunction getSettings() {}\nmodule.exports = { putSettings, getSettings };\n');
  fs.writeFileSync(path.join(root, 'server', 'auth.js'), '// Sign-in against the demo account.\nfunction login() {}\nmodule.exports = { login };\n');
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(root, 'src', `widget${i}.js`), `// Widget number ${i} for the dashboard grid.\nfunction widget${i}() {}\nmodule.exports = { widget${i} };\n`);
  return root;
}

module.exports = async function run() {
  await test('manifest: Laya identified, Violetto RETIRED (history only, never a worker), Jev EXCLUDED with a reason, weights outside the repo', () => {
    const m = rt.manifest();
    assert.strictEqual(m.laya.model, 'convaiinnovations/laya');
    assert.ok(!m.violetto, 'Violetto is not an active worker');
    const retired = rt.retired();
    assert.strictEqual(retired.violetto.status, 'RETIRED');
    assert.match(retired.violetto.sha256, /^[0-9a-f]{64}$/, 'the identity is kept as history');
    assert.strictEqual(m.jev.status, 'EXCLUDED');
    assert.match(m.jev.reason, /proprietary|hosted/i);
    assert.match(m.jev.reason, /NOT Jev/, 'Laya is never presented as Jev');
    for (const w of [m.laya]) assert.ok(!String(w.defaultStore).startsWith(path.join(__dirname, '..', '..')), 'model store is outside the repository');
  });

  await test('switches: off beats everything; auto needs a passed gate; on forces', () => {
    try {
      const app = fakeApp();
      env('LAIN_WORKERS', null); env('LAIN_WORKER_LAYA', null);
      assert.strictEqual(rt.info(app, 'laya').installed, true);
      const gates = rt.manifest().laya.gates || {};
      assert.strictEqual(rt.uses(app, 'laya', 'file_locate'), Boolean(gates.file_locate && gates.file_locate.pass), 'auto follows the recorded gate');
      env('LAIN_WORKER_LAYA', 'on');
      assert.strictEqual(rt.uses(app, 'laya', 'file_locate'), false, 'on does NOT revive the rejected file ranker');
      assert.strictEqual(rt.uses(app, 'laya', 'selection_resolution'), true, 'on forces the live Harness roles');
      env('LAIN_ROLE_SOURCE_FILE_RANKER', 'FORCE');
      assert.strictEqual(rt.uses(app, 'laya', 'file_locate'), true, 'an explicit role override replays the experiment');
      env('LAIN_ROLE_SOURCE_FILE_RANKER', null);
      env('LAIN_WORKERS', 'off');
      assert.strictEqual(rt.uses(app, 'laya', 'file_locate'), false, 'workers off overrides a forced worker');
      env('LAIN_WORKERS', null);
      app.cfg.workers.laya.enabled = 'off'; env('LAIN_WORKER_LAYA', null);
      assert.strictEqual(rt.uses(app, 'laya', 'file_locate'), false);
      assert.strictEqual(rt.uses(app, 'jev', 'decision_intent'), false, 'an excluded worker is never usable');
    } finally { restore(); }
  });

  await test('three caches kept apart: residency (cold load) · result cache (zero inference) · invalidation on a new state', async () => {
    try {
      // A FAKE WORKER speaking the adapter protocol (node standing in for python):
      // counts its own inferences, so a cache hit is provably zero inference.
      const dir = tmpdir('lain-spec-fake-');
      const adapter = path.join(dir, 'fake.js');
      fs.writeFileSync(adapter, [
        "let n = 0; const rl = require('readline').createInterface({ input: process.stdin });",
        "rl.on('line', (l) => { const q = JSON.parse(l);",
        "  if (q.op === 'ping') return setTimeout(() => console.log(JSON.stringify({ id: q.id, ok: true })), 150);",
        "  n += 1; console.log(JSON.stringify({ id: q.id, ok: true, n, ranked: [{ id: 'a' }], usage: { tokens_in: 7, output_chars: 3 } })); });",
      ].join('\n'));
      fs.mkdirSync(path.join(dir, 'store'));
      env('LAIN_WORKER_LAYA', 'on'); inProcess();
      const app = { cfg: { workers: { laya: { python: process.execPath, adapter, hfHome: path.join(dir, 'store') } } } };
      assert.ok(await rt.warm(app, 'laya'));
      const st = rt.stats(app, 'laya');
      assert.ok(st.coldLoadMs >= 100, `cold load measured apart: ${st.coldLoadMs}`);
      assert.strictEqual(st.inferences, 0, 'a load is not an inference');
      const a = await rt.call(app, 'laya', { op: 'rank' }, { cacheKey: 'state-1' });
      const b = await rt.call(app, 'laya', { op: 'rank' }, { cacheKey: 'state-1' });
      assert.strictEqual(a.n, 1);
      assert.ok(b.cached && b.n === 1, 'the same state is served from the result cache');
      assert.strictEqual(st.inferences, 1, 'ZERO inference for the hit');
      assert.strictEqual(st.cacheHits, 1);
      assert.ok(st.cacheLookupUs.length === 2);
      const c = await rt.call(app, 'laya', { op: 'rank' }, { cacheKey: 'state-2' });
      assert.ok(!c.cached && c.n === 2, 'a changed state is re-evaluated, never a stale hit');
      assert.strictEqual(st.tokensIn, 14, 'the worker\'s own token counts, kept per worker');
      rt.settle(app);
      assert.ok(!app._workerProcs.size, 'settled: processes stopped');
    } finally { restore(); }
  });

  await test('Violetto is RETIRED: no role, no dispatch, no prewarm, no flagship tool — even when switched on', () => {
    try {
      const tools = require('../../src/tools');
      const app = { cfg: { workers: {} } };
      env('LAIN_WORKER_VIOLETTO', 'on');
      assert.ok(!tools.names(app).includes('geometry_specialist'), 'never a flagship tool');
      assert.strictEqual(rt.roleMode(app, 'violetto', 'numeric_geometry_solver'), 'OFF', 'no role exists to force');
      assert.strictEqual(rt.info(app, 'violetto'), null, 'not a worker the runtime knows');
      assert.strictEqual(rt.wantsResident(app, 'violetto'), false, 'never loaded');
      const d = require('../../src/dispatch');
      for (const cls of ['UI_GEOMETRY', 'UI_EVIDENCE', 'SELECTION', 'GENERAL']) assert.ok(!d.owners(cls, {}, null, null).some((o) => /violetto/.test(o)), cls);
      const src = ['dispatch.js', 'geometryjob.js', 'locateassist.js', 'layacontext.js', 'tools/index.js'].map((p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', p), 'utf8')).join('\n');
      assert.ok(!/require\('\.\/violettojob'\)|'violetto'\)/.test(src), 'no production code reaches Violetto');
    } finally { restore(); env('LAIN_WORKER_VIOLETTO', saveEnv.LAIN_WORKER_VIOLETTO); }
  });

  await test('an unusable or broken worker answers null — never throws, never waits long', async () => {
    try {
      inProcess();
      const none = { cfg: { workers: { laya: { python: path.join(tmpdir('lain-spec-no-'), 'missing.exe') } } } };
      assert.strictEqual(rt.info(none, 'laya').usable, false);
      assert.strictEqual(await rt.call(none, 'laya', { op: 'ping' }), null);
      // "installed" at an empty file that cannot run: spawn fails, the call resolves null.
      const broken = fakeApp(); env('LAIN_WORKER_LAYA', 'on');
      const t0 = Date.now();
      const r = await rt.call(broken, 'laya', { op: 'ping' }, { timeoutMs: 3000 });
      assert.strictEqual(r, null);
      assert.ok(Date.now() - t0 < 5000);
      rt.stop(broken);
    } finally { restore(); }
  });

  await test('lexical tier: path and compound-name hits lead; stop words do not match', () => {
    const list = [
      { id: 'src/harnesslocation.js', text: 'src/harnesslocation.js — WHERE THE HARNESS IS — root load' },
      { id: 'src/render.js', text: 'src/render.js — the renderer — write paint' },
      { id: 'server/store.js', text: 'server/store.js — Workspace settings persisted — putSettings getSettings' },
    ];
    assert.strictEqual(la.lexical('where is the harness location resolved', list)[0].id, 'src/harnesslocation.js');
    assert.strictEqual(la.lexical('saved settings are stale after a save', list)[0].id, 'server/store.js');
    assert.deepStrictEqual(la.lexical('the of and to', list), []);
  });

  await test('/workers: status, auto/off and per-worker switches go to the person\'s config', () => {
    const out = [];
    const app = { cfg: { workers: {} }, render: { write: (s) => out.push(s) }, session: {} };
    const C = new Proxy({}, { get: () => (s) => s });
    const cmd = require('../../src/workerscommand');
    const saved = require('../../src/config').save;
    require('../../src/config').save = () => {};
    try {
      cmd.run(app, [], { C });
      const text = out.join('');
      assert.match(text, /laya/); assert.match(text, /violetto\s+RETIRED/);
      // INSTALLED ≠ LOADED ≠ PARTICIPATING, per role.
      assert.match(text, /laya\s+runtime installed · not loaded/);
      assert.match(text, /source_file_ranker\s+OFF\s+invoked 0/);
      assert.match(text, /selection_resolver\s+SHADOW\s+invoked 0 · background 0 · critical-path 0/);
      assert.doesNotMatch(text, /Laya ON/i, 'no role-less "on"');
      assert.match(text, /jev\s+EXCLUDED/);
      cmd.run(app, ['off'], { C });
      assert.strictEqual(app.cfg.workers.policy, 'off');
      cmd.run(app, ['laya', 'on'], { C });
      assert.strictEqual(app.cfg.workers.laya.enabled, 'on');
      out.length = 0;
      cmd.run(app, ['jev', 'on'], { C });
      assert.match(out.join(''), /EXCLUDED/);
      assert.ok(!app.cfg.workers.jev, 'an excluded worker cannot be switched on');
    } finally { require('../../src/config').save = saved; }
  });

  await test('isolation: specialist modules cannot reach another worker, the network or authority', () => {
    for (const f of ['workerruntime.js', 'locateassist.js']) {
      // Comments out — but not the `//` of a URL, or the URL check below would be vacuous.
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
      assert.ok(!/require\(['"]\.\/(provider|permissions|capability|authority|goal|plan|subagents|delegate)['"]\)/.test(src), `${f} reaches no authority`);
      if (f === 'workerruntime.js') assert.ok(/http:\/\/127\.0\.0\.1:/.test(src), 'the check sees the loopback URL (not vacuous)');
      // LOOPBACK ONLY: a llama-server worker (Violetto) is reached on 127.0.0.1;
      // no URL to anywhere else may appear in a specialist module.
      const urls = src.match(/https?:\/\/[^\s'"`/]+/g) || [];
      assert.ok(urls.every((u) => /^http:\/\/127\.0\.0\.1:/.test(u)), `${f} reaches only loopback: ${urls.join(', ')}`);
    }
    const py = fs.readFileSync(path.join(__dirname, '..', '..', 'workers', 'laya', 'server.py'), 'utf8');
    assert.ok(!/subprocess|requests\.|urllib|open\([^)]*['"]w/.test(py), 'the Laya adapter spawns nothing, fetches nothing, writes nothing');
    assert.match(py, /HF_HUB_OFFLINE/, 'offline unless downloads are explicitly allowed');
  });
};
