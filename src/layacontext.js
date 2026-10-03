'use strict';

/** LAYA · HARNESS CONTEXT & PERCEPTION — Core dispatches, Laya correlates, Core validates (2026-09-24). */

const canonical = require('./canonical');

const ROLES = Object.freeze({
  harness_context_compiler: { gate: 'harness_context', on: ['selection', 'surface', 'edit', 'gug', 'input'] },
  selection_resolver: { gate: 'selection_resolution', on: ['input'] },
  cross_surface_correlator: { gate: 'cross_surface', on: ['selection', 'input'] },
  session_semantic_enrichment: { gate: 'session_enrichment', on: ['edit', 'surface'] },
});
const DEADLINE_MS = 2000;
const MAX_CANDIDATES = 24;
const KEEP = 4;
const MAX_RESULTS = 60;

function stateOf(app) {
  const r = (app && (app._sibling || app)) || {};
  if (!r._layaCtx) r._layaCtx = { queue: [], running: false, inJob: false, results: [], stats: {}, selfDispatchRefused: 0, criticalPathCalls: 0 };
  return r._layaCtx;
}
function statOf(app, role) {
  const s = stateOf(app).stats;
  if (!s[role]) s[role] = { dispatched: 0, skipped: 0, completed: 0, failed: 0, late: 0, validated: 0, invalid: 0, agree: 0, disagree: 0, consumed: 0, rawChars: 0, sliceChars: 0, backgroundMs: 0 };
  return s[role];
}

// ---- the facts Core hands a job (bounded) -------------------------------------------

/** CANDIDATE REFERENTS — CONSUMED FROM CORE'S CANONICAL STATE, never re-derived (2026-09-25). */
function candidates(app, session) {
  const hc = require('./harnesscontext');
  const h = session && session._harness;
  const out = [];
  if (!h) return { list: [], core: null, selection: null };
  const root = session.cwd || process.cwd();
  let sel = null;
  try { sel = hc.selection(app, session); } catch { sel = null; }
  if (sel) {
    out.push({ id: `sel:${sel.id}`, text: describeSelection(sel) });
    const ev = require('./evidencerefs');
    const store = session.evidenceRefs && Array.isArray(session.evidenceRefs.list) ? session.evidenceRefs.list : [];
    for (const e of store.slice().reverse()) {
      if (!e.key || !String(e.key).includes(`:${sel.id}:`) && !String(e.key).endsWith(`:${sel.id}`)) continue;
      if (ev.standing(session, e).state === 'stale') continue;
      out.push({ id: `evidence:${e.id}`, text: `${e.kind}: ${e.summary}` });
    }
    if (sel.symbol) for (const d of (sel.symbol.declarations || []).slice(0, 3)) out.push({ id: `file:${d.file}`, text: `declares ${sel.symbol.name} (${d.file}:${d.line})` });
    if (sel.visual) {
      if (sel.visual.binding && sel.visual.binding.file) out.push({ id: `file:${sel.visual.binding.file}`, text: `style owner ${sel.visual.binding.selector || ''} of the selected element` });
      const comp = sel.visual.component && sel.visual.component.candidates && sel.visual.component.candidates[0];
      if (comp) out.push({ id: `file:${comp.rel}`, text: `component that renders the selected element` });
      const g = require('./gug').get(app, root);
      const n = g && sel.visual.gugId ? g.nodes.get(sel.visual.gugId) : null;
      if (n) {
        const around = [n.parent, ...(n.parent && g.nodes.get(n.parent) ? g.nodes.get(n.parent).children : [])].filter(Boolean);
        for (const id of [...new Set(around)].slice(0, 12)) {
          const m = g.nodes.get(id);
          if (m && id !== n.id) out.push({ id: `gug:${id}`, text: `${m.tag || ''} ${m.name || ''} ${id}`.trim() });
        }
      }
    }
    for (const e of (sel.provenance || []).slice(0, 4)) out.push({ id: `file:${e.path}`, text: `the person edited ${e.path} lines ${e.startLine}-${e.endLine} by hand` });
  }
  try {
    for (const d of require('./lsp/manager').diagnostics(app).filter((x) => x.severity === 'error').slice(0, 6)) out.push({ id: `diag:${d.path}:${d.line}`, text: `error in ${d.path}:${d.line} ${d.message}`.slice(0, 200) });
  } catch { /* no servers */ }
  try {
    for (const p of require('./runtimeregistry').list({ project: root }).filter((x) => x.alive).slice(0, 4)) out.push({ id: `rt:${p.id}`, text: `running ${p.purpose}: ${p.label || p.command || ''}`.slice(0, 160) });
  } catch { /* no registry */ }
  try {
    const t = require('./idecontext').terminalTail(app);
    const last = t && t.text ? t.text.trim().split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' | ') : '';
    if (last) out.push({ id: 'term:last', text: `terminal: ${last}`.slice(0, 200) });
  } catch { /* no terminal */ }
  for (const a of (h.actions || []).slice(-8)) if (a.file) out.push({ id: `file:${a.file}`, text: a.text });
  const seen = new Set();
  return { list: out.filter((c) => (seen.has(c.id) ? false : seen.add(c.id))).slice(0, MAX_CANDIDATES), core: sel ? `sel:${sel.id}` : null, selection: sel ? sel.id : null };
}

