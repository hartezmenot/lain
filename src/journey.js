'use strict';

/**
 * THE SESSION JOURNEY — which room the window is in, and the path the work took.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS, AFTER CONSOLIDATION (2026-09-25). It was called "the Spine",
 * and it is not: the shared authority of LAIN is the Core owners themselves,
 * one per truth —
 *
 *   project mutations and their consequences   mutation.js (one transaction)
 *   the one project generation                 projectgen.current
 *   the canonical Selection                    harnesscontext.selection
 *   UI → source binding                        gug.sourceBinding
 *   what a request means, who takes it         mode.js → dispatch.route
 *   every model request                        modelrequest.js
 *   work changing hands                        planhandoff.js (the transfer)
 *   the task and its identity                  task.js
 *   who changed which lines                    editledger.js
 *
 * This file owns only what none of those do — the JOURNEY of one working
 * session:
 *
 *   surface     which room the window is in (in memory, on the root App)
 *   path        the transitions: Chat → Agent → IDE → a manual edit → BOT →
 *               Agent — as events carrying the task id, so a session reads as
 *               one piece of work (persisted with the session)
 *   agentTask   a pointer to the task the Coding Agent carries, as task.js
 *               serialises it, so its next turn is re-seated on it if a
 *               read-only aside ever replaced it
 *   proposal    the journey's name for a waiting "move to Agent?" — the record
 *               itself is a transfer in planhandoff.js; nothing is kept here
 *
 * The Focus workspace (open tabs, cursor) is presentation and lives in the
 * window. `project(app)` is this journey's projection; /api/state carries it
 * as `journey`.
 */

const crypto = require('crypto');
const path = require('path');

const SURFACES = Object.freeze(['home', 'ide', 'chat', 'bot', 'model', 'session', 'settings']);
const PANES = Object.freeze(['bot', 'agent']);

/** What can happen on the path. A closed set, so a reader can rely on it. */
const EVENT = Object.freeze({
  SURFACE: 'surface',           // the window moved to another room
  BOT: 'bot',                   // the BOT answered
  PROPOSED: 'proposed',         // "move to Agent?" was asked
  MOVED: 'moved',               // the person accepted: the Agent takes the task
  STAYED: 'stayed',             // the person kept it with the BOT
  AGENT_START: 'agent.start',
  AGENT_END: 'agent.end',
  USER_EDIT: 'user.edit',       // a manual save in the editor (editledger.js)
  CAPABILITY: 'capability',     // the BOT walked through a door (house.js)
});

const MAX_PATH = 200;

function defaults() { return { path: [], agentTask: null }; }
function attach(session) { session.journey = defaults(); return session; }
function of(session) { if (!session.journey) attach(session); return session.journey; }

function toJSON(session) {
  const v = (session && session.journey) || defaults();
  return { journey: { path: v.path.slice(-MAX_PATH), agentTask: v.agentTask || null } };
}

function restore(session, data = {}) {
  // A session saved before the rename carries the same record as `spine`.
  const raw = (data && (data.journey || data.spine)) || null;
  const d = raw && typeof raw === 'object' ? raw : {};
  const v = defaults();
  if (Array.isArray(d.path)) v.path = d.path.filter((e) => e && typeof e.kind === 'string').slice(-MAX_PATH);
  if (d.agentTask && typeof d.agentTask === 'object' && d.agentTask.task) v.agentTask = d.agentTask;
  session.journey = v;
  return session;
}

/** A stable, non-reversible id for a project root — the same folder, the same id. */
function projectId(root) {
  if (!root) return null;
  return `P${crypto.createHash('sha256').update(path.resolve(String(root)).toLowerCase()).digest('hex').slice(0, 12)}`;
}

/**
 * ONE EVENT ON THE PATH. The task id is read from the owner at the moment it
 * happens — never passed in by a caller that might hold a stale one.
 */
function note(session, kind, fields = {}) {
  if (!session || !Object.values(EVENT).includes(kind)) return null;
  const v = of(session);
  const e = { at: Date.now(), kind, taskId: (session.task && session.task.id) || null };
  for (const [k, val] of Object.entries(fields)) {
    if (val == null) continue;
    e[k] = typeof val === 'string' ? val.slice(0, 200) : val;
  }
  v.path.push(e);
  if (v.path.length > MAX_PATH) v.path.splice(0, v.path.length - MAX_PATH);
  return e;
}

/**
 * THE WINDOW SAYS WHICH ROOM IT IS IN. Only a CHANGE is a path event — the
 * window reports on every navigation and a repeat would bury the real steps.
 */
function surface(app, { surface: name, pane = null } = {}) {
  const want = String(name || '').toLowerCase();
  if (!SURFACES.includes(want)) return { ok: false, why: `surface must be one of ${SURFACES.join(', ')}` };
  const p = PANES.includes(pane) ? pane : null;
  const root = app._sibling || app;
  const prev = root._surface || null;
  root._surface = { surface: want, pane: p, at: Date.now() };
  if (!prev || prev.surface !== want || (want === 'ide' && prev.pane !== p)) {
    note(app.session, EVENT.SURFACE, { surface: want, pane: p || undefined });
  }
  return { ok: true, surface: root._surface };
}

// ---- the task the Coding Agent carries ----------------------------------------

/** An Agent turn is starting: the task is now agentic, and where it began is kept. */
function agentStarted(app, { via = 'ide', reason = '' } = {}) {
  const s = app.session;
  if (!s) return;
  const t = s.task;
  if (t) {
    t.agentic = true;
    if (!t.origin) t.origin = via;
  }
  note(s, EVENT.AGENT_START, { via, reason: reason || undefined });
}

