'use strict';

/** MODEL CAPABILITY PROFILES (Execution Discipline §36–§39) — discretion from MEASURED behaviour, not the model's name. */

const fs = require('fs');
const path = require('path');

const MIN_SAMPLE = 30;           // tool calls before measurement overrides the prior
const PRIORS = [
  [/\b(opus|sonnet|fable|claude)\b|gpt-?[5-9]|\bo[3-9]\b|codex|gemini-?(?:2\.5|3)-?pro/i, 'STRONG'],
  [/glm|qwen|deepseek|kimi|mistral-large|gemini|grok|llama-?3\.[1-9]-?70b/i, 'MEDIUM'],
  [/\b\d{1,2}b\b|:\d{1,2}b|mini|nano|tiny|small|haiku|ollama|local|phi|gemma/i, 'WEAK'],
];

function file() { return path.join(require('../config').configDir(), 'models', 'profiles.json'); }
function readAll() { try { return JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch { return {}; } }
function writeAll(all) {
  try { fs.mkdirSync(path.dirname(file()), { recursive: true }); const t = `${file()}.tmp`; fs.writeFileSync(t, JSON.stringify(all, null, 2)); fs.renameSync(t, file()); } catch { /* a profile never costs a turn */ }
}

const EMPTY = { calls: 0, invalidCalls: 0, patches: 0, patchFailures: 0, completionRequests: 0, falseCompletions: 0, repeats: 0, mutatingTurns: 0, verifiedTurns: 0, turns: 0, onOutcomeTurns: 0, vision: null, usableContext: null };

function prior(model) { const m = String(model || ''); for (const [re, d] of PRIORS) if (re.test(m)) return d; return 'MEDIUM'; }

/** Fold one finished turn into the model's profile. */
function record(model, t) {
  if (!model) return null;
  const all = readAll();
  const p = { ...EMPTY, ...(all[model] || {}) };
  for (const k of ['calls', 'invalidCalls', 'patches', 'patchFailures', 'completionRequests', 'falseCompletions', 'repeats']) p[k] += Number(t[k]) || 0;
  p.turns += 1;
  if (t.mutated) { p.mutatingTurns += 1; if (t.verified) p.verifiedTurns += 1; }
  if (t.onOutcome) p.onOutcomeTurns += 1;
  if (t.vision != null) p.vision = Boolean(t.vision);
  if (t.usableContext) p.usableContext = Number(t.usableContext);
  p.updatedAt = new Date().toISOString();
  all[model] = p;
  writeAll(all);
  return p;
}

function metrics(p) {
  const r = (a, b, d = null) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : d);
  return {
    tool_call_validity: r(p.calls - p.invalidCalls, p.calls),
    patch_success: r(p.patches - p.patchFailures, p.patches),
    false_completion_rate: r(p.falseCompletions, p.completionRequests),
    repetition_rate: r(p.repeats, p.calls),
    verification_propensity: r(p.verifiedTurns, p.mutatingTurns),
    usable_context: p.usableContext,
    vision: p.vision,
    long_horizon_coherence: r(p.onOutcomeTurns, p.turns),
  };
}

/** STRONG | MEDIUM | WEAK, with how it was decided. */
function discretion(model) {
  const p = readAll()[model];
  if (!p || p.calls < MIN_SAMPLE) return { level: prior(model), basis: 'prior', metrics: p ? metrics(p) : null };
  const m = metrics(p);
  const bad = (m.tool_call_validity != null && m.tool_call_validity < 0.85) || (m.patch_success != null && m.patch_success < 0.7)
    || (m.false_completion_rate != null && m.false_completion_rate > 0.35) || (m.repetition_rate != null && m.repetition_rate > 0.3);
  const good = (m.tool_call_validity == null || m.tool_call_validity >= 0.97) && (m.patch_success == null || m.patch_success >= 0.9)
    && (m.false_completion_rate == null || m.false_completion_rate <= 0.1) && (m.repetition_rate == null || m.repetition_rate <= 0.1)
    && (m.verification_propensity == null || m.verification_propensity >= 0.6);
  return { level: bad ? 'WEAK' : good ? 'STRONG' : 'MEDIUM', basis: 'measured', metrics: m };
}

/** What each level changes about HOW the work is shaped — never what counts as evidence. */
const SHAPE = Object.freeze({
  STRONG: { focus: 'brief', verification: 'model-chosen', independentCheck: false },
  MEDIUM: { focus: 'focused', verification: 'recommended', independentCheck: false },
  WEAK: { focus: 'structured', verification: 'mandatory tier', independentCheck: true },
});

module.exports = { record, discretion, metrics, prior, SHAPE, MIN_SAMPLE, file };
