'use strict';

/**
 * `geometry_specialist` — Violetto, OFFERED ONLY WHEN FORCED ON (2026-09-23).
 *
 * The `geometry_solver` contract (workers.js): numeric consequences of a
 * geometric change, nothing else. Its recruitment gate FAILED (3/6 within
 * ±0.5 px, ~228 s per answer against a deterministic solver at 6/6 in
 * microseconds), so `auto` never offers it; `/workers violetto on` or
 * LAIN_WORKER_VIOLETTO=on does, for experiments. The answer is labelled as an
 * unverified hint: the flagship checks it by arithmetic or by measuring.
 *
 * Bounded: one question, one inference (or a cached result for the SAME
 * question), a hard timeout, no retry, no access to files or other workers.
 */

const crypto = require('crypto');

function lastLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
}

const tools = {
  geometry_specialist: {
    mutates: false,
    schema: {
      name: 'geometry_specialist',
      description: 'EXPERIMENTAL local geometry specialist (Violetto, 1B, CPU). ONLY for a bounded numeric geometry problem — sizes, '
        + 'centering, insets, ratios, alignment — stated with every number it needs. It is slow (minutes) and often wrong: treat the '
        + 'answer as a hint and verify it by arithmetic or by measuring in the browser. Never for colours, UX, APIs or architecture.',
      parameters: {
        type: 'object',
        properties: {
          problem: { type: 'string', description: 'the geometry problem, with every dimension and constraint as numbers' },
          answer_format: { type: 'string', description: 'the one line the answer must end with, e.g. "width=?, x=?, y=?"' },
        },
        required: ['problem'],
      },
    },
    async run(input, ctx) {
      const app = ctx && ctx.app;
      const rt = require('../workerruntime');
      if (!app || !rt.uses(app, 'violetto', 'geometry')) return { output: 'UNAVAILABLE: the geometry specialist is not enabled.', isError: true };
      const problem = String(input.problem || '').slice(0, 2000);
      const fmt = String(input.answer_format || '').slice(0, 120);
      if (!problem.trim()) return { output: 'geometry_specialist needs a problem.', isError: true };
      const max = Number(((app.cfg.workers || {}).violetto || {}).maxTokens) || rt.info(app, 'violetto').maxTokens || 6000;
      const content = fmt ? `${problem}\nEnd with exactly one line: ${fmt}` : problem;
      const key = crypto.createHash('sha1').update(content).digest('hex');
      // A LOAD STILL IN PROGRESS IS NOT WAITED FOR: the worker gets the
      // availability deadline and is otherwise bypassed (workerruntime.call).
      // `warmWaitMs` stays on the row, always 0, so a returning wait shows.
      const warmWaitMs = 0;
      const st = rt.stats(app, 'violetto');
      const bypassesBefore = st.bypasses || 0;
      const r = await rt.call(app, 'violetto', { messages: [{ role: 'user', content }], max_tokens: max }, { timeoutMs: 10 * 60 * 1000, cacheKey: key });
      const bypass = !r && (st.bypasses || 0) > bypassesBefore ? (st.bypassStates || []).slice(-1)[0] || 'LOADING' : null;
      const row = { contract: 'geometry_solver', worker: 'VIOLETTO', ms: r ? (r.cached ? 0 : r.ms) : 0, warmWaitMs, bypass, cacheHit: Boolean(r && r.cached),
        inChars: content.length, outChars: r ? String(r.text || '').length : 0,
        tokensIn: r && !r.cached ? r.usage.tokens_in : 0, tokensOut: r && !r.cached ? r.usage.tokens_out : 0,
        problem: problem.slice(0, 400), answer: r ? lastLine(r.text) : null, finish: r ? r.finish : 'failed' };
      try { require('../workers').note(ctx.session, row); } catch { /* measurement only */ }
      if (bypass) return { output: `GEOMETRY SPECIALIST NOT READY (${bypass}) — not waited for. Solve it by arithmetic or measure it.`, isError: true };
      if (!r) return { output: 'GEOMETRY SPECIALIST FAILED (no answer within the time limit). Solve it by arithmetic or measure it.', isError: true };
      return {
        output: [
          `VIOLETTO · experimental, UNVERIFIED · ${r.cached ? 'cached result' : `${Math.round(r.ms / 1000)}s · ${r.usage.tokens_out} tokens · ${r.finish}`}`,
          `final line: ${lastLine(r.text) || '(none)'}`,
          r.finish === 'length' ? 'It ran out of tokens; the final line may be a guess mid-reasoning.' : '',
          'Verify these numbers before relying on them.',
        ].filter(Boolean).join('\n'),
      };
    },
  },
};

module.exports = { tools, lastLine };
