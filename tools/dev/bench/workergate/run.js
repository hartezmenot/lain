'use strict';

/**
 * THE RECRUITMENT GATE for a decision worker (src/workers.js).
 *
 *   node bench/workergate/run.js <baseUrl> <model> [apiKey]
 *
 * Runs the labelled set through the REAL cascade (workers.decide): LAIN's
 * deterministic classifier first (mode.js); the candidate model is consulted
 * ONLY where the rules fell through to their default — the tie-break role the
 * contract describes. Writes bench/workergate/out/<model>.json and prints the
 * verdict. A model joins only on PASS:
 *
 *   on the uncertain cases   cascade accuracy ≥ deterministic + 15 points
 *   when it answers          ≤ 20% wrong (it must know when to ABSTAIN)
 *   latency                  median ≤ 2000 ms per decision
 *   overall                  cascade accuracy ≥ deterministic accuracy
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.LAIN_CONFIG_DIR = process.env.LAIN_CONFIG_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'lain-gate-'));
const mode = require('../../../../src/mode');
const workers = require('../../../../src/workers');

const COARSE = { CHAT: 'CHAT', EXPLAIN: 'EXPLAIN', AUDIT: 'AUDIT', BUGFIX: 'FIX', TROUBLESHOOT: 'FIX', IMPLEMENT: 'CHANGE', REFACTOR: 'CHANGE', NEW_PROJECT: 'CHANGE', MIGRATE: 'CHANGE', RESUME: 'CHANGE' };
const DEFAULT_REASON = 'no clearer signal; treated as work to do';

async function infer(baseUrl, model, apiKey, text) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model, temperature: 0, max_tokens: 8, stream: false,
      messages: [
        { role: 'system', content: 'You classify one request for a coding assistant. CHAT = conversation or general knowledge, no project work. EXPLAIN = asks how/where/what about THIS project, no change. AUDIT = asks for an assessment or review. FIX = reports something broken or wrong. CHANGE = asks for new behaviour, a refactor or an edit. Reply with ONE label only, or ABSTAIN.' },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

async function main() {
  const [baseUrl, model, apiKey = ''] = process.argv.slice(2);
  const set = JSON.parse(fs.readFileSync(path.join(__dirname, 'intent.json'), 'utf8'));
  const rows = [];
  const session = { workerLedger: [] };
  for (const [prompt, want] of set.cases) {
    const v = mode.classify(prompt, {});
    const detLabel = COARSE[v.mode] || 'CHANGE';
    const certain = v.reason !== DEFAULT_REASON;
    const t0 = Date.now();
    const r = await workers.decide({
      contract: 'decision_intent', fingerprint: prompt, session,
      packet: { decision: 'What kind of request is this?', facts: [`request: "${prompt}"`], candidates: set.labels },
      deterministic: () => ({ label: detLabel, certain }),
      infer: baseUrl && model ? (text) => infer(baseUrl, model, apiKey, text) : null,
    });
    rows.push({ prompt, want, det: detLabel, certain, got: r.label, by: r.by, escalated: r.escalated, ms: certain ? 0 : Date.now() - t0 });
  }
  const acc = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : 0);
  const unc = rows.filter((r) => !r.certain);
  const answered = unc.filter((r) => !r.escalated && r.by !== 'deterministic');
  const lat = unc.map((r) => r.ms).sort((a, b) => a - b);
  const m = {
    cases: rows.length, uncertain: unc.length,
    detAccuracy: acc(rows, (r) => r.det === r.want),
    detAccuracyCertain: acc(rows.filter((r) => r.certain), (r) => r.det === r.want),
    detAccuracyUncertain: acc(unc, (r) => r.det === r.want),
    cascadeAccuracy: acc(rows, (r) => r.got === r.want),
    cascadeAccuracyUncertain: acc(unc, (r) => r.got === r.want),
    answeredWrongRate: answered.length ? acc(answered, (r) => r.got !== r.want) : null,
    abstainRate: unc.length ? unc.filter((r) => r.escalated).length / unc.length : null,
    medianMs: lat.length ? lat[Math.floor(lat.length / 2)] : 0,
  };
  const gate = {
    uncertainGain: m.cascadeAccuracyUncertain - m.detAccuracyUncertain >= 0.15,
    knowsWhenToAbstain: m.answeredWrongRate != null && m.answeredWrongRate <= 0.2,
    latency: m.medianMs <= 2000,
    noOverallLoss: m.cascadeAccuracy >= m.detAccuracy,
  };
  gate.pass = Boolean(model) && Object.values(gate).every(Boolean);
  const out = { at: new Date().toISOString(), role: set.role, model: model || '(deterministic only)', baseUrl: baseUrl || null, metrics: m, gate, rows };
  const dir = path.join(__dirname, 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(model || 'deterministic').replace(/[^a-z0-9.-]+/gi, '_').slice(-60)}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  console.log(`model ${out.model}`);
  console.log(`deterministic: ${pct(m.detAccuracy)} overall · ${pct(m.detAccuracyCertain)} when certain · ${pct(m.detAccuracyUncertain)} on the ${m.uncertain} default-branch cases`);
  console.log(`cascade:       ${pct(m.cascadeAccuracy)} overall · ${pct(m.cascadeAccuracyUncertain)} on the uncertain cases · wrong-when-answering ${pct(m.answeredWrongRate)} · abstain ${pct(m.abstainRate)} · median ${m.medianMs} ms`);
  console.log(`GATE ${gate.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(gate)}`);
  console.log(`→ ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
