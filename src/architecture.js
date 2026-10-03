'use strict';

/** THE INTENDED ARCHITECTURE — what this project is MEANT to be. */

const lainstore = require('./lainstore');

/** HOW FAR SOMETHING WAS TAKEN. */
const STATUS = Object.freeze({
  /** Decided, not built. A legitimate resting state, not a deficiency. */
  PLANNED: 'PLANNED',
  /** Some of it exists. The gap is the interesting part; say what it is. */
  PARTIAL: 'PARTIAL',
  /** It is built. Nothing has confirmed it behaves. */
  IMPLEMENTED: 'IMPLEMENTED',
  /** Something checked it and said what it checked. */
  VERIFIED: 'VERIFIED',
});

/** WHAT THE DISK SAYS. The reconciler's axis, and no author may write it. */
const OBSERVED = Object.freeze({
  /** The location exists and looks like what was described. */
  PRESENT: 'PRESENT',
  /** Nothing is at the recorded location. */
  MISSING: 'MISSING',
  /** It is there and it is broken — empty, unparseable, truncated. */
  DAMAGED: 'DAMAGED',
  /** It is there, it is fine, and it is no longer what was described. */
  DRIFTED: 'DRIFTED',
  /** Nothing has looked, or the node names no location to look at. */
  UNKNOWN: 'UNKNOWN',
});

/** Node kinds. Loose on purpose — a project decides its own nouns. */
const TYPE = Object.freeze({
  SYSTEM: 'SYSTEM',
  LAYER: 'LAYER',
  COMPONENT: 'COMPONENT',
  MODULE: 'MODULE',
  SERVICE: 'SERVICE',
  WORKER: 'WORKER',
  SURFACE: 'SURFACE',
  STORE: 'STORE',
  CONCEPT: 'CONCEPT',
});

const STATUSES = new Set(Object.values(STATUS));
const OBSERVATIONS = new Set(Object.values(OBSERVED));

/** A stable id from a name, so two authors naming the same node collide. */
function slug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function idFor(parentId, name) {
  const own = slug(name);
  if (!own) return '';
  return parentId ? `${parentId}.${own}` : own;
}

function empty() {
  return { nodes: {}, updatedAt: 0 };
}

/** Everything a node carries. Absent fields are absent, never guessed. */
function blank(id, name) {
  return {
    id,
    name: String(name || id),
    type: TYPE.COMPONENT,
    purpose: '',
    status: STATUS.PLANNED,
    owner: '',
    /** Project-relative. A node without one is pure design and says so. */
    location: '',
    parent: '',
    children: [],
    /** Ids of nodes this one needs. Structural, not traffic — see wiring.js. */
    dependencies: [],
    /** Dictionary terms that explain this node. */
    concepts: [],
    /** How it is checked, and what the last check said. */
    verification: { how: '', at: 0, by: '', result: '' },
    /** THE RECONCILER'S FIELD. No other writer. */
    observed: { status: OBSERVED.UNKNOWN, at: 0, note: '', fingerprint: '' },
    createdAt: 0,
    updatedAt: 0,
  };
}

// PERSISTENCE

/** Load the architecture, or an empty one. */
function load(root) {
  const body = lainstore.read(root, 'architecture', null);
  if (!body || typeof body !== 'object' || !body.nodes || typeof body.nodes !== 'object') return empty();
  const nodes = {};
  for (const [id, n] of Object.entries(body.nodes)) {
    if (!n || typeof n !== 'object') continue;
    const base = blank(id, n.name);
    nodes[id] = {
      ...base,
      ...n,
      id,
      children: Array.isArray(n.children) ? n.children.filter((c) => typeof c === 'string') : [],
      dependencies: Array.isArray(n.dependencies) ? n.dependencies.filter((c) => typeof c === 'string') : [],
      concepts: Array.isArray(n.concepts) ? n.concepts.filter((c) => typeof c === 'string') : [],
      status: STATUSES.has(n.status) ? n.status : STATUS.PLANNED,
      verification: { ...base.verification, ...(n.verification || {}) },
      observed: {
        ...base.observed,
        ...(n.observed || {}),
        status: OBSERVATIONS.has(n.observed && n.observed.status) ? n.observed.status : OBSERVED.UNKNOWN,
      },
    };
  }
  return { nodes, updatedAt: Number(body.updatedAt) || 0 };
}

