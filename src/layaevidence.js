'use strict';

/**
 * LAYA · `ui_evidence_narrower` — FACTS IN, COMPACT RELEVANT EVIDENCE OUT
 * (2026-09-24).
 *
 * Core acquires the live observation (DOM / accessibility / bounds / state /
 * network / console — observationstore.js) and owns it. This compiles one
 * bounded EVIDENCE_SLICE from it for one request:
 *
 *     Core's deterministic score  ─┐
 *                                  ├─ reciprocal-rank fusion → top nodes + their path
 *     Laya: query ↔ node cosine   ─┘   + the API requests + a receipt to expand anything
 *
 * LAYA DOES NOT VOLUNTEER. It runs only when Core's assignment for the input
 * allows the role (dispatch.js) and the role's mode says so
 * (workerruntime.roleMode): SHADOW computes and records, never attaches;
 * AUTO (a passed gate) / FORCE attach the slice as ORDINARY EVIDENCE — the
 * flagship is not told which worker produced it.
 *
 * THE TASK NEVER WAITS FOR PREPARATION. Embedding an observation's nodes is
 * done once per observation (`prepare`, off the task's clock, cached beside
 * the receipt and keyed by the embedding identity); a task's inference is the
 * query alone. Not prepared → bypassed, and preparation starts for next time.
 *
 * THE SLICE NARROWS OBSERVATIONS ONLY. The request, read-only status, required
 * output and acceptance criteria are not part of it and are never rewritten;
 * every node keeps its ref, so the raw observation stays one `observe` call away.
 */

const fs = require('fs');
const path = require('path');
const store = require('./observationstore');

const ROLE = 'ui_evidence_narrower';
const KEEP = 16;
const BATCH = 64;
const RRF_K = 60;
const DEADLINE_MS = 2000;

function nodeText(n) {
  const cls = (n.classes || []).join(' ').replace(/[-_]/g, ' ');
  const a = n.attrs || {};
  return [n.role || n.tag, n.name, n.text, cls, n.id, a.placeholder, a['aria-label'], a.type, a.href].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 200);
}

function vecFile(id) { return path.join(store.dir(), `${id}.laya.json`); }

function fromB64(b64, dim) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  const rows = [];
  for (let i = 0; i + dim <= f.length; i += dim) rows.push(f.slice(i, i + dim));
  return rows;
}

function readPrepared(id) {
  try {
    const j = JSON.parse(fs.readFileSync(vecFile(id), 'utf8'));
    return { ...j, rows: fromB64(j.vectors, j.dim) };
  } catch { return null; }
}

/**
 * PREPARE ONE OBSERVATION: embed every node once, keep the vectors beside the
 * receipt. Returns `{ ok, ms, nodes, calls, tokens, identity }`. Not on any
 * task's path — the benchmark and the SHADOW sidecar call it.
 */
async function prepare(app, id, { timeoutMs = 120000 } = {}) {
  const obs = store.load(id);
  if (!obs) return { ok: false, why: 'no such receipt' };
  const have = readPrepared(id);
  if (have && have.n === (obs.nodes || []).length) return { ok: true, cached: true, ms: 0, nodes: have.n, identity: have.identity };
  const rt = require('./workerruntime');
  const texts = (obs.nodes || []).map(nodeText);
  const t0 = Date.now();
  const parts = [];
  let dim = 0; let tokens = 0; let calls = 0; let identity = '';
  for (let i = 0; i < texts.length; i += BATCH) {
    const r = await rt.call(app, 'laya', { op: 'embed', texts: texts.slice(i, i + BATCH) }, { timeoutMs });
    calls += 1;
    if (!r || !r.vectors) return { ok: false, why: 'the embedding call failed', ms: Date.now() - t0, calls };
    dim = r.dim; identity = `${r.model}|${r.schema}`;
    tokens += (r.usage && r.usage.tokens_in) || 0;
    parts.push(Buffer.from(r.vectors, 'base64'));
  }
  const vectors = Buffer.concat(parts).toString('base64');
  fs.writeFileSync(vecFile(id), JSON.stringify({ id, n: texts.length, dim, identity, vectors, preparedAt: new Date().toISOString(), ms: Date.now() - t0, calls, tokens }), 'utf8');
  return { ok: true, cached: false, ms: Date.now() - t0, nodes: texts.length, calls, tokens, identity };
}

function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

function rrf(order, k = RRF_K) { const m = new Map(); order.forEach((ref, i) => m.set(ref, 1 / (k + i + 1))); return m; }

/**
 * THE EVIDENCE SLICE for one focus over one prepared observation. `laya` is
 * `{ cos: Map(ref → cosine) }` or null (deterministic only).
 */
