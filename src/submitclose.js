'use strict';

/**
 * WHAT HAPPENS ONCE A TURN HAS ENDED — the REPL's half, not the loop's.
 *
 * ------------------------------------------------------------------------
 * TWO CLOSINGS, TWO OWNERS, AND THE SEAM BETWEEN THEM IS REAL.
 *
 * `turnclose.js` closes a TURN: totals, what the session remembers, what the
 * runtime is told. It happens inside `runTurn` and decides nothing about what
 * comes next. This closes a SUBMISSION: whether another one follows, and why.
 *
 * Split out of app.js at the god-object guard, whole rather than in pieces —
 * every branch below answers the same question ("is this conversation finished
 * with the user's last sentence, or not?") and they are only correct in this
 * order. Splitting them apart would be filing one decision under three headings.
 *
 * IT STARTS WORK, WHICH IS WHY IT IS NOT IN THE READ MODEL AND NOT IN THE UI.
 * Two of the three branches can begin another turn, and both do it by calling
 * `app.submit` — the same door — with the USER'S OWN TEXT. Nothing here composes
 * a sentence for a model.
 */

/**
 * @param {object} app
 * @param {object} record the finished turn
 * @param {string} text what was submitted, for the rate-limit resume
 * @returns {Promise<object>} the record, or the record of the turn that followed
 */
