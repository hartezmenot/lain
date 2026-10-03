'use strict';

/** THE CHANGE PANES — diff, files, output. */

const fs = require('fs');
const path = require('path');

const MAX_TREE_ENTRIES = 300;
const SKIP = /^(?:node_modules|\.git|dist|build|out|target|vendor|__pycache__|\.venv|venv|coverage|\.next|\.cache|\.idea|\.vscode)$/i;

// Measured VISIBLY — these panes carry colour now, and `.length` counts escape
// bytes as if they took cells. See ui/text.js.
const T = require('./text');
// THE ONE WRAPPER. A command and its output are content and may not be cut to the column - see the note in `outputView`. `wrapIndented` never drops a…
const { wrapIndented, MAX_WRAPPED_ROWS } = require('./doc');
const clip = T.clip;
const pad = T.pad;
function rel(cwd, p) {
  try { return path.relative(cwd, p).replace(/\\/g, '/'); } catch { return String(p); }
}

/** Every file this session touched, with a real line count for each. */
/** MEMOISED PER CHECKPOINT GENERATION (2026-10-02): the answer only changes when a checkpoint is added or removed, or a file on disk changes — so each… */
const changedMemo = new WeakMap();   // checkpoints → { gen, cwd, files: Map(path → { mtimeMs, size, row }) , out }
function changedFiles({ checkpoints, cwd }) {
  if (!checkpoints || !Array.isArray(checkpoints.entries)) return changedFilesNow({ checkpoints, cwd });
  const last = checkpoints.entries[checkpoints.entries.length - 1];
  const gen = `${checkpoints.entries.length}|${last ? last.id : ''}`;
  let m = changedMemo.get(checkpoints);
  if (!m || m.gen !== gen || m.cwd !== cwd) { m = { gen, cwd, stamps: new Map(), out: null }; changedMemo.set(checkpoints, m); }
  let fresh = Boolean(m.out);
  if (fresh) {
    for (const [p, st0] of m.stamps) {
      let st = null;
      try { const s = fs.statSync(p); st = `${s.mtimeMs}:${s.size}`; } catch { st = 'gone'; }
      if (st !== st0) { fresh = false; break; }
    }
  }
  if (fresh) return m.out;
  const out = changedFilesNow({ checkpoints, cwd });
  m.stamps = new Map();
  for (const e of checkpoints.entries) for (const f of e.files) if (!m.stamps.has(f.path)) { let st = 'gone'; try { const s = fs.statSync(f.path); st = `${s.mtimeMs}:${s.size}`; } catch { st = 'gone'; } m.stamps.set(f.path, st); }
  m.out = out;
  return out;
}
function changedFilesNow({ checkpoints, cwd }) {
  const byPath = new Map();
  for (const entry of (checkpoints && checkpoints.entries) || []) {
    for (const f of entry.files) {
      // Keep the EARLIEST captured bytes: with several edits to one file, the
      // interesting diff is against how it started, not against the last edit.
      if (!byPath.has(f.path)) byPath.set(f.path, { path: f.path, before: f.bytes ? f.bytes.toString('utf8') : null, existed: f.existed });
    }
  }
  const out = [];
  for (const rec of byPath.values()) {
    let after = null;
    try { after = fs.readFileSync(rec.path, 'utf8'); } catch { after = null; }
    if (rec.before === after) continue;
    const a = rec.before == null ? [] : linesOf(rec.before);
    const b = after == null ? [] : linesOf(after);
    const { added, removed } = countChanges(a, b);
    out.push({
      path: rec.path,
      rel: rel(cwd, rec.path),
      kind: rec.before == null ? 'added' : after == null ? 'deleted' : 'modified',
      added, removed, before: rec.before, after,
    });
  }
  out.sort((x, y) => x.rel.localeCompare(y.rel));
  return out;
}

