'use strict';

/**
 * ONE ISOLATION CASE — the Toralink read-only diagnostic (2026-09-24).
 *
 *   node bench/readonly-diagnostic/case.js --case A|B|C|D --tag <new-name>
 *        [--project <dir>] [--prompt <file>] [--out <dir>]
 *        [--model M] [--mode forward|canned] [--cap 30] [--max-steps 0]
 *        [--paste 1] [--lain <LAIN tree>]
 *
 *   A  workers OFF, the gpt-oss route
 *   B  Laya + Violetto REGISTERED (forced on, locate on) with INERT executables:
 *      the schemas, the shortlist hook and every gate are real; every load fails,
 *      so no specialist inference can happen (worker calls → bypass)
 *   C  Laya ACTUAL (loaded HOT before the turn), Violetto OFF
 *   D  workers OFF, an alternate model through the same router
 *
 * The project is COPIED (no node_modules/dist) and hashed before and after, so
 * any write — `.lain/` included — is a measured fact. LAIN runs in an isolated
 * home whose one connection points at proxy.js in front of LainRouter; every
 * request body and the router's raw response bytes are kept. `--mode canned`
 * answers locally: the exact assembled request, at zero quota.
 *
 * QUOTA: `--cap` is a hard per-run ceiling enforced by the proxy. One run per
 * case is the protocol; see docs/STATUS.md (2026-09-24) for what it cost.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const CASE = arg('case', 'A');
const TAG = arg('tag', CASE);
const MODE = arg('mode', 'forward');
const MODEL = arg('model', CASE === 'D' ? 'claude-code/claude-haiku-4-5-20251001' : 'ollama-cloud/gpt-oss:120b');
const CAP = Number(arg('cap', '30'));
const MAX_STEPS = Number(arg('max-steps', '0'));
const PASTE = arg('paste', '1');
const LAIN_ROOT = path.resolve(arg('lain', REPO));
const PROJECT = path.resolve(arg('project', path.join(os.homedir(), 'Documents', 'toralink')));
const OUT = path.resolve(arg('out', path.join(REPO, 'bench', 'out', 'readonly-diagnostic')));
const PROMPT = path.resolve(arg('prompt', path.join(OUT, 'prompt.txt')));
const KEY_FROM = arg('key-from', 'lain:127.0.0.1');
const UPSTREAM = arg('upstream', 'http://127.0.0.1:4570');
const PROTOCOL = arg('protocol', 'chat');
const EFFORT = arg('effort', null);
const TIMEOUT_MS = Number(arg('timeout-min', '40')) * 60 * 1000;
// Exists on every Windows machine and is not a model server: a load that runs it fails.
const INERT = process.env.DIAG_INERT_EXE || 'C:/Windows/System32/where.exe';

const SKIP = new Set(['node_modules', 'dist']);
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d); else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
function manifest(root) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[path.relative(root, p).replace(/\\/g, '/')] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  })(root);
  return out;
}
function diffManifest(a, b) {
  return {
    added: Object.keys(b).filter((k) => !(k in a)),
    removed: Object.keys(a).filter((k) => !(k in b)),
    modified: Object.keys(b).filter((k) => k in a && a[k] !== b[k]),
  };
}

(async () => {
  if (!fs.existsSync(PROMPT)) throw new Error(`no prompt at ${PROMPT} (--prompt)`);
  const userCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.lain-v2', 'config.json'), 'utf8'));
  const KEY = MODE === 'canned' ? 'canned' : ((userCfg.connections || {})[KEY_FROM] || {}).apiKey;
  if (!KEY) throw new Error(`no apiKey on connections["${KEY_FROM}"]`);
  const base = path.join(os.tmpdir(), 'lain-diag', TAG);
  if (fs.existsSync(base)) throw new Error(`${base} exists — use a new --tag`);
  const work = path.join(base, 'project');
  const home = path.join(base, 'home');
  const outDir = path.join(OUT, TAG);
  fs.mkdirSync(outDir, { recursive: true });
  copyTree(PROJECT, work);
  const before = manifest(work);

  const proxy = await require('./proxy').start({ dir: path.join(outDir, 'wire'), mode: MODE, cap: CAP, upstream: UPSTREAM });
  const workers = CASE === 'B' ? { laya: { python: INERT }, violetto: { server: INERT } } : {};
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    model: MODEL, connection: 'live', maxSteps: MAX_STEPS, ...(EFFORT ? { effort: EFFORT } : {}),
    trustedPaths: [{ path: work, level: 'TRUSTED', at: new Date().toISOString() }],
    connections: { live: { provider: 'lainrouter', via: 'native', auth: 'api_key', protocol: PROTOCOL, baseUrl: `http://127.0.0.1:${proxy.port}/v1`, apiKey: KEY, models: [MODEL] } },
    workers,
  }, null, 2));
  const hostDir = path.join(base, 'workerhost');
  const ENV = {
    A: { LAIN_WORKERS: 'off', LAIN_LOCATE: 'off', LAIN_WORKER_LAYA: 'off', LAIN_WORKER_VIOLETTO: 'off' },
    B: { LAIN_WORKERS: 'auto', LAIN_LOCATE: 'on', LAIN_WORKER_LAYA: 'on', LAIN_ROLE_SOURCE_FILE_RANKER: 'FORCE', LAIN_WORKER_VIOLETTO: 'on' },
    C: { LAIN_WORKERS: 'auto', LAIN_LOCATE: 'on', LAIN_WORKER_LAYA: 'on', LAIN_ROLE_SOURCE_FILE_RANKER: 'FORCE', LAIN_WORKER_VIOLETTO: 'off' },
    D: { LAIN_WORKERS: 'off', LAIN_LOCATE: 'off', LAIN_WORKER_LAYA: 'off', LAIN_WORKER_VIOLETTO: 'off' },
  }[CASE];
  if (!ENV) throw new Error(`unknown case ${CASE}`);

  // C: Laya must be HOT before step 0, or the 100 ms availability rule bypasses it.
  let prep = null;
  if (CASE === 'C') {
    process.env.LAIN_WORKERHOST_DIR = hostDir;
    Object.assign(process.env, ENV);
    const host = require(path.join(LAIN_ROOT, 'src/workerhost'));
    const rt = require(path.join(LAIN_ROOT, 'src/workerruntime'));
    const t0 = Date.now();
    const app0 = { cfg: { workers: {} } };
    await host.load('laya', rt.spec(app0, 'laya'));
    const w = await host.wait('laya', 15 * 60 * 1000);
    prep = { layaState: w.state, modelReadyMs: Date.now() - t0, modelLoadMs: w.loadMs, ok: w.ok };
    if (!w.ok) throw new Error('laya did not become hot');
    // MODEL HOT != PROJECT READY: the arm starts only when BOTH axes are ready.
    // Preparation cost is recorded here, apart from the timed task.
    const ti = Date.now();
    rt.indexProject(app0, 'laya', work);
    await new Promise((r) => setTimeout(r, 200));
    const ix = await rt.waitProjectIndex(app0, 'laya', work, 30 * 60 * 1000);
    const st = await host.status({ measure: true });
    prep.indexReadyMs = Date.now() - ti;
    prep.index = ix.project;
    prep.residentMB = st.ok && st.workers.laya ? st.workers.laya.residentMB : null;
    prep.modelStateAtStart = st.ok && st.workers.laya ? st.workers.laya.state : null;
    if (prep.modelStateAtStart !== 'HOT_IDLE' || !ix.project || ix.project.state !== 'READY') throw new Error(`arm refused to start: model ${prep.modelStateAtStart}, index ${ix.project && ix.project.state}`);
    console.log('laya ready:', JSON.stringify({ model: prep.modelStateAtStart, index: ix.project.state, files: ix.project.files, build: ix.project.lastBuild }));
  }

  const { prepareCli } = require(path.join(REPO, 'tests/helpers'));
  const p = prepareCli({ cwd: work, configDir: home, env: { LAIN_REQTRACE: path.join(outDir, 'reqtrace.jsonl'), LAIN_BACKOFF_MS: '2000,6000', LAIN_WORKERHOST_DIR: hostDir, DIAG_LAIN_ROOT: LAIN_ROOT, ...ENV } });
  const t0 = Date.now();
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'runner.js'), PROMPT, PASTE], { cwd: work, env: p.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  try { await require(path.join(REPO, 'src/supervisor')).shutdownIn(p.env.LAIN_HOME); } catch { /* none */ }
  if (CASE === 'B' || CASE === 'C') { try { process.env.LAIN_WORKERHOST_DIR = hostDir; await require(path.join(LAIN_ROOT, 'src/workerhost')).shutdown('diagnostic over'); } catch { /* none */ } }
  await proxy.close();
  const fixtureDiff = diffManifest(before, manifest(work));
  fs.writeFileSync(path.join(outDir, 'stdout.txt'), run.stdout);
  fs.writeFileSync(path.join(outDir, 'stderr.txt'), run.stderr);
  const session = require(path.join(REPO, 'bench/metrics')).loadSession(home, run.stdout);
  if (session) fs.writeFileSync(path.join(outDir, 'session.json'), JSON.stringify(session, null, 1));
  // The isolated home holds the router key: it does not outlive the run.
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  // THE LAYA ARM IS VALID ONLY WITH A REAL INFERENCE — a lexical-only substitute is not a Laya run.
  const ws = (session && session.workerStats && session.workerStats.laya) || null;
  const ledger = (session && session.workerLedger) || [];
  const layaRow = ledger.find((r) => r.contract === 'evidence_narrower') || null;
  const layaVerdict = CASE === 'C' ? { calls: ws ? ws.calls : 0, inferences: ws ? ws.inferences : 0, tier: layaRow ? layaRow.tier : null,
    valid: Boolean(ws && ws.inferences >= 1 && layaRow && layaRow.tier === 'laya'), bypass: layaRow ? layaRow.layaBypass : null, timedOut: layaRow ? layaRow.layaTimedOut : null } : null;
  const meta = { case: CASE, tag: TAG, model: MODEL, protocol: PROTOCOL, effort: EFFORT, layaVerdict, mode: MODE, paste: PASTE, cap: CAP, maxSteps: MAX_STEPS, lain: LAIN_ROOT, exit: run.code, wallMs: Date.now() - t0, requests: proxy.count(), wireLog: proxy.log, prep, fixtureDiff };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 1));
  console.log(JSON.stringify({ case: CASE, tag: TAG, exit: run.code, requests: proxy.count(), wallMs: meta.wallMs, fixtureDiff }, null, 1));
})().catch((e) => { console.error('case fatal:', (e && e.stack) || e); process.exitCode = 1; });
