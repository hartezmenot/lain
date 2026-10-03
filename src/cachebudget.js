'use strict';

/** THE CONTEXT BUDGETER — before a flagship request, what will it cost in UNCACHED input, who is responsible, and can Core make it cheaper without… */

const canonical = require('./canonical');

const TARGET = 0.05;
const CEILING = 0.08;

/** Optional volatile sections, with the floor each may be cut to. Everything else is required. */
const REDUCIBLE = [
  { head: '# Working tree (git)', floor: 600, recover: 'run git status for the rest' },
  { head: '# In the IDE right now', floor: 1200, recover: 'the IDE still holds it; ask for the selection or file again' },
  { head: '# Harness context (Core)', floor: 800, recover: 'Core holds the full Harness context; ask for it' },
  { head: '# Likely relevant files', floor: 600, recover: 'search or locate for more candidates' },
  { head: 'EVIDENCE SLICE', floor: 1500, recover: 'expand the receipt with observe' },
  { head: '# Pinned files', floor: 2000, recover: 'read_file the pinned file' },
];

function ceilings(cfg = {}) {
  const c = (cfg && cfg.contextBudget) || {};
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    target: n(c.target, TARGET), ceiling: n(c.ceiling, CEILING),
    // ABSOLUTE ceilings, in characters (≈ tokens × 4) — observable, configurable.
    toolResultChars: n(c.toolResultChars, 24000), harnessChars: n(c.harnessChars, 2400), gugChars: n(c.gugChars, 1800),
    layaChars: n(c.layaChars, 600), deltaChars: n(c.deltaChars, 1200), uncachedChars: n(c.uncachedChars, 48000),
  };
}

// ---- serialisation --------------------------------------------------------------

