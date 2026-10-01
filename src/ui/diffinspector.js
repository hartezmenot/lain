'use strict';

/**
 * `/diff` — THE PERSISTENT DIFF INSPECTOR.
 *
 * ------------------------------------------------------------------------
 * WHAT IT IS. An INSPECTOR (ui/panel.js KIND.INSPECTOR): it opens, it stays,
 * and it closes only when the person closes it. A timer, a streaming reply, a
 * patch landing, a resize, a finished task or a background job does not close
 * it — each of those only makes it redraw, and a redraw re-reads the real patch
 * state, so its counters move when the files do and never otherwise.
 *
 *     OVERVIEW                                   DETAIL
 *
 *     3 files changed  +217 −131                 src/provider.js   MODIFIED  +75 −40
 *                                                  118   const route = pick(cfg);
 *     ❯ ● newprovider.js      +142               119 - const retry = 3;
 *       ● provider.js         +75 −40            119 + const retry = policy.retries;
 *       ● oldprovider.js      −91                120   return send(route, retry);
 *
 * TWO SEMANTICS, KEPT APART: the dot is the FILE's state — blue new, green
 * modified, red removed — and a diff line's colour is the LINE's — green added,
 * red removed, neutral context. A modified file is green in the overview and
 * its removed lines are still red in the detail.
 *
 * KEYS.  ↑↓ select or scroll · PgUp/PgDn page · ←/→ previous/next file ·
 *        Enter open a file · Esc back to the overview, then close.
 *
 * THE SOURCE OF TRUTH is the one byte-snapshot system: checkpoint.js holds the
 * bytes before LAIN's first write to each file, and the file on disk holds the
 * bytes now (ui/panes.js `changedFiles`). There is no second record of what
 * changed.
 */

const { KIND, MODE } = require('./panel');
const { P } = require('./paint');
const panes = require('./panes');

const STATE_PAINT = {
  added: (s) => P.writing(s),       // blue: new
  modified: (s) => P.ok(s),         // green: modified
  deleted: (s) => P.bad(s),         // red: removed
};
const STATE_WORD = { added: 'NEW', modified: 'MODIFIED', deleted: 'REMOVED' };

/**
 * Paint `+n` green and `−n` red in the COUNTS COLUMN only — everything after the
 * last two-space gap. A file called `retry-2.js` must not have its name painted.
 */
function paintCounts(body) {
  const trimmed = body.replace(/\s+$/, '');
  const gap = trimmed.lastIndexOf('  ');
  if (gap < 0) return body;
  const head = body.slice(0, gap);
  const tail = body.slice(gap).replace(/(\+\d+)|(−\d+)/g, (m, plus) => (plus ? P.ok(m) : P.bad(m)));
  return head + tail;
}

/**
 * The files, re-read only when something could have changed: a new checkpoint,
 * or a file's size or mtime moving. Every frame asks; almost every frame is a
 * cache hit, because a redraw at 60Hz is not a change to the tree.
 */
function source(app) {
  const fs = require('fs');
  let cache = { key: '', files: [] };
  return () => {
    const cp = app.checkpoints;
    const cwd = app.session && app.session.cwd;
    const entries = (cp && cp.entries) || [];
    const paths = new Set();
    for (const e of entries) for (const f of e.files) paths.add(f.path);
    let key = `${entries.length}|`;
    for (const p of paths) {
      try { const st = fs.statSync(p); key += `${p}:${st.size}:${Math.floor(st.mtimeMs)};`; } catch { key += `${p}:gone;`; }
    }
    if (key !== cache.key) cache = { key, files: panes.changedFiles({ checkpoints: cp, cwd }) };
    return cache.files;
  };
}

