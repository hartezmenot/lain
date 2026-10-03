'use strict';

/** WHAT KIND OF ANSWER A QUESTION IS ASKING FOR, AND WHAT A TYPED LINE MEANS. */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The free-text row. One spelling, shared by the tool and the panel. */
const OTHER = 'Other…';

/** WHAT THE SURFACE IS ASKING FOR. */
const KIND = Object.freeze({
  CHOICE: 'CHOICE',
  NUMBER: 'NUMBER',
  TEXT: 'TEXT',
  CONFIRMATION: 'CONFIRMATION',
  MULTI_SELECT: 'MULTI_SELECT',
});

/** What a caller may name in `ask_user`, mapped to the kind it means. */
const FROM_TOOL = Object.freeze({
  choice: KIND.CHOICE,
  number: KIND.NUMBER,
  text: KIND.TEXT,
  confirm: KIND.CONFIRMATION,
  confirmation: KIND.CONFIRMATION,
  multi: KIND.MULTI_SELECT,
  multi_select: KIND.MULTI_SELECT,
});

/** The kind a caller asked for, or CHOICE. Never throws on a bad name. */
function kindOf(name, options = []) {
  const k = FROM_TOOL[String(name || '').trim().toLowerCase()] || (options.length ? KIND.CHOICE : KIND.TEXT);
  // NO OPTIONS MEANS THERE IS NOTHING TO CHOOSE BETWEEN, whatever was declared.
  if (needsOptions(k) && !options.length) return KIND.TEXT;
  return k;
}

/** True when this kind draws a list of rows to pick from. */
function listed(kind) {
  return kind === KIND.CHOICE || kind === KIND.CONFIRMATION || kind === KIND.MULTI_SELECT;
}

/** True when the CALLER has to supply those rows for the question to mean anything. */
function needsOptions(kind) {
  return kind === KIND.CHOICE || kind === KIND.MULTI_SELECT;
}

/** THE KEYS A MODEL ACTUALLY USES when it sends an option as an object. */
const LABEL_KEYS = ['label', 'option', 'choice', 'title', 'name', 'text', 'value'];
const WHY_KEYS = ['description', 'detail', 'details', 'why', 'reason', 'explanation', 'subtitle'];

/** A row's own text. */
function optionText(o) {
  if (o == null) return '';
  if (typeof o === 'string') return o;
  if (typeof o !== 'object') return String(o);
  if (Array.isArray(o)) return o.map(optionText).filter(Boolean).join(' — ');

  const pick = (keys) => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
    return '';
  };
  const label = pick(LABEL_KEYS);
  const why = pick(WHY_KEYS);
  if (label) return why && why !== label ? `${label} — ${why}` : label;
  if (why) return why;

  // An object shaped like nothing above.
  for (const v of Object.values(o)) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return '';
}

/** Is this row the free-text row? Tolerant of the plain-ASCII spelling. */
function optionIsOther(o) {
  const s = optionText(o).trim().replace(/[.…]+$/, '').toLowerCase();
  return s === 'other';
}

/** Are these options themselves numbers? */
function isNumeric(options = []) {
  const real = options.filter((o) => optionText(o) !== OTHER);
  return real.length > 0 && real.every((o) => /^-?\d+(?:\.\d+)?$/.test(optionText(o).trim()));
}

/** The visible label for each row. */
function labels(options = [], kind = KIND.CHOICE) {
  if (kind === KIND.CONFIRMATION) return options.map((_, i) => (i === 0 ? 'Y' : 'N'));
  // MULTI_SELECT IS ALWAYS NUMBERED, because its hint says "type 1-3, comma separated" and a row lettered A under that instruction is the same…
  if (kind === KIND.MULTI_SELECT) return options.map((_, i) => String(i + 1));
  const numeric = isNumeric(options);
  return options.map((_, i) => (numeric ? String(i + 1) : (LETTERS[i] || String(i + 1))));
}

/** WHAT THE SURFACE ACCEPTS RIGHT NOW, in the user's words. */
function hint(options = [], kind = KIND.CHOICE) {
  const n = options.length;
  switch (kind) {
    case KIND.NUMBER: return 'type a number';
    case KIND.TEXT: return 'type your answer';
    case KIND.CONFIRMATION: return 'type Y or N';
    case KIND.MULTI_SELECT:
      return n ? `type 1-${n}, comma separated` : 'type your answer';
    default:
      if (!n) return 'type your answer';
      return isNumeric(options)
        ? `type a number 1-${n}`
        : `type ${n === 1 ? 'A' : `A-${LETTERS[n - 1] || n}`}`;
  }
}

