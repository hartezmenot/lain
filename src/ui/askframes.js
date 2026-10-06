'use strict';

/** THE QUESTION FRAMES — one per kind of answer. */

const { KIND, MODE } = require('./panel');

/** What each kind of question accepts. The one declaration all three surfaces read. */
const A = require('./answer');

/** The choice/why split, so a compact row and its explanation stay in step. */
const { splitOption } = require('./adapters');
const T = require('./text');

/**
 * THE QUESTION IS SHOWN IN FULL: its lines are question rows (the panel wraps them by display width and scrolls them on
 * their own, panel.js renderQuestion), as plain text — a model's ANSI codes are not written to the terminal.
 */
function questionRows(question) {
  return T.strip(String(question == null ? '' : question)).split('\n').map((l) => ({ label: l, selectable: false, question: true }));
}
const ZONE = { questionZone: true, fullWidth: true };

/** ONE ENTRY POINT, FIVE FRAMES. */
function askAdapter({ question, options = [], title = 'LAIN NEEDS YOUR INPUT', input = null }) {
  const kind = A.kindOf(input, options);
  // The model's own "(please type a number)" is removed: the surface prints an accurate prompt of its own, and two instructions that can disagree is how…
  const asked = A.stripUiInstruction(question);

  if (kind === A.KIND.NUMBER) return numberAdapter({ question: asked, title });
  if (kind === A.KIND.TEXT) return textAdapter({ question: asked, title, options });
  if (kind === A.KIND.MULTI_SELECT) return multiAdapter({ question: asked, options, title });

  const rows = kind === A.KIND.CONFIRMATION && !options.length ? ['Yes', 'No'] : options;
  const parsed = rows.map(splitOption);
  const hasWhy = parsed.some((p) => p.why);
  const marks = A.labels(rows, kind);
  return {
    title,
    ...ZONE,
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    // WHAT THIS SURFACE TAKES, stated once and read by all three places that have to agree about it: these rows, the panel footer, and the border of the…
    takes: kind,
    options: rows,
    question: asked,
    items: [
      ...questionRows(asked),
      { label: '', selectable: false },
      ...rows.map((o, i) => ({ label: `${marks[i]}.  ${parsed[i].choice}`, value: o })),
    ],
    footer: A.footer(rows, kind, { escape: hasWhy ? 'details' : 'cancel' }),
    // Only offered when there is genuinely more to read. Escape that opens an
    // empty screen is worse than Escape that cancels.
    onEscape: hasWhy ? () => ({ push: askDetailsAdapter({ question: asked, options: rows }) }) : null,
    /** A TYPED LINE IS THE ANSWER — the whole point of this rewrite. */
    onTyped(text) {
      if (kind === A.KIND.CONFIRMATION) {
        const v = A.validate(kind, text, rows);
        return v.ok ? { close: v.value } : { reject: v.why };
      }
      const m = A.match(text, rows, kind);
      if (!m) return undefined;                       // empty line: Enter means the row
      if (m.kind === 'OPTION' && A.optionIsOther(rows[m.index])) {
        return { push: textAdapter({ question: asked, options: rows, back: true }) };
      }
      return { close: m.value };
    },
    onSelect(item) {
      // PICKING "Other…" MUST LEAD SOMEWHERE YOU CAN TYPE.
      if (A.optionIsOther(item.value)) {
        return { push: textAdapter({ question: asked, options: rows, back: true }) };
      }
      return { close: item.value };
    },
    /** THE LABEL MOVES TO THE CHOICE. */
    shortcuts: A.isNumeric(rows) ? {} : Object.fromEntries(rows.map((o, i) => [
      String(marks[i]).toLowerCase(),
      (item, { panel }) => {
        const at = panel.items.findIndex((x) => x.value === o);
        if (at >= 0) panel.cursor = at;
        return true;
      },
    ])),
  };
}

