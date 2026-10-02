'use strict';

/**
 * SESSION INTELLIGENCE — what a session's Chat lane and Coding Agent run on,
 * and WHERE each choice came from.
 *
 *     global   fabric role defaults (fabric.json), else cfg.model / cfg.connection / cfg.effort
 *        ↓
 *     project  cfg.projects[<projectId>]  — this project's defaults
 *        ↓
 *     session  session.intel (family, effort), sessionviews (coding), sourceSelections (chat)
 *
 * The nearest layer that states a value wins; `scope` names that layer.
 *
 * ------------------------------------------------------------------------
 * PHASE 8.3 — THE INTELLIGENCE FABRIC. A lane is what the PERSON chose:
 *
 *     PROVIDER FAMILY  ›  LOGICAL MODEL  ›  EFFORT        e.g. Codex › GPT-6 Sol › XHigh
 *
 * and underneath it the BACKING ACCOUNT the family's account policy chose
 * (fabric/policy.js) — Automatic fallback, Use one account only, Ask before
 * switching. The backing account is kept where Phase 8.2 kept "the account"
 * (session.accountSelections.chat, views.coding.connection), so a request's
 * exact route is still account + model → accountcatalog.routeFor. It changes
 * only by policy or by the person — and when it changes, nothing the person
 * chose does: same family, model, effort, execution, plan and phase.
 *
 * EFFORT belongs to the model: a lane offers exactly the levels its model
 * declares (fabric/effortcaps.js), a model with none has no effort, and a
 * stored level the model does not take is never sent — the model's default is.
 *
 * NOT A ROUTER, NOT A TOOL. Nothing here is offered to a model; choosing is the
 * person's act, and nothing sends a request.
 */

function root(app) { return (app && app._sibling) || app; }
function projectOf(session) {
  try {
    const sv = require('./sessionviews');
    const p = sv.project(session);
    if (!p.attached || p.missing) return null;
    return { id: require('./journey').projectId(session.cwd), root: session.cwd };
  } catch { return null; }
}
function projectLayer(app, session) {
  const p = projectOf(session);
  const all = (root(app).cfg && root(app).cfg.projects) || {};
  return { project: p, layer: (p && all[p.id]) || {} };
}

function accountsMod() { return require('./accountcatalog'); }
function fab() { return require('./fabric/index'); }
function caps() { return require('./fabric/effortcaps'); }
function fstore() { return require('./fabric/store'); }

/** The session's fabric state for a lane: { family, effort, policy?, pinned? }. */
function laneState(session, which) {
  const s = session || {};
  if (!s.intel || typeof s.intel !== 'object') s.intel = require('./modelsource/sessionstate').intelDefaults();
  if (!s.intel.lanes) s.intel.lanes = {};
  if (!s.intel.lanes[which]) s.intel.lanes[which] = { family: null, effort: null };
  return s.intel.lanes[which];
}

/** The chosen account id, or null, from whatever a layer stored (account, route or base id). */
function normalizeAccount(app, stored) {
  if (!stored) return null;
  const a = accountsMod().accountFor(app, stored);
  return a ? a.id : null;
}

const pick = (sessionV, projectV, globalV) => (sessionV != null && sessionV !== '' ? { value: sessionV, scope: 'session' }
  : projectV != null && projectV !== '' ? { value: projectV, scope: 'project' } : { value: globalV == null ? null : globalV, scope: 'global' });

/** The global default for a lane: the fabric's role default, else the legacy config keys. */
function globalOf(app, which) {
  const cfg = root(app).cfg || {};
  let rd = null;
  try { rd = fstore().roleDefault(which === 'chat' ? 'chat' : 'coding'); } catch { rd = null; }
  if (which === 'chat') {
    const botDefault = (cfg.defaultChat && (cfg.defaultChat.source || 'lain') === 'lain' && cfg.defaultChat.model) || cfg.model || null;
    if (rd && rd.model) return { model: rd.model, account: rd.policy === 'pinned' ? rd.pinned || null : null, family: rd.family || null, effort: rd.effort || null, policy: rd.policy || null, pinned: rd.pinned || null };
    return { model: botDefault, accountAlways: (cfg.defaultChat && cfg.defaultChat.connection) || null, accountIf: { model: cfg.model || null, account: cfg.connection || null }, family: null, effort: cfg.effort || null };
  }
  if (rd && rd.model) return { model: rd.model, account: rd.policy === 'pinned' ? rd.pinned || null : null, family: rd.family || null, effort: rd.effort || null, policy: rd.policy || null, pinned: rd.pinned || null };
  return { model: cfg.model || null, account: cfg.connection || null, family: null, effort: cfg.effort || null };
}