/** Line counts either side of the common prefix/suffix. Bounded and exact. */
/** A FILE'S LINES. The newline that ENDS the last line does not start another: `'a\nb\n'.split('\n')` is three elements for two lines, and every count… */
function linesOf(text) {
  const t = String(text);
  if (!t) return [];
  return (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n');
}

/** Lines added/removed, from the same edit script `unified` draws — so the count beside a file agrees with its [Diff]. */
function countChanges(a, b) {
  let added = 0;
  let removed = 0;
  for (const o of require('./diffscript').ops(a, b)) {
    if (o.op === 'add') added += 1;
    else if (o.op === 'del') removed += 1;
  }
  return { added, removed };
}

/** A RENAME IS TWO EVENTS THAT MEAN ONE THING. */
function groupChanges(files) {
  const added = files.filter((f) => f.kind === 'added');
  const removed = files.filter((f) => f.kind === 'deleted');
  const renamed = [];
  const paired = new Set();
  for (const gone of removed) {
    if (!gone.before || !gone.before.trim()) continue;
    const match = added.find((n) => !paired.has(n) && n.after === gone.before);
    if (!match) continue;
    paired.add(match);
    paired.add(gone);
    renamed.push({ from: gone.rel, to: match.rel });
  }
  return {
    added: added.filter((f) => !paired.has(f)),
    modified: files.filter((f) => f.kind === 'modified'),
    removed: removed.filter((f) => !paired.has(f)),
    renamed,
  };
}

/** DIFF — WHAT WAS IMPLEMENTED, WHAT CHANGED, WHAT WENT AWAY. */
/** ONE DIFF ROW — conventional semantics, on its own reading surface. */
function diffRow(line, width, P) {
  // THE LAIN DIFF PALETTE (ui/palette.js, 2026-09-23): an added row is teal-green on dark teal, a removed row rose on dark red, context neutral on the…
  const { C } = require('../render');
  const mark = line.slice(5, 6);
  const gap = /^\s{5}…/.test(line);
  const body = clip(line, Math.max(8, width - 4));
  const padded = body + ' '.repeat(Math.max(0, width - 4 - T.width(body)));
  if (gap) return '  ' + C.bg('raised', C.fg('separator', padded));
  const tok = mark === '+' ? ['addBg', 'addFg'] : mark === '-' ? ['delBg', 'delFg'] : ['raised', 'ctx'];
  return '  ' + C.bg(tok[0], C.fg('lineNo', padded.slice(0, 4)) + C.fg(tok[1], padded.slice(4)));
}

/** At or above this width a diff is drawn side by side; below it, unified. */
const SPLIT_MIN = 150;

/** THE SAME HUNKS, SIDE BY SIDE — old on the left, new on the right — built from the unified rows `unified()` produced, so there is one diff and two… */
function diffSplit(lines, width, visible = null) {
  const { C } = require('../render');
  const half = Math.floor((width - 3) / 2);
  const side = (cell, tok) => {
    if (!cell) return C.bg('raised', ' '.repeat(half));
    const num = String(cell.n == null ? '' : cell.n).padStart(4);
    const text = clip(cell.t, Math.max(4, half - 5));
    const pad = ' '.repeat(Math.max(0, half - 5 - T.width(text)));
    return C.bg(tok[0], C.fg('lineNo', num) + C.fg(tok[1], ` ${text}${pad}`));
  };
  const parse = (l) => ({ n: Number(l.slice(0, 4)) || null, mark: l.slice(5, 6), t: l.slice(7) });
  const rows = [];
  let d = 0;
  for (let i = 0; i < lines.length;) {
    const l = String(lines[i] || '');
    if (/^\s{5}…/.test(l)) { rows.push({ gap: l.trim(), src: [i] }); i += 1; continue; }
    const p = parse(l);
    if (p.mark !== '+' && p.mark !== '-') { rows.push({ l: { n: p.n == null ? null : p.n - d, t: p.t }, r: { n: p.n, t: p.t }, src: [i] }); i += 1; continue; }
    const dels = []; const adds = [];
    while (i < lines.length && /^[+-]$/.test(String(lines[i] || '').slice(5, 6))) {
      const q = parse(String(lines[i])); (q.mark === '-' ? dels : adds).push({ ...q, i }); i += 1;
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ l: dels[k] || null, r: adds[k] || null, del: true, src: [dels[k], adds[k]].filter(Boolean).map((x) => x.i) });
    }
    d += adds.length - dels.length;
  }
  const bar = C.fg('separator', ' │ ');
  return rows.map((r) => {
    const shown = !visible || r.src.every((i) => visible[i]);
    if (!shown) return C.bg('raised', ' '.repeat(half)) + bar + C.bg('raised', ' '.repeat(width - 3 - half));
    if (r.gap) return C.bg('raised', C.fg('separator', T.fit(`     ${r.gap}`, width)));
    const left = r.del ? side(r.l, ['delBg', 'delFg']) : side(r.l, ['raised', 'ctx']);
    const right = r.del ? side(r.r, ['addBg', 'addFg']) : side(r.r, ['raised', 'ctx']);
    return left + bar + T.fit(right, width - 3 - half);
  });
}

