'use strict';

/**
 * CONTROL vs LAYA on one flagship route — the two runs' own receipts, compared.
 *
 *   node bench/readonly-diagnostic/compare.js <controlTag> <layaTag> [--out <dir>]
 *        [--price-in 0.10 --price-cached 0.01 --price-write 0.125 --price-out 0.50 --price-source "…"]
 *
 * FLAGSHIP TOKENS come from the provider's per-request receipts (the proxy's
 * capture of the raw stream), never estimated; a figure the provider did not
 * report is null, not 0. LOCAL LAYA COMPUTE is a separate section and is never
 * added to the flagship's pools or its cost. Prices are a SNAPSHOT passed in at
 * benchmark time — nothing here is orchestration.
 */

const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', path.join(__dirname, '..', 'out', 'readonly-diagnostic')));
const PRICE = {
  inputPerM: Number(arg('price-in', '0.10')), cachedPerM: Number(arg('price-cached', '0.01')),
  writePerM: Number(arg('price-write', '0.125')), outputPerM: Number(arg('price-out', '0.50')),
  source: arg('price-source', 'developers.openai.com/api/docs/pricing — gpt-6-luna, Standard, short context, read 2026-09-24'),
};
const [controlTag, layaTag] = process.argv.slice(2).filter((a) => !a.startsWith('--')).slice(0, 2);

