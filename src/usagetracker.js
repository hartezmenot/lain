'use strict';

/** THE USAGE TRACKER'S NUMBERS (2026-09-30) — one place, for every surface that shows them */

const RANGES = Object.freeze({
  today: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); },
  '7d': () => Date.now() - 7 * 864e5,
  month: () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); },
  '30d': () => Date.now() - 30 * 864e5,
  all: () => 0,
});

function tone(rem) { return rem == null ? null : rem <= 5 ? 'bad' : rem <= 20 ? 'warn' : 'ok'; }
function remainingOf(w) {
  if (w.remainingPercent != null) return Math.max(0, Math.min(100, Math.round(w.remainingPercent)));
  if (w.usedPercent != null) return Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
  return null;
}

/** The lane's route and its backing account's reported windows. `observed` adds LAIN's own tokens per window. */
function laneView(app, lane, { observed = null } = {}) {
  const si = require('./sessionintel');
  let l = null;
  try { l = si.lane(app, app.session, lane); } catch { l = null; }
  const d = (l && l.display) || { resolved: false, text: 'Select model' };
  const out = { lane, route: { resolved: Boolean(d.resolved), text: d.resolved ? d.text : 'Select model', problem: d.resolved ? null : (d.problem || null), family: (l && l.family) || null, familyLabel: (l && l.familyLabel) || null, policy: (l && l.policyLabel) || null }, account: null, windows: [], ring: null, note: null };
  if (!d.resolved || !l || !l.family) return out;
  let acct = null;
  try {
    const f = require('./fabric/index').family(app, l.family);
    const id = l.backing && l.backing.id;
    acct = f && id ? f.accounts.find((a) => a.id === id) || null : null;
  } catch { acct = null; }
  if (!acct) { out.note = `${l.familyLabel || 'This provider'} has no account behind this route yet`; return out; }
  out.account = { id: acct.id, name: acct.name, limited: Boolean(acct.limited) };
  for (const w of acct.quota || []) {
    const rem = remainingOf(w);
    if (rem == null) continue;
    const row = { label: w.label, usedPercent: w.usedPercent != null ? Math.round(w.usedPercent) : 100 - rem, remainingPercent: rem, resetsAt: w.resetsAt || null, expired: Boolean(w.expired), tone: tone(rem), observedTokens: null };
    if (observed) {
      const match = observed.find((x) => (x.source === acct.id || (l.family === 'claude' && x.source === 'claude-code')) && sameLabel(x.label || x.window, w.label) && x.bounded && x.observed);
      if (match) { row.observedTokens = match.observed.tokens; row.capacity = match.capacity || null; }
    }
    out.windows.push(row);
  }
  if (!out.windows.length) out.note = acct.quotaNote || `${l.familyLabel || 'This provider'} has not reported quota for this account yet`;
  // THE RING: the tightest window — the one that runs out first — as what REMAINS.
  const t = out.windows.filter((w) => !w.expired).sort((a, b) => a.remainingPercent - b.remainingPercent)[0] || null;
  if (t) out.ring = { remainingPercent: t.remainingPercent, usedPercent: t.usedPercent, label: t.label, resetsAt: t.resetsAt, tone: t.tone };
  else if (acct.limited) out.ring = { remainingPercent: 0, usedPercent: 100, label: 'limited', resetsAt: acct.limited.until || null, tone: 'bad' };
  return out;
}
function sameLabel(a, b) {
  const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^5hour$|^fivehour$|^primary$/, '5h').replace(/^weekly$|^7day$|^sevenday$|^secondary$/, 'wk');
  return n(a) === n(b);
}

/** A receipt's model id as people read it: the catalog's name when it knows the model, else a tidied id. */
function modelName(app, id) {
  if (!id || id === '(none)' || id === 'unknown') return 'Unattributed';
  let label = null;
  try { label = require('./accountcatalog').modelLabel(app, null, id); } catch { label = null; }
  if (label && label !== id) return label;
  try { return require('./catalog').displayName(id); } catch { return id; }
}

/** BOTH LANES' RINGS — small and cheap (index lookups), for the state snapshot. */
function lanes(app) {
  return { chat: laneView(app, 'chat'), coding: laneView(app, 'coding') };
}

/** THE DROPDOWN: LAIN-observed usage over `range`, and the lane's windows with what LAIN observed inside each. */
function dropdown(app, { range = 'month', lane = 'coding' } = {}) {
  const r = RANGES[range] ? range : 'month';
  const usage = require('./usage');
  const cfg = ((app && app._sibling) || app).cfg || {};
  const rows = usage.read({ from: RANGES[r]() });
  const t = usage.sum(rows, cfg);
  const eff = usage.efficiency(rows);
  const groups = usage.aggregate(rows, 'model', cfg).filter((g) => (g.input || 0) + (g.output || 0) > 0);
  const top = groups.slice(0, 3).map((g) => ({ key: g.key, label: modelName(app, g.key), tokens: (g.input || 0) + (g.output || 0), requests: g.requests }));
  const rest = groups.slice(3).reduce((a, g) => a + (g.input || 0) + (g.output || 0), 0);
  if (rest > 0) top.push({ key: 'other', label: 'Other', tokens: rest, requests: groups.slice(3).reduce((a, g) => a + g.requests, 0) });
  let observed = null;
  try { observed = require('./resetwindows').windows(app); } catch { observed = null; }
  return {
    at: Date.now(),
    overall: { range: r, tokens: t.input + t.output, input: t.input, output: t.output, requests: t.requests, cacheRead: t.reported.cache ? t.cacheRead : null,
      cacheReuse: eff.provider && eff.provider.hitRatio != null ? eff.provider.hitRatio : null, models: top },
    lane: laneView(app, lane === 'chat' ? 'chat' : 'coding', { observed }),
  };
}

module.exports = { lanes, laneView, dropdown, remainingOf, modelName, RANGES };
