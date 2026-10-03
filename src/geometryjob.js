'use strict';

/** GEOMETRY JOBS — Core owns the numbers; the flagship owns the semantics (2026-09-24). */

const fs = require('fs');
const path = require('path');

// ---- THE JOB ---------------------------------------------------------------

const UI_NOUN = /\b(?:button|btn|input|field|textbox|icon|avatar|badge|bar|header|footer|composer|panel|card|dialog|modal|box|sidebar|toolbar|image|logo|tab|chip|pill|toggle|switch|slider|menu|dropdown|thumbnail|spinner|checkbox|link)s?\b/i;
const GEOMETRY_WORD = /\b(?:smaller|larger|bigger|wider|narrower|taller|shorter|size|sized|width|height|tall|short|wide|narrow|shrink\w*|grow\w*|enlarg\w*|reduc\w*|increas\w*|decreas\w*|scale\w*)\b/i;
const SCALE_RE = /(\d+(?:\.\d+)?)\s*%\s*(smaller|larger|bigger|wider|narrower|taller|shorter|less|more)?/i;
const PX_RE = /(\d+(?:\.\d+)?)\s*px\s*(smaller|larger|bigger|wider|narrower|taller|shorter|less|more)?/i;
const GROW = /\b(?:larger|bigger|wider|taller|grow\w*|enlarg\w*|increas\w*|more)\b/i;
const SHRINK = /\b(?:smaller|narrower|shorter|shrink\w*|reduc\w*|decreas\w*|less)\b/i;
const GENERIC = new Set(['the', 'a', 'an', 'this', 'that', 'my', 'our', 'make', 'button', 'btn', 'field', 'box', 'little', 'bit', 'slightly', 'too', 'more', 'less', 'by', 'so', 'it']);
/** UI naming conventions a person does not have to know: the "send" button is often `.submit`. */
const SYNONYMS = { send: ['send', 'submit'], submit: ['submit', 'send'], search: ['search'], close: ['close', 'dismiss'] };

function dimensionOf(s) {
  if (/\b(?:taller|shorter|height|tall|short)\b/i.test(s)) return 'height';
  if (/\b(?:wider|narrower|width|wide|narrow)\b/i.test(s)) return 'width';
  return 'both';
}

/** THE GEOMETRY_JOB, or null. */
function parse(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 400) return null;
  const noun = UI_NOUN.exec(s);
  if (!noun || !GEOMETRY_WORD.test(s)) return null;
  const before = s.slice(0, noun.index).split(/\s+/).slice(-2).map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, '')).filter((w) => w && !GENERIC.has(w) && !GEOMETRY_WORD.test(w));
  const target = [...before, noun[0].toLowerCase()].join(' ');
  const dimension = dimensionOf(s);
  let delta = null;
  const pct = SCALE_RE.exec(s);
  const px = PX_RE.exec(s);
  const sign = SHRINK.test(s) ? -1 : GROW.test(s) ? 1 : 0;
  if (pct && sign) delta = { kind: 'scale', scale: +(1 + sign * Number(pct[1]) / 100).toFixed(6), words: pct[0] };
  else if (px && sign) delta = { kind: 'px', px: sign * Number(px[1]), words: px[0] };
  const related = (/\b(?:compared (?:with|to)|relative to|than|match(?:ing)?)\s+(?:the\s+)?([a-z-]+)/i.exec(s) || [])[1] || '';
  return {
    type: 'GEOMETRY_JOB',
    target,
    terms: [...new Set(before.flatMap((w) => SYNONYMS[w] || [w]))],
    dimension,
    requested_delta: delta || { kind: 'qualitative', words: (GEOMETRY_WORD.exec(s) || [''])[0] },
    related: related.toLowerCase(),
    explicit: Boolean(delta),
    current: null,
    constraints: [],
    implementation_binding: null,
  };
}

// ---- THE SOLVER ------------------------------------------------------------

/** GEOMETRY_RESULT for one value. */
function solveValue(value, delta) {
  if (!delta || !Number.isFinite(value)) return null;
  const v = delta.kind === 'scale' ? value * delta.scale : delta.kind === 'px' ? value + delta.px : null;
  if (v == null) return null;
  return Math.round(v * 100) / 100;
}

