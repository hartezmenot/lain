'use strict';

/** HOW THE PARTS ARE WIRED — typed, persistent, and not recoverable from imports. */

const lainstore = require('./lainstore');

/** THE VERBS. A closed list — an open one degenerates into prose, and prose is what this replaces. Each is a different question somebody actually asks. */
const REL = Object.freeze({
  /** Invokes it directly, in-process. */
  CALLS: 'CALLS',
  /** Cannot function without it. The structural edge; the import graph's kind. */
  DEPENDS_ON: 'DEPENDS_ON',
  /** Transmits to it across a boundary — HTTP, socket, pipe, queue. */
  SENDS: 'SENDS',
  /** Accepts transmissions from it. The other half of SENDS, stored explicitly
   *  because the receiver often does not know the sender exists. */
  RECEIVES: 'RECEIVES',
  /** Is the authority for it. Exactly one owner is the point of saying it. */
  OWNS: 'OWNS',
  READS: 'READS',
  WRITES: 'WRITES',
  /** Produces an event others may consume. */
  EMITS: 'EMITS',
  CONSUMES: 'CONSUMES',
  /** Causes it to start doing something it was not doing. */
  WAKES: 'WAKES',
  /** Waits on it, and cannot proceed until it answers. */
  BLOCKS: 'BLOCKS',
  /** Restores it after a failure. */
  RECOVERS: 'RECOVERS',
});

const VERBS = new Set(Object.values(REL));

/** Verbs whose reverse direction is a different, equally real verb. */
const MIRROR = Object.freeze({
  SENDS: 'RECEIVES',
  RECEIVES: 'SENDS',
  EMITS: 'CONSUMES',
  CONSUMES: 'EMITS',
});

/** How an edge reads in a sentence, from the subject's side. */
const PHRASE = Object.freeze({
  CALLS: 'calls',
  DEPENDS_ON: 'depends on',
  SENDS: 'sends to',
  RECEIVES: 'receives from',
  OWNS: 'owns',
  READS: 'reads',
  WRITES: 'writes',
  EMITS: 'emits to',
  CONSUMES: 'consumes from',
  WAKES: 'wakes',
  BLOCKS: 'blocks on',
  RECOVERS: 'recovers',
});

function empty() { return { edges: [], updatedAt: 0 }; }

function keyOf(e) { return `${e.from}\u0001${e.rel}\u0001${e.to}`; }

function load(root) {
  const body = lainstore.read(root, 'wiring', null);
  if (!body || !Array.isArray(body.edges)) return empty();
  const seen = new Set();
  const edges = [];
  for (const e of body.edges) {
    if (!e || typeof e !== 'object') continue;
    const from = String(e.from || '').trim();
    const to = String(e.to || '').trim();
    const rel = String(e.rel || '').toUpperCase();
    if (!from || !to || !VERBS.has(rel)) continue;
    const edge = {
      from, to, rel,
      via: String(e.via || ''),
      note: String(e.note || ''),
      at: Number(e.at) || 0,
      ...(Array.isArray(e.proof) ? { proof: e.proof, proofAt: Number(e.proofAt) || 0 } : {}),
      ...(e.proofOrigin ? { proofOrigin: String(e.proofOrigin) } : {}),
    };
    const k = keyOf(edge);
    if (seen.has(k)) continue;      // a duplicated edge is one edge
    seen.add(k);
    edges.push(edge);
  }
  return { edges, updatedAt: Number(body.updatedAt) || 0 };
}

function save(root, graph) {
  graph.updatedAt = Date.now();
  // PROOF: an edge depends on both ends' locations and on `via` when it names a file.
  const freshness = require('./freshness');
  let model = null;
  for (const e of graph.edges) {
    if (Array.isArray(e.proof) && e.proofAt === e.at) continue;
    if (!model) { try { model = require('./architecture').load(root); } catch { model = { nodes: {} }; } }
    const locs = [e.from, e.to].map((id) => model.nodes[id] && model.nodes[id].location).filter(Boolean);
    e.proof = freshness.stamp(root, [...locs, ...freshness.pathsIn(root, e.via)]).evidence;
    e.proofAt = e.at;
    delete e.proofOrigin;
  }
  return lainstore.write(root, 'wiring', { edges: graph.edges, updatedAt: graph.updatedAt });
}

/** RECORD AN EDGE. */
function connect(graph, { from, to, rel, via = '', note = '', at = Date.now() } = {}) {
  const f = String(from || '').trim();
  const t = String(to || '').trim();
  const r = String(rel || '').toUpperCase();
  if (!f || !t) return { ok: false, error: 'an edge needs both ends' };
  if (f === t) return { ok: false, error: 'a component cannot be wired to itself' };
  if (!VERBS.has(r)) {
    return { ok: false, error: `unknown relationship "${rel}" — one of ${[...VERBS].join(', ')}` };
  }
  const edge = { from: f, to: t, rel: r, via: String(via), note: String(note), at };
  const k = keyOf(edge);
  const at0 = graph.edges.findIndex((e) => keyOf(e) === k);
  if (at0 >= 0) {
    // MERGED, NOT DUPLICATED. Re-declaring an edge with a `via` it did not have
    // is somebody adding detail, not somebody adding an edge.
    const prev = graph.edges[at0];
    graph.edges[at0] = { ...prev, via: edge.via || prev.via, note: edge.note || prev.note, at };
    return { ok: true, edge: graph.edges[at0], created: false };
  }
  graph.edges.push(edge);
  return { ok: true, edge, created: true };
}

