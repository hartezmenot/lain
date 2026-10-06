'use strict';

/** THE INTERACTION PANEL — one subsystem, many adapters. */

const { P } = require('./paint');
/** The one ruler for terminal cells — CJK is two, an escape is zero. See ui/text.js. */
const T = require('./text');

const MODE = Object.freeze({ HIDDEN: 'hidden', COMPACT: 'compact', EXPANDED: 'expanded' });

/** WHAT the panel is currently for. */
const KIND = Object.freeze({
  IDLE: 'IDLE',
  COMMAND_PALETTE: 'COMMAND_PALETTE',
  FILE_COMPLETION: 'FILE_COMPLETION',
  MODEL_SELECTION: 'MODEL_SELECTION',
  EFFORT_SELECTION: 'EFFORT_SELECTION',
  PROVIDER_SELECTION: 'PROVIDER_SELECTION',
  CONFIG: 'CONFIG',
  ASK_USER: 'ASK_USER',
  CONFIRM: 'CONFIRM',
  FILE_PICKER: 'FILE_PICKER',
  // `STEP_PICKER` STOOD HERE — the "which plan step to expand" picker the PLAN pane opened on an empty Enter.
  /** WHAT A COMMAND SAID — `/status`, `/dash`, a compaction notice. */
  OUTPUT: 'OUTPUT',
  /** SOMETHING WORTH KNOWING WHILE THE WORK CARRIES ON — see looping.js. */
  ADVISORY: 'ADVISORY',
  /** SOMETHING THE PERSON IS INSPECTING — `/diff`. */
  INSPECTOR: 'INSPECTOR',
  /** A command's follow-up actions — `/goal`, `/plan`, `/resume`. See ui/shelf.js. */
  SHELF: 'SHELF',
});

/** Completion kinds follow the input; everything else owns the keyboard. */
const COMPLETION_KINDS = new Set([KIND.COMMAND_PALETTE, KIND.FILE_COMPLETION]);

/** Kinds with NO CALLER WAITING BEHIND THEM. */
const PASSIVE_KINDS = new Set([KIND.OUTPUT, KIND.ADVISORY]);

/** An adapter is `{ title, mode, kind, items, footer?, onSelect?, onBack? }`. */
/** LAND ON SOMETHING CHOOSABLE — every way a level opens (open, replace, push). */
function landOn(items, cursor) {
  const list = items || [];
  if (!list[cursor] || list[cursor].selectable !== false) return cursor;
  const i = list.findIndex((x) => x && x.selectable !== false);
  return i < 0 ? 0 : i;
}

class InteractionPanel {
  constructor() {
    this.stack = [];      // adapter frames; supports drill-down + back
    this.cursor = 0;
    this.scroll = 0;
    this.result = null;   // resolved value for await-style callers
    /** Why the last typed answer was refused, drawn under the question. */
    this.error = null;
    this._resolve = null;
  }

  get visible() { return this.stack.length > 0; }
  get frame() { return this.stack[this.stack.length - 1] || null; }
  get mode() { return this.frame ? (this.frame.mode || MODE.EXPANDED) : MODE.HIDDEN; }
  get items() { return this.frame ? this.frame.items || [] : []; }

  /** What the panel is for right now. IDLE when it is closed. */
  get kind() { return this.frame ? (this.frame.kind || KIND.CONFIRM) : KIND.IDLE; }

  /** WHAT THE OPEN FRAME TAKES FROM THE KEYBOARD — null when it takes nothing. */
  get takes() { return this.frame ? (this.frame.takes || null) : null; }

  /** True when a typed line is an answer to this panel rather than a prompt. */
  get acceptsTyped() { return typeof (this.frame && this.frame.onTyped) === 'function'; }

  /** The choices the open question is offering, for the surfaces that describe it. */
  get options() { return (this.frame && this.frame.options) || []; }

  /** ENTER, WITH TEXT ON THE LINE. */
  submitTyped(text) {
    const f = this.frame;
    if (!f || typeof f.onTyped !== 'function') return false;
    this.error = null;
    const outcome = f.onTyped(String(text == null ? '' : text), { panel: this });
    if (outcome && outcome.push) { this.push(outcome.push); return true; }
    if (outcome && outcome.close !== undefined) { this.close(outcome.close); return true; }
    // REFUSED, AND THE QUESTION STAYS OPEN.
    if (outcome && outcome.reject) { this.error = String(outcome.reject); return true; }
    return false;
  }

  /** Why the last answer was refused, or null. Cleared by the next attempt. */
  get lastError() { return this.error || null; }

