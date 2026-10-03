'use strict';

/** WHAT THE ONE SURFACE IS MADE OF. */

const views = require('./views');

/** THE CONVERSATION, as lines. */
function liveLines(screen, width) {
  const s = screen.state;
  return views.activity({
    session: s.session, current: s.current, width,
    transcript: s.transcript,
    liveActions: s.liveActions || [], liveNarration: s.liveNarration || [], liveNotes: s.liveNotes || [], liveThoughts: s.liveThoughts || [], thoughtsOpen: Boolean(s.activityExpanded),
    liveUser: s.liveUser || null, liveFrom: s.liveFrom || null, liveTyped: Boolean(s.liveTyped), extras: s.extras || [],
    // HOW A PARAGRAPH OF THE TURN IN FLIGHT IS PRESENTED — see ui/reveal.js.
    reveal: s.activity ? (text, at) => s.activity.reveal(text, at) : null,
    // THE TRANSIENT DIFF, and where history (an earlier process) ends.
    openDiff: screen.openDiff || null,
    closedDiffs: screen.closedDiffs || null,
    shownDiffs: screen.shownDiffs || null,
    // The clock the newest edit's diff arrives against — ui/turnsections.js.
    now: Date.now(),
    historyTurns: Number(s.historyTurns) || 0,
    checkpoints: s.checkpoints || null,
    cwd: s.cwd || '',
  });
}

/** The surface's content, as lines. */
function workspaceLines(screen, width, height = 20) {
  const s = screen.state;
  if (screen.completion) return screen.completion;

  const lines = liveLines(screen, width);
  // THE LIVE POSITION, at the foot of the feed
  if (s.activity) {
    try {
      for (const r of s.activity.liveRows(width)) lines.push(r);
    } catch { /* presentation only — the account above still stands */ }
  }
  // The launch screen stands in only when there is truly nothing yet: no task AND no feed.
  const hasTask = Boolean(s.session && s.session.task);
  if (hasTask || lines.filter((l) => l.trim()).length) return lines;
  return views.welcome({
    cwd: s.cwd, project: s.project, model: s.model, provider: s.provider,
    connection: s.connection, effort: s.effort, resume: s.resumeToken,
    width, height,
  });
}

module.exports = { liveLines, workspaceLines };
