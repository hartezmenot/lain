'use strict';
/** ONE TURN. */

const provider = require('./provider');
const progress = require('./streamprogress');
const inflight = require('./inflight');
const errors = require('./errors');
const toolRegistry = require('./tools');

/** HOW MANY STEPS A TURN MAY TAKE BY DEFAULT: NO LIMIT. */
const DEFAULT_MAX_STEPS = 0;
/** THE RETRY SCHEDULE LIVES IN backoff.js — how many attempts, and how long between them. */
const { MAX_RETRIES, backoffFor, sleep } = require('./backoff');
/** How far to fold when a provider refuses on message COUNT. See msgfold.js. */
const msgfold = require('./msgfold');
/** The ONE place that knows what a provider will accept. */
const providerLimits = require('./providerlimits');
/** Making the payload fit before it is sent. See contextfit.js. */
const contextfit = require('./contextfit');
/** Accounting and the session's record of a finished turn. See turnclose.js. */
const turnclose = require('./turnclose');

/** The title the transient surface wears while compaction is speaking. */
const COMPACT_SURFACE = 'COMPACT';

/** WHAT LAIN IS DOING RIGHT NOW. */
const PHASE = Object.freeze({
  WAITING_MODEL: 'WAITING_MODEL',
  RECEIVING: 'RECEIVING',
  RUNNING_TOOL: 'RUNNING_TOOL',
  RETRYING: 'RETRYING',
  ENDED: 'ENDED',
});

/** THE RECORD ITSELF — its shape and its bounds — lives in turnrecord.js. */
const { newRecord, MAX_ACTIONS, MAX_REASONING, MAX_AUDITS } = require('./turnrecord');

// NAMING A CALL FOR A PERSON lives in describe.js — pure string work over the arguments, kept out of the loop that runs them.
const { describeTarget, firstLine, actionRecord, editSize, EMPTY_ANSWER } = require('./describe');
const reqtrace = require('./reqtrace');
const askgate = require('./askgate');

/** Announce the phase. A no-op when nobody listens, so headless runs pay nothing. */
function status(opts, phase, detail = {}) {
  if (opts && opts.onStatus) opts.onStatus({ phase, ...detail });
}