  /** True when typing should keep driving this panel rather than be blocked. */
  get isCompletion() { return COMPLETION_KINDS.has(this.kind); }

  /** True when the panel is showing something rather than asking something. */
  get isPassive() { return PASSIVE_KINDS.has(this.kind); }

  /** True for the one panel that must not take the keyboard. */
  get isAdvisory() { return this.kind === KIND.ADVISORY; }

  /** True for a persistent inspector — see KIND.INSPECTOR. */
  get isInspector() { return this.kind === KIND.INSPECTOR; }

  /** Swap the CONTENT of the open panel without closing it — what a completion menu does on every keystroke. */
  replace(adapter) {
    if (!this.stack.length) return this.open(adapter);
    this.stack[this.stack.length - 1] = adapter;
    const n = (adapter.items || []).length;
    // A NEW adapter may say where the cursor belongs, exactly as `open` does.
    if (Number(adapter.cursor) >= 0) this.cursor = Number(adapter.cursor);
    if (this.cursor >= n) this.cursor = Math.max(0, n - 1);
    this.cursor = landOn(adapter.items, this.cursor);
    this.scroll = 0;
    return undefined;
  }

  /** The currently highlighted item, or null. */
  get current() {
    const it = this.items[this.cursor];
    return it && it.selectable !== false ? it : null;
  }

  /** Open a panel. Returns a promise that settles when the user picks or cancels. */
  open(adapter) {
    this.stack = [adapter];
    this.error = null;
    // An adapter may say where the cursor belongs — a list of 1,151 models is
    // far more useful opened ON the current one than at the alphabetical top.
    this.cursor = Number(adapter && adapter.cursor) > 0 ? Number(adapter.cursor) : 0;
    this.cursor = landOn(adapter && adapter.items, this.cursor);
    this.scroll = 0;
    this.result = null;
    return new Promise((resolve) => { this._resolve = resolve; });
  }

  /** Drill down (model → its routes) while keeping the parent for `←`. */
  push(adapter) {
    // REMEMBER WHERE THE CURSOR WAS.
    const from = this.frame;
    if (from) from._cursor = this.cursor;
    this.stack.push(adapter);
    this.cursor = Number(adapter && adapter.cursor) > 0 ? Number(adapter.cursor) : 0;
    this.cursor = landOn(adapter && adapter.items, this.cursor);
    this.scroll = 0;
  }

  back() {
    if (this.stack.length <= 1) return this.close(null);
    this.stack.pop();
    const f = this.frame;
    this.cursor = f && Number.isFinite(f._cursor) ? f._cursor : 0;
    this.scroll = 0;
    return undefined;
  }

  /** ESCAPE. The frame decides what backing out MEANS. */
  escape() {
    const f = this.frame;
    if (!f || typeof f.onEscape !== 'function') return false;
    const outcome = f.onEscape({ panel: this });
    if (outcome && outcome.push) { this.push(outcome.push); return true; }
    if (outcome && outcome.back) { this.back(); return true; }
    return false;
  }

  close(value = null) {
    this.stack = [];
    this.error = null;
    this.cursor = 0;
    this.scroll = 0;
    this.result = value;
    if (this._resolve) { const r = this._resolve; this._resolve = null; r(value); }
    return value;
  }

  /** Is there anything here to put a cursor ON? */
  get selectable() {
    return this.items.some((it) => it && it.selectable !== false);
  }

  move(delta, viewportRows = 10) {
    const n = this.items.length;
    if (!n) return;
    // NOTHING TO SELECT MEANS THE ARROWS SCROLL
    if (!this.selectable) { this.scrollBy(delta, viewportRows); return; }
    // Skip non-selectable rows (headings/separators) in the direction of travel.
    let next = this.cursor;
    for (let i = 0; i < n; i++) {
      next = (next + delta + n) % n;
      if (this.items[next] && this.items[next].selectable !== false) break;
    }
    this.cursor = next;
    this._clampScroll(viewportRows);
  }

  _clampScroll(viewportRows, total = this.items.length) {
    const rows = Math.max(1, viewportRows);
    // THE CURSOR ONLY DRAGS THE VIEW WHEN THERE IS A CURSOR.
    if (this.selectable) {
      if (this.cursor < this.scroll) this.scroll = this.cursor;
      if (this.cursor >= this.scroll + rows) this.scroll = this.cursor - rows + 1;
    }
    const maxScroll = Math.max(0, total - rows);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    if (this.scroll < 0) this.scroll = 0;
  }

  scrollBy(delta, viewportRows = 10) {
    this.scroll = Math.max(0, Math.min(this.scroll + delta, Math.max(0, this.items.length - viewportRows)));
  }

