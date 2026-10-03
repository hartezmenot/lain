'use strict';

/** WHAT THE SCREEN DOES AS A TURN BEGINS, RUNS, IS INTERRUPTED AND ENDS. */

/** A genuinely new task: the previous task's story is no longer the news. */
function clearExtras(ui) {
  ui.story.newTask();
  // A new task starts an empty timeline — the previous task's operations are
  // not the news, and its diff window is about a change nobody is looking at.
  ui.activity.reset();
  if (Array.isArray(ui.app.session.actors)) ui.app.session.actors.length = 0;
}

/** A new turn: whatever the last one was doing is no longer the news. */
function beginTurn(ui, verdict = null) {
  const alert = require('./alert');
  // WHAT TO DO WITH THE CLOCK IS DECIDED BEFORE THE ALERT IS CLEARED, because clearing it is what destroys the evidence the decision is made from.
  const attempt = alert.attemptFor(ui, verdict);
  // THE STALE ALERT STOPS BEING THE RESTING STATE, HERE
  alert.clearResting(ui);
  ui.story.beginTurn();
  // NO REQUEST IS OPEN YET, so there is no live figure to draw.
  ui.liveUsage = null;
  // THE RESPONSE COUNTER GOES BACK TO ZERO
  ui.liveOutput = { chars: 0, tokens: 0, measured: false };
  // AND THE WORK CLOCK STARTS, HERE AND NOWHERE ELSE
  if (attempt === alert.ATTEMPT.CONTINUE) require('./workclock').resume(ui.clock);
  else require('./workclock').start(ui.clock);
  // AND THE LIVE ROW GOES BACK TO THE WORK.
  require('./operation').clear(ui);
}

/** The turn is over: hand the feed back to the persisted record. */
function endTurn(ui) {
  ui.story.endTurn();
  // THE ESTIMATE IS REPLACED BY THE RECEIPT
  try {
    const turns = (ui.app.session && ui.app.session.turns) || [];
    const last = turns[turns.length - 1];
    const measured = last && last.usage && Number(last.usage.outputTokens);
    if (measured > 0) ui.liveOutput = { chars: (ui.liveOutput && ui.liveOutput.chars) || 0, tokens: measured, measured: true };
  } catch { /* the estimate is still true, and still says it is one */ }
  // THE OPEN REQUEST IS CLOSED.
  ui.liveUsage = null;
  // AND THE WORK CLOCK STOPS, KEEPING ITS VALUE
  require('./workclock').settle(ui.clock);
  // AND THE TRANSIENT ROW IS HANDED BACK
  require('./operation').clear(ui);
  ui.refresh();
}

/** The call in flight. This is what keeps the screen from going silent while the model works: the turn already announces each call, so showing it costs… */
function setRunning(ui, name, target) {
  ui.running = name ? { name, target } : null;
  // ENQUEUED, NOT AWAITED.
  if (name) ui.activity.begin(name, target);
  else ui.activity.settle();
  ui._syncTicker();
  ui.refresh();
}

/** Adopt the turn loop's phase. */
function setPhase(ui, next) {
  const before = ui.phase && ui.phase.phase;
  const after = next && next.phase;
  if (before !== after) ui.phaseSince = Date.now();
  ui.phase = next && next.phase !== 'ENDED' ? next : null;
  if (!ui.phase) ui.interrupting = false;
  ui._syncTicker();
  ui.refresh();
}

/** Ctrl+C during work: shown immediately, before the unwind finishes. */
function setInterrupting(ui, on) {
  ui.interrupting = Boolean(on);
  if (ui.interrupting) ui.interrupted = false;
  ui._syncTicker();
  ui.refresh();
}

/** The turn ENDED because the user cancelled it. */
function setInterrupted(ui, on) {
  ui.interrupted = Boolean(on);
  if (ui.interrupted) ui.interrupting = false;
  ui._syncTicker();
  ui.refresh();
}

/** The turn ENDED BADLY — the provider died, timed out, or refused. */
function setFailed(ui, on) {
  // An OBJECT keeps its kind; a STRING keeps its sentence — `failureRow` renders both and only a boolean carries nothing.
  ui.failed = on && (typeof on === 'object' || typeof on === 'string') ? on : Boolean(on);
  // WHICH SELECTION FAILED. A provider warning belongs to the model/route it was
  // observed on; choosing another one ends it (§48). See projection.activeFailure.
  ui.failedFor = ui.failed ? require('./projection').selectionKey(ui.app) : null;
  if (ui.failed) { ui.interrupting = false; ui.interrupted = false; }
  ui._syncTicker();
  ui.refresh();
}

module.exports = {
  clearExtras, beginTurn, endTurn,
  setRunning, setPhase, setInterrupting, setInterrupted, setFailed,
};
