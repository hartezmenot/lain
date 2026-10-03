'use strict';

/** WHAT THE SCREEN IS TOLD — the projection of app state into a frame. */

const views = require('./views');
const termtitle = require('../termtitle');

/** The selection a provider fact is about: the model and route in use. */
function selectionKey(app) {
  const cfg = (app && app.cfg) || {};
  return `${cfg.model || ''}|${cfg.connection || ''}`;
}

/** A PROVIDER WARNING IS LIVE ONLY WHILE ITS SELECTION IS (§48). */
function activeFailure(ui) {
  if (!ui.failed) return false;
  return ui.failedFor && ui.failedFor !== selectionKey(ui.app) ? false : ui.failed;
}

function lastTurnOfThisProcess(ui) {
  const turns = (ui.app.session && ui.app.session.turns) || [];
  const floor = Number(ui.app._turnsAtAdopt) || 0;
  const last = turns.length > floor ? turns[turns.length - 1] : null;
  if (!last) return null;
  const providerStop = last.stopReason === 'provider' || last.stopReason === 'rate-limited';
  if (providerStop && ui.failedFor && ui.failedFor !== selectionKey(ui.app)) return { ...last, stopReason: null };
  return last;
}

function statusState(ui) {
  const last = lastTurnOfThisProcess(ui);
  return {
    // FOR THE ACTIVITY BOX: is a turn working, and did the person expand it (Ctrl+O).
    busy: Boolean(ui.busy),
    activityExpanded: Boolean(ui.activityExpanded),
    phase: ui.phase,
    phaseSince: ui.phaseSince,
    // HOW LONG THIS TASK HAS BEEN WORKING
    clock: require('./workclock').reading(ui.clock),
    // THE TRANSIENT OPERATION NOTE, if one is standing.
    op: require('./operation').current(ui),
    interrupting: ui.interrupting,
    interrupted: ui.interrupted,
    failed: activeFailure(ui),
    retryCancelled: ui.retryCancelled,
    pendingCompletion: ui.app.pendingCompletion || null,
    // A DELIBERATE WAIT, so the strip can name it and count it down.
    waitingUntil: ui.waitingUntil || 0,
    waitingLabel: ui.waitingLabel || '',
    // WAITING ON A PERSON is a resting state the strip must carry, or it
    // reports the turn that asked the question as DONE.
    awaitingUser: (ui.app.session && ui.app.session.lifecycle
      && ui.app.session.lifecycle.state === 'NEEDS_USER')
      ? ui.app.session.lifecycle.reason : null,
    // A FAILING LAST CHECK, carried to the strip.
    finalSmoke: (() => {
      const sess = ui.app.session;
      if (!sess || !sess.lifecycle) return null;
      const fsm = require('../finalsmoke');
      const st = fsm.state(sess.lifecycle, sess.cwd);
      return { state: st, why: fsm.why(st, sess.cwd) };
    })(),
    lastCheckFailed: (ui.app.session && ui.app.session.lifecycle
      && ui.app.session.lifecycle.lastCommand
      && ui.app.session.lifecycle.lastCommand.ok === false)
      ? ui.app.session.lifecycle.lastCommand : null,
    // THE PLAN IN HAND, not the last plan the session had.
    progress: views.progressOf(views.livePlan(ui.app.session)),
    // WHAT THIS SESSION HAS COST
    usage: (ui.app.session && ui.app.session.usage) || null,
    // AND THE REQUEST THAT IS OPEN RIGHT NOW, if its input side is known.
    liveUsage: ui.liveUsage || null,
    // Is a request open at all?
    requestOpen: Boolean(ui.phase && (ui.phase.phase === 'WAITING_MODEL' || ui.phase.phase === 'RECEIVING')),
    steerQueued: Boolean(ui.app.steerQueue && ui.app.steerQueue.length),
    // THE PENDING TEXT ITSELF, not merely that some exists —.
    pending: (ui.app.steerQueue || []).slice(),
    // WORK RUNNING BESIDE THE CONVERSATION
    jobs: ui.app.jobs ? ui.app.jobs.all().map((j) => j.summary()) : [],
    background: require('./activityline').backgroundOf(ui.app),   // `1 shell · 1 monitor` on the live row
    // THIS turn's calls while it runs, the last turn's once it has ended —
    // the trail is always about work that really happened.
    recent: ui.liveActions.length ? ui.liveActions : (last && last.actions) || [],
    // WHY IT STOPPED TRAVELS WITH THE COUNTS.
    lastTurn: last ? {
      toolCalls: last.toolCalls || 0,
      filesChanged: (last.mutations || []).length,
      stopReason: last.stopReason || null,
      usage: last.usage || null,   // the receipt on the DONE line (ui/activityline.receipt)
      blocker: last.blocker != null ? Boolean(last.blocker) : require('../wakeup').statesBlocker(last.text),
    } : null,
  };
}

