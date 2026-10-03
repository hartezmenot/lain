'use strict';

/** ONE THINKING PHASE of a request (Simplify S5.1): from the first reasoning byte to the first text or tool call, the end of the request, or Ctrl+C. */

const KEEP = 2000;

/** A reasoning chunk arrived: open the phase if needed and add to it. */
function add(phase, chunk) {
  const p = phase || { start: Date.now(), last: Date.now(), chars: 0, text: '' };
  p.last = Date.now();
  p.chars += chunk.length;
  p.text = (p.text + chunk).slice(-KEEP);
  return p;
}

/** The phase is over: one entry on record.thinking, returned for the live screen. */
function close(record, phase, step, interrupted = false) {
  if (!phase) return null;
  const t = { step, ms: Math.max(0, (interrupted ? Date.now() : phase.last) - phase.start), chars: phase.chars, tokens: null, hidden: !phase.text.trim(), interrupted, text: phase.text };
  (record.thinking = record.thinking || []).push(t);
  return t;
}

/** The provider's exact reasoning-token count, when its receipt carries one, replaces the estimate. */
function settle(record, step, usage) {
  const mine = (record.thinking || []).filter((t) => t.step === step);
  if (mine.length && usage && usage.reasoningTokens != null) mine[mine.length - 1].tokens = Number(usage.reasoningTokens) || 0;
}

module.exports = { add, close, settle, KEEP };
