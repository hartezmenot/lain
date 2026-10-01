'use strict';

/**
 * THE USAGE VIEW'S ROUTES — consumption (usage.js receipts) and limits (the
 * providers' own windows, per account), side by side and never combined.
 *
 *   /api/usage          totals, one grouping, every filter (project, session,
 *                       task, model, provider, account, role, source), the facets
 *                       a filter bar offers, local runtime speed, and context
 *                       efficiency — provider cache and LAIN's own reuse apart
 *   /api/usage/limits   grouped by what the source actually reports:
 *                         active    windows a provider or runtime reported
 *                         plans     credits / plans a provider reports
 *                         none      accounts with nothing reported (collapsed)
 *                         local     local models — no provider quota
 */

const usage = require('../usage');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400) { return { code, body: { ok: false, why: String(why) } }; }

// `month` is the calendar month so far (the usage tracker's "this month"); the others are rolling.
const RANGES = { today: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }, '7d': () => Date.now() - 7 * 864e5, '30d': () => Date.now() - 30 * 864e5, month: () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); }, all: () => 0 };
const FILTERS = ['project', 'session', 'task', 'model', 'provider', 'account', 'role', 'via', 'origin'];

function root(app) { return (app && app._sibling) || app; }

/** Every account's windows, as reported. Account view and window view (unchanged contract). */
function limits(app) {
  const accounts = [];
  for (const v of require('../accountinstances').list(app)) {
    const ws = (v.limits && v.limits.windows) || [];
    accounts.push({
      id: v.id, name: v.display_name, driver: v.driver_id, provider: v.provider, source: v.source_type,
      identity: v.identity ? { email: v.identity.email || null, planType: v.identity.planType || null } : null,
      reportedBy: v.limits ? v.limits.reportedBy || 'provider' : null, observedAt: v.limits ? v.limits.observedAt || null : null,
      windows: ws.map((w) => ({ id: w.id, label: w.label || w.name || w.id, usedPercent: w.usedPercent != null ? w.usedPercent : (w.percent != null ? w.percent : null),
        resetsAt: w.resetsAt || (w.resetAt ? Date.parse(w.resetAt) || null : null), expired: Boolean(w.expired), confirmed: false })),
      notReported: !ws.length ? (v.limits_error || 'not reported by the provider') : null,
    });
  }
  // CLAUDE CODE: the windows its runtime streamed on the last run (rate_limit_event).
  const cc = require('../runtimeadapters').cachedTelemetry('claude-code');
  if (cc && cc.limits && cc.limits.windows && cc.limits.windows.length) {
    accounts.push({
      id: 'runtime:claude-code', name: `Claude Code${cc.identity && cc.identity.plan ? ` · ${cc.identity.plan}` : ''}`, driver: 'claude-code', provider: 'anthropic', source: 'runtime',
      identity: cc.identity ? { email: cc.identity.email || null, planType: cc.identity.plan || null } : null,
      reportedBy: cc.limits.basis, observedAt: cc.limits.at,
      windows: cc.limits.windows.map((w) => ({ id: w.id, label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt, expired: Boolean(w.resetsAt && w.resetsAt < Date.now()), confirmed: false })),
      notReported: null,
    });
  }
  const windows = [];
  for (const a of accounts) for (const w of a.windows) windows.push({ account: a.id, name: a.name, provider: a.provider, ...w });
  return { accounts, windows };
}

/** Limits grouped by what each source actually reports. */
function grouped(app) {
  const base = limits(app);
  const active = base.accounts.filter((a) => a.windows.length);
  const none = base.accounts.filter((a) => !a.windows.length).map((a) => ({ id: a.id, name: a.name, provider: a.provider, why: a.notReported }));
  // API routes: a live reading when a response carried rate-limit headers, else "none reported".
  const uw = require('../usagewindows');
  try {
    for (const g of require('./accounts').providers(app)) {
      for (const c of g.connections) {
        const r = uw.forConnection(c.id);
        if (r && r.windows && r.windows.length) {
          active.push({ id: c.id, name: `${g.label} · ${c.id}`, driver: 'api', provider: g.provider, source: 'api', reportedBy: 'provider response headers', observedAt: r.at || null,
            windows: r.windows.map((w) => ({ id: w.name || w.kind, label: w.label || w.name, usedPercent: w.percent != null ? w.percent : null, resetsAt: w.resetAt || null, expired: false, confirmed: false })) });
        } else if (!none.some((x) => x.id === c.id)) none.push({ id: c.id, name: `${g.label} · ${c.id}`, provider: g.provider, why: 'no limit reported by this provider' });
      }
    }
  } catch { /* no catalog */ }
  const plans = [];
  // NO ZCODE START PLAN (2026-09-29): LAIN integrates Z.ai through its API only; its quota comes from Z.ai's monitor (fabric/quotaread.js).
  const local = [];
  try {
    for (const m of require('../local/modeldirs').list().models) local.push({ id: m.id, name: m.modelName || m.name, via: 'llama.cpp' });
    const o = require('../local/ollama').cached();
    for (const m of ((o && o.models) || [])) local.push({ id: m.id, name: m.name, via: 'Ollama' });
  } catch { /* none */ }
  return { active, plans, none, local, at: Date.now() };
}

