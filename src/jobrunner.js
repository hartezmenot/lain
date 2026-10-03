'use strict';

/** STARTING AGENT WORK WITHOUT THE PROMPT WAITING FOR IT. */

const { runTurn } = require('./turn');
const { Session } = require('./session');
const { STATE } = require('./jobs');

/** THE OPTIONS A TURN IS RUN WITH — built once, for both paths. */
/** SIMPLE (simple.js): the model runs the loop — no classification, no wake-up, no lifecycle gate, no context profile. */
function simpleOptions(app, { session, signal, from = null, typed = false, ask = null, onStatus = null, steer = null }) {
  const p = require('./simpleprompt').of(app, { session });
  // THE PERSON ASKED (typed, Continue, a steer): every remembered limit on this route gets one real request (limitprobe.js).
  { const lp = require('./limitprobe'); if (lp.personAsked(from)) lp.forget(app, session); }
  return {
    cfg: require('./sessionviews').turnCfg(app, session),
    cfgNow: () => require('./sessionviews').turnCfg(app, session),
    systemPrompt: p.stable, live: p.live,
    from, typed, signal, evidence: session.evidence, lifecycle: null, availability: app.availability, checkpoints: app.checkpoints,
    app, ask, onStatus, steer,
    sideContext: async () => require('./bgdetach').takeContext(session),   // background results, delivered once
    taskClass: null, requiresExecution: false, simple: true,
  };
}

function turnOptions(app, opts) { return simpleOptions(app, opts); }

/** THE ORDINARY CONVERSATION, STARTED AND NOT WAITED FOR. */
/** Record a worker against the active task, if there is one. */
function noteAgent(app, entry) {
  try {
    const h = require('./harnesslink').existing(app);
    if (!h || !h.runtime.activeId) return;
    h.runtime.noteAgent(h.runtime.activeId, entry);
  } catch { /* the work is not a convenience; the record is */ }
}

function startPrimary(app, text, opts = {}) {
  if (app.jobs.primary()) return null;
  const job = app.jobs.create({ request: text, primary: true, session: app.session });
  job.state = STATE.RUNNING;
  job.startedAt = Date.now();
  // THE BUSY FLAG MOVED HERE FROM THE REPL LOOP, which used to bracket the awaited turn with it.
  if (app.ui.enabled) app.ui.setBusy(true);
  app.jobs.changed();

  // NO try/catch AROUND THIS CALL, and that is not an oversight.
  const p = app.submit(text, opts);
  // The SAME controller the interrupt handler reads, so `/cancel 1` and Ctrl+C
  // are one mechanism rather than two that can disagree.
  if (app.abort) job.abort = app.abort;

  Promise.resolve(p).then(
    (record) => {
      // Cancelled beats finished: a turn that was aborted still returns, and
      // reporting that as success is the one reading a person would dispute.
      if (job.state === STATE.CANCELLED) return;
      job._finish(STATE.SUCCEEDED, { result: record || null });
    },
    (e) => {
      if (job.state === STATE.CANCELLED) return;
      job._finish(STATE.FAILED, { error: (e && e.message) || String(e) });
      // The REPL used to catch this.
      try { app.render.notice('error', `job #${job.id} failed: ${job.error}`); } catch { /* no renderer */ }
    },
  ).then(() => app.jobs.changed());

  return job;
}

/** SAYING A JOB FINISHED, WITHOUT SAYING IT THREE TIMES. */
let pendingSay = [];
let sayTimer = null;

function announce(app, job) {
  pendingSay.push(job);
  if (sayTimer) return;
  sayTimer = setTimeout(() => {
    const batch = pendingSay;
    pendingSay = [];
    sayTimer = null;
    try {
      if (batch.length === 1) {
        const j = batch[0];
        // `Background #17 COMPLETED - run the integration suite`
        if (j.state === STATE.SUCCEEDED) app.render.notice('info', `Background #${j.id} COMPLETED - ${String(j.request).slice(0, 60)}`);
        else if (j.state === STATE.FAILED) app.render.notice('warn', `Background #${j.id} FAILED - ${j.error}`);
        return;
      }
      const ok = batch.filter((j) => j.state === STATE.SUCCEEDED).length;
      const bad = batch.length - ok;
      const ids = batch.map((j) => '#' + j.id).join(' ');
      const what = bad ? `${ok} background task(s) completed, ${bad} failed` : `${batch.length} background tasks completed`;
      app.render.notice(bad ? 'warn' : 'info', `${what} - ${ids} · /bg`);
    } catch { /* no renderer is not a reason to leave a job unsettled */ }
  }, 0);
  if (sayTimer && typeof sayTimer.unref === 'function') sayTimer.unref();
}

