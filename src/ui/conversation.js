'use strict';

/** THE CONVERSATION — one task, replayed as it happened. */

const T = require('./text');
const { P } = require('./paint');
const { MARK, phrase } = require('./phrasing');
// THE ONE WRAPPER. Command output is evidence and may not be clipped — see the note at the transcript tail for why. `wrapIndented` rather than `wrap`…
const { wrapIndented, MAX_WRAPPED_ROWS } = require('./doc');
const {
  pushAction, pushModel, pushUser, pushExternal, pushMcp, pushNote, pushLines, renderFeed, compactRuns, spokenCount,
} = require('./feed');
// WHICH CALLS LEAVE A ROW BEHIND - policy, in its own file, because this one
// draws. See ui/durable.js.
const { keepers } = require('./durable');

const clip = T.clip;

/** HOW FAR BACK THE CONVERSATION CAN BE SCROLLED. */
const MAX_FEED_ENTRIES = 2000;
const MAX_TRANSCRIPT_LINES = 2000;
/** HOW MANY TURNS THE FEED IS BUILT FROM — the ceiling that actually bit. */
const MAX_TURNS_SHOWN = 400;

/** Two pieces of user text that are the same message, whitespace aside. */
function sameText(a, b) {
  const n = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().toLowerCase();
  const x = n(a);
  return Boolean(x) && x === n(b);
}

/** WHO ASKED FOR A TURN, AND WHY THE FEED HAS TO KNOW. */
/** Draw whatever started this turn: the person's words, or — when LAIN asked itself — the one line that says so. */
function sayInput(out, text, from, typed = false) {
  if (!String(text || '').trim()) return;
  const note = require('./phrasing').selfAskedCaption(from, typed);
  if (note) { pushNote(out, note, 'info'); return; }
  pushUser(out, text);
}