/** THE RECT SOLVER (bench/specialist-workers/geometry/gug.js, promoted): resize one node and re-solve its relations to its parent. */
function solveRect(node, parent, { scale = 1 } = {}) {
  const rel = node.rel || {};
  const n = { x: node.x, y: node.y, w: +(node.w * scale).toFixed(4), h: 0 };
  n.h = rel.square ? n.w : +(node.h * scale).toFixed(4);
  if (parent && rel.centerY) n.y = +(parent.y + parent.h / 2 - n.h / 2).toFixed(4);
  if (parent && rel.centerX) n.x = +(parent.x + parent.w / 2 - n.w / 2).toFixed(4);
  if (parent && rel.rightInset != null) n.x = +(parent.x + parent.w - rel.rightInset - n.w).toFixed(4);
  if (parent && rel.leftInset != null) n.x = +(parent.x + rel.leftInset).toFixed(4);
  const preserved = Object.keys(rel).filter((k) => rel[k] != null && rel[k] !== false);
  return { type: 'GEOMETRY_RESULT', x: n.x, y: n.y, width: n.w, height: n.h, preserved, conflicts: [] };
}

// ---- THE IMPLEMENTATION BINDING ------------------------------------------------

const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.vue', '.svelte']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '.lain', '.noema', 'vendor', 'target', '__pycache__']);
const MAX_FILES = 400;
const MAX_BYTES = 512 * 1024;

function styleFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= MAX_FILES || depth > 8) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1); continue; }
      if (e.isFile() && STYLE_EXT.has(path.extname(e.name).toLowerCase())) out.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

const PROPS = { width: ['width'], height: ['height'], both: ['width', 'height'] };