async function after(app, record, text) {
  // THE TURN HAS ENDED: an account switch that waited for it is applied now — never in the middle of a request.
  try { await require('./sessionintel').applyPending(app, app.session); } catch { /* the choice stays as it was */ }
  if (record && app.ui && app.ui.enabled) require('./compacttip').afterTurn(app);
  // ---- AN INTERRUPTED TURN HAS NO RECORD, AND THAT IS ORDINARY ----------
  //
  // `record` is set when the turn yields `done`. A turn cancelled with Ctrl+C
  // never gets there, so it arrives here as `null` — and every branch below
  // asks the record a question.
  //
  // THIS IS PRE-EXISTING, not introduced by moving the code: `app.js` read
  // `record.text` and `record.stopReason` unguarded in exactly the same order
  // (see the same lines in git HEAD). It is fixed here because this is where it
  // lives now, and because the one moment it can fire is the moment a person
  // has just pressed Ctrl+C — where an exception is the last thing wanted.
  //
  // THE STEER QUEUE IS STILL DRAINED. A sentence typed while the turn was
  // working is the user's own text and is not forfeited by cancelling the work
  // it was aimed at; what is skipped is everything that reasons ABOUT a record
  // that does not exist.
  if (!record) {
    const waiting = app.wantExit ? [] : app.drainSteers();
    if (waiting.length) {
      return app.submit(waiting.join('\n'), { sameTask: true, from: 'steer', typed: true });
    }
    // A QUEUED CONTINUATION IS DROPPED WHEN THE TURN IT WAITED FOR WAS
    // CANCELLED. Ctrl+C means stop, and starting fresh work out of the same
    // keystroke is the opposite of what was asked for.
    if (app._queuedContinue) app._queuedContinue = null;
    return record;
  }
  // ---- WHAT YOU TYPED WHILE IT WORKED, NOW THAT IT HAS FINISHED ---------
  //
  // A steer defaults to WAIT: it is delivered here, once the work in flight is
  // done, rather than interrupting a healthy tool call to add a sentence.
  // Pressing Enter again promotes it to NOW and it lands at the next step
  // boundary instead — this path is for the ones nobody promoted.
  //
  // SAME TASK, deliberately. It is a correction to the work that just happened,
  // not a new request, so it must not replace the objective.
  //
  // THIS IS THE USER'S OWN TEXT, which is why it may start a turn when nothing
  // else may. LAIN composes nothing here: it delivers a sentence the person
  // typed, at the first moment it is safe to deliver it.
  //
  // EVERY queued steer, not only the ones still WAITING — see `drainSteers` for
  // the sentence that used to be deleted here without being delivered.
  const waiting = app.wantExit ? [] : app.drainSteers();
  if (waiting.length) {
    // NO ACKNOWLEDGEMENT ROW: the next turn's USER block IS the delivery, and a
    // transient note here was cleared by `beginTurn` before any frame drew it.
    const joined = waiting.join('\n');
    return await app.submit(joined, { sameTask: true, from: 'steer', typed: true });
  }

  // ---- A CONTINUATION THAT WAS QUEUED BEHIND THIS TURN ------------------
  //
  // Pressing Continue on a goal while a turn is running reports QUEUED rather
  // than "a turn is running — stop it or let it finish". QUEUED has to mean it
  // actually runs, or it is the refusal with a nicer word on it. This is that
  // promise being kept, at the first moment it can be.
  //
  // AFTER THE STEERS, because a sentence the person typed is more recent
  // intent than a button they pressed before it.
  if (!app.wantExit && app._queuedContinue) {
    const queued = app._queuedContinue;
    app._queuedContinue = null;
    // A GOAL SET MID-TURN (`/goal <text>`) is the person's own message, a new task.
    if (queued.goal) return await app.submit(queued.text, {});
    return await app.submit(queued.text, { sameTask: true, from: 'continue' });
  }

  // ---- IT ASKED YOU SOMETHING ------------------------------------------
  //
  // "Now press 2 and narrow to 2.0" is the model asking the PERSON to act. It is
  // not finished and it is not continuing: it is waiting. Without this the strip
  // said DONE over an investigation that was waiting for a key press.
  //
  // THIS IS THE ONLY THING LEFT OF WHAT USED TO BE `carryon`. That module decided
  // the model should take ANOTHER TURN whenever a turn hit `maxSteps`, and
  // manufactured one — up to four times, each with a synthetic "continue from
  // where you stopped" prompt, each a fresh request re-sending the whole
  // conversation, each leaving that prompt permanently in the history.
  //
  // It is gone, deliberately. `maxSteps` is a bound on LAIN'S EXECUTION, not a
  // claim about the task and not a licence to spend four more requests deciding
  // the model did not mean to stop. The model is the agent; when it stops, it has
  // stopped, and the task simply stays ACTIVE so the next thing the user types
  // carries on. Classifying the ending truthfully is LAIN's job. Overriding it is
  // not.
  //
  // What remains here is a CLASSIFICATION, not a control flow: it reads the turn
  // and sets lifecycle state. It starts nothing.
  if (app.session.lifecycle && require('./lifecycle').Lifecycle.asksUserToAct(record.text)) {
    const why = 'it asked you to do something and is waiting for you';
    app.session.lifecycle.needsUser(why);
    // THE ONE STATE WHERE NOTHING HAPPENS UNTIL A PERSON ACTS. A companion that
    // cannot show it leaves the user waiting on a LAIN that is waiting on them —
    // the same deadlock, in a second window.
    app.events.emit(require('./events').EVENT.WAITING_FOR_USER, { reason: why });
    if (app.ui.enabled) app.ui.refresh();
  }

  // ---- THE CODING AGENT'S CHECKPOINT (supervision.js) --------------------
  //
  // A Coding turn that ended is an AUTHORITATIVE checkpoint: its phase summary
  // goes to Chat, pending steers and plan deltas are put to the person, a
  // queued profile change applies, and the run strategy decides whether LAIN
  // continues the APPROVED plan on its own (Long Context Phasing). A provider
  // limit pauses the task resumably first (quotapause.js), so the checkpoint
  // sees it and does not continue.
  //
  // THE NEXT PHASE IS NOT CARRY-ON: the person chose the strategy after a usage
  // warning; LAIN continues only the approved plan, and stops for any problem.
  let phaseNext = null;
  // ---- THE FAMILY'S ACCOUNT POLICY FIRST (Phase 8.3, fabric/fallback.js) ----------
  // Automatic fallback moves to the next eligible account of the same family for the
  // same model and effort and CARRIES ON the same task; Ask / Pinned / no compatible
  // account leave a question on the session instead. Nothing the person chose changes.
  let fallback = null;
  if (record.stopReason === 'rate-limited' && record.providerFailure && !app.wantExit) {
    try { fallback = require('./fabric/fallback').onTurnLimited(app, record); } catch { fallback = null; }
    if (fallback && fallback.action === 'switched') {
      if (app.ui.enabled) app.ui.noteActor('note', fallback.text); else app.render.notice('info', fallback.text);
      return await app.submit(require('./ratelimit').RESUME_PROMPT, { sameTask: true, from: 'account-fallback' });
    }
    if (fallback && app.ui.enabled && await require('./fabric/fallback').askInTerminal(app)) {
      return await app.submit(require('./ratelimit').RESUME_PROMPT, { sameTask: true, from: 'account-fallback' });
    }
  }
  if (require('./sessionviews').current(app.session) === 'coding' && !app.session.cowork) {
    try {
      if (record.stopReason === 'rate-limited' && record.providerFailure) require('./quotapause').pause(app, record);
      const cp = require('./supervision').checkpoint(app, record);
      if (cp && cp.next) phaseNext = cp;
      try { app.session.save(); } catch { /* in memory */ }
    } catch (e) { if (process.env.LAIN_DEBUG_TASK) app.render.notice('warn', `checkpoint: ${e.message}`); }
  }
  // THE TASK CARRIES ON (autocontinue.js): the next phase, a turn a provider failure cut (after a bounded,
  // cancellable wait — Stop ends it), or a crash recovered. Always the same door, with the cause as `from`.
  if (phaseNext && !app.wantExit && !(record.stopReason === 'rate-limited')) {
    const ac = require('./autocontinue');
    if (phaseNext.delayMs > 0 && !(await ac.wait(app, phaseNext.delayMs, phaseNext.cause))) return record;
    if (phaseNext.compact) ac.compactBoundary(app);
    return await app.submit(phaseNext.next, { sameTask: true, from: phaseNext.cause || 'phase-continue' });
  }

  // ---- RATE LIMITED FOR HOURS: WAIT, OR CHANGE MODEL --------------------
  //
  // The turn ended without spending itself on a limit measured in hours (see
  // turn.js). Only two answers are useful and both belong to the person, so they
  // are asked — and then LAIN does the waiting, rather than the user coming back
  // later to type `continue`.
  if (record.stopReason === 'rate-limited' && record.providerFailure) {
    // AN ACCOUNT QUESTION IS ALREADY ON THE SESSION (Ask / Pinned / no compatible account): it is the answer
    // the person gives — the window and Telegram show it; nothing waits on a second question here.
    if (fallback) { app.render.notice('warn', fallback.text || 'The account is rate limited — choose what to do.'); return record; }
    return await require('./ratelimit').handle(app, record, text);
  }

  // ---- AND IF NOBODY IS LOOKING, SAY SO ---------------------------------
  //
  // LAST, because everything above can still change how this turn ended — a
  // steer continues it, a rate limit resumes it — and a notification about an
  // ending that was not one is worse than none. Only a turn that really stopped
  // here reaches this line. See src/notify.js for what is and is not worth
  // interrupting somebody for; it is silent when there is no window.
  require('./notify').turnEnded(app, record);
  return record;
}

module.exports = { after };
