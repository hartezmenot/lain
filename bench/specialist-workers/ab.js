'use strict';

/**
 * SPECIALIST A/B, v3 (2026-09-23) — CONTROL vs LAYA vs LAYA + VIOLETTO on one
 * flagship route; fresh sessions and workspaces; only the specialist switches
 * differ. v2 results (out/ab2-*.json) were produced by the previous version.
 *
 *   node bench/specialist-workers/ab.js --model ollama-cloud/gpt-oss:120b
 *        [--base http://127.0.0.1:4570/v1] [--key-from lain:127.0.0.1]
 *        [--arms control,laya,laya+violetto] [--reps 1]
 *        [--arm-budget 40] [--budget 121] [--timeout-min 50]
 *        [--price-in 0.15 --price-cached 0.014 --price-out 0.60 --price-source "…"]
 *
 *   control         Laya OFF, Violetto OFF, shortlist off. Every deterministic
 *                   tool, AST/symbol lookup, browser and test runner stays —
 *                   the baseline is NOT weakened.
 *   laya            Laya ON in its only LAIN role (the locate shortlist,
 *                   evidence_narrower); Violetto OFF.
 *   laya+violetto   Laya ON; Violetto AVAILABLE (the geometry_specialist tool
 *                   is offered; the flagship decides whether to call it).
 *   violetto        optional: Violetto only.
 *
 * WARM PROTOCOL (§10). Before the timed task of an arm that uses a worker,
 * the worker host loads it and the runner WAITS until it is HOT_IDLE; the
 * cold load is recorded apart from the task. For Laya the embedding memo is
 * cleared, then the project index is embedded on a TWIN copy of the fixture
 * (identical files, so identical items) — the run's own workspace is never
 * touched. A worker an arm does not use is unloaded first. The result cache
 * lives in each LAIN process, so every run starts with an empty one (§26).
 *
 * VALIDITY (§38–39). A run counts only when ALL hold: the model finished
 * (`end`), every request went to the one route/model, it ran the project's
 * tests, it checked the page in a browser, the hidden final smoke ran, it did
 * not stop at the step budget, and no worker result-cache hit leaked into it.
 * Invalid runs are kept, with reasons, and never enter a saving.
 *
 * TOKEN POOLS ARE NEVER SUMMED (§37). Flagship input / cached / uncached /
 * output come from the provider's own per-request receipts; "cache not
 * reported" stays null, never 0. Worker tokens and latencies are separate.
 *
 * QUOTA (§41): a per-arm and a global request budget; LAIN's own step cap
 * holds each run under its arm budget; a route failure or rate limit stops
 * the whole benchmark; no retries, no route/model switching.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCli } = require('../../tests/helpers');
const { collect, loadSession, loadReqtrace, callsOf } = require('../metrics');
const { reset } = require('./reset');
const { score } = require('./acceptance/score');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const MODEL = arg('model', '');
const BASE = arg('base', 'http://127.0.0.1:4570/v1');
const KEY_FROM = arg('key-from', '');
const ARMS = arg('arms', 'control,laya,laya+violetto').split(',');
const REPS = Number(arg('reps', '1'));
const ARM_BUDGET = Number(arg('arm-budget', '40'));
const BUDGET = Number(arg('budget', String(1 + 3 * 40)));
const TIMEOUT = Number(arg('timeout-min', '50')) * 60 * 1000;
const PRICE = {
  inputPerM: Number(arg('price-in', '0.15')), cachedPerM: Number(arg('price-cached', '0.014')), outputPerM: Number(arg('price-out', '0.60')),
  source: arg('price-source', 'ollama.com/pricing, gpt-oss:120b Standard, observed 2026-09-23 (Off-Peak is half; not applied — the off-peak window was not verified)'),
};
// --mock: LAIN's scripted provider, ZERO provider quota — proves the arms, the
// workers and the metrics are wired before any real request is spent.
const MOCK = process.argv.includes('--mock');
function mockScript(arm) {
  const steps = [{ text: 'Reading the spec.', tool_calls: [{ name: 'read_file', input: { path: 'DESIGN.md' } }] }];
  if (/violetto/.test(arm)) steps.push({ text: 'Geometry.', tool_calls: [{ name: 'geometry_specialist', input: { problem: 'A square send button 40 px wide sits in a composer 64 px tall whose top edge is at y=720 and right edge at x=1256 (y grows downward), 12 px inside the right edge and vertically centred. Give its width and top-left corner.', answer_format: 'width=?, x=?, y=?' } }] });
  steps.push({ text: 'Fixing the send button.', tool_calls: [{ name: 'edit_file', input: { path: 'src/styles.css', old: '  width: 44px;\n  height: 36px;', new: '  width: 40px;\n  height: 40px;' } }] });
  steps.push({ text: 'Testing.', tool_calls: [{ name: 'run_bash', input: { command: 'node --test' } }] });
  steps.push({ text: 'Done.' });
  return steps;
}

const PROMPT = [
  'TeamDesk has a batch of reported problems. Fix all of them; DESIGN.md is the spec.',
  '1. The settings page reads like generic AI marketing: emoji everywhere, a purple gradient hero, hype copy, a shouty button, a row of fake metrics with pill badges, a card nested inside a card, oversized rounded corners. Make it match DESIGN.md.',
  '2. Geometry: the send button in the note composer and the avatar in the top bar are the wrong size and position; the composer\'s side margins are unequal; the form controls are different heights (see DESIGN.md).',
  '3. On a phone-sized screen (375 px) the page scrolls sideways.',
  '4. After saving settings, the page shows the old values again until the API server is restarted.',
  '5. The top bar shows "undefined" instead of the user\'s name.',
  '6. Saving twice quickly can leave the older value as the current settings, and the client retries requests that can never succeed.',
  '7. The API log is noisy by default and prints passwords.',
  '8. Signing in: the client posts to /api/login and gets a 404, and any non-empty password is accepted.',
  'Keep existing behaviour working. Run the project\'s tests, and check the page in a browser (desktop and phone width) before you finish.',
].join('\n');

const USES = { control: [], laya: ['laya'], violetto: ['violetto'], 'laya+violetto': ['laya', 'violetto'] };
const ENV = {
  control: { LAIN_LOCATE: 'off', LAIN_WORKER_LAYA: 'off', LAIN_WORKER_VIOLETTO: 'off' },
  laya: { LAIN_LOCATE: 'on', LAIN_WORKER_LAYA: 'on', LAIN_WORKER_VIOLETTO: 'off' },
  violetto: { LAIN_LOCATE: 'off', LAIN_WORKER_LAYA: 'off', LAIN_WORKER_VIOLETTO: 'on' },
  'laya+violetto': { LAIN_LOCATE: 'on', LAIN_WORKER_LAYA: 'on', LAIN_WORKER_VIOLETTO: 'on' },
};

const EDIT = new Set(['edit_file', 'apply_patch', 'write_file', 'append_file', 'insert_at', 'delete_range', 'replace_symbol', 'insert_near_symbol', 'remove_symbol', 'rename_symbol', 'move_file', 'delete_file']);
const EXPLORE = new Set(['list_dir', 'grep', 'glob', 'symbols', 'locate', 'dependents', 'understand', 'file_info', 'concept', 'architecture', 'wiring', 'check_symbols', 'read_file', 'read_symbol']);
const TEST_RUN = /\b(?:test|tests|jest|pytest|vitest|mocha|node --test|npm (?:run )?test)\b/i;
const BROWSER = (c) => c.name === 'request_browser' || c.name === 'observe' || /^chrome/.test(c.name) || c.name === 'harness'
  || (/^run_/.test(c.name) && /playwright|puppeteer|msedge|chromium|headless/i.test(String((c.input && c.input.command) || '')));

function key() {
  if (!KEY_FROM) return '';
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.lain-v2', 'config.json'), 'utf8'));
  const k = ((cfg.connections || {})[KEY_FROM] || {}).apiKey;
  if (!k) throw new Error(`no apiKey on connections["${KEY_FROM}"]`);
  return k;
}
const KEY = MOCK ? '' : key();

async function probe() {
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
      // A REASONING MODEL spends its first tokens thinking: 20 was all reasoning and
      // came back as an empty answer (FAILED_EMPTY_RESPONSE, 2026-09-23).
      body: JSON.stringify({ model: MODEL, max_tokens: 400, stream: false, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
      signal: AbortSignal.timeout(120000),
    });
    const j = await res.json().catch(() => ({}));
    return res.ok && j.choices ? { ok: true, usage: j.usage } : { ok: false, why: `${res.status} ${JSON.stringify(j).slice(0, 200)}` };
  } catch (e) { return { ok: false, why: e.message }; }
}

function rel(root, p) { return path.relative(root, path.resolve(root, String(p || ''))).replace(/\\/g, '/'); }
const resultText = (c) => String((c.result && c.result.content) || '');
const sum = (xs) => xs.reduce((s, x) => s + (Number(x) || 0), 0);
function median(xs) { const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; }

/** Tool metrics: what the flagship asked the tools for, by kind. */
function toolMetrics(calls, root) {
  const reads = calls.filter((c) => c.name === 'read_file');
  const keyOf = (c) => `${rel(root, c.input.path || '')}:${c.input.start_line || c.input.offset || ''}-${c.input.end_line || c.input.limit || ''}`;
  const seen = new Map();
  for (const c of reads) seen.set(keyOf(c), (seen.get(keyOf(c)) || 0) + 1);
  const firstEdit = calls.findIndex((c) => EDIT.has(c.name));
  const byName = {};
  for (const c of calls) byName[c.name] = (byName[c.name] || 0) + 1;
  const cmd = (c) => String((c.input && (c.input.command || c.input.which)) || '');
  return {
    total: calls.length, byName,
    fileReads: reads.length,
    repeatedReads: [...seen.values()].reduce((s, n) => s + Math.max(0, n - 1), 0),
    symbolReads: calls.filter((c) => c.name === 'read_symbol' || c.name === 'locate' || c.name === 'symbols').length,
    browserChecks: calls.filter(BROWSER).length,
    testRuns: calls.filter((c) => c.name === 'run_tests' || (/^run_/.test(c.name) && TEST_RUN.test(cmd(c)))).length,
    exploreBeforeFirstEdit: (firstEdit < 0 ? calls : calls.slice(0, firstEdit)).filter((c) => EXPLORE.has(c.name)).length,
    uniqueFilesRead: new Set(reads.map((c) => rel(root, c.input.path || ''))).size,
  };
}