  /** Enter (or `→`). The adapter decides: resolve, drill down, or do nothing. */
  select({ key = 'enter' } = {}) {
    const f = this.frame;
    if (!f) return undefined;
    const item = this.items[this.cursor];
    if (!item || item.selectable === false) return undefined;
    if (typeof f.onSelect !== 'function') return this.close(item.value !== undefined ? item.value : item);
    const outcome = f.onSelect(item, { key, panel: this });
    if (outcome && outcome.push) { this.push(outcome.push); return undefined; }
    if (outcome && outcome.close !== undefined) return this.close(outcome.close);
    // The same refusal submitTyped allows: Enter on a MULTI_SELECT with nothing marked is not an empty answer, it is a question that has not been answered…
    if (outcome && outcome.reject) { this.error = String(outcome.reject); return undefined; }
    return undefined;
  }

  /** A SINGLE TYPED LETTER THE OPEN PANEL CLAIMS — `D` for details on the session browser being the first of them. */
  shortcut(letter) {
    const f = this.frame;
    if (!f || this.isCompletion) return false;
    const key = String(letter || '').toLowerCase();
    const fn = f.shortcuts && f.shortcuts[key];
    if (typeof fn !== 'function') return false;
    const outcome = fn(this.items[this.cursor] || null, { panel: this });
    if (outcome && outcome.push) { this.push(outcome.push); return true; }
    if (outcome && outcome.close !== undefined) { this.close(outcome.close); return true; }
    return outcome !== undefined;
  }

  /** Render to lines. `rows` is the height the layout allotted; the panel windows its own content so a 2,000-row list can never push the terminal around. */
  /** Render to lines. `rows` is the height the layout allotted; the panel windows its own content so a 2,000-row list can never push the terminal around. */
  render(width = 80, rows = 12) {
    const f = this.frame;
    if (!f) return [];
    if (f.questionZone) return this.renderQuestion(width, rows);
    const out = [];
    // THE MENU IS AS WIDE AS ITS CONTENTS, NOT AS WIDE AS THE TERMINAL
    const inner = this.menuWidth(width);
    const INDENT = '  ';
    const title = String(f.title || '');
    if (title) {
      // SENTENCE CASE. `COMMANDS` in capitals inside a box was the loudest thing on a screen whose subject is a conversation. A PATH KEEPS ITS CASE…
      out.push(P.meta(INDENT + (f.keepCase ? clip(title, inner) : title.charAt(0) + title.slice(1).toLowerCase())));
      out.push('');
    }

    // Chrome is the title, its blank row, a blank row and the footer — four, where the box spent six.
    const chrome = (title ? 2 : 0) + FOOTER_ROWS;
    const bodyRows = Math.max(1, rows - chrome);
    // WRAP, OR CLIP
    const shown = f.wrap ? wrapItems(this.items, inner) : this.items;
    this._clampScroll(bodyRows, shown.length);
    const slice = shown.slice(this.scroll, this.scroll + bodyRows);
    for (let i = 0; i < bodyRows; i++) {
      const item = slice[i];
      if (!item) { out.push(''); continue; }
      const idx = this.scroll + i;
      const sel = idx === this.cursor && item.selectable !== false;
      // `>` ONLY ON THE SELECTED ROW, and the others are not indented to make room for a marker they do not have - they are, because a list whose rows shift…
      const marker = item.selectable === false ? '  ' : (sel ? '❯ ' : '  ');
      const text = marker + String(item.label == null ? '' : item.label);
      // COLOUR IS APPLIED AFTER PADDING
      const body = pad(clip(text, inner), inner);
      // A ROW MAY PAINT ITSELF when one tone cannot say it — a diff overview row carries a state dot and separately coloured counts.
      if (typeof item.paint === 'function') {
        const painted = item.paint(body, { selected: sel });
        out.push(INDENT + (sel ? P.surface(painted) : painted));
        continue;
      }
      const tint = item.tone && P[item.tone] ? P[item.tone] : null;
      // THE ROW ENTER WILL CHOOSE, UNMISTAKABLY
      const painted = tint ? tint(body) : accentRow(body);
      out.push(INDENT + (sel ? P.surface(painted) : painted));
    }
    // THE REFUSAL, WHERE THE ANSWER WOULD HAVE GONE.
    if (this.error) {
      out[out.length - 1] = INDENT + P.bad(pad(clip('✗ ' + this.error, inner), inner));
    }
    const more = this.items.length > bodyRows
      ? `  (${this.scroll + 1}-${Math.min(this.scroll + bodyRows, this.items.length)} of ${this.items.length})`
      : '';
    out.push('');
    out.push(P.meta(INDENT + clip((f.footer || defaultFooter(this.stack.length)) + more, inner)));
    return out;
  }

