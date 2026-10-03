'use strict';

/**
 * NOEMA-ADDED LATENCY — measured, not assumed.
 *
 *   node bench/latency/run.js [--n 20] [--only inproc|cli|direct] [--json out.json] [--prof]
 *
 * A zero-latency fake model (fakemodel.js) answers instantly, so every millisecond between "submit" and "the
 * model saw the request", between "the model answered" and "the next request / the turn ended", is time Noema
 * spent. Nothing here contacts a real provider and nothing touches the real home: each run gets a temporary
 * NOEMA_CONFIG_DIR and a temporary trusted project.
 *
 * Scenarios
 *   ok      "reply OK"                      one model step, no tools
 *   read    one read_file, then "done"      two model steps
 *   shell   one run_cmd `echo hi`, "done"   two model steps + a real shell
 *
 * Paths
 *   direct  a bare HTTP request to the fake model (in-process and from a fresh `node`) — the floor
 *   inproc  App.submit in this process (warm Core: what every turn after the first pays)
 *   cli     `node bin/noema.js -p "<prompt>"` cold (process start → model request → exit)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const fake = require('./fakemodel');

const ROOT = (process.argv.indexOf('--root') >= 0 && process.argv[process.argv.indexOf('--root') + 1]) || path.join(__dirname, '..', '..', '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const N = Number(opt('n', 15));
const ONLY = opt('only', '');

const PROMPTS = {
  ok: 'reply OK',
  read: 'TOOL:read_file {"path":"a.txt"}',
  shell: 'TOOL:run_cmd {"command":"echo hi"}',
};

function stats(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!s.length) return { n: 0 };
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { n: s.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
}

function sandbox(port) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noema-lat-'));
  const cfgDir = path.join(base, 'home');
  const cwd = path.join(base, 'proj');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'alpha\nbeta\n');
  const cfg = {
    trustedPaths: [{ path: cwd, level: 'TRUSTED', at: new Date().toISOString() }],
    connections: { bench: { provider: 'bench', protocol: 'chat', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'bench-key', models: [{ id: 'bench-model', ctx: 128000 }] } },
    model: 'bench-model', connection: 'bench',
    ...(opt('profile', '') && opt('profile', '') !== true ? { executionProfile: String(opt('profile', '')).toUpperCase() } : {}),
    telemetry: false,
  };
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(cfg, null, 2));
  return { base, cfgDir, cwd };
}

async function direct(server) {
  const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
  const body = JSON.stringify({ model: 'bench-model', stream: true, messages: [{ role: 'user', content: 'reply OK' }] });
  const inproc = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    await r.text();
    inproc.push(performance.now() - t0);
  }
  const script = `const t0=Date.now();fetch(${JSON.stringify(url)},{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(body)}}).then(r=>r.text()).then(()=>{})`;
  const fresh = [];
  for (let i = 0; i < Math.min(N, 8); i++) {
    const t0 = Date.now();
    // ASYNC: the fake model lives in THIS event loop; spawnSync would deadlock it.
    await new Promise((r) => spawn(process.execPath, ['-e', script], { stdio: 'ignore' }).on('exit', r));
    fresh.push(Date.now() - t0);
  }
  return { inprocRequest: stats(inproc), freshNodeRequest: stats(fresh) };
}

async function inproc(server) {
  const sb = sandbox(server.port);
  process.env.LAIN_CONFIG_DIR = sb.cfgDir;
  process.env.NOEMA_CONFIG_DIR = sb.cfgDir;
  process.env.LAIN_NO_DESKTOP = '1';
  require(path.join(ROOT, 'src', 'boot')).aliasEnv();
  const tReq0 = performance.now();
  const { App } = require(path.join(ROOT, 'src', 'app'));
  const requireMs = performance.now() - tReq0;
  const tNew = performance.now();
  const app = new App({ cwd: sb.cwd, interactive: false });
  app.interactive = false;
  await app.prepare();
  const constructMs = performance.now() - tNew;
  const out = { requireMs: +requireMs.toFixed(1), constructMs: +constructMs.toFixed(1), scenarios: {} };
  const perf = require(path.join(ROOT, 'src', 'perfmark'));
  for (const [name, prompt] of Object.entries(PROMPTS).filter(([k]) => !opt('scenario', '') || k === opt('scenario', ''))) {
    const rows = { total: [], pre: [], post: [], between: [], firstTurn: null, requestBytes: [], tools: [], marks: {} };
    for (let i = 0; i < N + 1; i++) {
      const from = server.log.length;
      perf.reset();
      const t0 = performance.now();
      await app.submit(prompt);
      const t1 = performance.now();
      const reqs = server.log.slice(from).filter((e) => /chat\/completions/.test(e.url));
      if (!reqs.length) { rows.total.push(NaN); continue; }
      const sample = {
        total: t1 - t0,
        pre: reqs[0].arrived - t0,
        post: t1 - reqs[reqs.length - 1].sent,
        between: reqs.slice(1).reduce((a, r, k) => a + (r.arrived - reqs[k].sent), 0),
      };
      if (i === 0) { rows.firstTurn = Object.fromEntries(Object.entries(sample).map(([k, v]) => [k, +v.toFixed(1)])); continue; }   // the first turn of a session is reported apart
      for (const k of ['total', 'pre', 'post', 'between']) rows[k].push(sample[k]);
      rows.requestBytes.push(reqs[0].bytes); rows.tools.push(reqs[0].tools);
      for (const [k, v] of Object.entries(perf.read())) (rows.marks[k] = rows.marks[k] || []).push(v);
    }
    out.scenarios[name] = {
      firstTurn: rows.firstTurn,
      total: stats(rows.total), preRequest: stats(rows.pre), betweenSteps: stats(rows.between), postResponse: stats(rows.post),
      requestBytes: stats(rows.requestBytes), toolSchemas: stats(rows.tools),
      marks: Object.fromEntries(Object.entries(rows.marks).map(([k, v]) => [k, stats(v)])),
    };
  }
  try { await require(path.join(ROOT, 'src', 'harnesslink')).shutdown(app); } catch { /* best effort */ }
  try { require(path.join(ROOT, 'src', 'workerruntime')).settle(app); } catch { /* best effort */ }
  return out;
}

