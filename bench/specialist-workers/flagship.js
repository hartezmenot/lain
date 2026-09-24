'use strict';

/**
 * THE FLAGSHIP POOL of one A/B run, from the provider's own per-request
 * receipts (`LAIN_REQTRACE` rows). Used by ab.js, and by anything that
 * recomputes a recorded run from its raw trace.
 *
 * Cached input is a SUBSET of input on the Ollama Cloud route (prompt_tokens
 * includes cached_tokens — verified 2026-09-23: 72 prompt / 48 cached;
 * 14,333 / 13,952), so uncached = input − cached, only where the cache was
 * reported. "Not reported" stays null, never 0.
 *
 * A request the provider answered with NO usage object at all (0 in / 0 out,
 * no cache field) is counted apart as `usageNotReportedRequests` instead of
 * voiding the cached/uncached split of every other request.
 */

const sum = (xs) => xs.reduce((s, x) => s + (Number(x) || 0), 0);
function median(xs) { const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; }

function flagship(reqtrace, price) {
  const noUsage = reqtrace.filter((r) => r.receipt && !r.receipt.inputTokens && !r.receipt.outputTokens && r.receipt.cacheReadTokens == null);
  const rows = reqtrace.filter((r) => r.receipt && !noUsage.includes(r));
  const reported = rows.filter((r) => r.receipt.cacheReadTokens != null);
  const input = sum(rows.map((r) => r.receipt.inputTokens));
  const cached = reported.length ? sum(reported.map((r) => r.receipt.cacheReadTokens)) : null;
  const allReported = reported.length === rows.length && rows.length > 0;
  const uncached = allReported ? input - cached : null;
  const output = sum(rows.map((r) => r.receipt.outputTokens));
  const cost = allReported ? {
    uncachedInput: +(uncached / 1e6 * price.inputPerM).toFixed(6),
    cachedInput: +(cached / 1e6 * price.cachedPerM).toFixed(6),
    output: +(output / 1e6 * price.outputPerM).toFixed(6),
  } : null;
  if (cost) cost.total = +(cost.uncachedInput + cost.cachedInput + cost.output).toFixed(6);
  const inputs = rows.map((r) => r.receipt.inputTokens);
  return {
    requests: reqtrace.length, withReceipt: rows.length, usageNotReportedRequests: noUsage.length, cacheReportedRequests: reported.length,
    inputTokens: input, cachedInputTokens: cached, uncachedInputTokens: uncached, outputTokens: output,
    cacheHitRate: allReported && input ? +(cached / input).toFixed(3) : null,
    averageInputPerRequest: rows.length ? Math.round(input / rows.length) : null,
    peakInputRequest: inputs.length ? Math.max(...inputs) : null,
    providerWallMs: sum(reqtrace.map((r) => r.ms)),
    failedRequests: reqtrace.filter((r) => r.ok === false).length,
    toolSchemaChars: { median: median(reqtrace.map((r) => r.toolSchemaChars)), total: sum(reqtrace.map((r) => r.toolSchemaChars)) },
    geometryToolOfferedOnRequests: reqtrace.filter((r) => (r.tools || []).includes('geometry_specialist')).length,
    costUSD: cost,
  };
}

module.exports = { flagship, sum, median };