  // ---- A QUESTION IS SHOWN IN FULL (askframes.js `questionZone`) -------------------------------------------------------
  /** The question's display rows at this width: wrapped by display width (wide characters count 2, ANSI 0), never clipped. */
  questionRows(width) { return wrapItems(this.items.filter((it) => it.question), this.menuWidth(width)); }
  /** The rows a question panel needs: the title, the whole question, the blank, the options, the footer. */
  wantedRows(width) {
    const f = this.frame; if (!f) return 0;
    return (f.title ? 2 : 0) + this.questionRows(width).length + this.items.filter((it) => !it.question).length + FOOTER_ROWS;
  }
  /** PgUp / PgDn / the wheel move through the question; the arrows stay with the options. */
  scrollQuestion(delta) {
    const f = this.frame; if (!f) return;
    // A PAGE IS THE QUESTION'S OWN WINDOW less one line of overlap — a bigger step would skip lines nobody saw.
    const page = Math.max(1, (f._qroom || 1) - 1);
    f._qscroll = Math.max(0, (f._qscroll || 0) + Math.sign(delta) * Math.min(Math.abs(delta), page));
  }
  /**
   * THE QUESTION AND ITS OPTIONS. The options keep their rows (they are what you answer with); the question takes the
   * rest, and when it is taller than that it scrolls on its own, saying how much is above and below — never cut.
   */
  renderQuestion(width, rows) {
    const f = this.frame; const out = []; const INDENT = '  ';
    const inner = this.menuWidth(width);
    const title = String(f.title || '');
    if (title) { out.push(P.meta(INDENT + title.charAt(0) + title.slice(1).toLowerCase())); out.push(''); }
    const body = Math.max(1, rows - (title ? 2 : 0) - FOOTER_ROWS);
    const q = this.questionRows(width);
    const rest = this.items.map((it, i) => ({ it, i })).filter((x) => !x.it.question);   // the blank, the options, notes
    const fits = q.length + rest.length <= body;
    // TOO TALL FOR BOTH: the options take up to half (they scroll around the cursor), the question the rest; a question
    // that fits in what is left is shown whole and the options get every remaining row.
    let optRoom = rest.length; let qRoom = q.length;
    if (!fits) {
      optRoom = Math.min(rest.length, Math.max(2, Math.ceil(body / 2)));
      qRoom = body - optRoom;
      if (q.length <= qRoom) { qRoom = q.length; optRoom = body - qRoom; }
    }
    // THE QUESTION'S WINDOW, with a marker row for what is above and below it.
    let lines = q; let above = 0; let below = 0;
    if (q.length > qRoom) {
      const room = Math.max(1, qRoom - 2);
      f._qroom = room;
      f._qscroll = Math.min(Math.max(0, f._qscroll || 0), Math.max(0, q.length - room));
      above = f._qscroll; lines = q.slice(above, above + room); below = q.length - above - lines.length;
    } else f._qscroll = 0;
    const row = (text) => INDENT + pad(clip(text, inner), inner);
    if (q.length > qRoom && qRoom >= 2) out.push(INDENT + P.meta(pad(above ? `  ▲ ${above} more line${above === 1 ? '' : 's'} above · PgUp` : '', inner)));
    for (const l of lines) out.push(row(`  ${l.label}`));
    if (q.length > qRoom && qRoom >= 2) out.push(INDENT + P.meta(pad(below ? `  ▼ ${below} more line${below === 1 ? '' : 's'} below · PgDn` : '', inner)));
    // THE OPTIONS: a window around the cursor when there are more than their rows, with one row saying how many are not shown.
    const ci = rest.findIndex((x) => x.i === this.cursor);
    const clipped = rest.length > optRoom;
    const win = clipped ? Math.max(1, optRoom - 1) : optRoom;
    const start = ci >= win ? ci - win + 1 : 0;
    const shown = rest.slice(start, start + win);
    for (const { it, i } of shown) {
      const sel = i === this.cursor && it.selectable !== false;
      const text = pad(clip((it.selectable === false ? '  ' : (sel ? '❯ ' : '  ')) + String(it.label == null ? '' : it.label), inner), inner);
      const tint = it.tone && P[it.tone] ? P[it.tone] : null;
      const painted = tint ? tint(text) : accentRow(text);
      out.push(INDENT + (sel ? P.surface(painted) : painted));
    }
    if (clipped) {
      const count = (xs) => xs.filter((x) => x.it.selectable !== false).length;
      const up = count(rest.slice(0, start)); const down = count(rest.slice(start + shown.length));
      out.push(INDENT + P.meta(pad(`  ${up ? `▲ ${up} more choice${up === 1 ? '' : 's'} above · ↑` : ''}${up && down ? '   ' : ''}${down ? `▼ ${down} more choice${down === 1 ? '' : 's'} below · ↓` : ''}`, inner)));
    }
    while (out.length < (title ? 2 : 0) + body) out.push('');
    if (this.error) out[out.length - 1] = INDENT + P.bad(pad(clip('✗ ' + this.error, inner), inner));
    out.push('');
    const more = q.length > qRoom ? (rest.some((x) => x.it.selectable !== false) ? ' · PgUp/PgDn the question' : ' · PgUp/PgDn scroll') : '';
    out.push(P.meta(INDENT + clip((f.footer || defaultFooter(this.stack.length)) + more, inner)));
    return out;
  }