/** The values a filter bar offers, from the rows in range (bounded). */
function facets(rows) {
  const out = {};
  for (const d of FILTERS) {
    const m = new Map();
    for (const r of rows) { const k = usage.keyOf(r, d); m.set(k, (m.get(k) || 0) + 1); }
    out[d] = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([key, n]) => ({ key, n }));
  }
  return out;
}

const ROUTES = {
  'POST /api/usage': async (app, body = {}) => {
    const range = RANGES[body.range] ? body.range : '7d';
    const by = usage.DIMS.includes(body.by) ? body.by : 'model';
    const from = RANGES[range]();
    const all = usage.read({ from });
    const filters = {};
    for (const k of FILTERS) if (body.filters && body.filters[k] != null && body.filters[k] !== '') filters[k] = String(body.filters[k]);
    const rows = usage.filter(all, filters);
    const cfg = root(app).cfg || {};
    // MORE GROUPINGS OF THE SAME ROWS (the Usage page's provider and account shares) — one read, not three.
    const also = Array.isArray(body.also) ? body.also.filter((d) => usage.DIMS.includes(d) && d !== by).slice(0, 4) : [];
    const groupsBy = {};
    for (const d of also) groupsBy[d] = usage.aggregate(rows, d, cfg).slice(0, 50).map((g) => ({ key: g.key, requests: g.requests, input: g.input, output: g.output, cacheRead: g.cacheRead, cacheWrite: g.cacheWrite, reasoning: g.reasoning, reported: g.reported }));
    return ok({
      range, by, filters, at: Date.now(), groupsBy,
      totals: usage.sum(rows, cfg),
      groups: usage.aggregate(rows, by, cfg).slice(0, 200),
      bySource: usage.aggregate(rows, 'via', cfg).map((g) => ({ key: g.key, requests: g.requests, input: g.input, output: g.output, estimated: g.estimated, local: g.local })),
      sources: usage.aggregate(rows, 'source', cfg).map((g) => ({ source: g.key, requests: g.requests })),
      efficiency: usage.efficiency(rows),
      context: require('../contextmetrics').summary({ from }),
      facets: facets(all),
      priced: Object.keys((cfg.usage && cfg.usage.prices) || {}).length,
      totalInRange: all.length,
      // THE INDEX (usageindex.js): per-day totals from hourly aggregates — no receipt re-read.
      // (A filter the index is not keyed on — task, via — falls back to the rows.)
      daily: Object.keys(filters).every((k) => require('../usageindex').DIMS.includes(k))
        ? require('../usageindex').aggregate({ from, by: 'day', filters }).groups.sort((a, b) => (a.key < b.key ? -1 : 1))
        : usage.aggregate(rows, 'day', cfg).map((g) => ({ key: g.key, requests: g.requests, input: g.input, output: g.output, cacheRead: g.cacheRead, cacheWrite: g.cacheWrite, reasoning: g.reasoning })).sort((a, b) => (a.key < b.key ? -1 : 1)),
      index: require('../usageindex').stats(),
    });
  },
  'POST /api/usage/limits': async (app) => ok({ at: Date.now(), ...limits(app), grouped: grouped(app) }),
  /** THE TOP-RIGHT TRACKER'S DROPDOWN (usagetracker.js): LAIN-observed overall, and the lane's windows with what LAIN saw in each. */
  'POST /api/usage/tracker': async (app, body = {}) => ok(require('../usagetracker').dropdown(app, { range: body.range, lane: body.lane })),
  'POST /api/usage/refresh-limits': async (app, body = {}) => {
    const ai = require('../accountinstances');
    const id = String(body.id || '');
    if (!id) return bad('which account');
    const r = await ai.refresh(app, id);
    return r.ok ? ok({ at: Date.now(), ...limits(app), grouped: grouped(app) }) : bad(r.why, 409);
  },
};

module.exports = { ROUTES, limits, grouped, facets };