/** Every place in the project's stylesheets that sets the target's size in px: a custom property named for it (`--submit-size: 40px`) or a rule whose… */
function bindings(root, job) {
  const terms = (job && job.terms) || [];
  if (!terms.length) return [];
  const named = (s) => terms.some((t) => new RegExp(`(?:^|[^a-z0-9])${t}(?:$|[^a-z0-9])`, 'i').test(s));
  const out = [];
  for (const file of styleFiles(root)) {
    let text;
    try { if (fs.statSync(file).size > MAX_BYTES) continue; text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const lines = text.split(/\r?\n/);
    // Custom properties.
    lines.forEach((line, i) => {
      const m = /^\s*(--[\w-]+)\s*:\s*(\d+(?:\.\d+)?)px\s*;?\s*$/.exec(line);
      if (m && named(m[1]) && /(?:size|width|height|dim|diameter|^--[\w-]*-[wh]$)/i.test(m[1])) {
        out.push({ file: rel, kind: 'custom-property', name: m[1], decls: [{ prop: /width|-w$/i.test(m[1]) ? 'width' : /height|-h$/i.test(m[1]) ? 'height' : 'size', value: Number(m[2]), line: i + 1, text: line }] });
      }
    });
    // Rules: `selector { ... }` on the lines between the brace pair.
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(text))) {
      const selector = m[1].trim().split('\n').pop().trim();
      if (!selector || selector.startsWith('@') || !named(selector.replace(/[.#]/g, ' '))) continue;
      // Any number of declarations per line: `.send { width: 40px; height: 40px; }` is one line.
      const startLine = text.slice(0, m.index + m[1].length).split(/\r?\n/).length;
      const decls = [];
      m[2].split(/\r?\n/).forEach((body, k) => {
        const line = lines[startLine + k - 1] || '';
        const dre = /(?:^|[;{\s])(width|height)\s*:\s*(\d+(?:\.\d+)?)px/g;
        let d;
        while ((d = dre.exec(body))) decls.push({ prop: d[1], value: Number(d[2]), line: startLine + k, text: line });
      });
      if (decls.length) out.push({ file: rel, kind: 'rule', name: selector, decls });
    }
  }
  return out;
}

/** THE ONE BINDING THE JOB CAN BE APPLIED TO, or why not. */
function bind(root, job) {
  if (!job || !job.explicit) return { ok: false, why: 'no numeric delta — the size change is a judgement, not arithmetic' };
  const all = bindings(root, job);
  const want = PROPS[job.dimension];
  const fitting = all.filter((b) => b.decls.some((d) => d.prop === 'size' || want.includes(d.prop)));
  if (!fitting.length) return { ok: false, why: `no stylesheet binding names "${job.target}"`, candidates: 0 };
  const props = fitting.filter((b) => b.kind === 'custom-property');
  const pick = props.length ? props : fitting;
  // One size variable for both sides, asked to change one side: that breaks the square — a design question.
  if (pick.length === 1 && pick[0].decls[0].prop === 'size' && job.dimension !== 'both') {
    return { ok: false, why: `${pick[0].name} sizes both sides; changing only the ${job.dimension} breaks that — a design choice`, candidates: 1 };
  }
  if (pick.length !== 1) return { ok: false, why: `${pick.length} stylesheet bindings could be "${job.target}"`, candidates: pick.length, list: pick.slice(0, 6).map((b) => `${b.file}:${b.decls[0].line} ${b.name}`) };
  const b = pick[0];
  const decls = b.decls.filter((d) => d.prop === 'size' || want.includes(d.prop));
  const file = path.join(root, b.file);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, why: `${b.file} could not be read` }; }
  for (const d of decls) if (text.split(d.text).length !== 2) return { ok: false, why: `the declaration at ${b.file}:${d.line} is not unique in its file` };
  // ONE EDIT PER LINE, however many of the line's declarations change.
  const solved = decls.map((d) => ({ ...d, next: solveValue(d.value, job.requested_delta) }));
  if (solved.some((e) => !(e.next > 0))) return { ok: false, why: 'the solved size is not positive' };
  const byLine = new Map();
  for (const d of solved) { if (!byLine.has(d.line)) byLine.set(d.line, []); byLine.get(d.line).push(d); }
  const edits = [...byLine.values()].map((ds) => {
    let newText = ds[0].text;
    for (const d of ds) {
      const re = d.prop === 'size' ? /(:\s*)(\d+(?:\.\d+)?)px/ : new RegExp(`(${d.prop}\\s*:\\s*)(\\d+(?:\\.\\d+)?)px`);
      newText = newText.replace(re, `$1${d.next}px`);
    }
    return { line: ds[0].line, text: ds[0].text, newText, changes: ds.map((d) => ({ prop: d.prop, value: d.value, next: d.next })) };
  });
  return { ok: true, binding: b, edits };
}

// ---- THE DIRECT TURN ------------------------------------------------------------

/** May Core finish this input without the flagship? */
function routes(app, verdict) {
  const session = app && app.session;
  const d = session && session.dispatch;
  // A SELECTION-REFERENT JOB ("rename this", "move this down 6px") comes through the same door (selectionjob.js).
  if (d && d.cls === 'SELECTION') { const w = mayWrite(app, verdict); return w.yes ? require('./selectionjob').routes(app, verdict) : w; }
  if (!d || d.cls !== 'UI_GEOMETRY' || !d.geometry || !d.geometry.explicit) return { yes: false, why: 'not an explicit geometry job' };
  const w = mayWrite(app, verdict);
  if (!w.yes) return w;
  const b = bind(session.cwd || process.cwd(), d.geometry);
  d.geometry.binding = b.ok ? { file: b.binding.file, name: b.binding.name, kind: b.binding.kind } : { none: b.why, candidates: b.candidates || 0 };
  return b.ok ? { yes: true, plan: b } : { yes: false, why: b.why };
}

/** May Core write this input's result without asking? AUTO execution, the Coding view, no read-only declaration. */
function mayWrite(app, verdict) {
  const session = app && app.session;
  if (!session) return { yes: false, why: 'no session' };
  if (String(process.env.LAIN_GEOMETRY_DIRECT || (app.cfg && app.cfg.geometryDirect) || 'on').toLowerCase() === 'off') return { yes: false, why: 'direct geometry is switched off' };
  if (verdict && verdict.sameTask) return { yes: false, why: 'continues an existing task' };
  if (require('./execmode').of(session) !== 'AUTO' || require('./readonly').active(session) || session._botTurn) return { yes: false, why: 'this session does not write without asking' };
  try { if (require('./sessionviews').current(session) === 'chat') return { yes: false, why: 'the Chat view does not write' }; } catch { /* coding view */ }
  return { yes: true };
}

/** The direct turn. Yields turn.js's own event vocabulary, closes the record through turnclose like every other turn. A plan that carries its own runner… */
async function* run(app, text, verdict, { from = null, typed = false, plan = null } = {}) {
  if (plan && typeof plan.run === 'function') { yield* plan.run(app, text, verdict, { from, typed, plan }); return; }
  const session = app.session;
  const { newRecord } = require('./turnrecord');
  const turnclose = require('./turnclose');
  const record = newRecord(session.id, text, null);
  record.from = from || null;
  record.typed = Boolean(typed);
  record.lane = 'core';
  record.owner = 'deterministic:geometry';
  session.messages.push({ role: 'user', content: String(text), ts: new Date().toISOString() });
  const d = session.dispatch;
  const p = plan || bind(session.cwd || process.cwd(), d.geometry);
  const tools = require('./tools');
  const ctx = { app, session, cwd: session.cwd, turnId: record.turnId, signal: app.abort ? app.abort.signal : null, actor: 'CORE', what: `${d.geometry.target} ${(d.geometry.requested_delta && d.geometry.requested_delta.words) || ''}`.trim() };
  const done = [];
  let failed = '';
  for (const e of p.edits) {
    const input = { path: p.binding.file, old: e.text, new: e.newText };
    const id = `core-${record.turnId}-${done.length}`;
    yield { type: 'tool_start', id, name: 'edit_file', input };
    const r = await tools.execute('edit_file', input, ctx);
    record.toolCalls += 1;
    record.toolNames.push('edit_file');
    record.actions.push({ name: 'edit_file', target: p.binding.file, ok: !r.isError, ms: 0 });
    yield { type: 'tool_result', id, name: 'edit_file', input, output: r.output, isError: Boolean(r.isError), meta: r.meta || null };
    if (r.isError) { failed = String(r.output || 'the edit was refused'); break; }
    done.push(e);
    for (const m of r.mutated || []) record.mutations = [...(record.mutations || []), m];
  }
  // VERIFY BY READING IT BACK — the edit result says it was sent, the file says it happened.
  let verified = false;
  if (!failed) {
    try {
      const now = fs.readFileSync(path.join(session.cwd, p.binding.file), 'utf8');
      verified = p.edits.every((e) => now.includes(e.newText) && !now.includes(e.text));
    } catch { verified = false; }
  }
  const delta = d.geometry.requested_delta;
  const lines = failed
    ? [`I didn't change ${d.geometry.target}: ${failed}`]
    : [`Changed ${d.geometry.target} (${delta.words}) in \`${p.binding.file}\` — ${p.binding.name}:`,
      ...done.flatMap((e) => e.changes.map((c) => `- line ${e.line}: ${c.prop} ${c.value}px → ${c.next}px`)),
      verified ? 'Verified: the file now holds the new values.' : 'Not verified: the file did not read back as expected — please check it.',
      d.geometry.gug ? `Resolved from the selected Workshop node (GUG generation ${d.geometry.gug.generation}) and its one stylesheet binding; no model was asked.` : 'Solved by arithmetic from the one stylesheet binding for it; no model was asked.'];
  const reply = lines.join('\n');
  record.text = reply;
  record.narration.push({ step: 0, text: reply, at: Date.now() });
  record.stopReason = 'end';
  record.verified = verified;
  session.messages.push({ role: 'assistant', content: reply, ts: new Date().toISOString() });
  d.geometry.result = { type: 'GEOMETRY_RESULT', edits: done.flatMap((e) => e.changes.map((c) => ({ prop: c.prop, from: c.value, to: c.next }))), verified, conflicts: failed ? [failed] : [] };
  d.geometry.owner = 'deterministic';
  // THE CORE JOB ROW: target, constraints, input and solution, so a geometry
  // job's owner is measured, never assumed.
  try {
    require('./dispatch').job(session, {
      worker: 'CORE', role: 'geometry_solver', contract: 'deterministic', mode: 'DETERMINISTIC', consumed: true,
      why: 'deterministic arithmetic answered exactly', target: d.geometry.target, constraints: d.geometry.constraints,
      input: d.geometry.requested_delta, solution: d.geometry.result, deterministicSufficient: true,
    });
  } catch { /* telemetry only */ }
  // THE USER'S OWN EDIT, as a Harness fact: the GUG generation and the recent-actions ledger follow it.
  yield { type: 'text', chunk: reply };
  turnclose.close(session, session.lifecycle || null, record);
  yield { type: 'done', record };
}

/** THE PARTIAL JOB, AS ORDINARY EVIDENCE for the flagship when Core could not finish it. */
function evidence(session) {
  const d = session && session.dispatch;
  const g = d && d.cls === 'UI_GEOMETRY' ? d.geometry : null;
  if (!g) return '';
  const b = g.binding || {};
  const lines = ['# Geometry facts (Core)', `target: ${g.target} · dimension: ${g.dimension} · requested: ${g.requested_delta.words || g.requested_delta.kind}`];
  if (g.related) lines.push(`relative to: ${g.related}`);
  if (b.file) lines.push(`binding: ${b.file} ${b.name}`);
  else if (b.none) lines.push(`binding: unresolved — ${b.none}`);
  lines.push('Numbers follow from the binding by arithmetic; the choice of target and any UX tradeoff are yours.');
  return lines.join('\n');
}

module.exports = { parse, solveValue, solveRect, bindings, bind, routes, run, evidence, styleFiles, mayWrite };