// THE CHAIN the brief asks to trace, as source identifiers (the check is on the
// report's own words; every link names a real symbol or route in the project).
const CHAIN = [
  ['search input / submit', /runSearch|SearchView/],
  ['frontend API call', /api\.search|api\.ts/],
  ['HTTP route', /\/api\/search/],
  ['backend orchestration', /searchTorrents/],
  ['provider aggregation', /searchAll/],
  ['results rendered', /applySearchResponse|SearchView|results/],
  ['selected-result handoff', /addDownload|\/api\/downloads|download\(/],
];

const SEARCH_TOOLS = new Set(['grep', 'glob', 'symbols', 'locate', 'understand', 'dependents', 'check_symbols', 'read_symbol']);

function load(tag) {
  const dir = path.join(OUT, tag);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const session = fs.existsSync(path.join(dir, 'session.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) : {};
  const wire = path.join(dir, 'wire');
  const receipts = fs.readdirSync(wire).filter((f) => f.endsWith('-parsed.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(wire, f), 'utf8')));
  return { tag, meta, session, receipts };
}

function flagship(run) {
  const r = run.receipts;
  const sum = (f) => r.reduce((s, x) => s + (Number(f(x)) || 0), 0);
  const reported = r.filter((x) => x.usage && x.usage.input_tokens_details && x.usage.input_tokens_details.cached_tokens != null);
  const input = sum((x) => x.usage && x.usage.input_tokens);
  const cached = reported.length === r.length ? sum((x) => x.usage.input_tokens_details.cached_tokens) : null;
  const writes = r.every((x) => x.usage && x.usage.input_tokens_details && x.usage.input_tokens_details.cache_write_tokens != null) ? sum((x) => x.usage.input_tokens_details.cache_write_tokens) : null;
  const output = sum((x) => x.usage && x.usage.output_tokens);
  const reasoning = sum((x) => x.usage && x.usage.output_tokens_details && x.usage.output_tokens_details.reasoning_tokens);
  const uncached = cached == null ? null : input - cached - (writes || 0);
  const cost = cached == null ? null : {
    uncachedInput: +(uncached / 1e6 * PRICE.inputPerM).toFixed(6),
    cachedInput: +(cached / 1e6 * PRICE.cachedPerM).toFixed(6),
    cacheWrites: writes == null ? null : +(writes / 1e6 * PRICE.writePerM).toFixed(6),
    output: +(output / 1e6 * PRICE.outputPerM).toFixed(6),
  };
  if (cost) cost.total = +(cost.uncachedInput + cost.cachedInput + (cost.cacheWrites || 0) + cost.output).toFixed(6);
  const efforts = [...new Set(r.map((x) => x.effort && x.effort.effort).filter(Boolean))];
  const models = [...new Set(r.map((x) => x.model).filter(Boolean))];
  return { calls: r.length, input, cached, cacheWrites: writes, uncached, output, reasoning, cacheHitRate: cached == null || !input ? null : +(cached / input).toFixed(3), cost, effortServed: efforts, modelServed: models, wallMs: run.meta.wallMs };
}

function toolUse(run) {
  const msgs = run.session.messages || [];
  const results = new Map(msgs.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m]));
  const calls = [];
  for (const m of msgs) if (m.role === 'assistant') for (const tc of m.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.arguments || '{}'); } catch { /* raw */ }
    const res = results.get(tc.id);
    calls.push({ name: tc.name, input, resultChars: res ? String(res.content || '').length : 0, isError: Boolean(res && res.isError) });
  }
  const reads = calls.filter((c) => c.name === 'read_file');
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const readFiles = reads.map((c) => norm(c.input.path));
  const inspected = calls.filter((c) => c.input && (c.input.path || c.input.file) && ['read_file', 'check_symbols', 'read_symbol'].includes(c.name)).map((c) => norm(c.input.path || c.input.file));
  const uniq = [...new Set(inspected)];
  const byName = {};
  for (const c of calls) byName[c.name] = (byName[c.name] || 0) + 1;
  const finalText = String((run.session.turns || []).slice(-1)[0] ? ((msgs.filter((m) => m.role === 'assistant').slice(-1)[0] || {}).content || '') : '');
  const chain = CHAIN.map(([name, re]) => ({ link: name, found: re.test(finalText) }));
  return {
    toolCalls: calls.length, byName, readFileCalls: reads.length, searchCalls: calls.filter((c) => SEARCH_TOOLS.has(c.name)).length,
    uniqueFilesInspected: uniq.length, repeatedInspections: inspected.length - uniq.length, filesRead: [...new Set(readFiles)],
    readBytes: reads.reduce((s, c) => s + c.resultChars, 0), errors: calls.filter((c) => c.isError).length,
    reportChars: finalText.length, chain, chainScore: `${chain.filter((c) => c.found).length}/${chain.length}`,
    calls, stop: ((run.session.turns || []).slice(-1)[0] || {}).stopReason || null,
  };
}

function layaSection(run, tools) {
  const ws = (run.session.workerStats || {}).laya || null;
  const row = (run.session.workerLedger || []).find((r) => r.contract === 'evidence_narrower') || null;
  if (!row && !ws) return null;
  const slice = new Set((row && row.slice) || []);
  const norm = (p) => String(p || '').replace(/\\/g, '/');
  const outside = tools.calls.filter((c) => c.name === 'read_file' && !slice.has(norm(c.input.path)));
  const inside = tools.calls.filter((c) => c.name === 'read_file' && slice.has(norm(c.input.path)));
  const needed = new Set(tools.filesRead);
  return {
    prep: run.meta.prep || null,
    calls: ws ? ws.calls : 0, inferences: ws ? ws.inferences : 0, cacheHits: ws ? ws.cacheHits : 0, cacheMisses: ws ? ws.cacheMisses : 0,
    inferenceMs: ws ? ws.inferenceMs : [], tokensIn: ws ? ws.tokensIn : 0, outputChars: ws ? ws.outputChars : 0,
    tier: row ? row.tier : null, bypass: row ? row.layaBypass : null, timedOut: row ? row.layaTimedOut : null,
    index: row ? row.layaIndex : null, stale: row ? row.layaStale : null,
    candidatesBefore: row ? row.candidateCount : null, candidates: row ? row.candidates : null, layaRanked: row ? row.layaRanked : null,
    slice: row ? row.slice : null, sliceSize: slice.size,
    rawEvidenceChars: row ? row.rawChars : null, sliceChars: row ? row.outChars : null,
    compression: row && row.outChars ? +(row.rawChars / row.outChars).toFixed(1) : null,
    falseNarrowing: {
      neededFiles: needed.size, hits: [...needed].filter((f) => slice.has(f)).length, misses: [...needed].filter((f) => !slice.has(f)),
      readsOutsideSlice: outside.length, readsInsideSlice: inside.length,
      bytesOutsideSlice: outside.reduce((s, c) => s + c.resultChars, 0),
      tokensOutsideSliceEstimate: Math.round(outside.reduce((s, c) => s + c.resultChars, 0) / 4),
      estimateMethod: 'chars/4 — an ESTIMATE, unlike the flagship pools',
      sliceUnused: [...slice].filter((f) => !needed.has(f)),
    },
  };
}

const runs = [controlTag, layaTag].map(load);
const result = { price: PRICE, arms: {} };
for (const run of runs) {
  const f = flagship(run);
  const t = toolUse(run);
  result.arms[run.tag] = { case: run.meta.case, model: run.meta.model, protocol: run.meta.protocol, effortRequested: run.meta.effort, flagship: f,
    tools: { ...t, calls: undefined }, mutation: run.meta.fixtureDiff, laya: layaSection(run, t), layaVerdict: run.meta.layaVerdict || null };
}
const [a, b] = runs.map((r) => result.arms[r.tag]);
const d = (x, y) => (x == null || y == null ? null : { abs: +(y - x).toFixed(6), pct: x ? +(100 * (y - x) / x).toFixed(1) : null });
result.delta = {
  input: d(a.flagship.input, b.flagship.input), cached: d(a.flagship.cached, b.flagship.cached), uncached: d(a.flagship.uncached, b.flagship.uncached),
  output: d(a.flagship.output, b.flagship.output), calls: d(a.flagship.calls, b.flagship.calls), wallMs: d(a.flagship.wallMs, b.flagship.wallMs),
  cost: d(a.flagship.cost && a.flagship.cost.total, b.flagship.cost && b.flagship.cost.total),
  uniqueFilesRead: d(a.tools.uniqueFilesInspected, b.tools.uniqueFilesInspected), readFileCalls: d(a.tools.readFileCalls, b.tools.readFileCalls),
  toolCalls: d(a.tools.toolCalls, b.tools.toolCalls), chain: `${a.tools.chainScore} → ${b.tools.chainScore}`,
};
const file = path.join(OUT, `compare-${controlTag}-vs-${layaTag}.json`);
fs.writeFileSync(file, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
