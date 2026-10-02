'use strict';

/**
 * MAKING THE REQUEST FIT, BEFORE IT IS SENT.
 *
 * Split out of turn.js, which had crossed the god-object guard again. The seam
 * is a real one: turn.js owns the LOOP — steps, tools, retries, what the model
 * said — and this owns one question asked immediately before each send:
 *
 *     will this provider accept the payload I am about to hand it?
 *
 * It knows nothing about tools, steps or the conversation's meaning. It reads
 * a session, a resolved provider and a system prompt, and returns the exact
 * array to transmit plus whatever should be said about the trimming.
 *
 * ------------------------------------------------------------------------
 * THE BUG IT WAS BUILT FROM, measured on the wire at 1,002 messages:
 *
 *     413 Payload Too Large — Chat history exceeds the 800-message limit
 *
 * The pre-flight check measured CHARACTERS and only characters. A message-count
 * cap and a token window are unrelated quantities — a thousand one-word
 * messages are tiny in tokens and over a count cap; three messages holding a
 * 400KB file are the reverse — so a payload has to pass both, separately.
 *
 * THE PROVIDER MUST NEVER BE LAIN'S CONTEXT-SIZE CALCULATOR. Sending a payload
 * already known to be over the limit costs a round trip, and the refusal
 * arrives with the whole turn's work inside the request that was rejected.
 *
 * ------------------------------------------------------------------------
 * WHAT IT WILL NOT DO. It never refuses to send. If a conversation cannot be
 * folded small enough, the request goes anyway and the notice says plainly that
 * it may be refused — a provider can accept more than it advertises, and
 * stranding the user on LAIN's arithmetic would be a worse failure than the
 * one being fixed. What it will not do is send silently.
 */

const providerLimits = require('./providerlimits');
const tokenaudit = require('./tokenaudit');
const contextprovenance = require('./contextprovenance');

/**
 * BUILD THE EXACT ARRAY THAT WILL BE TRANSMITTED.
 *
 * The system prompt is prepended HERE rather than by the caller, because the
 * count that matters is the count the provider receives — and the array LAIN
 * used to check was one message shorter than the one it sent. On the boundary
 * that difference is a refused request.
 */