function cliOnce(server, sb, prompt) {
  return new Promise((resolve) => {
    const env = { ...process.env, NOEMA_CONFIG_DIR: sb.cfgDir, LAIN_CONFIG_DIR: sb.cfgDir, LAIN_NO_DESKTOP: '1', NO_COLOR: '1' };
    for (const k of Object.keys(env)) if (/^LAIN_(MOCK|PROVIDER|ISOLATED)/.test(k)) delete env[k];
    const from = server.log.length;
    const t0 = performance.now();
    let firstOut = null;
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'noema.js'), '-p', prompt], { cwd: sb.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => { if (firstOut == null) firstOut = performance.now() - t0; });
    child.stderr.on('data', () => {});
    child.on('exit', () => {
      const t1 = performance.now();
      const reqs = server.log.slice(from).filter((e) => /chat\/completions/.test(e.url));
      resolve({ total: t1 - t0, toRequest: reqs.length ? reqs[0].arrived - t0 : NaN, afterResponse: reqs.length ? t1 - reqs[reqs.length - 1].sent : NaN, firstOut });
    });
  });
}

async function cli(server) {
  const sb = sandbox(server.port);
  const out = {};
  for (const name of ['ok', 'read']) {
    const rows = { total: [], toRequest: [], afterResponse: [], firstOut: [] };
    for (let i = 0; i < Math.min(N, 8); i++) {
      const r = await cliOnce(server, sb, PROMPTS[name]);
      for (const k of Object.keys(rows)) rows[k].push(r[k]);
    }
    out[name] = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, stats(v)]));
  }
  return out;
}

async function main() {
  const server = await fake.start();
  const result = { at: new Date().toISOString(), node: process.version, n: N };
  try {
    if (!ONLY || ONLY === 'direct') result.direct = await direct(server);
    if (!ONLY || ONLY === 'cli') result.cli = await cli(server);
    if (!ONLY || ONLY === 'inproc') result.inproc = await inproc(server);
  } finally { await server.close(); }
  const text = JSON.stringify(result, null, 2);
  process.stdout.write(text + '\n');
  const outFile = opt('json', '');
  if (outFile && outFile !== true) fs.writeFileSync(outFile, text);
  setTimeout(() => process.exit(0), 200).unref();
}

main().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
