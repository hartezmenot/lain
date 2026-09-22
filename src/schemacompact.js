'use strict';

/**
 * ECO'S REAL TOKEN LEVER — the same tools, described in fewer words (2026-09-23).
 *
 * MEASURED before this existed (the same scripted fixture, the turn's own
 * audits): every request carried ~15.4k tokens of tool schemas — 75% of the
 * first request — and FAST, NORMAL and ECO sent byte-for-byte the same
 * payloads, ±0.5%. ECO's smaller context budget never bound on an ordinary
 * task, so "token economy" was serialization and nothing else.
 *
 * WHAT ECO NOW DOES. Every tool is still offered, with the SAME name and the
 * SAME parameter structure — nothing is stripped, nothing is renamed. Only the
 * prose shrinks:
 *   - a tool's description keeps its first two sentences, plus EVERY sentence
 *     that states a hard constraint (MUST, NEVER, ONLY, ONE call, Do not,
 *     refused, DENIED, required, …) — the rules survive, the essays do not;
 *   - a parameter description keeps its first sentence, bounded.
 * Deterministic and stable across requests, so a prompt cache still holds it.
 */

const RULE = /\b(?:MUST|NEVER|ONLY|ONE call|Do not|do not|Never|refus\w*|DENIED|required|REQUIRED|Without it|without it|not a|is not|INCONCLUSIVE|ambiguous)\b/;
const MAX_DESC = 700;
const MAX_PARAM = 140;

function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [];
}

function description(text) {
  const all = sentences(text).map((s) => s.trim()).filter(Boolean);
  const kept = all.filter((s, i) => i < 2 || RULE.test(s));
  let out = '';
  for (const s of kept) { if ((out + ' ' + s).length > MAX_DESC) break; out = out ? `${out} ${s}` : s; }
  return out || String(text || '').slice(0, MAX_DESC);
}

function param(text) {
  const first = sentences(text)[0] || String(text || '');
  return first.length > MAX_PARAM ? `${first.slice(0, MAX_PARAM - 1).trimEnd()}…` : first.trim();
}

/** Deep-copy a JSON schema with every nested `description` shortened. */
function schema(s) {
  if (Array.isArray(s)) return s.map(schema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) out[k] = k === 'description' && typeof v === 'string' ? param(v) : schema(v);
  return out;
}

/** The tool list, compacted. Names and parameter shapes are untouched. */
function compact(tools = []) {
  return tools.map((t) => ({ ...t, description: description(t.description), parameters: schema(t.parameters) }));
}

module.exports = { compact, description, param };
