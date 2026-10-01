'use strict';

/**
 * ACCOUNT POLICY (Phase 8.3) — which backing account serves a family's
 * logical model, and what happens when that account hits a limit.
 *
 *   Automatic fallback   the first healthy account, in the family's priority
 *                        order, that serves the SAME model at the SAME effort.
 *                        On a limit LAIN moves to the next one — session, task,
 *                        model, effort, execution, plan and phase unchanged —
 *                        and says so (tray, account detail). Nothing else moves.
 *   Use one account only the pinned account, always. On a limit LAIN stops and
 *                        asks: Switch account · Wait · Choose another model.
 *   Ask before switching LAIN finds the next eligible account and ASKS; no
 *                        request goes through it until the person says Switch.
 *
 * NEVER A SEMANTIC CHANGE. If no other account serves this model at this
 * effort, the answer is a question, never another model or a lower effort:
 * "no Codex account offers GPT-6 Sol at XHigh". Choosing another model is the
 * person's act.
 *
 * Decided from the eligibility index (fabric/index.js) and the limits the
 * providers reported (fabric/store.js) — never by probing a model.
 */

const store = require('./store');
const idx = require('./index');
const caps = require('./effortcaps');

const DECISION = Object.freeze({
  KEEP: 'keep', SWITCHED: 'switched', ASK: 'ask', PINNED: 'pinned', INCOMPATIBLE: 'incompatible', NONE: 'none',
});

/**
 * THE BACKING ACCOUNT for (family, model, effort) under the family's policy.
 *   current   the account the lane runs on now (kept while it is eligible and healthy)
 *   exclude   accounts known to be limited this moment (the one that just refused)
 * → { ok, account, switched, decision, candidates, why }
 */
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

/**
 * A LIMIT JUST HAPPENED on `accountId`. Record it (the tray and every surface
 * read it) and decide what the lane does next. Nothing is switched here — the
 * caller applies a SWITCHED decision; ASK / PINNED / INCOMPATIBLE become the
 * question the person answers.
 */
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
  if (r.decision === DECISION.INCOMPATIBLE) return { ...base, decision: DECISION.INCOMPATIBLE, text: `${r.why}. Noema will not change the model or the effort on its own.`, choices: ['wait', 'choose-model'] };
  return { ...base, decision: DECISION.NONE, text: r.why || '' };
}

module.exports = { DECISION, resolve, onLimit };
