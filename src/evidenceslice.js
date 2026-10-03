'use strict';

/** EVIDENCE SLICE — the flagship gets where the thing is, not the whole world. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_MATCHES = 12;
const INTERACTIVE = new Set(['Button', 'Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'MenuItem', 'ListItem', 'TabItem', 'Hyperlink', 'Slider', 'Spinner', 'TreeItem', 'Document']);
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'is', 'it', 'this', 'that', 'button', 'field', 'box']);

function dir(sessionId) { return path.join(require('./config').configDir(), 'evidence', String(sessionId || 'no-session')); }

/** Depth-first, with the path of indices and the parent index. */
function flatten(tree) {
  const out = [];
  const walk = (node, depth, parent, trail) => {
    if (!node) return;
    const i = out.length;
    out.push({ node, depth, parent, trail });
    (node.children || []).forEach((k, n) => walk(k, depth + 1, i, `${trail}.${n}`));
  };
  walk(tree, 0, -1, '0');
  return out;
}

function terms(focus) {
  return String(focus || '').toLowerCase().split(/[^a-z0-9_#]+/).filter((t) => t.length >= 2 && !STOP.has(t));
}

function score(node, ts) {
  if (!ts.length) return 0;
  const name = String(node.name || '').toLowerCase();
  const id = String(node.automationId || '').toLowerCase();
  const type = String(node.controlType || '').toLowerCase();
  const value = String(node.value || '').toLowerCase();
  let s = 0;
  for (const t of ts) {
    const bare = t.replace(/^#/, '');
    if (name.includes(bare)) s += 3;
    if (id && id.includes(bare)) s += 3;
    if (type === bare) s += 2;
    if (value && value.includes(bare)) s += 1;
  }
  if (s > 0 && INTERACTIVE.has(node.controlType)) s += 0.5;
  return s;
}

function union(rects) {
  const rs = rects.filter((r) => r && r.width > 0 && r.height > 0);
  if (!rs.length) return null;
  const x = Math.min(...rs.map((r) => r.x)); const y = Math.min(...rs.map((r) => r.y));
  const x2 = Math.max(...rs.map((r) => r.x + r.width)); const y2 = Math.max(...rs.map((r) => r.y + r.height));
  return { x, y, width: x2 - x, height: y2 - y };
}

/** Store the raw tree under a receipt id. */
function keep(sessionId, tree, rendered, meta = {}) {
  const id = `ev_${crypto.createHash('sha1').update(rendered).digest('hex').slice(0, 10)}`;
  try {
    fs.mkdirSync(dir(sessionId), { recursive: true });
    fs.writeFileSync(path.join(dir(sessionId), `${id}.json`), JSON.stringify({ id, at: new Date().toISOString(), tree, rendered, ...meta }), 'utf8');
    return id;
  } catch { return ''; }
}

function load(sessionId, id) {
  if (!/^ev_[0-9a-f]{10}$/.test(String(id || ''))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir(sessionId), `${id}.json`), 'utf8')); } catch { return null; }
}

/** THE SLICE. `describe(node, indent)` is the caller's one-row renderer, so a slice row reads exactly like a tree row. @returns {{text, matched, total… */
function slice(tree, { focus = '', window = '', receipt = '', totalChars = 0, describe }) {
  const flat = flatten(tree);
  const ts = terms(focus);
  const scored = flat.map((f, i) => ({ i, s: score(f.node, ts) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
  // A CONTAINER IS PATH, NOT A MATCH, when something inside it matched too: "Network" pane + "Network mode" combo is one finding, and the region must be…
  const hits = new Set(scored.map((x) => x.i));
  const isAncestorOfHit = (i) => scored.some((x) => { let k = flat[x.i].parent; while (k >= 0) { if (k === i) return true; k = flat[k].parent; } return false; });
  const top = scored.filter((x) => !(hits.has(x.i) && isAncestorOfHit(x.i))).slice(0, MAX_MATCHES);
  const keepIdx = new Set();
  for (const { i } of top) { let k = i; while (k >= 0 && !keepIdx.has(k)) { keepIdx.add(k); k = flat[k].parent; } }
  const matched = new Set(top.map((x) => x.i));
  const region = union(top.map((x) => flat[x.i].node.rect));
  const best = top[0] ? top[0].s : 0;
  const strong = top.filter((x) => x.s >= best).length;
  const confidence = !top.length ? 0 : strong === 1 ? 0.9 : strong <= 3 ? 0.7 : 0.5;
  const rows = [...keepIdx].sort((a, b) => a - b).map((k) => `${matched.has(k) ? '▸' : ' '} ${describe(flat[k].node, '  '.repeat(flat[k].depth))}`);
  const head = [
    `EVIDENCE SLICE · ui_tree · focus ${JSON.stringify(focus)} · deterministic (evidence_narrower)`,
    `target: ${window || 'the requested window'}${region ? ` · region ${region.x},${region.y} ${region.width}×${region.height}` : ''}`,
    `matched ${top.length} of ${flat.length} node(s)${scored.length > top.length ? ` (${scored.length - top.length} weaker matches omitted)` : ''} · confidence ${confidence}`,
  ];
  const tail = [];
  if (!top.length) tail.push('unresolved: NOTHING matches that focus — nothing was guessed. Refine `focus`, or expand the receipt.');
  else if (strong > 3) tail.push('unresolved: several controls match equally — name one (automationId or exact name) before acting.');
  tail.push(receipt
    ? `raw: receipt ${receipt} (${flat.length} nodes, ${totalChars} chars) — computer {op:"expand", receipt:"${receipt}"} returns the whole tree, or add query:"…" to re-slice`
    : 'raw: the full tree could not be stored; ask ui_tree again without focus');
  const text = [...head, ...rows, ...tail].join('\n');
  return { text, matched: top.length, total: flat.length, confidence, abstain: !top.length, region };
}

module.exports = { slice, flatten, terms, score, keep, load, MAX_MATCHES };
