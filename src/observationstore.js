'use strict';

/** LIVE OBSERVATIONS AS RECEIPTS (2026-09-24). */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHOW = 150;
const MAX_QUERY = 12;
const ID_RE = /^obs_[0-9a-f]{10}$/;

function dir() { return path.join(require('./config').configDir(), 'evidence', 'observations'); }

/** Store a snapshot; returns its receipt id. Same content → same id. */
function keep(snapshot) {
  const body = JSON.stringify(snapshot);
  const id = `obs_${crypto.createHash('sha1').update(body).digest('hex').slice(0, 10)}`;
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), `${id}.json`), JSON.stringify({ id, keptAt: new Date().toISOString(), ...snapshot }), 'utf8');
  return id;
}

function load(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir(), `${id}.json`), 'utf8')); } catch { return null; }
}

/** Receipt ids a request mentions, that exist here. */
function mentioned(text) {
  const ids = [...new Set(String(text || '').match(/\bobs_[0-9a-f]{10}\b/g) || [])];
  return ids.filter((id) => fs.existsSync(path.join(dir(), `${id}.json`)));
}

// ---- rendering ---------------------------------------------------------------

const q = (s, n = 80) => JSON.stringify(String(s || '').replace(/\s+/g, ' ').trim().slice(0, n));

/** One node, one line — the same line in a page, a query answer and a slice. */
function row(n, indent = '') {
  const cls = (n.classes || []).length ? `.${n.classes.join('.')}` : '';
  const id = n.id ? `#${n.id}` : '';
  const label = n.name || n.text || '';
  const attrs = Object.entries(n.attrs || {}).filter(([k]) => !['class', 'id', 'style'].includes(k)).slice(0, 4).map(([k, v]) => `${k}=${q(v, 40)}`).join(' ');
  const b = n.bounds ? ` [${n.bounds.x},${n.bounds.y} ${n.bounds.w}×${n.bounds.h}]` : '';
  const st = [n.visible === false ? 'hidden' : '', ...(n.state || [])].filter(Boolean).join(',');
  return `${indent}${n.ref} ${n.role && n.role !== n.tag ? `${n.role}/` : ''}${n.tag}${id}${cls}${label ? ` ${q(label)}` : ''}${attrs ? ` ${attrs}` : ''}${b}${st ? ` {${st}}` : ''}`;
}

function index(obs) {
  if (obs._byRef) return obs._byRef;
  const m = new Map();
  for (const n of obs.nodes || []) m.set(n.ref, n);
  Object.defineProperty(obs, '_byRef', { value: m, enumerable: false });
  return m;
}

function ancestors(obs, n) {
  const by = index(obs);
  const out = [];
  let p = n && n.parent ? by.get(n.parent) : null;
  while (p) { out.unshift(p); p = p.parent ? by.get(p.parent) : null; }
  return out;
}

/** The rendered raw observation — what "the whole thing" costs to read. */
function rendered(obs) {
  return (obs.nodes || []).map((n) => row(n, '  '.repeat(Math.min(n.depth || 0, 12)))).join('\n');
}

