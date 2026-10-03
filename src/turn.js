'use strict';
/**
 * ONE TURN.
 *
 * A turn is: the user said something, and the model works — taking as many
 * steps as it needs, calling whatever tools it chooses in whatever order — until
 * it stops asking for tools. The whole exchange is ONE turn with ONE record.
 *
 * TWO INVARIANTS THIS FILE EXISTS TO HOLD
 *
 * 1. THE TOOL PROTOCOL STAYS IN THE CONVERSATION. The assistant turn is pushed
 *    carrying its tool_calls, and every result is pushed as a `tool` message
 *    matched by id. Nothing is built in a local array and discarded. The next
 *    request therefore replays what this one actually did.
 *
 * 2. TOOL WORK IS COUNTED ACROSS THE WHOLE TURN, NOT THE LAST STEP. A turn that
 *    ran ten tools and closed with "Step 2 is complete, I'll continue with
 *    Step 3" did ten tools' worth of work. V1 scored that as a zero-tool
 *    narration turn and drove its progress tracker to a stop; three productive
 *    turns in a row could end with `continue` producing nothing. `record.toolCalls`
 *    is the turn total and is what any later liveness/lifecycle logic must read.
 *
 * A provider failure is REPORTED, never thrown: the generator always yields a
 * terminal `done` event, so the REPL always gets control back. Real programming
 * errors still throw, or we would lose the stack traces that matter.
 */

const provider = require('./provider');
const progress = require('./streamprogress');
const inflight = require('./inflight');
const errors = require('./errors');
const toolRegistry = require('./tools');

/**
 * HOW MANY STEPS A TURN MAY TAKE BY DEFAULT: NO LIMIT. It was 30, and thirty
 * was an opinion — a turn ended as `STEP LIMIT` with the work unfinished
 * because a counter reached a number nobody chose for the task in hand.
 *
 * Every other ending is a fact about the world rather than about a variable.
 * The count survives as telemetry; only its authority is gone. A CONFIGURED
 * `maxSteps` is still honoured — that is a person capping their own spend. The
 * full argument is in config.js, where the default lives.
 */
const DEFAULT_MAX_STEPS = 0;
/**
 * THE RETRY SCHEDULE LIVES IN backoff.js — how many attempts, and how long
 * between them. It is a pure question with no reference to a turn, so it sits
 * outside this file; what stays here is the decision to USE it, which is the
 * loop's business. See that file for why the retry is not an LLM retry loop.
 */
const { MAX_RETRIES, backoffFor, sleep } = require('./backoff');
/** How far to fold when a provider refuses on message COUNT. See msgfold.js. */
const msgfold = require('./msgfold');
/** The ONE place that knows what a provider will accept. */
const providerLimits = require('./providerlimits');
/** Making the payload fit before it is sent. See contextfit.js. */
const contextfit = require('./contextfit');
/** Accounting and the session's record of a finished turn. See turnclose.js. */
const turnclose = require('./turnclose');

/**
 * The title the transient surface wears while compaction is speaking.
 *
 * ONE CONSTANT, because the surface is keyed by title: two spellings would open
 * two surfaces for one subject and the second would wipe the first's lines.
 */
const COMPACT_SURFACE = 'COMPACT';

/**
 * WHAT LAIN IS DOING RIGHT NOW.
 *
 * The turn loop is the only thing that knows this, so it is the only thing that
 * says it. Each phase is announced from the exact point in the loop where it
 * becomes true — never inferred afterwards, never guessed from a timer.
 *
 * This vocabulary already existed here as bare strings passed to `onStatus`,
 * and NOTHING EVER PASSED AN `onStatus`. The loop computed "what am I doing"
 * before every provider call and every tool, and threw it away — which is
 * exactly why the screen could go quiet for a minute with no way to tell a
 * working LAIN from a dead one.
 *
 *   WAITING_MODEL  the request is out and nothing has come back yet. This is
 *                  the long, silent one, and the reason this exists at all.
 *   RECEIVING      bytes are arriving; the model is producing.
 *   RUNNING_TOOL   a tool is executing on this machine.
 *   RETRYING       a transient provider failure; waiting before another attempt.
 *   ENDED          the loop is finished. Not a claim about success.
 */
