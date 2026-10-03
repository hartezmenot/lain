'use strict';

/** ACCOUNT POLICY (Phase 8.3) — which backing account serves a family's logical model, and what happens when that account hits a limit. */

const store = require('./store');
const idx = require('./index');
const caps = require('./effortcaps');

const DECISION = Object.freeze({
  KEEP: 'keep', SWITCHED: 'switched', ASK: 'ask', PINNED: 'pinned', INCOMPATIBLE: 'incompatible', NONE: 'none',
});

/** THE BACKING ACCOUNT for (family, model, effort) under the family's policy. */
function resolve(app, { family, model, effort = null, current = null, exclude = [], policy = null, pinned = null } = {}) {
  const f0 = idx.family(app, family);
  if (!f0) return { ok: false, decision: DECISION.NONE, why: `no provider family "${family}"` };
  // A LANE OR A DEFAULT MAY STATE ITS OWN POLICY; otherwise the family's.
  const f = policy && Object.values(store.POLICY).includes(policy) ? { ...f0, policy, pinned: pinned || f0.pinned } : f0;
  const m = f.byModel.get(String(model || ''));
  if (!m) return { ok: false, decision: DECISION.NONE, why: `${f.label} does not offer ${model}` };
  const e = caps.norm(effort);
  if (e && !m.efforts.includes(e)) return { ok: false, decision: DECISION.INCOMPATIBLE, why: `${m.label} on ${f.label} has no ${caps.label(e)} effort`, candidates: [] };
  const all = idx.eligible(app, family, model, e);
  const healthy = all.filter((x) => !x.limited && !exclude.includes(x.account.id));
  const same = (id) => all.find((x) => x.account.id === id) || null;
  const cand = healthy.map((x) => x.account);

  if (f.policy === store.POLICY.PINNED) {
    const pin = f.pinned || current || (all[0] && all[0].account.id) || null;
    const p = pin ? same(pin) : null;
    if (!p) return { ok: false, decision: DECISION.INCOMPATIBLE, why: `the pinned account ${nameOf(f, pin)} does not offer ${m.label}${e ? ` at ${caps.label(e)}` : ''}`, candidates: cand, pinned: pin };
    if (p.limited || exclude.includes(p.account.id)) return { ok: false, decision: DECISION.PINNED, why: `${f.label} is rate limited on this account`, account: p.account, candidates: cand.filter((a) => a.id !== pin), pinned: pin };
    return { ok: true, decision: DECISION.KEEP, account: p.account, switched: false, candidates: cand };
  }
  const cur = current ? same(current) : null;
  if (cur && !cur.limited && !exclude.includes(current)) return { ok: true, decision: DECISION.KEEP, account: cur.account, switched: false, candidates: cand };
  if (!healthy.length) {
    // ANOTHER HEALTHY ACCOUNT SERVES THE MODEL — but not at this effort: that is a question, never a downgrade.
    const servesOtherwise = f.accounts.filter((a) => a.usable && !a.limited && a.id !== current && !exclude.includes(a.id) && m.accounts.some((x) => x.id === a.id));
    if (e && servesOtherwise.length) return { ok: false, decision: DECISION.INCOMPATIBLE, why: `no other ${f.label} account serves ${m.label} at ${caps.label(e)}`, candidates: [], servesOtherwise: servesOtherwise.map((a) => a.id) };
    if (all.length) return { ok: false, decision: DECISION.NONE, why: `every ${f.label} account that serves ${m.label} is limited`, candidates: [] };
    return { ok: false, decision: DECISION.INCOMPATIBLE, why: `no ${f.label} account serves ${m.label}${e ? ` at ${caps.label(e)}` : ''}`, candidates: [], servesOtherwise: servesOtherwise.map((a) => a.id) };
  }
  const next = healthy[0].account;
  // NOTHING CHOSEN YET, or the current account does not serve this model at all (a model was
  // just chosen): the first eligible account is the choice — a selection, not a fallback.
  if (!cur) return { ok: true, decision: DECISION.KEEP, account: next, switched: false, candidates: cand };
  if (f.policy === store.POLICY.ASK) return { ok: false, decision: DECISION.ASK, why: `${f.label} is rate limited on ${nameOf(f, current)}`, proposal: next, candidates: cand };
  return { ok: true, decision: DECISION.SWITCHED, account: next, switched: Boolean(current && current !== next.id), candidates: cand };
}