  /** HOW WIDE THE MENU IS: what its contents need, bounded by the frame. */
  menuWidth(width) {
    const frame = Math.max(10, Math.floor(Number(width) || 80) - 2);
    // AN INSPECTOR READS CODE, and code needs the width it has. A diff clipped
    // to a menu's eighty-four columns is a diff with its right half missing.
    if (this.frame && this.frame.fullWidth) return frame;
    let longest = 0;
    for (const it of this.items) {
      const n = T.width(String((it && it.label) || ''));
      if (n > longest) longest = n;
    }
    const footer = String((this.frame && this.frame.footer) || defaultFooter(this.stack.length)).length + 18;
    const wanted = Math.max(longest + 2, footer, MENU_MIN);
    return Math.max(MENU_MIN, Math.min(frame, Math.min(wanted, MENU_MAX)));
  }
}

/** A ROW'S COMMAND TOKEN, ACCENTED; THE REST OF IT, DIM. */
function accentRow(body) {
  const m = /^(  |❯ )(\S+)(\s{2,})([\s\S]*)$/.exec(body);
  if (!m) return body;
  return m[1] + P.cmd(m[2]) + P.meta(m[3] + m[4]);
}

/** HOW MANY ROWS ARE NOT CONTENT: a blank row and the footer. */
const FOOTER_ROWS = 2;

/** A menu narrower than this is a sliver; wider than this is a wall. */
const MENU_MIN = 32;
const MENU_MAX = 84;

function defaultFooter(depth) {
  return depth > 1
    ? '↑↓ select · Enter open · ← back · Esc close'
    : '↑↓ select · Enter confirm · Esc cancel';
}

/** EXACTLY `width` CELLS. */
function pad(s, width) {
  const t = String(s == null ? '' : s);
  return T.pad(T.width(t) > width ? T.hardSlice(t, width) : t, width);
}

/** Expand items into DISPLAY ROWS, wrapping each label to the panel width. */
function wrapItems(items, inner) {
  const width = Math.max(8, inner - 2);   // the marker column
  const out = [];
  // NOT NAMED "continuation": that word belongs to task.js, which owns whether an INPUT continues the previous task, and an architecture guard keeps it…
  const HANG = '  ';
  for (const item of items || []) {
    const text = String((item && item.label) == null ? '' : item.label).replace(/\s+$/, '');
    if (!text.trim()) { out.push({ ...item, label: '', selectable: false }); continue; }

    // THE LIMIT IS DECIDED PER ROW, BEFORE THE ROW IS BUILT.
    const words = text.split(/\s+/).filter(Boolean);
    let row = 0;
    let line = '';
    const limit = () => Math.max(4, width - (row === 0 ? 0 : HANG.length));
    const flush = () => {
      out.push({ ...item, label: (row === 0 ? '' : HANG) + line, selectable: false });
      row += 1;
      line = '';
    };
    for (let w of words) {
      // A SINGLE WORD LONGER THAN THE PANEL still has to go somewhere — a long path, a token, a URL.
      while (T.width(w) > limit()) {
        if (line) flush();
        line = T.hardSlice(w, limit());
        w = w.slice(line.length);
        flush();
      }
      if (!w) continue;
      if (line && (T.width(line) + 1 + T.width(w)) > limit()) flush();
      line = line ? `${line} ${w}` : w;
    }
    if (line) flush();
  }
  return out;
}

function clip(s, width) {
  return T.clip(String(s == null ? '' : s), width);
}

module.exports = {
  FOOTER_ROWS,
  MODE, KIND, COMPLETION_KINDS, PASSIVE_KINDS, InteractionPanel,
  pad, clip,
};


// THE ADAPTERS LIVE IN ui/adapters.js — see its header for why.
Object.assign(module.exports, require('./adapters'));
