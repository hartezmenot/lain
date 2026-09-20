'use strict';

/**
 * WHAT DID THE USER JUST MEAN?
 *
 * Split out of app.js, which had grown past the god-object guard. The seam is
 * real: app.js RUNS the turn, and this decides what the input was — a new task,
 * a continuation, a steer — and what kind of work it implies. Both questions
 * are answered locally and for free, by task.js and mode.js; this is the glue
 * that applies their verdict to the session, and the only place that does.
 *
 * Everything downstream consumes the verdict rather than re-reading the raw
 * text, which is what keeps there being exactly one classifier.
 */

const taskId = require('./task');
const modeId = require('./mode');
const taskClassId = require('./taskclass');
const { Lifecycle } = require('./lifecycle');

/**
 * @param {App}     app
 * @param {string}  text
 * @param {boolean} isPaste
 * @param {string}  forceMode  a named mode from a command, or null
 * @param {boolean} sameTask   asserted by LAIN's own machinery only
 */
function identify(app, text, isPaste, forceMode = null, sameTask = false) {

  const verdict = taskId.classify(text, { isPaste, activeTask: app.session.task });
  // A CALLER MAY KNOW BETTER THAN THE CLASSIFIER. The troubleshoot relay
  // submits its own instruction — "a second model recommends this next
  // step…" — which reads as a brand new request and replaced the user's
  // actual problem in the task banner, then cleared the story that produced
  // it. Only LAIN's own machinery may assert this; typed input never does.
  if (sameTask && app.session.task) verdict.sameTask = true;
  // WHAT KIND OF WORK IS THIS? A different question from "is this the same
  // task?", answered locally and for free — see mode.js. It selects a
  // paragraph of workflow guidance and nothing else, so it can never block.
  const verdictMode = modeId.classify(text, {
    isPaste,
    taskKind: verdict.kind,
    activeMode: app.session.mode,
    projectEmpty: app.projectIsEmpty(),
  });
  verdict.mode = (forceMode && modeId.KIND[forceMode]) || verdictMode.mode;  // a named mode (/troubleshoot) beats the keyword guess
  verdict.modeReason = forceMode && modeId.KIND[forceMode] ? 'requested by command' : verdictMode.reason;
  app.session.mode = verdict.mode;

  // ---- WHAT GROUNDING DOES THIS ACTUALLY NEED? --------------------------
  //
  // A different question again from "what mode is this" — see taskclass.js's
  // header for the exact defect it closes: a live desktop diagnostic that
  // mode.js has no vocabulary for was falling through to CHAT and being
  // told "this does not need the project inspected", which the model then
  // answered instead of doing the diagnostic. Consumed here, once, and
  // carried on the session so every surface — the prompt, the runtime
  // provenance diagnostic (§19), the routing tests (§47-48) — reads the same
  // verdict rather than re-guessing it.
  verdict.taskClass = taskClassId.classify(text, { mode: verdict.mode, projectEmpty: app.projectIsEmpty() });
  app.session.taskClassVerdict = verdict.taskClass;

  // (The CLI -> PROBE handoff that lived here — flipping the session's
  // execution environment when a PROBE-mode task arrived with a live Probe —
  // was removed with the Probe integration in 2026-09, along with PROBE as a
  // mode: such a request now classifies as whatever its own text says, which
  // is the honest answer for a tool whose workspace is the codebase.)

  if (!verdict.sameTask) {
    // ---- P0 — EXPLICIT CANCELLATION RETIRES THE OLD TASK, FOR REAL --------
    //
    // task.js already refuses to classify this as a STEER once the user says
    // "cancel it" — but refusing to STEER is not enough on its own if the old
    // task object is simply dropped by reference and something elsewhere
    // still points at it (an in-flight event, a handoff built earlier this
    // tick). `settle` marks it SUPERSEDED before it is let go, so anything
    // holding a stale reference sees a task that says plainly it is over
    // rather than one that still reads ACTIVE.
    //
    // There is no separate "task history" list to resurrect from — grep the
    // whole runtime and `app.session.task = …` happens in exactly this one
    // place — so once this reference is replaced, `/resume`, compaction and
    // recovery all read the NEW task from disk. There is nowhere else old
    // work could come back from.
    if (verdict.cancelled && app.session.task) {
      app.session.task.settle(taskId.STATE.SUPERSEDED);
      // A SMALL, IN-MEMORY RECORD FOR DIAGNOSTICS ONLY (§19's runtime
      // provenance surface) — not persisted, not a resurrection path. It
      // exists so a person can ask "what happened to the old task" and get a
      // real answer instead of it simply vanishing without a trace.
      if (!Array.isArray(app._retiredTasks)) app._retiredTasks = [];
      app._retiredTasks.push({
        id: app.session.task.id, objective: app.session.task.objective.slice(0, 160),
        supersededAt: new Date().toISOString(), reason: verdict.reason,
      });
      if (app._retiredTasks.length > 10) app._retiredTasks.shift();
    }
    // A genuinely new task: fresh lifecycle, fresh liveness. Evidence is
    // SESSION-scoped and deliberately survives — a new task in the same
    // session should not re-read files whose content is already known.
    //
    // ON EXPLICIT CANCELLATION the new task's objective is the text with the
    // cancel clause stripped ("Cancel the current task. Diagnose Calculator…"
    // becomes "Diagnose Calculator…") — see task.stripCancelClause — so the
    // new task's own record reads as the work, not as an instruction to stop
    // the old one.
    app.session.task = new taskId.Task(verdict.cancelled ? (verdict.newText || text) : text);
    if (app.ui.enabled) app.ui.clearExtras();   // a new task, a new story
    app.session.lifecycle = new Lifecycle(text);
    // ---- UNLESS LAIN'S OWN MACHINERY SAID THIS CONTINUES EXISTING WORK ----
    //
    // A goal and a plan can exist with no task object at all — `/goal` and
    // `/plan` are commands, not turns, so nothing has classified a request yet.
    // `sameTask` above is only honoured when a task exists, so a Continue
    // pressed on that plan was classified as a NEW task — and a new task
    // discarded the plan, which is the plan the button had just been asked to
    // continue. Found by pressing Continue in a real terminal: the turn ran,
    // and the next /plan opened an empty composer.
    //
    // A fresh task object is still made (there was none), but a plan that the
    // machinery explicitly said it is continuing is not thrown away. Typed input
    // can never assert this, so an ordinary new request still starts clean.
    if (!sameTask) app.session.plan = null;
    // FRESH BUDGETS, because both are PER TASK. Carried over, a spent
    // clarification budget would mean the SECOND thing somebody asks for can
    // never be clarified, and a spent visual budget would refuse to show
    // candidates for a picture nobody has looked at yet. Neither is a limit on
    // the user; both are limits on one task talking to itself.
    app._clarify = null;
    // A NEW TASK GETS ITS CONTINUATIONS BACK. The budget is per task, and a
    // task that inherited a spent one could not continue at all.
    app._visual = null;
  } else {
    if (!app.session.lifecycle) app.session.lifecycle = new Lifecycle(app.session.task.objective);
    app.session.lifecycle.noteUserInput();
    // ---- A FINISHED PLAN IS NOT THIS TURN'S PROGRESS ---------------------
    //
    // A plan stops being live when a task is ACCEPTED as complete, and that
    // acceptance happens in exactly one place (completion.js). Every other way
    // a turn can end — interrupted, abandoned, or a completion check that
    // refused — leaves a plan whose steps are all done still marked live.
    //
    // The banner reads progress off that plan, so the next thing the user typed
    // opened on `STEP 2/2 · 100%` inherited whole from the turn before it. The
    // percentage was true about work that had already stopped, and false about
    // the work being asked for, which is the worst combination: it reads as
    // "this is nearly done" for a request that has not started.
    //
    // Retiring it here does not delete it — the PLAN pane still shows what was
    // done. It stops being the answer to "how far along is the work in hand",
    // and a plan that is genuinely still in progress is untouched.
    const plan = app.session.plan;
    if (plan && plan.isLive && plan.isFinished) plan.retire('the plan finished before this request');
    if (verdict.kind === taskId.KIND.STEER) {
      app.session.task.steer(text);
      // A steer adjusts what is LEFT. Completed steps are evidence and are
      // never rewritten or deleted (see plan.js).
      if (app.session.plan) app.session.plan.steer(text);
    }
  }
  app.session.task.turnIds.push(text.slice(0, 60));
  // ---- WHO IS ABOUT TO RUN THIS, RECORDED FROM WHAT WILL ACTUALLY RUN ------
  //
  // Every turn passes through here, so this is the one place that sees the
  // model in force at the moment work begins — and it reads it from `cfg`,
  // which is what the provider layer will really use, rather than from anything
  // a model said about itself.
  //
  // ON A MODEL SWITCH THIS RECORDS A HANDOVER AND CHANGES NOTHING ELSE. That is
  // the entire point: see src/task.js `assignExecutor`, whose job is what it
  // does NOT do. The objective, the steers, the evidence, the plan and the task
  // id all survive, because a rate-limited or swapped executor is a fact about
  // a model and never a fact about whether the work is still wanted.
  noteExecutor(app);
  return verdict;
}

/**
 * Keep `task.executor` pointing at the model that is about to work.
 *
 * TOTAL AND SILENT. A session assembled without a config (a test double, a
 * headless run) must not be able to take a turn down over bookkeeping, so
 * every failure here is swallowed — the task is still perfectly usable with a
 * null executor, it simply cannot say who is carrying it.
 */
function noteExecutor(app) {
  try {
    const task = app.session.task;
    if (!task) return;
    const model = String((app.cfg && app.cfg.model) || '');
    if (!model) return;
    const provider = String((app.cfg && app.cfg.connection) || '');
    const cur = task.executor;
    // ALREADY THE EXECUTOR AND ABLE TO WORK: nothing to say. Re-assigning here
    // would push a handover row on every single turn and bury the real ones.
    if (cur && cur.model === model && cur.provider === provider && cur.state === taskId.EXECUTOR.ACTIVE) return;
    // THE SAME MODEL COMING BACK FROM A BLOCK IS A RESUME, NOT A HANDOVER. A
    // limit that expired did not change who is doing the work.
    if (cur && cur.model === model && cur.provider === provider) { task.resumeExecutor(); return; }
    task.assignExecutor({ provider, model });
  } catch { /* bookkeeping must never cost a turn */ }
}

module.exports = { identify };