function disconnect(graph, { from, to, rel } = {}) {
  const before = graph.edges.length;
  const r = rel ? String(rel).toUpperCase() : '';
  graph.edges = graph.edges.filter((e) => !(
    (!from || e.from === from) && (!to || e.to === to) && (!r || e.rel === r)
  ));
  return { ok: true, removed: before - graph.edges.length };
}

/** Every edge leaving a node. */
function outgoing(graph, id, rel = '') {
  const r = rel ? String(rel).toUpperCase() : '';
  return graph.edges.filter((e) => e.from === id && (!r || e.rel === r));
}

/** Every edge arriving at a node. */
function incoming(graph, id, rel = '') {
  const r = rel ? String(rel).toUpperCase() : '';
  return graph.edges.filter((e) => e.to === id && (!r || e.rel === r));
}

/** Everything either side of a node. */
function around(graph, id) {
  return { out: outgoing(graph, id), in: incoming(graph, id) };
}

/** A PATH BETWEEN TWO COMPONENTS, if there is one. */
function path(graph, from, to, { maxHops = 8 } = {}) {
  if (from === to) return [];
  const queue = [[from, []]];
  const seen = new Set([from]);
  while (queue.length) {
    const [at, trail] = queue.shift();
    if (trail.length >= maxHops) continue;
    for (const e of outgoing(graph, at)) {
      if (e.to === to) return [...trail, e];
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push([e.to, [...trail, e]]);
    }
  }
  return null;
}

/** WHICH NODES EXIST ONLY AS ENDPOINTS. */
function dangling(graph, model) {
  const known = new Set(Object.keys((model && model.nodes) || {}));
  const out = new Set();
  for (const e of graph.edges) {
    if (!known.has(e.from)) out.add(e.from);
    if (!known.has(e.to)) out.add(e.to);
  }
  return [...out].sort();
}

/** How a single edge reads. */
function sayEdge(e, { model = null, reverse = false } = {}) {
  const nameOf = (id) => {
    const n = model && model.nodes && model.nodes[id];
    return n ? n.name : id;
  };
  const verb = reverse && MIRROR[e.rel] ? PHRASE[MIRROR[e.rel]] : PHRASE[e.rel] || e.rel.toLowerCase();
  const subject = reverse ? nameOf(e.to) : nameOf(e.from);
  const object = reverse ? nameOf(e.from) : nameOf(e.to);
  const via = e.via ? `  (${e.via})` : '';
  const note = e.note ? `  — ${e.note}` : '';
  return `${subject} ${verb} ${object}${via}${note}`;
}

/** ONE NODE'S WIRING, as a person reads it. */
function render(graph, id, { model = null } = {}) {
  const { out, in: incom } = around(graph, id);
  if (!out.length && !incom.length) {
    return `Nothing is recorded about how ${id} is wired.`;
  }
  const lines = [];
  if (out.length) {
    lines.push('OUTWARD');
    for (const e of out) lines.push(`  ${sayEdge(e, { model })}`);
  }
  if (incom.length) {
    if (lines.length) lines.push('');
    lines.push('INWARD');
    for (const e of incom) lines.push(`  ${sayEdge(e, { model })}`);
  }
  return lines.join('\n');
}

/** THE WHOLE GRAPH AS A FLOW, when it is small enough to be worth drawing. */
function summary(graph, { model = null, max = 40 } = {}) {
  if (!graph.edges.length) {
    return 'No wiring has been recorded for this project yet.\n'
      + 'Record one with wiring{op:"connect"} — an import graph cannot express WAKES, BLOCKS or SENDS.';
  }
  const byRel = new Map();
  for (const e of graph.edges) {
    if (!byRel.has(e.rel)) byRel.set(e.rel, []);
    byRel.get(e.rel).push(e);
  }
  const lines = [`WIRING — ${graph.edges.length} relationship(s)`];
  let shown = 0;
  for (const rel of Object.values(REL)) {
    const rows = byRel.get(rel);
    if (!rows || !rows.length) continue;
    lines.push('', `${rel} (${rows.length})`);
    for (const e of rows) {
      if (shown >= max) { lines.push('  [more — ask about one component]'); return lines.join('\n'); }
      lines.push(`  ${sayEdge(e, { model })}`);
      shown += 1;
    }
  }
  return lines.join('\n');
}

module.exports = {
  REL, VERBS, MIRROR, PHRASE,
  empty, load, save, connect, disconnect,
  outgoing, incoming, around, path, dangling,
  sayEdge, render, summary,
};
