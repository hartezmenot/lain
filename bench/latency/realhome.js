'use strict';

/**
 * NOEMA OVERHEAD WITH THE PERSON'S REAL HOME — zero quota.
 *
 *   node bench/latency/realhome.js [--n 10]
 *
 * The real config, accounts, connections, supervisor and project state, but the model selection is pointed (IN
 * MEMORY ONLY, config.save disabled) at the zero-latency fake model. Whatever the sandbox bench does not see — a
 * home with many connections, DPAPI credential reads, a long-lived supervisor — shows up here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const ROOT = path.join(__dirname, '..', '..');
const N = Number((process.argv.indexOf('--n') >= 0 && process.argv[process.argv.indexOf('--n') + 1]) || 10);

(async () => {
  const server = await require('./fakemodel').start();
  process.chdir(ROOT);
  const config = require(path.join(ROOT, 'src', 'config'));
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'noema-realhome-')));
  fs.writeFileSync(path.join(proj, 'a.txt'), 'alpha\n');
  const realLoad = config.load;
  config.save = () => {};
  config.load = (...a) => {
    const c = realLoad(...a);
    c.connections = { ...(c.connections || {}), bench: { provider: 'bench', protocol: 'chat', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'bench-key', models: [{ id: 'bench-model', ctx: 128000 }] } };
    c.connection = 'bench'; c.model = 'bench-model'; c.family = null; c.account = null;
    c.trustedPaths = [...(c.trustedPaths || []), { path: proj, level: 'TRUSTED', at: new Date().toISOString() }];
    c.dashAutostart = false;
    return c;
  };
  const tReq = performance.now();
  const { App } = require(path.join(ROOT, 'src', 'app'));
  const requireMs = performance.now() - tReq;
  const app = new App({ cwd: proj, interactive: false, out: { write() {}, on() {}, columns: 100, isTTY: false } });
  await app.prepare();
  const perf = require(path.join(ROOT, 'src', 'perfmark'));
  const rows = [];
  for (let i = 0; i < N; i++) {
    const from = server.log.length;
    const t0 = performance.now();
    await app.submit(i % 2 ? 'TOOL:read_file {"path":"a.txt"}' : 'reply OK');
    const t1 = performance.now();
    const reqs = server.log.slice(from).filter((e) => /chat\/completions/.test(e.url));
    rows.push({ kind: i % 2 ? 'read' : 'ok', total: +(t1 - t0).toFixed(1), pre: reqs[0] ? +(reqs[0].arrived - t0).toFixed(1) : null, post: reqs.length ? +(t1 - reqs[reqs.length - 1].sent).toFixed(1) : null, marks: perf.read() });
  }
  await server.close();
  try { await require(path.join(ROOT, 'src', 'harnesslink')).shutdown(app); } catch { /* best effort */ }
  process.stdout.write(`${JSON.stringify({ requireMs: +requireMs.toFixed(1), rssMB: Math.round(process.memoryUsage().rss / 1048576), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), rows }, null, 1)}\n`);
  setTimeout(() => process.exit(0), 300).unref();
})().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
