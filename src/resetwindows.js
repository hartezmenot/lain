'use strict';

/**
 * USAGE PER PROVIDER RESET WINDOW — the provider's window, and what LAIN itself
 * observed being spent inside it. Two different numbers, never merged:
 *
 *   PROVIDER   "72% remaining" — the provider said it (Claude Code's
 *              rate_limit_event, a Codex account's rate-limit snapshot, a
 *              route's rate-limit headers). Covers ALL use of the account,
 *              including use outside LAIN.
 *   OBSERVED   input / output / reasoning / cache read / cache write / requests
 *              (and cost, only where a source reported one) from LAIN's own
 *              receipts (usage.js) whose time falls inside [start, reset).
 *              Only what went through LAIN; never claimed to equal the quota,
 *              unless the provider's quota is itself token-denominated.
 *
 * A window is only placed in time when its length is known: Claude Code names
 * its windows (five_hour, seven_day…), Codex states `windowDurationMins`, a
 * header names its unit (5h, 7d). Otherwise it is listed with its reset only
 * and LAIN says it cannot bound it — nothing is guessed.
 *
 * PROVIDER LABELS ARE KEPT ("5-hour" stays "5-hour"); the category
 * (SHORT_TERM / DAILY / WEEKLY / MONTHLY / CREDITS / EXPIRY) is for grouping.
 *
 * PREVIOUS WINDOW: the same length ending at this window's start. LAIN's own
 * receipts cover it exactly; the provider's percentage for it is whatever LAIN
 * last saw before that reset (window-snapshots.json) — or "not recorded".
 *
 * ESTIMATED EFFECTIVE CAPACITY (2026-09-30): each time the provider's % moves,
 * the snapshot keeps a paired reading — the % and the tokens LAIN observed in
 * the window at that moment. Where the % rose AND LAIN saw tokens in between,
 * the ratio says how many LAIN-observed tokens one percent has meant; summed,
 * "~N equivalent tokens" for the whole window. It is labelled an estimate, with
 * a confidence (High / Medium / Low) from how many readings agree and how far
 * the % travelled — and "Insufficient data" until there are enough. A reading
 * that moved with nothing seen by LAIN is use outside LAIN: excluded, and it
 * lowers the confidence. Never a provider figure; never used to block a run.
 */

const fs = require('fs');
const path = require('path');

const MIN = 60 * 1000;
const NAMED = Object.freeze({ five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080, one_hour: 60, daily: 1440, weekly: 10080, monthly: 43200 });

function category(mins) {
  if (!mins) return 'UNKNOWN';
  if (mins < 1440) return 'SHORT_TERM';
  if (mins < 10080) return 'DAILY';
  if (mins < 40000) return 'WEEKLY';
  return 'MONTHLY';
}

const SERIES_MAX = 24;       // paired readings kept per window instance
const INSTANCES_MAX = 6;     // the most recent window instances an estimate draws on (plans change)

/**
 * THE ESTIMATE from paired readings (`series`: [at, usedPercent, observedTokens]) across a window's recent
 * instances. A step is a rise of the provider's % with LAIN tokens seen since the last rise; readings where the
 * % held still carry their tokens into the next rise (providers report whole percents).
 */