/** The effort a lane stores, with its layer — before it is checked against the model. */
function storedEffort(app, s, which, layer, g) {
  const li = laneState(s, which);
  const v = require('./sessionviews').views(s);
  if (li.effort) return { value: li.effort, scope: 'session' };
  return pick(v.effort, layer.effort, g.effort);
}

/** The catalog id an account reaches a logical model by (a router pool keeps its namespace). */
function catalogIdOf(entry, accountId, fallback) {
  const x = entry && entry.accounts.find((a) => a.id === accountId);
  return (x && x.catalogId) || fallback;
}

/** THE LEVELS A LANE MAY OFFER for its model: the pinned account's, else every account's. */
function levelsFor(fam, entry, pinned) {
  if (pinned) { const x = entry.accounts.find((a) => a.id === pinned); if (x) return x.levels.slice(); }
  return entry.efforts.slice();
}

/**
 * WHAT THE EFFORT CONTROL OFFERS (2026-10-02): the model's NATIVE levels when it has them (source 'provider' — sent
 * to the provider exactly as declared), otherwise LAIN's Low / High / Max (source 'lain' — LAIN's execution depth:
 * context, tools, exploration, delegation; never sent to the model and never presented as hidden reasoning).
 */
function offered(fam, entry, pinned) {
  const l = levelsFor(fam, entry, pinned);
  return l.length ? { levels: l, source: 'provider' } : { levels: caps().LAIN_LEVELS.slice(), source: 'lain' };
}

