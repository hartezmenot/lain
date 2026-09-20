'use strict';

const contract = require('./contract');
const artifacts = require('./artifacts');
const attachments = require('./attachments');

function jobs(app) {
  return (app?.jobs?.all?.() || []).slice(-20).map((job) => {
    const row = job.summary ? job.summary() : job;
    return { id: row.id, state: row.state, label: contract.safeText(row.label, 100), waiting: Boolean(row.waiting),
      needsInput: Boolean(row.needsInput), activity: contract.safeText(row.activity, 120), startedAt: row.startedAt || null,
      endedAt: row.endedAt || null, error: row.error ? contract.safeText(row.error, 160) : null };
  });
}

function approval(app) {
  const events = require('../events');
  const required = app?.events?.last?.(events.EVENT.APPROVAL_REQUIRED), resolved = app?.events?.last?.(events.EVENT.APPROVAL_RESOLVED);
  if (!required || (resolved && resolved.at >= required.at)) return null;
  return { status: 'WAITING', kind: contract.safeText(required.kind || 'action', 30),
    label: contract.safeText(required.what || 'Approval required', 120), reason: contract.safeText(required.reason, 200), at: required.at };
}

function finished(app) {
  const turn = [...(app?.session?.turns || [])].reverse().find((row) => row && row.text);
  return turn ? { text: contract.safeText(turn.text, 1000), at: turn.endedAt || null } : null;
}

/**
 * THE AUTHORITY CHAIN A COWORK SESSION IS SERVING — goal, task, executor.
 *
 * ------------------------------------------------------------------------
 * ORIENTATION, NOT AUTHORISATION, and the distinction is the whole reason this
 * is safe to add. Cowork's ownership boundary is unchanged and is not here: an
 * artifact belongs to a harness task whose `sessionId` and `workspace` match
 * this session's, checked in cowork/artifacts.js against the real path. Nothing
 * in this projection is consulted to decide who may read a file, and adding a
 * goal id to a record cannot widen what a conversation can reach.
 *
 * WHY IT IS HERE AT ALL. Cowork predates the authority model, so a Cowork
 * background job could say which harness task owned its output and could not say
 * what the work was FOR. Since Cowork's `/bg` goes through the same
 * `app.startBackground` as the CLI's, it now inherits the goal like any other
 * worker — this is the surface that lets a Cowork client SEE that, rather than a
 * second mechanism for arranging it.
 *
 * BOUNDED AND SAFE TEXT, like everything else that crosses this boundary: the
 * goal and objective are one-lined and clipped through `contract.safeText`,
 * because a Cowork projection is rendered into a chat message on a platform LAIN
 * does not control.
 */
function authorityChain(app) {
  try {
    const chain = require('../authority').project(app && app.session);
    return {
      goalId: chain.goal ? chain.goal.id : null,
      goal: chain.goal ? contract.safeText(chain.goal.text, 200) : null,
      taskId: chain.task ? chain.task.id : null,
      task: chain.task ? contract.safeText(chain.task.objective, 200) : null,
      executor: chain.executor
        ? { model: contract.safeText(chain.executor.model, 60), state: chain.executor.state, epoch: chain.executor.epoch }
        : null,
      scopeRevision: chain.scopeRevision,
    };
  } catch {
    // A projection that cannot be built is reported as absent rather than as an
    // error: a Cowork client asking what this session is doing must still get an
    // answer about its artifacts and its jobs.
    return null;
  }
}

function project(app) {
  const session = app?.session, active = Boolean(session?.cowork);
  const harness = active ? require('../harnesssurface').project(app) : null;
  return {
    version: 1, active,
    session: active ? { id: session.id, lane: 'cowork', source: session.cowork.source, createdAt: session.createdAt } : null,
    // WHAT THIS WORK IS FOR. See authorityChain: orientation, never authorisation.
    authority: active ? authorityChain(app) : null,
    currentTask: harness?.task || null,
    activity: harness?.activity || { state: 'IDLE', action: '', target: '', timestamp: null },
    attachments: active ? attachments.list(app) : [], artifacts: active ? artifacts.list(app, { limit: 20 }) : [],
    approval: active ? approval(app) : null, jobs: active ? jobs(app) : [], finished: active ? finished(app) : null,
    capabilities: contract.capabilities(app),
  };
}

module.exports = { project, jobs, approval, finished, authorityChain };
