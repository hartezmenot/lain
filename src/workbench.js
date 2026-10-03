'use strict';

/** THE WORKBENCH STATE — what Chat needs to supervise the Coding Agent, kept on the session it supervises. */

const crypto = require('crypto');

const MAX = Object.freeze({ steers: 40, findings: 60, phases: 40, deltas: 60, offers: 20, notes: 40 });

function id(prefix) { return `${prefix}_${crypto.randomBytes(4).toString('hex')}`; }

function blank() {
  return {
    strategy: { kind: 'NORMAL', review: 'AUTOMATIC', since: null, acknowledged: null, phasesRun: 0, pausedForReview: null },
    pendingProfile: null,
    steers: [],
    findings: [],
    phases: [],
    deltas: [],
    quota: null,
    offers: [],
    // CHAT'S SUPERVISED EXCHANGES while the Agent ran (you said / LAIN answered from Core) —
    // drawn in the Chat lane; never part of the model's transcript.
    notes: [],
    surface: { writer: null, since: null, handoff: null },
  };
}

/** The state, created on first use. */
function of(session) {
  if (!session) return blank();
  if (!session.workbench || typeof session.workbench !== 'object') session.workbench = blank();
  const b = blank();
  for (const k of Object.keys(b)) if (session.workbench[k] === undefined) session.workbench[k] = b[k];
  return session.workbench;
}

function cap(list, n) { return list.length > n ? list.slice(-n) : list; }

function toJSON(session) {
  const w = session && session.workbench;
  if (!w) return {};
  return { workbench: {
    ...w,
    steers: cap(w.steers || [], MAX.steers),
    findings: cap(w.findings || [], MAX.findings),
    phases: cap(w.phases || [], MAX.phases),
    deltas: cap(w.deltas || [], MAX.deltas),
    notes: cap(w.notes || [], MAX.notes),
    offers: cap((w.offers || []).filter((o) => o.state === 'OPEN'), MAX.offers),
  } };
}

function restore(session, data = {}) {
  if (data && data.workbench && typeof data.workbench === 'object') { session.workbench = data.workbench; of(session); }
  // A queued SLOW (retired in Phase 8.1) is ECO now.
  if (session.workbench && session.workbench.pendingProfile) session.workbench.pendingProfile = require('./profile').normalize(session.workbench.pendingProfile);
}

/** An offer LAIN itself puts to the person (never the model's). Returns it; one open offer per kind. */
function offer(session, kind, body = {}) {
  const w = of(session);
  for (const o of w.offers) if (o.kind === kind && o.state === 'OPEN') o.state = 'SUPERSEDED';
  const o = { id: id('of'), kind, state: 'OPEN', at: Date.now(), ...body };
  w.offers.push(o);
  w.offers = cap(w.offers, MAX.offers);
  return o;
}
function openOffers(session) { return of(session).offers.filter((o) => o.state === 'OPEN'); }
function settleOffer(session, offerId, state = 'ANSWERED', answer = null) {
  const o = of(session).offers.find((x) => x.id === offerId);
  if (!o) return null;
  o.state = state; o.answer = answer; o.answeredAt = Date.now();
  return o;
}

module.exports = { of, toJSON, restore, id, offer, openOffers, settleOffer, blank, MAX };