function nameOf(f, id) { const a = f && f.accounts.find((x) => x.id === id); return a ? a.name : (id || 'this account'); }

/** A LIMIT JUST HAPPENED on `accountId`. */
function onLimit(app, { family, model, effort = null, accountId, resetAt = null, reason = 'rate limited' } = {}) {
  if (accountId) {
    store.recordQuota(accountId, { limited: { until: resetAt || (Date.now() + 5 * 60 * 1000), reason } });
    try { require('./tray').changed(app); } catch { /* no tray */ }
  }
  const f = idx.family(app, family);
  if (!f) return { decision: DECISION.NONE };
  // ONE BACKING ACCOUNT: the ordinary rate-limit path (wait, or change model) is the whole answer.
  if (f.accounts.filter((a) => a.usable).length < 2 && f.policy !== store.POLICY.PINNED) return { decision: DECISION.NONE, family: f.id };
  const r = resolve(app, { family, model, effort, current: accountId, exclude: [accountId] });
  const from = f.accounts.find((a) => a.id === accountId) || null;
  const base = { family: f.id, familyLabel: f.label, model, modelLabel: (f.byModel.get(model) || {}).label || model, effort: caps.norm(effort), from: from ? { id: from.id, name: from.name } : null };
  if (r.decision === DECISION.SWITCHED || (r.ok && r.account && r.account.id !== accountId)) return { ...base, decision: DECISION.SWITCHED, to: { id: r.account.id, name: r.account.name }, reason: `${from ? from.name : 'the account'} ${reason}` };
  if (r.decision === DECISION.ASK) return { ...base, decision: DECISION.ASK, to: { id: r.proposal.id, name: r.proposal.name }, text: `This ${f.label} account is rate limited.\n\nSwitch to ${r.proposal.name}?`, choices: ['switch', 'wait'] };
  if (r.decision === DECISION.PINNED) return { ...base, decision: DECISION.PINNED, candidates: (r.candidates || []).map((a) => ({ id: a.id, name: a.name })), text: `${f.label} is rate limited on this account.`, choices: ['switch-account', 'wait', 'choose-model'] };
  if (r.decision === DECISION.INCOMPATIBLE) return { ...base, decision: DECISION.INCOMPATIBLE, text: `${r.why}. LAIN will not change the model or the effort on its own.`, choices: ['wait', 'choose-model'] };
  return { ...base, decision: DECISION.NONE, text: r.why || '' };
}

/**
 * THE PERSON ASKED AGAIN (2026-10-03). A stored limit is LAIN's memory of a 429, not the provider's word: resetting
 * usage on the provider's own site never reaches it, so Continue answered "every … account is limited" without a
 * request. A typed message or Continue forgets the limits of the accounts serving this lane's model (and the route
 * breaker), so ONE real request asks the provider; a fresh 429 records the limit again (onLimit).
 */
function forgetLimits(app, session) {
  const s = session || (app && app.session);
  if (!s) return [];
  let l = null;
  try {
    const sv = require('../sessionviews');
    const which = sv.current(s) === sv.VIEW.CHAT || (s._botTurn && s._botOwnModel) ? 'chat' : 'coding';
    l = require('../sessionintel').lane(app, s, which);
  } catch { return []; }
  if (!l || l.ok || l.needs !== 'decision' || !l.family || !l.model) return [];
  const all = idx.eligible(app, l.family, l.model, l.effort);
  // A HEALTHY ACCOUNT EXISTS: the question (Switch · Wait) is the answer, not a retry.
  if (!all.length || all.some((x) => !x.limited)) return [];
  const out = [];
  for (const x of all) {
    store.clearLimit(x.account.id);
    try { if (app.availability && x.route) app.availability.retry(x.route); } catch { /* the breaker re-learns from the next reply */ }
    out.push(x.account.id);
  }
  return out;
}

module.exports = { DECISION, resolve, onLimit, forgetLimits };