/** The flagship pool (provider receipts, cached ⊂ input, "not reported" stays null) — flagship.js. */
const flagship = (reqtrace) => require('./flagship').flagship(reqtrace, PRICE);

// ---- the warm protocol (worker host) ------------------------------------------------

function hostApi(hostDir) {
  process.env.LAIN_WORKERHOST_DIR = hostDir;
  process.env.LAIN_WORKER_LAYA = 'on';
  process.env.LAIN_WORKER_VIOLETTO = 'on';
  process.env.LAIN_WORKERS = '';
  return { host: require('../../src/workerhost'), rt: require('../../src/workerruntime'), la: require('../../src/locateassist') };
}

async function prepare(arm, outDir, hostDir, runName) {
  if (MOCK) return { mock: true };
  const { host, rt, la } = hostApi(hostDir);
  const app = { cfg: { workers: {} } };
  const uses = USES[arm];
  const out = { arm, uses, unloaded: [] };
  const st = await host.status();
  for (const id of ['laya', 'violetto']) {
    if (!uses.includes(id) && st.ok && st.workers[id] && st.workers[id].state !== 'UNLOADED') { await host.unload(id, `A/B arm ${arm} does not use it`); out.unloaded.push(id); }
  }
  for (const id of uses) {
    const before = await host.status();
    const was = before.ok && before.workers[id] ? before.workers[id].state : 'UNLOADED';
    const t0 = Date.now();
    await host.load(id, rt.spec(app, id));
    const w = await host.wait(id, 15 * 60 * 1000);
    const m = await host.status({ measure: true });
    out[id] = { wasState: was, alreadyHot: ['HOT_IDLE', 'INFERENCING'].includes(was), prepWaitMs: Date.now() - t0, hostLoadMs: w.loadMs, residentMB: m.ok ? m.workers[id].residentMB : null, state: w.state, reloads: w.reloads };
    if (!w.ok) throw new Error(`${id} did not become ready: ${w.state} ${w.lastError || ''}`);
  }
  if (uses.includes('laya')) {
    const clr = await host.call('laya', { op: 'clear' }, { timeoutMs: 10000 });
    const twin = reset(path.join(os.tmpdir(), 'lain-bench', path.basename(outDir), `${runName}-twin`));
    const items = la.items(twin.dest);
    const t0 = Date.now();
    const r = await host.call('laya', { op: 'rank', query: 'warm', items, k: 1, mode: 'cos' }, { timeoutMs: 10 * 60 * 1000 });
    out.laya.embeddingMemoCleared = clr.ok ? clr.msg.dropped : null;
    out.laya.projectIndex = { items: items.length, ms: Date.now() - t0, tokens: r.ok && r.msg.usage ? r.msg.usage.tokens_in : null, ok: Boolean(r.ok) };
  }
  return out;
}

