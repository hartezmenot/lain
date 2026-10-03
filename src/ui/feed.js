'use strict';

/** THE ACTIVITY FEED — telling what the MODEL said from what LAIN DID. */

/** views.js holds the shared text helpers; required lazily to avoid a cycle. */
const V = () => require('./views');
const T = require('./text');

/** Feed entries carry WHO they came from, so the renderer can group them. */
/** `   +12 -4`, or empty when this call changed nothing. */
function editCounts(a) {
  const added = Number(a && a.added) || 0;
  const removed = Number(a && a.removed) || 0;
  if (!added && !removed) return '';
  return `   +${added} -${removed}`;
}

/** Prefix every row of a tool run with the gutter, quietly. */
const GUTTER = '│';

/** HOW WIDE A CONVERSATION DIVIDER IS. */
const DIVIDER_MAX = 64;

// HOW A ROW IS PAINTED lives next door: this file decides which rows exist,
// ui/rowpaint.js decides what weight each part of one carries. See its header.
const { paintRow, paintMark } = require('./rowpaint');


/** A run of tool rows, every one behind the gutter. `P` is passed in lazily. */
function quoteRun(rows, P) {
  return rows.map((r) => (r === '' ? P.meta(GUTTER) : P.meta(`${GUTTER} `) + r));
}

function pushAction(out, a) {
  const shell = require('./shellrow');   // `› command` rows (2026-09-23)
  if (shell.is(a)) return shell.push(out, a);
  out.push({
    kind: 'action',
    // WHAT THE ROW IS ABOUT, for the one word in it that carries an accent.
    subject: String(a.target || ''),
    // THE SIZE OF THE CHANGE STAYS WITH IT.
    text: `${a.ok ? V().MARK.done : V().MARK.error} ${V().phrase(a.name, a.target)}${editCounts(a)}${a.ms >= 1000 ? ` · ${(a.ms / 1000).toFixed(a.ms < 10000 ? 1 : 0)}s` : ''}`,
    // Carried so a run of calls can be counted by what it DID rather than by
    // re-parsing the sentence that was just built out of it.
    verb: V().verbOf(a.name),
    failed: !a.ok,
    // WHICH FILE THIS ROW IS ABOUT, so a click can open it.
    path: a.path || null,
  });
  // Errors always; otherwise only short results from calls that were not about a file — a file call's output is the file itself, which belongs in the…
  if (a.note && (!a.ok || (a.brief && !a.file))) out.push({ kind: 'action', text: `    ${a.note}` });
  // A COMMAND'S OUTPUT LIVES IN OUTPUT, and Context says where to look rather than either dumping forty lines of test log into the conversation or…
  else if (a.output && !a.brief) out.push({ kind: 'action', text: '    \u21b3 /jobs' });
}

/** WHAT THE MODEL SAID — ONE ENTRY PER LINE, not one entry per message. */
function pushModel(out, text, { last = true } = {}) {
  // THE PARAGRAPH BREAK THE STREAM ATE, PUT BACK
  const prev = out[out.length - 1];
  if (prev && prev.kind === 'model' && String(prev.text || '').trim()) {
    out.push({ kind: 'model', text: '', next: true });   // the next paragraph: a new message for `↓ N new`
  }
  // A LEADING RESTATEMENT OF THE REQUEST IS NOT AN ANSWER, and neither is a line announcing the tool call drawn directly underneath it.
  const before = out.length;
  // `last` — is this the model's final word on its turn?
  const condense = require('./condense');
  // A WALL OF ANALYSIS IS FOLDED, NEVER DROPPED
  const shown = condense.fold(condense.prose(text, { last }), { last });
  pushLines(out, shown.text, 'model');
  // NOTHING SURVIVED THE FILTER — then the separator is a blank row introducing
  // nothing, and a feed that grows a gap per dropped line is its own defect.
  if (out.length === before && out[before - 1] && out[before - 1].kind === 'model'
      && !String(out[before - 1].text || '').trim()) {
    out.pop();
  } else if (shown.folded) {
    // WHERE THE REST OF IT WENT.
    out.push({ kind: 'more', text: '▶ full reasoning in DETAIL (8)' });
  }
}