/** THE LANE — family › model › effort, its backing account and route. Every surface reads this. */
function lane(app, session = app.session, which = 'coding') {
  const L = which === 'chat' ? 'chat' : 'coding';
  const s = session || {};
  const v = require('./sessionviews').views(s);
  const { layer } = projectLayer(app, s);
  const g = globalOf(app, L);
  const li = laneState(s, L);
  let model; let account;
  if (L === 'chat') {
    model = pick(s.sourceSelections && s.sourceSelections.lain, layer.bot && layer.bot.model, g.model);
    // THE GLOBAL ACCOUNT applies only to the global model (a session's own model never inherits it).
    account = pick(s.accountSelections && s.accountSelections.chat, layer.bot && layer.bot.connection, g.account || g.accountAlways || (g.accountIf && model.value && model.value === g.accountIf.model ? g.accountIf.account : null));
  } else {
    model = pick(v.coding.model, layer.coding && layer.coding.model, g.model);
    account = model.scope === 'session' ? { value: v.coding.connection || null, scope: 'session' }
      : model.scope === 'project' ? { value: (layer.coding && layer.coding.connection) || null, scope: 'project' } : { value: g.account || null, scope: 'global' };
    // AN ACCOUNT CHOSEN FOR THIS SESSION before its model still stands.
    if (v.coding.connection && model.scope !== 'session') account = { value: v.coding.connection, scope: 'session' };
  }
  const layerFam = (L === 'chat' ? layer.bot : layer.coding) || {};
  const A = accountsMod();
  const F = fab();
  let accountId = normalizeAccount(app, account.value);
  let implicit = false;
  // THE FAMILY: the backing account's, else the one this lane chose, else the only family that offers the model.
  let fam = accountId ? F.familyOfAccount(app, accountId) : null;
  const wantFam = li.family || layerFam.family || g.family || null;
  if (!fam && wantFam) fam = F.family(app, wantFam);
  let offering = [];
  if (!fam && model.value) {
    offering = F.familiesOffering(app, model.value);
    if (offering.length === 1) { fam = offering[0]; implicit = true; }
  }
  // A FAMILY THIS SESSION CHOSE does not inherit a default model it does not offer.
  if (fam && (account.scope === 'session' || li.family) && model.scope !== 'session' && model.value && !fam.byModel.has(model.value)) model = { value: null, scope: 'session' };
  const entry = fam && model.value ? fam.byModel.get(model.value) || null : null;
  // THE POLICY: this lane's override, the default's, else the family's own.
  const policyName = li.policy || g.policy || (fam ? fam.policy : null);
  const pinned = policyName === 'pinned' ? (li.pinned || g.pinned || (fam && fam.pinned) || accountId || null) : null;
  // EFFORT — only a level the model declares ever leaves here.
  const eff = storedEffort(app, s, L, layer, g);
  let effort = eff.value && eff.value !== 'auto' ? caps().norm(eff.value) : null;
  let levels = null; let effortAdjusted = false; let effortSource = null;
  if (entry) {
    const off = offered(fam, entry, pinned);
    levels = off.levels; effortSource = off.source;
    if (effort && !levels.includes(effort)) { effortAdjusted = true; effort = entry.defaultEffort && levels.includes(entry.defaultEffort) ? entry.defaultEffort : null; }
    if (!levels.length) effort = null;
  }
  // THE BACKING ACCOUNT, by policy (fabric/policy.js).
  let acct = accountId ? A.find(app, accountId) : null;
  let decision = null;
  if (fam && entry) {
    const r = require('./fabric/policy').resolve(app, { family: fam.id, model: model.value, effort, current: accountId, policy: policyName, pinned });
    if (r.ok) { if (!acct || r.account.id !== acct.id) { acct = A.find(app, r.account.id) || acct; if (!accountId) implicit = true; } }
    else decision = r;
  }
  let route = null; let why = ''; let needs = null; let catalogModel = null;
  if (decision) {
    needs = decision.decision === 'incompatible' ? 'account' : 'decision';
    why = decision.why;
  } else if (!acct && model.value) {
    needs = fam ? 'account' : 'family';
    why = fam ? `no ${fam.label} account serves ${model.value}`
      : offering.length > 1 ? `choose which provider runs ${model.value} — ${offering.slice(0, 4).map((f) => f.label).join(', ')} offer it` : `no configured provider offers ${model.value}`;
  } else if ((acct || fam) && !model.value) { needs = 'model'; why = `choose a model on ${fam ? fam.label : acct.name}`; }
  else if (acct && model.value) {
    const r = A.routeFor(app, acct.id, catalogIdOf(entry, acct.id, model.value));
    if (r.ok) { route = r.connectionId; catalogModel = r.model; } else { why = r.why; needs = r.code === 'NOT_OFFERED' ? 'model' : 'account'; }
  } else { needs = 'family'; why = 'choose a provider'; }
  let modelLabel = (entry && entry.label) || model.value || '';
  if (!entry && model.value) { try { modelLabel = A.modelLabel(app, acct ? acct.id : null, model.value); } catch { /* the id */ } }
  // A STORED ACCOUNT THIS MACHINE DOES NOT HAVE is still the choice — reported, never sent through.
  if (!acct && !fam && account.value && !implicit) { needs = 'account'; why = `the account "${account.value}" is not configured here`; }
  const b = acct && fam ? fam.accounts.find((x) => x.id === acct.id) : null;
  const effortLabel = effort ? caps().label(effort) : (levels && levels.length ? 'Default' : '');
  // THE CANONICAL ROUTE (2026-09-29): source › model › effort › execution, and only when it RESOLVES. A half-resolved
  // lane ("Select provider · GPT-6 Sol", a keyless "Z.ai API · GLM 5.3 Flash") is never drawn: every surface shows
  // `display.text`, which is the whole route or "Select model" — with `display.problem` saying why when a choice broke.
  const resolved = Boolean(route);
  const execution = (() => { try { return require('./profile').of(s, root(app).cfg); } catch { return 'NORMAL'; } })();
  // A ROUTE CAN RESOLVE WITHOUT A FAMILY: a connection the fabric does not group (a localhost OpenAI-compatible
  // router, a custom endpoint) still runs. Its source is then the connection itself — never a crash on `fam.id`.
  const source = fam ? { id: fam.id, label: fam.label } : { id: acct ? acct.id : route, label: acct ? (A.label(acct) || acct.name || acct.id) : String(route || '') };
  const display = resolved
    ? { resolved: true, source: source.id, sourceLabel: source.label, model: entry ? entry.id : model.value, modelLabel, effort, effortLabel: effort ? effortLabel : '', execution,
      text: [source.label, modelLabel, effort ? effortLabel : ''].filter(Boolean).join(' · ') }
    : { resolved: false, text: 'Select model', problem: (fam || model.value || account.value) && why ? why : null, execution };
  return {
    lane: L, resolved, display,
    family: fam ? fam.id : (wantFam || null), familyLabel: fam ? fam.label : '', familyKind: fam ? fam.kind : null,
    policy: fam ? (policyName || 'auto') : null, policyLabel: fam ? fstore().POLICY_LABEL[policyName || 'auto'] : '', pinned,
    account: acct ? acct.id : (account.value || null), accountScope: account.scope, implicit,
    accountView: A.view(acct), accountLabel: b ? b.name : (acct ? A.label(acct) : ''),
    backing: b ? { id: b.id, name: b.name, identity: b.identity, state: b.state, stateLabel: b.stateLabel, limited: b.limited } : null,
    accountCount: fam ? fam.accounts.length : 0,
    model: entry ? entry.id : (model.value || null), catalogModel: catalogModel || (model.value || null), modelScope: model.scope, modelLabel,
    effort, effortLabel, effortScope: eff.scope, effortAdjusted, effortSource,
    efforts: levels || [], effortLabels: (levels || []).map(caps().label), defaultEffort: entry ? entry.defaultEffort || null : null, effortKnown: Boolean(entry),
    route, ok: Boolean(route), needs, why,
    pending: (s.intel && s.intel.pending && s.intel.pending.lane === L) ? s.intel.pending : null,
    // A CHOICE WAITING for the request now running to finish (never applied mid-run).
    switchPending: (s.intel && s.intel.lanes && s.intel.lanes[L] && s.intel.lanes[L].pendingChoice) ? { ...s.intel.lanes[L].pendingChoice } : null,
  };
}