/** THE BYTES A PREFIX CACHE SEES, provider-neutral: the tool schemas in their order, then every message. */
function serialize(wire, tools) {
  const segs = [];
  let s = '';
  const add = (label, text) => { segs.push({ label, start: s.length, end: s.length + text.length }); s += text; };
  add('tools', JSON.stringify((tools || []).map((t) => [t.name, t.description, t.parameters])));
  const callName = new Map();
  for (const m of wire || []) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) callName.set(c.id, c.name);
    const body = JSON.stringify([m.role, typeof m.content === 'string' ? m.content : m.content == null ? '' : m.content, m.tool_calls ? m.tool_calls.map((c) => [c.id, c.name, c.arguments || c.input || null]) : null, m.tool_call_id || null]);
    if (m._ctx) { add(`ctx:${m._ctx}`, body); continue; }   // anchored context is HISTORY (append-only), not the tail
    if (m._live) {
      // THE VOLATILE TAIL, split by its own section headings.
      const heads = [...String(m.content).matchAll(/(?:^|\n)(# [^\n]+|EVIDENCE SLICE[^\n]*)/g)];
      if (!heads.length) { add('live', body); continue; }
      let at = 0;
      const text = body;
      const offs = heads.map((h) => ({ head: h[1].slice(0, 40), idx: text.indexOf(h[1]) })).filter((h) => h.idx >= 0);
      if (offs.length && offs[0].idx > 0) { add('live', text.slice(0, offs[0].idx)); at = offs[0].idx; }
      offs.forEach((h, i) => { const end = i + 1 < offs.length ? offs[i + 1].idx : text.length; if (end > at) { add(`live:${h.head}`, text.slice(at, end)); at = end; } });
      if (at < text.length) add('live', text.slice(at));
      continue;
    }
    add(m.role === 'tool' ? `tool:${callName.get(m.tool_call_id) || 'result'}` : m._ctx ? `ctx:${m._ctx}` : m.role, body);
  }
  return { s, segs };
}

function lcp(a, b) { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; }

/** Who owns the bytes after the shared prefix, largest first. */
function owners(segs, from) {
  const by = new Map();
  for (const g of segs) {
    const lo = Math.max(g.start, from);
    if (g.end <= lo) continue;
    by.set(g.label, (by.get(g.label) || 0) + (g.end - lo));
  }
  return [...by.entries()].map(([owner, chars]) => ({ owner, chars })).sort((a, b) => b.chars - a.chars);
}

// ---- the plan -----------------------------------------------------------------

function lineageOf(session, pc) {
  const key = `${pc.model || ''}|${pc.connectionId || pc.provider || ''}`;
  if (!session._cacheLineage || session._cacheLineage.key !== key) {
    const prevEpoch = session._cacheLineage ? session._cacheLineage.epoch : 0;
    session._cacheLineage = { key, epoch: prevEpoch + (session._cacheLineage ? 1 : 0), prev: null, routeChanged: Boolean(session._cacheLineage) };
  }
  return session._cacheLineage;
}

/** PLAN ONE REQUEST: warmth, epoch, expected ratio, owners. */
function plan(session, pc, wire, tools, cfg = {}) {
  const lim = ceilings(cfg);
  const L = lineageOf(session, pc);
  const { s, segs } = serialize(wire, tools);
  const toolsSeg = segs[0];
  const toolsHash = canonical.hash(s.slice(toolsSeg.start, toolsSeg.end));
  const sys = segs.find((g) => g.label === 'system');
  const sysHash = sys ? canonical.hash(s.slice(sys.start, sys.end)) : '';
  const sysRaw = String(((wire || []).find((m) => m.role === 'system') || {}).content || '');
  let warmth = 'WARM';
  let epochReason = null;
  let shared = 0;
  const p = L.prev;
  if (!p) { warmth = L.routeChanged ? 'EPOCH_RESET' : 'COLD'; epochReason = L.routeChanged ? 'model or route changed' : 'first request of this lineage'; }
  else if (p.toolsHash !== toolsHash) {
    const now = new Set((tools || []).map((t) => t.name)); const was = new Set(p.toolNames);
    const added = [...now].filter((n) => !was.has(n)); const removed = [...was].filter((n) => !now.has(n));
    warmth = 'EPOCH_RESET'; epochReason = `tool surface changed${added.length ? ` +${added.join(',')}` : ''}${removed.length ? ` -${removed.join(',')}` : ''}${!added.length && !removed.length ? ' (schema text)' : ''}`;
  } else if (p.sysHash !== sysHash) { warmth = 'EPOCH_RESET'; epochReason = `system prompt changed at "${firstDiffHeading(p.sysText, sysRaw)}"`; }
  else {
    shared = lcp(p.s, s);
    // APPEND-ONLY? The previous request's history (all but its volatile tail) must survive whole.
    if (shared < p.historyEnd) { warmth = 'EPOCH_RESET'; epochReason = 'history rewritten (compaction or a changed earlier message)'; }
  }
  if (warmth === 'EPOCH_RESET') { L.epoch += 1; shared = 0; }
  const chars = s.length;
  const uncachedChars = chars - shared;
  const r = chars ? uncachedChars / chars : 0;
  const out = {
    lineage: L.key, epoch: L.epoch, warmth, epochReason, chars, cachedChars: shared, uncachedChars, ratio: +r.toFixed(4),
    status: warmth !== 'WARM' ? warmth : r <= lim.target ? 'SEND' : r <= lim.ceiling ? 'PRESSURE' : 'OVER',
    owners: owners(segs, shared).slice(0, 8), reductions: [], exception: null,
    sincePrevMs: p ? Date.now() - p.at : null,
    contextGeneration: session._harness ? session._harness.generation : null,
    absoluteOver: uncachedChars > lim.uncachedChars,
    _commit: { s, toolsHash, sysHash, sysText: sysRaw, toolNames: (tools || []).map((t) => t.name), historyEnd: historyEnd(segs) },
  };
  Object.defineProperty(out, '_commit', { enumerable: false, value: out._commit });
  return out;
}

function historyEnd(segs) { const live = segs.find((g) => g.label.startsWith('live')); return live ? live.start : (segs.length ? segs[segs.length - 1].end : 0); }

function firstDiffHeading(a, b) {
  const before = String(b || '').slice(0, lcp(String(a || ''), String(b || '')));
  const m = before.match(/(?:^|\n)# [^\n]+/g);
  return m ? m[m.length - 1].trim().slice(0, 60) : 'the start';
}

/** Record this request as the lineage's latest (after any reduction was applied). */
function commit(session, pl) {
  const L = session && session._cacheLineage;
  if (!L || !pl || !pl._commit) return;
  L.prev = { ...pl._commit, at: Date.now() };
}

/** CUT OPTIONAL TAIL SECTIONS TO THEIR FLOORS, largest owner first, until the expected ratio is within the ceiling or nothing optional is left. */
function reduceLive(live, pl, cfg = {}) {
  const lim = ceilings(cfg);
  let text = String(live || '');
  const done = [];
  const needed = pl.uncachedChars - Math.floor(lim.ceiling * pl.chars);
  let saved = 0;
  const parts = sections(text);
  const order = parts.map((p, i) => ({ ...p, i, rule: REDUCIBLE.find((r) => p.head.startsWith(r.head)) }))
    .filter((p) => p.rule && p.body.length > p.rule.floor + 200).sort((a, b) => b.body.length - a.body.length);
  for (const p of order) {
    if (saved >= needed) break;
    const cut = p.body.length - p.rule.floor;
    parts[p.i].body = `${p.body.slice(0, p.rule.floor)}\n[… ${cut} chars held back by Core's context budget (warm uncached over ${Math.round(lim.ceiling * 100)}%); ${p.rule.recover}]`;
    saved += cut;
    done.push({ owner: p.head.slice(0, 40), cutChars: cut });
  }
  if (done.length) text = parts.map((p) => p.body).join('');
  return { live: text, reductions: done, savedChars: saved };
}

function sections(text) {
  const idx = [];
  const re = /(?:^|\n\n)(# [^\n]+|EVIDENCE SLICE[^\n]*)/g;
  let m;
  while ((m = re.exec(text))) idx.push({ at: m.index === 0 ? 0 : m.index + 2, head: m[1] });
  if (!idx.length) return [{ head: '', body: text }];
  const out = [];
  if (idx[0].at > 0) out.push({ head: '', body: text.slice(0, idx[0].at) });
  idx.forEach((h, i) => out.push({ head: h.head, body: text.slice(h.at, i + 1 < idx.length ? idx[i + 1].at : text.length) }));
  return out;
}

/** The exception a still-over request carries: owner and cause, never silence. */
function exception(pl) {
  const top = pl.owners.slice(0, 3);
  const evidence = top.filter((o) => o.owner.startsWith('tool:') || o.owner === 'user');
  return {
    reason: evidence.length ? 'new evidence the task requires (tool results / the request) — not reducible without losing it' : 'required volatile context',
    owners: top,
  };
}

module.exports = { plan, commit, reduceLive, exception, serialize, lcp, owners, ceilings, sections, REDUCIBLE, TARGET, CEILING };
