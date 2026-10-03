'use strict';

/** TOO MANY MESSAGES — the one refusal that has a fix, and how far to apply it. */

/** A margin under the provider's stated cap, for the messages this step is about to add — the assistant turn and its tool results. */
const MARGIN = 8;
/** Never fold below this, whatever the arithmetic says. */
const FLOOR = 8;
/** How much to keep when we have to pick a size ourselves — see `capFor`. */
const SELF_FRACTION = 0.6;

/** HOW FAR TO FOLD, WHEN THE TWO COUNTS DISAGREE. */
function capFor(own, stated) {
  const held = Math.max(0, Number(own) || 0);
  const said = Math.max(0, Number(stated) || 0);
  let cap = said ? Math.max(FLOOR, said - MARGIN) : Math.floor(held / 2);
  if (cap >= held) cap = Math.max(FLOOR, Math.floor(held * SELF_FRACTION));
  return cap;
}

/** What to say once a fold has actually removed something. */
function foldedMessage(fold, stated, cap) {
  return `The provider refused ${fold.beforeMessages} messages (its limit is `
    + `${stated || cap}). ${fold.folded} of the oldest were folded into one summary — `
    + `${fold.afterMessages} are being sent now. Their text is still in the session and `
    + 'on screen; it is no longer in the request.';
}

/** What to say when nothing could be folded. */
function stuckMessage(remaining) {
  return `nothing could be folded — ${remaining} messages, and all of them are either `
    + 'the objective or the step in flight. /compact, or switch provider.';
}

/** AND WHAT THE FOLDED MESSAGES WERE */
/** How much of each folded USER message is reproduced verbatim. */
const FOLD_USER_KEEP = 400;
/** How many folded instructions one summary lists, newest first. */
const FOLD_SAID_KEEP = 60;
/** WHAT THE FOLDED MESSAGES WERE, built from what they ARE rather than from prose a model invents about them. */
function foldSummary(gone) {
  const said = [];
  const calls = new Map();
  let stood = 0;
  for (const m of gone) {
    if (!m) continue;
    // A PRIOR FOLD IS MERGED, NEVER SUMMARISED AGAIN
    if (m.elided === 'folded') {
      stood += Math.max(1, Number(m.foldedCount) || 1);
      for (const t of m.said || []) said.push(String(t));
      for (const [n, c] of Object.entries(m.calls || {})) calls.set(n, (calls.get(n) || 0) + (Number(c) || 0));
      continue;
    }
    stood += 1;
    if (m.role === 'user' && String(m.content || '').trim()) {
      said.push(String(m.content).replace(/\s+/g, ' ').trim().slice(0, FOLD_USER_KEEP));
    }
    for (const tc of m.tool_calls || []) {
      const n = String((tc && tc.name) || 'tool');
      calls.set(n, (calls.get(n) || 0) + 1);
    }
  }
  // BOUNDED, AND HONEST ABOUT IT
  let dropped = 0;
  if (said.length > FOLD_SAID_KEEP) {
    dropped = said.length - FOLD_SAID_KEEP;
    said.splice(0, dropped);
  }
  const tools = [...calls.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n}×${c}`)
    .join(', ');
  const head = `[${stood} earlier messages folded to fit this provider's message limit. `
    + 'Their full text is still in the session and on screen — it is no longer being sent.]';
  const parts = [head];
  if (said.length) {
    const lead = dropped
      ? `What you asked for, in order (the ${dropped} oldest are no longer listed here):`
      : 'What you asked for, in order:';
    parts.push(lead + '\n' + said.map((s) => `  · ${s}`).join('\n'));
  }
  if (tools) parts.push(`Tool calls made in that stretch: ${tools}. Re-run any of them if you need the output.`);
  // THE PARTS TRAVEL WITH THE TEXT, so the next fold merges instead of parsing.
  return {
    content: parts.join('\n'),
    said,
    calls: Object.fromEntries(calls),
    foldedCount: stood,
  };
}

/** The characters one message costs — the one measure `Session.contextChars` sums. */
function messageChars(m) {
  let n = String((m && m.content) || '').length + 24;   // + envelope
  for (const tc of (m && m.tool_calls) || []) n += String(tc.arguments || '').length + String(tc.name || '').length + 40;
  return n;
}

/** An old call's arguments larger than this are elided. */
const ARGS_STUB_MIN = 400;
const ARG_FIELD_KEEP = 160;
/** A character-driven fold aims this far under the budget, so it does not re-fire next step. */
const FOLD_CHAR_TARGET = 0.7;

/** THE HALF OF A CALL THAT COMPACTION NEVER SHRANK: ITS ARGUMENTS. */
function elideArguments(m) {
  let removed = 0;
  for (const tc of (m && m.tool_calls) || []) {
    if (!tc || tc.argsElided) continue;
    const raw = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {});
    if (raw.length <= ARGS_STUB_MIN) continue;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const kept = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (v == null || typeof v === 'number' || typeof v === 'boolean') kept[k] = v;
        else if (typeof v === 'string' && v.length <= ARG_FIELD_KEEP) kept[k] = v;
        else kept[k] = `[elided ${typeof v === 'string' ? v.length : JSON.stringify(v).length} chars]`;
      }
    } else {
      kept._elided = `${raw.length} chars of arguments`;
    }
    const next = JSON.stringify(kept);
    if (next.length >= raw.length) continue;
    tc.arguments = next;
    tc.argsElided = raw.length;
    removed += raw.length - next.length;
  }
  return removed;
}

/** WHERE TO CUT so a fold of `messages[1 .. */
function charCut(messages, targetChars, floor) {
  let total = 0;
  for (const m of messages) total += messageChars(m);
  if (total <= targetChars || floor <= 2) return 1;
  let cut = 1;
  let removed = 0;
  while (cut < floor && total - removed > targetChars) { removed += messageChars(messages[cut]); cut += 1; }
  for (;;) {
    const summary = foldSummary(messages.slice(1, cut)).content.length + 24;
    if (total - removed + summary <= targetChars || cut >= floor) break;
    removed += messageChars(messages[cut]);
    cut += 1;
  }
  return cut;
}

module.exports = {
  capFor, foldedMessage, stuckMessage, foldSummary, messageChars, elideArguments, charCut,
  MARGIN, FLOOR, SELF_FRACTION, FOLD_USER_KEEP, FOLD_SAID_KEEP, ARGS_STUB_MIN, ARG_FIELD_KEEP, FOLD_CHAR_TARGET,
};
