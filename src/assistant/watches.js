'use strict';

/** CONDITION WATCHES — "tell me when …", evaluated from STATE LAIN already holds. */

const KINDS = Object.freeze(['window_reset', 'channel_state', 'runtime_state', 'plan_expiry']);

function validate(w) {
  if (w.kind === 'plan_expiry') return { ok: false, why: 'ZCode does not report the Start Plan’s expiry or balance to LAIN, so there is nothing LAIN could watch. Open ZCode to see it.' };
  if (w.kind === 'window_reset' && !w.source) return { ok: false, why: 'which account? (claude-code, or a Codex account id)' };
  if (w.kind === 'channel_state' && w.platform !== 'telegram') return { ok: false, why: 'Telegram is the channel LAIN can watch today' };
  if (w.kind === 'runtime_state' && !w.runtime) return { ok: false, why: 'which runtime?' };
  return { ok: true };
}

function windowsFor(app, source) {
  if (source === 'claude-code') { const t = require('../runtimeadapters').cachedTelemetry('claude-code'); return (t && t.limits && t.limits.windows) || []; }
  try { const v = require('../accountinstances').list(app).find((x) => x.id === source); return (v && v.limits && v.limits.windows) || []; } catch { return []; }
}

/** Evaluate once. Returns { fire, text, memo }. */
async function evaluate(app, w, memo = {}, now = Date.now()) {
  if (w.kind === 'window_reset') {
    const ws = windowsFor(app, w.source).filter((x) => !w.window || x.label === w.window || x.id === w.window);
    const due = ws.filter((x) => x.resetsAt && x.resetsAt <= now && !(memo.fired || []).includes(`${x.id || x.label}:${x.resetsAt}`));
    if (!ws.length) return { fire: false, memo: { ...memo, note: 'no window reported yet' } };
    if (!due.length) return { fire: false, memo };
    const keys = due.map((x) => `${x.id || x.label}:${x.resetsAt}`);
    return { fire: true, memo: { ...memo, fired: [...(memo.fired || []), ...keys].slice(-20) }, text: `${w.label || w.source}: the ${due.map((x) => x.label).join(' and ')} window reset time has passed (reported reset ${new Date(due[0].resetsAt).toLocaleTimeString()}). Refresh the account to confirm the new figure.` };
  }
  if (w.kind === 'channel_state') {
    let st = null;
    try { const c = await require('../botconnect').telegram(app); st = (c && c.status) || null; } catch { st = null; }
    const operational = st === 'OPERATIONAL' || st === 'LISTENING';
    const prev = memo.operational;
    const m = { ...memo, operational, state: st };
    if (prev === undefined) return { fire: false, memo: m };
    if (w.when !== 'up' && prev === true && operational === false) return { fire: true, memo: m, text: `Telegram stopped being operational (now: ${String(st || 'unknown').toLowerCase()}).` };
    if (w.when === 'up' && prev === false && operational === true) return { fire: true, memo: m, text: 'Telegram is operational again.' };
    return { fire: false, memo: m };
  }
  if (w.kind === 'runtime_state') {
    const r = await require('../runtimeadapters').report(app, w.runtime).catch(() => null);
    const state = r ? r.state : null;
    const prev = memo.state;
    const m = { ...memo, state };
    const target = String(w.state || 'Operational');
    if (prev !== undefined && prev !== state && state === target) return { fire: true, memo: m, text: `${r.label} is ${state}.` };
    return { fire: false, memo: m };
  }
  return { fire: false, memo };
}

module.exports = { KINDS, validate, evaluate };