function diffView({ checkpoints, cwd, width = 80, selected = null, maxLines = 400 }) {
  const { P } = require('./paint');
  const files = changedFiles({ checkpoints, cwd });
  if (!files.length) {
    return [P.head('DIFF'), '', '  Nothing has changed yet.', '',
      P.meta('  Everything LAIN writes is captured here first,'),
      P.meta('  so /undo can always put it back.')];
  }

  const pick = selected ? files.find((f) => f.rel === selected) : null;
  if (!pick) {
    // EXPANDED BY DEFAULT.
    const lines = [];
    let budget = maxLines;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (budget <= 0) {
        lines.push(P.meta(`  … ${files.length - i} more file(s) — Enter opens one on its own.`));
        break;
      }
      const counts = `+${f.added} -${f.removed}`;
      const kind = f.kind === 'added' ? P.ok : f.kind === 'deleted' ? P.bad : P.warn;
      // The divider IS the file boundary, and it stays findable while scrolling because it is the widest, brightest thing in the pane.
      const head = `━━ ${f.rel} `;
      const fill = Math.max(2, width - T.width(head) - counts.length - 3);
      lines.push(P.info(head + '━'.repeat(fill)) + ' ' + P.meta(counts));
      lines.push(kind('  ' + f.kind.toUpperCase()));
      const body = unified(f.before, f.after, Math.min(budget, 120));
      for (const l of body) lines.push(diffRow(l, width, P));
      if (!body.length) lines.push(P.meta('    (no line-level diff was captured for this file)'));
      lines.push('');
      budget -= body.length + 3;
    }
    return lines;
  }

  const kindPaint = pick.kind === 'added' ? P.ok : pick.kind === 'deleted' ? P.bad : P.warn;
  const lines = [
    P.head(pick.rel),
    '  ' + kindPaint(pick.kind.toUpperCase()) + P.meta(`   +${pick.added} -${pick.removed}`),
    '',
  ];
  // LINE-LEVEL, when the bytes are there to show it — and never faked when they
  // are not: `unified` works from the captured bytes and the file on disk.
  for (const l of unified(pick.before, pick.after, maxLines)) lines.push(diffRow(l, width, P));
  lines.push('');
  lines.push(P.meta('  Esc to go back.'));
  return lines;
}

/** A line-level diff with line numbers and a little context, in real hunks (unchanged runs between them elided to `…`). */
function unified(before, after, max = 400, context = 3) {
  const a = before == null ? [] : linesOf(before);
  const b = after == null ? [] : linesOf(after);
  if (before == null) return b.slice(0, max).map((l, i) => `${String(i + 1).padStart(4)} + ${l}`);
  if (after == null) return a.slice(0, max).map((l, i) => `${String(i + 1).padStart(4)} - ${l}`);

  // REAL HUNKS, not one prefix/suffix span
  const ops = require('./diffscript').ops(a, b);
  const near = new Uint8Array(ops.length);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op === 'eq') continue;
    for (let k = Math.max(0, i - context); k < Math.min(ops.length, i + context + 1); k++) near[k] = 1;
  }
  const out = [];
  let na = 0;
  let nb = 0;
  let changed = 0;
  let gap = false;
  let over = 0;
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (o.op !== 'add') na += 1;
    if (o.op !== 'del') nb += 1;
    if (!near[i]) { gap = out.length > 0; continue; }
    if (o.op !== 'eq' && changed >= max) { over += 1; continue; }
    if (gap) { out.push('     …'); gap = false; }
    if (o.op === 'eq') out.push(`${String(nb).padStart(4)}   ${o.text}`);
    else { changed += 1; out.push(`${String(o.op === 'del' ? na : nb).padStart(4)} ${o.op === 'del' ? '-' : '+'} ${o.text}`); }
  }
  if (over) out.push(`     … ${over} more changed lines`);
  return out;
}

