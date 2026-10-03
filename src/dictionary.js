'use strict';

/** THE PROJECT'S OWN WORDS — what they mean, kept where the next model finds them. */

const lainstore = require('./lainstore');

/** WHAT KIND OF WORD THIS IS. */
const KIND = Object.freeze({
  /** A part of the system that exists and can be pointed at. */
  COMPONENT: 'Architecture component',
  /** A named state something can be in. */
  STATE: 'State',
  /** Something a person or a model does. */
  INTERACTION: 'Interaction concept',
  /** A rule the system holds itself to. */
  RULE: 'Rule',
  /** A named piece of data that moves between components. */
  ARTIFACT: 'Artifact',
  /** A process or sequence with a beginning and an end. */
  PROCESS: 'Process',
  /** Anything else. Better than a forced fit. */
  TERM: 'Term',
});

const KINDS = new Set(Object.values(KIND));

function empty() { return { terms: {}, updatedAt: 0 }; }

/** Case-insensitive, punctuation-insensitive, so `ask_user` finds `ask user`. */
function keyOf(term) {
  return String(term || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function blank(term) {
  return {
    term: String(term),
    kind: KIND.TERM,
    purpose: '',
    location: '',
    owns: '',
    invariant: '',
    lifecycle: [],
    see: [],
    /** Architecture node ids this term explains, when it explains one. */
    nodes: [],
    at: 0,
    by: '',
  };
}

function load(root) {
  const body = lainstore.read(root, 'concepts', null);
  if (!body || !body.terms || typeof body.terms !== 'object') return empty();
  const terms = {};
  for (const [k, t] of Object.entries(body.terms)) {
    if (!t || typeof t !== 'object' || !t.term) continue;
    const base = blank(t.term);
    terms[k] = {
      ...base,
      ...t,
      lifecycle: Array.isArray(t.lifecycle) ? t.lifecycle.map(String) : [],
      see: Array.isArray(t.see) ? t.see.map(String) : [],
      nodes: Array.isArray(t.nodes) ? t.nodes.map(String) : [],
    };
  }
  return { terms, updatedAt: Number(body.updatedAt) || 0 };
}

function save(root, dict) {
  dict.updatedAt = Date.now();
  // PROOF: a definition (re)written now is established against the disk now.
  // An untouched one keeps the proof it was made with, so it can go STALE.
  const freshness = require('./freshness');
  for (const e of Object.values(dict.terms)) {
    if (!e || (Array.isArray(e.proof) && e.proofAt === e.at)) continue;
    const loc = String(e.location || '').split('::')[0];
    e.proof = loc ? freshness.stamp(root, [loc]).evidence : [];
    e.proofAt = e.at;
    delete e.proofOrigin;
  }
  return lainstore.write(root, 'concepts', { terms: dict.terms, updatedAt: dict.updatedAt });
}

/** DEFINE A TERM, or refine the one that is there. */
function define(dict, spec) {
  const term = String((spec && spec.term) || '').trim();
  if (!term) return { ok: false, error: 'a definition needs a term' };
  const key = keyOf(term);
  if (!key) return { ok: false, error: `"${term}" has no letters or digits in it` };
  const existing = dict.terms[key];
  const entry = existing ? { ...existing } : blank(term);

  if (spec.kind != null) {
    const k = String(spec.kind);
    // ACCEPTED BY LABEL OR BY SHORT NAME.
    const match = KINDS.has(k) ? k : KIND[k.toUpperCase().replace(/[^A-Z]/g, '_')];
    if (!match) return { ok: false, error: `unknown kind "${spec.kind}" — one of ${Object.keys(KIND).join(', ')}` };
    entry.kind = match;
  }
  if (spec.purpose != null) entry.purpose = String(spec.purpose).trim();
  if (spec.location != null) entry.location = String(spec.location).replace(/\\/g, '/');
  if (spec.owns != null) entry.owns = String(spec.owns).trim();
  if (spec.invariant != null) entry.invariant = String(spec.invariant).trim();
  if (Array.isArray(spec.lifecycle)) entry.lifecycle = spec.lifecycle.map(String).filter(Boolean);
  if (Array.isArray(spec.see)) entry.see = spec.see.map(String).filter(Boolean);
  if (Array.isArray(spec.nodes)) entry.nodes = spec.nodes.map(String).filter(Boolean);
  entry.term = term;
  if (!entry.purpose) {
    return { ok: false, error: 'a definition without a purpose is a word with no meaning attached — say what it is FOR' };
  }
  entry.at = Date.now();
  entry.by = String(spec.by || entry.by || 'lain');
  dict.terms[key] = entry;
  return { ok: true, entry, created: !existing };
}

function forget(dict, term) {
  const key = keyOf(term);
  if (!dict.terms[key]) return { ok: false, error: `"${term}" is not defined` };
  delete dict.terms[key];
  return { ok: true };
}

/** Exact lookup. */
function get(dict, term) { return dict.terms[keyOf(term)] || null; }

/** SEARCH BY CONCEPT. */
function search(dict, query, { max = 8 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const key = keyOf(q);
  const exact = dict.terms[key];
  const out = [];
  const push = (e) => { if (e && !out.includes(e)) out.push(e); };
  push(exact);
  for (const e of Object.values(dict.terms)) {
    if (out.length >= max) break;
    if (e.term.toLowerCase().includes(q)) push(e);
  }
  for (const e of Object.values(dict.terms)) {
    if (out.length >= max) break;
    const hay = `${e.purpose} ${e.invariant} ${e.owns} ${e.see.join(' ')}`.toLowerCase();
    if (hay.includes(q)) push(e);
  }
  return out.slice(0, max);
}

/** Every term that explains a given architecture node. */
function forNode(dict, nodeId) {
  return Object.values(dict.terms).filter((e) => e.nodes.includes(nodeId));
}

/** One entry, in the shape the header of this file describes. */
function render(entry) {
  if (!entry) return '';
  const out = [`TERM: ${entry.term}`, `TYPE: ${entry.kind}`];
  if (entry.location) out.push(`LOCATION: ${entry.location}`);
  out.push(`PURPOSE: ${entry.purpose}`);
  if (entry.owns) out.push(`OWNS: ${entry.owns}`);
  if (entry.invariant) out.push(`INVARIANT: ${entry.invariant}`);
  if (entry.lifecycle.length) out.push(`LIFECYCLE: ${entry.lifecycle.join(' -> ')}`);
  if (entry.see.length) out.push(`SEE: ${entry.see.join(', ')}`);
  return out.join('\n');
}

/** THE WHOLE VOCABULARY, one line each. */
function list(dict, { max = 60 } = {}) {
  const entries = Object.values(dict.terms);
  if (!entries.length) {
    return 'No vocabulary has been recorded for this project yet.\n'
      + 'Define one with concept{op:"define"} — a definition is what lets the NEXT model '
      + 'read this code without inferring what its words mean.';
  }
  const byKind = new Map();
  for (const e of entries) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind).push(e);
  }
  const lines = [`VOCABULARY — ${entries.length} term(s)`];
  let shown = 0;
  for (const kind of [...byKind.keys()].sort()) {
    const rows = byKind.get(kind).sort((a, b) => (a.term < b.term ? -1 : 1));
    lines.push('', kind.toUpperCase());
    for (const e of rows) {
      if (shown >= max) { lines.push('  [more — ask for one by name]'); return lines.join('\n'); }
      const one = e.purpose.split(/(?<=\.)\s/)[0];
      lines.push(`  ${e.term.padEnd(18)} ${one.length > 88 ? `${one.slice(0, 85)}...` : one}`);
      shown += 1;
    }
  }
  return lines.join('\n');
}

module.exports = { KIND, KINDS, empty, blank, load, save, keyOf, define, forget, get, search, forNode, render, list };