const PHASE = Object.freeze({
  WAITING_MODEL: 'WAITING_MODEL',
  RECEIVING: 'RECEIVING',
  RUNNING_TOOL: 'RUNNING_TOOL',
  RETRYING: 'RETRYING',
  ENDED: 'ENDED',
});

/**
 * THE RECORD ITSELF — its shape and its bounds — lives in turnrecord.js. This
 * file RUNS a turn; that one declares what a run writes into. See its header
 * for why the two are apart.
 */
const { newRecord, MAX_ACTIONS, MAX_REASONING, MAX_AUDITS } = require('./turnrecord');

// NAMING A CALL FOR A PERSON lives in describe.js — pure string work over the
// arguments, kept out of the loop that runs them. Re-exported below, because
// turnevents.js and the tests have always imported it from here.
const { describeTarget, firstLine, actionRecord, editSize, EMPTY_ANSWER } = require('./describe');
const reqtrace = require('./reqtrace');
const askgate = require('./askgate');

/** Announce the phase. A no-op when nobody listens, so headless runs pay nothing. */
function status(opts, phase, detail = {}) {
  if (opts && opts.onStatus) opts.onStatus({ phase, ...detail });
}

/**
 * @param {Session} session   MUTATED — the tool protocol is appended to it
 * @param {string}  userInput
 * @param {object}  opts  cfg, systemPrompt, signal, maxSteps, onStatus
 */

