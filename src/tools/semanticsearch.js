'use strict';

/** SEMANTIC SEARCH (S9): Laya, only where it is installed — files ranked by meaning, fused with the lexical shortlist. */

function installed(app) {
  if (process.env.LAIN_ISOLATED === '1' && !process.env.LAIN_SEMANTIC_SEARCH) return false;   // tests see this machine's models only on request
  try { const w = require('../workerruntime').info(app, 'laya'); return Boolean(w && w.usable); } catch { return false; }
}

const tools = {
  semantic_search: {
    mutates: false,
    schema: {
      name: 'semantic_search',
      description: 'Find the project files most related to a description in plain words ("where the login form is validated"), '
        + 'by meaning as well as words. Returns paths, best first. Use grep for exact text.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string', description: 'project root (default: the working directory)' } }, required: ['query'] },
    },
    async run(input, ctx) {
      const app = ctx && ctx.app;
      const root = require('path').resolve(((ctx && ctx.session) || (app && app.session) || {}).cwd || process.cwd(), (input && input.path) || '.');
      const q = String((input && input.query) || '').trim();
      if (!q) return { output: 'semantic_search needs a query', isError: true };
      const r = await require('../locateassist').rank(app, root, q, { laya: 'cos' });
      if (!r.ranked.length) return { output: `no file matched "${q}" (${r.n} files considered)` };
      const how = r.by === 'laya' ? 'by meaning and words' : `by words only${r.laya && r.laya.bypass ? ` (Laya: ${String(r.laya.bypass).toLowerCase()})` : ''}`;
      return { output: [`${r.ranked.length} of ${r.n} files, ${how}:`, ...r.ranked.map((x) => `  ${x.id}`)].join('\n') };
    },
  },
};

module.exports = { tools, installed };