function slice(obs, focus, { laya = null, keep = KEEP } = {}) {
  const nodes = obs.nodes || [];
  const det = store.queryNodes(obs, focus, nodes.length).map((n) => n.ref);
  const detR = rrf(det);
  const layaOrder = laya ? [...laya.cos.entries()].sort((a, b) => b[1] - a[1]).map(([ref]) => ref) : [];
  const layaR = rrf(layaOrder);
  const fused = nodes.map((n) => ({ n, s: (detR.get(n.ref) || 0) + (layaR.get(n.ref) || 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const top = fused.slice(0, keep).map((x) => x.n);
  const topRefs = new Set(top.map((n) => n.ref));
  const ordered = nodes.filter((n) => topRefs.has(n.ref));
  const rows = ordered.map((n) => {
    const path_ = store.ancestors(obs, n).slice(-4).map((a) => `${a.tag}${a.id ? `#${a.id}` : ''}${(a.classes || [])[0] ? `.${a.classes[0]}` : ''}(${a.ref})`).join(' > ');
    return `▸ ${store.row(n)}${path_ ? `\n    in ${path_}` : ''}`;
  });
  // THE PAGE'S OWN API CALLS, those the question names first — static assets are not runtime relationships.
  const ts = store.terms(focus);
  const hits = (r) => ts.filter((t) => String(r.url).toLowerCase().includes(t)).length;
  const net = (obs.network || []).filter((r) => /\/api\//.test(r.url) || (['fetch', 'xhr'].includes(r.type) && hits(r)))
    .map((r, i) => ({ r, i, h: hits(r) })).sort((a, b) => b.h - a.h || a.i - b.i).map((x) => x.r);
  const margin = fused.length > keep ? fused[0].s - fused[keep].s : fused.length ? fused[0].s : 0;
  const confidence = !top.length ? 0 : margin > 0.01 ? 0.7 : 0.5;
  const text = [
    `EVIDENCE SLICE · observation ${obs.id} · ${top.length} of ${nodes.length} nodes · ${obs.url || ''}`,
    'It narrows OBSERVATIONS only; the request, its read-only status, the output it asks for and its acceptance criteria are unchanged.',
    ...rows,
    net.length ? 'relevant network:' : 'relevant network: none observed',
    ...net.slice(0, 8).map((r) => `  ${r.method} ${r.url} → ${r.status == null ? 'no response' : r.status}${r.ms != null ? ` ${r.ms}ms` : ''}${r.initiator ? ` · from ${r.initiator}` : ''}`),
    `confidence ${confidence}${top.length ? '' : ' · unresolved: nothing matched — expand the receipt'}`,
    `raw: every node keeps its ref — observe {goal:"element", receipt:"${obs.id}", ref:"n…"} expands one, {goal:"page", receipt:"${obs.id}"} pages all ${nodes.length}.`,
  ].join('\n');
  return { text, refs: top.map((n) => n.ref), detRefs: det.slice(0, keep), layaRefs: layaOrder.slice(0, keep), network: net.slice(0, 8).map((r) => r.url), confidence, total: nodes.length };
}

/**
 * ONE LAYA JOB over a prepared observation: embed the query only, score, fuse,
 * slice. Returns `{ ok, slice, ms, usage, bypass }`.
 */
async function compile(app, id, focus, { keep = KEEP, timeoutMs = DEADLINE_MS } = {}) {
  const obs = store.load(id);
  if (!obs) return { ok: false, bypass: 'NO_RECEIPT' };
  const prep = readPrepared(id);
  if (!prep || prep.n !== (obs.nodes || []).length) return { ok: false, bypass: 'NOT_PREPARED' };
  const rt = require('./workerruntime');
  const t0 = Date.now();
  const r = await rt.call(app, 'laya', { op: 'embed', texts: [String(focus || '').slice(0, 300)] }, { timeoutMs });
  const ms = Date.now() - t0;
  if (!r || !r.vectors) return { ok: false, bypass: 'NO_ANSWER', ms };
  if (`${r.model}|${r.schema}` !== prep.identity) return { ok: false, bypass: 'WRONG_MODEL', ms };
  const qv = fromB64(r.vectors, r.dim)[0];
  const cos = new Map();
  (obs.nodes || []).forEach((n, i) => cos.set(n.ref, prep.rows[i] ? cosine(qv, prep.rows[i]) : -1));
  const s = slice(obs, focus, { laya: { cos }, keep });
  const top = [...cos.values()].sort((a, b) => b - a);
  return { ok: true, slice: s, ms, usage: r.usage || {}, cosRange: top.length ? [top[Math.min(keep, top.length) - 1], top[0]] : null };
}

// ---- the turn hook ------------------------------------------------------------------

/**
 * THE SLICE FOR THIS TURN, when Core assigned the role and its mode consumes
 * it. Step 0 computes it; later steps reuse it. SHADOW is recorded after the
 * fact and never attached.
 */
async function take(app, session, step = 0) {
  if (!app || !session) return '';
  const d = session.dispatch;
  const turnKey = (session.messages || []).filter((m) => m.role === 'user').length;
  const st = session._layaEvidence;
  if (st && st.turnKey === turnKey) return step >= 0 ? st.text : '';
  if (!d || d.cls !== 'UI_EVIDENCE' || !(d.observations || []).length) return '';
  if (!require('./dispatch').allows(session, `laya:${ROLE}`)) return '';
  const rt = require('./workerruntime');
  const mode = rt.roleMode(app, 'laya', ROLE);
  const hold = session._layaEvidence = { turnKey, text: '', mode };
  if (mode === 'OFF' || !rt.uses(app, 'laya', 'live_evidence', { shadow: true })) return '';
  const focus = require('./locateassist').intentText(lastUser(session));
  const id = d.observations[0];
  const base = { worker: 'LAYA', role: ROLE, contract: 'evidence_narrower', mode, why: 'Core: a UI-evidence request over a captured observation', receipt: id };
  if (mode === 'SHADOW') {
    // RECORDED, NEVER ATTACHED — and only on a resident model.
    if (!rt.isHot(app, 'laya')) { require('./dispatch').job(session, { ...base, mode: 'SHADOW_SKIPPED', why: 'not resident — a shadow job never loads a model' }); return ''; }
    compile(app, id, focus).then((r) => require('./dispatch').job(session, { ...base, consumed: false, ok: r.ok, bypass: r.bypass || null, ms: r.ms || 0, refs: r.ok ? r.slice.refs : [], resultChars: r.ok ? r.slice.text.length : 0 }))
      .catch(() => null);
    return '';
  }
  const r = await compile(app, id, focus);
  const obs = store.load(id);
  const rawChars = obs ? store.rendered(obs).length : 0;
  const job = require('./dispatch').job(session, { ...base, consumed: r.ok, ok: r.ok, bypass: r.bypass || null, ms: r.ms || 0, facts: obs ? (obs.nodes || []).length : 0,
    refs: r.ok ? r.slice.refs : [], resultChars: r.ok ? r.slice.text.length : 0, rawChars, cosRange: r.cosRange || null, usage: r.usage || null });
  hold.job = job;
  require('./workers').note(session, { contract: 'evidence_narrower', worker: r.ok ? 'LAYA' : 'deterministic', role: ROLE, tier: r.ok ? 'laya' : 'bypass', layaBypass: r.bypass || null,
    ms: r.ms || 0, warmWaitMs: 0, rawChars, outChars: r.ok ? r.slice.text.length : 0, receipt: id, slice: r.ok ? r.slice.refs : [], layaUsage: r.usage || null });
  if (!r.ok) {
    // NOT PREPARED → bypassed now, prepared for next time (never awaited).
    if (r.bypass === 'NOT_PREPARED' && rt.isHot(app, 'laya')) prepare(app, id).catch(() => null);
    return '';
  }
  hold.text = r.slice.text;
  hold.refs = r.slice.refs;
  return hold.text;
}

function lastUser(session) {
  const m = (session.messages || []).slice().reverse().find((x) => x.role === 'user' && typeof x.content === 'string');
  return m ? m.content : '';
}

/**
 * NARROWING DEBT: observation reads this turn that went outside the slice —
 * which refs, how many chars, how many calls. Written onto the job row.
 */
function settle(session) {
  const st = session && session._layaEvidence;
  if (!st || !st.job || !Array.isArray(st.refs)) return null;
  const inSlice = new Set(st.refs);
  const reads = (session.observationReads || []).filter((r) => r.at >= st.job.at);
  const outside = reads.filter((r) => r.refs.some((ref) => !inSlice.has(ref)) || r.goal === 'page');
  st.job.expansions = reads.length;
  st.job.outsideCalls = outside.length;
  st.job.outsideChars = outside.reduce((n, r) => n + (r.chars || 0), 0);
  st.job.outsideRefs = [...new Set(outside.flatMap((r) => r.refs.filter((ref) => !inSlice.has(ref))))].slice(0, 200);
  return st.job;
}

module.exports = { prepare, compile, slice, take, settle, nodeText, readPrepared, ROLE, KEEP };