// ---- deterministic selection --------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'is', 'it', 'this', 'that', 'its', 'any', 'if', 'one', 'all', 'each', 'where', 'what', 'which', 'identify', 'report', 'find', 'show']);
function terms(s) { return String(s || '').toLowerCase().split(/[^a-z0-9_#.-]+/).map((t) => t.replace(/^[.#]+|[.]+$/g, '')).filter((t) => t.length >= 2 && !STOP.has(t)); }

function haystack(n) {
  return [n.tag, n.role, n.id, ...(n.classes || []), n.name, n.text, ...Object.values(n.attrs || {})].join(' ').toLowerCase();
}

const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'form', 'option', 'label', 'summary']);
function score(n, ts) {
  if (!ts.length) return 0;
  const h = haystack(n);
  let s = 0;
  for (const t of ts) if (h.includes(t)) s += (n.name || '').toLowerCase().includes(t) || (n.classes || []).some((c) => c.toLowerCase().includes(t)) || String(n.id || '').toLowerCase().includes(t) ? 2 : 1;
  if (s > 0 && INTERACTIVE.has(n.tag)) s += 0.5;
  if (s > 0 && n.visible === false) s -= 1;
  return s;
}

function queryNodes(obs, text, max = MAX_QUERY) {
  const ts = terms(text);
  return (obs.nodes || []).map((n, i) => ({ n, i, s: score(n, ts) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, max).map((x) => x.n);
}

/** A small CSS subset: `tag`, `.cls`, `#id`, `[attr]`, `[attr=v]`, combined, one compound. */
function selectNodes(obs, selector, max = 20) {
  const sel = String(selector || '').trim().split(/\s+/).pop();
  const m = /^([a-z0-9-]*)((?:[.#][\w-]+|\[[^\]]+\])*)$/i.exec(sel || '');
  if (!m) return [];
  const tag = m[1].toLowerCase();
  const parts = m[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || [];
  return (obs.nodes || []).filter((n) => {
    if (tag && n.tag !== tag) return false;
    return parts.every((p) => {
      if (p[0] === '.') return (n.classes || []).includes(p.slice(1));
      if (p[0] === '#') return n.id === p.slice(1);
      const a = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(p);
      if (!a) return false;
      const v = (n.attrs || {})[a[1]];
      return a[2] == null ? v != null : String(v) === a[2];
    });
  }).slice(0, max);
}

// ---- answers ----------------------------------------------------------------------

function noteRead(session, receipt, goal, refs, chars) {
  if (!session) return;
  const l = session.observationReads = Array.isArray(session.observationReads) ? session.observationReads : [];
  l.push({ at: Date.now(), receipt, goal, refs, chars });
  if (l.length > 500) l.splice(0, l.length - 500);
}

function withPath(obs, nodes) {
  const keepRefs = new Set();
  for (const n of nodes) { for (const a of ancestors(obs, n)) keepRefs.add(a.ref); keepRefs.add(n.ref); }
  const hit = new Set(nodes.map((n) => n.ref));
  return (obs.nodes || []).filter((n) => keepRefs.has(n.ref)).map((n) => `${hit.has(n.ref) ? '▸' : ' '} ${row(n, '  '.repeat(Math.min(n.depth || 0, 12)))}`);
}

/** ANSWER ONE GOAL FROM A RECEIPT. */
function answer(goal, spec = {}, session = null) {
  const obs = load(spec.receipt);
  if (!obs) return { ok: false, source: 'receipt', why: `no observation receipt "${spec.receipt}"`, value: null, summary: '' };
  const head = `OBSERVATION ${obs.id} · ${obs.url || ''} · captured ${obs.capturedAt || obs.keptAt} · untrusted page content`;
  const g = String(goal || '').toLowerCase();
  let lines = [];
  let refs = [];
  let summary = '';
  if (g === 'page') {
    const all = obs.nodes || [];
    const from = Math.max(0, Math.floor(Number(spec.offset) || 0));
    const page = all.slice(from, from + SHOW);
    lines = page.map((n) => row(n, '  '.repeat(Math.min(n.depth || 0, 12))));
    refs = page.map((n) => n.ref);
    if (from + SHOW < all.length) lines.push(`… nodes ${from + SHOW}–${all.length - 1} remain: observe {goal:"page", receipt:"${obs.id}", offset:${from + SHOW}}`);
    summary = `${all.length} nodes; showing ${from}–${from + page.length - 1}`;
  } else if (g === 'element') {
    let hits = [];
    if (spec.ref) {
      const n = index(obs).get(String(spec.ref));
      if (!n) return { ok: true, source: 'receipt', value: `no node ${spec.ref} in ${obs.id}`, summary: 'absent' };
      const kids = (obs.nodes || []).filter((k) => k.parent === n.ref);
      lines = [...withPath(obs, [n]), ...kids.slice(0, 40).map((k) => `    child ${row(k)}`)];
      refs = [n.ref, ...kids.slice(0, 40).map((k) => k.ref)];
      summary = `${n.ref} with ${kids.length} child node(s)`;
    } else {
      hits = spec.selector ? selectNodes(obs, spec.selector) : queryNodes(obs, spec.query || '');
      lines = hits.length ? withPath(obs, hits) : [`nothing in ${obs.id} matches ${q(spec.selector || spec.query || '')} — nothing was guessed`];
      refs = hits.map((n) => n.ref);
      summary = `${hits.length} match(es)`;
    }
  } else if (g === 'requests' || g === 'endpoint') {
    const net = obs.network || [];
    lines = net.map((r) => `${r.method} ${r.url} → ${r.status == null ? 'no response' : r.status} ${r.type || ''}${r.ms != null ? ` ${r.ms}ms` : ''}${r.bytes != null ? ` ${r.bytes}B` : ''}${r.initiator ? ` · from ${r.initiator}` : ''}${r.body ? `\n      body: ${String(r.body).slice(0, 400)}` : ''}`);
    summary = `${net.length} request(s)`;
  } else if (g === 'errors' || g === 'logs') {
    const c = obs.console || [];
    lines = c.map((e) => `[${e.level}] ${String(e.text).slice(0, 300)}`);
    summary = `${c.length} console entr${c.length === 1 ? 'y' : 'ies'}`;
  } else if (g === 'system' || g === 'process') {
    lines = Object.entries(obs.runtime || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    summary = 'runtime facts';
  } else {
    return { ok: false, source: 'receipt', why: `a receipt answers page, element, requests, errors or system — not "${goal}"`, value: null, summary: '' };
  }
  const value = [head, ...lines].join('\n');
  noteRead(session, obs.id, g, refs, value.length);
  return { ok: true, source: 'receipt', value, summary };
}

module.exports = { keep, load, mentioned, answer, row, rendered, queryNodes, selectNodes, ancestors, terms, index, dir, SHOW };