/** The border label for the input box while a question is open. */
function inputLabel(options = [], kind = KIND.CHOICE) {
  return `ANSWER — ${hint(options, kind)}`;
}

/** The panel footer. It names every key that works, and nothing that does not. */
function footer(options = [], kind = KIND.CHOICE, { escape = 'cancel' } = {}) {
  const keys = hint(options, kind);
  switch (kind) {
    case KIND.NUMBER:
    case KIND.TEXT:
      return `${keys} · Enter send · Esc ${escape}`;
    case KIND.MULTI_SELECT:
      return `${keys} · ↑↓ move · Space mark · Enter send · Esc ${escape}`;
    default:
      return `${keys} · ↑↓ choose · Enter send · Esc ${escape}`;
  }
}

/** Resolve a typed line against the options. */
function match(typed, options = [], kind = KIND.CHOICE) {
  const s = String(typed == null ? '' : typed).trim();
  if (!s) return null;

  const exact = options.findIndex((o) => optionText(o).trim().toLowerCase() === s.toLowerCase());
  if (exact >= 0) return { kind: 'OPTION', index: exact, value: optionText(options[exact]) };

  const bare = /^\[?([A-Za-z0-9]{1,3})\]?[.)]?$/.exec(s);
  if (bare) {
    const token = bare[1].toLowerCase();
    const at = labels(options, kind).findIndex((l) => l.toLowerCase() === token);
    if (at >= 0) return { kind: 'OPTION', index: at, value: optionText(options[at]) };
    // AND THE PLAIN ORDINAL, whichever alphabet the rows are drawn in.
    const ord = Number(token);
    if (Number.isInteger(ord) && ord >= 1 && ord <= options.length) {
      return { kind: 'OPTION', index: ord - 1, value: optionText(options[ord - 1]) };
    }
  }

  return { kind: 'TEXT', value: s };
}

/** IS THIS LINE AN ACCEPTABLE ANSWER TO A QUESTION OF THIS KIND? */
function validate(kind, typed, options = []) {
  const s = String(typed == null ? '' : typed).trim();
  if (!s) return { ok: false, why: 'nothing was typed' };

  if (kind === KIND.NUMBER) {
    if (!/^-?\d+(?:\.\d+)?$/.test(s)) {
      return { ok: false, why: `"${s}" is not a number. Type digits only, for example 12.` };
    }
    return { ok: true, value: s };
  }

  if (kind === KIND.CONFIRMATION) {
    if (/^(y|yes)$/i.test(s)) return { ok: true, value: optionText(options[0]) || 'Yes' };
    if (/^(n|no)$/i.test(s)) return { ok: true, value: optionText(options[1]) || 'No' };
    return { ok: false, why: `"${s}" is not yes or no. Type Y or N.` };
  }

  if (kind === KIND.MULTI_SELECT) {
    const picked = selection(s, options);
    if (!picked.ok) return picked;
    return { ok: true, value: picked.values.join(', ') };
  }

  return { ok: true, value: s };
}

/** `1,3` or `a c` or `React, Svelte` → the rows they name. */
function selection(typed, options = []) {
  const tokens = String(typed || '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return { ok: false, why: 'nothing was selected' };
  const indexes = [];
  for (const t of tokens) {
    const m = match(t, options, KIND.MULTI_SELECT);
    if (!m || m.kind !== 'OPTION') {
      return { ok: false, why: `"${t}" is not one of the choices. Use the numbers beside them.` };
    }
    if (!indexes.includes(m.index)) indexes.push(m.index);
  }
  indexes.sort((a, b) => a - b);
  return { ok: true, indexes, values: indexes.map((i) => optionText(options[i])) };
}

/** STRIP AN INSTRUCTION THE UI NOW OWNS. */
const UI_INSTRUCTION = /\s*\(\s*(?:please\s+)?(?:just\s+)?(?:type|enter|reply\s+with|respond\s+with|answer\s+with|choose|pick|select|say)\b[^)]{0,60}\)\s*$/i;

function stripUiInstruction(question) {
  const s = String(question == null ? '' : question);
  const cut = s.replace(UI_INSTRUCTION, '');
  return cut.trim() ? cut.trimEnd() : s;
}

module.exports = {
  LETTERS, OTHER, KIND, FROM_TOOL,
  kindOf, listed, needsOptions, optionText, optionIsOther, isNumeric, labels,
  hint, inputLabel, footer, match, validate, selection, stripUiInstruction,
};
