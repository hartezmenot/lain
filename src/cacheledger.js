'use strict';

/** CACHE LEDGER — what every flagship request cost in UNCACHED input, measured honestly (2026-09-24). */

const MAX_ROWS = 400;
const TARGET = 0.05;
const CEILING = 0.08;

/** One receipt → { total, cached, uncached, output, cacheWrite, reported }. */
function normalize(receipt, protocol) {
  if (!receipt) return { total: null, cached: null, uncached: null, output: null, cacheWrite: null, reported: false };
  const input = Number(receipt.inputTokens) || 0;
  const read = Number(receipt.cacheReadTokens) || 0;
  const write = Number(receipt.cacheCreationTokens) || 0;
  const reported = receipt.cacheReported !== false && (receipt.cacheReported === true || receipt.cacheReadTokens != null);
  const output = Number(receipt.outputTokens) || 0;
  if (protocol === 'anthropic') {
    const total = input + read + write;
    return reported ? { total, cached: read, uncached: input + write, output, cacheWrite: write, reported: true } : { total, cached: null, uncached: null, output, cacheWrite: null, reported: false };
  }
  return reported ? { total: input, cached: read, uncached: Math.max(0, input - read), output, cacheWrite: write || null, reported: true } : { total: input, cached: null, uncached: null, output, cacheWrite: null, reported: false };
}

function ratio(n) { return n && n.reported && n.total ? n.uncached / n.total : null; }

function band(r) { return r == null ? 'UNREPORTED' : r <= TARGET ? 'TARGET' : r <= CEILING ? 'PRESSURE' : 'OVER'; }

function ledgerOf(session) {
  if (!session) return null;
  if (!session._cacheLedger) session._cacheLedger = { rows: [], epochs: 0 };
  return session._cacheLedger;
}

/** SETTLE ONE REQUEST: the plan Core made before sending (cachebudget.plan — expected cached/uncached, warmth, epoch, owners) joined with what the… */
function settle(session, plan, receipt, pc = {}) {
  const l = ledgerOf(session);
  if (!l || !plan) return null;
  const actual = normalize(receipt, pc.protocol);
  const r = ratio(actual);
  const row = {
    at: Date.now(), model: pc.model || '', route: pc.connectionId || pc.provider || '', protocol: pc.protocol || '',
    epoch: plan.epoch, warmth: plan.warmth, epochReason: plan.epochReason || null, contextGeneration: plan.contextGeneration || null,
    expected: { chars: plan.chars, cachedChars: plan.cachedChars, uncachedChars: plan.uncachedChars, ratio: plan.ratio },
    actual: { ...actual, ratio: r },
    band: plan.warmth === 'WARM' ? band(r) : plan.warmth,
    owners: plan.owners ? plan.owners.slice(0, 6) : [],
    reductions: plan.reductions || [],
    exception: plan.exception || null,
    sincePrevMs: plan.sincePrevMs == null ? null : plan.sincePrevMs,
  };
  l.rows.push(row);
  if (l.rows.length > MAX_ROWS) l.rows.splice(0, l.rows.length - MAX_ROWS);
  return row;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/** THE DISTRIBUTION of WARM, REPORTED requests — median, p90 (only with ≥ 10 requests), worst normal (a request not carrying a justified exception), the… */
function summary(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const warm = all.filter((x) => x.warmth === 'WARM' && x.actual && x.actual.reported);
  const ratios = warm.map((x) => x.actual.ratio).sort((a, b) => a - b);
  const normal = warm.filter((x) => !x.exception).map((x) => x.actual.ratio);
  const sum = (k) => warm.reduce((n, x) => n + (x.actual[k] || 0), 0);
  return {
    requests: all.length,
    warm: warm.length,
    cold: all.filter((x) => x.warmth === 'COLD').length,
    epochResets: all.filter((x) => x.warmth === 'EPOCH_RESET').length,
    unreported: all.filter((x) => x.actual && !x.actual.reported).length,
    median: pct(ratios, 0.5),
    p90: ratios.length >= 10 ? pct(ratios, 0.9) : null,
    worstNormal: normal.length ? Math.max(...normal) : null,
    overCeiling: warm.filter((x) => x.actual.ratio > CEILING).length,
    exceptions: warm.filter((x) => x.exception).map((x) => ({ ratio: x.actual.ratio, reason: x.exception.reason, owners: x.exception.owners })),
    totals: { input: sum('total'), cached: sum('cached'), uncached: sum('uncached'), output: sum('output') },
    meanPrompt: warm.length ? Math.round(sum('total') / warm.length) : null,
    target: TARGET, ceiling: CEILING,
  };
}

function rows(session) { const l = session && session._cacheLedger; return l ? l.rows.slice() : []; }

module.exports = { normalize, ratio, band, settle, summary, rows, ledgerOf, TARGET, CEILING };
