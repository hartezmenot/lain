'use strict';

/**
 * LOCAL LAYA GATE — before any cloud request (2026-09-24).
 *
 *   node bench/live-evidence/gate.js --snapshot bench/out/live-evidence/<stamp>
 *
 * Can Laya (`ui_evidence_narrower`) compile the captured live observation
 * into a small slice that KEEPS the search interaction chain? Measured against
 * truth.json (fixed selectors decided from the source before any model ran):
 * retained / missed / irrelevant targets, compression, latency — for the
 * shipped slice (Core's deterministic score fused with Laya), and, for
 * attribution, Core alone and Laya alone.
 *
 * Preparation (cold model load, embedding every node once) is timed apart
 * from the task's inference (the query only). Nothing here calls a cloud
 * model. Writes gate.json, prompt.txt (the receipt filled in) and the
 * prepared vectors, beside the snapshot.
 *
 * GATE: FAIL when the slice misses two or more of {search input, search
 * submission, results container, result item / download action}, or the
 * search endpoint. A failed gate means NO Luna A/B.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const SNAP = path.resolve(arg('snapshot'));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-live-gate-'));
process.env.LAIN_CONFIG_DIR = path.join(base, 'home');
process.env.LAIN_WORKERHOST_DIR = path.join(base, 'host');
process.env.LAIN_WORKERS = 'auto';
process.env.LAIN_ROLE_UI_EVIDENCE_NARROWER = 'force';
fs.mkdirSync(process.env.LAIN_CONFIG_DIR, { recursive: true });

const store = require(path.join(REPO, 'src/observationstore'));
const le = require(path.join(REPO, 'src/layaevidence'));
const rt = require(path.join(REPO, 'src/workerruntime'));
const host = require(path.join(REPO, 'src/workerhost'));

function evaluate(refs, network, truth, byRef, rawChars, text) {
  const set = new Set(refs);
  const targets = {};
  for (const [k, want] of Object.entries(truth)) {
    if (k === 'T8_search_endpoint') targets[k] = network.some((u) => /\/api\/search\b/.test(u));
    else targets[k] = want.some((r) => set.has(r));
  }
  const truthRefs = new Set(Object.entries(truth).filter(([k]) => k !== 'T8_search_endpoint').flatMap(([, v]) => v));
  const irrelevant = refs.filter((r) => !truthRefs.has(r)).map((r) => { const n = byRef.get(r); return `${r} ${n.tag}${(n.classes || []).length ? `.${n.classes.join('.')}` : ''}`; });
  const essential = ['T1_search_input', 'T2_search_submit', 'T5_results_container', 'T6_result_item|T7_download_action'];
  const missedEssential = essential.filter((e) => !e.split('|').some((k) => targets[k]));
  return {
    retained: Object.keys(targets).filter((k) => targets[k]), missed: Object.keys(targets).filter((k) => !targets[k]),
    recall: +(Object.values(targets).filter(Boolean).length / Object.keys(targets).length).toFixed(3),
    irrelevantRetained: irrelevant, sliceNodes: refs.length, sliceChars: text ? text.length : null,
    compression: text ? +(rawChars / text.length).toFixed(1) : null, missedEssential,
  };
}

(async () => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(SNAP, 'snapshot.json'), 'utf8'));
  const truth = JSON.parse(fs.readFileSync(path.join(SNAP, 'truth.json'), 'utf8'));
  const id = store.keep(snapshot);
  const obs = store.load(id);
  const byRef = new Map(obs.nodes.map((n) => [n.ref, n]));
  const raw = store.rendered(obs);
  const rawNet = (obs.network || []).map((r) => `${r.method} ${r.url} ${r.status}`).join('\n');
  const rawChars = raw.length + rawNet.length;
  const prompt = fs.readFileSync(path.join(__dirname, 'prompt.template.txt'), 'utf8').split('{RECEIPT}').join(id);
  fs.writeFileSync(path.join(SNAP, 'prompt.txt'), prompt);
  const focus = require(path.join(REPO, 'src/locateassist')).intentText(prompt);
  const app = { cfg: { workers: {} } };
  const out = { receipt: id, rawNodes: obs.nodes.length, visibleNodes: obs.nodes.filter((n) => n.visible).length, rawChars, networkRows: (obs.network || []).length, truth, focusChars: focus.length };

  // PREPARATION — apart from the task.
  const t0 = Date.now();
  await host.load('laya', rt.spec(app, 'laya'));
  const w = await host.wait('laya', 15 * 60 * 1000);
  out.coldLoadMs = Date.now() - t0;
  out.modelLoadMs = w.loadMs;
  if (!w.ok) throw new Error('laya did not become hot');
  await rt.hostView(app);
  const p = await le.prepare(app, id);
  out.prepare = p;
  const st = await host.status({ measure: true });
  out.modelState = st.workers.laya.state;
  out.residentMB = st.workers.laya.residentMB;

  // THE TASK'S INFERENCE — the query only.
  const r = await le.compile(app, id, focus);
  if (!r.ok) throw new Error(`compile failed: ${r.bypass}`);
  const r2 = await le.compile(app, id, focus);
  out.inference = { ms: r.ms, warmMs: r2.ms, usage: r.usage, cosRange: r.cosRange };
  out.slice = { text: r.slice.text, refs: r.slice.refs, network: r.slice.network, confidence: r.slice.confidence };
  out.shipped = evaluate(r.slice.refs, r.slice.network, truth, byRef, rawChars, r.slice.text);
  // ATTRIBUTION: Core alone, Laya alone (same K).
  const det = le.slice(obs, focus, { laya: null });
  out.coreOnly = evaluate(det.refs, det.network, truth, byRef, rawChars, det.text);
  out.layaOnly = evaluate(r.slice.layaRefs, r.slice.network, truth, byRef, rawChars, null);
  out.layaOnlyTop = r.slice.layaRefs.map((ref) => store.row(byRef.get(ref)));
  out.gate = out.shipped.missedEssential.length >= 2 || !out.shipped.retained.includes('T8_search_endpoint') ? 'FAIL' : 'PASS';
  // LENIENT READING: a ref printed on a row's "in …" path line is visible too.
  const pathRefs = (text) => [...String(text).matchAll(/\((n\d+)\)/g)].map((m) => m[1]);
  out.shippedWithPaths = evaluate([...new Set([...r.slice.refs, ...pathRefs(r.slice.text)])], r.slice.network, truth, byRef, rawChars, r.slice.text);
  // DIAGNOSTIC, declared before it was run and NOT the gate: Core splits the
  // numbered request into its items; each item gets its own top-2 nodes, from
  // Laya alone and from Core alone. Shows whether a better-shaped job would help.
  const items = [...prompt.matchAll(/^\d+\.\s+(.+?);?\s*$/gm)].map((m) => m[1]);
  const perItem = { laya: [], core: [], inferences: 0, ms: 0 };
  for (const it of items) {
    const c = await le.compile(app, id, it, { keep: 2 });
    perItem.inferences += 1; perItem.ms += c.ms || 0;
    if (c.ok) perItem.laya.push(...c.slice.layaRefs.slice(0, 2));
    perItem.core.push(...store.queryNodes(obs, it, 2).map((n) => n.ref));
  }
  const netAll = (obs.network || []).filter((x) => /\/api\//.test(x.url)).map((x) => x.url);
  out.diagnosticDecomposed = {
    items, inferences: perItem.inferences, ms: perItem.ms,
    laya: evaluate([...new Set(perItem.laya)], netAll, truth, byRef, rawChars, null),
    core: evaluate([...new Set(perItem.core)], netAll, truth, byRef, rawChars, null),
    layaPicks: [...new Set(perItem.laya)].map((ref) => store.row(byRef.get(ref)).slice(0, 110)),
  };
  fs.copyFileSync(path.join(store.dir(), `${id}.laya.json`), path.join(SNAP, `${id}.laya.json`));
  fs.writeFileSync(path.join(SNAP, 'gate.json'), JSON.stringify(out, null, 1));
  const brief = (e) => `recall ${e.recall} · missed ${e.missed.join(',') || '—'} · ${e.sliceNodes} nodes${e.compression ? ` · ×${e.compression}` : ''} · irrelevant ${e.irrelevantRetained.length}`;
  console.log(JSON.stringify({ receipt: id, rawNodes: out.rawNodes, rawChars, coldLoadMs: out.coldLoadMs, prepareMs: p.ms, inferenceMs: r.ms, warmMs: r2.ms, residentMB: out.residentMB,
    shipped: brief(out.shipped), shippedWithPaths: brief(out.shippedWithPaths), coreOnly: brief(out.coreOnly), layaOnly: brief(out.layaOnly), cosRange: r.cosRange, gate: out.gate,
    diagnosticDecomposed: { laya: brief(out.diagnosticDecomposed.laya), core: brief(out.diagnosticDecomposed.core), layaPicks: out.diagnosticDecomposed.layaPicks } }, null, 1));
  await host.shutdown('gate over');
})().catch(async (e) => { console.error('gate fatal:', (e && e.stack) || e); try { await host.shutdown('gate failed'); } catch { /* none */ } process.exitCode = 1; });
