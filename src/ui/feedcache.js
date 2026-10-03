'use strict';

/** THE CONVERSATION, BUILT ONCE PER CHANGE INSTEAD OF ONCE PER FRAME. */

/** The one remembered render: its key, and the lines it produced. */
let slot = { key: '', lines: null };

/** A STABLE NAME FOR AN ARRAY, so "a different list of turns" is detectable. */
const ids = new WeakMap();
let nextId = 1;
function idOf(arr) {
  if (!arr || typeof arr !== 'object') return 0;
  if (!ids.has(arr)) ids.set(arr, nextId++);
  return ids.get(arr);
}

/** A cheap, complete description of what the feed would be built from. */
function key(o) {
  const parts = [o.width, idOf(o.turns), (o.turns || []).length];
  for (const t of o.turns || []) {
    parts.push(
      (t.userInput || '').length,
      (t.text || '').length,
      (t.reasoning || '').length,
      (t.actions || []).length,
      (t.narration || []).length,
      (t.steerTexts || []).length,
      (t.errors || []).length,
      // Set just AFTER the turn is recorded (app.js), so it must move the key.
      (t.contradiction || '').length,
      t.facts ? 1 : 0,
      (t.thinking || []).length,   // the fact footer is set just after the turn is recorded, too
    );
  }
  const extras = o.extras || [];
  parts.push('x', extras.length);
  for (const e of extras) parts.push(e.kind, (e.text || '').length, e.afterTurns);
  const plan = o.plan;
  parts.push('p', plan ? plan.steps.map((s) => s.status).join('') : '');
  parts.push('t', o.objective ? String(o.objective).length : 0);
  parts.push('a', (o.liveActions || []).length);
  for (const a of o.liveActions || []) parts.push(a.name, a.ok ? 1 : 0, (a.note || '').length, (a.output || '').length, a.added || 0, a.removed || 0);
  // THE LIVE PROSE GOES IN WHOLE, not as a length: it is the one input that changes without changing size, because a paragraph resolving on screen…
  parts.push('n', (o.liveTexts || []).length);
  for (const t of o.liveTexts || []) parts.push(t);
  // AND THE LAST TURN'S PROSE, for exactly the same reason.
  parts.push('s', (o.settledTexts || []).length);
  for (const t of o.settledTexts || []) parts.push(t);
  parts.push('o', (o.liveNotes || []).length);
  parts.push('th', (o.liveThoughts || []).map((t) => `${t.ms}:${t.tokens}`).join('|'), o.thoughtsOpen ? 1 : 0);
  parts.push('u', o.liveUser ? String(o.liveUser).length : 0);
  parts.push('r', (o.transcript || []).length, (o.transcript || []).length ? String(o.transcript[o.transcript.length - 1]).length : 0);
  parts.push('c', ((o.current && o.current.steps) || []).map((s) => `${s.label}${s.done ? 1 : 0}${s.active ? 1 : 0}`).join('|'));
  // WHICH DIFF IS OPEN, and where history ends — both change what is drawn.
  parts.push('d', o.openDiff || '', 'h', o.historyTurns || 0);
  // Which diffs are collapsed, and — only while an edit is arriving — the frame's time.
  parts.push('x', o.closedDiffs || '', 'a', o.arriving || 0);
  return parts.join(',');
}

/** A COPY of the cached lines, with the two side-channels the pane needs. */
function copyOf(lines) {
  const out = lines.slice();
  out.spoken = lines.spoken;
  if (lines.userAt) {
    Object.defineProperty(out, 'userAt', { value: lines.userAt, enumerable: false, writable: true });
  }
  // AND `fileAt`, the third channel.
  if (lines.fileAt) {
    Object.defineProperty(out, 'fileAt', { value: lines.fileAt, enumerable: false, writable: true });
  }
  for (const key of ['diffAt', 'hunkAt']) {
    if (lines[key]) Object.defineProperty(out, key, { value: lines[key], enumerable: false, writable: true });
  }
  return out;
}

/** The remembered render for this key, or null. */
function get(k) {
  return slot.key && slot.key === k && slot.lines ? copyOf(slot.lines) : null;
}

/** Remember this render, and hand back a copy of it. */
function put(k, lines) {
  slot = { key: k, lines };
  return copyOf(lines);
}

/** Forget it. Nothing depends on this — it is here for the tests. */
function reset() { slot = { key: '', lines: null }; }

module.exports = { key, get, put, reset, copyOf, idOf };
