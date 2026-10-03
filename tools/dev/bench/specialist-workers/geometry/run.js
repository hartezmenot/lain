'use strict';

/**
 * VIOLETTO GEOMETRY ARM — the same six UI geometry changes answered by
 *   (a) the deterministic GUG solver (gug.js), and
 *   (b) Limite 1B Violetto on the local patched llama-server,
 * scored against the solver's exact answer (±0.5 px). Writes out/violetto.json.
 *
 *   node bench/specialist-workers/geometry/run.js [baseUrl=http://127.0.0.1:8093/v1] [maxTokens=6000]
 */

const fs = require('fs');
const path = require('path');
const { apply, CASES } = require('./gug');

const BASE = process.argv[2] || 'http://127.0.0.1:8093/v1';
const MAX = Number(process.argv[3]) || 6000;

function parse(text) {
  const t = String(text || '');
  const num = (k) => { const m = new RegExp(`${k}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, 'gi'); let last = null; let x; while ((x = m.exec(t))) last = Number(x[1]); return last; };
  return { width: num('width'), x: num('x'), y: num('y') };
}

async function ask(words) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ temperature: 0.6, top_p: 0.95, max_tokens: MAX, messages: [{ role: 'user', content: `${words}\nGive the new width and the new top-left corner. End with exactly one line: width=?, x=?, y=?` }] }),
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  const j = await res.json();
  const c = j.choices[0];
  return { ms: Date.now() - t0, finish: c.finish_reason, text: c.message.content || '', tokens: j.usage && j.usage.completion_tokens };
}

(async () => {
  const rows = [];
  const only = process.env.ONLY ? process.env.ONLY.split(',').map(Number) : null;
  for (const [i, c] of CASES.entries()) {
    if (only && !only.includes(i)) continue;
    const t0 = process.hrtime.bigint();
    const truth = apply(c.graph, c.id, c.change);
    const detUs = Number(process.hrtime.bigint() - t0) / 1000;
    let v;
    try { v = await ask(c.words); } catch (e) { v = { ms: 0, finish: 'error', text: String(e.message), tokens: 0 }; }
    const got = parse(v.text);
    const ok = (a, b) => a != null && Math.abs(a - b) <= 0.5;
    const correct = ok(got.width, truth.w) && ok(got.x, truth.x) && ok(got.y, truth.y);
    rows.push({ case: c.name, error: v.finish === 'error' ? v.text : undefined, truth: { width: truth.w, x: truth.x, y: truth.y }, deterministicUs: +detUs.toFixed(1), violetto: { ...got, correct, ms: v.ms, tokens: v.tokens, finish: v.finish } });
    console.log(`${correct ? 'OK ' : 'BAD'} ${c.name}: truth ${truth.w}/${truth.x}/${truth.y} · violetto ${got.width}/${got.x}/${got.y} · ${Math.round(v.ms / 1000)}s ${v.tokens}tok ${v.finish}`);
  }
  const n = rows.length;
  const summary = {
    at: new Date().toISOString(), model: 'limite-1b-violetto Q4_K_M (patched llama.cpp, CPU)', cases: n,
    violettoCorrect: rows.filter((r) => r.violetto.correct).length,
    violettoMedianMs: rows.map((r) => r.violetto.ms).sort((a, b) => a - b)[Math.floor(n / 2)],
    violettoTokens: rows.reduce((s, r) => s + (r.violetto.tokens || 0), 0),
    deterministicCorrect: n, deterministicMaxUs: Math.max(...rows.map((r) => r.deterministicUs)),
  };
  const out = path.join(__dirname, '..', 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, only ? 'violetto-geometry-rerun.json' : 'violetto-geometry.json'), JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary));
})();
