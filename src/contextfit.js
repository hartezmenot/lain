'use strict';

/** MAKING THE REQUEST FIT, BEFORE IT IS SENT. */

const providerLimits = require('./providerlimits');
const contextprovenance = require('./contextprovenance');

/** BUILD THE EXACT ARRAY THAT WILL BE TRANSMITTED. */
function buildWire(session, systemPrompt, live = '') {
  const head = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  // THE CHANGING HALF GOES LAST
  const framed = contextprovenance.frame(live);
  const tail = framed ? [{ role: 'user', content: framed, _live: true }] : [];
  // THIS TURN'S THREAD ONLY.
  const frozen = session._wireSent ? session._wireSent.set : null;
  const history = require('./sessionviews').wireMessages(session);   // the thread's own messages, as they were — no spliced packets, no folding
  return [...head, ...history, ...tail];
}

/** Remember which history messages this lineage has transmitted (a new model/route starts empty). */
function noteSent(session, pc, wire, { reset = false } = {}) {
  const key = `${pc.model || ''}|${pc.connectionId || pc.provider || ''}`;
  if (!session._wireSent || session._wireSent.key !== key) session._wireSent = { key, set: new WeakSet() };
  if (reset) return wire;
  for (const m of session.messages || []) session._wireSent.set.add(m);
  return wire;
}

/** FIT THE PAYLOAD, AND SAY WHAT WAS DONE TO IT. */
function fit(session, pc, { systemPrompt = '', live = '', cfg = {}, surface = 'COMPACT', tools = [] } = {}) {
  require('./perfmark').mark('fit');
  const notices = [];
  let compactions = 0;
  const authority = session.contextAuthority;
  if (!authority) throw new Error('session has no context authority');

  // PASS ONE: both budgets, before the array is built  THE BUDGET, NOT THE CEILING
  const firstDecision = { result: null };   // compaction is compactor.js (S8), before the fit
  const first = firstDecision.result || {
    compacted: false, before: session.contextChars(), after: session.contextChars(),
    elided: 0, folded: 0, beforeMessages: session.messages.length, afterMessages: session.messages.length,
  };
  if (first.compacted) {
    compactions += 1;
    // WHAT IT DID, then WHAT SURVIVED — the second is the question a person actually has when their context is rewritten mid-task.
    const kb = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.max(0, Math.round(n))));
    notices.push({
      type: 'notice', level: 'info', surface,
      message: `Context compacted · ${kb(first.before)} → ${kb(first.after)} · nothing was deleted · /token`,
    });
  }

  // ---- PASS TWO: measure what is ACTUALLY going out -----------------------
  noteSent(session, pc, null, { reset: true });   // a new model/route: nothing is frozen yet, so repeats may fold
  let projection = authority.project(pc, () => buildWire(session, systemPrompt, live), {
    stable: systemPrompt, live, tools: (tools || []).length,
  });
  // WHAT WILL THIS COST IN UNCACHED INPUT?
  let cache = null;
  try {
    const cb = require('./cachebudget');
    cache = cb.plan(session, pc, projection.wire, tools, cfg);
    if (cache.status === 'OVER') {
      const red = cb.reduceLive(live, cache, cfg);
      if (red.reductions.length) {
        const reduced = red.live;
        projection = authority.project(pc, () => buildWire(session, systemPrompt, reduced), { stable: systemPrompt, live: reduced, tools: (tools || []).length });
        const again = cb.plan(session, pc, projection.wire, tools, cfg);
        again.reductions = red.reductions;
        again.before = { ratio: cache.ratio, uncachedChars: cache.uncachedChars };
        cache = again;
      }
      if (cache.status === 'OVER') cache.exception = cb.exception(cache);
    }
    cb.commit(session, cache);
  } catch { cache = null; }
  const wire = noteSent(session, pc, projection.wire);
  const limits = providerLimits.limitsFor(pc, cfg);
  const verdict = providerLimits.check(wire, limits);
  if (!verdict.ok) {
    notices.push({
      type: 'notice', level: 'warn', surface,
      message: `still ${verdict.count} messages against a ${verdict.limit}-message limit — sending anyway; `
        + `compaction attempts for context epoch ${authority.epoch} are exhausted (${authority.attempts}/${authority.attempts})`,
    });
  }

  // ACCOUNTED, EVERY TIME
  const tokenaudit = require('./devtool').load('tokenaudit');   // a developer measurement (tools/dev) where present
  const audit = tokenaudit ? tokenaudit.measure(wire, { tools: tools || [], budget: require('./contextbudget').charsFor(pc, cfg) }) : null;
  if (audit && cache) audit.cache = { warmth: cache.warmth, epoch: cache.epoch, ratio: cache.ratio, status: cache.status, reductions: cache.reductions, exception: cache.exception };
  return { wire, notices, compactions, fit: first, verdict, audit, cache };
}

module.exports = { fit, buildWire };