function save(root, model) {
  model.updatedAt = Date.now();
  return lainstore.write(root, 'architecture', { nodes: model.nodes, updatedAt: model.updatedAt });
}

/** SEED CANDIDATE NODES FROM THE INDEX — observations, never intent. */
function seed(model, files, { cap = 120 } = {}) {
  const known = new Set(Object.values(model.nodes).map((n) => n.location).filter(Boolean));
  let added = 0;
  let skipped = 0;
  for (const f of Array.isArray(files) ? files : []) {
    if (added >= cap) break;
    const rel = String((f && (f.path || f.rel)) || '').replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!rel || !/\.(js|cjs|mjs|ts|py|rs)$/i.test(rel) || rel.includes('node_modules/')) continue;
    if (known.has(rel)) { skipped += 1; continue; }
    const id = slug(rel.replace(/\.[^.]+$/, '')) || slug(rel);
    if (model.nodes[id]) { known.add(rel); skipped += 1; continue; }
    const node = blank(id, rel.split('/').pop());
    node.location = rel;
    node.origin = 'seed';
    node.createdAt = Date.now();
    node.updatedAt = Date.now();
    model.nodes[id] = node;
    known.add(rel);
    added += 1;
  }
  return { added, skipped, capped: added >= cap };
}

// EDITING

/** DECLARE A NODE, or update the one that is already there. */
function declare(model, spec) {
  const name = String((spec && spec.name) || '').trim();
  const parentId = String((spec && spec.parent) || '').trim();
  const id = String((spec && spec.id) || '').trim() || idFor(parentId, name);
  if (!id) return { ok: false, error: 'a node needs a name' };
  if (parentId && !model.nodes[parentId]) {
    return { ok: false, error: `no such parent "${parentId}" — declare it first` };
  }

  const existing = model.nodes[id];
  const node = existing ? { ...existing } : blank(id, name || id);
  if (!existing) node.createdAt = Date.now();

  if (name) node.name = name;
  if (spec.type) node.type = String(spec.type).toUpperCase();
  if (spec.purpose != null) node.purpose = String(spec.purpose);
  if (spec.owner != null) node.owner = String(spec.owner);
  if (spec.location != null) node.location = String(spec.location).replace(/\\/g, '/');
  if (spec.status != null) {
    const s = String(spec.status).toUpperCase();
    if (!STATUSES.has(s)) {
      // NAMED, NOT COERCED. A status quietly rounded to PLANNED is a claim
      // about the project that nobody made.
      return { ok: false, error: `unknown status "${spec.status}" — one of ${[...STATUSES].join(', ')}` };
    }
    node.status = s;
  }
  if (Array.isArray(spec.dependencies)) node.dependencies = spec.dependencies.map(String).filter(Boolean);
  if (Array.isArray(spec.concepts)) node.concepts = spec.concepts.map(String).filter(Boolean);
  if (spec.verification && typeof spec.verification === 'object') {
    node.verification = { ...node.verification, ...spec.verification };
  }
  node.parent = parentId || node.parent || '';
  node.updatedAt = Date.now();
  model.nodes[id] = node;

  if (node.parent) {
    const p = model.nodes[node.parent];
    if (p && !p.children.includes(id)) p.children = [...p.children, id];
  }
  return { ok: true, node, created: !existing };
}

