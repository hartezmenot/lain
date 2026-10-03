'use strict';

/** THE CONTEXT ACTION SHELF — one compact surface for a command with follow-ups. */

const { MODE, KIND } = require('./panel');
const { P } = require('./paint');
const T = require('./text');

/** The action buttons as plain text, and the column span of each. */
function actionRow(state) {
  const acts = state.confirming
    ? [{ label: state.confirming.yes || 'Yes', value: '__yes' }, { label: 'Cancel', value: '__no' }]
    : state.actions;
  let col = 0;
  const spans = acts.map((a, i) => {
    const w = T.width(String(a.label)) + 2;
    const span = { start: col, end: col + w, index: i };
    col += w + 2;
    return span;
  });
  const text = acts.map((a) => ` ${a.label} `).join('  ');
  return { acts, spans, text };
}

function shelf({ title = '', context = [], choices = [], actions = [], focus = 0, cursor = 0, footer = null } = {}) {
  const state = {
    actions: actions.filter(Boolean),
    focus: Math.max(0, Math.min(focus, Math.max(0, actions.length - 1))),
    confirming: null,
  };
  const items = [];
  for (const line of [].concat(context || [])) {
    if (line != null) items.push({ label: String(line), selectable: false });
  }
  if (items.length && choices.length) items.push({ label: '', selectable: false });
  const firstChoice = items.length;
  for (const c of choices) {
    items.push({
      label: c.detail ? `${c.label}   ${c.detail}` : String(c.label),
      value: c.value !== undefined ? c.value : c.label,
      choice: true,
    });
  }
  // THE QUESTION ROW: blank until a destructive action asks, then the question.
  const questionIndex = items.length;
  items.push({ label: '', selectable: false });
  const rowIndex = items.length;
  const row = { label: '', selectable: false, actions: true };
  items.push(row);

  const frame = {
    title,
    keepCase: true,
    kind: KIND.SHELF,
    mode: MODE.COMPACT,
    items,
    cursor: choices.length ? firstChoice + Math.max(0, Math.min(cursor, choices.length - 1)) : 0,
    footer: footer || (choices.length > 1 ? '←→ action · ↑↓ choose · Enter · Esc close' : '←→ action · Enter · Esc close'),
    shelf: state,
    actionRowIndex: rowIndex,
  };

  const refresh = () => {
    const { acts, text } = actionRow(state);
    row.label = text;
    row.paint = (body) => {
      const painted = acts.map((a, i) => (i === state.focus ? P.surface(P.key(` ${a.label} `)) : P.meta(` ${a.label} `))).join('  ');
      // The panel measured `body` as two marker columns plus the plain row; keep that width.
      return '  ' + painted + ' '.repeat(Math.max(0, T.width(body) - 2 - T.width(text)));
    };
    items[questionIndex].label = state.confirming ? String(state.confirming.confirm) : '';
    items[questionIndex].tone = state.confirming ? 'warn' : undefined;
  };
  refresh();

  const chosen = (panel) => {
    const item = panel.items[panel.cursor];
    if (item && item.choice) return item.value;
    return choices.length === 1 ? (choices[0].value !== undefined ? choices[0].value : choices[0].label) : null;
  };

  /** Run the focused action: a confirming action asks first, everything else closes with it. */
  const run = (panel) => {
    if (state.confirming) {
      const act = state.confirming;
      const yes = state.focus === 0;
      state.confirming = null;
      state.focus = Math.max(0, state.actions.indexOf(act));
      if (yes) { panel.close({ action: act.value, choice: chosen(panel) }); return true; }
      refresh();
      return true;
    }
    const act = state.actions[state.focus];
    if (!act) return false;
    if (act.confirm) {
      state.confirming = act;
      state.focus = 1;               // land on Cancel: a destructive yes is never the default
      refresh();
      return true;
    }
    panel.close({ action: act.value, choice: chosen(panel) });
    return true;
  };

  frame.onKey = (key, { panel }) => {
    const n = state.confirming ? 2 : state.actions.length;
    if (!n) return false;
    if (key === 'left' || key === 'shift-tab') { state.focus = (state.focus - 1 + n) % n; refresh(); return true; }
    if (key === 'right' || key === 'tab') { state.focus = (state.focus + 1) % n; refresh(); return true; }
    if (key === 'enter') return run(panel);
    if (key === 'escape' && state.confirming) {
      state.focus = Math.max(0, state.actions.indexOf(state.confirming));
      state.confirming = null;
      refresh();
      return true;
    }
    return false;
  };

  // A UNIQUE FIRST LETTER RUNS ITS ACTION. Letters two actions share are not claimed.
  const counts = {};
  for (const a of state.actions) { const k = String(a.label)[0].toLowerCase(); counts[k] = (counts[k] || 0) + 1; }
  frame.shortcuts = {};
  state.actions.forEach((a, i) => {
    const k = String(a.label)[0].toLowerCase();
    if (counts[k] !== 1) return;
    frame.shortcuts[k] = (_item, { panel }) => {
      if (state.confirming) return undefined;
      state.focus = i;
      run(panel);
      return true;
    };
  });

  /** `x` is the column within the row, after the panel's indent and marker. */
  frame.onClick = (item, x, { panel, index }) => {
    if (item && item.actions) {
      const hit = actionRow(state).spans.find((s) => x >= s.start && x < s.end);
      if (!hit) return true;
      state.focus = hit.index;
      refresh();
      return run(panel);
    }
    if (item && item.choice) panel.cursor = index;
    return true;
  };

  return frame;
}

module.exports = { shelf, actionRow };
