'use strict';

/**
 * A FINISHED TURN, AS WHAT IT DID (§4, §15–16, §85).
 *
 *     USER · fix retry ownership
 *     ────
 *     Tracing scheduler → queue ownership.      (narration, condensed)
 *
 *     CHANGE
 *     │ ✓ scheduler.ts   +18 -7   [Diff]
 *     VERIFY
 *     │ ✓ npm test -- retry
 *     RESULT
 *     Retry scheduling now has one owner.
 *
 * Only for a turn that CHANGED or CHECKED something; a conversational turn is
 * drawn exactly as before. Reads are never listed here — the activity box and
 * the timeline showed them while they happened.
 *
 * THE DIFF IS PART OF THE TRANSCRIPT, SHOWN WITHOUT BEING ASKED FOR. A change
 * row carries the file's real hunks directly under it — live, through VERIFY,
 * and after DONE — and scrolls up with everything else. Nobody has to click to
 * find out that something changed. A large diff shows its first AUTO_LINES and
 * a `… N more lines [Show all]` row; the row's own control collapses and
 * reopens it (ui/difftoggle.js). Clicking is for inspection, never discovery.
 *
 * ARRIVAL IS NOT LIFETIME. The newest live edit's diff OPENS as grey space and
 * its rows arrive top-down over ARRIVE_MS — a pure function of the time since
 * the edit landed, computed at draw time, so nothing waits on it — and then it
 * is simply the diff, for good.
 */

const EDIT = new Set(['write_file', 'edit_file', 'apply_patch', 'append_file', 'insert_at', 'delete_range', 'move_file', 'delete_file',
  'replace_symbol', 'insert_near_symbol', 'remove_symbol', 'rename_symbol', 'download_file']);
const CHECK = /^(?:run_bash|run_powershell|run_cmd|run_tests|python_run|process_run|verify_task|service_check|observe_stop|request_browser|request_computer|ab_compare|delegate)$/;
/** Shown by default; past this a diff offers the rest behind [Show all]. */
const AUTO_LINES = 16;
/** Shown when expanded. */
const FULL_LINES = 400;
/** The grey space opens first, then the rows arrive within ARRIVE_MS. */
const OPEN_MS = 120;
const ARRIVE_MS = 600;

const keyOf = (turn, path) => `${turn}:${path}`;
/**
 * HOW MANY FILES SHOW THEIR DIFF WITHOUT BEING ASKED — the most recent ones.
 * A turn that touched thirty files must not print thirty diffs: the older rows
 * stay one line each (so a long run still folds to `✓ edited ×N`), and each
 * one's control opens it.
 */
const MAX_AUTO_FILES = 3;

/** Shown or not: the person's own choice first, then whether it is one of the recent files. */
function isShown(ctx, turn, path, auto) {
  const k = keyOf(turn, path);
  if (ctx.closedDiffs && ctx.closedDiffs.has(k)) return false;
  if (ctx.shownDiffs && ctx.shownDiffs.has(k)) return true;
  return Boolean(auto);
}

/** How many of `n` rows have arrived `now`, for an edit that landed at `landedAt`. Pure. */
function arrived(n, landedAt, now) {
  if (!landedAt || !now) return n;
  const e = now - landedAt;
  if (e < OPEN_MS) return 0;
  return Math.min(n, Math.ceil(((e - OPEN_MS) / ARRIVE_MS) * n));
}

/** Is any of these live edits still arriving? The ticker runs fast while it is. */
function arriving(actions, now = Date.now()) {
  return (actions || []).some((a) => a && a.landedAt && now - a.landedAt < OPEN_MS + ARRIVE_MS + 40);
}