/** REMOVE A NODE AND ITS DESCENDANTS. */
function forget(model, id) {
  const node = model.nodes[id];
  if (!node) return { ok: false, error: `no such node "${id}"` };
  const doomed = [];
  const walk = (nid) => {
    doomed.push(nid);
    for (const c of (model.nodes[nid] || { children: [] }).children) walk(c);
  };
  walk(id);
  for (const d of doomed) delete model.nodes[d];
  for (const n of Object.values(model.nodes)) {
    n.children = n.children.filter((c) => !doomed.includes(c));
    n.dependencies = n.dependencies.filter((c) => !doomed.includes(c));
  }
  return { ok: true, removed: doomed };
}

/** RECORD A VERIFICATION — and refuse one with no evidence. */
function verify(model, id, { how, result, by = 'lain', at = Date.now() } = {}) {
  const node = model.nodes[id];
  if (!node) return { ok: false, error: `no such node "${id}"` };
  const h = String(how || '').trim();
  const r = String(result || '').trim();
  if (!h || !r) {
    return { ok: false, error: 'a verification must say HOW it was checked and WHAT the check said' };
  }
  node.verification = { how: h, result: r, by: String(by), at: Number(at) || Date.now() };
  node.status = STATUS.VERIFIED;
  node.updatedAt = Date.now();
  return { ok: true, node };
}

/** THE RECONCILER'S DOOR — the only way `observed` is ever written. */
function observe(model, id, { status, note = '', fingerprint = '', at = Date.now() }) {
  const node = model.nodes[id];
  if (!node) return false;
  if (!OBSERVATIONS.has(status)) return false;
  node.observed = { status, note: String(note), fingerprint: String(fingerprint), at };
  return true;
}

// READING

