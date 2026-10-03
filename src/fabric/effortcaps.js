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

/** DECLARED LEVELS for transports that take a level but do not list them per model. */
const CLAUDE_DECLARED = [
  // Claude Code's model-config documentation (2026-10): 4.6 models take low/medium/high/max; Opus 4.7+, Sonnet 5+
  // and Opus 5+ add xhigh. Haiku has no configurable effort.
  [/(^|[/:-])(opus|sonnet)[-.]?4[-.]6/i, ['low', 'medium', 'high', 'max']],
  [/(^|[/:-])opus/i, ['low', 'medium', 'high', 'xhigh', 'max']],
  [/(^|[/:-])sonnet[-.]?[5-9]/i, ['low', 'medium', 'high', 'xhigh', 'max']],
  [/(^|[/:-])sonnet/i, ['low', 'medium', 'high']],
];

/** GLM-5.3 (Z.ai's own documentation): reasoning is always on; `reasoning_effort` takes low | high | max and the PROVIDER default is max. */
const GLM_RE = /(^|[/:-])glm-5\.3/i;
const ZAI_HOST = /(^|\.)(z\.ai|bigmodel\.cn)(:|\/|$)/i;

function declared({ runtime = null, protocol = null, upstreamId = '', provider = null, baseUrl = '' } = {}) {
  const id = String(upstreamId || '');
  if (runtime === 'claude-code' || (protocol === 'anthropic' && /claude/i.test(id))) {
    for (const [re, levels] of CLAUDE_DECLARED) if (re.test(id)) return { levels: levels.slice(), source: runtime === 'claude-code' ? 'Claude Code --effort' : 'Anthropic API effort', wire: runtime ? 'runtime' : 'output_config' };
  }
  if (!runtime && GLM_RE.test(id) && (/^(zai|bigmodel)$/i.test(String(provider || '')) || ZAI_HOST.test(String(baseUrl || '').replace(/^https?:\/\//i, '')))) {
    return { levels: ['low', 'high', 'max'], default: 'high', source: 'Z.ai reasoning_effort', wire: protocol === 'anthropic' ? 'output_config' : 'reasoning_effort' };
  }
  return null;
}

/** THE EFFORT A REQUEST CARRIES — chosen once, at send time, from what the route ACTUALLY supports. */
const LAIN_LEVELS = Object.freeze(['low', 'high', 'max']);
function forRequest({ levels = [], defaultEffort = null, wire = null, requested = null, profile = 'NORMAL' } = {}) {
  const want = requested && requested !== 'auto' ? norm(requested) : null;
  if (levels.length) {
    const explicit = Boolean(want && levels.includes(want));
    let effort = explicit ? want : null;
    if (!effort) {
      const p = String(profile || 'NORMAL').toUpperCase();
      if (p === 'FAST' || p === 'ECO') effort = levels.includes('low') ? 'low' : levels[0];
      else effort = defaultEffort && levels.includes(defaultEffort) ? defaultEffort : null;   // null: the provider's own default
    }
    return { effort, source: 'provider', wire: effort ? wire : null, levels: levels.slice(), explicit };
  }
  // NO NATIVE EFFORT: LAIN execution effort (context, tools, exploration, delegation) — never sent to the model.
  const p = String(profile || 'NORMAL').toUpperCase();
  const lainEffort = want && LAIN_LEVELS.includes(want) ? want : (p === 'FAST' || p === 'ECO' ? 'low' : 'high');
  return { effort: null, lainEffort, source: 'lain', wire: null, levels: [], explicit: Boolean(want) };
}

/** THE PLAN FOR ONE REQUEST (provider.resolve, 2026-10-02). */
function planFor({ conn, route: r, cfg = {}, chat = 'chat' } = {}) {
  const fused = Boolean(r.effort) || (Array.isArray(r.efforts) && r.efforts.length > 1) || conn.protocol === 'responses';
  if (fused) return null;
  const dec = declared({ runtime: conn.runtime || null, protocol: conn.protocol || chat, upstreamId: r.upstreamId || r.model, provider: conn.provider, baseUrl: conn.baseUrl });
  if (dec) return forRequest({ levels: dec.levels, defaultEffort: dec.default || null, wire: dec.wire, requested: cfg.effort, profile: cfg.executionProfile });
  return conn.runtime ? null : forRequest({ levels: [], requested: cfg.effort, profile: cfg.executionProfile });
}

/** THE LEVELS ONE ROUTE OFFERS for one model. */
function forRoute({ family, model, row = null, route = null, conn = null, overrides = null } = {}) {
  const ov = overrides && overrides[`${family}|${model}`];
  if (ov && Array.isArray(ov.levels)) return { levels: order(ov.levels), default: norm(ov.default) || null, source: 'your override' };
  if (row && Array.isArray(row.efforts) && row.efforts.length) return { levels: order(row.efforts), default: norm(row.defaultEffort) || null, source: 'reported by the provider' };
  if (route && Array.isArray(route.efforts) && route.efforts.length) return { levels: order(route.efforts), default: null, source: 'the route\'s own model ids' };
  const d = declared({ runtime: (conn && conn.runtime) || (row && row.runtime) || null, protocol: conn && conn.protocol, upstreamId: (route && (route.upstreamId || model)) || model, provider: conn && conn.provider, baseUrl: conn && conn.baseUrl });
  if (d) return { levels: d.levels, default: d.default || null, source: d.source };
  return { levels: [], default: null, source: null };
}

/** Is `effort` one of these levels? null (the model's default) always is. */
function allowed(levels, effort) { const e = norm(effort); return !effort || effort === 'auto' || (e && (levels || []).includes(e)); }

/** THE TRANSPORT FORM of a level — the only place a level becomes wire syntax. */
function runtimeArgs(runtime, effort) {
  const e = norm(effort);
  if (!e) return [];
  if (runtime === 'codex') return ['-c', `model_reasoning_effort="${e}"`];
  if (runtime === 'claude-code') return ['--effort', e];
  return [];
}

module.exports = { LEVELS, LABEL, LAIN_LEVELS, norm, order, label, declared, forRoute, forRequest, planFor, allowed, runtimeArgs };