/** The inline diff of one file, bounded, arriving if it just landed — or nothing when collapsed. */
function pushDiff(said, ctx, turn, path, landedAt = 0, auto = true) {
  if (!isShown(ctx, turn, path, auto)) return;
  const all = diffLines(ctx, path, FULL_LINES);
  const full = Boolean(ctx.openDiff && ctx.openDiff.turn === turn && ctx.openDiff.path === path);
  // NOTHING CAPTURED TO COMPARE AGAINST (no checkpoint, or the file was put
  // back): the summary row already says what happened. The explanatory note is
  // an answer to someone who asked to see more, not something to add unasked.
  if (!full && all.length === 1 && /^\s*\(no difference/.test(all[0])) return;
  const body = all.slice(0, full ? FULL_LINES : AUTO_LINES);
  const got = arrived(body.length, landedAt, ctx.now);
  // `full` travels beside the visible `text`: a side-by-side layout pairs rows
  // before they have all arrived (panes.diffSplit).
  body.forEach((l, i) => said.push({ kind: 'diff', text: i < got ? l : '', full: l, diffOf: { turn, path } }));
  const rest = all.length - body.length;
  if (rest > 0 && got >= body.length) {
    said.push({ kind: 'diffmore', text: `… ${rest} more line${rest === 1 ? '' : 's'}   [Show all]`, diff: { turn, path, full: true } });
  }
}

/** The control a change row carries: collapse while shown, open while collapsed. */
function control(ctx, turn, path, auto = true) {
  return isShown(ctx, turn, path, auto) ? '[× Diff]' : '[Diff]';
}

/** Split a turn's calls into changes (per file), checks, and other kept rows. */
function sections(actions, kept) {
  const changes = new Map();
  const checks = [];
  const other = [];
  for (const a of actions || []) {
    if (isChange(a)) {
      const key = String(a.path || a.target || '');
      const c = changes.get(key) || { path: key, added: 0, removed: 0, ok: true };
      c.added += Number(a.added) || 0;
      c.removed += Number(a.removed) || 0;
      changes.set(key, c);
      continue;
    }
    // A refused check never ran, so it is not VERIFY evidence; it stays visible as an ordinary row.
    if (CHECK.test(a.name) && kept.has(a) && !a.denied) { checks.push(a); continue; }
    if (kept.has(a)) other.push(a);
  }
  return { changes: [...changes.values()], checks, other };
}

function pushChange(out, c, { turn, ctx, auto }) {
  const counts = c.added || c.removed ? `   +${c.added} -${c.removed}` : '';
  out.push({
    kind: 'action',
    // ui/rowpaint.js paints +N green and -N red on this row too.
    text: `✓ ${c.path}${counts}   ${control(ctx, turn, c.path, auto)}`,
    subject: c.path,
    path: c.path,
    verb: 'edited',
    diff: { turn, path: c.path, shown: isShown(ctx, turn, c.path, auto) },
  });
}

/**
 * THE CHANGE SECTION — one row per file with its diff under it, for a finished
 * turn. Keyed by the same turn index as the live row, so a diff collapsed or
 * expanded while the work runs keeps that state when it settles. Its lifetime
 * is the turn's, never an animation's or the counters'.
 */
function pushChanges(said, changes, ti, ctx) {
  if (!changes.length) return;
  said.push({ kind: 'section', text: 'CHANGE' });
  changes.forEach((c, i) => {
    const auto = !ctx.history && i >= changes.length - MAX_AUTO_FILES;
    pushChange(said, c, { turn: ti, ctx, auto });
    pushDiff(said, ctx, ti, c.path, 0, auto);
  });
}

/**
 * A LIVE EDIT ROW, IN PLACE, WITH ITS DIFF UNDER IT. The turn in flight keeps
 * its interleaved account (prose, the call it led to, the next prose); the row
 * carries the same control the settled CHANGE row has, keyed identically
 * ({turn, path}). The diff ARRIVES here, in the place it then stays.
 */
function pushLiveChange(said, a, turn, ctx, pushAction, auto = true) {
  const key = String(a.path || a.target);
  const at = said.length;
  pushAction(said, a);
  said[at] = { ...said[at], text: `${said[at].text}   ${control(ctx, turn, key, auto)}`, diff: { turn, path: key, shown: isShown(ctx, turn, key, auto) } };
  pushDiff(said, ctx, turn, key, a.landedAt || 0, auto);
}

/** True for a call that folds into the CHANGE section instead of leaving its own row. */
function isChange(a) {
  return Boolean(a && a.ok && (EDIT.has(a.name) || Number(a.added) > 0 || Number(a.removed) > 0) && (a.path || a.target));
}

/** The real hunks of one file, against the bytes before this session first wrote it. */
function diffLines(ctx, rel, max = FULL_LINES) {
  const panes = require('./panes');
  const path = require('path');
  let files = [];
  try { files = panes.changedFiles({ checkpoints: ctx.checkpoints, cwd: ctx.cwd }); } catch { files = []; }
  const want = String(rel || '').replace(/\\/g, '/');
  const f = files.find((x) => x.rel.replace(/\\/g, '/') === want || path.resolve(ctx.cwd || '.', want) === x.path);
  if (!f) return ['  (no difference against the captured original — it may have been reverted)'];
  return panes.unified(f.before, f.after, max);
}

/**
 * Push one finished turn in sectioned form. Returns false when the turn has
 * nothing to section, so the caller draws it the ordinary way.
 */
function pushTurn(said, t, ti, { actions, kept, narration, steers, settled, feed, ctx }) {
  const sec = sections(actions, kept);
  if (!sec.changes.length && !sec.checks.length) return false;
  const lastSaid = narration.length ? narration[narration.length - 1] : null;
  const steps = [...new Set([...narration.map((n) => n.step), ...actions.map((a) => a.step), ...steers.map((s) => s.step)])].sort((x, y) => x - y);
  // A RESTATEMENT IS DRAWN ONCE. Live, 2026-09-18: "The cart line total bug is
  // fixed…" opened three step narrations and then the RESULT — four copies of
  // one finding. A narration whose opening sentence was already said in this
  // turn (or opens the RESULT) is not drawn again; it stays in the record.
  const seen = new Set();
  const opening = (n) => String(settled(t, n) || '').trim().split(/(?<=[.!?])\s|\s[-—]\s|\n/)[0].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (lastSaid) seen.add(opening(lastSaid));
  for (const st of steps) {
    for (const s of steers.filter((x) => x.step === st)) feed.pushUser(said, s.text);
    for (const n of narration.filter((x) => x.step === st && x !== lastSaid)) {
      const key = opening(n);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      feed.pushModel(said, settled(t, n), { last: false });
    }
    for (const a of sec.other.filter((x) => x.step === st)) feed.pushAction(said, a);
  }
  pushChanges(said, sec.changes, ti, ctx);
  if (sec.checks.length) {
    said.push({ kind: 'section', text: 'VERIFY' });
    for (const a of sec.checks) feed.pushAction(said, a);
  }
  if (lastSaid && String(settled(t, lastSaid) || '').trim()) {
    said.push({ kind: 'section', text: 'RESULT' });
    feed.pushModel(said, settled(t, lastSaid), { last: true });
  }
  return true;
}

/**
 * Draw a `section` label or a run of `diff` rows into the rendered feed.
 * Returns `{ next, kind }` when entry `i` was one of those, else null.
 */
function renderSpecial(entries, i, out, width, P) {
  const e = entries[i];
  if (e.kind === 'diffmore') {
    const T = require('./text');
    const row = '  ' + P.meta(T.clip(e.text, Math.max(16, width - 2)));
    out.diffAt[out.length] = { ...e.diff, col: T.strip(row).lastIndexOf('[') };
    out.push(row);
    return { next: i, kind: 'diffmore' };
  }
  if (e.kind === 'section') {
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push(P.head(e.text));
    return { next: i, kind: 'section' };
  }
  if (e.kind !== 'diff') return null;
  out.hunkAt[out.length] = e.diffOf;
  const panes = require('./panes');
  let j = i;
  while (j < entries.length && entries[j].kind === 'diff') j += 1;
  const block = entries.slice(i, j);
  // WIDE: side by side (old | new). Otherwise unified. Same hunks either way.
  if (width >= panes.SPLIT_MIN) {
    const lines = block.map((b) => String(b.full != null ? b.full : b.text || ''));
    const visible = block.map((b) => Boolean(b.text) || b.full == null);
    for (const row of panes.diffSplit(lines, width - 3, visible)) out.push('   ' + row);
  } else {
    for (const b of block) out.push(' ' + panes.diffRow(String(b.text || ''), Math.max(16, width - 1), P));
  }
  return { next: j - 1, kind: 'diff' };
}

/** `src/foo.ts:84` on any drawn row is a reference a click opens at that line (§17). */
const REF_RE = /(?:^|[\s(`'"[])((?:[A-Za-z]:)?(?:[\w.@-]+[\\/])*[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,5}):(\d{1,6})\b/;
function markRefs(out) {
  const T = require('./text');
  for (let r = 0; r < out.length; r++) {
    if (out.fileAt[r] || (out.diffAt && out.diffAt[r])) continue;
    const m = REF_RE.exec(T.strip(String(out[r] || '')));
    if (m) out.fileAt[r] = `${m[1]}:${m[2]}`;
  }
}

module.exports = {
  sections, pushTurn, pushChanges, pushLiveChange, isChange, diffLines, renderSpecial, markRefs, arrived, arriving,
  REF_RE, EDIT, CHECK, AUTO_LINES, OPEN_MS, ARRIVE_MS, MAX_AUTO_FILES,
};