function roots(model) {
  return Object.values(model.nodes)
    .filter((n) => !n.parent || !model.nodes[n.parent])
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function childrenOf(model, id) {
  return (model.nodes[id] ? model.nodes[id].children : [])
    .map((c) => model.nodes[c])
    .filter(Boolean)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** FIND A NODE by id, by name, or by the tail of a dotted id. */
function find(model, query) {
  const q = String(query || '').trim();
  if (!q) return { matches: [] };
  if (model.nodes[q]) return { matches: [model.nodes[q]] };
  const lower = q.toLowerCase();
  const s = slug(q);
  const exact = Object.values(model.nodes).filter(
    (n) => n.name.toLowerCase() === lower || n.id.endsWith(`.${s}`) || n.id === s,
  );
  if (exact.length) return { matches: exact };
  const loose = Object.values(model.nodes).filter(
    (n) => n.name.toLowerCase().includes(lower) || n.id.includes(s),
  );
  return { matches: loose };
}

/** The chain from a root down to this node. What "architectural parent" means. */
function ancestry(model, id) {
  const out = [];
  let cur = model.nodes[id];
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parent ? model.nodes[cur.parent] : null;
  }
  return out;
}

/** WHAT TO REPORT, when intent and observation disagree. */
function effective(node) {
  const o = node.observed || { status: OBSERVED.UNKNOWN };
  if (o.status === OBSERVED.MISSING && node.status !== STATUS.PLANNED) {
    return { label: `${node.status} / MISSING`, alarm: true, why: 'it was built and it is not there now' };
  }
  if (o.status === OBSERVED.DAMAGED) {
    return { label: `${node.status} / DAMAGED`, alarm: true, why: 'the file is there and it is broken' };
  }
  if (o.status === OBSERVED.DRIFTED) {
    return { label: `${node.status} / DRIFTED`, alarm: true, why: 'it no longer matches what was recorded' };
  }
  if (node.status === STATUS.PLANNED && o.status === OBSERVED.PRESENT) {
    return { label: 'PLANNED / PRESENT', alarm: false, why: 'something is already at that location' };
  }
  return { label: node.status, alarm: false, why: '' };
}

const GLYPH = { PLANNED: '·', PARTIAL: '~', IMPLEMENTED: '+', VERIFIED: '*' };

/** THE TREE, as a person reads it. */
function render(model, { detail = false, from = '' } = {}) {
  const lines = [];
  const walk = (node, depth) => {
    const pad = '  '.repeat(depth);
    const eff = effective(node);
    const g = GLYPH[node.status] || '?';
    let line = `${pad}${g} ${node.name}`;
    const bits = [];
    if (node.type && node.type !== TYPE.COMPONENT) bits.push(node.type.toLowerCase());
    bits.push(eff.label);
    if (node.location) bits.push(node.location);
    line += `  [${bits.join(' · ')}]`;
    lines.push(line);
    if (eff.alarm) lines.push(`${pad}    ! ${eff.why}`);
    if (detail) {
      if (node.purpose) lines.push(`${pad}    ${node.purpose}`);
      if (node.owner) lines.push(`${pad}    owner: ${node.owner}`);
      if (node.dependencies.length) lines.push(`${pad}    needs: ${node.dependencies.join(', ')}`);
      if (node.concepts.length) lines.push(`${pad}    concepts: ${node.concepts.join(', ')}`);
      if (node.verification.at) {
        lines.push(`${pad}    verified by ${node.verification.how}: ${node.verification.result}`);
      }
    }
    for (const c of childrenOf(model, node.id)) walk(c, depth + 1);
  };
  const top = from && model.nodes[from] ? [model.nodes[from]] : roots(model);
  for (const n of top) walk(n, 0);
  if (!lines.length) {
    return 'No architecture has been recorded for this project yet.\n'
      + 'Declare one with architecture{op:"declare"} — it may describe what is INTENDED, '
      + 'before any of it exists.';
  }
  lines.push('');
  lines.push('· planned   ~ partial   + implemented   * verified');
  return lines.join('\n');
}

/** One node, in full. What a recovery actually reads. */
function describe(model, node) {
  const eff = effective(node);
  const out = [
    `${node.name}  (${node.id})`,
    `  type       ${node.type}`,
    `  status     ${eff.label}${eff.alarm ? `  — ${eff.why}` : ''}`,
  ];
  if (node.purpose) out.push(`  purpose    ${node.purpose}`);
  if (node.owner) out.push(`  owner      ${node.owner}`);
  out.push(`  location   ${node.location || '(none recorded — this node is design only)'}`);
  const line = ancestry(model, node.id).map((a) => a.name).join(' > ');
  if (line) out.push(`  within     ${line}`);
  const kids = childrenOf(model, node.id);
  if (kids.length) out.push(`  contains   ${kids.map((k) => k.name).join(', ')}`);
  if (node.dependencies.length) out.push(`  depends on ${node.dependencies.join(', ')}`);
  if (node.concepts.length) out.push(`  concepts   ${node.concepts.join(', ')}`);
  if (node.verification.at) {
    out.push(`  verified   ${node.verification.how} — ${node.verification.result}`
      + ` (${new Date(node.verification.at).toISOString().slice(0, 10)}, by ${node.verification.by})`);
  } else {
    out.push('  verified   never');
  }
  const o = node.observed;
  out.push(`  observed   ${o.status}${o.note ? ` — ${o.note}` : ''}`
    + (o.at ? ` (${new Date(o.at).toISOString().slice(0, 10)})` : ' (nothing has looked)'));
  return out.join('\n');
}

/** Counts, for a one-line summary that costs nothing. */
function tally(model) {
  const t = { nodes: 0, planned: 0, partial: 0, implemented: 0, verified: 0, missing: 0, damaged: 0, drifted: 0 };
  for (const n of Object.values(model.nodes)) {
    t.nodes += 1;
    t[n.status.toLowerCase()] = (t[n.status.toLowerCase()] || 0) + 1;
    const o = n.observed.status;
    if (o === OBSERVED.MISSING) t.missing += 1;
    else if (o === OBSERVED.DAMAGED) t.damaged += 1;
    else if (o === OBSERVED.DRIFTED) t.drifted += 1;
  }
  return t;
}

module.exports = {
  STATUS, OBSERVED, TYPE,
  empty, blank, load, save, slug, idFor,
  declare, forget, verify, observe, seed,
  roots, childrenOf, find, ancestry, effective, render, describe, tally,
};
