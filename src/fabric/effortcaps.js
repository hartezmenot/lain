'use strict';

/**
 * EFFORT IS A PROPERTY OF A MODEL ROUTE (Phase 8.3) — never a global list.
 *
 *   ModelCapability { provider_family, model_id, effort_levels[], default_effort? }
 *
 * A model offers exactly the levels its provider says it takes; a model with
 * none has no effort selector at all. Nothing here invents an upstream id:
 * "Opus 5.5 · XHigh" is `model = opus-5.5, effort = xhigh`, and the level is
 * translated into the ONE form its transport understands, at send time.
 *
 * WHERE LEVELS COME FROM, in this order (the first that states any wins):
 *   1. the person's override       fabric.json efforts["<family>|<model>"]
 *   2. the provider's own report   Codex model/list supportedReasoningEfforts
 *                                  (runtimeconnections rows), and a route whose
 *                                  upstream ids fuse the level (gpt-5.5-high)
 *   3. a documented transport      Claude Code `--effort`, the Anthropic API's
 *                                  `output_config.effort` — declared below, per
 *                                  model family, and overridable by (1)
 *   otherwise none.
 */

const LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const LABEL = Object.freeze({ minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' });

function norm(e) {
  const s = String(e || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (s === 'extrahigh' || s === 'xhi') return 'xhigh';
  return LEVELS.includes(s) ? s : null;
}
function order(list) { return [...new Set((list || []).map(norm).filter(Boolean))].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b)); }
function label(e) { return LABEL[norm(e)] || (e ? String(e) : ''); }

/**
 * DECLARED LEVELS for transports that take a level but do not list them per
 * model. Claude Code documents `--effort low|medium|high|xhigh|max`; the Opus
 * and Sonnet families honour it, Haiku has no configurable effort. The same
 * holds for the Anthropic API's `output_config.effort`.
 */
const CLAUDE_DECLARED = [
  [/(^|[/:-])opus/i, ['low', 'medium', 'high', 'xhigh', 'max']],
  [/(^|[/:-])sonnet/i, ['low', 'medium', 'high']],
];

function declared({ runtime = null, protocol = null, upstreamId = '' } = {}) {
  const id = String(upstreamId || '');
  if (runtime === 'claude-code' || (protocol === 'anthropic' && /claude/i.test(id))) {
    for (const [re, levels] of CLAUDE_DECLARED) if (re.test(id)) return { levels: levels.slice(), source: runtime === 'claude-code' ? 'Claude Code --effort' : 'Anthropic API effort' };
  }
  return null;
}

/**
 * THE LEVELS ONE ROUTE OFFERS for one model.
 * `row` is a runtime/local row (runtimeconnections) or null; `route` the catalog route.
 */
function forRoute({ family, model, row = null, route = null, conn = null, overrides = null } = {}) {
  const ov = overrides && overrides[`${family}|${model}`];
  if (ov && Array.isArray(ov.levels)) return { levels: order(ov.levels), default: norm(ov.default) || null, source: 'your override' };
  if (row && Array.isArray(row.efforts) && row.efforts.length) return { levels: order(row.efforts), default: norm(row.defaultEffort) || null, source: 'reported by the provider' };
  if (route && Array.isArray(route.efforts) && route.efforts.length) return { levels: order(route.efforts), default: null, source: 'the route\'s own model ids' };
  const d = declared({ runtime: (conn && conn.runtime) || (row && row.runtime) || null, protocol: conn && conn.protocol, upstreamId: (route && (route.upstreamId || model)) || model });
  if (d) return { levels: d.levels, default: null, source: d.source };
  return { levels: [], default: null, source: null };
}

/** Is `effort` one of these levels? null (the model's default) always is. */
function allowed(levels, effort) { const e = norm(effort); return !effort || effort === 'auto' || (e && (levels || []).includes(e)); }

/**
 * THE TRANSPORT FORM of a level — the only place a level becomes wire syntax.
 *   codex (runtime)       -c model_reasoning_effort="<level>"
 *   claude-code (runtime) --effort <level>
 * API routes carry it as a request field (provider.js / responsesapi.js).
 */
function runtimeArgs(runtime, effort) {
  const e = norm(effort);
  if (!e) return [];
  if (runtime === 'codex') return ['-c', `model_reasoning_effort="${e}"`];
  if (runtime === 'claude-code') return ['--effort', e];
  return [];
}

module.exports = { LEVELS, LABEL, norm, order, label, declared, forRoute, allowed, runtimeArgs };