async function* runTurn(session, userInput, opts = {}) {
  let cfg = opts.cfg || {};
  let pc = provider.resolve(cfg); session._effortSeen = { effort: pc.effort || pc.lainEffort || null, explicit: Boolean(pc.effortExplicit) };   // the header names an explicit effort
  const record = newRecord(session.id, userInput, pc.model);
  // See `from` in turnrecord.js for why a turn has to know who asked for it.
  record.from = opts.from || null; record.typed = Boolean(opts.typed);
  const signal = opts.signal;
  // 0 = UNBOUNDED, and it is the default.
  const maxSteps = Math.max(0, Number(opts.maxSteps) || Number(cfg.maxSteps) || DEFAULT_MAX_STEPS);
  // Configurable, and bounded either way: a retry budget a config file can set
  // to a thousand is a spiral with a settings key.
  const maxRetries = Math.max(0, Math.min(10,
    Number(opts.maxConnectionRetries) || Number(cfg.maxConnectionRetries) || MAX_RETRIES));

  session.messages.push({ role: 'user', content: userInput, ts: new Date().toISOString() });
  inflight.begin(session, record, { from: opts.from || null });   // DURABLE FROM HERE: a force-close keeps the turn (inflight.js)

  // THE TURN'S SCRATCH — findings recorded during the turn survive its death; turnclose settles it.
  require('./scratch').open(session.cwd, session.id, { goal: userInput });

  // No credential is a setup instruction and must cost zero requests.
  const hint = provider.credentialHint(pc, cfg);
  if (hint) {
    record.stopReason = 'no-credential';
    record.errors.push({ kind: 'NO_CREDENTIAL', message: hint });
    yield { type: 'notice', level: 'warn', message: hint };
    // RECORDED BEFORE `done`, like every ending — see turnclose.close for what a skipped one does to the screen.
    turnclose.close(session, null, record);
    yield { type: 'done', record };
    return;
  }

  // The vocabulary follows the App (`computer` appears only while a transport is connected), in THE MODEL'S OWN
  // TOOL DIALECT (discipline/dialect.js): same operations, the vocabulary its family speaks.
  const full = require('./discipline/dialect').forTurn(session, opts.tools === false ? [] : toolRegistry.schemas(opts.app, { turn: true, session }), pc.model, cfg);
  const schemas = full;   // one schema shape for every profile (S5.1): a profile never changes the tools array
  { const grew = require('./simple').toolSetNote(session, schemas); if (grew) yield { type: 'notice', level: 'info', transient: true, message: grew }; }
  // `ask` lets ask_user reach the interaction panel.
  const toolCtx = {
    cwd: session.cwd, signal, session, ask: opts.ask || null, app: opts.app || null,
    checkpoints: opts.checkpoints || null, turnId: record.turnId, workOrder: opts.workOrder || null,
  };
  const avail = opts.availability || null;
  let connId = pc.connectionId || pc.provider || 'unknown', availModel = pc.canonicalModel || pc.model || '';   // both move with turnswitch
  let retries = 0;
  let foldedOnce = false;
  let emptyRetried = false;
  session.contextAuthority.touch({ reason: 'turn-started' });

  // CIRCUIT BREAKER, checked BEFORE any socket.
  if (avail) {
    const gate = avail.shouldAttemptFor(connId, availModel);
    if (!gate.allow) {
      const secs = Math.ceil((gate.retryAfterMs || 0) / 1000);
      // Skipped for a limit is still a limit, and it has a way out — see turnclose.skipped.
      const limited = Boolean(gate.rateLimited);
      record.stopReason = limited ? 'rate-limited' : 'provider';
      record.providerFailure = turnclose.skipped(pc, connId, gate, limited);
      yield {
        type: 'provider_failure', provider: pc.provider, connectionId: connId,
        kind: gate.status, message: gate.reason, skipped: true,
        hint: secs > 0
          ? `Not retrying automatically for ${secs}s. /provider retry ${connId} to try now.`
          : `/provider enable ${connId} to turn it back on.`,
      };
      // RECORDED BEFORE `done`, for the same reason. See turnclose.close.
      turnclose.close(session, null, record);
      yield { type: 'done', record };
      return;
    }
  }

  let wakeNote = '';   // the one hidden wake-up note, consumed by the next answered request
  // UNBOUNDED UNLESS THE USER ASKED FOR A BOUND.
  for (let step = 0; !maxSteps || step < maxSteps; step++) {
    if (signal && signal.aborted) { record.stopReason = 'aborted'; break; }
    record.steps = step + 1;

    const sw = step > 0 ? require('./turnswitch').next(opts, cfg, pc) : null;   // a model chosen mid-turn serves the next step
    if (sw) { ({ cfg, pc, connId, availModel } = sw); record.model = pc.model; yield { type: 'notice', level: 'info', message: sw.message }; }

    // A STEER IS DELIVERED HERE — between steps, immediately before the next request is built.
    for (const n of require('./steerqueue').deliver(session, record, opts, step)) yield n;

    // WILL THIS PROVIDER ACCEPT WHAT IS ABOUT TO BE SENT?
    { const cmp = await require('./compactor').maybe(session, cfg, { signal }); if (cmp) yield { type: 'notice', level: 'info', transient: true, message: require('./compactor').line(cmp) }; }   // S8: summary at the window threshold
    const fitted = contextfit.fit(session, pc, {
      systemPrompt: opts.systemPrompt,
      // THE HALF THAT CHANGES EVERY TURN, kept out of the cached prefix.
      live: [(step > 0 && typeof opts.liveContinuing === 'string' ? opts.liveContinuing : opts.live) || '', wakeNote,
        typeof opts.sideContext === 'function' ? await opts.sideContext(step) : ''].filter(Boolean).join('\n\n'),
      cfg,
      surface: COMPACT_SURFACE,
      // The schemas are part of the payload and a tenth of it; accounting that
      // left them out would understate every request by about 10,000 tokens.
      tools: schemas,
    });
    const wire = fitted.wire;
    record.compactions += fitted.compactions;
    // WHAT THIS REQUEST COST, AND OF WHAT.
    if (fitted.audit) {
      record.audits = record.audits || [];
      record.audits.push(fitted.audit);
      if (record.audits.length > MAX_AUDITS) record.audits.shift();
    }
    for (const n of fitted.notices) yield n;

    let text = '';
    let calls = [];
    let usage = null;
    let failure = null;
    let thought = false; let finish = null;
    let think = null;   // the thinking phase in progress (thinkphase.js)
    const tp = require('./thinkphase');
    const closeThink = (interrupted = false) => { const t = tp.close(record, think, step + 1, interrupted); think = null; return t; };

    // ANNOUNCED BEFORE THE AWAIT, not after it.
    const live = progress.begin(); live.model = pc.canonicalModel || pc.model || '';   // the live row: `Waiting for GLM 5.3`
    status(opts, PHASE.WAITING_MODEL, { step: step + 1, live });

    // THE REQUEST BOUNDARY: the runtime admits BEFORE the wire; a denial means the provider is never called.
    const shut = require('./providerhealth').routeShut(connId);
    const gate = shut ? { allow: false, reason: shut } : null;
    // ABORT, RECHECKED AFTER THE AWAIT — it is the window a cancel lands in
    if (signal && signal.aborted) { record.stopReason = 'aborted'; break; }
    if (gate && gate.allow === false) {
      const word = /^([A-Z_]+):/.exec(String(gate.reason || '')) || [];
      failure = { kind: word[1] || 'RUNTIME_REFUSED', retriable: false, layer: 'runtime',
        message: String(gate.reason || 'the runtime refused this request') };
    }

    try {
      if (!failure) {
      record.usage.requests += 1;
    const trace = reqtrace.forStep(record.turnId, step + 1, {});
      for await (const ev of provider.chat(pc, wire, { tools: schemas, signal, trace, live, sessionId: session.id, taskId: session.task ? session.task.id : null, cwd: session.cwd, role: session.thread === 'chat' ? 'bot' : 'agent', origin: record.from === 'messaging' ? 'telegram' : null })) {   // role: a Chat-view turn is the BOT's
        if (signal && signal.aborted) break;
        if (!ev) continue;
        if (ev.type === 'text') {
          if (think) yield { type: 'thought', thought: closeThink() };
          if (!text) status(opts, PHASE.RECEIVING, { step: step + 1, live });
          progress.text(live, ev.chunk);
          text += ev.chunk || '';
          yield { type: 'text', chunk: ev.chunk || '' };
        } else if (ev.type === 'reasoning') {
          // Reasoning stays out of `text` (the answer); the screen shows it while it streams and then folds it.
          if (!text && !thought) status(opts, PHASE.RECEIVING, { step: step + 1, live });
          const chunk = String(ev.chunk || '');
          progress.reasoning(live, chunk.length);
          progress.thought(live, chunk);
          if (chunk.trim()) thought = true;
          think = tp.add(think, chunk);
          record.reasoningChars = (record.reasoningChars || 0) + chunk.length;
          if ((record.reasoning || '').length < MAX_REASONING) record.reasoning = (record.reasoning || '') + chunk;
          yield { type: 'reasoning', chunk, hidden: Boolean(ev.hidden) };
        } else if (ev.type === 'tool_calls') { if (think) yield { type: 'thought', thought: closeThink() }; calls = Array.isArray(ev.calls) ? ev.calls : []; }
        else if (ev.type === 'usage') usage = ev; else if (ev.type === 'finish') finish = ev.reason;
        // A reading of the open request's input, passed through and never added to the receipt.
        else if (ev.type === 'usage_live') yield { type: 'usage_live', ...ev };
      }
      }
    } catch (e) {
      if (signal && signal.aborted) { record.stopReason = 'aborted'; if (think) yield { type: 'thought', thought: closeThink(true) }; break; } // the person stopped it: no provider failure
      if (!errors.isProviderFailure(e)) throw e; // a real bug keeps its stack
      // `explain` carries the SENTENCE naming the layer, so no screen downstream
      // can show a provider's 429 as though LAIN had malfunctioned.
      failure = errors.explain(e);
    } finally {
      // (the attempt's receipt is the usage record — usage.js — and nothing else is told)
    }

    // THE THINKING PHASE ENDS WITH THE REQUEST; its exact token count, when the provider reports one, arrives with the receipt.
    if (think) yield { type: 'thought', thought: closeThink(Boolean(signal && signal.aborted)) };
    tp.settle(record, step + 1, usage);
    // AN EMPTY REPLY IS NOT AN ANSWER: it settled as DONE, so every next prompt
    // got another instant DONE and read as swallowed. One retry, then a provider failure.
    if (!failure && !(signal && signal.aborted) && !text.trim() && !calls.length && !thought) {
      failure = { kind: errors.KIND.UNAVAILABLE, layer: 'provider', empty: true, retriable: !emptyRetried,
        message: 'the provider returned an empty response — no text, no tool calls, no reasoning' };
      emptyRetried = true;
    }
    // An empty body proves the route ANSWERED; counted, it opened the breaker and later prompts went unsent.
    if (avail && !(failure && failure.empty)) { avail.noteOutcome(connId, availModel, failure || null); }
    // A STALL AFTER THE REPLY STARTED: the text is kept and the step resumed (finish.js), not the turn ended.
    if (require('./finish').resumable(failure, text, calls, record)) { finish = 'stalled'; failure = null; yield { type: 'notice', level: 'warn', transient: true, message: 'STREAM STALLED · the provider went silent mid-reply · resuming from what it said' }; }
    if (failure) {
      // TOO MANY MESSAGES IS A DIFFERENT REFUSAL, AND HAS A FIX
      if (failure.kind === errors.KIND.CONTEXT_LIMIT
          && failure.limitKind === errors.LIMIT.MESSAGES
          && !foldedOnce && !text.trim()) {
        foldedOnce = true;
        // WHAT THE REFUSAL TAUGHT US IS WORTH KEEPING
        providerLimits.learn(pc, { messages: Number(failure.maxMessages) || 0 });
        // SAY IT IS HAPPENING BEFORE IT HAPPENS.
        yield { type: 'notice', level: 'info', surface: COMPACT_SURFACE, working: true,
          message: `over this provider's ${failure.maxMessages || 'message'} limit — folding the oldest exchanges…` };
        // HOW FAR TO FOLD lives in msgfold.js — including what to do when the provider's count and LAIN's disagree, which is the case that used to make this…
        const stated = Number(failure.maxMessages) || 0;
        const cap = msgfold.capFor(session.messages.length, stated);
        const authority = session.contextAuthority;
        const recoveryId = authority.beginCompaction({ reason: `provider-message-limit:${stated}` });
        const fold = recoveryId
          ? session.compact({ maxMessages: cap, force: true })
          : { folded: 0, beforeMessages: session.messages.length, afterMessages: session.messages.length };
        if (recoveryId) authority.finishCompaction(recoveryId);
        if (recoveryId && fold.folded > 0) {
          record.compactions += 1;
          // INTO THE SAME BOX, AND THE BOX THEN CLOSES ITSELF
          yield {
            type: 'notice',
            level: 'info',
            surface: COMPACT_SURFACE,
            message: msgfold.foldedMessage(fold, stated, cap),
          };
          // THE SAME STEP, not the next one.
          step -= 1;
          continue;
        }
        // NOTHING COULD BE FOLDED — and the busy surface must be released even
        // so. See msgfold.stuckMessage for what that silence used to cost.
        yield {
          type: 'notice',
          level: 'warn',
          surface: COMPACT_SURFACE,
          message: msgfold.stuckMessage(session.messages.length),
        };
        // And it does NOT retry into the same wall: everything left is work,
        // and dropping it would lose the task rather than the history.
      }
      // Retry the SAME step for a transient failure, with a bounded budget.
      const rl = require('./ratelimit');
      if (rl.worthAsking(failure) && !text.trim()) {
        record.stopReason = 'rate-limited';
        record.providerFailure = {
          provider: pc.provider, model: pc.canonicalModel || cfg.model || pc.model,
          connectionId: connId,
          kind: failure.kind,
          message: failure.message,
          retryAfterMs: failure.retryAfterMs,
          resumeAt: Date.now() + failure.retryAfterMs,
        };
        break;
      }

      if (failure.retriable && retries < maxRetries && !text.trim()) {
        retries += 1;
        // ONE POLICY, in backoff.js: MAX(schedule, trustworthy provider hint), so a provider can make LAIN wait longer but never shorter.
        const waitMs = backoffFor(retries, failure.retryAfterMs);
        // A 20-second rate-limit wait with a silent screen is indistinguishable from a hang, so the wait says what it is and how long it will be.
        const resumeAt = Date.now() + waitMs;
        status(opts, PHASE.RETRYING, {
          attempt: retries, of: maxRetries, waitMs, resumeAt,
          rateLimited: failure.kind === errors.KIND.RATE_LIMITED,
          // WHAT FAILED, not merely that something did.
          kind: failure.kind,
          status: failure.status || null,
          reason: failure.message,
        });
        // TRANSIENT, AND COMPACT
        yield {
          type: 'notice',
          level: 'warn',
          transient: true,
          message: `${errors.retryWord(failure)} · ${errors.shortReason(failure)} · retry in `
            + `${Math.round(waitMs / 1000)}s · ${retries}/${maxRetries}`,
        };
        await sleep(waitMs, signal, opts.timers || null);  // timers: test seam, see backoff.js
        // Escape (or Ctrl+C) during the wait aborts the signal.
        if (signal && signal.aborted) { record.stopReason = 'aborted'; break; }
        // AND THE END OF THE WAIT IS A TRANSIENT TOO: on a TUI `Ⅱ Rate limited` simply becomes `◐ Receiving` and this row is superseded; on a pipe it is the…
        yield { type: 'notice', level: 'info', transient: true, message: 'Resuming' };
        step -= 1;
        continue;
      }
      // THE WHOLE CLASSIFICATION, not a hand-listed subset of it: a field enumerated here is one somebody has to remember to add, and spreading it cannot…
      record.errors.push({ ...failure, status: failure.status || null });
      record.providerFailure = { provider: pc.provider, ...failure };
      record.stopReason = 'provider';
      yield { type: 'provider_failure', provider: pc.provider, ...failure };
      break;
    }

    wakeNote = '';
    if (usage) {
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'promptTokens']) record.usage[k] = (record.usage[k] || 0) + (usage[k] || 0); if (Number.isFinite(usage.reasoningTokens)) record.usage.reasoningTokens = (record.usage.reasoningTokens || 0) + usage.reasoningTokens;   // reasoning only when STATED
    } require('./cacheledger').settle(session, fitted.cache, usage, pc);   // expected (cachebudget) vs billed, per request
    if (text.trim()) {
      record.text += (record.text ? '\n' : '') + text.trim();
      // Keep WHICH step said it.
      if (record.narration.length < MAX_ACTIONS) {
        record.narration.push({ step, text: text.trim(), at: Date.now() });
      }
    }

    const normalized = require('./toolcalls').normalize(calls, step);

    if (text.trim() || normalized.length) {
      const asst = { role: 'assistant', content: text.trim(), ts: new Date().toISOString() };
      if (normalized.length) {
        asst.tool_calls = normalized.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.input) }));
      }
      session.messages.push(asst);
    }
    inflight.step(session, step);

    if (signal && signal.aborted) {
      for (const c of normalized) {
        session.messages.push({ role: 'tool', tool_call_id: c.id, content: 'interrupted by the user before this ran', isError: true });
      }
      record.stopReason = 'aborted';
      break;
    }

    // No tool calls: the GENERATION ended (RESPONSE_ENDED). Whether the TURN ends, and the TASK, is decided below and elsewhere.
    if (!normalized.length) {
      const cut = require('./finish').onCut(record, finish);   // a length cut or refusal is not a natural end (finish.js)
      if (cut === 'continue') { wakeNote = require('./finish').continueNote(finish); continue; } else if (cut) { record.stopReason = cut; break; }
      record.stopReason = record.stopReason || 'end';
      // A TURN THAT SAID NOTHING MUST NOT LOOK LIKE ONE THAT DID — see describe.EMPTY_ANSWER.
      if (!record.text.trim() && !record.toolCalls && !record.reasoningChars) {
        yield { type: 'notice', level: 'warn', message: EMPTY_ANSWER };
      }
      break;
    }

    const gated = askgate.cut(normalized);   // a question ends the step — askgate.js
    const pre = require('./toolstep').prefetch(gated.run, { session, evidence: opts.evidence || null, toolCtx }, require('./profile').concurrency(require('./profile').of(session, cfg)));   // FAST/NORMAL: independent reads start together
    for (const c of gated.run) {
      if (signal && signal.aborted) {
        session.messages.push({ role: 'tool', tool_call_id: c.id, content: 'interrupted by the user before this ran', isError: true });
        continue;
      }
      yield { type: 'tool_start', id: c.id, name: c.name, input: c.input };
      status(opts, PHASE.RUNNING_TOOL, { tool: c.name, target: describeTarget(c.name, c.input), label: require('./describe').liveLabel(c.name, c.input, toolCtx.app) });
      inflight.beforeTool(session, c, describeTarget(c.name, c.input));   // on disk BEFORE any effect

      // EVIDENCE, RECEIPTS AND THE TRANSACTION live in toolstep.js: an unchanged read may be served without re-running,
      // and a source write goes through the mutation lifecycle, which captures and settles its own checkpoint.
      const startedMs = Date.now();
      const { result, substitute, checkpoint } = await (pre.get(c.id) || require('./toolstep').run(c, { session, evidence: opts.evidence || null, toolCtx }));
      if (substitute) record.evidenceReuse += 1;

      // One bounded line per call, for the ACTIVITY view — see describe.js.
      if (record.actions.length < MAX_ACTIONS) {
        // See describe.js `editSize`: the RECORD carries the +/- counts, not the feed.
        const size = editSize(opts.checkpoints, checkpoint);
        record.actions.push(actionRecord(c, result, { step, ms: Date.now() - startedMs, reused: Boolean(substitute), ...size }));
      }


      record.toolCalls += 1;                       // TURN-WIDE accumulation
      if (!record.toolNames.includes(c.name)) record.toolNames.push(c.name);
      for (const m of result.mutated || []) if (!record.mutations.includes(m)) record.mutations.push(m);
      if (result.isError) record.errors.push({ kind: 'TOOL', tool: c.name, message: `${c.name}: ${String(result.output).slice(0, 200)}`, denied: Boolean(result.denied), fatal: Boolean(result.fatal) });   // turnoutcome.js reads both flags

      // Every call gets a result message. An unanswered tool_call is a 400
      // everywhere, and a silent one makes the model believe it succeeded.
      session.messages.push({
        role: 'tool',
        tool_call_id: c.id,
        content: require('./toolbudget').bound(c.name, c.input, result, { cfg, session }),   // bounded as it ENTERS; raw kept by receipt
        isError: Boolean(result.isError),
        ts: new Date().toISOString(),
      });
      inflight.afterTool(session, c, result);

      // `input` travels with the result so a consumer can label it without
      // having to remember what it saw at tool_start.
      yield { type: 'tool_result', id: c.id, name: c.name, input: c.input, output: result.output, isError: Boolean(result.isError), exitCode: result.exitCode == null ? null : result.exitCode, meta: result.meta || null, size: record.actions.length ? record.actions[record.actions.length - 1] : null };

    }
    askgate.answerDeferred(session, gated.deferred);

    session.contextAuthority.touch({
      reason: `step-result:${record.turnId}:${step}`,
    });

    // ONLY WHEN THE USER SET A BOUND. With `maxSteps` unset this never fires, and the loop never ends on a count —
    // `max-steps` means "the limit YOU configured was reached", a different sentence from the one it used to mean.
    if (maxSteps && step === maxSteps - 1) record.stopReason = 'max-steps';
  }

  // THE TURN IS OVER: account for it, and remember it. Both live in
  // turnclose.js, which contacts no provider and decides nothing.
  turnclose.close(session, null, record);

  status(opts, PHASE.ENDED, { stopReason: record.stopReason });
  yield { type: 'done', record };
}

module.exports = { runTurn, PHASE, DEFAULT_MAX_STEPS, newRecord, describeTarget, MAX_ACTIONS };
