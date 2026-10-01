'use strict';

/**
 * REAL PROVIDER: DIRECT vs NOEMA, per execution profile — minimal quota.
 *
 *   node bench/latency/real.js [--connection lain:zai] [--model glm-5.3-flash] [--n 2]
 *
 * Same methodology as tests/acceptance/realmodel.js: the person's own configured connection, the model/connection
 * chosen IN MEMORY ONLY (config.save is disabled — the default model is untouched), no secret printed. Spends about
 * 3·n + 6·n requests. Reports wall time, time-to-first-byte where measurable, and the provider's own token receipts.
 *
 *   direct   provider.chat with ONE user message and no tools — the floor for this route
 *   noema    App.submit, NORMAL / FAST / ECO: "reply OK", then a one-tool task in a scratch project
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const CONN = opt('connection', 'lain:zai');
const MODEL = opt('model', 'glm-5.3-flash');
const N = Number(opt('n', 2));

process.chdir(ROOT);
const config = require(path.join(ROOT, 'src', 'config'));
const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'noema-reallat-')));
fs.writeFileSync(path.join(proj, 'a.txt'), 'alpha line one\nbeta\n');
let profile = 'NORMAL';
const realLoad = config.load;
config.save = () => {};
config.load = (...a) => {
  const c = realLoad(...a);
  c.connection = CONN; c.model = MODEL; c.executionProfile = profile;
  c.trustedPaths = [...(c.trustedPaths || []), { path: proj, level: 'TRUSTED', at: new Date().toISOString() }];
  c.dashAutostart = false;
  return c;
};

const med = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]) : null; };

async function direct() {
  const provider = require(path.join(ROOT, 'src', 'provider'));
  const pc = provider.resolve(config.load());
  const rows = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now(); let first = null; let usage = null;
    for await (const ev of provider.chat(pc, [{ role: 'user', content: 'Reply with exactly: OK' }], {})) {
      if ((ev.type === 'text' || ev.type === 'reasoning') && first == null) first = performance.now() - t0;
      if (ev.type === 'usage') usage = ev;
    }
    rows.push({ ms: performance.now() - t0, first, in: usage && usage.inputTokens, out: usage && usage.outputTokens, reasoning: usage && usage.reasoningTokens });
  }
  return { ms: med(rows.map((r) => r.ms)), firstByte: med(rows.map((r) => r.first)), in: med(rows.map((r) => r.in)), out: med(rows.map((r) => r.out)), reasoning: med(rows.map((r) => r.reasoning)) };
}

async function noema(prof, prompt) {
  profile = prof;
  const { App } = require(path.join(ROOT, 'src', 'app'));
  const app = new App({ cwd: proj, interactive: false, out: { write() {}, on() {}, columns: 100, isTTY: false } });
  require(path.join(ROOT, 'src', 'profile')).set(app.session, prof);
  await app.prepare();
  const rows = [];
  for (let i = 0; i < N; i++) {
    const perf = require(path.join(ROOT, 'src', 'perfmark'));
    const t0 = performance.now();
    const rec = await app.submit(prompt);
    const ms = performance.now() - t0;
    const marks = perf.read();
    const u = (rec && rec.usage) || {};
    rows.push({ ms, toRequest: marks['@request'], requests: u.requests, in: u.inputTokens, out: u.outputTokens, cache: u.cacheReadTokens, reasoning: u.reasoningTokens, tools: rec && rec.toolCalls, stop: rec && rec.stopReason });
  }
  try { await require(path.join(ROOT, 'src', 'harnesslink')).shutdown(app); } catch { /* best effort */ }
  const pick = (k) => med(rows.map((r) => r[k]));
  return { ms: pick('ms'), noemaToRequest: pick('toRequest'), requests: pick('requests'), in: pick('in'), out: pick('out'), cache: pick('cache'), reasoning: pick('reasoning'), tools: pick('tools'), stops: rows.map((r) => r.stop).join(',') };
}

(async () => {
  const out = { at: new Date().toISOString(), connection: CONN, model: MODEL, n: N };
  out.direct = await direct();
  for (const prof of ['NORMAL', 'FAST', 'ECO']) {
    out[prof] = {
      ok: await noema(prof, 'Reply with exactly: OK'),
      tool: await noema(prof, 'Read a.txt and reply with only its first line.'),
    };
  }
  const text = JSON.stringify(out, null, 2);
  fs.mkdirSync(path.join(ROOT, 'bench', 'out', 'latency'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'bench', 'out', 'latency', `real-${Date.now()}.json`), text);
  process.stdout.write(`${text}\n`);
  setTimeout(() => process.exit(0), 300).unref();
})().catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
