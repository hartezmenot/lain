'use strict';

/**
 * CORE ASSIGNS; CAPABILITIES DO NOT VOLUNTEER (2026-09-24).
 *
 * migration_plan was on every request and fired on "move the button to the
 * right"; Laya ranked files nobody asked it to; Violetto was a flagship tool.
 * These pin the fix: one deterministic assignment per input (dispatch.js),
 * specialists as bounded jobs with per-role modes, and the steer's acceptance
 * scenarios A–E.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

process.env.LAIN_CONFIG_DIR = process.env.LAIN_CONFIG_DIR || tmpdir('lain-dispatch-home-');

const dispatch = require('../../src/dispatch');
const tools = require('../../src/tools');
const rt = require('../../src/workerruntime');

function appFor(cwd, extra = {}) {
  return { cfg: { workers: {} }, session: { id: `s-${Date.now()}`, cwd, messages: [], turns: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0 }, ...extra }, abort: new AbortController() };
}
function assign(app, text) {
  app.session.messages.push({ role: 'user', content: text });
  return dispatch.assign(app, text, { mode: require('../../src/mode').classify(text).mode });
}
const saved = {};
function env(k, v) { if (!(k in saved)) saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
function restore() { for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; delete saved[k]; } }

module.exports = async function run() {
  // ---------------------------------------------------------------- migration --

  await test('MIGRATION IS A STATE TRANSITION: the steer\'s valid triggers are eligible, and name both sides', () => {
    const yes = {
      'move persistence from JSON to SQLite while keeping old state compatible': ['JSON', 'SQLite'],
      'Change Agent B from React to Vue': ['React', 'Vue'],
      'replace the webpack build with vite': ['webpack build', 'vite'],
      'upgrade the IPC message schema from v1 to v2': ['v1', 'v2'],
      'move the auth module from core to server': ['core', 'server'],
      'switch storage from localStorage to IndexedDB': ['localStorage', 'IndexedDB'],
    };
    for (const [s, [from, to]] of Object.entries(yes)) {
      const t = dispatch.migrationTransition(s);
      assert.ok(t.eligible, `${s} → ${JSON.stringify(t)}`);
      assert.strictEqual(t.current, from, s);
      assert.strictEqual(t.target, to, s);
      assert.ok(t.boundary, 'a boundary is named');
    }
    for (const s of ['Migrate this C++ implementation to Python', 'merge these three coding agents into one', 'split the repository into two repos',
      'rewrite the scanner in Rust', 'migrate the tests to the new runner',
      'replace all local UI geometry tokens with a new centralized design-token system while preserving compatibility']) {
      assert.ok(dispatch.migrationTransition(s).eligible, s);
    }
    assert.strictEqual(dispatch.migrationTransition(Object.keys(yes)[0]).compatibility, true, 'the compatibility requirement is carried');
  });

  await test('MULTI-FILE ≠ MIGRATION, COMPLEX ≠ MIGRATION: ordinary work and value changes are never eligible', () => {
    for (const s of [
      'make button 10% smaller', 'the send button is too tall compared with input', 'trace search flow', 'inspect this broken UI using Computer',
      'change the padding to 8px', 'move the button to the right', 'turn the toggle into a switch', 'change this button into a lever',
      'convert the width to rem', 'switch the theme to dark', 'change the loader to read the JSON', 'fix tool routing so web goes to the web tool',
      'rename the config key to timeoutMs', 'update the CSS for the header', 'add a test for the parser', 'edit one function to return early',
      'refactor the search module into smaller functions', 'move the settings button from the header to the sidebar',
      'change the dev server port from 3000 to 4000', 'implement the export feature across the server, the client and the tests',
    ]) {
      const t = dispatch.migrationTransition(s);
      assert.strictEqual(t.eligible, false, `${s} → ${JSON.stringify(t)}`);
      assert.ok(t.why, 'the refusal says why');
    }
  });

  await test('migration_plan is NOT flagship vocabulary by default — only for an eligible input or a migration in flight', async () => {
    const cwd = tmpdir('lain-dispatch-mig-');
    const app = appFor(cwd);
    assert.ok(!tools.names(app).includes('migration_plan'), 'no assignment: not offered');
    assign(app, 'make the header padding 8px and update the tests');
    for (const n of ['migration_plan', 'migration_verify', 'migration_activate']) assert.ok(!tools.names(app).includes(n), n);
    const r = await tools.execute('migration_plan', { request: 'x' }, { app, cwd, session: app.session });
    assert.ok(r.isError && /not offered for this task/.test(r.output), r.output);
    assign(app, 'move persistence from JSON to SQLite while keeping old state compatible');
    assert.ok(tools.names(app).includes('migration_plan'), 'eligible: offered');
    assert.ok(tools.schemas(app).some((s) => s.name === 'migration_verify'));
    // IN FLIGHT: a later, ordinary input still sees the tools that finish the migration.
    app.session.dispatch = null;
    assign(app, 'continue');
    const d = app.session.dispatch;
    assert.strictEqual(d.migration.eligible, false);
    assert.strictEqual(d.migration.offered, d.migration.inFlight);
  });

  await test('the base prompt no longer advertises migration_plan; the MIGRATE guidance still teaches it', () => {
    const p = require('../../src/prompt');
    const base = String(p.SYSTEM_PROMPT || p.BASE || '');
    if (base) assert.ok(!/migration_plan/.test(base), 'not in the always-on prompt');
    assert.match(p.MODE_GUIDANCE.MIGRATE, /migration_plan/);
    assert.strictEqual(require('../../src/mode').classify('move the button to the right').mode === 'MIGRATE', false);
  });

  await test('MIGRATION TELEMETRY: eligibility, trigger, transition, invocation and use are recorded per input', () => {
    const app = appFor(tmpdir('lain-dispatch-tel-'));
    const d = assign(app, 'Change Agent B from React to Vue');
    assert.strictEqual(d.migration.trigger, 'from-to');
    dispatch.settle(app.session, { actions: [{ name: 'migration_plan', ok: true }, { name: 'read_file', ok: true }, { name: 'write_file', ok: true }, { name: 'migration_verify', ok: true }] });
    assert.strictEqual(d.migration.invoked, 1);
    assert.strictEqual(d.migration.used, true);
    assign(app, 'move the button to the right');
    dispatch.settle(app.session, { actions: [] });
    const s = dispatch.summary(app.session);
    assert.strictEqual(s.migration.eligible, 1);
    assert.strictEqual(s.migration.invoked, 1);
    assert.strictEqual(s.migration.used, 1);
    assert.strictEqual(s.migration.triggers['to:value'], 1, JSON.stringify(s.migration.triggers));
  });

  // ------------------------------------------------------------ the tool surface --

  await test('TOOL SURFACE: no specialist or other-surface machinery in an ordinary coding request', () => {
    const app = appFor(tmpdir('lain-dispatch-surf-'));
    assign(app, 'fix the failing parser test');
    const names = tools.names(app);
    for (const n of ['geometry_specialist', 'migration_plan', 'migration_verify', 'migration_activate', 'hand_to_coding_agent']) assert.ok(!names.includes(n), n);
    app.session._botTurn = true;
    assert.ok(tools.names(app).includes('hand_to_coding_agent'), 'the IDE BOT still has its handoff');
  });

  // ------------------------------------------------------------- worker roles --

  await test('RECRUITMENT PER ROLE: source ranking OFF and REJECTED (a worker switch cannot revive it); Harness roles SHADOW; one role can be set alone', () => {
    try {
      const app = { cfg: { workers: {} } };
      env('LAIN_WORKER_LAYA', null); env('LAIN_WORKERS', null);
      assert.strictEqual(rt.roleMode(app, 'laya', 'source_file_ranker'), 'OFF');
      for (const r of ['harness_context_compiler', 'selection_resolver', 'cross_surface_correlator', 'session_semantic_enrichment', 'ui_evidence_narrower']) assert.strictEqual(rt.roleMode(app, 'laya', r), 'SHADOW', r);
      assert.strictEqual(rt.roleMode(app, 'laya', 'gug_context_compiler'), 'OFF', 'the old role name is gone, not aliased');
      assert.strictEqual(rt.wantsResident(app, 'laya'), false, 'a default SHADOW role never loads the model by itself');
      env('LAIN_ROLE_UI_EVIDENCE_NARROWER', 'auto');
      assert.strictEqual(rt.roleMode(app, 'laya', 'ui_evidence_narrower'), 'SHADOW', 'AUTO without a passed gate runs as SHADOW');
      env('LAIN_ROLE_UI_EVIDENCE_NARROWER', null);
      env('LAIN_WORKER_LAYA', 'on');
      assert.strictEqual(rt.roleMode(app, 'laya', 'source_file_ranker'), 'OFF', 'forcing the worker does not revive a rejected role');
      assert.strictEqual(rt.roleMode(app, 'laya', 'selection_resolver'), 'FORCE', 'forcing the worker forces its live roles');
      env('LAIN_ROLE_SOURCE_FILE_RANKER', 'FORCE');
      assert.strictEqual(rt.roleMode(app, 'laya', 'source_file_ranker'), 'FORCE', 'only an explicit role override (a benchmark) reaches it');
      env('LAIN_ROLE_SOURCE_FILE_RANKER', null);
      env('LAIN_WORKERS', 'off');
      assert.strictEqual(rt.roleMode(app, 'laya', 'ui_evidence_narrower'), 'OFF');
    } finally { restore(); }
  });

  await test('SPECIALISTS DO NOT SUMMON SPECIALISTS: no worker module reaches another worker or the migration planner', () => {
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8');
    const la = src('layaevidence.js');
    const lc = src('layacontext.js');
    const mi = src('tools/migrate.js');
    assert.ok(!fs.existsSync(path.join(__dirname, '..', '..', 'src', 'violettojob.js')), 'Violetto is retired: no job module');
    assert.ok(!/violettojob|tools\/migrate|migration'\)/.test(la), 'Laya → another worker / migration');
    assert.ok(!/require\('\.\/(?:violettojob|tools|tools\/[\w]+|migration|migrationintent|layaevidence|provider|permissions|mutation)'\)|locateassist'\)\.(?:take|rank)/.test(lc), 'Laya context → another worker / tools / migration / authority');
    assert.ok(!/layaevidence|layacontext|violettojob|locateassist/.test(mi), 'migration_plan → a worker');
    // Results return to Core: every job lands on the assignment's ledger.
    assert.match(la, /dispatch'\)\.job\(/);
  });

  // ------------------------------------------------------ acceptance scenarios --

  await test('SCENARIO A — "make the send button 10% smaller": no migration_plan, no flagship, no worker; Core solves, writes, verifies', async () => {
    const cwd = tmpdir('lain-dispatch-a-');
    fs.writeFileSync(path.join(cwd, 'composer.css'), ':root {\n  --submit-size: 40px;\n}\n.composer .submit { width: var(--submit-size); height: var(--submit-size); }\n');
    const app = appFor(cwd);
    const d = assign(app, 'make the send button 10% smaller');
    assert.strictEqual(d.cls, 'UI_GEOMETRY');
    assert.strictEqual(d.migration.offered, false);
    assert.deepStrictEqual(d.owners, ['deterministic', 'flagship']);
    const g = require('../../src/geometryjob');
    const route = g.routes(app, {});
    assert.ok(route.yes, route.why);
    const events = [];
    for await (const ev of g.run(app, 'make the send button 10% smaller', {}, { plan: route.plan })) events.push(ev);
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.record.verified, 'verified by reading the file back');
    assert.strictEqual(done.record.usage.requests, 0, 'no model request');
    assert.match(fs.readFileSync(path.join(cwd, 'composer.css'), 'utf8'), /--submit-size: 36px;/);
    const job = d.jobs.find((j) => j.worker === 'CORE' && j.role === 'geometry_solver');
    assert.ok(job && job.mode === 'DETERMINISTIC' && job.deterministicSufficient && job.solution, JSON.stringify(d.jobs));
    assert.ok(!d.jobs.some((j) => j.worker === 'VIOLETTO' || j.worker === 'LAYA'), 'no worker took part');
  });

  await test('SCENARIO A, ambiguous: two bindings → no direct write; the flagship gets the partial job as ordinary facts', () => {
    const cwd = tmpdir('lain-dispatch-a2-');
    fs.writeFileSync(path.join(cwd, 'a.css'), '.send { width: 40px; height: 40px; }\n');
    fs.writeFileSync(path.join(cwd, 'b.css'), '.submit-row .submit { width: 32px; height: 32px; }\n');
    const app = appFor(cwd);
    assign(app, 'make the send button 10% smaller');
    const g = require('../../src/geometryjob');
    const route = g.routes(app, {});
    assert.strictEqual(route.yes, false);
    assert.match(route.why, /2 stylesheet bindings/);
    const facts = g.evidence(app.session);
    assert.match(facts, /# Geometry facts \(Core\)/);
    assert.match(facts, /binding: unresolved/);
    assert.doesNotMatch(facts, /violetto|laya/i, 'ordinary evidence, no specialist named');
    assert.match(fs.readFileSync(path.join(cwd, 'a.css'), 'utf8'), /40px/, 'nothing written');
  });

  await test('SCENARIO A, the solver: a square rect keeps its relations exactly (6/6 on the geometry gate)', () => {
    const g = require('../../src/geometryjob');
    const r = g.solveRect({ x: 1146, y: 910, w: 44, h: 44, rel: { square: true, centerY: true, rightInset: 10 } }, { x: 400, y: 900, w: 800, h: 64 }, { scale: 0.9 });
    assert.deepStrictEqual([r.width, r.height, r.x, r.y], [39.6, 39.6, 1150.4, 912.2]);
    assert.deepStrictEqual(r.preserved.sort(), ['centerY', 'rightInset', 'square']);
    assert.strictEqual(g.solveValue(40, { kind: 'scale', scale: 0.9 }), 36);
  });

  await test('SCENARIO B — "the send button is too tall compared with the input": no migration; not arithmetic; flagship gets facts', () => {
    const app = appFor(tmpdir('lain-dispatch-b-'));
    const d = assign(app, 'the send button is too tall compared with the input');
    assert.strictEqual(d.cls, 'UI_GEOMETRY');
    assert.strictEqual(d.migration.offered, false);
    assert.strictEqual(d.geometry.explicit, false);
    assert.strictEqual(d.geometry.related, 'input');
    assert.deepStrictEqual(d.owners, ['deterministic', 'flagship'], 'geometry is Core\'s; no worker is named');
    assert.strictEqual(require('../../src/geometryjob').routes(app, {}).yes, false);
    assert.strictEqual(d.jobs.length, 0, 'allowed is not dispatched: nothing volunteered');
  });

  await test('SCENARIO C — "trace the search flow": no migration, no worker, no Laya file ranking even with the shortlist on', () => {
    try {
      env('LAIN_LOCATE', 'on');
      const app = appFor(tmpdir('lain-dispatch-c-'));
      const d = assign(app, 'trace the search flow from the input to the results');
      assert.strictEqual(d.cls, 'TRACE');
      assert.strictEqual(d.migration.offered, false);
      assert.deepStrictEqual(d.owners, ['deterministic', 'flagship']);
      assert.strictEqual(require('../../src/locateassist').policy(app, app.session).laya, 'off');
    } finally { restore(); }
  });

  await test('SCENARIO D — "move persistence from JSON to SQLite while keeping old state compatible": migration_plan eligible', () => {
    const app = appFor(tmpdir('lain-dispatch-d-'));
    const d = assign(app, 'move persistence from JSON to SQLite while keeping old state compatible');
    assert.strictEqual(d.cls, 'MIGRATION');
    assert.ok(d.migration.eligible && d.migration.compatibility);
    assert.ok(d.owners.includes('migration_planner'));
    assert.strictEqual(require('../../src/mode').classify('move persistence from JSON to SQLite while keeping old state compatible').mode, 'MIGRATE');
  });

  await test('SCENARIO E — "inspect this broken UI using Computer": UI evidence; Laya only as its role mode says (SHADOW: never attached)', async () => {
    const app = appFor(tmpdir('lain-dispatch-e-'));
    const d = assign(app, 'inspect this broken UI using Computer');
    assert.strictEqual(d.cls, 'UI_EVIDENCE');
    assert.ok(d.owners.includes('laya:ui_evidence_narrower'));
    assert.ok(!d.owners.some((o) => o.startsWith('violetto')), 'Violetto is retired');
    assert.strictEqual(d.migration.offered, false);
    assert.strictEqual(await require('../../src/layaevidence').take(app, app.session, 0), '', 'no receipt, SHADOW: nothing attached');
  });
};
