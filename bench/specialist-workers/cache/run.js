'use strict';

/**
 * CACHE / RESIDENCY BENCH — no flagship request is made here.
 *
 *   node bench/specialist-workers/cache/run.js [laya|violetto|both]
 *
 * Separates the three things "cache" can mean for a local worker:
 *   B  MODEL RESIDENCY   cold load (process start → model ready) and resident
 *                        memory, then warm inference with the model in memory
 *   C  RESULT CACHE      the same question about the same STATE fingerprint is
 *                        answered from LAIN's result cache with ZERO inference;
 *                        a changed state is a new key and re-evaluates
 * (A, the flagship provider's prompt cache, is measured by the A/B from the
 * provider's own receipts, not here.)
 *
 * Laya goes through the real locate path (locateassist.rank); Violetto through
 * the real `geometry_specialist` tool. Writes out/cache-<worker>.json.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.LAIN_CONFIG_DIR = process.env.LAIN_CONFIG_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'lain-cache-bench-'));
const rt = require('../../../src/workerruntime');
const la = require('../../../src/locateassist');

const OUT = path.join(__dirname, '..', 'out');
const which = process.argv[2] || 'both';

function snap(st) { return { calls: st.calls, inferences: st.inferences, cacheHits: st.cacheHits, cacheMisses: st.cacheMisses, tokensIn: st.tokensIn, tokensOut: st.tokensOut }; }

async function laya() {
  process.env.LAIN_WORKER_LAYA = 'on';
  const app = { cfg: { workers: {} } };
  const root = path.join(__dirname, '..', 'fixture');
  const list = la.items(root);
  const t0 = Date.now();
  const ok = await rt.warm(app, 'laya');
  const st = rt.stats(app, 'laya');
  const res = { worker: 'laya', items: list.length, loaded: ok, coldLoadMs: st.coldLoadMs, memoryMB: st.memoryMB, wallToReadyMs: Date.now() - t0 };
  const q1 = 'the top bar shows undefined instead of the user name';
  const q2 = 'saving settings shows old values until the server restarts';
  let t = Date.now(); let r = await la.rank(app, root, q1, { laya: 'cos', list });
  res.firstInference = { ms: Date.now() - t, layaMs: r.laya && r.laya.ms, usage: r.laya && r.laya.usage, note: 'embeds every item once (the project index)' };
  t = Date.now(); r = await la.rank(app, root, q2, { laya: 'cos', list });
  res.warmInference = { ms: Date.now() - t, layaMs: r.laya && r.laya.ms, usage: r.laya && r.laya.usage, note: 'items already embedded; only the new query runs' };
  const before = snap(st);
  t = Date.now(); r = await la.rank(app, root, q2, { laya: 'cos', list });
  const after = snap(st);
  res.resultCache = { ms: Date.now() - t, cached: r.laya && r.laya.cached, inferencesDuring: after.inferences - before.inferences, lookupUs: st.cacheLookupUs[st.cacheLookupUs.length - 1] };
  const changed = [...list, { id: 'src/new-feature.js', text: 'src/new-feature.js — user name display helper — displayName' }];
  const b2 = snap(st);
  t = Date.now(); r = await la.rank(app, root, q2, { laya: 'cos', list: changed });
  res.invalidation = { ms: Date.now() - t, cached: r.laya && r.laya.cached, inferencesDuring: snap(st).inferences - b2.inferences, note: 'one new file in the listing → a new state key → re-evaluated' };
  res.totals = { ...snap(st), totalInferenceMs: st.totalInferenceMs };
  rt.stop(app);
  return res;
}

async function violetto() {
  process.env.LAIN_WORKER_VIOLETTO = 'on';
  const app = { cfg: { workers: {} }, session: { workerLedger: [] } };
  const tool = require('../../../src/tools/geometry').tools.geometry_specialist;
  const t0 = Date.now();
  const ok = await rt.warm(app, 'violetto');
  const st = rt.stats(app, 'violetto');
  const res = { worker: 'violetto', loaded: ok, coldLoadMs: st.coldLoadMs, memoryMB: st.memoryMB, wallToReadyMs: Date.now() - t0 };
  const ask = async (problem) => {
    const t = Date.now();
    const out = await tool.run({ problem, answer_format: 'width=?, x=?, y=?' }, { app, session: app.session });
    const row = app.session.workerLedger[app.session.workerLedger.length - 1] || {};
    return { ms: Date.now() - t, answer: row.answer, finish: row.finish, tokensIn: row.tokensIn, tokensOut: row.tokensOut, cached: row.cacheHit, output: String(out.output).split('\n')[0] };
  };
  const P1 = 'A square send button 40 px wide sits in a composer bar 64 px tall whose top edge is at y=720 and right edge at x=1256 (screen y grows downward). Its right edge is 12 px inside the bar\'s right edge and it is vertically centred. Give its width and top-left corner.';
  const P2 = 'A square avatar 32 px wide is vertically centred in a top bar 56 px tall whose top edge is at y=0 and right edge at x=1280, with a 16 px right inset. Give its width and top-left corner.';
  res.truth = { P1: 'width=40, x=1204, y=732', P2: 'width=32, x=1232, y=12' };
  res.firstInference = await ask(P1);
  res.warmInference = await ask(P2);
  const before = snap(st);
  res.resultCache = { ...(await ask(P2)), inferencesDuring: snap(st).inferences - before.inferences, lookupUs: st.cacheLookupUs[st.cacheLookupUs.length - 1] };
  const b2 = snap(st);
  res.invalidation = { ...(await ask(P2.replace('16 px right inset', '24 px right inset'))), inferencesDuring: snap(st).inferences - b2.inferences, truth: 'width=32, x=1224, y=12' };
  res.totals = { ...snap(st), totalInferenceMs: st.totalInferenceMs };
  rt.stop(app);
  return res;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const w of which === 'both' ? ['laya', 'violetto'] : [which]) {
    const r = w === 'laya' ? await laya() : await violetto();
    r.at = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, `cache-${w}.json`), JSON.stringify(r, null, 2));
    console.log(JSON.stringify(r, null, 1));
  }
  process.exit(0);
})();
