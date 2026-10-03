'use strict';

/** THE COMPOSER PROJECTION — what a big paste LOOKS LIKE while you are editing it. */

/** THE CANONICAL WORDING, at the user's instruction. */
const PLACEHOLDER = '<pasted text>';

/** IS THIS BLOCK BIG ENOUGH TO BE WORTH HIDING? */
function collapsible(body) {
  return require('./pasted').isPaste(body);
}

/** WHERE EACH RECORDED PASTE CURRENTLY SITS IN `text`. */
function spans(text, pastes = []) {
  const s = String(text == null ? '' : text);
  const taken = [];
  for (const raw of Array.isArray(pastes) ? pastes : []) {
    const body = String(raw == null ? '' : raw);
    if (!body || !collapsible(body)) continue;
    let at = 0;
    for (;;) {
      const i = s.indexOf(body, at);
      if (i < 0) break;
      const to = i + body.length;
      if (!taken.some((t) => i < t.to && to > t.from)) { taken.push({ from: i, to }); break; }
      at = i + 1;
    }
  }
  return taken.sort((a, b) => a.from - b.from);
}

/** The buffer as it should be DRAWN, with two maps between the coordinate systems. */
function project(text, pastes = []) {
  const s = String(text == null ? '' : text);
  const found = spans(s, pastes);
  if (!found.length) {
    return { text: s, spans: [], toProjected: (i) => i, toBuffer: (j) => j };
  }

  let out = '';
  let at = 0;
  /** Each span in BOTH coordinate systems, so neither map has to re-derive it. */
  const marks = [];
  for (const sp of found) {
    out += s.slice(at, sp.from);
    marks.push({ from: sp.from, to: sp.to, pFrom: out.length, pTo: out.length + PLACEHOLDER.length });
    out += PLACEHOLDER;
    at = sp.to;
  }
  out += s.slice(at);

  const toProjected = (i) => {
    const n = Math.max(0, Math.min(s.length, Number(i) || 0));
    let delta = 0;
    for (const m of marks) {
      if (n <= m.from) break;
      if (n < m.to) return m.pTo;
      delta += (m.to - m.from) - PLACEHOLDER.length;
    }
    return n - delta;
  };

  const toBuffer = (j) => {
    const n = Math.max(0, Math.min(out.length, Number(j) || 0));
    for (const m of marks) {
      if (n <= m.pFrom) return n + (m.from - m.pFrom);
      if (n < m.pTo) return m.from;
    }
    const last = marks[marks.length - 1];
    return n + (last.to - last.pTo);
  };

  return { text: out, spans: marks, toProjected, toBuffer };
}

/** WHAT THE COMPOSER IS HIDING, as one short phrase, or ''. */
function hidden(marks, text) {
  if (!marks || !marks.length) return '';
  const s = String(text == null ? '' : text);
  let bytes = 0;
  for (const m of marks) bytes += Buffer.byteLength(s.slice(m.from, m.to), 'utf8');
  const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  return marks.length === 1 ? size : `${marks.length} blocks · ${size}`;
}

module.exports = { project, spans, hidden, collapsible, PLACEHOLDER };
