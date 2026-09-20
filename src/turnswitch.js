'use strict';

/**
 * A MODEL CHOSEN WHILE A TURN IS RUNNING SERVES ITS NEXT STEP.
 *
 * Live, 2026-09-18: `/model kr/claude-haiku-4.5` mid-turn. The header said
 * haiku at once; requests 52–58 of that same turn all went to sonnet, because
 * runTurn resolved its provider config once, before the first step. The screen
 * named one model while another did the work — and the person who switched
 * (usually because A was slow, limited or wrong) got A for the rest of the task.
 *
 * Now each step after the first asks the caller for the CURRENT selection
 * (`opts.cfgNow`, jobrunner.turnOptions). A different model/connection/effort
 * that resolves to a usable route takes over at that step boundary — never
 * inside a request or a tool call. The conversation on the wire is unchanged,
 * so the new model continues the same work from the same evidence rather than
 * restarting it. A selection that cannot be served (no credential, removed
 * route) is not adopted mid-turn: the turn stays on the model that works, and
 * the next turn reports the problem through the ordinary path.
 */

const provider = require('./provider');

function same(a, b) {
  return String(a.model || '') === String(b.model || '')
    && String(a.connection || '') === String(b.connection || '')
    && String(a.effort || '') === String(b.effort || '');
}

/** @returns {null | {cfg, pc, message}} */
function next(opts, cfg, pc) {
  if (!opts || typeof opts.cfgNow !== 'function') return null;
  let now;
  try { now = opts.cfgNow(); } catch { return null; }
  if (!now || same(now, cfg)) return null;
  let npc;
  try { npc = provider.resolve(now); } catch { return null; }
  if (!npc || !npc.model || npc.unavailable || !npc.protocol) return null;
  if (provider.credentialHint(npc, now)) return null;
  const was = pc.canonicalModel || pc.model || 'the previous model';
  const is = npc.canonicalModel || npc.model;
  return {
    cfg: now, pc: npc,
    connId: npc.connectionId || npc.provider || 'unknown',
    availModel: npc.canonicalModel || npc.model || '',
    message: `Model switched · ${was} → ${is} · continuing this turn from the same state`,
  };
}

module.exports = { next, same };
