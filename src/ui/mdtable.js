'use strict';

/** PREFORMATTED LINES (D1) AND MARKDOWN TABLES (D2) for ui/markdown.js and ui/feed.js — presentation only. */

const T = require('./text');
const { P } = require('./paint');
const inline = (s) => require('./markdown').inline(s);

/** IS THIS ONE LINE PREFORMATTED? */
const BOX = /[─━│┃┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬▶◀►◄▲▼]/;
function preformatted(line) {
  const t = String(line == null ? '' : line);
  if (!t.trim()) return false;
  if (/^ {4}/.test(t) || BOX.test(t)) return true;
  if (/^\s*\+[-=+]{2,}/.test(t) || /^\s*\|.*\|\s*$/.test(t)) return true;
  const body = t.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '');
  return /\S {3,}\S/.test(body);
}

/** A markdown pipe-table row's cells, or null. */
function cells(line) {
  const t = String(line || '').trim();
  if (!/^\|.*\|$/.test(t)) return null;
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/** A MARKDOWN TABLE (D2): an aligned grid sized to the width, or — when the terminal is too narrow — stacked `key: value` rows, one block per record. */
function table(rows, cols) {
  const head = rows[0];
  const body = rows.slice(1);
  const n = Math.max(head.length, ...body.map((r) => r.length));
  const widths = Array.from({ length: n }, (_, k) => Math.max(...[head, ...body].map((r) => T.width(inline(r[k] || '').replace(/\x1b\[[0-9;]*m/g, '')))));
  const total = widths.reduce((a, w) => a + w, 0) + 3 * (n - 1);
  const out = [];
  const plain = (s) => String(s || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  if (total <= cols) {
    const row = (r, paint) => r.concat(Array(n - r.length).fill('')).map((c, k) => paint(T.pad(plain(c), widths[k]))).join(P.meta(' │ '));
    out.push(row(head, (s) => P.head(s)));
    out.push(P.meta(widths.map((w) => '─'.repeat(w)).join('─┼─')));
    for (const r of body) out.push(row(r, (s) => s));
    return out;
  }
  const keyW = Math.min(Math.max(...head.map((h) => T.width(plain(h)))), Math.floor(cols / 3));
  for (const r of body) {
    for (let k = 0; k < n; k++) {
      const key = T.pad(T.clip(plain(head[k] || ''), keyW), keyW);
      const val = plain(r[k] || '');
      const room = Math.max(8, cols - keyW - 2);
      const parts = require('./doc').wrap(val, room);
      out.push(`${P.meta(key)}  ${parts[0] || ''}`);
      for (const p of parts.slice(1)) out.push(`${' '.repeat(keyW)}  ${p}`);
    }
    out.push('');
  }
  if (out.length && !out[out.length - 1]) out.pop();
  return out;
}

module.exports = { preformatted, cells, TABLE_SEP, table };