/** FILES — the project as a bounded tree, with this session's changes marked. */
function filesView({ checkpoints, cwd, width = 80, tree = null, cursor = -1 }) {
  const { P } = require('./paint');
  const files = changedFiles({ checkpoints, cwd });
  const changed = new Map(files.map((f) => [f.rel, f]));
  const entries = tree || [];
  const lines = [];

  // WHAT CHANGED, FIRST — grouped by what happened to it.
  if (files.length) {
    const g = groupChanges(files);
    const section = (mark, label, paint, rows) => {
      if (!rows.length) return;
      lines.push(paint(`${mark} ${label}`) + P.meta(`  ${rows.length}`));
      for (const f of rows) {
        const counts = `+${f.added} -${f.removed}`;
        const room = Math.max(10, width - counts.length - 8);
        lines.push('    ' + pad(P.path(clip(f.rel, room)), room + 2) + P.meta(counts));
      }
      lines.push('');
    };
    section('+', 'ADDED', P.ok, g.added);
    section('~', 'MODIFIED', P.warn, g.modified);
    section('-', 'REMOVED', P.bad, g.removed);
    for (const r of g.renamed) {
      lines.push(P.info('→ RENAMED') + '    ' + P.path(clip(r.from, width / 2 - 6)) + P.meta(' → ') + P.path(clip(r.to, width / 2 - 6)));
    }
    if (g.renamed.length) lines.push('');
  }

  lines.push(P.head('PROJECT'), '');

  if (!entries.length) {
    lines.push('  Nothing scanned yet.');
    return lines;
  }

  // Real tree connectors.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let prefix = '';
    for (let d = 0; d < e.depth; d++) prefix += lastAtDepth(entries, i, d) ? '   ' : '│  ';
    const branch = lastAtDepth(entries, i, e.depth) ? '└─ ' : '├─ ';
    // A DIRECTORY IS NOT A FILE, and a file this session touched is not an
    // untouched one. Both are said with colour rather than another column.
    const mark = changed.has(e.rel) ? ' ' + P.ok('●') : '';
    const sel = i === cursor ? '❯' : ' ';
    const name = e.isDir ? P.info(e.name) : changed.has(e.rel) ? P.ok(e.name) : e.name;
    const body = `${sel} ${P.meta(prefix + branch)}${name}`;
    lines.push(pad(clip(body, width - 3), Math.max(0, width - 3)) + mark);
  }
  if (changed.size) {
    lines.push('');
    lines.push('  ' + P.ok('●') + P.meta(` changed this session — ${changed.size} file${changed.size === 1 ? '' : 's'}`));
  }
  return lines;
}

/** Is entry `i` the last child at depth `d` within its parent? */
function lastAtDepth(entries, i, d) {
  for (let j = i + 1; j < entries.length; j++) {
    if (entries[j].depth < d) return true;      // left the parent
    if (entries[j].depth === d) return false;   // another sibling follows
  }
  return true;
}

/** A shallow, bounded project tree. */
function scanTree(cwd, { max = MAX_TREE_ENTRIES, depth = 2 } = {}) {
  const out = [];
  const walk = (dir, d, prefix) => {
    if (out.length >= max || d > depth) return;
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const dirs = names.filter((e) => e.isDirectory() && !SKIP.test(e.name) && !e.name.startsWith('.'));
    const files = names.filter((e) => e.isFile() && !e.name.startsWith('.'));
    for (const e of dirs) {
      if (out.length >= max) return;
      const r = prefix + e.name;
      out.push({ name: e.name + '/', rel: r, depth: d, isDir: true });
      walk(path.join(dir, e.name), d + 1, r + '/');
    }
    for (const e of files) {
      if (out.length >= max) return;
      out.push({ name: e.name, rel: prefix + e.name, depth: d, isDir: false });
    }
  };
  walk(cwd, 0, '');
  return out;
}