function activity({ session, current = null, width = 80, transcript = null, liveActions = [], liveNarration = [], liveNotes = [], liveThoughts = [], thoughtsOpen = false, liveUser = null, liveFrom = null, liveTyped = false, extras = [], reveal = null, openDiff = null, closedDiffs = null, shownDiffs = null, now = 0, historyTurns = 0, checkpoints = null, cwd = '' }) {
  // A PARAGRAPH OF THE TURN IN FLIGHT IS PRESENTED, NOT DUMPED — see ui/reveal.js.
  const sayText = (n) => (typeof reveal === 'function' ? reveal(n.text, n.at) : n.text);
  // RESOLVED ONCE, UP FRONT — because the cache key below has to contain the text that is about to be drawn, and computing it twice is how the key and…
  const liveTexts = liveNarration.map(sayText);
  const textOf = new Map(liveNarration.map((n, i) => [n, liveTexts[i]]));
  /** ONE PARAGRAPH OF LIVE PROSE, WITH THE BREAK BEFORE IT. */
  const say = (out, n) => {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'model' && String(prev.text || '').trim()) {
      out.push({ kind: 'model', text: '' });
    }
    pushLines(out, textOf.get(n), 'model');
  };

  const turns = (session && session.turns) || [];

  // THE PARAGRAPH THAT WAS STILL RESOLVING WHEN THE TURN ENDED
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const lastNarration = (lastTurn && Array.isArray(lastTurn.narration)) ? lastTurn.narration : [];
  const settledTexts = (reveal && lastNarration.length)
    ? lastNarration.map((n) => (n && n.at ? reveal(String(n.text || ''), n.at) : String((n && n.text) || '')))
    : [];
  // KEYED ONLY WHEN THERE IS SOMETHING TO KEY.
  const settledOf = new Map(settledTexts.length
    ? lastNarration.map((n, i) => [n, settledTexts[i]])
    : []);
  const settled = (t, n) => (t === lastTurn && settledOf.has(n)
    ? settledOf.get(n)
    : String((n && n.text) || ''));
  const plan = session && session.plan;

  // BUILT ONCE PER CHANGE, NOT ONCE PER FRAME
  const cache = require('./feedcache');
  const ck = cache.key({
    width, turns, extras, plan, liveActions, liveNotes, liveThoughts, thoughtsOpen, liveUser, liveFrom, liveTyped, transcript, current,
    liveTexts, settledTexts, objective: session && session.task && session.task.objective,
    openDiff: openDiff ? `${openDiff.turn}:${openDiff.path}` : '', historyTurns,
    // Collapsed diffs change what is drawn; so does a diff mid-arrival, frame by frame.
    closedDiffs: (closedDiffs && closedDiffs.size) || (shownDiffs && shownDiffs.size)
      ? `${[...(closedDiffs || [])].sort().join('|')}+${[...(shownDiffs || [])].sort().join('|')}` : '',
    arriving: now && require('./turnsections').arriving(liveActions, now) ? now : 0,
  });
  const hit = cache.get(ck);
  if (hit) return hit;

  const lines = [];

  // THE PLAN, when there is one.
  if (plan && plan.steps.length) {
    for (const st of plan.steps) {
      if (st.status === 'dropped') continue;
      lines.push(`  ${MARK[st.status] || MARK.todo} ${clip(st.text, width - 6)}`);
    }
    lines.push('');
  }

  // Prose and calls INTERLEAVED, in the order they happened: what LAIN said, then what it did about it.
  const said = [];

  // WHAT THE OTHER ACTORS SAID, PLACED WHERE THEY SAID IT.
  const at = (e) => (Number.isFinite(e.afterTurns) ? e.afterTurns : Number.MAX_SAFE_INTEGER);
  const pending = [...extras].sort((a, b) => at(a) - at(b));
  const flushActors = (upTo) => {
    while (pending.length && at(pending[0]) <= upTo) {
      const e = pending.shift();
      if (e.kind === 'external') pushExternal(said, e.text);
      else if (e.kind === 'mcp') pushMcp(said, e.text);
      // A NOTE IS THE PROGRAM SPEAKING, not a model.
      else pushNote(said, e.text, e.level);
    }
  };

  // THE ACTUAL SCROLLBACK CEILING, and it was SIX TURNS
  const start = Math.max(0, turns.length - MAX_TURNS_SHOWN);
  if (start > 0) {
    lines.push(P.meta(`  ⋮ ${start} earlier turn(s) not shown `
      + '— the full transcript is in the saved session'));
  }
  for (let ti = start; ti < turns.length; ti++) {
    const t = turns[ti];
    // Anything said BEFORE this turn began belongs above it.
    flushActors(ti);
    // WHAT THE USER SAID, first, because it is what everything under it is a response to.
    sayInput(said, t.userInput, t.from, t.typed);
    // THINKING, FOLDED (ui/thoughtrow.js): one line under the message; a reasoning-only answer is said as such below.
    const thoughtRow = require('./thoughtrow');
    const onlyReasoning = !String(t.text || '').trim() && !(t.actions || []).length && String(t.reasoning || '').trim() && t.stopReason !== 'aborted';
    const thinkSum = thoughtRow.sum(t.thinking) || (t.stopReason === 'aborted' && String(t.reasoning || '').trim() ? { ms: 0, chars: String(t.reasoning).length, tokens: null, interrupted: true, text: t.reasoning } : null);
    if (thinkSum && !onlyReasoning) thoughtRow.push(said, { ...thinkSum, interrupted: thinkSum.interrupted || t.stopReason === 'aborted' && !String(t.text || '').trim() }, thoughtsOpen);
    const actions = Array.isArray(t.actions) ? t.actions : [];
    // WHICH OF THEM LEAVE A ROW BEHIND.
    const kept = keepers(actions);
    const narration = Array.isArray(t.narration) ? t.narration : null;

    // WHAT THE USER SAID WHILE IT WAS WORKING —.
    const steers = Array.isArray(t.steerTexts) ? t.steerTexts : [];

    // A TURN THAT CHANGED OR CHECKED SOMETHING is drawn as CHANGE / VERIFY /
    // RESULT (ui/turnsections.js); any other turn keeps the interleaved form.
    const sectioned = narration && require('./turnsections').pushTurn(said, t, ti, {
      actions, kept, narration, steers, settled, feed: { pushUser, pushModel, pushAction },
      // A TURN FROM AN EARLIER PROCESS (a resumed session) keeps its diffs closed until asked: drawing every one of them
      // re-read every changed file on every redraw (measured: 150–200 ms and ~1,000 file reads per frame, 2026-10-02).
      ctx: { openDiff, closedDiffs, shownDiffs, checkpoints, cwd: cwd || (session && session.cwd) || '', history: ti < historyTurns },
    });
    if (sectioned) { /* drawn */ } else if (narration) {
      const steps = [...new Set([
        ...narration.map((n) => n.step),
        ...actions.map((a) => a.step),
        ...steers.map((s) => s.step),
      ])].sort((x, y) => x - y);
      // WHICH PARAGRAPH WAS THE LAST THING THIS TURN SAID.
      const lastSaid = narration.length ? narration[narration.length - 1] : null;
      for (const st of steps) {
        // BEFORE the step's own output, because that is the order it happened
        // in: the model was handed the correction, and then did what follows.
        for (const s of steers.filter((x) => x.step === st)) pushUser(said, s.text, { steer: true });
        for (const n of narration.filter((x) => x.step === st)) {
          pushModel(said, settled(t, n), { last: n === lastSaid });
        }
        for (const a of actions.filter((x) => x.step === st && kept.has(x))) pushAction(said, a);
      }
      // Calls from a turn recorded before steps were tracked.
      for (const a of actions.filter((x) => x.step === undefined && kept.has(x))) pushAction(said, a);
    } else {
      for (const s of steers) pushUser(said, s.text, { steer: true });
      // ONE CALL, so a turn recorded before narration existed is laid out by the same rule as every other message.
      pushModel(said, t.text);
      if (actions.length) for (const a of actions.filter((x) => kept.has(x))) pushAction(said, a);
      // A TURN RECORDED BEFORE ACTIONS EXISTED has only names, and a name cannot say whether the call succeeded — so there is nothing to classify and they…
      else for (const n of t.toolNames || []) said.push({ kind: 'action', text: `${MARK.done} ${phrase(n, '')}` });
    }
    // WHAT IT THOUGHT, WHEN IT SAID NOTHING AT ALL
    const lain = said.some((e) => e.kind === 'model' || e.kind === 'action');
    if (!lain && onlyReasoning) thoughtRow.reasoningOnly(said, t.reasoning);
    // A failed CALL is already in the feed, in order, as `✗ Read a.js` with its reason.
    for (const e of (t.errors || []).slice(0, 2)) {
      if (e.kind === 'TOOL') continue;
      // NOT AS AN ACTION. It was pushed with the same ✗ a failed tool call wears, so it landed directly beneath the call that had just SUCCEEDED and read as…
      const f = require('./status').failureRow(e);
      // A FAILURE FROM A TURN THAT ENDED IN AN EARLIER PROCESS is history, not
      // an alarm (§48, §80): kept in the transcript, never drawn in red again.
      if (ti < historyTurns) pushNote(said, `earlier · ${f.word} — ${f.detail}`, 'info');
      else pushNote(said, `${f.word} — ${f.detail}`, 'error');
    }
    // A SUCCESS CLAIM THE EVIDENCE CONTRADICTED belongs to THIS turn (app.js stores it on the record).
    if (t.contradiction) pushNote(said, t.contradiction, 'warn');
    require('../factfooter').push(said, t.facts);   // the fact footer (S4)
  }

  // Everything said after the last recorded turn — including a review that has
  // just come back and is the reason the next turn is about to happen.
  flushActors(Number.MAX_SAFE_INTEGER);

  // The message being worked on RIGHT NOW, which has no turn record yet.
  sayInput(said, liveUser, liveFrom, liveTyped);

  // WHICH LIVE CALLS LEAVE A ROW.
  const liveKept = keepers(liveActions);
  const sectionsOf = require('./turnsections');
  const lastEditOf = new Map();
  liveActions.forEach((a, k) => { if (sectionsOf.isChange(a)) lastEditOf.set(String(a.path || a.target), k); });
  const liveCtx = { openDiff, closedDiffs, shownDiffs, now, checkpoints, cwd: cwd || (session && session.cwd) || '' };
  // ONLY THE MOST RECENTLY EDITED FILES show their diff unasked — ui/turnsections.js MAX_AUTO_FILES.
  const recentFiles = new Set([...lastEditOf.entries()].sort((x, y) => y[1] - x[1]).slice(0, sectionsOf.MAX_AUTO_FILES).map(([k]) => k));

  // THE TURN IN FLIGHT. `session.turns` only gains an entry when a turn ENDS, so without this the feed was empty for the entire time the work was…
  const thoughtRow = require('./thoughtrow');
  for (let i = 0; i < liveActions.length; i++) {
    for (const x of liveThoughts.filter((y) => y.after === i)) thoughtRow.push(said, x, thoughtsOpen);
    for (const n of liveNarration.filter((x) => x.after === i)) say(said, n);
    for (const n of liveNotes.filter((x) => x.after === i)) { if (n.steer) pushUser(said, n.text, { steer: true }); else pushNote(said, n.text, n.level); }
    // THE SAME RULE WHILE IT IS STILL HAPPENING
    const a = liveActions[i];
    if (!liveKept.has(a)) continue;
    if (sectionsOf.isChange(a) && lastEditOf.get(String(a.path || a.target)) === i) sectionsOf.pushLiveChange(said, a, turns.length, liveCtx, pushAction, recentFiles.has(String(a.path || a.target)));
    else pushAction(said, a);
  }
  for (const x of liveThoughts.filter((y) => y.after >= liveActions.length)) thoughtRow.push(said, x, thoughtsOpen);
  for (const n of liveNarration.filter((x) => x.after >= liveActions.length)) say(said, n);
  for (const n of liveNotes.filter((x) => x.after >= liveActions.length)) { if (n.steer) pushUser(said, n.text, { steer: true }); else pushNote(said, n.text, n.level); }

  if (said.length) {
    // NO `CONTEXT` HEADING HERE.
    const feed = compactRuns(said);
    const shown = feed.length > MAX_FEED_ENTRIES ? feed.slice(-MAX_FEED_ENTRIES) : feed;
    // A CAP THAT IS HIT SAYS SO.
    if (shown.length < feed.length) {
      lines.push(P.meta(`  ⋮ ${feed.length - shown.length} earlier entries not shown `
        + '— the full transcript is in the saved session'));
    }
    // WHERE EACH USER MESSAGE LANDED, carried through to the Screen so a click in the feed can put that message back on the input line.
    const feedLines = renderFeed(shown, width);
    const base = lines.length;
    if (feedLines.userAt) {
      if (!lines.userAt) {
        Object.defineProperty(lines, 'userAt', { value: Object.create(null), enumerable: false, writable: true });
      }
      for (const k of Object.keys(feedLines.userAt)) lines.userAt[base + Number(k)] = feedLines.userAt[k];
    }
    // AND WHERE EACH FILE-NAMING ACTION ROW LANDED, rebased the same way, so a
    // click on `Read src/loader.js` can open src/loader.js. See ui/mouse.js.
    if (feedLines.fileAt) {
      if (!lines.fileAt) {
        Object.defineProperty(lines, 'fileAt', { value: Object.create(null), enumerable: false, writable: true });
      }
      for (const k of Object.keys(feedLines.fileAt)) lines.fileAt[base + Number(k)] = feedLines.fileAt[k];
    }
    // AND WHERE EACH [Diff] CONTROL AND EACH HUNK LANDED — ui/difftoggle.js.
    for (const key of ['diffAt', 'hunkAt']) {
      if (!feedLines[key]) continue;
      if (!lines[key]) Object.defineProperty(lines, key, { value: Object.create(null), enumerable: false, writable: true });
      for (const k of Object.keys(feedLines[key])) lines[key][base + Number(k)] = feedLines[key][k];
    }
    for (const l of feedLines) lines.push(l);
  }

  // HOW MANY MESSAGES THIS FEED CONTAINS, carried on the result.
  lines.spoken = spokenCount(said);

  // THE LIVE ROW IS NOT HERE.

  for (const step of (current && current.steps) || []) {
    const m = step.done ? MARK.done : step.active ? MARK.active : MARK.todo;
    lines.push(`  ${m} ${clip(step.label, width - 6)}`);
  }

  // What commands printed.
  if (transcript && transcript.length) {
    if (said.length) lines.push('');
    // Same reasoning as the feed above: this was 40 lines, so the output of a
    // command that printed more than that could not be scrolled back to.
    const tail = transcript.length > MAX_TRANSCRIPT_LINES
      ? transcript.slice(-MAX_TRANSCRIPT_LINES) : transcript;
    if (tail.length < transcript.length) {
      lines.push(P.meta(`  ⋮ ${transcript.length - tail.length} earlier output lines not shown`));
    }
    // WRAPPED, NOT CLIPPED
    for (const l of tail) {
      const parts = wrapIndented(String(l == null ? '' : l), Math.max(12, width));
      if (parts.length <= MAX_WRAPPED_ROWS) { for (const p of parts) lines.push(p); continue; }
      for (const p of parts.slice(0, MAX_WRAPPED_ROWS)) lines.push(p);
      lines.push(P.meta(`  ⋮ ${parts.length - MAX_WRAPPED_ROWS} more wrapped row(s) of this line`));
    }
  }
  // REMEMBERED, AND A COPY HANDED BACK.
  return cache.put(ck, lines);
}

module.exports = {
  activity, sameText, MAX_FEED_ENTRIES, MAX_TRANSCRIPT_LINES, MAX_TURNS_SHOWN,
};