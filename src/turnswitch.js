'use strict';

/** A MODEL CHOSEN WHILE A TURN IS RUNNING SERVES ITS NEXT STEP. */

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
