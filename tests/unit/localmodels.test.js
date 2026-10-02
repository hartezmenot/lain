'use strict';

/**
 * LOCAL MODELS — GGUF headers read without loading, model directories that are
 * references (nothing copied, nothing deleted), projector pairing only on
 * evidence, an owned llama-server (start, reuse, controlled switch, stop), the
 * normal request path with local metrics, and the Agent compatibility test.
 * Fakes only: fixture GGUF headers and a fake llama-server.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const G = require('../fixtures/runtimes/ggufwrite');
  const { shim, FIX } = require('../fixtures/runtimes/shim');
  const gguf = require('../../src/local/gguf');
  const md = require('../../src/local/modeldirs');
  const llama = require('../../src/local/llamacpp');
  const { App } = require('../../src/app');

  const models = tmpdir('models-');
  const d1 = path.join(models, 'assistant', 'qwen3-vl-4b');
  const d2 = path.join(models, 'more');
  const d3 = tmpdir('models2-');
  fs.mkdirSync(d1, { recursive: true }); fs.mkdirSync(d2, { recursive: true });
  const vl = G.textModel(path.join(d1, 'Qwen3VL-4B-Instruct-Q4_K_M.gguf'), { arch: 'qwen3vl', name: 'Qwen3Vl 4b Instruct', basename: 'qwen3vl', width: 2560 });
  const proj = G.projector(path.join(d1, 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf'), { basename: 'qwen3vl', width: 2560 });
  const small = G.textModel(path.join(d2, 'tiny-1b-Q5_K_M.gguf'), { arch: 'llama', name: 'tiny-1b', width: 1024, ftype: 999 });
  const wrongProj = G.projector(path.join(d2, 'mmproj-other-f16.gguf'), { basename: 'other', width: 4096 });
  const diffusion = G.other(path.join(d2, 'image-model-Q4_0.gguf'));
  const vl2 = G.textModel(path.join(d3, 'second-vl-Q8_0.gguf'), { arch: 'qwen2vl', name: 'Second VL', width: 3584 });
  G.projector(path.join(d3, 'mmproj-a.gguf'), { basename: 'a', width: 3584 });
  G.projector(path.join(d3, 'mmproj-b.gguf'), { basename: 'b', width: 3584 });
  try { fs.unlinkSync(md.file()); } catch { /* fresh */ }

  const before = () => fs.readdirSync(models, { recursive: true }).map((f) => { const p = path.join(models, f); const s = fs.statSync(p); return `${f}:${s.size}:${s.mtimeMs}`; }).sort();

  await test('GGUF: the header is read without loading the model — metadata, not guesses', () => {
    const s = gguf.inspect(vl);
    assert.strictEqual(s.kind, 'text'); assert.strictEqual(s.architecture, 'qwen3vl'); assert.strictEqual(s.contextLength, 32768);
    assert.strictEqual(s.quantization, 'Q4_K_M'); assert.strictEqual(s.quantSource, 'metadata');
    assert.strictEqual(s.vocabSize, 2000, 'the vocabulary was counted, not kept');
    assert.ok(s.chatTemplate.present); assert.strictEqual(s.visionArch, true);
    const sm = gguf.inspect(small);
    assert.strictEqual(sm.quantization, 'Q5_K_M'); assert.strictEqual(sm.quantSource, 'file name', 'an unknown file_type falls back to the name, and says so');
    assert.strictEqual(gguf.inspect(proj).kind, 'projector'); assert.strictEqual(gguf.inspect(proj).projector.projectionDim, 2560);
    assert.strictEqual(gguf.inspect(diffusion).kind, 'other', 'no tokenizer: not a text model llama-server can serve');
    const bad = path.join(d2, 'not-gguf.gguf'); fs.writeFileSync(bad, 'hello');
    assert.strictEqual(gguf.inspect(bad).ok, false);
    fs.unlinkSync(bad);
  });

  await test('DIRS: a directory is a reference — scanned recursively, headers only, several directories', () => {
    const snap = before();
    const a = md.add(models);
    assert.ok(a.ok, a.why);
    assert.strictEqual(md.add(models).ok, false, 'the same folder twice is refused');
    assert.ok(md.add(d3).ok);
    const l = md.list();
    assert.strictEqual(l.dirs.length, 2);
    assert.deepStrictEqual(l.dirs[0].counts, { gguf: 5, text: 2, projector: 2, other: 1 });
    assert.strictEqual(l.models.length, 3);
    assert.deepStrictEqual(before(), snap, 'no model file was created, copied, moved or touched');
    const cfg = JSON.parse(fs.readFileSync(md.file(), 'utf8'));
    assert.ok(!JSON.stringify(cfg).includes('tok1999'), 'no model content is stored — only the reference and header facts');
  });

  await test('PAIRING: only on evidence — matching projector width in the same folder; otherwise not paired', () => {
    const l = md.list();
    const m1 = l.models.find((m) => m.file === vl);
    assert.strictEqual(m1.projector, proj); assert.match(m1.pairing, /output width 2560 matches/); assert.strictEqual(m1.vision, true);
    const m2 = l.models.find((m) => m.file === small);
    assert.strictEqual(m2.projector, null, 'a non-vision architecture gets none, even with an mmproj next to it');
    const m3 = l.models.find((m) => m.file === vl2);
    assert.strictEqual(m3.projector, null);
    assert.match(m3.pairing, /Projector not automatically paired/, 'two candidates that fit: the person chooses');
    md.pair(vl2, path.join(d3, 'mmproj-b.gguf'));
    assert.strictEqual(md.list().models.find((m) => m.file === vl2).projector, path.join(d3, 'mmproj-b.gguf'));
    assert.match(md.list().models.find((m) => m.file === vl2).pairing, /chosen by you/);
    assert.ok(fs.existsSync(wrongProj));
  });

  await test('DIRS: removing a directory forgets the reference; every model stays on disk', () => {
    const id = md.list().dirs.find((d) => d.path === path.resolve(d3)).id;
    const r = md.remove(id);
    assert.ok(r.ok); assert.match(r.note, /untouched/);
    assert.ok(fs.existsSync(vl2), 'the folder and its models are untouched');
    assert.strictEqual(md.list().dirs.length, 1);
    assert.ok(md.rescan().ok);
  });

  // ---- the owned llama-server ------------------------------------------------
  const bin = shim(tmpdir('llamabin-'), 'llama-server', path.join(FIX, 'fakellama.js'));
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('localapp-') });
  app.cfg.local = { llamacpp: { server: bin, ctx: 4096, skipMemoryCheck: true } };
  const argsFile = path.join(tmpdir('llamaargs-'), 'args.json');
  process.env.FAKE_LLAMA_ARGS = argsFile;
  const idVL = md.list().models.find((m) => m.file === vl).id;
  const idSmall = md.list().models.find((m) => m.file === small).id;

  await test('LLAMA.CPP: ensure starts one owned server, health-checks it, and reuses it', async () => {
    assert.strictEqual(llama.version(app), 'b1234 (abcdef0)');
    const r = await llama.ensure(app, idVL);
    assert.ok(r.ok, r.why); assert.strictEqual(r.reused, false); assert.strictEqual(r.server.state, 'ready');
    const argv = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.ok(argv.includes('--mmproj') && argv.includes(proj), 'the paired projector is passed');
    assert.ok(argv.includes('--jinja'), 'chat templates with tools');
    assert.strictEqual(argv[argv.indexOf('-c') + 1], '4096');
    const rec = require('../../src/runtimeregistry').list().find((x) => x.pid === r.server.pid);
    assert.ok(rec && rec.purpose === 'llama-server', 'registered with LAIN ownership');
    const again = await llama.ensure(app, idVL);
    assert.ok(again.ok); assert.strictEqual(again.reused, true); assert.strictEqual(again.server.pid, r.server.pid, 'no second server for the same model');
  });

  await test('LLAMA.CPP: BOT through the normal request path — local metrics recorded, no provider cache invented', async () => {
    const provider = require('../../src/provider');
    const pc = provider.resolve({ connections: {}, model: idVL, local: app.cfg.local });
    assert.strictEqual(pc.protocol, 'runtime'); assert.strictEqual(pc.runtime, 'llamacpp'); assert.strictEqual(pc.connectionId, 'local:llamacpp');
    assert.strictEqual(provider.credentialHint(pc), null, 'a local route needs no credential');
    assert.strictEqual(pc.ctx, 4096, 'the request path knows the local server’s real window, so context fitting works');
    let text = ''; let usage = null;
    for await (const ev of provider.chat(pc, [{ role: 'user', content: 'hi' }], { role: 'bot', sessionId: 's-local' })) { if (ev.type === 'text') text += ev.chunk; if (ev.type === 'usage') usage = ev; }
    assert.match(text, /Hello from llamacpp\//);
    assert.strictEqual(usage.local.runtime, 'llama.cpp'); assert.strictEqual(usage.local.tokPerSec, 100); assert.strictEqual(usage.local.promptTokens, 42);
    assert.strictEqual(usage.cacheReported, false);
    const row = require('../../src/usage').read({}).filter((x) => x.session === 's-local').pop();
    assert.strictEqual(row.via, 'Local · llama.cpp'); assert.strictEqual(row.tokens, 'runtime'); assert.strictEqual(row.role, 'bot');
    assert.strictEqual(row.local.tokPerSec, 100); assert.strictEqual(row.cacheRead, null, 'no provider cache for a local model');
  });

  await test('LLAMA.CPP: a second model is a controlled switch — never while a request is in flight', async () => {
    const first = llama.status()[0];
    const done = llama.begin(idVL);
    const blocked = await llama.ensure(app, idSmall);
    assert.strictEqual(blocked.ok, false); assert.match(blocked.why, /in flight|answering a request/);
    done();
    const r = await llama.ensure(app, idSmall);
    assert.ok(r.ok, r.why);
    assert.strictEqual(llama.status().length, 1, 'one LAIN server at a time by default');
    assert.notStrictEqual(llama.status()[0].pid, first.pid);
    assert.ok(!require('../../src/runtimeregistry').list().some((x) => x.pid === first.pid && x.alive), 'the old server was stopped');
  });

  await test('LLAMA.CPP: a model llama-server cannot load is an answer, not a hang', async () => {
    process.env.FAKE_LLAMA_FAIL = '1';
    llama.stopAll();
    const r = await llama.ensure(app, idVL, { startTimeoutMs: 8000 });
    delete process.env.FAKE_LLAMA_FAIL;
    assert.strictEqual(r.ok, false); assert.match(r.why, /unknown model architecture/);
    assert.strictEqual(llama.status().length, 0);
  });

  await test('LLAMA.CPP: without a setting, the context is sized from the header and free memory (KV cache from the attention shape)', () => {
    const m = { ...md.byId(idVL), headCountKv: 8, keyLength: 128, valueLength: 128, blockCount: 36, contextLength: 262144 };
    const plain = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: tmpdir('ctx-') });
    plain.cfg.local = { llamacpp: { server: bin } };
    const c = llama.configFor(plain, m);
    assert.ok([32768, 24576, 16384, 8192].includes(c.ctx));
    assert.strictEqual(llama.estimate(m, { ctx: 32768 }).kv, 36 * 32768 * 8 * 256 * 2, 'layers × ctx × kv-heads × (key+value) × 2 bytes');
    assert.strictEqual(llama.configFor(plain, { ...m, contextLength: 4096 }).ctx, 4096, 'never beyond what the model states');
  });

  await test('LLAMA.CPP: the resource estimate refuses a start that would not fit, with the numbers', async () => {
    const m = md.byId(idVL);
    const est = llama.estimate({ ...m, sizeBytes: 40 * 1073741824 }, llama.configFor(app, m));
    assert.ok(est.total > 40 * 1073741824);
    app.cfg.local.llamacpp.skipMemoryCheck = false;
    const big = require('os').freemem() * 2;
    const orig = md.byId;
    md.byId = (id) => ({ ...orig(id), sizeBytes: big });
    const r = await llama.ensure(app, idVL);
    md.byId = orig;
    app.cfg.local.llamacpp.skipMemoryCheck = true;
    assert.strictEqual(r.ok, false); assert.match(r.why, /not enough free memory: this model needs about/);
  });

  await test('AGENT TEST: a model that calls tools and continues is verified; a text-only one is not — keyed to file + runtime + config', async () => {
    const la = require('../../src/localagent');
    process.env.FAKE_LLAMA_MODE = 'good';
    const good = await la.run(app, idVL);
    assert.ok(good.ok, good.why);
    assert.strictEqual(good.result, 'verified', JSON.stringify(good.probes));
    assert.strictEqual(la.current(app, idVL).result, 'verified');
    const rt = require('../../src/runtimeconnections').rowFor(app, idVL);
    assert.ok(rt.roles.includes('AGENT'), 'AGENT only after the test');
    llama.stopAll();
    process.env.FAKE_LLAMA_MODE = 'notools';
    const weak = await la.run(app, idSmall);
    assert.notStrictEqual(weak.result, 'verified');
    assert.ok(!require('../../src/runtimeconnections').rowFor(app, idSmall).roles.includes('AGENT'));
    const inv = require('../../src/modelinventory');
    const refused = await inv.select(app, { lane: 'coding', source: 'lain', modelId: idSmall });
    assert.strictEqual(refused.ok, false); assert.match(refused.why, /not verified for the Coding Agent/);
    // CHANGE THE CONFIGURATION: the old result no longer applies.
    app.cfg.local.llamacpp.ctx = 2048;
    assert.strictEqual(la.current(app, idVL), null, 'a changed context invalidates the verification');
    assert.strictEqual(la.history(app, idVL).stale, true);
    app.cfg.local.llamacpp.ctx = 4096;
    fs.utimesSync(vl, new Date(), new Date(Date.now() + 5000));
    md.rescan();
    assert.strictEqual(la.current(app, idVL), null, 'a changed model file invalidates it too');
    delete process.env.FAKE_LLAMA_MODE;
  });

  await test('LLAMA.CPP: stop stops only what LAIN started; teardown leaves nothing running', async () => {
    const r = await llama.ensure(app, idSmall);
    assert.ok(r.ok, r.why);
    const pid = r.server.pid;
    const s = llama.stop(llama.status()[0].key);
    assert.ok(s.ok);
    assert.strictEqual(llama.status().length, 0);
    await new Promise((x) => setTimeout(x, 300));
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    assert.strictEqual(alive, false, 'the owned process is gone');
    llama.stopAll();
    delete process.env.FAKE_LLAMA_ARGS;
  });
};
