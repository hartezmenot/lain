'use strict';

/** WHAT A TURN RECORD IS — the shape, and the bounds on it. */

/** TURN IDS ARE UNIQUE WITHIN A PROCESS, and the counter is why. */
let turnSeq = 0;

/** HOW MANY ACTIONS AND HOW MUCH NARRATION ONE TURN KEEPS. */
const MAX_ACTIONS = 200;

/** HOW MANY PER-REQUEST TOKEN BREAKDOWNS ONE TURN KEEPS. */
const MAX_AUDITS = 12;

/** How much thinking is kept. It is only ever shown when the model said nothing. */
const MAX_REASONING = 4000;

/** What one turn did. Handed to the REPL and appended to the session. */
function newRecord(sessionId, userInput, model) {
  require('./perfmark').mark('turn');   // where the turn's milliseconds go (perfmark.js)
  turnSeq += 1;
  return {
    turnId: `t${turnSeq}-${Date.now().toString(36)}`,
    sessionId,
    userInput,
    model,
    /** WHO ASKED FOR THIS TURN. */
    from: null,
    startedAt: new Date().toISOString(),
    steps: 0,
    toolCalls: 0,          // TURN-WIDE. never per-step.
    toolNames: [],
    /** What actually happened, in order, for the ACTIVITY view. */
    actions: [],
    /** `[{ step, text }]` — the model's prose, in the order it was said. */
    narration: [],
    evidenceReuse: 0,      // reads served from the ledger instead of re-read
    compactions: 0,        // times the conversation had to be trimmed to fit
    mutations: [],         // absolute paths actually changed
    errors: [],            // [{ kind, message }]
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, promptTokens: 0, requests: 0 },
    text: '',              // assistant prose across the turn
    stopReason: null,      // 'end' | 'max-steps' | 'aborted' | 'provider' | 'no-credential'
    providerFailure: null,
    /** Per-request token breakdowns. See src/tokenaudit.js. */
    audits: [],
  };
}

module.exports = { newRecord, MAX_ACTIONS, MAX_REASONING, MAX_AUDITS };
