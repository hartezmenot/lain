'use strict';

/**
 * WHEN A BACKING ACCOUNT HITS A LIMIT MID-TASK (Phase 8.3).
 *
 *   Automatic fallback   the lane moves to the next eligible account of the
 *                        SAME family for the SAME model and effort, and the
 *                        task carries on — same session, task, model, effort,
 *                        execution, plan and phase. Only the backing account
 *                        changes, and that is recorded (tray, account detail,
 *                        every surface's status): "Codex switched to Work".
 *   Ask before switching the next eligible account is PROPOSED; nothing is sent
 *                        through it until the person says Switch.
 *   Use one account only never switched: Switch account · Wait · Choose another model.
 *   No compatible account the model and effort are never changed on their own —
 *                        the person is asked.
 *
 * The decision is fabric/policy.js's; this file applies it to the session and
 * records it. A pending question lives on the session (session.intel.pending)
 * so the window, the terminal and Telegram all show the same one, and any of
 * them can answer it (`decide`).
 */

const store = require('./store');
const policy = require('./policy');

function laneOfTurn(app, record) {
  if (record && record.lane === 'chat') return 'chat';
  try { return require('../sessionviews').current(app.session) === 'chat' || (app.session && app.session._botTurn && app.session._botOwnModel) ? 'chat' : 'coding'; } catch { return 'coding'; }
}

function resetOf(f) {
  if (!f) return null;
  if (f.resumeAt) return f.resumeAt;
  if (f.retryAfterMs) return Date.now() + f.retryAfterMs;
  return null;
}

/**
 * A TURN STOPPED ON A PROVIDER LIMIT. Returns null when the family has no
 * account policy to apply (one account, not a family) — the ordinary
 * rate-limit path then runs — else { action: 'switched' | 'ask' | 'pinned' | 'incompatible', ... }.
 */
function onTurnLimited(app, record) {
  const s = app && app.session;
  if (!s) return null;
  const si = require('../sessionintel');
  const L = laneOfTurn(app, record);
  let l = null;
  try { l = si.lane(app, s, L); } catch { l = null; }
  if (!l || !l.family || !l.account || !l.model) return null;
  const f = (record && record.providerFailure) || {};
  const d = policy.onLimit(app, { family: l.family, model: l.model, effort: l.effort, accountId: l.account, resetAt: resetOf(f), reason: 'rate limited' });
  if (!d || d.decision === policy.DECISION.NONE) return null;
  if (d.decision === policy.DECISION.SWITCHED) {
    si.switchBacking(app, s, L, d.to.id);
    try { s.save(); } catch { /* in memory */ }
    const ev = store.event('fallback', { lane: L, family: d.family, familyLabel: d.familyLabel, model: d.model, effort: d.effort, from: d.from, to: d.to, reason: d.reason, session: s.id });
    try { require('./tray').changed(app, { note: `${d.familyLabel} switched to ${d.to.name}` }); } catch { /* no tray */ }
    return { action: 'switched', lane: L, from: d.from, to: d.to, text: `${d.familyLabel} switched to ${d.to.name} — ${d.reason}`, event: ev };
  }
  s.intel = s.intel || require('../modelsource/sessionstate').intelDefaults();
  s.intel.pending = { lane: L, at: Date.now(), kind: d.decision, family: d.family, familyLabel: d.familyLabel, model: d.model, modelLabel: d.modelLabel, effort: d.effort, from: d.from, to: d.to || null, candidates: d.candidates || [], text: d.text, choices: d.choices, resetAt: resetOf(f) };
  try { s.save(); } catch { /* in memory */ }
  store.event('account-decision', { lane: L, family: d.family, kind: d.decision, from: d.from, to: d.to || null, session: s.id });
  try { require('./tray').changed(app); } catch { /* no tray */ }
  return { action: d.decision, lane: L, pending: s.intel.pending, text: d.text };
}

/**
 * THE PERSON'S ANSWER — from the window, the terminal or Telegram.
 *   switch           to the proposed account (Ask) or `account` (Pinned: any eligible one)
 *   wait             keep the account; the task stays paused until Continue re-checks
 *   choose-model     clear the question; the surface opens its model picker
 * A switch keeps family, model and effort; a pinned lane stays pinned — to the new account.
 */