function capacity(instances) {
  const steps = [];
  let outside = 0;
  const recent = instances.filter((x) => Array.isArray(x.series) && x.series.length > 1).sort((a, b) => (b.resetsAt || 0) - (a.resetsAt || 0)).slice(0, INSTANCES_MAX);
  for (const inst of recent) {
    const pts = inst.series.slice().sort((a, b) => a[0] - b[0]);
    let anchor = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      // A FALL (a reset inside the instance, or receipts rewritten) starts over from here.
      if (p[1] < anchor[1] || p[2] < anchor[2]) { anchor = p; continue; }
      const du = p[1] - anchor[1];
      if (du <= 0) continue;
      const dt = p[2] - anchor[2];
      if (dt > 0) steps.push({ du, dt }); else outside++;
      anchor = p;
    }
  }
  const span = Math.round(steps.reduce((a, s) => a + s.du, 0) * 10) / 10;
  const base = { label: 'Estimated effective capacity', unit: 'equivalent tokens', readings: steps.length, span, outside };
  if (steps.length < 2 || span < 3) {
    return { ...base, tokens: null, confidence: 'Insufficient data', basis: steps.length ? `${steps.length} paired reading${steps.length === 1 ? '' : 's'} over ${span} points of the provider's % — not enough to estimate` : 'no paired readings yet — the provider\'s % has to move while Noema is working' };
  }
  const tokens = Math.round((steps.reduce((a, s) => a + s.dt, 0) / span) * 100);
  const ratios = steps.map((s) => s.dt / s.du);
  const mean = ratios.reduce((a, r) => a + r, 0) / ratios.length;
  const sd = Math.sqrt(ratios.reduce((a, r) => a + (r - mean) ** 2, 0) / ratios.length);
  const cv = mean ? sd / mean : 1;
  const outsideShare = outside / (steps.length + outside);
  const confidence = steps.length >= 6 && span >= 20 && cv <= 0.25 && outside === 0 ? 'High'
    : steps.length >= 4 && span >= 10 && cv <= 0.5 && outsideShare <= 0.2 ? 'Medium' : 'Low';
  return {
    ...base, tokens, confidence, spread: Math.round(cv * 100) / 100,
    basis: `${steps.length} paired readings over ${span} points of the provider's %, from the input + output tokens Noema observed; assumes the account was not used outside Noema meanwhile${outside ? ` (${outside} reading${outside === 1 ? '' : 's'} moved with no Noema use — excluded)` : ''}`,
  };
}

function snapFile() { return path.join(require('./config').configDir(), 'usage', 'window-snapshots.json'); }
function readSnaps() { try { return JSON.parse(fs.readFileSync(snapFile(), 'utf8')); } catch { return {}; } }
function writeSnaps(s) {
  try {
    const keys = Object.keys(s).sort((a, b) => (s[b].at || 0) - (s[a].at || 0)).slice(0, 500);
    const out = {}; for (const k of keys) out[k] = s[k];
    fs.mkdirSync(path.dirname(snapFile()), { recursive: true });
    fs.writeFileSync(snapFile(), JSON.stringify(out));
  } catch { /* a cache of observations */ }
}

/** Every provider-reported window LAIN knows about now, with where it came from and which receipts belong to it. */
function sources(app) {
  const out = [];
  // CLAUDE CODE — its own rate_limit_event, cached with its telemetry.
  try {
    const t = require('./runtimeadapters').cachedTelemetry('claude-code');
    const ws = (t && t.limits && t.limits.windows) || [];
    if (ws.length) {
      out.push({ id: 'claude-code', family: 'claude', label: 'Claude Code', account: (t.identity && (t.identity.plan || t.identity.email)) || null, basis: (t.limits && t.limits.basis) || 'reported by Claude Code',
        windows: ws.map((w) => ({ ...w, mins: NAMED[w.id] || null })),
        match: (r) => r.runtime === 'claude-code' || r.via === 'Runtime · Claude Code' });
    }
  } catch { /* none */ }
  // RUNTIME ACCOUNTS (Codex …) — each account's own snapshot.
  try {
    for (const v of require('./accountinstances').list(app)) {
      const ws = (v.limits && v.limits.windows) || [];
      if (!ws.length) continue;
      out.push({ id: v.id, family: v.driver_id, label: (require('./fabric/store').alias(v.id) || v.display_name), account: v.identity ? (v.identity.email || v.identity.planType || null) : null, basis: v.limits.reportedBy || 'provider-reported',
        windows: ws.map((w) => ({ ...w, mins: w.windowMins || NAMED[w.id] || null })),
        credits: v.limits.resetCredits != null ? { available: v.limits.resetCredits } : null,
        match: (r) => r.account === v.id || String(r.account || '').startsWith(`${v.id}:`) });
    }
  } catch { /* none */ }
  // API CONNECTIONS WHOSE PROVIDER ANSWERS QUOTA ON REQUEST (Z.ai's monitor — fabric/quotaread.js), as last recorded
  // (fabric/store.recordQuota). An API key is a connection type, not "no account information" (2026-10-01).
  try {
    const store = require('./fabric/store');
    const known = new Set(out.map((s) => s.id));
    const rows = require('./accountcatalog').list(app).accounts || [];
    for (const [id, q] of Object.entries(store.read().quota || {})) {
      if (known.has(id) || !q || !Array.isArray(q.windows) || !q.windows.length) continue;
      const acct = rows.find((a) => a.id === id);
      if (!acct || !acct.base) continue;   // runtime accounts come from their own snapshot above
      out.push({ id, family: acct.family || 'api', label: acct.name || id, account: acct.base, basis: q.source ? `reported by ${q.source}` : 'provider-reported',
        windows: q.windows.map((w) => ({ ...w, id: w.id || w.label, mins: w.windowMins || NAMED[w.id] || null })),
        match: (r) => r.account === acct.base || String(r.account || '').startsWith(`${acct.base}:`) || r.account === id });
    }
  } catch { /* none */ }
  // API ROUTES — rate-limit headers seen this process (usagewindows.js).
  try {
    const uw = require('./usagewindows');
    for (const rd of uw.all()) {
      if (!rd) continue;
      const ws = rd.windows.filter((w) => w.subscription || /^\d+[hdm]$/.test(w.name)).map((w) => {
        const d = uw.durationMs(w.name);
        return { id: w.name, label: w.label, usedPercent: w.percent != null ? Math.round(w.percent * 10) / 10 : null, resetsAt: w.resetAt || null, mins: d ? Math.round(d / MIN) : null };
      });
      if (!ws.length) continue;
      out.push({ id: rd.connectionId, family: 'api', label: rd.connectionId, account: rd.provider || null, basis: 'rate-limit headers on Noema’s own requests',
        windows: ws, match: (r) => r.account === rd.connectionId || String(r.account || '').startsWith(`${rd.connectionId}:`) });
    }
  } catch { /* none */ }
  return out;
}