/** Files the Coding Agent changed for the current task, from the checkpoint ledger. */
function taskFiles(app) {
  try {
    return require('./ui/panes').changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd }).map((f) => f.rel).slice(0, 40);
  } catch { return []; }
}

/** An Agent turn ended: snapshot the task it carried, as task.js serialises it. */
function agentEnded(app, { outcome = '' } = {}) {
  const s = app.session;
  if (!s) return;
  const t = s.task;
  if (t && t.agentic) {
    of(s).agentTask = { task: t.toJSON(), files: taskFiles(app), at: Date.now() };
  }
  note(s, EVENT.AGENT_END, { outcome: outcome || undefined });
}

/**
 * BEFORE AN AGENT TURN: make sure the task in hand is the one the Agent was
 * carrying. The aside rule keeps a read-only question from replacing it, so in
 * ordinary use this finds nothing to do; it exists so continuity does not
 * depend on every other path remembering that rule.
 */
function reseat(app) {
  const s = app.session;
  const saved = s && of(s).agentTask;
  if (!saved || !saved.task) return false;
  const T = require('./task');
  if (s.task && s.task.id === saved.task.id) return false;
  if (s.task && s.task.agentic && s.task.live) return false;   // the Agent moved on to newer work
  const back = T.Task.from(saved.task);
  if (!back || !back.live) return false;
  s.task = back;
  return true;
}

// ---- "move to Agent?" -----------------------------------------------------------

// "MOVE TO AGENT?" IS A TRANSFER (planhandoff.js — the one Core handoff record):
// these are the journey's names for it, and they keep no state of their own.
function asProposal(t) {
  return t ? { id: t.id, text: t.text || '', task: t.task || null, context: t.findings || null, origin: t.origin || (t.kind === 'delegation' ? 'bot' : 'fast'), via: t.via || 'ide', reason: t.reason || '', at: t.at } : null;
}

function propose(app, { text, task = null, context = null, origin = 'fast', via = 'ide', reason = '' } = {}) {
  const t = require('./planhandoff').transfer(app, {
    kind: origin === 'bot' ? 'delegation' : 'proposal', from: 'bot', to: 'agent', text, task, context, reason, via, origin,
  });
  note(app.session, EVENT.PROPOSED, { origin, reason: t.reason || undefined });
  return asProposal(t);
}

function proposal(app) {
  if (!app.session) return null;
  return asProposal(require('./planhandoff').pendingTransfer(app));
}

/** Take the waiting proposal, once (accept or decline is recorded on the transfer). */
function takeProposal(app, id, accept = true) {
  return asProposal(require('./planhandoff').answerTransfer(app, id, accept));
}

// ---- the projection ---------------------------------------------------------------

function taskView(t) {
  if (!t) return null;
  return {
    id: t.id, objective: String(t.objective || '').slice(0, 300), state: t.state,
    origin: t.origin || null, agentic: Boolean(t.agentic), startedAt: t.startedAt,
    executor: t.executor ? { model: t.executor.model, state: t.executor.state } : null,
  };
}

/** Which surfaces a task has passed through, in order, without repeats. */
function surfacesOf(pathEvents, taskId) {
  const out = [];
  for (const e of pathEvents) {
    if (taskId && e.taskId !== taskId) continue;
    const where = e.kind === EVENT.SURFACE ? e.surface
      : e.kind === EVENT.AGENT_START ? 'agent' : e.kind === EVENT.BOT ? 'bot'
        : e.kind === EVENT.USER_EDIT ? 'edit' : null;
    if (where && out[out.length - 1] !== where) out.push(where);
  }
  return out.slice(-12);
}

function project(app) {
  const s = app.session;
  if (!s) return null;
  const v = of(s);
  const root = app._sibling || app;
  let proj = null;
  try { proj = require('./sessionviews').project(s); } catch { proj = null; }
  const attached = Boolean(proj && proj.attached);
  const saved = v.agentTask;
  const agentTask = saved && saved.task ? {
    ...taskView(saved.task), files: (saved.files || []).slice(0, 20), at: saved.at,
    current: Boolean(s.task && s.task.id === saved.task.id),
  } : null;
  const p = proposal(app);
  return {
    ids: {
      session: s.id,
      project: attached ? projectId(s.cwd) : null,
      task: (s.task && s.task.id) || null,
    },
    // READ FROM THEIR OWNERS, never kept here: the one project generation and
    // the canonical Selection (harnesscontext.js), for the window to show.
    projectGeneration: (() => { try { return attached ? require('./projectgen').current(s.cwd).n : null; } catch { return null; } })(),
    selection: (() => {
      try {
        const sel = require('./harnesscontext').selection(app, s);
        return sel ? { id: sel.id, kind: sel.kind, surface: sel.surface, projectGeneration: sel.projectGeneration, file: sel.source ? sel.source.file : null, symbol: sel.symbol ? sel.symbol.name : null, binding: sel.visual && sel.visual.binding ? sel.visual.binding : null } : null;
      } catch { return null; }
    })(),
    project: attached ? { name: path.basename(s.cwd || ''), root: s.cwd } : null,
    surface: root._surface || null,
    task: taskView(s.task),
    agentTask,
    agent: { running: s._role === 'agent', bot: s._role === 'bot' },
    proposal: p ? { id: p.id, text: p.text, task: p.task, origin: p.origin, via: p.via, reason: p.reason, at: p.at } : null,
    path: v.path.slice(-40),
    route: surfacesOf(v.path, (agentTask && agentTask.id) || (s.task && s.task.id)),
  };
}

module.exports = {
  SURFACES, PANES, EVENT, MAX_PATH,
  attach, toJSON, restore, note, surface, projectId,
  agentStarted, agentEnded, reseat, taskFiles,
  propose, proposal, takeProposal, project, surfacesOf,
};
