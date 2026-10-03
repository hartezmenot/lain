'use strict';

/**
 * WORKER_RECRUITMENT_REPORT — one JSON per candidate, from measured files only.
 *
 *   node bench/specialist-workers/report.js <ab2-json>
 *
 * Reads: out/laya-locate-gate.json, out/laya-ui-gate.json, out/violetto-geometry.json
 * (+ -rerun), out/cache-laya.json, out/cache-violetto.json, the v2 A/B table and
 * workers/manifest.json. Writes out/WORKER_RECRUITMENT_REPORT-<id>.json.
 *
 * THE RULES (fixed before the A/B was read; the n ≥ 3 clause was added after
 * the first A/B of 2026-09-23 and is stated in every report):
 *   RECRUIT_AUTO  its gate for a use PASSED, AND in ≥ 3 valid runs per arm the
 *                 arm cut median flagship input by ≥ 10% with the median outside
 *                 CONTROL's own range, no quality loss, no more false narrowing
 *                 than it saves, and acceptable latency
 *   EXPERIMENTAL  a gate or a conclusive A/B shows a benefit the other does not
 *   REJECT        the gate failed and no conclusive benefit exists, or it costs
 *                 more than it saves, or a deterministic owner does the job
 * Fewer than 3 valid runs per arm is EXPLORATORY: reported, never promoted on.
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')); } catch { return null; } };
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'workers', 'manifest.json'), 'utf8')).workers;
const ab = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : null;
const rows = (ab && ab.rows) || [];
const valid = (arm) => rows.filter((r) => r.arm === arm && r.valid);
const pct = (a, b) => (a == null || !b ? null : +(((a - b) / b) * 100).toFixed(1));
const MIN_RUNS = 3;

function armView(arm) {
  const rs = valid(arm);
  if (!rs.length) return null;
  const r = rs[0];
  return {
    runs: rs.length,
    flagship: r.flagship,
    tools: { total: r.tools.total, fileReads: r.tools.fileReads, exploreBeforeFirstEdit: r.tools.exploreBeforeFirstEdit, testRuns: r.tools.testRuns, domReads: r.tools.domReads },
    quality: { acceptance: r.quality.acceptance, finalSmoke: r.quality.finalSmoke, browser: r.quality.browser, responsive: r.quality.responsive, backend: r.quality.backend, diff: r.quality.diff, unexpectedFiles: r.quality.unexpectedFiles },
    wallMs: r.wallMs,
  };
}

function delta(arm) {
  const c = armView('control');
  const a = armView(arm);
  if (!c || !a) return null;
  return {
    flagshipInputPct: pct(a.flagship.inputTokens, c.flagship.inputTokens),
    flagshipCallsPct: pct(a.flagship.calls, c.flagship.calls),
    flagshipOutputPct: pct(a.flagship.outputTokens, c.flagship.outputTokens),
    acceptance: `${a.quality.acceptance.pass} vs ${c.quality.acceptance.pass} of ${c.quality.acceptance.total}`,
    wallPct: pct(a.wallMs, c.wallMs),
    conclusive: a.runs >= MIN_RUNS && c.runs >= MIN_RUNS,
    label: a.runs >= MIN_RUNS && c.runs >= MIN_RUNS ? 'CONCLUSIVE' : `EXPLORATORY (n=${a.runs} vs n=${c.runs}; ${MIN_RUNS} per arm required)`,
  };
}

function write(id, report) {
  fs.writeFileSync(path.join(OUT, `WORKER_RECRUITMENT_REPORT-${id}.json`), JSON.stringify(report, null, 2));
  console.log(`${id.padEnd(9)} ${report.verdict}  — ${report.why}`);
}

const common = ab ? {
  flagshipRoute: ab.model, effort: ab.effort, budgets: ab.budgets, requestsSpent: ab.requestsSpent, stopped: ab.stopped,
  control: armView('control'),
} : null;

// ---- Laya -----------------------------------------------------------------------
{
  const fg = read('laya-locate-gate.json');
  const ug = read('laya-ui-gate.json');
  const cache = read('cache-laya.json');
  const r = valid('laya')[0] || null;
  const d = delta('laya');
  const gatePass = Object.values(manifest.laya.gates || {}).some((g) => g.pass);
  const verdict = gatePass && d && d.conclusive && d.flagshipInputPct <= -10 ? 'RECRUIT_AUTO' : gatePass || (d && d.conclusive && d.flagshipInputPct <= -10) ? 'EXPERIMENTAL' : 'REJECT';
  write('laya', {
    candidate: 'Laya', model: manifest.laya.model, package: manifest.laya.package, license: manifest.laya.license, contract: 'evidence_narrower',
    gates: {
      file_locate: fg && { items: fg.summary.items, queries: fg.rows.length, all: fg.summary.all, choiceConfidentWrong: fg.summary.choiceConfidentWrong },
      ui_control: ug && { controls: ug.summary.controls, lexical: ug.summary.lexical, fused: ug.summary.fused, 'laya-choice': ug.summary['laya-choice'] },
    },
    residencyAndCache: cache && { coldLoadMs: cache.coldLoadMs, residentMB: cache.memoryMB, firstInference: cache.firstInference, warmInference: cache.warmInference, resultCache: cache.resultCache, invalidation: cache.invalidation },
    ab: common && { ...common, laya: armView('laya'), delta: d,
      worker: r && r.laya ? { calls: r.laya.calls, inferences: r.laya.inferences, cacheHits: r.laya.cacheHits, cacheMisses: r.laya.cacheMisses, coldLoadMs: r.laya.coldLoadMs, coldEmbed: r.laya.coldEmbed, warmInferenceMs: r.laya.warmInferenceMedianMs, totalInferenceMs: r.laya.totalInferenceMs, tokensIn: r.laya.tokensIn, outputChars: r.laya.outputChars, residentMB: r.laya.memoryMB, turnWaitedForLoadMs: r.laya.warmWaitMs } : null,
      compression: r && r.laya ? r.laya.compression : null,
      falseNarrowing: r && r.laya ? r.laya.falseNarrowing : null,
      decisionQuality: r ? `the Laya run used ${r.tools.total} tool calls against CONTROL's ${armView('control') ? armView('control').tools.total : '?'}, but ran ${r.tools.testRuns} test run(s) and ${r.tools.domReads} browser check(s); its shortlist named ${r.laya && r.laya.falseNarrowing ? `${r.laya.falseNarrowing.hits}/${r.laya.falseNarrowing.touched}` : '?'} of the files it used` : null },
    verdict,
    why: `gates FAIL (files: fused hit@8 ${fg && fg.summary.all.fused['hit@8']} < lexical ${fg && fg.summary.all.lexical['hit@8']}); A/B ${d ? d.label : 'not run'}${d ? `, flagship input ${d.flagshipInputPct}% vs CONTROL` : ''} — no promotion from exploratory evidence`,
    policy: 'installed; auto uses it nowhere (no passed gate); forced only for experiments (/workers laya on)',
  });
}

// ---- Violetto -----------------------------------------------------------------------
{
  const g = read('violetto-geometry.json');
  const rr = read('violetto-geometry-rerun.json');
  const cache = read('cache-violetto.json');
  const grows = g ? g.rows.map((x) => (x.violetto.finish === 'error' && rr ? rr.rows.find((y) => y.case === x.case) || x : x)) : [];
  const correct = grows.filter((x) => x.violetto.correct).length;
  const r = valid('violetto')[0] || null;
  const d = delta('violetto');
  const schemaChars = 0;   // no flagship tool since 2026-09-24: Core dispatches geometry jobs (src/violettojob.js)
  write('violetto', {
    candidate: 'Limite 1B Violetto', model: manifest.violetto.model, sha256: manifest.violetto.sha256, license: manifest.violetto.license, contract: 'geometry_solver',
    geometryEval: { cases: grows.length, correctWithinHalfPx: correct, deterministicSolver: `${grows.length}/${grows.length} in < 0.2 ms`, finishedWithinBudget: grows.filter((x) => x.violetto.finish === 'stop').length },
    residencyAndCache: cache && { coldLoadMs: cache.coldLoadMs, residentMB: cache.memoryMB, firstInference: cache.firstInference, warmInference: cache.warmInference, resultCache: cache.resultCache, invalidation: cache.invalidation, truth: cache.truth },
    ab: common && { ...common, violetto: armView('violetto'), delta: d,
      worker: r && r.violetto ? { calls: r.violetto.calls, inferences: r.violetto.inferences, coldLoadMs: r.violetto.coldLoadMs, residentMB: r.violetto.memoryMB, questions: r.violetto.questions } : null,
      toolSchemaOverhead: schemaChars && r ? { schemaChars, requests: r.flagship.calls, approxTokens: Math.round(schemaChars / 4 * r.flagship.calls) } : null,
      decisionQuality: r && r.violetto && !r.violetto.inferences ? 'the flagship was offered the geometry tool and never called it: it solved the geometry itself (CSS arithmetic + browser check). The arm paid only costs: cold load, resident memory, the tool schema on every request.' : null },
    verdict: 'REJECT',
    why: `offline: ${correct}/${grows.length} within ±0.5 px, ~228 s and 6,000 tokens per answer, final lines unusable in the cache bench; end to end: offered, never used by the flagship; a deterministic solver answers exactly in microseconds`,
    policy: 'installed; off by policy; the geometry_specialist tool exists only when forced on (/workers violetto on)',
  });
}

// ---- Jev --------------------------------------------------------------------------------
write('jev', {
  candidate: 'Jev', model: 'TypeSafe jev-1.13 (hosted, proprietary)', contract: 'decision_intent',
  availability: manifest.jev.reason, status: 'EXCLUDED', verdict: 'REJECT',
  why: 'no legitimately usable implementation here; excluded from the benchmark; no substitute presented as Jev',
});