function describeSelection(sel) {
  if (sel.source) return `selected ${sel.symbol ? `identifier ${sel.symbol.name}` : 'text'} in ${sel.source.file} lines ${sel.source.startLine}-${sel.source.endLine}`;
  if (sel.visual) return `selected ${sel.visual.label || sel.visual.selector || 'element'}${sel.visual.binding && sel.visual.binding.file ? ` styled by ${sel.visual.binding.file}` : ''}`;
  return `selected ${sel.kind}`;
}

// the jobs: PURE functions of (facts, embed)

const JOBS = {
  async harness_context_compiler(facts, embed) {
    const texts = [facts.query, ...facts.candidates.map((c) => c.text)];
    const v = await embed(texts);
    if (!v) return null;
    const scored = facts.candidates.map((c, i) => ({ id: c.id, cos: dot(v[0], v[i + 1]) })).sort((a, b) => b.cos - a.cos);
    return { refs: scored.slice(0, facts.keep).map((s) => s.id), scores: scored.slice(0, facts.keep).map((s) => s.cos) };
  },
  async selection_resolver(facts, embed) {
    const texts = [facts.query, ...facts.candidates.map((c) => c.text)];
    const v = await embed(texts);
    if (!v) return null;
    const scored = facts.candidates.map((c, i) => ({ id: c.id, cos: dot(v[0], v[i + 1]) })).sort((a, b) => b.cos - a.cos);
    return scored.length ? { refs: [scored[0].id], scores: [scored[0].cos], margin: scored.length > 1 ? scored[0].cos - scored[1].cos : null } : null;
  },
  async cross_surface_correlator(facts, embed) {
    const visual = facts.candidates.filter((c) => c.id.startsWith('gug:'));
    const code = facts.candidates.filter((c) => !c.id.startsWith('gug:'));
    if (!visual.length || !code.length) return { refs: [], scores: [] };
    const v = await embed([visual[0].text, ...code.map((c) => c.text)]);
    if (!v) return null;
    const scored = code.map((c, i) => ({ id: c.id, cos: dot(v[0], v[i + 1]) })).sort((a, b) => b.cos - a.cos);
    return { refs: [visual[0].id, scored[0].id], scores: [1, scored[0].cos] };
  },
  async session_semantic_enrichment(facts, embed) {
    const actions = facts.candidates.filter((c) => c.id.startsWith('file:'));
    if (actions.length < 2) return { refs: [], scores: [] };
    const v = await embed(actions.map((c) => c.text));
    if (!v) return null;
    // The actions most related to the latest one: a thread of work, not a label.
    const last = v[v.length - 1];
    const scored = actions.slice(0, -1).map((c, i) => ({ id: c.id, cos: dot(last, v[i]) })).sort((a, b) => b.cos - a.cos);
    return { refs: [actions[actions.length - 1].id, ...scored.slice(0, facts.keep - 1).map((s) => s.id)], scores: [1, ...scored.slice(0, facts.keep - 1).map((s) => s.cos)] };
  },
};

function dot(a, b) { let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]; return s; }

// ---- validation: CORE OWNS FACTS ---------------------------------------------------------

