'use strict';

/** SETTINGS › STORAGE — the Harness's door to cachecare.js (Gate 3 §77–80). */

const care = require('../cachecare');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400, extra = {}) { return { code, body: { ok: false, why: String(why), ...extra } }; }

const jobs = { inspect: { running: false, partial: null, result: null, error: null, startedAt: null }, clear: { running: false, result: null, error: null, startedAt: null } };

function state() {
  return { inspect: { running: jobs.inspect.running, partial: jobs.inspect.partial, result: jobs.inspect.result, error: jobs.inspect.error, startedAt: jobs.inspect.startedAt },
    clear: { running: jobs.clear.running, result: jobs.clear.result, error: jobs.clear.error, startedAt: jobs.clear.startedAt } };
}

function startInspect(app) {
  if (jobs.inspect.running) return;
  Object.assign(jobs.inspect, { running: true, partial: [], error: null, startedAt: Date.now() });
  care.inspect(app, { onProgress: (cats) => { jobs.inspect.partial = cats; } })
    .then((r) => { jobs.inspect.result = r; }, (e) => { jobs.inspect.error = String((e && e.message) || e); })
    .finally(() => { jobs.inspect.running = false; jobs.inspect.partial = null; });
}

const ROUTES = {
  'POST /api/cache/inspect': async (app, body = {}) => {
    const fresh = jobs.inspect.result && Date.now() - jobs.inspect.result.at < 60000;
    if (body.refresh || !fresh) startInspect(app);
    return ok(state());
  },
  'POST /api/cache/clear': async (app, body = {}) => {
    if (jobs.clear.running) return ok({ ...state(), joined: true });
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
    const advanced = (ids || []).filter((id) => { const c = care.CATEGORIES.find((x) => x.id === id); return c && c.tier === 'advanced'; });
    if (advanced.length && body.confirmAdvanced !== true) return bad('advanced categories need your confirmation', 428, { advanced });
    Object.assign(jobs.clear, { running: true, result: null, error: null, startedAt: Date.now() });
    care.clear(app, { ids, confirmAdvanced: body.confirmAdvanced === true })
      .then((r) => { jobs.clear.result = r; jobs.inspect.result = null; startInspect(app); }, (e) => { jobs.clear.error = String((e && e.message) || e); })
      .finally(() => { jobs.clear.running = false; });
    return ok(state());
  },
  'POST /api/cache/state': async () => ok(state()),
};

/** Polled while a job runs — not an action worth logging. */
const QUIET = ['/api/cache/state', '/api/cache/inspect'];

module.exports = { ROUTES, QUIET };