async function* runTurn(session, userInput, opts = {}) {
  let cfg = opts.cfg || {};
  let pc = provider.resolve(cfg); session._effortSeen = { effort: pc.effort || pc.lainEffort || null, explicit: Boolean(pc.effortExplicit) };   // the header names an explicit effort
  const record = newRecord(session.id, userInput, pc.model);
  // See `from` in turnrecord.js for why a turn has to know who asked for it.
  record.from = opts.from || null; record.typed = Boolean(opts.typed);
  const signal = opts.signal;
  // 0 = UNBOUNDED, and it is the default. A number here came from the caller or
  // from the user's config — see DEFAULT_MAX_STEPS for why LAIN no longer picks
  // one. `Math.max(0, …)` rather than `Math.max(1, …)`, because clamping zero
  // up to one would turn "no limit" into "one step" and stop every turn dead.
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
    // RECORDED BEFORE `done`, like every ending — see turnclose.close for what
    // a skipped one does to the screen. `opts.lifecycle` rather than `life`:
    // this exit happens before that binding exists.
    turnclose.close(session, opts.lifecycle || null, record);
    yield { type: 'done', record };
    return;
  }

  // The vocabulary follows the App (`computer` appears only while a transport is connected), in THE MODEL'S OWN
  // TOOL DIALECT (discipline/dialect.js): same operations, the vocabulary its family speaks.
  const full = require('./discipline/dialect').forTurn(session, opts.tools === false ? [] : toolRegistry.schemas(opts.app, { turn: true, session }), pc.model, cfg);
  const schemas = full;   // one schema shape for every profile (S5.1): a profile never changes the tools array
  { const grew = opts.simple ? require('./simple').toolSetNote(session, schemas) : null; if (grew) yield { type: 'notice', level: 'info', transient: true, message: grew }; }
  // `ask` lets ask_user reach the interaction panel. Absent on non-interactive
  // runs, where the tool says so rather than hanging.
  // `app` is here for ONE tool: `computer`, which must reach the permission gate
  // to ask the user before anything touches the screen, the mouse or the
  // keyboard. No other tool reads it, and a turn run without an app simply has
  // no reach into the machine at all.
  // `checkpoints` and `turnId` ride here because the mutation transaction
  // (mutation.js) owns the checkpoint now; `workOrder` binds a bounded worker.
  const toolCtx = {
    cwd: session.cwd, signal, session, ask: opts.ask || null, app: opts.app || null,
    checkpoints: opts.checkpoints || null, turnId: record.turnId, workOrder: opts.workOrder || null,
  };
  const life = opts.lifecycle || null;
  const avail = opts.availability || null;
  let connId = pc.connectionId || pc.provider || 'unknown', availModel = pc.canonicalModel || pc.model || '';   // both move with turnswitch
  let retries = 0;
  let foldedOnce = false;
  let emptyRetried = false;
  session.contextAuthority.touch({ reason: 'turn-started' });

  // CIRCUIT BREAKER, checked BEFORE any socket. A route already known to be
  // down — or that the user disabled or put in maintenance — is skipped
  // instantly, costing zero requests and zero waiting.
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
      turnclose.close(session, life, record);
      yield { type: 'done', record };
      return;
    }
  }

  // WHICH LOOP THE USER HAS BEEN TOLD ABOUT — a fingerprint, or null.
  //
  // Held for the turn so the advisory is raised ONCE per loop and RETRACTED the
  // moment the model does something new. Re-raising it every step would make it
  // flicker; never clearing it would leave a warning about a solved problem on
  // screen. See looping.js.
  let toldAbout = null;
  let wakeNote = '';   // the one hidden wake-up note, consumed by the next answered request
  // UNBOUNDED UNLESS THE USER ASKED FOR A BOUND. The turn ends when the model
  // stops asking for tools, when the user stops it, or when the provider or the
  // transport makes it impossible — see DEFAULT_MAX_STEPS. A step count is not
  // one of those things.
  for (let step = 0; !maxSteps || step < maxSteps; step++) {
    if (signal && signal.aborted) { record.stopReason = 'aborted'; break; }
    record.steps = step + 1;

    const sw = step > 0 ? require('./turnswitch').next(opts, cfg, pc) : null;   // a model chosen mid-turn serves the next step
    if (sw) { ({ cfg, pc, connId, availModel } = sw); record.model = pc.model; yield { type: 'notice', level: 'info', message: sw.message }; }

    // A STEER IS DELIVERED HERE — between steps, immediately before the next
    // request is built. That is the "next safe model interaction": the previous
    // step's tool results are already in the conversation, nothing is half
    // written, and the model sees the correction as the most recent thing said
    // to it. It does NOT start a second turn, does not touch the plan, and
    // cannot arrive in the middle of a tool call.
    for (const n of require('./steerqueue').deliver(session, record, opts, step)) yield n;

    // ---- WILL THIS PROVIDER ACCEPT WHAT IS ABOUT TO BE SENT? --------------
    //
    // Immediately before the send, because that is the only moment the real
    // size is known, and it costs no request — it is local string work.
    //
    // The measuring and folding live in contextfit.js: a payload has to pass a
    // character budget AND a message-count cap, which are unrelated quantities,
    // and this file had grown past the god-object guard carrying both. What
    // stays here is the decision to ASK, which is the loop's business.
    const fitted = contextfit.fit(session, pc, {
      systemPrompt: opts.systemPrompt,
      // THE HALF THAT CHANGES EVERY TURN, kept out of the cached prefix. See
      // promptparts.js; absent for a caller that does not split, which then
      // behaves exactly as before.
      live: [(step > 0 && typeof opts.liveContinuing === 'string' ? opts.liveContinuing : opts.live) || '', wakeNote,
        typeof opts.sideContext === 'function' ? await opts.sideContext(step) : ''].filter(Boolean).join('\n\n'),
      cfg,
      surface: COMPACT_SURFACE,
      // The schemas are part of the payload and a tenth of it; accounting that
      // left them out would understate every request by about 10,000 tokens.
      tools: schemas, simple: Boolean(opts.simple),
    });
    const wire = fitted.wire;
    record.compactions += fitted.compactions;
    // WHAT THIS REQUEST COST, AND OF WHAT. Kept on the record rather than
    // printed, so the turn stays quiet and `/tokens` can answer later. Only
    // the most recent few are held: this is a diagnostic, not a log.
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

    // ANNOUNCED BEFORE THE AWAIT, not after it. The request below can take a
    // minute; saying "waiting" once it returns would be a report, not a status.
    // LIVENESS: one record per request, filled from the wire (streamprogress.js)
    // and read by the screen on the frames it already draws.
    const live = progress.begin(); live.model = pc.canonicalModel || pc.model || '';   // the live row: `Waiting for GLM 5.3`
    status(opts, PHASE.WAITING_MODEL, { step: step + 1, live });

    // THE REQUEST BOUNDARY: the runtime admits BEFORE the wire; a denial means
    // the provider is never called. Retries re-enter here, so every real
    // provider attempt gets its own request lifecycle. See guardian.js.
    // A ROUTE ANOTHER PROCESS LEARNED IS RATE LIMITED stays shut here too (providerhealth.routeShut — a file read,
    // no IPC). Nothing on the request path waits for another process.
    const shut = require('./providerhealth').routeShut(connId);
    const gate = shut ? { allow: false, reason: shut } : null;
    // ABORT, RECHECKED AFTER THE AWAIT — it is the window a cancel lands in
    // (measured: a cancelled job's suspended turn walked past it into the wire
    // and ate a later test's provider step). A cancelled turn issues NOTHING.
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
      // ---- TOO MANY MESSAGES IS A DIFFERENT REFUSAL, AND HAS A FIX -------
      //
      // Reported live on 2026-08-22: omniroute answered 413
      // `chat_history_too_large / message_limit` — "Chat history exceeds the
      // 800-message limit; compact the conversation and retry." LAIN compacted,
      // truthfully said "Nothing to elide — 291k chars", and was refused again
      // on every following request. Compaction only ever shortened BODIES, and
      // a thousand short messages are still a thousand messages, so the one
      // tool built to rescue the session had no lever on the limit it hit.
      //
      // THIS IS NOT THE TRANSPORT RETRY and must never be folded into it. The
      // request is not re-sent unchanged: the conversation is made SMALLER
      // first, and only if that actually removed messages is anything sent
      // again. It happens ONCE per step — a second identical refusal means the
      // fold could not reach far enough, and trying again would be the
      // token-burning loop the design forbids.
      if (failure.kind === errors.KIND.CONTEXT_LIMIT
          && failure.limitKind === errors.LIMIT.MESSAGES
          && !foldedOnce && !text.trim()) {
        foldedOnce = true;
        // ---- WHAT THE REFUSAL TAUGHT US IS WORTH KEEPING ------------------
        //
        // A 413 that names its own cap is the provider stating a fact about
        // itself, and it is the ONLY source of that fact that cannot be out of
        // date. Remembered here, every later request in this process is checked
        // against the real number before it is built — so a route whose limit
        // LAIN did not know is learned once, from one refusal, instead of
        // being rediscovered on every long conversation. See providerlimits.
        providerLimits.learn(pc, { messages: Number(failure.maxMessages) || 0 });
        // SAY IT IS HAPPENING BEFORE IT HAPPENS. Folding a very long history is
        // the one compaction that takes long enough to see, and a screen that
        // goes quiet after a refusal — then reports a finished fold — showed the
        // user nothing at the moment they were most likely to think LAIN had
        // died. `working` is cleared by whatever notice follows.
        yield { type: 'notice', level: 'info', surface: COMPACT_SURFACE, working: true,
          message: `over this provider's ${failure.maxMessages || 'message'} limit — folding the oldest exchanges…` };
        // HOW FAR TO FOLD lives in msgfold.js — including what to do when the
        // provider's count and LAIN's disagree, which is the case that used to
        // make this whole branch a no-op.
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
          // ---- INTO THE SAME BOX, AND THE BOX THEN CLOSES ITSELF -----------
          //
          // This was a `note`, which is a CONVERSATION line — so the fold
          // announced itself on the bottom surface and then reported its result
          // into the transcript, where "folded 214 messages" sat permanently
          // between two things the user actually said. The surface it opened
          // was never released either, because only a `notice` addressed to the
          // same surface clears `working`, so the box hung on "working…" for
          // the rest of the session.
          //
          // One subject, one box: the announcement and the result are the same
          // event, so the result replaces the announcement and auto-closes with
          // it. Nobody has to press Esc to dismiss LAIN's own housekeeping.
          yield {
            type: 'notice',
            level: 'info',
            surface: COMPACT_SURFACE,
            message: msgfold.foldedMessage(fold, stated, cap),
          };
          // THE SAME STEP, not the next one. `continue` alone would let the
          // loop increment and spend a step of the budget on a request that
          // was never answered — the conversation got smaller, the work did
          // not advance. Same reason the transient retry does it.
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
      // Anything already streamed is kept.
      // NOTHING STREAMED YET is the condition, and it is about correctness:
      // once bytes of an answer have arrived, re-sending would duplicate them.
      // ---- A LIMIT MEASURED IN HOURS IS A DECISION, NOT A RETRY ------------
      //
      // The retry below is right for a limit that clears in seconds. A real
      // router handed LAIN "retry in 4 hours" — sitting in that retry is a
      // LAIN that looks alive and spends its budget before the limit clears.
      // The turn ENDS instead, carrying when it clears; app.js asks the only
      // two useful questions (wait, or change model). See ratelimit.js.
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
        // ONE POLICY, in backoff.js: MAX(schedule, trustworthy provider hint),
        // so a provider can make LAIN wait longer but never shorter. The
        // hardcoded 20s rate-limit branch that used to live here is gone.
        const waitMs = backoffFor(retries, failure.retryAfterMs);
        // A 20-second rate-limit wait with a silent screen is indistinguishable
        // from a hang, so the wait says what it is and how long it will be.
        // WHEN, not just how long. A duration answers "how long do I wait";
        // an absolute time answers "can I go and do something else" — and the
        // second is the question a person actually has. Both are sent, because
        // the countdown is what makes a long wait legible while it happens.
        const resumeAt = Date.now() + waitMs;
        status(opts, PHASE.RETRYING, {
          attempt: retries, of: maxRetries, waitMs, resumeAt,
          rateLimited: failure.kind === errors.KIND.RATE_LIMITED,
          // WHAT FAILED, not merely that something did. A gateway timeout and
          // a refused model are different problems with different fixes, and
          // a screen that calls both "retrying" makes the user debug the
          // wrong half. See ui/status.js.
          kind: failure.kind,
          status: failure.status || null,
          reason: failure.message,
        });
        // ---- TRANSIENT, AND COMPACT ---------------------------------------
        //
        // It was DURABLE and carried the provider's whole body — `WARN omniroute:
        // 503 … {"error":{…}} retry 4/5 at 16:17:24 (6s)` — every field of which the
        // live row already draws, and replaces when the wait ends. `transient` sends
        // it to the operation row on a TUI and to one dim line on a pipe, which has
        // no such row and must not fall silent for sixty seconds. The raw payload
        // stays on `record.errors` for /status. See turnevents.js.
        yield {
          type: 'notice',
          level: 'warn',
          transient: true,
          message: `${errors.retryWord(failure)} · ${errors.shortReason(failure)} · retry in `
            + `${Math.round(waitMs / 1000)}s · ${retries}/${maxRetries}`,
        };
        await sleep(waitMs, signal, opts.timers || null);  // timers: test seam, see backoff.js
        // Escape (or Ctrl+C) during the wait aborts the signal. Say that the
        // wait ended because it was cancelled, not because the provider came
        // back — the two look identical from here otherwise.
        if (signal && signal.aborted) { record.stopReason = 'aborted'; break; }
        // AND THE END OF THE WAIT IS A TRANSIENT TOO: on a TUI `Ⅱ Rate limited`
        // simply becomes `◐ Receiving` and this row is superseded; on a pipe it is
        // the one line that says the gap is over. Either way a recovery the user
        // need not act on leaves no trace in the conversation.
        yield { type: 'notice', level: 'info', transient: true, message: 'Resuming' };
        step -= 1;
        continue;
      }
      // THE WHOLE CLASSIFICATION, not a hand-listed subset of it: a field
      // enumerated here is one somebody has to remember to add, and spreading
      // it cannot forget. Context reads `limitKind`/`layer` to draw failures.
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
    const repeatsFinal = !opts.simple && require('./finish').repeatsFinal(session.messages, text, calls);   // legacy: one completion per turn (finish.js)
    if (repeatsFinal) record.repeatedFinal = (record.repeatedFinal || 0) + 1;
    if (text.trim() && !repeatsFinal) {
      record.text += (record.text ? '\n' : '') + text.trim();
      // Keep WHICH step said it. The activity view interleaves prose with the
      // calls that followed it, which is the difference between a narrative and
      // two stacked lists.
      //
      // `at` IS A DISPLAY STAMP, and it is here so a paragraph does not TELEPORT
      // when the turn ends. Prose is presented from the moment it was said (see
      // ui/reveal.js), and the live copy of it — ui/story.js `noteNarration` —
      // is cleared the instant `endTurn` hands the feed back to this record. A
      // paragraph still resolving at that moment therefore lost the one thing
      // the presentation is a function of, and snapped to full: half a second of
      // motion followed by the rest of the answer appearing at once, which is
      // the "magician effect" the brief names.
      //
      // Carrying the stamp across the handover is the whole of the fix: the
      // record now says WHEN as well as WHAT, so the same pure function keeps
      // returning the same frames either side of the boundary. It changes
      // nothing else — the text, the step and the order are untouched, and a
      // record without a stamp (every session saved before this) is drawn
      // settled, which is what it is.
      if (record.narration.length < MAX_ACTIONS) {
        record.narration.push({ step, text: text.trim(), at: Date.now() });
      }
    }

    const normalized = require('./toolcalls').normalize(calls, step);

    if ((text.trim() && !repeatsFinal) || normalized.length) {
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
      // AN EXECUTION TURN THAT WENT IDLE gets ONE hidden wake-up on the
      // framed tail, never a user message. See wakeup.js.
      const idle = opts.simple ? null : require('./wakeup').decide(record, text, { required: Boolean(opts.requiresExecution) && record.from !== 'goal-continue', wakeups: record.wakeups || 0, cls: opts.taskClass || null, smoke: require('./finalsmoke').state(life, session.cwd), readOnly: require('./readonly').active((opts.app && opts.app.session) || session) });
      if (idle === 'wake') { record.wakeups = (record.wakeups || 0) + 1; wakeNote = require('./wakeup').noteFor(record); continue; }
      if (idle === 'no-progress') record.stopReason = 'no-progress';
      record.stopReason = record.stopReason || 'end';
      // A TURN THAT SAID NOTHING MUST NOT LOOK LIKE ONE THAT DID — see
      // describe.EMPTY_ANSWER. Only when all three are empty: a model that
      // reasoned has that on screen already.
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
      status(opts, PHASE.RUNNING_TOOL, { tool: c.name, target: describeTarget(c.name, c.input), label: (c.input && typeof c.input.description === 'string' && c.input.description.trim()) || null });
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

      // LIVENESS, fed from the real path — OBSERVED HERE, ANSWERED BY THE USER.
      //
      // It used to push a `role: 'user'` message telling the model it was
      // repeating and then block the turn. Now it yields an advisory the person
      // may act on or ignore; the turn is not affected either way. looping.js
      // has the whole account.
      let advise = null;
      if (life) {
        const v = life.observeTool({
          name: c.name, input: c.input, output: result.observedOutput != null ? result.observedOutput : result.output,
          isError: Boolean(result.isError), mutated: result.mutated || [],
          exitCode: result.exitCode == null ? null : result.exitCode,
          // Set by toolstep.js — keeps a masked chain from reading as a pass; see evidencekind.js.
          noMatch: Boolean(result.noMatch), searchLike: Boolean(result.searchLike), denied: Boolean(result.denied), finalSmoke: Boolean(result.finalSmoke), detached: Boolean(result.detached),
        });
        const say = require('./looping').verdict(v, life.quiet, v.key);
        if (say.show && toldAbout !== v.key) {
          toldAbout = v.key;
          advise = { type: 'looping', name: c.name, target: describeTarget(c.name, c.input), count: say.count, key: v.key };
        } else if (!say.show && toldAbout) {
          toldAbout = null;
          advise = { type: 'looping_clear' };
        }
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

      // AFTER the result, so the advisory is about a call that has finished —
      // and NOTHING is awaited here: the next step runs whether or not anybody
      // is looking at it.
      if (advise) yield advise;
    }
    askgate.answerDeferred(session, gated.deferred);

    session.contextAuthority.touch({
      reason: `step-result:${record.turnId}:${step}`,
    });

    // ONLY WHEN THE USER SET A BOUND. With `maxSteps` unset this never fires, and the loop never ends on a count —
    // `max-steps` means "the limit YOU configured was reached", a different sentence from the one it used to mean.
    if (maxSteps && step === maxSteps - 1) record.stopReason = 'max-steps';
    if (life && life._closed) { record.stopReason = 'end'; if (!record.text.trim()) record.text = life._closed.text; life._closed = null; break; }   // a granted completion ends the turn (tools/contract.js)
  }

  // THE TURN IS OVER: account for it, and remember it. Both live in
  // turnclose.js, which contacts no provider and decides nothing.
  turnclose.close(session, life, record);

  status(opts, PHASE.ENDED, { stopReason: record.stopReason });
  yield { type: 'done', record };
}

module.exports = { runTurn, PHASE, DEFAULT_MAX_STEPS, newRecord, describeTarget, MAX_ACTIONS };
