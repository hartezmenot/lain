'use strict';

/** THE SESSION'S FACTS, ONCE (Phase 8.2) — what every surface says about the session it drives: the terminal's /status, Telegram's /status, the window's… */

function laneFacts(l) {
  if (!l) return { provider: null, familyId: null, account: null, accountId: null, model: null, modelId: null, effort: null, policy: null, route: null, needs: 'family', why: '' };
  return {
    // THE LOGICAL ROUTE (Phase 8.3): provider family › model › effort — what the person chose.
    provider: l.familyLabel || null, familyId: l.family || null,
    model: l.modelLabel || l.model || null, modelId: l.model || null,
    effort: require('./sessionintel').effortText(l) || null, effortId: l.effort || null, efforts: l.effortLabels || [], effortSource: l.effortSource || null,
    policy: l.policyLabel || null, policyId: l.policy || null,
    // THE BACKING ACCOUNT — a diagnostic detail under the route, never its name.
    account: l.accountLabel || l.account || null, accountId: l.account || null, accounts: l.accountCount || 0,
    route: l.route || null, needs: l.needs || null, why: l.why || '', pending: l.pending || null,
  };
}

function facts(app) {
  const s = app.session;
  const si = require('./sessionintel');
  const lane = (which) => { try { return si.lane(app, s, which); } catch { return null; } };
  let reasoning = null;
  try { reasoning = si.resolve(app, s).reasoning; } catch { reasoning = null; }
  let proj = null;
  try { proj = require('./sessionviews').project(s); } catch { proj = null; }
  const sup = require('./supervision');
  const rs = require('./runstrategy');
  const ph = (() => { try { return sup.phaseInfo(s); } catch { return { total: 0, done: 0, current: null }; } })();
  const goal = (() => { try { return require('./goal').text(s); } catch { return ''; } })();
  const task = s.task ? String(s.task.objective || '').slice(0, 200) : '';
  const w = (() => { try { return require('./workbench').of(s); } catch { return {}; } })();
  return {
    session: s.id,
    project: { name: proj && proj.attached ? proj.name : null, path: s.cwd || null, github: (proj && proj.github) || null },
    task: task || goal || null,
    taskId: (s.task && s.task.id) || null,
    coding: laneFacts(lane('coding')),
    chat: laneFacts(lane('chat')),
    front: (() => { try { return require('./sessionintel').currentLane(s); } catch { return 'coding'; } })(),
    effort: reasoning ? reasoning.value : null,
    execution: require('./profile').of(s, app.cfg),
    pendingExecution: w.pendingProfile || null,
    strategy: (() => { try { return rs.LABEL[rs.get(s).kind]; } catch { return null; } })(),
    mode: (() => { try { return require('./execmode').of(s); } catch { return null; } })(),
    phase: (() => { try { return sup.statusLine(app); } catch { return null; } })(),
    plan: ph.total ? { done: ph.done, total: ph.total, current: ph.current ? ph.current.text : null } : null,
  };
}

/** A lane as one phrase, provider first: "Codex › GPT-6 Sol · XHigh", or what it is waiting for. */
function laneText(x) {
  const who = x.provider || x.account;
  if (who && x.modelId) return `${who} › ${x.model}${x.effort ? ` · ${x.effort}` : ''}`;
  if (who) return `${who} › choose a model`;
  if (x.modelId) return `choose a provider for ${x.model}`;
  return 'not set';
}

/** The facts as [label, value] rows — the terminal's /status and Telegram's /status print these. */
function rows(f) {
  return [
    ['session', f.session],
    // ONE LINE: the path (its last part is the name); an unassigned session's folder is LAIN's own, not news.
    ['project', f.project.name ? f.project.path : (f.project.github ? `${f.project.github} (not cloned)` : 'Unassigned — no project folder')],
    ['task', f.task ? `${f.task}${f.taskId ? ` · ${f.taskId}` : ''}` : 'none'],
    // THE LANE IN FRONT, as the person chose it — provider, model, effort, execution — then how its
    // account is managed and which backing account serves it now (Phase 8.3).
    ...frontRows(f),
    ['execution', word(f.execution) + (f.pendingExecution && f.pendingExecution !== f.execution ? ` → ${word(f.pendingExecution)} at the next checkpoint` : '')],
    ['account', accountText(f[f.front === 'chat' ? 'chat' : 'coding'])],
    // THE OTHER LANE, in one phrase.
    [f.front === 'chat' ? 'coding agent' : 'chat', laneText(f.front === 'chat' ? f.coding : f.chat)],
    // ONE ROW FOR WHERE THE WORK STANDS: phase · run strategy · mode · the plan's progress.
    ['phase', `${f.phase || 'Idle'} · ${f.strategy || 'Normal'} · ${f.mode || 'AUTO'}${f.plan ? ` · plan ${f.plan.done} of ${f.plan.total}${f.plan.current ? ` — now: ${f.plan.current}` : ''}` : ''}`],
  ];
}

/** NORMAL → Normal: a profile as a person reads it. */
function word(p) { const s = String(p || 'NORMAL').toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); }

function frontRows(f) {
  const x = f[f.front === 'chat' ? 'chat' : 'coding'];
  if (!x.provider && !x.modelId) return [['provider', x.why || 'not set'], ['model', '—'], ['effort', x.effort || '—']];
  return [
    ['provider', `${x.provider || x.account || 'choose a provider'}${f.front === 'chat' ? ' (chat)' : ''}${x.policy ? ` · ${x.policy}` : ''}`],
    ['model', x.model || (x.why || 'choose a model')],
    ['effort', x.effort || (x.efforts && x.efforts.length ? 'Default' : 'not configurable')],
  ];
}

/** "Personal (of 3)" — the backing account serving the lane now, and a question waiting on it. */
function accountText(x) {
  if (!x.account) return x.why || 'none';
  return `${x.account}${x.accounts > 1 ? ` (of ${x.accounts})` : ''}${x.pending ? ' · waiting for your decision' : ''}`;
}

module.exports = { facts, rows, laneText };