/** Snapshot the app's EXISTING state for the views. No derivation by model. */
/** THE MOST RECENT REQUEST'S COMPOSITION, or null. */
function lastAuditOf(session) {
  const turns = (session && session.turns) || [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const a = turns[i] && turns[i].audits;
    if (Array.isArray(a) && a.length) return a[a.length - 1];
  }
  return null;
}

/** `{used, window}` in TOKENS, or null when no window is known. */
function contextUsage(app, pc) {
  const window = Number(pc && pc.ctx) || 0;
  if (!window) return null;
  let chars = 0;
  try { chars = app.session.contextChars(); } catch { return null; }
  const { CHARS_PER_TOKEN } = require('../session');
  return { used: Math.round(chars / CHARS_PER_TOKEN), window };
}

function frameState(ui) {
  const app = ui.app;
  let pc = {};
  // THE SESSION'S LANE, NOT THE PROCESS DEFAULT (Phase 8.2): the header names the
  // account and model the NEXT turn goes through — the same pair the window shows.
  let lane = null;
  try {
    const which = require('../sessionviews').current(app.session) === 'chat' ? 'chat' : 'coding';
    lane = require('../sessionintel').lane(app, app.session, which);
  } catch { lane = null; }
  try { pc = require('../provider').resolve(require('../sessionviews').turnCfg(app, app.session)); } catch { pc = {}; }
  let providerStatus = null;
  try { providerStatus = app.availability.getFor(pc.connectionId || pc.provider || '', pc.canonicalModel || pc.model || '').status; } catch { /* none */ }
  const life = app.session.lifecycle;
  const summary = life && life.summary ? life.summary() : null;
  return {
    cwd: app.session.cwd,
    session: app.session,
    plan: app.session.plan,
    lifecycle: life,
    checkpoints: app.checkpoints,
    outputs: ui.outputs,
    // THE MOCK MODEL (LAIN_PROVIDER=mock: tests, demos) answers every turn whatever the lane says —
    // no account to ask for, and its own name is what the next turn uses.
    model: pc.provider === 'mock' ? pc.model : ((lane && lane.modelLabel) || pc.canonicalModel || pc.model || app.cfg.model),
    // THE PROVIDER FAMILY (Phase 8.3) — "Codex › GPT-6 Sol (XHigh)": never the backing account's name.
    account: pc.provider === 'mock' ? '' : (lane ? (lane.familyLabel || lane.accountLabel || (lane.needs === 'family' || lane.needs === 'account' ? 'choose a provider' : '')) : ''),
    provider: pc.provider,
    connection: pc.connectionId,
    // THE LANE'S EFFORT as its model declares it (a level it does not take is never shown as in force).
    // LAIN EFFORT (S12a) is shown like a provider level, always (it is LAIN's own, never a guess at a provider default); a profile default says so.
    effort: (() => { if (lane && lane.effortSource === 'lain' && lane.effective) return require('../sessionintel').effortText(lane); if (lane && lane.effortKnown) return lane.effortLabel && lane.effort ? lane.effortLabel : null; try { const r = require('../sessionintel').resolve(app, app.session).reasoning; return r && r.value !== 'auto' ? r.value : null; } catch { return app.cfg.effort; } })(),
    /** THE OUTPUT TOKENS OF THE RESPONSE IN FLIGHT — the header's one number. */
    output: ui.liveOutput || null,
    // THE HEADER'S RUN STATE — mode, RUNNING, elapsed, real step progress. See ui/headerstate.js.
    run: require('./headerstate').run(ui),
    // TURNS THAT ENDED IN AN EARLIER PROCESS — drawn as history, never as alarms.
    historyTurns: Number(app._turnsAtAdopt) || 0,
    /** HOW MUCH OF THE MODEL'S WINDOW THIS CONVERSATION OCCUPIES. */
    context: contextUsage(app, pc),
    providerStatus,
    readiness: ui.readiness(pc),
    evidence: app.session.evidence,
    // Cached per session — a shallow scan, never re-run on a keystroke.
    project: app.projectScan(),
    tree: app.projectTree(),
    toolCount: require('../tools').names().length,
    running: ui.running,
    /** Everything the LLM status strip above the INPUT draws. See ui/status.js. */
    llm: ui.statusState(),
    // WHAT THE TOKEN PANE READS
    liveUsage: ui.liveUsage || null,
    requestOpen: Boolean(ui.phase && (ui.phase.phase === 'WAITING_MODEL' || ui.phase.phase === 'RECEIVING')),
    lastAudit: lastAuditOf(app.session),
    liveActions: ui.liveActions,
    liveNarration: ui.liveNarration,
    liveNotes: ui.liveNotes,
    liveThoughts: ui.liveThoughts || [],
    activityExpanded: Boolean(ui.activityExpanded),   // Ctrl+O also opens folded thinking
    liveUser: ui.liveUser || null,
    // WHAT THE COMPOSER IS CAPTURING, or '' — see ui/inputbox.js promptFor.
    compose: require('../composemode').label(ui.app),
    liveFrom: ui.liveFrom || null,
    liveTyped: Boolean(ui.liveTyped),
    /** THE ACTIVITY TIMELINE — the live operation and the diff window, if any. */
    activity: ui.activity || null,
    extras: ui.extras,
    resumeToken: ui.lastSessionToken(),
    transcript: app.render.transcript,
    changedCount: ui.changedCount(),
    // A `stats` BLOCK STOOD HERE, AND IT CARRIED A SECOND CLOCK
  };
}

