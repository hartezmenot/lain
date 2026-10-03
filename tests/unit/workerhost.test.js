'use strict';

/**
 * THE WORKER HOST — a specialist model kept HOT between LAIN processes, and
 * never waited for (2026-09-23).
 *
 * Pins, against a fake worker that speaks the Laya adapter protocol:
 *   - LAIN starts the host and a load WITHOUT waiting; the load runs on;
 *   - a decision that arrives while the worker is LOADING is BYPASSED inside
 *     the availability deadline — the FAST rule;
 *   - once HOT_IDLE it answers; HOT_IDLE ≠ INFERENCING; the result cache still
 *     answers with zero inference, apart from residency;
 *   - a LAIN process that exits leaves the model hot for the next one;
 *   - a worker that dies is FAILED, the caller carries on, and restarts are
 *     bounded (no retry loop);
 *   - a killed host costs the caller nothing but the answer;
 *   - no client for the grace window → the host unloads and exits.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { test, tmpdir } = require('../helpers');

const host = require('../../src/workerhost');
const rt = require('../../src/workerruntime');

const saved = {};
const KEYS = ['LAIN_ROLE_SOURCE_FILE_RANKER', 'LAIN_WORKERHOST_DIR', 'LAIN_WORKERHOST', 'LAIN_WORKER_LAYA', 'LAIN_WORKERS', 'LAIN_WORKERHOST_GRACE_MS', 'LAIN_WORKERHOST_TICK_MS', 'FAKE_LOAD_MS'];
function env(k, v) { if (!(k in saved)) saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
function restore() { for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; delete saved[k]; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake Laya: `ping` loads for FAKE_LOAD_MS, `rank` counts, `slow` takes 600 ms, `crash` exits. */
function fakeWorker() {
  const dir = tmpdir('lain-host-fake-');
  const adapter = path.join(dir, 'fake.js');
  fs.writeFileSync(adapter, [
    "let n = 0; const rl = require('readline').createInterface({ input: process.stdin });",
    "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "rl.on('line', (l) => { const q = JSON.parse(l);",
    "  if (q.op === 'ping') return setTimeout(() => out({ id: q.id, ok: true }), Number(process.env.FAKE_LOAD_MS || 0));",
    "  if (q.op === 'crash') process.exit(3);",
    "  if (q.op === 'clear') return out({ id: q.id, ok: true, dropped: 0 });",
    "  n += 1; const r = { id: q.id, ok: true, n, ranked: [{ id: 'a' }], usage: { tokens_in: 7, output_chars: 3 } };",
    "  if (q.slow) return setTimeout(() => out(r), 600); out(r); });",
  ].join('\n'));
  fs.mkdirSync(path.join(dir, 'store'));
  return { dir, adapter, store: path.join(dir, 'store') };
}

function appFor(f) { return { cfg: { workers: { laya: { python: process.execPath, adapter: f.adapter, hfHome: f.store } } } }; }

async function fresh(extra = {}) {
  const d = tmpdir('lain-host-dir-');
  env('LAIN_WORKERHOST_DIR', d);
  env('LAIN_WORKERHOST', null);
  env('LAIN_WORKERS', null);
  env('LAIN_WORKER_LAYA', 'on');
  // THE REJECTED RANKER, replayed: only an explicit role override reaches it now.
  env('LAIN_ROLE_SOURCE_FILE_RANKER', 'FORCE');
  env('LAIN_WORKERHOST_GRACE_MS', extra.grace || null);
  env('LAIN_WORKERHOST_TICK_MS', extra.tick || null);
  env('FAKE_LOAD_MS', String(extra.loadMs == null ? 1200 : extra.loadMs));
  return d;
}

async function kill(d) {
  await host.pending();
  const ep = host.endpoint(d);
  await host.shutdown('test over');
  if (ep) { const until = Date.now() + 3000; while (host.alive(ep.pid) && Date.now() < until) await sleep(25); try { process.kill(ep.pid); } catch { /* gone */ } }
}

async function until(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(30); } return false; }

module.exports = async function run() {
  await test('LAIN starts the host and a load without waiting; a named pipe, never a TCP port', async () => {
    const d = await fresh({ loadMs: 1500 });
    try {
      const app = appFor(fakeWorker());
      const t0 = Date.now();
      assert.strictEqual(rt.prewarm(app, 'laya'), true);
      assert.ok(Date.now() - t0 < 50, `prewarm returned at once (${Date.now() - t0} ms)`);
      assert.ok(await until(async () => { const s = await host.status(); return s.ok && s.workers.laya && s.workers.laya.state === 'LOADING'; }), 'the host is up and LOADING');
      const ep = host.endpoint(d);
      assert.ok(ep && ep.pid !== process.pid, 'a separate process');
      assert.strictEqual(ep.pipe, host.pipeName(d));
      assert.ok(process.platform === 'win32' ? /^\\\\\.\\pipe\\lain-workerhost-[0-9a-f]{12}$/.test(ep.pipe) : ep.pipe.endsWith('host.sock'), ep.pipe);
      assert.ok(await until(async () => (await host.status()).workers.laya.state === 'HOT_IDLE', 5000), 'becomes HOT_IDLE by itself');
      const v = (await host.status()).workers.laya;
      assert.ok(v.loadMs >= 1400, `the load is measured by the host: ${v.loadMs}`);
      assert.strictEqual(v.inferences, 0, 'HOT_IDLE ≠ generating: a load is not an inference');
    } finally { await kill(d); restore(); }
  });

  await test('FAST: a decision while LOADING is bypassed inside the availability deadline; the load carries on', async () => {
    const d = await fresh({ loadMs: 2000 });
    try {
      const app = appFor(fakeWorker());
      rt.prewarm(app, 'laya');
      assert.ok(await until(async () => { const s = await host.status(); return s.ok && s.workers.laya && s.workers.laya.state === 'LOADING'; }));
      const t0 = Date.now();
      const r = await rt.call(app, 'laya', { op: 'rank' }, { timeoutMs: 20000 });
      const waited = Date.now() - t0;
      assert.strictEqual(r, null, 'no answer this time');
      assert.ok(waited < 600, `bypassed quickly (${waited} ms), not after the 2 s load`);
      const st = rt.stats(app, 'laya');
      assert.strictEqual(st.bypasses, 1);
      assert.deepStrictEqual(st.bypassStates, ['LOADING']);
      assert.ok(await until(async () => (await host.status()).workers.laya.state === 'HOT_IDLE', 5000), 'the load finished in the background');
      const next = await rt.call(app, 'laya', { op: 'rank' });
      assert.ok(next && next.n === 1, 'the NEXT decision gets the worker');
    } finally { await kill(d); restore(); }
  });

  await test('the locate shortlist is not held up by a loading Laya — the lexical tier answers and the row says why', async () => {
    const d = await fresh({ loadMs: 3000 });
    env('LAIN_LOCATE', 'on');
    try {
      const f = fakeWorker();
      const root = tmpdir('lain-host-proj-');
      fs.mkdirSync(path.join(root, 'server'));
      fs.writeFileSync(path.join(root, 'server', 'store.js'), '// Workspace settings persisted to a JSON file.\nfunction putSettings() {}\n');
      for (let i = 0; i < 14; i++) fs.writeFileSync(path.join(root, `w${i}.js`), `// Widget ${i}.\nfunction w${i}() {}\n`);
      const app = appFor(f);
      const session = { cwd: root, messages: [{ role: 'user', content: 'saving settings does not persist, check the store' }] };
      app.session = session;
      require('../../src/locateassist').prewarm(app);
      const t0 = Date.now();
      const text = await require('../../src/locateassist').take(app, session, 0);
      assert.ok(Date.now() - t0 < 1500, `no wait for the 3 s load (${Date.now() - t0} ms)`);
      assert.match(text, /server\/store\.js/);
      const row = session.workerLedger[0];
      assert.notStrictEqual(row.tier, 'laya', 'the lexical tier answered (the ledger says so; the text names no worker)');
      assert.strictEqual(row.warmWaitMs, 0);
      assert.ok(['LOADING', 'UNLOADED', 'UNAVAILABLE'].includes(row.layaBypass), `bypass recorded: ${row.layaBypass}`);
    } finally { await kill(d); env('LAIN_LOCATE', null); restore(); }
  });

  await test('HOT_IDLE answers; INFERENCING while it works; the result cache hit costs zero inference in the host', async () => {
    const d = await fresh({ loadMs: 100 });
    try {
      const app = appFor(fakeWorker());
      assert.ok(await rt.warm(app, 'laya'), 'a benchmark may wait for the load');
      const st = rt.stats(app, 'laya');
      assert.ok(st.coldLoadMs >= 90 && st.alreadyHot === false, JSON.stringify({ c: st.coldLoadMs, h: st.alreadyHot }));
      const slow = rt.call(app, 'laya', { op: 'rank', slow: true }, { cacheKey: 's1' });
      assert.ok(await until(async () => (await host.status()).workers.laya.state === 'INFERENCING', 2000), 'INFERENCING while it works');
      const a = await slow;
      assert.strictEqual(a.n, 1);
      assert.strictEqual((await host.status()).workers.laya.state, 'HOT_IDLE', 'back to HOT_IDLE');
      const b = await rt.call(app, 'laya', { op: 'rank' }, { cacheKey: 's1' });
      assert.ok(b.cached, 'the same state is a result-cache hit');
      assert.strictEqual((await host.status()).workers.laya.inferences, 1, 'ZERO host inference for the hit');
      assert.strictEqual(st.cacheHits, 1);
      const app2 = appFor({ adapter: app.cfg.workers.laya.adapter, store: app.cfg.workers.laya.hfHome });
      assert.ok(await rt.warm(app2, 'laya'));
      assert.strictEqual(rt.stats(app2, 'laya').alreadyHot, true, 'residency is not the result cache: a second client finds it hot');
      const c = await rt.call(app2, 'laya', { op: 'rank' }, { cacheKey: 's1' });
      assert.ok(!c.cached && c.n === 2, 'but a new process has its own (empty) result cache');
    } finally { await kill(d); restore(); }
  });

  await test('a request that outruns its deadline is dropped by the caller and finishes in the worker', async () => {
    const d = await fresh({ loadMs: 50 });
    try {
      const app = appFor(fakeWorker());
      assert.ok(await rt.warm(app, 'laya'));
      const t0 = Date.now();
      const r = await rt.call(app, 'laya', { op: 'rank', slow: true }, { timeoutMs: 150 });
      assert.strictEqual(r, null);
      assert.ok(Date.now() - t0 < 1000);
      assert.strictEqual(rt.stats(app, 'laya').timeouts, 1);
      assert.ok(await until(async () => (await host.status()).workers.laya.state === 'HOT_IDLE', 2000), 'the worker finished it and is idle again');
    } finally { await kill(d); restore(); }
  });

  await test('a LAIN process that exits leaves the model hot; the next process pays no load', async () => {
    const d = await fresh({ loadMs: 800 });
    try {
      const f = fakeWorker();
      const script = path.join(tmpdir('lain-host-client-'), 'client.js');
      fs.writeFileSync(script, `const rt = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'workerruntime.js'))});
        rt.warm({ cfg: { workers: { laya: { python: process.execPath, adapter: ${JSON.stringify(f.adapter)}, hfHome: ${JSON.stringify(f.store)} } } } }, 'laya').then((ok) => process.exit(ok ? 0 : 1));`);
      const code = await new Promise((res) => spawn(process.execPath, [script], { env: process.env, stdio: 'ignore' }).on('exit', res));
      assert.strictEqual(code, 0, 'the first client loaded and exited');
      const s = await host.status();
      assert.strictEqual(s.workers.laya.state, 'HOT_IDLE', 'still hot after its client left');
      const pid = s.workers.laya.pid;
      const app = appFor(f);
      const t0 = Date.now();
      const r = await rt.call(app, 'laya', { op: 'rank' });
      assert.ok(r && Date.now() - t0 < 500, 'answered at once');
      assert.strictEqual((await host.status()).workers.laya.pid, pid, 'the same worker process');
      assert.strictEqual((await host.status()).workers.laya.loads, 1, 'no reload');
    } finally { await kill(d); restore(); }
  });

  await test('a worker that dies is FAILED; the caller carries on; restarts are bounded, never a loop', async () => {
    const d = await fresh({ loadMs: 30 });
    try {
      const app = appFor(fakeWorker());
      for (let i = 0; i < 3; i++) {
        assert.ok(await rt.warm(app, 'laya'), `load ${i + 1}`);
        await host.call('laya', { op: 'crash' }, { timeoutMs: 1000 });
        assert.ok(await until(async () => (await host.status()).workers.laya.state === 'FAILED', 2000), 'FAILED');
        const r = await rt.call(app, 'laya', { op: 'rank' });
        assert.strictEqual(r, null, 'a failed worker answers null, never throws');
      }
      const refused = await host.load('laya', rt.spec(app, 'laya'));
      assert.match(String(refused.refused), /restart budget/, 'the fourth start in the window is refused');
      assert.strictEqual((await host.status()).workers.laya.state, 'FAILED');
    } finally { await kill(d); restore(); }
  });

  await test('a killed host costs the caller only the answer; the next prewarm starts a new one', async () => {
    const d = await fresh({ loadMs: 30 });
    try {
      const app = appFor(fakeWorker());
      assert.ok(await rt.warm(app, 'laya'));
      const ep = host.endpoint(d);
      process.kill(ep.pid);
      await until(async () => !host.alive(ep.pid), 3000);
      const t0 = Date.now();
      const r = await rt.call(app, 'laya', { op: 'rank' });
      assert.strictEqual(r, null);
      assert.ok(Date.now() - t0 < 3000, 'no hang');
      assert.strictEqual(rt.stats(app, 'laya').bypassStates.slice(-1)[0], 'UNAVAILABLE', 'a missing host is a bypass, not an error');
      app._hostLoads = null;
      rt.prewarm(app, 'laya');
      assert.ok(await until(async () => { const s = await host.status(); return s.ok && s.workers.laya && s.workers.laya.state === 'HOT_IDLE'; }, 8000), 'a new host, hot again');
      assert.notStrictEqual(host.endpoint(d).pid, ep.pid);
    } finally { await kill(d); restore(); }
  });

  await test('no LAIN client for the grace window → the host unloads and exits (and records why)', async () => {
    const d = await fresh({ loadMs: 30, grace: '600', tick: '200' });
    try {
      const f = fakeWorker();
      const script = path.join(tmpdir('lain-host-client-'), 'client.js');
      fs.writeFileSync(script, `const rt = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'workerruntime.js'))});
        rt.warm({ cfg: { workers: { laya: { python: process.execPath, adapter: ${JSON.stringify(f.adapter)}, hfHome: ${JSON.stringify(f.store)} } } } }, 'laya').then((ok) => process.exit(ok ? 0 : 1));`);
      // THE CLIENT IS A CHILD WHOSE PID DIES — this test process never leases.
      await new Promise((res) => spawn(process.execPath, [script], { env: process.env, stdio: 'ignore' }).on('exit', res));
      const ep = host.endpoint(d);
      assert.ok(ep, 'the host is up');
      assert.ok(await until(async () => !host.alive(ep.pid), 6000), 'exited after the grace window');
      const events = fs.readFileSync(path.join(d, 'events.jsonl'), 'utf8');
      assert.match(events, /"hostExit":"no LAIN client for/);
      assert.match(events, /"to":"UNLOADED"/);
    } finally { await kill(d); restore(); }
  });

  await test('isolation: the host modules reach only loopback and hold no authority', () => {
    for (const f of ['workerhost.js', 'workerhostmain.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
      assert.ok(!/require\(['"]\.\/(provider|permissions|capability|authority|goal|plan|subagents|delegate|turn)['"]\)/.test(src), `${f} reaches no authority`);
      const urls = src.match(/https?:\/\/[^\s'"`/]+/g) || [];
      assert.ok(urls.every((u) => /^http:\/\/127\.0\.0\.1:/.test(u)), `${f} reaches only loopback: ${urls.join(', ')}`);
      assert.ok(!/\.listen\(\s*\d|listen\([^)]*0\.0\.0\.0/.test(src), `${f} opens no TCP listener`);
    }
  });
};