/** Write the backing account and model into the lane's slots (the route is resolved from these). */
function writeLane(session, L, acctId, modelId) {
  if (L === 'chat') {
    const sel = { ...(session.sourceSelections || {}) };
    if (modelId) sel.lain = modelId; else delete sel.lain;
    session.sourceSelections = sel;
    session.accountSelections = { ...(session.accountSelections || {}), chat: acctId || null };
  } else {
    const v = require('./sessionviews').views(session);
    v.coding.model = modelId || null;
    v.coding.connection = acctId || null;
  }
}

function roleGate(r, modelId, rt, L, A) {
  const roles = require('./modelroles');
  const row = require('./runtimeconnections').rowFor(r, modelId, A.baseOf(rt));
  if (row) { const g = roles.check(row, L === 'chat' ? roles.ROLE.BOT : roles.ROLE.AGENT); if (!g.ok) return g; }
  const gate = roles.check({ modelId }, L === 'chat' ? roles.ROLE.BOT : roles.ROLE.AGENT);
  return gate.ok ? null : gate;
}

/**
 * CHOOSE — the one write every surface makes. Passive: nothing is sent.
 *
 *   family            the provider family; the model is kept when the family
 *                     offers it, else the family's declared default, else the
 *                     lane waits for a model. The backing account follows policy.
 *   account           a specific backing account (the family follows it)
 *   model             must be offered by the lane's family; a model offered by
 *                     one other family only moves the lane to that family
 *   effort            must be a level the model declares ('auto' = its default)
 */
