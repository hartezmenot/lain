'use strict';

/** `recall_evidence` — an earlier deterministic result, by its id. */

const tools = {
  recall_evidence: {
    mutates: false,
    schema: {
      name: 'recall_evidence',
      description:
        'Return the full content of an earlier deterministic result named as evidence:eN in your context '
        + '(language-server references, a UI-graph slice, a diff, test output). Cheaper than re-running the lookup, '
        + 'and refused when the files it was computed from have changed since — then re-run the lookup instead.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'the evidence id, e.g. "evidence:e14" or "e14"' } },
        required: ['id'],
      },
    },
    async run(input, ctx) {
      const ev = require('../evidencerefs');
      const session = ctx && ctx.session;
      const asked = String((input && input.id) || '').trim();
      const r = ev.get(session, asked);
      // A MISSING OR STALE ID IS A STRUCTURED ANSWER, not a dead end (2026-09-29): the ids that DO hold
      // current evidence come back with it, so the model re-asks or re-runs instead of ending its turn.
      const current = () => ev.view(session).entries.filter((e) => !e.stale).slice(-6).map((e) => ({ id: `evidence:${e.id}`, kind: e.kind, summary: String(e.summary || '').slice(0, 120) }));
      const listed = (rows) => (rows.length ? ` Current evidence: ${rows.map((x) => `${x.id} (${x.kind}) ${x.summary}`).join(' · ')}.` : ' No current evidence is recorded — run the lookup itself.');
      if (!r.entry) {
        const related = current();
        const shape = /^(?:evidence:)?e\d+$/i.test(asked) ? '' : ' Evidence ids look like "e14"; a receipt or another tool\'s id is not one.';
        return { output: `EVIDENCE_NOT_FOUND: "${asked}" is not evidence in this session.${shape}${listed(related)}`, isError: true, meta: { code: 'EVIDENCE_NOT_FOUND', related } };
      }
      if (r.state === 'stale') {
        const related = current();
        return { output: `EVIDENCE_STALE: evidence:${r.entry.id} — ${r.why}. Re-run the lookup (${r.entry.kind}) rather than use it.${listed(related)}`, isError: true, meta: { code: 'EVIDENCE_STALE', stale: true, related } };
      }
      return { output: `${ev.ref(r.entry)}\n${r.entry.content}`, meta: { id: r.entry.id, state: r.state } };
    },
  },
};

module.exports = { tools };
