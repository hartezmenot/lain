'use strict';

/**
 * EDIT THE LATEST MESSAGE, OR RETRY IT — a new branch, never a rewritten history (2026-10-02).
 *
 *   the latest user message of a thread (Chat or Coding) and everything after it in THAT thread
 *     → moved to a kept branch record (workbench.branches: the old wording, its replies, its turn records)
 *     → the new wording is submitted as an ordinary turn
 *
 * WHAT IS NOT PRETENDED:
 *   · the old request's turn records leave the live history with it — no record of the new branch claims work the
 *     old request asked for (its task and contract are cleared when the old wording started them);
 *   · files the replaced turns CHANGED are not silently left or silently reverted: in the Coding lane the person
 *     chooses — undo them first (LAIN's checkpoints, refused if a file changed since) or keep them;
 *   · the other thread's messages are untouched, and nothing older than the latest message is editable here.
 */

const MAX_BRANCHES = 10;

function threadOf(m) { try { return require('./sessionviews').threadOf(m); } catch { return m && m.thread ? m.thread : 'coding'; } }

/** The latest user message of `view`'s thread, and what came after it there. */
function plan(app, view = 'chat') {
  const s = app.session;
  const msgs = s.messages || [];
  let at = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'user' && threadOf(m) === view && String(m.content || '').trim()) { at = i; break; }
  }
  if (at < 0) return { ok: false, why: 'there is no message to edit' };
  const text = String(msgs[at].content || '');
  const turns = s.turns || [];
  let firstTurn = -1;
  for (let i = turns.length - 1; i >= 0; i--) { if (String(turns[i].userInput || '').trim() === text.trim()) { firstTurn = i; break; } }
  const replaced = firstTurn >= 0 ? turns.slice(firstTurn).filter((t) => !t.lane || t.lane === view || view === 'coding') : [];
  const turnIds = new Set(replaced.map((t) => t.turnId).filter(Boolean));
  const entries = (app.checkpoints && app.checkpoints.entries) || [];
  const files = [];
  for (const e of entries) if (turnIds.has(e.turnId)) for (const f of e.files) if (!files.includes(f.path)) files.push(f.path);
  return { ok: true, index: at, text, firstTurn, turnIds: [...turnIds], files };
}

/**
 * MAKE THE BRANCH. `files`: 'undo' | 'keep' (Coding: required when the replaced turns changed files).
 * @returns {{ok:true, replaced, undone:[], kept:[]}|{ok:false, why, needsChoice?, files?}}
 */
function branch(app, { view = 'chat', files = null } = {}) {
  const s = app.session;
  if (app.abort && !app.abort.signal.aborted) return { ok: false, why: 'a turn is running — stop it, or edit when it ends' };
  const p = plan(app, view);
  if (!p.ok) return p;
  const rel = (f) => { try { return require('path').relative(s.cwd || '', f) || f; } catch { return f; } };
  if (p.files.length && !files) return { ok: false, needsChoice: true, files: p.files.map(rel), why: `The earlier request changed ${p.files.length} file${p.files.length === 1 ? '' : 's'}` };
  const undone = [];
  if (files === 'undo' && p.files.length) {
    const ids = new Set(p.turnIds);
    for (;;) {
      const last = app.checkpoints.entries[app.checkpoints.entries.length - 1];
      if (!last || !ids.has(last.turnId)) break;
      const r = app.checkpoints.undo();
      if (!r.ok) return { ok: false, why: r.error || 'the changes could not be undone', stale: Boolean(r.stale) };
      for (const x of r.restored || []) undone.push(rel(x.path));
    }
  }
  // THE OLD BRANCH IS KEPT, OUT OF THE LIVE HISTORY: its wording, its replies (this thread only), its turn records.
  const msgs = s.messages || [];
  const moved = [];
  const keep = [];
  msgs.forEach((m, i) => { if (i >= p.index && threadOf(m) === view) moved.push(m); else keep.push(m); });
  s.messages = keep;
  const movedTurns = p.firstTurn >= 0 ? (s.turns || []).splice(p.firstTurn) : [];
  const w = require('./workbench').of(s);
  if (!Array.isArray(w.branches)) w.branches = [];
  w.branches.push({ at: Date.now(), view, replaced: p.text.slice(0, 4000), messages: moved.slice(0, 200), turns: movedTurns.map((t) => ({ turnId: t.turnId, userInput: String(t.userInput || '').slice(0, 2000), stopReason: t.stopReason || null, model: t.model || null, toolCalls: t.toolCalls || 0 })), files: files || null, undone });
  if (w.branches.length > MAX_BRANCHES) w.branches.splice(0, w.branches.length - MAX_BRANCHES);
  // A TASK THE OLD WORDING STARTED is not the new request's: its contract (asks, criteria) goes with the old branch.
  if (s.task && String(s.task.objective || '').trim() === p.text.trim()) { s.task = null; s.lifecycle = null; }
  try { require('./turnguard').end(app, { stopReason: 'aborted' }); } catch { /* a recovery briefing is never owed to a branch */ }
  try { s.save(); } catch { /* in memory */ }
  return { ok: true, replaced: p.text, undone, kept: files === 'keep' ? p.files.map(rel) : [] };
}

module.exports = { plan, branch };
