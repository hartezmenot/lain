'use strict';

/**
 * THE REAL BINARY AND THE WORKER HOST (2026-09-23): a local worker may never
 * lengthen a turn because it is loading, and a model loaded for one LAIN
 * process is still hot for the next.
 *
 * A fake Laya (node speaking the adapter protocol) takes 30 s to "load". The
 * first `lain -p` must finish long before that, with the shortlist answered
 * deterministically and the bypass recorded. Once the host reports HOT_IDLE,
 * a SECOND process is served by the worker without a reload.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli } = require('../helpers');

const LOAD_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sessionOf(configDir) {
  const dir = path.join(configDir, 'sessions');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return JSON.parse(fs.readFileSync(files[0], 'utf8'));
}

module.exports = async function run() {
  await test('WORKER HOST (real binary): a loading Laya is bypassed, never waited for; the next process finds it hot', async () => {
    const dir = tmpdir('lain-hostcli-');
    const adapter = path.join(dir, 'fake.js');
    fs.writeFileSync(adapter, [
      "const rl = require('readline').createInterface({ input: process.stdin });",
      "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      // THE CURRENT ADAPTER PROTOCOL (layaindex.js, 2026-09-24): `ping` reports the
      // embedding identity, `embed` returns unit vectors (a word-hash bag here).
      "const DIM = 16; const vec = (t) => { const a = new Float32Array(DIM); for (const w of String(t).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) a[[...w].reduce((s, c) => s + c.charCodeAt(0), 0) % DIM] += 1; let n = 0; for (const x of a) n += x * x; n = Math.sqrt(n) || 1; return a.map((x) => x / n); };",
      "rl.on('line', (l) => { const q = JSON.parse(l);",
      "  if (q.op === 'ping') return setTimeout(() => out({ id: q.id, ok: true, model: 'fake-laya', schema: 'fake-embed-v1' }), Number(process.env.FAKE_LOAD_MS));",
      "  if (q.op === 'embed') { const t = q.texts || []; const b = Buffer.alloc(t.length * DIM * 4); t.forEach((x, i) => Buffer.from(vec(x).buffer).copy(b, i * DIM * 4)); return out({ id: q.id, ok: true, dim: DIM, n: t.length, vectors: b.toString('base64'), usage: { tokens_in: 3 * t.length } }); }",
      "  out({ id: q.id, ok: true }); });",
    ].join('\n'));
    fs.mkdirSync(path.join(dir, 'store'));
    const cwd = tmpdir('lain-hostcli-proj-');
    fs.mkdirSync(path.join(cwd, 'server'));
    fs.writeFileSync(path.join(cwd, 'server', 'store.js'), '// Workspace settings persisted to a JSON file.\nfunction putSettings() {}\nmodule.exports = { putSettings };\n');
    for (let i = 0; i < 14; i++) fs.writeFileSync(path.join(cwd, `w${i}.js`), `// Widget ${i}.\nfunction w${i}() {}\nmodule.exports = { w${i} };\n`);
    const hostDir = path.join(dir, 'host');
    const env = { LAIN_WORKER_LAYA: 'on', LAIN_LOCATE: 'on', LAIN_ROLE_SOURCE_FILE_RANKER: 'FORCE', LAIN_WORKERHOST_DIR: hostDir, FAKE_LOAD_MS: String(LOAD_MS) };
    const cfgFor = (name) => {
      const configDir = path.join(dir, name);
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
        trustedPaths: [{ path: cwd, level: 'TRUSTED', at: new Date().toISOString() }],
        workers: { laya: { python: process.execPath, adapter, hfHome: path.join(dir, 'store') } },
      }));
      return configDir;
    };
    const prevDir = process.env.LAIN_WORKERHOST_DIR;
    process.env.LAIN_WORKERHOST_DIR = hostDir;
    const host = require('../../src/workerhost');
    try {
      const c1 = cfgFor('one');
      const t0 = Date.now();
      const r1 = await runCli(['-p', 'saving settings does not persist, check the store'], { cwd, configDir: c1, env, script: [{ text: 'FIRST-DONE' }], timeoutMs: 60000 });
      const wall = Date.now() - t0;
      assert.strictEqual(r1.code, 0, r1.stderr);
      assert.match(r1.stdout, /FIRST-DONE/);
      assert.ok(wall < LOAD_MS - 10000, `the run did not wait for the ${LOAD_MS / 1000} s load (${wall} ms)`);
      const row1 = sessionOf(c1).workerLedger.find((x) => x.contract === 'evidence_narrower');
      assert.ok(row1, 'the shortlist ran');
      assert.strictEqual(row1.tier, 'deterministic', 'answered without Laya');
      assert.ok(['LOADING', 'UNLOADED', 'UNAVAILABLE'].includes(row1.layaBypass), `bypass recorded: ${row1.layaBypass}`);
      assert.strictEqual(row1.warmWaitMs, 0);
      const s = await host.status();
      assert.ok(s.ok && s.workers.laya && s.workers.laya.state === 'LOADING', 'the load carries on after Noema exited');
      const until = Date.now() + LOAD_MS + 15000;
      while (Date.now() < until && (await host.status()).workers.laya.state !== 'HOT_IDLE') await sleep(250);
      assert.strictEqual((await host.status()).workers.laya.state, 'HOT_IDLE');
      const c2 = cfgFor('two');
      const r2 = await runCli(['-p', 'saving settings does not persist, check the store'], { cwd, configDir: c2, env, script: [{ text: 'SECOND-DONE' }], timeoutMs: 60000 });
      assert.strictEqual(r2.code, 0, r2.stderr);
      const row2 = sessionOf(c2).workerLedger.find((x) => x.contract === 'evidence_narrower');
      assert.strictEqual(row2.tier, 'laya', 'the next process is served by the hot worker');
      assert.strictEqual((await host.status()).workers.laya.loads, 1, 'no reload across Noema processes');
    } finally {
      await host.pending();
      await host.shutdown('test over');
      if (prevDir == null) delete process.env.LAIN_WORKERHOST_DIR; else process.env.LAIN_WORKERHOST_DIR = prevDir;
    }
  });
};
