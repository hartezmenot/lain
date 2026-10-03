'use strict';

/** THE ONE ACTIVITY LINE — the words it is built from (2026-10-01). */

/** 812 · 9.6k · 1.2M — a token count, short. */
function tok(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Characters → an ESTIMATED token figure (≈4 chars/token), labelled as one. Never presented as a count. */
function estTokens(chars) {
  const n = Math.max(0, Number(chars) || 0);
  if (!n) return '';
  return `~${tok(Math.max(1, Math.round(n / 4)))} tok`;
}

const KINDS = ['shell', 'monitor', 'agent', 'preview', 'check'];
const PLURAL = { shell: 'shells', monitor: 'monitors', agent: 'agents', preview: 'previews', check: 'checks' };

/** What is running besides the model, by user-facing kind. Reads the registries; never narration. */
function backgroundOf(app) {
  const n = { shell: 0, monitor: 0, agent: 0, preview: 0, check: 0 };
  if (!app) return n;
  try {
    for (const j of (app._jobs && typeof app._jobs.running === 'function' ? app._jobs.running() : [])) {
      n[j.kind === 'monitor' ? 'monitor' : 'shell'] += 1;
    }
  } catch { /* a registry that cannot be read counts nothing */ }
  try {
    for (const j of (app.jobs && typeof app.jobs.running === 'function' ? app.jobs.running() : [])) {
      if (j.primary) continue;
      if (j.kind === 'subagent') n.agent += 1;
      else if (j.kind === 'process') n.shell += 1;
    }
  } catch { /* idem */ }
  return n;
}

/** `1 shell · 1 monitor` — empty when nothing runs in the background. */
function backgroundLabel(counts) {
  if (!counts) return '';
  return KINDS.filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${counts[k] === 1 ? k : PLURAL[k]}`).join(' · ');
}

/** THE RECEIPT, compact: `in 18.2k · reasoning 7.4k · out 1.1k · cache 12.8k`. */
function receipt(u) {
  if (!u) return '';
  const parts = [];
  if (Number(u.inputTokens) > 0) parts.push(`in ${tok(u.inputTokens)}`);
  if (Number(u.reasoningTokens) > 0) parts.push(`reasoning ${tok(u.reasoningTokens)}`);
  if (Number(u.outputTokens) > 0) parts.push(`out ${tok(u.outputTokens)}`);
  if (u.cacheReadTokens != null && Number(u.cacheReadTokens) > 0) parts.push(`cache ${tok(u.cacheReadTokens)}${cachePct(u) != null ? ` (${cachePct(u)}%)` : ''}`);
  return parts.join(' · ');
}

/** The share of the prompt served from the provider's cache, or null when the provider stated no prompt size. */
function cachePct(u) {
  const prompt = Number(u && u.promptTokens) || 0;
  const read = Number(u && u.cacheReadTokens) || 0;
  return prompt > 0 ? Math.min(100, Math.round((100 * read) / prompt)) : null;
}

module.exports = { tok, estTokens, backgroundOf, backgroundLabel, receipt, cachePct, KINDS };