async function one(arm, rep, outDir, hostDir) {
  const name = `${arm.replace('+', '_')}-${rep}`;
  const runDir = path.join(outDir, name);
  fs.mkdirSync(runDir, { recursive: true });
  // OUTSIDE this repository: a copy inside it would inherit its AGENTS.md walk-up.
  const work = reset(path.join(os.tmpdir(), 'lain-bench', path.basename(outDir), name));
  const prep = await prepare(arm, outDir, hostDir, name);
  const configDir = path.join(runDir, 'home');
  fs.mkdirSync(configDir, { recursive: true });
  // LAIN'S OWN STEP CAP holds the run under its arm budget (2 kept for transport retries).
  const maxSteps = Math.max(5, ARM_BUDGET - 2);
  const connection = KEY
    ? { provider: 'lainrouter', via: 'native', auth: 'api_key', protocol: 'chat', baseUrl: BASE, apiKey: KEY, models: [MODEL] }
    : { provider: 'live-bridge', via: 'bridge', protocol: 'chat', baseUrl: BASE, models: [MODEL] };
  const cfg = { model: MODEL, connection: 'live', maxSteps, trustedPaths: [{ path: work.dest, level: 'TRUSTED', at: new Date().toISOString() }], connections: { live: connection } };
  if (MOCK) cfg.workers = { violetto: { maxTokens: 400 } };
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(cfg, null, 2));
  const reqtraceFile = path.join(runDir, 'reqtrace.jsonl');
  const t0 = Date.now();
  // LAIN_BACKOFF_MS '' = LAIN's REAL retry schedule. runCli (shared with the
  // tests) sets 1 ms waits so tests never sleep; a live run inherited them, and
  // a 16 s router restart spent all 10 retries in ~30 ms (pass 4, 2026-09-23).
  const env = { LAIN_REQTRACE: reqtraceFile, LAIN_WORKERS: '', LAIN_WORKERHOST_DIR: hostDir, ...(MOCK ? {} : { LAIN_BACKOFF_MS: '' }), ...ENV[arm] };
  const run = await runCli(['-p', PROMPT], { cwd: work.dest, configDir, env, timeoutMs: TIMEOUT, ...(MOCK ? { script: mockScript(arm) } : {}) });
  const wallMs = Date.now() - t0;
  fs.writeFileSync(path.join(runDir, 'stdout.txt'), run.stdout);
  fs.writeFileSync(path.join(runDir, 'stderr.txt'), run.stderr);
  const session = loadSession(configDir, run.stdout);
  const reqtrace = loadReqtrace(reqtraceFile);
  const m = session ? collect({ session, reqtrace, wallMs, mode: 'live' }) : null;
  const calls = session ? callsOf(session) : [];
  const turn = session && session.turns && session.turns.length ? session.turns[session.turns.length - 1] : null;
  const stopReason = turn ? turn.stopReason || null : null;
  const routes = [...new Set(reqtrace.map((r) => `${r.connection}|${r.model}`))];
  const routeOk = MOCK ? routes.length === 1 : routes.length === 1 && routes[0] === `live|${MODEL}`;
  const ledger = (session && session.workerLedger) || [];
  const wstats = (session && session.workerStats) || {};
  const tools = toolMetrics(calls, work.dest);
  const narrow = ledger.find((r) => r.contract === 'evidence_narrower') || null;
  let falseNarrowing = null;
  if (narrow && narrow.slice) {
    const inSlice = new Set(narrow.slice);
    const missedReads = calls.filter((c) => c.name === 'read_file' && !inSlice.has(rel(work.dest, c.input.path || '')));
    falseNarrowing = { sliceSize: narrow.slice.length, touched: narrow.touched, hits: narrow.hits, missed: narrow.missed, missedReadCalls: missedReads.length, missedReadChars: missedReads.reduce((s, c) => s + resultText(c).length, 0) };
  }
  const geo = ledger.filter((r) => r.contract === 'geometry_solver');
  const q = score(work.dest);
  const smokeRan = q.checks.some((c) => /SMOKE/i.test(c.id)) || typeof q.finalSmoke === 'boolean';
  const diff = require('child_process').execFileSync('git', ['diff', '--numstat'], { cwd: work.dest, encoding: 'utf8' });
  const diffFiles = diff.trim() ? diff.trim().split('\n').map((l) => { const [a, d, f] = l.split('\t'); return { f, a: Number(a) || 0, d: Number(d) || 0 }; }) : [];
  const layaHits = (wstats.laya && wstats.laya.cacheHits) || 0;
  const invalid = [];
  if (stopReason !== 'end') invalid.push(stopReason === 'max-steps' ? 'request budget reached before completion' : `ended "${stopReason}"`);
  if (!routeOk) invalid.push(`route changed: ${routes.join(', ')}`);
  if (!tools.testRuns) invalid.push('tests required but not run');
  if (!tools.browserChecks) invalid.push('browser verification required but skipped');
  if (!smokeRan) invalid.push('final smoke did not run');
  if (!work.ok) invalid.push('fixture differs');
  // A LEAK is a hit on the run's FIRST ranking — its state was answered before
  // this process asked. A later hit on the same state inside the run (a
  // replayed step 0) is the run's own cache doing its job, and is reported.
  if (narrow && narrow.cacheHit) invalid.push('worker result cache hit on the run\'s first ranking — cache leak');
  const layaRow = narrow && narrow.tier === 'laya' ? narrow : null;
  return {
    arm, rep, exit: run.code, wallMs, stopReason, valid: invalid.length === 0, invalid, routeOk, routes,
    fixture: { ok: work.ok, hash: work.fixtureHash, files: work.files },
    prep,
    flagship: flagship(reqtrace),
    llmFromSession: m ? { providerRequests: m.llm.providerRequests, steps: m.llm.steps, retries: m.llm.retries } : null,
    tools,
    laya: USES[arm].includes('laya') ? {
      invoked: Boolean(narrow), servedBy: narrow ? narrow.tier : null, bypass: narrow ? narrow.layaBypass || null : null, timedOut: narrow ? Boolean(narrow.layaTimedOut) : null,
      calls: wstats.laya ? wstats.laya.calls : 0, inferences: wstats.laya ? wstats.laya.inferences : 0,
      cacheHits: layaHits, cacheMisses: wstats.laya ? wstats.laya.cacheMisses : 0,
      tokensIn: layaRow && layaRow.layaUsage ? layaRow.layaUsage.tokens_in : null,
      tokensEquiv: layaRow && layaRow.layaUsage ? layaRow.layaUsage.tokens_equiv : null,
      outputChars: layaRow && layaRow.layaUsage ? layaRow.layaUsage.output_chars : null,
      outputTokens: 'none — Laya scores items; it generates no tokens',
      warmInferenceMs: layaRow ? layaRow.layaMs : null,
      coldLoadMs: prep.laya ? prep.laya.hostLoadMs : null, alreadyHot: prep.laya ? prep.laya.alreadyHot : null, residentMB: prep.laya ? prep.laya.residentMB : null,
      projectIndex: prep.laya ? prep.laya.projectIndex : null,
      compression: narrow ? { rawEvidenceChars: narrow.rawChars, layaInputChars: narrow.layaUsage ? narrow.layaUsage.input_chars : null, sliceChars: (narrow.slice || []).join('\n').length, flagshipPacketChars: narrow.outChars, ratio: narrow.outChars ? +(narrow.rawChars / narrow.outChars).toFixed(1) : null } : null,
      slice: narrow ? narrow.slice : null,
      falseNarrowing,
    } : null,
    violetto: USES[arm].includes('violetto') ? {
      available: true, invoked: geo.length > 0,
      notInvokedReason: geo.length ? null : 'the flagship never called geometry_specialist (whether it solved the geometry is what the G checks show)',
      calls: geo.length, cacheHits: geo.filter((g) => g.cacheHit).length,
      questions: geo.map((g) => ({ problem: g.problem, answer: g.answer, finish: g.finish, ms: g.ms, bypass: g.bypass, tokensIn: g.tokensIn, tokensOut: g.tokensOut, cached: g.cacheHit })),
      tokensIn: sum(geo.map((g) => g.tokensIn)), tokensOut: sum(geo.map((g) => g.tokensOut)),
      coldLoadMs: prep.violetto ? prep.violetto.hostLoadMs : null, residentMB: prep.violetto ? prep.violetto.residentMB : null,
    } : null,
    quality: {
      acceptance: q.acceptance, finalSmoke: q.finalSmoke, smokeRan, ownTests: q.ownTests.pass, failed: q.checks.filter((c) => !c.ok).map((c) => c.id),
      browser: summaryOf(q.checks, /^(G|S|D|SMOKE)/), responsive: summaryOf(q.checks, /^(R1|G3\.composer\.symmetric375)/), backend: summaryOf(q.checks, /^B/),
      diff: { files: diffFiles.length, added: sum(diffFiles.map((x) => x.a)), removed: sum(diffFiles.map((x) => x.d)) },
    },
  };
}