function decide(app, session, { choice, account = null } = {}) {
  const s = session || app.session;
  const p = s && s.intel && s.intel.pending;
  if (!p) return { ok: false, why: 'nothing is waiting for an account decision' };
  const si = require('../sessionintel');
  if (choice === 'switch' || choice === 'switch-account') {
    const to = account || (p.to && p.to.id) || null;
    const ok = to && (p.to && p.to.id === to || (p.candidates || []).some((c) => c.id === to));
    if (!ok) return { ok: false, why: 'choose one of the accounts offered' };
    const idx = require('./index');
    const elig = idx.eligible(app, p.family, p.model, p.effort).map((x) => x.account.id);
    if (!elig.includes(to)) return { ok: false, why: 'that account no longer serves this model at this effort' };
    si.switchBacking(app, s, p.lane, to);
    // A PINNED LANE STAYS PINNED — to the account the person chose.
    const f = idx.family(app, p.family);
    if (f && f.policy === store.POLICY.PINNED) store.setPolicy(p.family, store.POLICY.PINNED, to);
    const name = ((f && f.accounts.find((a) => a.id === to)) || {}).name || to;
    s.intel.pending = null;
    try { s.save(); } catch { /* in memory */ }
    store.event('fallback', { lane: p.lane, family: p.family, familyLabel: p.familyLabel, model: p.model, effort: p.effort, from: p.from, to: { id: to, name }, reason: 'you chose to switch', session: s.id });
    try { require('./tray').changed(app); } catch { /* no tray */ }
    return { ok: true, switched: true, to: { id: to, name }, resume: true };
  }
  if (choice === 'wait' || choice === 'choose-model') {
    s.intel.pending = null;
    try { s.save(); } catch { /* in memory */ }
    return { ok: true, switched: false, openPicker: choice === 'choose-model' };
  }
  return { ok: false, why: 'the answer is switch, wait or choose-model' };
}

/** The terminal's question for a pending decision (ui/panel shape). */
function adapter(p) {
  const { KIND, MODE } = require('../ui/panel');
  const items = String(p.text || '').split('\n').filter(Boolean).map((t) => ({ label: t, selectable: false }));
  items.push({ label: '', selectable: false });
  if (p.kind === 'ask' && p.to) items.push({ label: `Switch to ${p.to.name}`, value: `switch:${p.to.id}` });
  if (p.kind === 'pinned') for (const c of (p.candidates || []).slice(0, 6)) items.push({ label: `Switch account — ${c.name}`, value: `switch:${c.id}` });
  items.push({ label: 'Wait', value: 'wait' });
  if (p.kind !== 'ask') items.push({ label: 'Choose another model', value: 'choose-model' });
  return { title: `${p.familyLabel} · account`, kind: KIND.ASK_USER, mode: MODE.EXPANDED, items, cursor: items.findIndex((i) => i.value), footer: '↑↓ choose · Enter confirm · Esc = wait' };
}

/**
 * THE TERMINAL'S ANSWER, when a person is there to give it. Returns true when
 * the task should resume (a switch), false otherwise.
 */
async function askInTerminal(app) {
  const p = app.session && app.session.intel && app.session.intel.pending;
  if (!p || !app.ui || !app.ui.enabled) return false;
  const pick = await app.ui.ask(adapter(p));
  const v = String(pick || 'wait');
  if (v.startsWith('switch:')) { const r = decide(app, app.session, { choice: 'switch', account: v.slice(7) }); if (r.ok) app.transient('info', `${p.familyLabel} switched to ${r.to.name}`); return Boolean(r.ok); }
  decide(app, app.session, { choice: v === 'choose-model' ? 'choose-model' : 'wait' });
  if (v === 'choose-model') { try { await require('../modelcommand').pickCommand(app, { args: [], rest: '' }, { C: require('../render').C, config: require('../config'), refreshCatalog: () => {} }); } catch { /* the picker reports */ } }
  return false;
}

module.exports = { onTurnLimited, decide, adapter, askInTerminal, laneOfTurn };