/** OUTPUT — bounded command/test output, newest last. */
/** IMAGE FILES MENTIONED BY A COMMAND'S OUTPUT. */
const img = require('./images');

function imagesIn(o) {
  const found = [];
  const text = String((o && o.output) || '');
  const EXT = '(?:png|jpe?g|gif|webp|bmp)';
  const WIN = `[A-Za-z]:[\\\\/][^\\s"']+\\.${EXT}`;      // C:\a\b.png
  const NIX = `/[^\\s"']+\\.${EXT}`;                     // /a/b.png
  for (const m of text.matchAll(new RegExp(`${WIN}|${NIX}`, 'gi'))) {
    if (!found.includes(m[0])) found.push(m[0]);
  }
  return found.slice(0, 3);
}

function outputView({ outputs = [], width = 80, running = null }) {
  const { P } = require('./paint');
  if (!outputs.length && !running) {
    return [P.head('OUTPUT'), '', '  Nothing has been run yet.', '', P.meta('  Shell and test output appears here.')];
  }
  const lines = [P.head('OUTPUT'), ''];
  for (const o of outputs.slice(-5)) {
    const ok = o.exitCode === 0;
    const mark = ok ? P.ok('✓') : o.exitCode == null ? P.meta('·') : P.bad('✗');
    // A COMMAND AND ITS OUTPUT ARE CONTENT, NOT LABELS
    const cmd = wrapIndented(String(o.command || ''), Math.max(12, width - 6));
    lines.push(`  ${mark} ` + P.cmd(cmd[0]));
    for (const part of cmd.slice(1)) lines.push('    ' + P.cmd(part));
    const body = String(o.output || '').split(String.fromCharCode(10));
    const shown = body.slice(0, 200);
    // Trailing blank lines are just a gap between one command and the next.
    while (shown.length && !shown[shown.length - 1].trim()) shown.pop();
    for (const l of shown) {
      // BOUNDED PER SOURCE LINE, because a minified bundle printed to stdout is one line of forty thousand characters and wrapping it unconditionally turns a…
      const parts = wrapIndented(String(l), Math.max(12, width - 8));
      const keep = parts.slice(0, MAX_WRAPPED_ROWS);
      for (const part of keep) lines.push('      ' + part);
      if (parts.length > keep.length) {
        lines.push(P.meta(`      ... ${parts.length - keep.length} more wrapped row(s) of this line`));
      }
    }
    // AN IMAGE IS NAMED AND MEASURED, NEVER APPROXIMATED.
    for (const f of imagesIn(o)) for (const l of img.imageLines(f, width)) lines.push(l);
    if (body.length > 200) lines.push(P.meta(`      … ${body.length - 200} more lines`));
    // THE EXIT STATUS IS ALWAYS STATED, including zero.
    lines.push('      ' + (ok
      ? P.meta('Process exited 0')
      : P.bad(`Process exited ${o.exitCode == null ? '?' : o.exitCode}`)));
    lines.push('');
  }
  // WHAT IS EXECUTING RIGHT NOW, at the foot where the newest thing belongs.
  if (running) {
    const what = running.target || running.name || '';
    // The command IN FLIGHT, whole - see the note above. This is the row a
    // person reads when something is taking too long, and half of it is no use.
    const flight = wrapIndented(String(what), Math.max(12, width - 6));
    lines.push('  ' + P.warn('◒ ') + P.cmd(flight[0]));
    for (const part of flight.slice(1)) lines.push('    ' + P.cmd(part));
    lines.push('      ' + P.meta('tool     ') + P.meta(running.name || '—'));
    lines.push('      ' + P.meta('status   ') + P.warn('RUNNING'));
  }
  return lines;
}

module.exports = {
  changedFiles, countChanges, linesOf, groupChanges, diffView, diffRow, diffSplit, SPLIT_MIN, unified, filesView, scanTree, outputView,
  // EXPORTED so `/image` can offer the images LAIN has actually seen mentioned without keeping a second list of them.
  imagesIn,
  MAX_TREE_ENTRIES,
};