/** One entry per line, blank lines preserved, leading/trailing blanks dropped. */
function pushLines(out, text, kind) {
  const all = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  while (all.length && !all[0].trim()) all.shift();
  while (all.length && !all[all.length - 1].trim()) all.pop();
  if (!all.length) return;
  for (const line of all) out.push({ kind, text: line.replace(/\s+$/, '') });
}

/** WHAT THE USER SAID. The entry that was missing entirely. */
function pushUser(out, text, { steer = false } = {}) {
  // THE USER'S LINE BREAKS ARE THE USER'S.
  const before = out.length;
  const source = String(text == null ? '' : text);
  pushLines(out, source, 'user');
  for (let i = before; i < out.length; i++) { out[i].source = source; if (steer) out[i].steer = true; }
  // WHERE ONE MESSAGE BEGINS.
  if (out.length > before) out[before].head = true;
}

/** THE OTHER TWO ACTORS. */
function pushExternal(out, text) {
  pushLines(out, text, 'external');
}

function pushMcp(out, text) {
  const t = String(text || '').trim();
  if (t) out.push({ kind: 'mcp', text: t });
}

/** SOMETHING THE PROGRAM ITSELF SAID — a liveness warning, a block, a notice. */
function pushNote(out, text, level = 'info') {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t) out.push({ kind: 'note', text: t, level });
}

/** Render the tagged feed, grouping runs of the same kind under one label. */
const LABEL_MIN_WIDTH = 52;

/** WHO IS SPEAKING, and how loudly. */
/** A LABEL IS FOR TELLING TWO SPEAKERS APART, and `label: ''` means this one needs no telling. */
const KIND = {
  user: { label: 'USER', paint: 'key', body: 'plain' },
  model: { label: '', paint: 'info', body: 'plain' },
  external: { label: 'EXTERNAL', paint: 'external', body: 'plain' },
  mcp: { label: 'MCP', paint: 'warn', body: 'plain' },
  action: { label: '', paint: 'meta', body: 'meta' },
  // A POINTER, NOT A SPEAKER. It says where the rest of a folded paragraph is;
  // it is the quietest thing on the screen and it never carries a label.
  more: { label: '', paint: 'meta', body: 'meta' },
  // NOT THE SAME GREY — see `kindOf`. A 429 drawn in the same neutral as
  // "compacting the conversation" is a failure hidden inside housekeeping.
  note: { label: 'NOTE', paint: 'meta', body: 'meta' },
  thought: { label: '', paint: 'meta', body: 'meta' },   // folded thinking (ui/thoughtrow.js)
  facts: { label: '', paint: 'meta', body: 'meta' },     // the fact footer (factfooter.js)
};

/** A NOTE AND AN ERROR ARE NOT THE SAME EVENT, and they were the same rows. */
function kindOf(entry) {
  const k = KIND[entry.kind] || KIND.action;
  if (entry.kind !== 'note') return k;
  if (entry.level === 'error') return { label: 'ERROR', paint: 'bad', body: 'bad' };
  if (entry.level === 'warn') return { label: 'WARN', paint: 'warn', body: 'warn' };
  return k;
}

// HOW A USER MESSAGE IS DRAWN lives in ui/feeduser.js — see its header for
// why (the god-object guard was pointing at exactly this seam).
const { userAnchor } = require('./feeduser');