/** NUMBER — a validated line, and no list of options that do not exist. */
function numberAdapter({ question, title = 'LAIN NEEDS YOUR INPUT' }) {
  return {
    title,
    ...ZONE,
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    takes: A.KIND.NUMBER,
    options: [],
    question,
    items: [
      ...questionRows(question),
      { label: '', selectable: false },
      { label: 'Type a number on the line above and press Enter.', selectable: false },
    ],
    footer: A.footer([], A.KIND.NUMBER),
    onTyped(text) {
      const v = A.validate(A.KIND.NUMBER, text);
      return v.ok ? { close: v.value } : { reject: v.why };
    },
  };
}

/** TEXT — free text, with a real place to type it. */
function textAdapter({ question, options = [], title = 'YOUR ANSWER', back = false }) {
  return {
    title,
    ...ZONE,
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    takes: A.KIND.TEXT,
    options,
    question,
    items: [
      ...questionRows(question),
      { label: '', selectable: false },
      { label: 'Type your answer on the line above and press Enter.', selectable: false },
      ...(back ? [{ label: 'Esc goes back to the listed choices.', selectable: false }] : []),
    ],
    footer: A.footer(options, A.KIND.TEXT, { escape: back ? 'back' : 'cancel' }),
    onEscape: back ? () => ({ back: true }) : null,
    onTyped(text) {
      const s = String(text == null ? '' : text).trim();
      return s ? { close: s } : undefined;
    },
  };
}

/** MULTI_SELECT — any of them, none of them, all of them. */
function multiAdapter({ question, options = [], title = 'LAIN NEEDS YOUR INPUT' }) {
  const marks = A.labels(options, A.KIND.MULTI_SELECT);
  const chosen = new Set();
  const rows = () => [
    ...questionRows(question),
    { label: '', selectable: false },
    ...options.map((o, i) => ({
      label: `${chosen.has(i) ? '[x]' : '[ ]'} ${marks[i]}.  ${splitOption(o).choice}`,
      value: o,
      index: i,
    })),
  ];
  const frame = {
    title,
    ...ZONE,
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    takes: A.KIND.MULTI_SELECT,
    options,
    question,
    chosen,
    items: rows(),
    footer: A.footer(options, A.KIND.MULTI_SELECT),
    /** Space marks and unmarks. Enter is "send what is marked". */
    shortcuts: {
      ' ': (item, { panel }) => {
        if (!item || item.index === undefined) return true;
        if (chosen.has(item.index)) chosen.delete(item.index); else chosen.add(item.index);
        frame.items = rows();
        panel.stack[panel.stack.length - 1] = frame;
        return true;
      },
    },
    onSelect() {
      if (!chosen.size) return { reject: 'nothing is marked yet — Space marks a row, or type the numbers.' };
      return { close: [...chosen].sort((a, b) => a - b).map((i) => A.optionText(options[i])).join(', ') };
    },
    onTyped(text) {
      const v = A.validate(A.KIND.MULTI_SELECT, text, options);
      return v.ok ? { close: v.value } : { reject: v.why };
    },
  };
  return frame;
}

/**
 * The same question, with every option's reasoning IN FULL: one scrolling text (wrapped by display width like the
 * question itself, panel.js renderQuestion) — the choice and its whole explanation, never cut at a length.
 */
function askDetailsAdapter({ question, options = [] }) {
  const items = [...questionRows(question), { label: '', selectable: false, question: true }];
  options.forEach((o, i) => {
    const { choice, why } = splitOption(o);
    // A LONG OPTION's row label is its first words and "…"; here its whole text follows, so the heading is the letter alone.
    const cut = choice.endsWith('…') && String(why).startsWith(choice.slice(0, -1).trimEnd());
    items.push({ label: cut ? `${A.LETTERS[i] || i + 1} —` : `${A.LETTERS[i] || i + 1} — ${T.strip(choice)}`, selectable: false, question: true });
    for (const l of T.strip(why || '(no further explanation was given)').split('\n')) items.push({ label: `    ${l}`, selectable: false, question: true });
    items.push({ label: '', selectable: false, question: true });
  });
  return {
    title: 'QUESTION DETAILS',
    ...ZONE,
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    items,
    footer: 'Esc back to the choices',
    onEscape: () => ({ back: true }),
  };
}

module.exports = { askAdapter, numberAdapter, textAdapter, multiAdapter, askDetailsAdapter };