async function choose(app, session, { lane: which = 'coding', family, account, model, effort, _apply = false } = {}) {
  // CHOSEN, SO NO LONGER NEWS (modelcatalog.js): the NEW mark ends when the model is selected.
  if (model && family) { try { require('./modelcatalog').seen(String(family).startsWith('api:') ? family : family, model); } catch { /* a marker */ } }
  const A = accountsMod();
  const F = fab();
  const r = root(app);
  try { await r.ensureCatalog({ announce: false }); } catch { /* resolved from what is cached */ }
  const L = which === 'chat' ? 'chat' : 'coding';
  const li = laneState(session, L);
  const cur = lane(app, session, L);
  // A CHOICE MADE WHILE THIS LANE IS WORKING waits for the next safe turn boundary (pending_backing_account_id):
  // the request in flight keeps the account it started on, and is never cut off for the switch. The person's Stop
  // is the only thing that ends a run early. It is validated when it is applied.
  if (!_apply && cur.account && (family !== undefined || account !== undefined || model !== undefined || effort !== undefined) && laneBusy(session, cur)) {
    if (account) { const a = A.accountFor(app, account); if (!a) return { ok: false, code: 'NO_ACCOUNT', why: `no account "${account}" is configured` }; if (!a.usable) return { ok: false, code: 'ACCOUNT_UNUSABLE', why: `${a.name}: ${a.why}` }; }
    if (family) { const f = F.family(app, family); if (!f) return { ok: false, code: 'NO_FAMILY', why: `no provider "${family}" is connected` }; }
    li.pendingChoice = { family, account, model, effort, at: Date.now() };
    try { session.save(); } catch { /* in memory */ }
    return { ok: true, deferred: true, lane: lane(app, session, L), why: 'It takes effect when the request now running finishes — nothing is interrupted.' };
  }
  if (li.pendingChoice && !_apply) li.pendingChoice = null;   // a newer choice made at rest replaces a waiting one
  let famId = cur.family;
  let acctId = cur.account;
  let modelId = cur.model;
  let effortReset = false;
  if (family !== undefined) {
    if (!family) { famId = null; acctId = null; }
    else {
      const f = F.family(app, family);
      if (!f) return { ok: false, code: 'NO_FAMILY', why: `no provider "${family}" is connected` };
      if (!f.usable) return { ok: false, code: 'FAMILY_UNUSABLE', why: `${f.label} has no signed-in account yet` };
      famId = f.id;
      if (acctId && (!F.familyOfAccount(app, acctId) || F.familyOfAccount(app, acctId).id !== f.id)) acctId = null;
      if (model === undefined) {
        if (!(modelId && f.byModel.has(modelId))) {
          const first = f.accounts.find((a) => a.usable);
          const d = first ? A.defaultModel(app, first.id) : null;
          modelId = d && f.byModel.has(d) ? d : (f.models.length === 1 ? f.models[0].id : null);
        }
      }
    }
  }
  if (account !== undefined) {
    if (!account) acctId = null;
    else {
      const a = A.accountFor(app, account);
      if (!a) return { ok: false, code: 'NO_ACCOUNT', why: `no account "${account}" is configured` };
      if (!a.usable) return { ok: false, code: 'ACCOUNT_UNUSABLE', why: `${a.name}: ${a.why}` };
      acctId = a.id;
      const f = F.familyOfAccount(app, a.id);
      famId = f ? f.id : famId;
      if (model === undefined) {
        const e = f && cur.model ? f.byModel.get(cur.model) : null;
        modelId = e && e.accounts.some((x) => x.id === a.id) ? e.id : A.defaultModel(app, a.id);
      }
    }
  }
  if (model !== undefined) modelId = model ? String(model) : null;
  if (modelId && modelId !== cur.model) {
    // A MODEL SPELLING the catalog folded is stored as its canonical id.
    try { const m = r.catalog().byId.get(modelId); if (m) modelId = m.id; } catch { /* as given */ }
  }
  if (modelId) {
    let f = famId ? F.family(app, famId) : null;
    if (!f || !f.byModel.has(modelId)) {
      const offs = F.familiesOffering(app, modelId);
      if (f && !f.byModel.has(modelId) && account === undefined && family !== undefined) return { ok: false, code: 'NOT_OFFERED', why: `${f.label} does not offer ${modelId}${offs.length ? ` — ${offs.slice(0, 4).map((x) => x.label).join(', ')} ${offs.length === 1 ? 'does' : 'do'}` : ''}` };
      if (offs.length === 1) { f = offs[0]; famId = f.id; if (acctId && (F.familyOfAccount(app, acctId) || {}).id !== f.id) acctId = null; }
      else if (!f) return { ok: false, code: 'NEEDS_FAMILY', why: offs.length ? `${modelId} is offered by ${offs.slice(0, 5).map((x) => x.label).join(', ')} — choose the provider first` : `no configured provider offers ${modelId}`, offering: offs.map((x) => ({ id: x.id, label: x.label })) };
      else if (!f.byModel.has(modelId)) return { ok: false, code: 'NOT_OFFERED', why: `${f.label} does not offer ${modelId}` };
    }
    if (acctId && F.familyOfAccount(app, acctId) && F.familyOfAccount(app, acctId).id !== famId) acctId = null;
    const entry = f.byModel.get(modelId);
    modelId = entry.id;   // THE LOGICAL ID is what the lane keeps; each account's catalog id is resolved at send time
    // EFFORT: a stored level this model does not take goes back to the model's default — and says so.
    const pinned = f.policy === 'pinned' ? (f.pinned || acctId) : null;
    const levels = offered(f, entry, pinned).levels;
    if (effort !== undefined) {
      const e = effort && effort !== 'auto' ? caps().norm(effort) : null;
      if (effort && effort !== 'auto' && !e) return { ok: false, code: 'BAD_EFFORT', why: `effort is one of ${levels.map(caps().label).join(', ') || 'none for this model'}` };
      if (e && !levels.includes(e)) return { ok: false, code: 'EFFORT_UNSUPPORTED', why: `${entry.label} ${levels.length ? `offers ${levels.map(caps().label).join(', ')}` : 'has no configurable effort'}` };
      li.effort = e;
    } else if (li.effort && !levels.includes(caps().norm(li.effort))) { li.effort = null; effortReset = true; }
    // THE BACKING ACCOUNT, by the family's policy.
    const pol = require('./fabric/policy').resolve(app, { family: f.id, model: modelId, effort: li.effort || null, current: acctId, policy: li.policy || null, pinned });
    if (pol.ok) acctId = pol.account.id;
    else if (!acctId) return { ok: false, code: pol.decision === 'incompatible' ? 'NO_ELIGIBLE_ACCOUNT' : 'ACCOUNT_LIMITED', why: pol.why };
    const rt = A.routeFor(app, acctId, catalogIdOf(entry, acctId, modelId));
    if (!rt.ok) return { ok: false, code: rt.code, why: rt.why };
    const gate = roleGate(r, rt.model, rt, L, A);
    if (gate) return { ok: false, code: gate.code, why: gate.why };
  } else if (effort !== undefined) {
    li.effort = effort && effort !== 'auto' ? caps().norm(effort) : null;
  }
  li.family = famId || null;
  writeLane(session, L, acctId, modelId);
  // A PENDING ACCOUNT QUESTION for this lane is answered by any explicit choice.
  if (session.intel && session.intel.pending && session.intel.pending.lane === L && (family !== undefined || account !== undefined || model !== undefined)) session.intel.pending = null;
  return { ok: true, lane: lane(app, session, L), needsModel: Boolean((acctId || famId) && !modelId), effortReset };
}