/** IS THIS HYPOTHESIS TRUE OF THE CURRENT STATE? */
function validate(app, session, hyp) {
  if (!hyp || !Array.isArray(hyp.refs)) return { valid: false, why: 'no hypothesis' };
  const h = session && session._harness;
  if (h && hyp.generation != null && h.generation !== hyp.generation) return { valid: false, late: true, why: `context moved on (${hyp.generation} → ${h.generation})` };
  const root = (session && session.cwd) || process.cwd();
  const g = require('./gug').get(app, root);
  for (const ref of hyp.refs) {
    if (ref.startsWith('gug:')) {
      const id = ref.slice(4);
      if (!g || !g.nodes.has(id)) return { valid: false, why: `${ref} is not a node of the current GUG` };
      if (hyp.gugGeneration != null && g.generation !== hyp.gugGeneration) return { valid: false, why: `GUG generation changed (${hyp.gugGeneration} → ${g.generation})` };
    } else if (ref.startsWith('file:')) {
      const rel = ref.slice(5);
      try { if (!require('fs').existsSync(require('path').join(root, rel))) return { valid: false, why: `${rel} does not exist` }; } catch { return { valid: false, why: 'file check failed' }; }
    } else if (ref.startsWith('sel:')) {
      // THE CANONICAL SELECTION is still this one (by id), or the hypothesis is about a screen left behind.
      let cur = null;
      try { cur = require('./harnesscontext').selection(app, session); } catch { cur = null; }
      if (!cur || `sel:${cur.id}` !== ref) return { valid: false, why: `${ref} is no longer the selection` };
    } else if (ref.startsWith('evidence:')) {
      const r = require('./evidencerefs').get(session, ref);
      if (!r.entry || r.state === 'stale') return { valid: false, why: `${ref} is ${r.entry ? 'stale' : 'gone'}` };
    } else if (ref.startsWith('diag:') || ref.startsWith('rt:') || ref === 'term:last') {
      // Evidence Core offered at this generation; the generation check above already vouched for it.
    } else return { valid: false, why: `${ref}: an unknown kind of reference` };
  }
  return { valid: true };
}

// ---- dispatch (Core's) -----------------------------------------------------------------

/** A HARNESS EVENT → the roles that listen to it, each in its own mode. */
function enqueue(app, session, event = {}) {
  const st = stateOf(app);
  if (st.inJob) { st.selfDispatchRefused += 1; return false; }
  if (!app || !session) return false;
  const rt = require('./workerruntime');
  let queued = false;
  for (const [role, spec] of Object.entries(ROLES)) {
    if (!spec.on.includes(event.type)) continue;
    const mode = rt.roleMode(app, 'laya', role);
    if (mode === 'OFF') continue;
    // An INPUT-time role joins only where Core's assignment names it (dispatch.owners).
    if (event.type === 'input' && !require('./dispatch').allows(session, `laya:${role}`) && role !== 'harness_context_compiler') continue;
    // COALESCED: the latest event per role is the only one worth answering.
    st.queue = st.queue.filter((j) => j.role !== role || j.session !== session);
    st.queue.push({ role, mode, session, event: { type: event.type, text: String(event.text || '').slice(0, 300) }, at: Date.now() });
    queued = true;
  }
  if (queued && !st.running) setImmediate(() => { drain(app).catch(() => null); });
  return queued;
}

async function drain(app) {
  const st = stateOf(app);
  if (st.running) return;
  st.running = true;
  try {
    while (st.queue.length) await runJob(app, st.queue.shift());
  } finally { st.running = false; }
}

function queryOf(session, job) {
  if (job.event.text) return job.event.text;
  const m = (session.messages || []).slice().reverse().find((x) => x.role === 'user' && typeof x.content === 'string');
  const h = session._harness || {};
  const last = (h.actions || []).slice(-1)[0];
  return String((m && m.content) || (last && last.text) || '').slice(0, 300);
}

async function runJob(app, job) {
  const rt = require('./workerruntime');
  const s = statOf(app, job.role);
  const session = job.session;
  const h = session._harness || { generation: 0 };
  s.dispatched += 1;
  // SHADOW NEVER LOADS A MODEL: it runs on a resident one or not at all.
  if (!rt.isHot(app, 'laya') && (job.mode === 'SHADOW' || !rt.uses(app, 'laya', ROLES[job.role].gate, { shadow: true }))) { s.skipped += 1; return record(app, job, { skipped: 'not resident' }); }
  const c = candidates(app, session);
  if (!c.list || !c.list.length) { s.skipped += 1; return record(app, job, { skipped: 'no candidates' }); }
  const facts = { query: queryOf(session, job), candidates: c.list, keep: KEEP };
  const rawChars = canonical.stringify(c.list).length;
  const g = require('./gug').get(app, session.cwd || process.cwd());
  const startGen = h.generation;
  const embed = async (texts) => {
    const r = await rt.call(app, 'laya', { op: 'embed', texts: texts.slice(0, MAX_CANDIDATES + 1).map((t) => String(t).slice(0, 300)) }, { timeoutMs: DEADLINE_MS });
    if (!r || !r.vectors) return null;
    const buf = Buffer.from(r.vectors, 'base64');
    const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
    const rows = [];
    for (let i = 0; i + r.dim <= f.length; i += r.dim) rows.push(f.slice(i, i + r.dim));
    return rows;
  };
  const t0 = Date.now();
  const st = stateOf(app);
  let out = null;
  st.inJob = true;
  try { out = await JOBS[job.role](facts, embed); } catch { out = null; } finally { st.inJob = false; }
  s.backgroundMs += Date.now() - t0;
  if (!out) { s.failed += 1; return record(app, job, { failed: true, ms: Date.now() - t0 }); }
  s.completed += 1;
  const hyp = { role: job.role, refs: out.refs || [], scores: out.scores || [], generation: startGen, gugGeneration: g ? g.generation : null };
  const v = validate(app, session, hyp);
  if (v.late) s.late += 1;
  else if (v.valid) s.validated += 1; else s.invalid += 1;
  // REFERENT RECALL against Core's own explicit referent, where there is one.
  if (c.core && hyp.refs.length) { if (hyp.refs.includes(c.core)) s.agree += 1; else s.disagree += 1; }
  const text = v.valid ? render(job.role, hyp, c.list) : '';
  s.rawChars += rawChars; s.sliceChars += text.length;
  return record(app, job, { hyp, valid: v.valid, why: v.why || '', late: Boolean(v.late), core: c.core, text, rawChars, ms: Date.now() - t0 });
}

