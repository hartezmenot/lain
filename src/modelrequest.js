'use strict';

/**
 * THE ONE MODEL REQUEST ENVELOPE — every request to a model, whatever carries it.
 *
 *     Core model request
 *       ├─ identity      reqtrace: id, turn, step, reason (why it is asking)
 *       ├─ ownership     session, task
 *       ├─ admission     a cancelled turn sends nothing
 *       ├─ cancellation  the turn's signal travels with it
 *       └─ accounting    outcome and the usage receipt, on the same record
 *               │
 *       transport (after the envelope, never instead of it)
 *         ├─ 'api'       provider.js — Anthropic, OpenAI-compatible, Responses
 *         └─ 'website'   modelsource/* — a signed-in ChatGPT.com / Gemini page
 *
 * ------------------------------------------------------------------------
 * WHY (2026-09-25). A website source's request went `chatdispatch → source.send`
 * with its own counting and nothing else: no request identity, no trace, no
 * task. "How many model requests did this session make, for which task, and
 * why?" had two answers depending on the transport. Transports stay
 * specialised — driving a web page is nothing like an HTTPS stream — but the
 * AUTHORITY over a request is here, once.
 *
 * Measuring and gating only: nothing here retries, delays or rewrites a request.
 * A failure inside the envelope never costs the request (a tracer that throws
 * would be a measurement able to end a turn).
 */

const TRANSPORT = Object.freeze({ API: 'api', WEBSITE: 'website', RUNTIME: 'runtime', LOCAL: 'local' });

/**
 * OPEN A REQUEST. Returns `{ ok, env }` — or `{ ok: false, why }` when the turn
 * it belongs to was already cancelled (nothing is sent for a dead turn).
 */
function open({ turn = null, step = null, reason = null, transport = TRANSPORT.API, model = '', connection = '', provider = '', project = null, role = null, origin = null, sessionId = null, taskId = null, signal = null, app = null } = {}) {
  if (signal && signal.aborted) return { ok: false, why: 'the turn was cancelled before the request was sent' };
  const reqtrace = require('./reqtrace');
  let rec = null;
  try {
    rec = reqtrace.begin({ turn, step, reason: reason || reqtrace.REASON.MACHINERY, model, connection });
    rec.transport = transport;
    rec.session = sessionId || null;
    rec.task = taskId || null;
    // WHO PAID FOR IT: the provider, the account (connection = account
    // instance), the project and the role — the dimensions usage.js reads.
    rec.provider = String(provider || '');
    rec.project = project ? require('./journey').projectId(project) : null;
    rec.role = role || null;
    // WHAT STARTED IT (usage.js ORIGIN): a person, Telegram, a schedule, a watch.
    rec.origin = origin || null;
  } catch { rec = null; }
  if (app) { try { require('./admissiontrace').note(app, 'request:open', { id: rec && rec.id, transport }); } catch { /* measurement only */ } }
  return { ok: true, env: { rec, transport, signal, openedAt: Date.now() } };
}

/** Close it: the outcome and — when the transport had one — the usage receipt. */
function close(env, { ok = true, status = 0, failure = '', usage = null } = {}) {
  if (!env || !env.rec) return null;
  try {
    const receipt = usage ? { type: 'usage', ...usage } : null;
    const done = require('./reqtrace').end(env.rec, { ok, status, failure, receipt });
    // THE USAGE RECEIPT (usage.js): the same record, kept past the session.
    try { require('./usage').record(done); } catch { /* measurement only */ }
    // THE TRAY RE-READS REPORTED QUOTA after a receipt — coalesced, and only in a process with a window.
    try { require('./fabric/tray').afterReceipt(); } catch { /* presentation only */ }
    return done;
  } catch { return null; }
}

/** The per-message sizing, when the transport sends a message array. */
function sized(env, messages, tools) {
  if (!env || !env.rec) return;
  try { require('./reqtrace').sized(env.rec, messages, tools); } catch { /* measurement only */ }
}

/**
 * The API transport's entry (provider.chat): the envelope from the provider
 * connection and the caller's trace, sized; throws when the turn was already
 * cancelled — nothing is sent for a dead turn.
 */
function openApi(pc, messages, opts = {}) {
  const t = opts.trace || {};
  const opened = open({
    turn: t.turn || null, step: t.step, reason: t.reason,
    transport: pc.protocol === 'runtime' ? (pc.locality === 'local' ? TRANSPORT.LOCAL : TRANSPORT.RUNTIME) : TRANSPORT.API,
    model: pc.model || '', connection: pc.connectionId || pc.provider || '', provider: pc.provider || '',
    project: opts.cwd || null, role: opts.role || null, origin: opts.origin || null,
    sessionId: opts.sessionId || null, taskId: opts.taskId || null, signal: opts.signal || null,
  });
  if (!opened.ok) { const e = new Error(opened.why); e.status = 499; e.cancelled = true; throw e; }
  if (opened.env.rec) {
    opened.env.rec.protocol = pc.protocol || ''; opened.env.rec.runtime = pc.runtime || null;
    // WHICH ACCOUNT (Phase 8.2): the one the lane asked for, and the one the route actually goes through.
    opened.env.rec.account = pc.accountId || pc.connectionId || null;
    opened.env.rec.requestedAccount = pc.requestedAccount || null;
    opened.env.rec.route = pc.routeId || null;
    // THE LOGICAL ROUTE (Phase 8.3): the family and logical model the person chose, and the effort sent.
    opened.env.rec.family = pc.family || null;
    opened.env.rec.logicalModel = pc.canonicalModel || null;
    opened.env.rec.effort = pc.reasoningEffort || null;
    if (pc.transportIdentity) opened.env.rec.transportIdentity = pc.transportIdentity;
  }
  sized(opened.env, messages, opts.tools);
  return opened.env;
}

module.exports = { TRANSPORT, open, openApi, close, sized };
