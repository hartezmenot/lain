'use strict';

/**
 * HOW THE LAST TURN ENDED, AND WHETHER THE NEXT SENTENCE NEEDS A BRIEFING (2026-10-02).
 *
 * This is the judgement the Rust Guardian used to hold (guardian.rs turn_end/offer), now kept WITH THE SESSION it is
 * about (`workbench.guard`, saved with the session file) — so it survives exactly as long as the work does, and needs
 * no second process to be asked.
 *
 *   turn ends             state              the next sentence
 *   completed             COMPLETED          delivered bare; any owed briefing is closed
 *   aborted / cancelled   CANCELLED          delivered bare (the person chose to stop)
 *   rate_limited          RATE_LIMITED       delivered WITH a briefing (RATE_LIMITED: …)
 *   anything else         PROVIDER_FAILED    delivered WITH a briefing (PROVIDER_FAILED: …)
 *   never ended           RUNNING, but no    TURN_LOST: the host died mid-turn — the session was repaired from disk
 *                         turn runs here     (inflight.js) and the next sentence carries that
 *
 * "Briefing" is handover.js's packet (app._handover → systemPrompt): the person's words go to the model unchanged;
 * what Noema observed rides in the system prompt.
 */

const wb = require('./workbench');

const STATE = Object.freeze({ IDLE: 'IDLE', RUNNING: 'RUNNING', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', RATE_LIMITED: 'RATE_LIMITED', PROVIDER_FAILED: 'PROVIDER_FAILED' });

function guard(s) {
  const w = wb.of(s);
  if (!w.guard || typeof w.guard !== 'object') w.guard = { state: STATE.IDLE, kind: '', reason: '', handover: '', model: '', at: 0 };
  return w.guard;
}

/** A turn starts in THIS process. */
function begin(app, { model = '' } = {}) {
  const s = app && app.session;
  if (!s) return;
  const g = guard(s);
  g.state = STATE.RUNNING; g.model = String(model || g.model || ''); g.at = Date.now(); g.kind = ''; g.reason = '';
}

/** How it ended, from the turn record's own words (turnrecord.js stopReason). */
function end(app, record) {
  const s = app && app.session;
  if (!s) return;
  const g = guard(s);
  const stop = record ? String(record.stopReason || 'end') : 'provider';
  const f = record && record.providerFailure;
  g.at = Date.now();
  if (stop === 'end' || stop === 'completed') { g.state = STATE.COMPLETED; g.handover = ''; g.kind = ''; g.reason = ''; return; }
  if (stop === 'aborted' || stop === 'cancelled') { g.state = STATE.CANCELLED; return; }
  g.state = stop === 'rate-limited' ? STATE.RATE_LIMITED : STATE.PROVIDER_FAILED;
  g.kind = String((f && f.kind) || stop).slice(0, 80);
  g.reason = String((f && (f.message || f.reason)) || '').slice(0, 300);
  if (!g.handover) g.handover = `${g.state}: ${g.reason || 'the previous turn did not finish'}`;
}

function running(app) { return Boolean(app && app.abort && !app.abort.signal.aborted); }

/**
 * MAY THIS SENTENCE GO STRAIGHT THROUGH? '' when it may; otherwise the reason, `KIND: detail`, that the briefing
 * carries. The most specific reason wins — the same ranking guard.rs used.
 */
function held(app) {
  const s = app && app.session;
  if (!s) return '';
  const g = guard(s);
  if (running(app)) return '';
  const detail = g.reason ? ` — ${g.reason}` : '';
  if (g.state === STATE.RATE_LIMITED) return `RATE_LIMITED: the route was limited${detail}`;
  if (g.state === STATE.PROVIDER_FAILED) return `PROVIDER_FAILED: the previous turn did not finish${detail}`;
  if (g.state === STATE.RUNNING) return 'TURN_LOST: the process running the previous turn is gone';
  if (g.handover) return `HANDOVER_PENDING: ${g.handover}`;
  return '';
}

/** A recovered crash (inflight.recover) that autocontinue already resumed owes no second briefing. */
function settleLost(app) { const s = app && app.session; if (s && guard(s).state === STATE.RUNNING && !running(app)) guard(s).state = STATE.IDLE; }

function view(s) { const g = guard(s); return { ...g }; }

module.exports = { STATE, begin, end, held, settleLost, view };