/** The most recent OTHER session, as its short token — an offer on the start screen, never an action. */
function lastSessionToken(ui) {
  if (ui._lastToken === undefined) {
    try {
      const { Session } = require('../session');
      const prev = Session.list(5).find((id) => id !== ui.app.session.id);
      ui._lastToken = prev ? Session.shortId(prev) : null;
    } catch { ui._lastToken = null; }
  }
  return ui._lastToken;
}

/** Credential readiness for the CURRENT route, kept distinct from availability. */
function readiness(ui, pc) {
  try {
    const id = (pc && pc.connectionId) || '';
    const base = id.includes(':') ? id.slice(0, id.indexOf(':')) : id;
    const c = ui.app.connections().find((x) => x.id === base || x.id === id);
    return c ? c.readiness : null;
  } catch { return null; }
}

/** How many files this session changed. */
function changedCount(ui) {
  // Memoised on the number of checkpoints, because this runs on EVERY redraw — including every keystroke — and computing it re-reads each changed file…
  const n = (ui.app.checkpoints && ui.app.checkpoints.entries.length) || 0;
  if (ui._countKey === n) return ui._count;
  try {
    ui._count = require('./panes').changedFiles({ checkpoints: ui.app.checkpoints, cwd: ui.app.session.cwd }).length;
  } catch { ui._count = 0; }
  ui._countKey = n;
  return ui._count;
}

/** Name the terminal tab after the project and the work. */
/** THE OS WINDOW TITLE — `Verifying · lain-v2`, or just `lain-v2`. */
/** ADVANCE THE WORK CLOCK — the one caller of ui/workclock.js `apply`. */
function clock(ui) {
  if (!ui || !ui.clock) return;
  try {
    const live = require('./status').liveState(ui.statusState());
    require('./workclock').apply(ui.clock, termtitle.stateOf(live));
  } catch { /* a clock that cannot classify itself simply keeps its value */ }
}

function title(ui, s) {
  let state = termtitle.STATE.IDLE;
  try {
    state = termtitle.stateOf(require('./status').liveState(ui.statusState()));
  } catch { state = termtitle.STATE.IDLE; }
  try {
    termtitle.update({ folder: views.projectName(s.cwd), state });
  } catch { /* the title is chrome on another program's window */ }
}

module.exports = { selectionKey, activeFailure, lastTurnOfThisProcess, statusState, frameState, lastSessionToken, readiness, changedCount, title, clock, contextUsage };