function buildWire(session, systemPrompt, live = '', simple = false) {
  const head = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  // ---- THE CHANGING HALF GOES LAST --------------------------------------
  //
  // Not role `system`: the Anthropic mapping hoists every system message into
  // the cached system block, which would put the volatile text straight back
  // into the prefix this exists to protect. A trailing user turn is what both
  // protocols already accept, and provider.js merges it into a preceding
  // tool-result turn so no two user messages ever arrive in a row.
  //
  // ---- FRAMED, NOT RAW — THE P0 FIX -------------------------------------
  //
  // `role: 'user'` is not a cosmetic label. A model handed LAIN's own mode
  // guidance under that role, positioned after the person's real request
  // (Anthropic concatenates consecutive same-role turns into one logical
  // turn), reads generated prose as the newer, more authoritative
  // instruction — reproduced exactly with `MODE_GUIDANCE.CHAT`'s "Answer the
  // user. This does not need the project inspected or any files changed.",
  // which overrode an actual diagnostic request. See contextprovenance.js.
  //
  // `contextprovenance.frame` wraps the text in `<lain-context>` tags whose
  // meaning is taught once, in the stable half of the prompt (prompt.js
  // BASE) — a structural boundary the model is told about explicitly, not a
  // prose prefix competing for the same authority the old "Already
  // established:" heading had.
  //
  // `_live` still marks it for the accounting in tokenaudit.js and for
  // compaction, which must never fold the one message describing the
  // current state.
  const framed = contextprovenance.frame(live);
  const tail = framed ? [{ role: 'user', content: framed, _live: true }] : [];
  // THIS TURN'S THREAD ONLY. A Coding turn is not handed the Chat transcript,
  // and a terminal-only session is returned untouched. See sessionviews.js.
  // A request the person repeated later is sent once (intent.foldRepeats) —
  // unless it already went out in this cache lineage (`_wireSent`), where a
  // fold would rewrite cached history.
  // THE ANCHORED HARNESS CONTEXT (harnesscontext.spliceContext): append-only, before the request it was recorded for.
  const frozen = session._wireSent ? session._wireSent.set : null;
  // SIMPLE: the thread's own messages, as they were — no spliced packets, no folding.
  const history = simple ? require('./sessionviews').wireMessages(session)
    : require('./harnesscontext').spliceContext(session, require('./intent').foldRepeats(require('./sessionviews').wireMessages(session), { frozen }), contextprovenance.frame);
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

/**
 * FIT THE PAYLOAD, AND SAY WHAT WAS DONE TO IT.
 *
 * @param {object} session
 * @param {object} pc      the resolved provider
 * @param {object} o       { systemPrompt, cfg }
 * @returns {{wire:Array, notices:Array, compactions:number, fit:object, verdict:object}}
 *          `notices` are events for the caller to yield — this yields nothing
 *          itself, so the whole thing is testable without a turn.
 */
function fit(session, pc, { systemPrompt = '', live = '', cfg = {}, surface = 'COMPACT', tools = [], simple = false } = {}) {
  require('./perfmark').mark('fit');
  const notices = [];
  let compactions = 0;
  const authority = session.contextAuthority;
  if (!authority) throw new Error('session has no context authority');

  // ---- PASS ONE: both budgets, before the array is built ------------------
  // ---- THE BUDGET, NOT THE CEILING --------------------------------------
  //
  // WAS `sessionMod.budgetChars(pc)`, which is what the provider will ACCEPT
  // — 676,108 characters on a 200k-token model. Compacting against that meant
  // compaction never ran until the window was nearly full, and by then the
  // cost had already been paid on every request that carried the transcript
  // up there. See src/contextbudget.js for why these are two numbers.
  //
  // The ceiling is still consulted below, for the different question of
  // whether this provider will refuse the payload outright.
  const firstDecision = authority.compact(pc, cfg, { reason: 'preflight-context-pressure' });
  const first = firstDecision.result || {
    compacted: false, before: session.contextChars(), after: session.contextChars(),
    elided: 0, folded: 0, beforeMessages: session.messages.length, afterMessages: session.messages.length,
  };
  if (first.compacted) {
    compactions += 1;
    // WHAT IT DID, then WHAT SURVIVED — the second is the question a person
    // actually has when their context is rewritten mid-task. Both are checked
    // against the session as it now stands (continuity.js); neither is a
    // reassurance printed unconditionally.
    // ---- ONE CONCISE LINE, AND NOT A COMPRESSION REPORT ------------------
    //
    // IT USED TO BE THREE, and the first was 120 characters of them:
    //
    //     CONTEXT COMPACTION  84k → 31k chars — elided 42k chars of earlier
    //     tool output (nothing was deleted; re-run a call to get it back)
    //     kept: the objective · 3 corrections you made · the plan (2/5 done)
    //
    // Auto-compaction is housekeeping the user did not ask for, happening in the
    // middle of their task. What they need from it is that it happened and that
    // nothing was lost; the accounting - what was elided, what survived, how
    // close to the budget this leaves them - is `/token`, which exists and says
    // all of it properly. A reassurance paragraph printed over the work it was
    // making room for is the thing it was making room for.
    //
    // STILL NOT INTO THE CONVERSATION: the surface is transient and closes
    // itself (src/turnevents.js). Nobody said this to the model.
    const kb = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.max(0, Math.round(n))));
    notices.push({
      type: 'notice', level: 'info', surface,
      message: `Context compacted · ${kb(first.before)} → ${kb(first.after)} · nothing was deleted · /token`,
    });
  }

  // ---- PASS TWO: measure what is ACTUALLY going out -----------------------
  noteSent(session, pc, null, { reset: true });   // a new model/route: nothing is frozen yet, so repeats may fold
  let projection = authority.project(pc, () => buildWire(session, systemPrompt, live, simple), {
    stable: systemPrompt, live, tools: (tools || []).length,
  });
  // ---- WHAT WILL THIS COST IN UNCACHED INPUT? (cachebudget.js) ------------
  //
  // The exact wire against the lineage's previous request. Over the 8 % warm
  // ceiling, the optional tail sections are cut to their floors and the wire
  // rebuilt once; still over, it is sent with an EXCEPTION naming the owners.
  // Required context and new tool evidence are never cut here.
  let cache = null;
  try {
    const cb = require('./cachebudget');
    cache = cb.plan(session, pc, projection.wire, tools, cfg);
    if (cache.status === 'OVER') {
      const red = cb.reduceLive(live, cache, cfg);
      if (red.reductions.length) {
        const reduced = red.live;
        projection = authority.project(pc, () => buildWire(session, systemPrompt, reduced, simple), { stable: systemPrompt, live: reduced, tools: (tools || []).length });
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

  // ---- ACCOUNTED, EVERY TIME -------------------------------------------
  //
  // Measured HERE because this is the one place the exact transmitted array
  // exists. A breakdown produced anywhere else would be a reconstruction, and
  // a reconstruction is what nobody could trust when the reported figure was
  // 330,000 tokens and no part of the system could say of what.
  const audit = tokenaudit.measure(wire, {
    tools: tools || [],
    budget: require('./contextbudget').charsFor(pc, cfg),
  });
  if (audit && cache) audit.cache = { warmth: cache.warmth, epoch: cache.epoch, ratio: cache.ratio, status: cache.status, reductions: cache.reductions, exception: cache.exception };
  return { wire, notices, compactions, fit: first, verdict, audit, cache };
}

module.exports = { fit, buildWire };