function summaryOf(checks, re) { const c = checks.filter((x) => re.test(x.id)); return `${c.filter((x) => x.ok).length}/${c.length}`; }

(async () => {
  if (!MODEL && !MOCK) { console.error('--model is required: the flagship route is a decision, not a default'); process.exit(2); }
  const maxTheoretical = 1 + ARMS.length * REPS * ARM_BUDGET;
  console.log(`budget: ${ARMS.length} arm(s) × ${REPS} rep(s) × ≤${ARM_BUDGET} requests + 1 probe = ≤${maxTheoretical} theoretical; global cap ${BUDGET}`);
  const p = MOCK ? { ok: true } : await probe();
  if (!p.ok) { console.error(`model ${MODEL} at ${BASE} does not answer: ${p.why}`); process.exit(2); }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(__dirname, 'out', 'runs', stamp);
  const hostDir = path.join(outDir, 'workerhost');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(__dirname, 'out', `ab3-${MOCK ? 'mock-' : ''}${stamp}.json`);
  const rows = [];
  const spent = { probe: MOCK ? 0 : 1 };
  let total = spent.probe;
  let stopped = null;
  const write = () => fs.writeFileSync(outFile, JSON.stringify({
    model: MODEL, base: BASE, route: KEY ? 'LainRouter (native connection, key from the person\'s LAIN config)' : 'bridge',
    effort: 'unset for every arm (LainRouter refuses reasoning_effort for this model: UNSUPPORTED_REASONING_EFFORT)',
    prompt: PROMPT, price: PRICE,
    budgets: { perArm: ARM_BUDGET, global: BUDGET, maxStepsPerRun: Math.max(5, ARM_BUDGET - 2), maxTheoretical },
    requestsSpent: { ...spent, total }, stopped,
    label: 'EXPLORATORY unless every compared arm has ≥ 3 valid runs', rows,
  }, null, 2));
  write();
  outer: for (let rep = 1; rep <= REPS; rep++) {
    for (const arm of ARMS) {
      if (!ENV[arm]) { console.log(`unknown arm ${arm}`); continue; }
      const left = BUDGET - total;
      if (left < ARM_BUDGET) { stopped = `global budget: ${total}/${BUDGET} spent, ${left} left < one arm budget (${ARM_BUDGET})`; break outer; }
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${arm} #${rep} … (spent ${total}/${BUDGET})`);
      let r;
      try { r = await one(arm, rep, outDir, hostDir); } catch (e) { r = { arm, rep, error: String((e && e.stack) || e).slice(0, 800), valid: false, invalid: ['runner error'] }; }
      const used = (r.flagship && r.flagship.requests) || 0;
      spent[arm] = (spent[arm] || 0) + used;
      total += used;
      rows.push(r);
      write();
      const f = r.flagship || {};
      console.log(`   ${r.valid ? 'VALID' : `INVALID (${(r.invalid || []).join('; ')})`} · ${r.stopReason} · ${Math.round((r.wallMs || 0) / 1000)}s · req ${f.requests} · in ${f.inputTokens} (cached ${f.cachedInputTokens}, uncached ${f.uncachedInputTokens}) out ${f.outputTokens} · $${f.costUSD ? f.costUSD.total : '?'} · acceptance ${r.quality ? `${r.quality.acceptance.pass}/${r.quality.acceptance.total} smoke ${r.quality.finalSmoke}` : r.error}`);
      // THE ROUTE FAILED, OR A LIMIT: stop everything. No retry, no other route.
      if (!r.routeOk || ['provider', 'rate-limited'].includes(r.stopReason) || r.error) {
        stopped = `run ${arm}#${rep} ended "${r.stopReason || r.error}"${r.routeOk === false ? ' with a route change' : ''} — benchmark stopped, partial results kept`;
        break outer;
      }
    }
  }
  try { const { host } = hostApi(hostDir); await host.shutdown('A/B over'); } catch { /* none */ }
  write();
  console.log(`requests: ${JSON.stringify(spent)} total ${total}/${BUDGET}${stopped ? ` · STOPPED: ${stopped}` : ''}`);
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
})();