/** Is a request running through this lane's account right now? (accountwork.js — observed, never signalled.) */
function laneBusy(session, cur) {
  try { if (session && session.inflight && session.inflight.turnId) return true; } catch { /* not in flight */ }
  try { return require('./accountwork').busyAccount(cur.account).length > 0; } catch { return false; }
}

/**
 * THE TURN BOUNDARY: a choice that waited for a running request is applied now, validated as any choice is. One
 * that no longer holds (the account was detached meanwhile) is dropped, and the person is told.
 */
async function applyPending(app, session = app.session) {
  const out = [];
  for (const L of ['chat', 'coding']) {
    const li = laneState(session, L);
    const p = li.pendingChoice;
    if (!p) continue;
    li.pendingChoice = null;
    // eslint-disable-next-line no-await-in-loop -- one lane at a time
    const r = await choose(app, session, { lane: L, family: p.family, account: p.account, model: p.model, effort: p.effort, _apply: true });
    out.push({ lane: L, ok: r.ok, why: r.ok ? null : r.why });
  }
  if (out.length) { try { session.save(); } catch { /* in memory */ } }
  return out;
}

/** THE BACKING ACCOUNT CHANGES — nothing the person chose does (fabric/fallback.js, the Switch answer). */
function switchBacking(app, session, which, accountId) {
  const L = which === 'chat' ? 'chat' : 'coding';
  const cur = lane(app, session, L);
  writeLane(session, L, accountId, cur.model);
  laneState(session, L).family = cur.family;
  return lane(app, session, L);
}

/** The route, model and effort a turn on this lane sends through, or the refusal (turnCfg). */
function routeCfg(app, session, which) {
  const l = lane(app, session, which);
  if (l.ok) return { ok: true, model: l.catalogModel || l.model, logicalModel: l.model, connection: l.route, account: l.account, family: l.family, effort: l.effort, effortKnown: l.effortKnown };
  return { ok: false, model: l.model, why: l.why || 'choose a provider and a model', code: l.needs };
}

/** The lane the session is looking at: Chat, else the Coding Agent. */
function currentLane(session) { try { return require('./sessionviews').current(session) === 'chat' ? 'chat' : 'coding'; } catch { return 'coding'; } }

/** The effective choices, each with the layer it came from. */
function resolve(app, session = app.session) {
  const { project } = projectLayer(app, session);
  const chatL = lane(app, session, 'chat');
  const codingL = lane(app, session, 'coding');
  const now = currentLane(session) === 'chat' ? chatL : codingL;
  const reasoning = now.effortKnown ? { value: now.effort || 'auto', scope: now.effortScope } : (() => {
    const { layer } = projectLayer(app, session);
    const e = storedEffort(app, session, now.lane, layer, globalOf(app, now.lane));
    return { value: e.value || 'auto', scope: e.scope };
  })();
  return {
    project,
    bot: { source: 'lain', model: chatL.model, account: chatL.account, family: chatL.family, scope: chatL.modelScope, accountScope: chatL.accountScope },
    chat: { source: 'lain', model: chatL.model, account: chatL.account, family: chatL.family, scope: chatL.modelScope, accountScope: chatL.accountScope, label: 'Noema', chatOnly: false, lane: chatL },
    coding: { model: codingL.model, account: codingL.account, family: codingL.family, scope: codingL.modelScope, accountScope: codingL.accountScope, lane: codingL },
    reasoning,
    efforts: { chat: chatL.efforts, coding: codingL.efforts },
    overrides: [
      codingL.modelScope !== 'global' ? `Coding Agent model: ${codingL.modelScope}` : null,
      chatL.modelScope !== 'global' ? `Chat model: ${chatL.modelScope}` : null,
      reasoning.scope !== 'global' ? `Reasoning: ${reasoning.scope}` : null,
    ].filter(Boolean),
  };
}

