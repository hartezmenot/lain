'use strict';

/** THE ASSISTANT'S ROUTES — a projection of Core's task store, never a second one. */

const store = require('../assistant/store');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400) { return { code, body: { ok: false, why: String(why) } }; }
function root(app) { return (app && app._sibling) || app; }

const SETTINGS_DEFAULTS = Object.freeze({
  notifications: true, defaultTargets: ['desktop'], quietHours: { enabled: false, start: '22:00', end: '07:00' },
  quietExactReminders: 'deliver', background: true, conditionChecks: true, missedPolicy: 'deliver_late',
});

function settings(app) { const c = root(app).cfg || {}; return { ...SETTINGS_DEFAULTS, ...(c.assistant || {}) }; }

function view(t) {
  return {
    id: t.id, type: t.type, title: t.title, instruction: t.instruction || null, state: t.state,
    schedule: t.schedule, describe: require('../assistant/schedule').describe(t), timezone: t.timezone,
    nextRun: t.nextRun || null, lastRun: t.lastRun || null, deferredUntil: t.deferredUntil || null,
    action: t.action || null, watch: t.watch || null, modelPolicy: t.modelPolicy, missedPolicy: t.missedPolicy,
    delivery: t.delivery, deliveryState: t.deliveryState || null, result: t.result || null,
    requiredCapabilities: t.requiredCapabilities || [], origin: t.origin || null, projectRoot: t.projectRoot || null, runs: t.runs || 0, createdAt: t.createdAt,
  };
}

function state(app) {
  const all = store.list().map(view);
  const live = (x) => ['scheduled', 'watching', 'paused', 'running'].includes(x.state);
  return {
    at: Date.now(),
    upcoming: all.filter((x) => live(x) && (x.type === 'reminder' || x.type === 'scheduled')),
    recurring: all.filter((x) => live(x) && x.type === 'recurring'),
    watches: all.filter((x) => live(x) && x.type === 'watch'),
    completed: all.filter((x) => !live(x)).sort((a, b) => (b.lastRun || b.createdAt) - (a.lastRun || a.createdAt)).slice(0, 100),
    activity: store.activity({ limit: 100 }),
    settings: settings(app),
    scopes: require('../assistant/intent').scopes(app),
    scheduler: require('../assistant/scheduler').status(app),
    policies: store.POLICY, targets: store.TARGETS, actions: store.ACTIONS,
  };
}

function saveCfg(app) { try { require('../config').save(root(app).cfg); } catch { /* applies in memory */ } }

const ROUTES = {
  'POST /api/assistant/state': async (app) => ok(state(app)),

  'POST /api/assistant/task': async (app, body = {}) => {
    const spec = body.task || {};
    const n = store.normalize({ ...spec, origin: spec.origin || 'desktop', delivery: spec.delivery || { targets: settings(app).defaultTargets }, missedPolicy: spec.missedPolicy || settings(app).missedPolicy });
    if (!n.ok) return bad(n.why);
    // COST SAFEGUARD: a model runs every time a model-backed recurring task fires.
    if (n.task.modelPolicy !== 'NO_MODEL' && n.task.type !== 'reminder' && body.confirmPolicy !== n.task.modelPolicy) {
      return { code: 409, body: { ok: false, needsConfirm: true, modelPolicy: n.task.modelPolicy, model: require('../assistant/actions').modelFor(app, n.task.modelPolicy), why: `This task runs a model (${n.task.modelPolicy}) every time it fires. Confirm the policy to save it.` } };
    }
    const r = store.create(n.task);
    if (!r.ok) return bad(r.why);
    require('../assistant/scheduler').poke(app);
    return ok({ task: view(r.task), ...state(app) });
  },

  // A SENTENCE, understood by the same deterministic door app.submit uses (intent.js) — no model.
  'POST /api/assistant/interpret': async (app, body = {}) => {
    const text = String(body.text || '').trim();
    if (!text) return bad('say what to schedule');
    const r = await require('../assistant/intent').interpret(app, text, { from: null });
    if (!r) return bad('Not understood without a model. Try “remind me in 20 minutes to …”, “every day at 8 show my model limits”, “tell me when Claude resets” — or use the form for a model task.');
    return r.task ? ok({ text: r.text, task: view(r.task), ...state(app) }) : ok({ text: r.text, answered: true, ...state(app) });
  },

  'POST /api/assistant/task/act': async (app, body = {}) => {
    const id = String(body.id || '');
    const act = String(body.action || '');
    let r;
    if (act === 'cancel') r = store.cancel(id);
    else if (act === 'pause') r = store.pause(id);
    else if (act === 'resume') r = store.resume(id);
    else if (act === 'remove') r = store.remove(id);
    else if (act === 'run') {
      const t = store.get(id);
      if (!t) return bad('no such task', 404);
      r = await require('../assistant/scheduler').runTask(app, t);
      r = { ok: true, ran: r.fired ? r.row : null };
    } else return bad('action is cancel, pause, resume, remove or run');
    if (!r.ok) return bad(r.why, 404);
    require('../assistant/scheduler').poke(app);
    return ok({ ...state(app), ran: r.ran || null });
  },

  'POST /api/assistant/settings': async (app, body = {}) => {
    const cfg = root(app).cfg;
    const cur = settings(app);
    const next = { ...cur };
    const s = body.settings || {};
    if ('notifications' in s) next.notifications = Boolean(s.notifications);
    if ('background' in s) next.background = Boolean(s.background);
    if ('conditionChecks' in s) next.conditionChecks = Boolean(s.conditionChecks);
    if (Array.isArray(s.defaultTargets)) { const t = s.defaultTargets.filter((x) => store.TARGETS.includes(x)); if (!t.length) return bad('choose at least one delivery target'); next.defaultTargets = t; }
    if (s.missedPolicy) { if (!store.MISSED.includes(s.missedPolicy)) return bad(`missed runs: one of ${store.MISSED.join(', ')}`); next.missedPolicy = s.missedPolicy; }
    if (s.quietExactReminders) { if (!['deliver', 'defer'].includes(s.quietExactReminders)) return bad('exact reminders in quiet hours: deliver or defer'); next.quietExactReminders = s.quietExactReminders; }
    if (s.quietHours) {
      const q = { ...cur.quietHours, ...s.quietHours };
      const re = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!re.test(q.start) || !re.test(q.end)) return bad('quiet hours are HH:MM');
      next.quietHours = { enabled: Boolean(q.enabled), start: q.start, end: q.end };
    }
    cfg.assistant = next;
    saveCfg(app);
    require('../assistant/scheduler').poke(app);
    return ok(state(app));
  },

  'POST /api/assistant/scopes': async (app, body = {}) => {
    const cfg = root(app).cfg;
    const want = body.scopes || {};
    const cur = require('../assistant/intent').scopes(app);
    for (const k of Object.keys(cur)) if (k in want) cur[k] = Boolean(want[k]);
    cfg.bot = cfg.bot || {}; cfg.bot.platforms = cfg.bot.platforms || {}; cfg.bot.platforms.telegram = cfg.bot.platforms.telegram || {};
    cfg.bot.platforms.telegram.scopes = cur;
    saveCfg(app);
    return ok(state(app));
  },
};

module.exports = { ROUTES, state, settings, SETTINGS_DEFAULTS };
