'use strict';

/** A BUDGET IS NOT A CEILING, AND CONFUSING THE TWO IS THE WHOLE DEFECT. */

const { CHARS_PER_TOKEN } = require('./session');

/** THE DEFAULT WORKING BUDGET, in tokens of conversation. */
const DEFAULT_BUDGET_TOKENS = 50_000;

/** Below this, compaction cannot help enough to be worth the history it costs. */
const MIN_BUDGET_TOKENS = 8_000;

/** The working budget in CHARACTERS, for this route and this config. */
function charsFor(pc, cfg = {}) {
  const env = Number(process.env.LAIN_CONTEXT_BUDGET_TOKENS);
  const set = Number(cfg && cfg.contextBudgetTokens);
  const want = Number.isFinite(env) && env > 0 ? env
    : (Number.isFinite(set) && set > 0 ? set : DEFAULT_BUDGET_TOKENS);
  // FAST spends more context, ECO less (profile.js) — within the same floor and ceiling.
  const scale = require('./profile').scale(cfg && cfg.executionProfile);
  // LAIN EXECUTION EFFORT (a model with no native effort — effortcaps.forRequest): Low keeps a small context packet,
  // Max allows a broader one. A model WITH native effort is untouched here: its effort goes to the provider.
  const lain = { low: 0.6, high: 1, max: 1.4 }[(pc && pc.lainEffort) || 'high'] || 1;
  const budget = Math.max(MIN_BUDGET_TOKENS, Math.round(want * scale * lain)) * CHARS_PER_TOKEN;
  const ceiling = require('./session').budgetChars(pc);
  return Math.floor(Math.min(budget, ceiling));
}

/** WHAT TO DO ABOUT A REQUEST OF THIS SIZE — named, so it can be reported. */
const ACTION = Object.freeze({ SEND: 'SEND', COMPACT: 'COMPACT', OVER: 'OVER' });

function decide(chars, budget) {
  if (!budget || chars <= budget) return { action: ACTION.SEND, chars, budget, over: 0 };
  return { action: ACTION.COMPACT, chars, budget, over: chars - budget };
}

module.exports = { charsFor, decide, ACTION, DEFAULT_BUDGET_TOKENS, MIN_BUDGET_TOKENS };