/** Accounts that offer a model — every surface names them the same way (accountcatalog.js). */
function accountsFor(app, modelId) {
  const A = accountsMod();
  const out = A.offering(app, modelId).map((a) => ({ id: a.id, name: a.name, provider: a.family, usable: a.usable, why: a.why, kind: a.kind, pinned: a.pinned }));
  // A NATIVE RUNTIME ACCOUNT WITHOUT A ROUTE is listed for what it is.
  for (const a of A.list(app).accounts) if (!a.usable && !out.some((x) => x.id === a.id)) out.push({ id: a.id, name: a.name, provider: a.family, usable: false, why: a.why, kind: a.kind });
  return out;
}

const EFFORTS = ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * SET one choice at one layer. `value` null clears that layer (the next layer
 * down takes over). A SESSION choice is `choose`. A DEFAULT (project / global)
 * stores the FAMILY with the model — never a model name that resolves through
 * whichever route reaches it first, and a backing account only when pinned.
 * Reasoning is per lane: `which` names it (default: the lane in front).
 */
async function set(app, session, { lane: part, field, value = null, scope = 'session', which: whichLane = null } = {}) {
  if (!['session', 'project', 'global'].includes(scope)) return { ok: false, why: 'scope is session, project or global' };
  if (!['bot', 'chat', 'coding', 'reasoning'].includes(part)) return { ok: false, why: 'the choice is chat, coding or reasoning' };
  const which = part === 'reasoning' ? (whichLane === 'chat' || whichLane === 'coding' ? whichLane : currentLane(session)) : (part === 'coding' ? 'coding' : 'chat');
  if (part !== 'reasoning' && field !== 'account' && field !== 'family' && value) {
    const roles = require('./modelroles');
    const gate = roles.check({ modelId: value }, which === 'chat' ? roles.ROLE.BOT : roles.ROLE.AGENT);
    if (!gate.ok) return { ok: false, why: gate.why, code: gate.code };
  }
  const r = root(app);
  const cfg = r.cfg;
  const v = require('./sessionviews').views(session);
  const save = () => { try { require('./config').save(cfg); } catch { /* reported by the next read */ } };
  if (part === 'reasoning') {
    const e = value == null || value === 'auto' ? null : String(value).toLowerCase();
    if (e && !EFFORTS.includes(caps().norm(e) || e)) return { ok: false, why: `reasoning is one of ${EFFORTS.join(', ')}` };
    if (scope === 'session') {
      // A LEVEL THE LANE'S MODEL DOES NOT TAKE is refused, with the levels it does.
      const l = lane(app, session, which);
      if (e && l.effortKnown && !l.efforts.includes(caps().norm(e))) return { ok: false, code: 'EFFORT_UNSUPPORTED', why: `${l.modelLabel} ${l.efforts.length ? `offers ${l.effortLabels.join(', ')}` : 'has no configurable effort'}` };
      laneState(session, which).effort = e ? caps().norm(e) : null;
      v.effort = e ? caps().norm(e) : null;
    } else if (scope === 'project') { const p = projectOf(session); if (!p) return { ok: false, why: 'open a project first' }; cfg.projects = cfg.projects || {}; cfg.projects[p.id] = { ...(cfg.projects[p.id] || {}), effort: e }; save(); }
    else { cfg.effort = e || undefined; save(); }
    return { ok: true, resolved: resolve(app, session) };
  }
  if (scope === 'session') {
    const body = { lane: which };
    body[field === 'account' ? 'account' : field === 'family' ? 'family' : 'model'] = value || null;
    const res = await choose(app, session, body);
    return res.ok ? { ok: true, resolved: resolve(app, session), lane: res.lane, needsModel: res.needsModel } : res;
  }
  // PROJECT / GLOBAL: a default for sessions that do not choose for themselves — family and model together.
  const A = accountsMod();
  const F = fab();
  try { await r.ensureCatalog({ announce: false }); } catch { /* resolved below */ }
  const key = which === 'chat' ? 'bot' : 'coding';
  let layerNow;
  if (scope === 'project') {
    const p = projectOf(session);
    if (!p) return { ok: false, why: 'open a project first' };
    layerNow = ((cfg.projects && cfg.projects[p.id]) || {})[key] || {};
  } else {
    const rd = fstore().roleDefault(which);
    layerNow = rd ? { model: rd.model || null, family: rd.family || null, connection: rd.pinned || null }
      : which === 'coding' ? { model: cfg.model || null, connection: cfg.connection || null } : { model: (cfg.defaultChat && cfg.defaultChat.model) || null, connection: (cfg.defaultChat && cfg.defaultChat.connection) || null };
  }
  let fam = layerNow.family || (layerNow.connection && F.familyOfAccount(app, layerNow.connection) ? F.familyOfAccount(app, layerNow.connection).id : null);
  let model = layerNow.model || null;
  if (field === 'account' || field === 'family') {
    if (value) {
      let f = field === 'family' ? F.family(app, value) : null;
      if (field === 'account') { const a = A.accountFor(app, value); if (!a) return { ok: false, why: `no account "${value}" is configured` }; if (!a.usable) return { ok: false, why: `${a.name}: ${a.why}` }; f = F.familyOfAccount(app, a.id); }
      if (!f) return { ok: false, why: `no provider "${value}" is connected` };
      fam = f.id;
      if (!(model && f.byModel.has(model))) { const first = f.accounts.find((a) => a.usable); const d = first ? A.defaultModel(app, first.id) : null; model = d && f.byModel.has(d) ? d : (f.models.length === 1 ? f.models[0].id : null); }
    } else { fam = null; }
  } else {
    model = value ? String(value) : null;
    if (model) {
      try { const m = r.catalog().byId.get(model); if (m) model = m.id; } catch { /* as given */ }
      const f = fam ? F.family(app, fam) : null;
      if (!(f && f.byModel.has(model))) {
        const offs = F.familiesOffering(app, model);
        if (offs.length === 1) fam = offs[0].id;
        else return { ok: false, code: 'NEEDS_FAMILY', why: offs.length ? `${model} is offered by ${offs.slice(0, 5).map((x) => x.label).join(', ')} — choose the default provider first` : `no configured provider offers ${model}` };
      }
    }
  }
  if (model && fam) {
    const f = F.family(app, fam);
    const elig = F.eligible(app, fam, model, null);
    if (!elig.length) return { ok: false, why: `no ${f ? f.label : fam} account serves ${model}` };
    const entry = f.byModel.get(model);
    model = entry.id;
    const rt = A.routeFor(app, elig[0].account.id, catalogIdOf(entry, elig[0].account.id, model));
    if (!rt.ok) return { ok: false, why: rt.why, code: rt.code };
    const gate = roleGate(r, rt.model, rt, which, A);
    if (gate) return { ok: false, why: gate.why, code: gate.code };
  }
  if (scope === 'project') {
    const p = projectOf(session);
    cfg.projects = cfg.projects || {};
    const cur = { ...(cfg.projects[p.id] || {}) };
    cur[key] = { model: model || null, family: fam || null, connection: null };
    cfg.projects[p.id] = cur;
    save();
  } else {
    const prev = fstore().roleDefault(which) || {};
    fstore().setRoleDefault(which, model || fam ? { ...prev, family: fam || null, model: model || null } : null);
    // THE LEGACY KEYS FOLLOW, so an older reader names the same model (never an account — policy chooses it).
    if (which === 'coding') { cfg.model = model || undefined; cfg.connection = undefined; }
    else cfg.defaultChat = { ...(cfg.defaultChat || {}), source: 'lain', model: model || null, connection: null };
    save();
  }
  return { ok: true, resolved: resolve(app, session) };
}

/** For turnCfg: the project layer and the reasoning override, applied to a copy. */
function overlay(app, session, cfg) {
  const v = require('./sessionviews').views(session);
  const { layer } = projectLayer(app, session);
  if (!v.coding.model && layer.coding && layer.coding.model) {
    cfg.model = layer.coding.model;
    if (layer.coding.connection) cfg.connection = layer.coding.connection;
  }
  const effort = v.effort != null ? v.effort : (layer.effort != null ? layer.effort : undefined);
  if (effort !== undefined) cfg.effort = effort || undefined;
  return cfg;
}

module.exports = { resolve, set, accountsFor, overlay, lane, choose, applyPending, switchBacking, routeCfg, currentLane, laneState, EFFORTS };