/** A FORKED SESSION — the same conversation so far, and a separate future. */
function forkSession(app) {
  const s = new Session({ cwd: app.session.cwd });
  s.messages = (app.session.messages || []).map((m) => ({ ...m }));
  // WHAT THE FORK INHERITS: THE AUTHORITY CHAIN, NOT A PILE OF FIELDS
  const parent = app.session;
  const goalMod = require('./goal');
  const { Task } = require('./task');
  const inherited = goalMod.toJSON(parent);
  if (inherited) s.goal = goalMod.from(inherited);
  if (parent.task) {
    s.task = typeof parent.task.toJSON === 'function'
      ? Task.from(parent.task.toJSON())
      // A SESSION ASSEMBLED BY A TEST DOUBLE may carry a plain object here.
      : Task.from(parent.task);
  } else {
    s.task = null;
  }
  s.mode = parent.mode || null;
  return s;
}

/** `/bg <request>` — a second piece of work, alongside the conversation. */
function startBackground(app, text) {
  const session = forkSession(app);
  const job = app.jobs.create({ request: text, primary: false, session });
  job.state = STATE.RUNNING;
  job.startedAt = Date.now();
  app.jobs.changed();
  // THE TASK RECORD IS TOLD A SECOND WORKER STARTED
  noteAgent(app, { name: `bg#${job.id}`, scope: String(text).slice(0, 200) });
  // WHICH HARNESS TASK THIS WORK BELONGS TO
  try {
    const h = require('./harnesslink').existing(app);
    job.taskId = (h && h.runtime.activeId) || null;
  } catch { job.taskId = null; }

  // THIS WORKER'S EXACT ASSIGNMENT
  try {
    job.workOrder = require('./authority').issue(app.session, {
      id: String(job.id),
      objective: text,
    });
    // AND THE WORKER IS TOLD WHICH ORDER IT IS EXECUTING.
    session.workOrder = job.workOrder;
  } catch { job.workOrder = null; }

  // A PER-JOB STEER QUEUE.
  job.steerQueue = [];

  const run = async () => {
    let record = null;
    for await (const ev of runTurn(session, text, turnOptions(app, {
      session,
      signal: job.abort.signal,
      from: 'background',
      // IT CAN ASK, AND IT STILL CANNOT TAKE THE SCREEN
      ask: (q) => app.interaction
        ? require('./interaction').ask(app, q, job.abort.signal)
        : job.askUser(q && q.question, (q && q.options) || []),
      onStatus: (p) => {
        if (!p) return;
        job.phase = p.phase || p.word || null;
        job.detail = String(p.detail || p.tool || '').slice(0, 80);
        app.jobs.changed();
      },
      steer: () => {
        const take = job.steerQueue.slice();
        job.steerQueue.length = 0;
        return take;
      },
    }))) {
      if (!ev) continue;
      // WHAT A BACKGROUND JOB SHOWS, and it is one line at a time on purpose: this is a thing you glance at while doing something else, not a second…
      if (ev.type === 'tool_start') {
        job.detail = `${ev.name}${ev.input && ev.input.path ? ' ' + ev.input.path : ''}`.slice(0, 80);
        app.jobs.changed();
      } else if (ev.type === 'done') {
        record = ev.record || null;
      }
    }
    return record;
  };

  const launch = app.interaction
    ? () => require('./interaction').run(app, { ...require('./interaction').port(app), signal: job.abort.signal }, run)
    : run;
  launch().then(
    (record) => {
      if (job.state === STATE.CANCELLED) return;
      job._finish(STATE.SUCCEEDED, { result: record || null });
    },
    (e) => {
      if (job.state === STATE.CANCELLED) return;
      job._finish(STATE.FAILED, { error: (e && e.message) || String(e) });
    },
  ).then(() => {
    noteAgent(app, {
      name: `bg#${job.id}`,
      scope: String(text).slice(0, 200),
      outcome: String(job.state),
    });
    // IT SAYS SO, WITHOUT TAKING THE SCREEN.
    announce(app, job);
    // ISOLATION IS THE POINT.
    app.jobs.changed();
    // THE JOB'S OWN ACCOUNT IS KEPT
    try { job.session.save(); } catch { /* a job's account is best effort, like the main one */ }
    try { app.session.save(); } catch { /* the main session save is best effort */ }
  });

  return job;
}

module.exports = { turnOptions, startPrimary, startBackground, forkSession };