function detailFrame(state, files, index) {
  return {
    kind: KIND.INSPECTOR,
    mode: MODE.EXPANDED,
    fullWidth: true,
    keepCase: true,
    get title() {
      const f = files()[state.index];
      return f ? `${f.rel}  ${STATE_WORD[f.kind] || ''}  +${f.added} −${f.removed}` : 'diff';
    },
    get items() {
      const f = files()[Math.min(state.index, Math.max(0, files().length - 1))];
      if (!f) return [{ label: 'That file no longer differs from where it started.', selectable: false }];
      const rows = panes.unified(f.before, f.after, 2000);
      if (!rows.length) return [{ label: '(no line-level diff was captured for this file)', selectable: false }];
      return rows.map((line) => {
        const mark = line.slice(5, 6);
        return {
          label: line,
          selectable: false,
          // THE LINE'S OWN SEMANTICS: added green, removed red, context neutral.
          paint: mark === '+' ? (b) => P.ok(b) : mark === '-' ? (b) => P.bad(b) : (b) => P.plain(b),
        };
      });
    },
    footer: '↑↓ scroll · PgUp/PgDn page · ←/→ previous/next file · Esc overview',
    onKey(key, { panel, rows }) {
      const n = files().length;
      if (key === 'left' || key === 'right') {
        if (!n) return true;
        state.index = (state.index + (key === 'right' ? 1 : -1) + n) % n;
        panel.scroll = 0;
        return true;
      }
      if (key === 'pageup' || key === 'pagedown') { panel.scrollBy(key === 'pagedown' ? rows : -rows, rows); return true; }
      if (key === 'enter') return true;
      return false;
    },
    onEscape({ panel }) {
      // BACK TO THE OVERVIEW, ON THE FILE LAST LOOKED AT — ←/→ may have moved it.
      if (panel.stack[0]) panel.stack[0]._cursor = state.index;
      return { back: true };
    },
    _index: index,
  };
}

/**
 * THE INSPECTOR, as an adapter for the one panel.
 *
 * @param {object} app  anything with `checkpoints` and `session.cwd`
 */
function inspector(app) {
  const files = source(app);
  const state = { index: 0 };
  const overview = {
    kind: KIND.INSPECTOR,
    mode: MODE.EXPANDED,
    fullWidth: true,
    keepCase: true,
    get title() {
      const all = files();
      if (!all.length) return 'diff';
      const plus = all.reduce((a, f) => a + f.added, 0);
      const minus = all.reduce((a, f) => a + f.removed, 0);
      return `diff · ${all.length} file${all.length === 1 ? '' : 's'} changed  +${plus} −${minus}`;
    },
    get items() {
      const all = files();
      if (!all.length) {
        return [
          { label: 'Nothing has changed yet.', selectable: false },
          { label: 'Everything Noema writes is captured first, so this fills as the work lands.', selectable: false },
        ];
      }
      const width = Math.max(...all.map((f) => f.rel.length));
      return all.map((f, i) => {
        const counts = [f.added ? `+${f.added}` : '', f.removed ? `−${f.removed}` : ''].filter(Boolean).join(' ');
        return {
          label: `● ${f.rel.padEnd(width)}  ${counts}`,
          value: i,
          // THE FILE'S STATE on the dot; the COUNTS in their own colours.
          paint: (body) => {
            const at = body.indexOf('●');
            if (at < 0) return paintCounts(body);
            return body.slice(0, at) + (STATE_PAINT[f.kind] || P.plain)('●') + paintCounts(body.slice(at + 1));
          },
        };
      });
    },
    footer: '↑↓ select · PgUp/PgDn page · Enter open · Esc close',
    onKey(key, { panel, rows }) {
      const n = files().length;
      if (key === 'left' || key === 'right') { if (n) panel.move(key === 'right' ? 1 : -1, rows); return true; }
      if (key === 'pageup' || key === 'pagedown') {
        if (n) panel.cursor = Math.max(0, Math.min(n - 1, panel.cursor + (key === 'pagedown' ? rows : -rows)));
        return true;
      }
      if (key === 'enter') {
        if (!n) return true;
        state.index = Math.min(panel.cursor, n - 1);
        panel.push(detailFrame(state, files, state.index));
        return true;
      }
      return false;
    },
  };
  return overview;
}

module.exports = { inspector, detailFrame, STATE_PAINT };
