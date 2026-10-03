'use strict';

/**
 * THE LAYA PROJECT INDEX, MEASURED WITH THE REAL MODEL (no provider quota).
 *
 *   node bench/readonly-diagnostic/laya-index.js [--project <dir>] [--query-file <file>]
 *
 * On a COPY of the project (the original is never touched):
 *   1. first build     cold host, model load, background index build
 *   2. reopen          a brand-new host: model load, then RESTORE (no re-embed)
 *   3. task inference  one rank_project against the restored index
 *   4. incremental     one source file edited → one embedding refreshed
 * Writes bench/out/laya-index/<stamp>.json.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const SRC = path.resolve(arg('project', path.join(os.homedir(), 'Documents', 'toralink')));
const QUERY_FILE = arg('query-file', path.join(REPO, 'tools', 'dev', 'bench', 'out', 'readonly-diagnostic', 'prompt.txt'));

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-index-'));
const work = path.join(base, 'project');
const hostDir = path.join(base, 'workerhost');
process.env.LAIN_WORKERHOST_DIR = hostDir;
process.env.LAIN_WORKERS = 'auto';
process.env.LAIN_WORKER_LAYA = 'on';
process.env.LAIN_WORKER_VIOLETTO = 'off';

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d); else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

(async () => {
  copyTree(SRC, work);
  const host = require(path.join(REPO, 'src/workerhost'));
  const rt = require(path.join(REPO, 'src/workerruntime'));
  const la = require(path.join(REPO, 'src/locateassist'));
  const layaindex = require(path.join(REPO, 'src/layaindex'));
  const app = { cfg: { workers: {} } };
  const out = { project: SRC, copy: work, cache: layaindex.cacheRoot(hostDir), at: new Date().toISOString() };

  async function phase(name) {
    const t0 = Date.now();
    // THE LOAD IS ACCEPTED FIRST, so the wait below has a worker to wait for.
    await host.load('laya', rt.spec(app, 'laya'));
    rt.indexProject(app, 'laya', work);
    const w = await host.wait('laya', 15 * 60 * 1000);
    const modelReadyMs = Date.now() - t0;
    const ix = await rt.waitProjectIndex(app, 'laya', work, 30 * 60 * 1000);
    const readyForTaskMs = Date.now() - t0;
    const st = await host.status({ measure: true });
    out[name] = { modelState: w.state, modelLoadMs: w.loadMs, modelReadyMs, readyForTaskMs, indexAfterModelMs: readyForTaskMs - modelReadyMs,
      residentMB: st.ok ? st.workers.laya.residentMB : null, index: ix.project };
    console.log(name, JSON.stringify({ modelReadyMs, readyForTaskMs, state: ix.project && ix.project.state, m: ix.project && ix.project.metrics }));
  }

  // 1. FIRST BUILD
  await phase('firstBuild');
  // 2. REOPEN: a new host process, same unchanged project
  const ep = host.endpoint();
  await host.shutdown('reopen');
  { const end = Date.now() + 15000; while (ep && host.alive(ep.pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); }
  await phase('reopen');
  // 3. ONE TASK INFERENCE on the restored index
  const brief = fs.existsSync(QUERY_FILE) ? fs.readFileSync(QUERY_FILE, 'utf8') : 'Trace how a search goes from the frontend through the API to the backend search and back.';
  const built = layaindex.items(work);
  const intent = la.intentText(brief);
  const cands = la.candidates(intent, built.items, la.CANDIDATES, work);
  const t0 = Date.now();
  const r = await rt.call(app, 'laya', { op: 'rank_project', root: work, query: intent.slice(0, 600), k: 8, generation: built.generation,
    candidates: cands.map((c) => ({ id: c.id, textHash: c.textHash })) }, { timeoutMs: 2000 });
  out.taskInference = { wallMs: Date.now() - t0, ok: Boolean(r), hostMs: r && r.ms, usage: r && r.usage, candidates: cands.length, ranked: r && r.ranked, stats: rt.stats(app, 'laya') };
  console.log('taskInference', JSON.stringify({ wallMs: out.taskInference.wallMs, ok: out.taskInference.ok, usage: r && r.usage, top: r && r.ranked.slice(0, 8).map((x) => x.id) }));
  // 4. INCREMENTAL: one source file edited
  const target = built.items.find((i) => /\.(tsx?|jsx?)$/.test(i.id) && !/test/.test(i.id));
  fs.appendFileSync(path.join(work, target.id), '\nexport function benchIncrementalMarker() { return 1; }\n');
  const ti = Date.now();
  rt.indexProject(app, 'laya', work);
  await new Promise((r2) => setTimeout(r2, 300));
  const inc = await rt.waitProjectIndex(app, 'laya', work, 10 * 60 * 1000);
  out.incremental = { edited: target.id, wallMs: Date.now() - ti, index: inc.project };
  console.log('incremental', JSON.stringify({ edited: target.id, m: inc.project && inc.project.metrics }));
  await host.shutdown('bench over');
  const dir = path.join(REPO, 'tools', 'dev', 'bench', 'out', 'laya-index');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('wrote', path.relative(REPO, file));
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
})().catch((e) => { console.error('fatal', e && e.stack || e); process.exitCode = 1; });