function renderFeed(entries, width) {
  const { P } = require('./paint');
  const out = [];
  // Drawn-line index -> the user message on that line.
  Object.defineProperty(out, 'userAt', { value: Object.create(null), enumerable: false, writable: true });
  // Drawn-line index -> the FILE that line names.
  Object.defineProperty(out, 'fileAt', { value: Object.create(null), enumerable: false, writable: true });
  // WHERE A [Diff] CONTROL AND AN EXPANDED HUNK LANDED — ui/difftoggle.js.
  Object.defineProperty(out, 'diffAt', { value: Object.create(null), enumerable: false, writable: true });
  Object.defineProperty(out, 'hunkAt', { value: Object.create(null), enumerable: false, writable: true });
  const labels = width >= LABEL_MIN_WIDTH;
  // WHERE THE CURRENT RUN OF CALLS BEGINS. The last one is the work in hand;
  // everything before it has finished and recedes. See the action branch below.
  let lastRun = -1;
  for (let k = 0; k < entries.length; k++) {
    if (entries[k].kind !== 'action') continue;
    if (k === 0 || entries[k - 1].kind !== 'action') lastRun = k;
  }
  let last = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    // CHANGE / VERIFY / RESULT labels and an expanded diff — ui/turnsections.js.
    const special = require('./turnsections').renderSpecial(entries, i, out, width, P);
    if (special) { i = special.next; last = special.kind; continue; }
    const k = kindOf(e);
    // BROKEN ON SEVERITY TOO, not only on speaker.
    const key = e.kind === 'note' ? `note:${e.level || 'info'}` : e.kind;
    if (key !== last || (e.kind === 'user' && e.head)) {
      if (last !== null && last !== 'section') out.push('');
      // A DIVIDER AT A MAJOR BOUNDARY, AND ONLY THERE
      if (e.kind === 'user' && out.length) {
        out.push(P.meta('─'.repeat(Math.max(8, Math.min(width, DIVIDER_MAX)))));
        out.push('');
      }
      // The label carries the actor's own colour, so a glance down the left edge tells you who said what without reading a word of it.
      const text = e.kind === 'user'
        ? (P[k.paint] || P.meta)(require('./anchors').label(e.source || e.text))
        : (P[k.paint] || P.meta)(k.label);
      // A KIND WITH NO LABEL STILL GETS ITS GAP.
      if (labels && e.kind !== 'user' && k.label) out.push(text);
      last = key;
    }
    // PROSE STARTS AT THE MARGIN
    const indent = (labels || e.kind === 'user') && k.label ? '  ' : (e.kind === 'action' ? ' ' : '');

    // A TOOL ACTION IS QUOTED, NEVER PROSE
    if (e.kind === 'action') {
      let j = i;
      const rows = [];
      // WHICH OF THESE ROWS NAMES A FILE.
      const named = [];
      const diffs = [];
      // WHAT EACH ROW IS ABOUT, collected beside the text.
      const subjects = [];
      while (j < entries.length && entries[j].kind === 'action') {
        if (entries[j].text) {
          rows.push(entries[j].text);
          subjects.push(entries[j].path || entries[j].subject || '');
          if (entries[j].path) named.push({ text: entries[j].text, path: entries[j].path });
          if (entries[j].diff) diffs.push({ path: entries[j].path, subject: entries[j].subject, diff: entries[j].diff });
        }
        j += 1;
      }
      if (rows.length) {
        // FINISHED WORK RECEDES; THE CURRENT RUN DOES NOT
        const recede = i !== lastRun;
        // AND THE ROWS ARE PAINTED, WHICH THEY WERE NOT
        const isChange = (r) => /\[(?:× )?Diff\]\s*$/.test(r);
        const quiet = { ...P, meta: P.faint, path: P.faint, plain: P.faint };
        const quoted = quoteRun(
          rows.map((r, n) => (!recede ? paintMark(r, P, subjects[n] || '')
            : isChange(r) ? paintMark(r, quiet, subjects[n] || '') : P.faint(r))),
          P,
        );
        for (const row of quoted) {
          // A ROW THAT NAMES A FILE IS A ROW YOU CAN OPEN
          const hit = named.find((n) => row.includes(n.path));
          if (hit) out.fileAt[out.length] = hit.path;
          const d = /\[(?:× )?Diff\]/.test(T.strip(row)) ? diffs.find((x) => (x.path && row.includes(x.path)) || (x.subject && row.includes(x.subject))) : null;
          if (d) out.diffAt[out.length] = { ...d.diff, col: T.strip(row).lastIndexOf('[') };
          out.push(recede && !d ? P.faint(row) : row);
        }
        i = j - 1;
        continue;
      }
    }

    // WHAT THE USER SAID, ON ITS OWN GROUND
    if (e.kind === 'user') {
      let j = i;
      const run = [];
      let source = '';
      while (j < entries.length && entries[j].kind === 'user' && !(j > i && entries[j].head)) {
        if (!source && entries[j].source) source = entries[j].source;
        run.push(entries[j].text || '');
        j += 1;
      }
      userAnchor(out, source || run.join(String.fromCharCode(10)), width, P, { steer: Boolean(e.steer) });
      // A QUIET RULE BETWEEN WHAT WAS ASKED AND WHAT CAME BACK — the one other
      // major boundary in an exchange. Only when something follows it.
      if (j < entries.length && entries[j].kind !== 'user') out.push(P.meta('─'.repeat(Math.max(8, Math.min(width, DIVIDER_MAX) >> 1))));
      i = j - 1;
      continue;
    }

    // A MODEL ANSWER IS RENDERED, NOT ECHOED
    if (e.kind === 'model') {
      let j = i;
      const run = [];
      while (j < entries.length && entries[j].kind === 'model') { run.push(entries[j].text || ''); j += 1; }
      const md = require('./markdown');
      if (md.looksMarked(run.join('\n'))) {
        for (const row of md.render(run, Math.max(12, width - indent.length))) {
          out.push(row ? indent + row : '');
        }
        i = j - 1;
        continue;
      }
      // Plain prose with no markup falls through to the ordinary path, so the
      // common case pays nothing for any of this.
    }
    // COLOUR IS APPLIED AFTER WRAPPING, one row at a time.
    if (!e.text) { out.push(''); continue; }
    // A LINE'S OWN INDENTATION IS PART OF THE LINE.
    const lead = (/^[ \t]+/.exec(e.text) || [''])[0].replace(/\t/g, '  ').slice(0, 24);
    const body = e.text.slice((/^[ \t]+/.exec(e.text) || [''])[0].length);
    let first = true;
    // AN INDENTED LINE IS PREFORMATTED, AND IS NOT REFLOWED
    const md = require('./markdown');
    const room = Math.max(12, width - indent.length);
    const fits = require('./text').width(lead + body) <= room;
    const rows = fits ? [{ lead: '', text: lead + body }]
      : md.preformatted(lead + body) ? md.foldPre(lead + body, room).map((r) => ({ lead: '', text: r }))
        : V().wrap(body, Math.max(12, room - lead.length)).map((r) => ({ lead, text: r }));
    for (const row of rows) {
      out.push(indent + row.lead + paintRow(e, row.text, first, P, k));
      first = false;
    }
  }
  require('./turnsections').markRefs(out);   // `src/foo.ts:84` is clickable (§17)
  return out;
}

/** HOW MANY CONVERSATIONAL MESSAGES — what `↓ 3 new` counts. */
const SPOKEN = new Set(['user', 'model', 'external', 'mcp']);
function spokenCount(entries) {
  // A RUN OF ENTRIES IS ONE MESSAGE; a model paragraph pushed after another is its own (routine calls leave no row between them since S4).
  let n = 0;
  let last = null;
  for (const e of entries) {
    if (SPOKEN.has(e.kind) && (e.kind !== last || e.next)) n++;
    last = e.kind;
  }
  return n;
}



// FLOOD COMPACTION MOVED TO ui/compact.js — see its header for the seam.
// Re-exported under the same names so no caller had to move with it.
const { compactRuns, KEEP } = require('./compact');

module.exports = {
  pushAction, pushModel, pushUser, pushExternal, pushMcp, pushNote, pushLines,
  renderFeed, compactRuns, spokenCount, LABEL_MIN_WIDTH, KIND, KEEP,
};
