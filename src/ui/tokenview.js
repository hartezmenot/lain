'use strict';

/** THE TOKEN PANE — what this conversation has actually cost. */

const { doc } = require('./doc');
const { P } = require('./paint');

/** Where a number came from. Printed, never inferred by the reader. */
const SOURCE = Object.freeze({
  MEASURED: 'measured',
  ESTIMATED: 'estimated',
  PENDING: 'pending',
  UNKNOWN: 'unknown',
});

function n(v) {
  const x = Math.max(0, Math.floor(Number(v) || 0));
  return x.toLocaleString('en-US');
}

/** Compact, for ratios and averages where the exact digit does not help. */
function k(v) {
  const x = Math.max(0, Number(v) || 0);
  if (x < 1000) return String(Math.round(x));
  if (x < 1_000_000) return `${(x / 1000).toFixed(1)}K`;
  return `${(x / 1_000_000).toFixed(2)}M`;
}

/** A figure with its provenance, or the reason there is no figure. */
function figure(d, label, value, { has = true, source = SOURCE.MEASURED, note = null } = {}) {
  if (!has) {
    d.field(label, source === SOURCE.PENDING ? 'pending' : 'unknown', { tone: P.dim, note });
    return;
  }
  d.field(label, n(value), { note: note || (source === SOURCE.ESTIMATED ? 'estimated' : null) });
}

/** `usage` session totals, as the provider reported them `live` the open request's input side, when a provider states it early `audit` the last… */
function render({ usage = null, live = null, audit = null, requests = 0, open = false,
  model = '', provider = '', width = 80 } = {}) {
  const d = doc();
  d.title('token usage', model || '');
  d.subtitle('What this conversation has cost, and where it went');

  const u = usage || {};
  const input = Number(u.inputTokens) || 0;
  const output = Number(u.outputTokens) || 0;
  const cacheRead = Number(u.cacheReadTokens) || 0;
  const cacheMade = Number(u.cacheCreationTokens) || 0;
  const reqs = Math.max(0, Number(requests) || 0);
  const total = input + output;

  // ---- THE REQUEST HAPPENING RIGHT NOW ----------------------------------
  d.section('current request');
  if (open) {
    // Anthropic states the input side at `message_start`; the OpenAI shape
    // states it once and late. Either way, output does not exist yet.
    const hasLive = Boolean(live && Number(live.inputTokens) > 0);
    figure(d, 'input', live && live.inputTokens, { has: hasLive, source: hasLive ? SOURCE.MEASURED : SOURCE.PENDING });
    figure(d, 'cached', live && live.cacheReadTokens, {
      has: Boolean(live && live.cacheReadTokens > 0),
      source: SOURCE.UNKNOWN,
      note: live && live.cacheReadTokens > 0 ? null : 'this route has not reported a cache read',
    });
    // NEVER A RISING NUMBER. See the header: no provider states output until
    // the request closes, so any figure drawn here would be invented.
    figure(d, 'output', 0, { has: false, source: SOURCE.PENDING, note: 'stated only when the request completes' });
    d.note('A request is open. These are the provider\'s own figures, not a projection.');
  } else if (audit) {
    // No request open: the most recent one, as LAIN measured the array it sent.
    const est = audit.estTokens || {};
    d.field('input', k(est.total), { note: 'estimated from the transmitted array' });
    d.field('  system prompt', k(est.system));
    d.field('  tool schemas', k(est.toolSchemas), {
      note: audit.chars && audit.chars.total
        ? `${Math.round((audit.chars.toolSchemas / audit.chars.total) * 100)}% of the request`
        : null,
    });
    d.field('  conversation', k((est.user || 0) + (est.assistant || 0) + (est.toolResults || 0)));
    if (est.duplicate) d.field('  repeated', k(est.duplicate), { tone: P.warn, note: 'the same body twice in one request' });
    d.field('  cacheable head', k(est.stablePrefix), { note: 'identical to the previous request, where the route caches' });
  } else {
    d.text('No request has been made yet.');
  }

  // ---- WHAT THE PROVIDER HAS ACTUALLY BILLED ----------------------------
  d.section('session', reqs ? `${reqs} request(s)` : null);
  if (!reqs && !input && !output) {
    d.text('Nothing has been reported by a provider yet.');
    d.note('These figures come from usage blocks on the wire. Until a request '
      + 'completes there is nothing measured to show, and a plausible zero would '
      + 'be worse than an empty pane.');
    return d.render(width);
  }
  figure(d, 'input', input);
  // ---- ZERO AND UNKNOWN ARE DIFFERENT FACTS -----------------------------
  figure(d, 'cached read', cacheRead, {
    has: cacheRead > 0,
    source: SOURCE.UNKNOWN,
    note: cacheRead > 0 ? null : 'no route in this session has reported one',
  });
  if (cacheMade > 0) figure(d, 'cache written', cacheMade);
  figure(d, 'output', output);
  figure(d, 'total', total);

  // THE RATIOS THAT MAKE AN INCIDENT VISIBLE
  d.section('per request');
  if (reqs > 0) {
    d.field('average input', k(input / reqs));
    d.field('average output', k(output / reqs));
    if (output > 0) {
      const ratio = input / output;
      d.field('input : output', `${ratio.toFixed(0)} : 1`, { tone: ratio >= 100 ? P.warn : null });
    } else {
      d.field('input : output', 'no output reported yet', { tone: P.dim });
    }
    if (input > 0) {
      d.field('cache hit rate', cacheRead > 0 ? `${((cacheRead / input) * 100).toFixed(1)}%` : 'unknown', {
        tone: cacheRead > 0 ? null : P.dim,
        note: cacheRead > 0 ? 'of input served from a cache' : 'this route reports no cache figures',
      });
    }
  }

  if (provider) {
    d.section('route');
    d.field('provider', provider);
    if (model) d.field('model', model);
    d.note('Usage is kept per session. Another session in another folder has its own.');
  }
  return d.render(width);
}

module.exports = { render, SOURCE };
