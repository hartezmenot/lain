'use strict';

/** THE USAGE VIEW'S ROUTES — consumption (usage.js receipts) and limits (the providers' own windows, per account), side by side and never combined. */

const usage = require('../usage');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400) { return { code, body: { ok: false, why: String(why) } }; }

// `month` is the calendar month so far (the usage tracker's "this month"); the others are rolling.
const RANGES = { today: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }, '7d': () => Date.now() - 7 * 864e5, '30d': () => Date.now() - 30 * 864e5, month: () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); }, all: () => 0 };
const FILTERS = ['project', 'session', 'task', 'model', 'provider', 'account', 'role', 'via', 'origin'];

function root(app) { return (app && app._sibling) || app; }

/** Every account's windows, as reported — THE SAME PROJECTION the Accounts page draws (fabric/quotaview.js). */
function limits(app) {
  const accounts = require('../fabric/quotaview').rows(app).map((r) => ({
    id: r.id, name: r.name, driver: r.family, provider: r.brand || r.family, source: r.kind, enabled: r.enabled,
    identity: r.identity ? { email: r.identity.email || null, planType: r.identity.plan || null } : null,
    reportedBy: r.windows.length ? (r.quotaSource || 'provider') : null, observedAt: r.quotaAt,
    windows: r.windows.map((w) => ({ id: w.id, label: w.label, usedPercent: w.usedPercent, remainingPercent: w.remainingPercent, resetsAt: w.resetsAt, expired: w.expired, confirmed: false })),
    notReported: r.windows.length ? null : r.quotaNote,
  }));
  const windows = [];
  for (const a of accounts) for (const w of a.windows) windows.push({ account: a.id, name: a.name, provider: a.provider, ...w });
  return { accounts, windows };
}

/** Limits grouped by what each source actually reports — from the same projection. */
function grouped(app) {
  const base = limits(app);
  const active = base.accounts.filter((a) => a.windows.length);
  const none = base.accounts.filter((a) => !a.windows.length).map((a) => ({ id: a.id, name: a.name, provider: a.provider, why: a.notReported }));
  const plans = [];
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