function sum(rows) {
  const o = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, requests: 0, costUsd: 0, costRows: 0, reported: { reasoning: 0, cache: 0 }, tokens: 0 };
  for (const r of rows) {
    o.requests += 1;
    o.input += r.input || 0; o.output += r.output || 0;
    if (r.reasoning != null) { o.reasoning += r.reasoning; o.reported.reasoning += 1; }
    if (r.cacheRead != null || r.cacheWrite != null) { o.cacheRead += r.cacheRead || 0; o.cacheWrite += r.cacheWrite || 0; o.reported.cache += 1; }
    if (r.costUsd != null) { o.costUsd += r.costUsd; o.costRows += 1; }
  }
  o.tokens = o.input + o.output;
  o.costUsd = o.costRows ? Math.round(o.costUsd * 10000) / 10000 : null;
  return o;
}

function group(rows, by, app) {
  const u = require('./usage');
  const m = new Map();
  for (const r of rows) { const k = u.keyOf(r, by); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  const total = rows.reduce((a, r) => a + (r.input || 0) + (r.output || 0), 0) || 1;
  const name = (k) => { if (by !== 'project') return k; try { return require('./assistant/intent').projectName(app, k); } catch { return k; } };
  return [...m.entries()].map(([key, rs]) => { const s = sum(rs); return { key, name: name(key), ...s, share: Math.round((s.tokens / total) * 1000) / 10 }; })
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * THE WINDOWS, each with its observed consumption (current and previous).
 * `by` adds a breakdown (project | session | model | account) to each.
 */
// RESULT CACHE (Phase 8.1): the windows are recomputed only when the receipts
// grew (usageindex generation), a provider reported something new (the sources'
// own figures), the breakdown changed, or a minute passed — not on every render.
let memo = null;
function windows(app, opts = {}) {
  const now = opts.now || Date.now();
  const by = opts.by || null;
  let sig = null;
  try {
    const srcs = sources(app).map((s) => [s.id, s.account, s.windows, s.credits]);
    sig = JSON.stringify([require('./usageindex').generation(), srcs, by, Math.floor(now / 60000), opts.now ? now : 0, require('./config').configDir()]);
  } catch { sig = null; }
  if (sig && memo && memo.sig === sig) return JSON.parse(memo.json);
  const out = windowsUncached(app, { now, by });
  if (sig) memo = { sig, json: JSON.stringify(out) };
  return out;
}
function windowsUncached(app, { now = Date.now(), by = null } = {}) {
  const u = require('./usage');
  const snaps = readSnaps();
  let changed = false;
  const out = [];
  const srcs = sources(app);
  const oldest = Math.min(now, ...srcs.flatMap((s) => s.windows.filter((w) => w.mins && w.resetsAt).map((w) => w.resetsAt - 2 * w.mins * MIN)));
  const all = Number.isFinite(oldest) ? u.read({ from: oldest }) : [];
  for (const s of srcs) {
    const mine = all.filter(s.match);
    for (const w of s.windows) {
      const key = `${s.id}|${w.id}|${w.resetsAt || 0}`;
      // THE RESET BOUNDARY ROLLS NOEMA'S OWN BUCKET (2026-10-01). Past the provider's reset, and with the window's length
      // known, the window in force is the next one: its end is PROJECTED from the reported reset plus whole windows, its
      // observed usage starts again, the one that just closed becomes "previous" (with the % last seen before it reset),
      // and the provider's percentage is "not reported since the reset" until it is read again. Noema never resets a
      // provider's quota; it only stops attributing new use to a window that is over.
      let reset = w.resetsAt || null; let rolled = false;
      if (w.mins && reset && now >= reset) { const len = w.mins * MIN; reset += (Math.floor((now - reset) / len) + 1) * len; rolled = true; }
      const used = rolled ? null : w.usedPercent;
      const row = {
        source: s.id, family: s.family || null, sourceLabel: s.label, account: s.account, basis: s.basis,
        window: w.id, label: w.label, category: category(w.mins), durationMins: w.mins,
        usedPercent: used, remainingPercent: used != null ? Math.round((100 - used) * 10) / 10 : null,
        resetsAt: reset, expired: Boolean(reset && now >= reset), rolled, resetProjected: rolled,
        ...(rolled ? { pending: 'the provider has not reported this window since it reset — Refresh quota to read it' } : {}),
        bounded: Boolean(w.mins && reset),
      };
      if (row.bounded) {
        const end = reset; const start = end - w.mins * MIN; const pStart = start - w.mins * MIN;
        const cur = mine.filter((r) => r.at >= start && r.at < end);
        const prev = mine.filter((r) => r.at >= pStart && r.at < start);
        const prevSnap = Object.values(snaps).filter((x) => x.source === s.id && x.window === w.id && x.resetsAt && x.resetsAt <= start + MIN && x.resetsAt > pStart).sort((a, b) => b.at - a.at)[0];
        row.start = start; row.end = end;
        row.observed = sum(cur);
        row.previous = { start: pStart, end: start, observed: sum(prev), usedPercent: prevSnap ? prevSnap.usedPercent : null, usedPercentBasis: prevSnap ? `last seen ${new Date(prevSnap.at).toLocaleString()}` : 'not recorded by Noema' };
        if (by) { row.breakdown = group(cur, by, app); row.previous.breakdown = group(prev, by, app); }
      } else {
        row.observed = null;
        row.why = w.mins ? 'the provider did not report when this window resets' : 'the provider did not say how long this window is, so Noema cannot bound it';
      }
      // THE SNAPSHOT — and, for a bounded window, the paired reading the capacity estimate is made from.
      if (!rolled && w.usedPercent != null && w.resetsAt && (!snaps[key] || snaps[key].usedPercent !== w.usedPercent)) {
        const series = ((snaps[key] && snaps[key].series) || []).concat(row.observed ? [[now, w.usedPercent, row.observed.tokens]] : []).slice(-SERIES_MAX);
        snaps[key] = { usedPercent: w.usedPercent, at: now, source: s.id, window: w.id, resetsAt: w.resetsAt, series };
        changed = true;
      }
      if (row.bounded) row.capacity = capacity(Object.values(snaps).filter((x) => x.source === s.id && x.window === w.id));
      out.push(row);
    }
    if (s.credits) out.push({ source: s.id, family: s.family || null, sourceLabel: s.label, account: s.account, basis: s.basis, window: 'credits', label: 'Reset credits', category: 'CREDITS', credits: s.credits, bounded: false, observed: null });
  }
  if (changed) writeSnaps(snaps);
  return out;
}

/** The short-term window for the route the Coding Agent uses now (Long Context Phasing's estimate). */
function currentForRoute(app) {
  let model = '';
  try { model = String(require('./sessionintel').resolve(app, app.session).coding.model || ''); } catch { model = String((app.cfg && app.cfg.model) || ''); }
  const ws = windows(app).filter((w) => w.bounded && w.usedPercent != null);
  const pick = (pred) => ws.filter(pred).sort((a, b) => (a.durationMins || 0) - (b.durationMins || 0))[0] || null;
  if (/^claude-code\//.test(model)) return pick((w) => w.source === 'claude-code');
  if (/^codex/.test(model)) return pick((w) => w.source !== 'claude-code');
  return pick((w) => model && (w.source === (app.cfg && app.cfg.connection))) || null;
}

module.exports = { windows, sources, currentForRoute, category, sum, capacity, NAMED };