function render(role, hyp, list) {
  const byId = new Map(list.map((c) => [c.id, c.text]));
  const lines = hyp.refs.slice(0, KEEP).map((r) => `- ${r}${byId.has(r) ? ` (${byId.get(r).slice(0, 80)})` : ''}`);
  return lines.length ? [`context correlation (${role}, validated by Core):`, ...lines].join('\n') : '';
}

function record(app, job, fields) {
  const st = stateOf(app);
  const r = { role: job.role, mode: job.mode, event: job.event.type, at: Date.now(), session: job.session.id || null, consumed: false, ...fields };
  // SESSION-BOUND: a result is only ever offered to the session it was about.
  Object.defineProperty(r, '_session', { value: job.session, enumerable: false });
  st.results.push(r);
  if (st.results.length > MAX_RESULTS) st.results.splice(0, st.results.length - MAX_RESULTS);
  return r;
}

/** WHAT CORE MAY PUT IN THE PACKET: the newest VALIDATED result of an AUTO or FORCE role, for THIS session, at THIS context generation. */
function consumable(app, session) {
  const st = stateOf(app);
  const h = session && session._harness;
  if (!h) return '';
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r._session !== session || !r.valid || !r.text || (r.mode !== 'AUTO' && r.mode !== 'FORCE')) continue;
    if (!r.hyp || r.hyp.generation !== h.generation) { r.late = true; continue; }
    const again = validate(app, session, r.hyp);
    if (!again.valid) continue;
    if (!r.consumed) { r.consumed = true; statOf(app, r.role).consumed += 1; }
    return r.text;
  }
  return '';
}

/** The SHADOW / AUTO metrics per role, for `/workers` and reports. */
function metrics(app) {
  const st = stateOf(app);
  const out = {};
  for (const role of Object.keys(ROLES)) {
    const s = statOf(app, role);
    out[role] = { ...s, compression: s.sliceChars ? +(s.rawChars / s.sliceChars).toFixed(1) : null, referentRecall: s.agree + s.disagree ? +(s.agree / (s.agree + s.disagree)).toFixed(2) : null,
      lateRate: s.completed ? +(s.late / s.completed).toFixed(2) : null, falseCorrelation: s.completed ? +(s.invalid / s.completed).toFixed(2) : null };
  }
  return { roles: out, queued: st.queue.length, running: st.running, selfDispatchRefused: st.selfDispatchRefused, criticalPathCalls: st.criticalPathCalls };
}

/** LOAD LAYA WHEN LAIN OPENS — only when a role will be consumed (AUTO/FORCE) or the person explicitly asked for a SHADOW role (warm ≠ participate). */
function prewarm(app) {
  try {
    const s = app && app.session;
    if (!s || !s.cwd) return false;
    const rt = require('./workerruntime');
    if (!rt.wantsResident(app, 'laya')) return false;
    const any = rt.roles(app, 'laya').some((r) => r.role !== 'source_file_ranker' && (r.mode === 'AUTO' || r.mode === 'FORCE' || (r.mode === 'SHADOW' && r.explicit)));
    if (any) rt.prewarm(app, 'laya');
    return any;
  } catch { return false; }
}

function _reset(app) { const r = (app && (app._sibling || app)) || {}; delete r._layaCtx; }

module.exports = { ROLES, JOBS, enqueue, drain, validate, candidates, consumable, metrics, prewarm, stateOf, _reset, DEADLINE_MS };
