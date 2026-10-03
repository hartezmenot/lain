'use strict';

/**
 * THINKING, FOLDED (Simplify S5.1): one dim line per thinking phase — `▸ Thought for 2m 23s · 8.2k tokens` — that
 * Ctrl+O opens to show what the model thought. An interrupted think reads `▸ Thinking (interrupted) · 759 tokens`.
 * Display only: never the model's message, never sent back to it.
 */

const EXPANDED_ROWS = 14;

function dur(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function tokens(t) {
  if (t.tokens != null) return `${require('./activityline').tok(t.tokens)} tokens`;
  if (t.chars) return `~${require('./activityline').tok(Math.ceil(t.chars / 4))} tokens`;
  return '';
}

/** The one-line summary of a phase (or of several, summed). */
function label(t, open = false) {
  const mark = open ? '▾' : '▸';
  const tk = tokens(t);
  const head = t.interrupted ? 'Thinking (interrupted)' : `Thought for ${dur(t.ms)}`;
  return `${mark} ${head}${tk ? ` · ${tk}` : ''}`;
}

/** Several phases of one finished turn as one line. */
function sum(list) {
  const xs = (list || []).filter(Boolean);
  if (!xs.length) return null;
  const known = xs.every((t) => t.tokens != null);
  return {
    ms: xs.reduce((a, t) => a + (t.ms || 0), 0),
    chars: xs.reduce((a, t) => a + (t.chars || 0), 0),
    tokens: known ? xs.reduce((a, t) => a + (t.tokens || 0), 0) : null,
    interrupted: xs[xs.length - 1].interrupted,
    hidden: xs.every((t) => t.hidden),
    text: xs.map((t) => t.text || '').filter(Boolean).join('\n\n'),
  };
}

/** Push the folded line (and, opened, the thought itself) as feed entries. */
function push(out, t, open = false) {
  if (!t) return;
  out.push({ kind: 'thought', text: label(t, open && !t.hidden && Boolean(t.text)) });
  if (!open || t.hidden || !t.text) return;
  const lines = String(t.text).split(/\r?\n/).map((l) => l.trimEnd()).filter((l, i, a) => l || (a[i - 1] && a[i - 1].trim()));
  for (const l of lines.slice(-EXPANDED_ROWS)) out.push({ kind: 'thought', text: `  ${l}` });
}

/** A turn that ended with reasoning and no answer: said so, in the thinking style (never as the model's message). */
function reasoningOnly(out, text) {
  out.push({ kind: 'thought', text: 'The model returned only its reasoning:' });
  for (const l of String(text || '').split(/\r?\n/).slice(-EXPANDED_ROWS)) out.push({ kind: 'thought', text: `  ${l}` });
  out.push({ kind: 'note', level: 'info', text: 'no answer text came back — the route sent reasoning only; ask again or switch model' });
}

module.exports = { label, sum, push, reasoningOnly, dur };
