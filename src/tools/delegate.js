'use strict';

/**
 * `delegate` and `ab_compare` — the main agent's two ways to use other agents.
 * Both refuse inside a bounded worker: a subagent never delegates (§63).
 */

const CONTRACT = {
  type: 'object',
  properties: {
    role: { type: 'string', enum: ['SCOUT', 'FOUNDATION', 'IMPLEMENTER', 'VERIFIER', 'RESEARCHER'] },
    objective: { type: 'string' },
    readScope: { type: 'array', items: { type: 'string' }, description: 'files/globs it may read — never the whole project for a writer' },
    writeScope: { type: 'array', items: { type: 'string' }, description: 'files/globs it alone may write; empty for SCOUT/VERIFIER/RESEARCHER' },
    ownedFiles: { type: 'array', items: { type: 'string' } },
    expectedOutput: { type: 'string' },
    verification: { type: 'string', description: 'what it must run or observe before reporting' },
    completion: { type: 'string', description: 'the condition that means it is finished' },
    model: { type: 'string', description: 'optional: a catalog model id for this subagent (any source, e.g. an OpenRouter model)' },
  },
  required: ['role', 'objective', 'readScope', 'expectedOutput', 'verification', 'completion'],
};

function refuseInside(ctx, name) {
  if (ctx && ctx.workOrder && ctx.workOrder.bounded) return { output: `DENIED: a subagent cannot use ${name}; report back to the main agent instead.`, isError: true, denied: true };
  if (!ctx || !ctx.app) return { output: `UNAVAILABLE: ${name} needs a LAIN session.`, isError: true };
  // SUBAGENTS OFF is the person's setting (`/subagents off`), and it covers A/B too.
  if (require('../subagents').settings(ctx.app).mode === 'off') {
    return { output: `DENIED SUBAGENTS_OFF: ${name} starts other agents, and subagents are turned off for this LAIN (/subagents auto to allow). Do the work yourself.`, isError: true, denied: true };
  }
  // ECO spends no extra model work on other agents unless the person asked (profile.js).
  const eco = require('../profile').allowsExtraAgents(ctx.session || ctx.app.session, name);
  if (!eco.ok) return { output: eco.output, isError: true, denied: true };
  return null;
}

const tools = {
  delegate: {
    mutates: false,
    schema: {
      name: 'delegate',
      description: 'Hand bounded work to specialist subagents. Use ONLY when the task naturally partitions, a long independent investigation exists, '
        + 'specialist verification helps, or a pipeline would keep your own context small — a one-agent task stays with you. '
        + 'Each subagent gets a FRESH session with only its contract (never this conversation), an enforced read/write scope and a write lease. '
        + 'mode "pipeline" runs stages in order (SCOUT → FOUNDATION → IMPLEMENTER → VERIFIER), each handed the earlier outputs; '
        + 'mode "parallel" requires disjoint writeScopes. You remain the integrator: check the results before relying on them.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['pipeline', 'parallel'] },
          agents: { type: 'array', items: CONTRACT, minItems: 1, maxItems: 6 },
        },
        required: ['agents'],
      },
    },
    async run(input, ctx) {
      const no = refuseInside(ctx, 'delegate');
      if (no) return no;
      const out = await require('../subagents').run(ctx.app, input.agents || [], { mode: input.mode === 'parallel' ? 'parallel' : 'pipeline', signal: ctx.signal });
      const mutated = out.results.flatMap((r) => r.mutations || []);
      return { output: require('../subagents').report(out), isError: !out.ok, meta: { delegated: out.results.length, mode: out.mode }, mutated };
    },
  },
  ab_compare: {
    mutates: true,
    schema: {
      name: 'ab_compare',
      description: 'For a DIFFICULT implementation or bug fix with two credible approaches: build candidate A and candidate B in isolated git worktrees, '
        + 'run the SAME verification command in each, select the winner from the evidence (passes, then smaller change, then faster), '
        + 'integrate only the winner into this tree, verify it here, and delete every temporary worktree. Asks the person only when the evidence does not decide.',
      parameters: {
        type: 'object',
        properties: {
          problem: { type: 'string' },
          verify: { type: 'string', description: 'one command both candidates must pass, e.g. "npm test -- retry"' },
          approachA: { type: 'string' },
          approachB: { type: 'string' },
          scope: { type: 'array', items: { type: 'string' }, description: 'files/globs the change may touch' },
        },
        required: ['problem', 'verify', 'approachA', 'approachB'],
      },
    },
    async run(input, ctx) {
      const no = refuseInside(ctx, 'ab_compare');
      if (no) return no;
      const r = await require('../abtest').run(ctx.app, {
        problem: input.problem, verifyCommand: input.verify,
        candidates: [{ approach: input.approachA }, { approach: input.approachB }], scope: input.scope || [],
      });
      const lines = [`A/B · ${r.integrated ? `selected ${r.record.selected}` : 'nothing integrated'} — ${r.record ? r.record.reason : r.why}`];
      for (const c of r.candidates || []) lines.push(`  ${c.label}: ${c.pass ? 'PASS' : 'FAIL'} · ${c.lines} lines · ${c.ms}ms · ${c.approach.slice(0, 80)}`);
      if (r.canonical) lines.push(`canonical verification: ${r.canonical.ok ? 'PASS' : `FAIL (exit ${r.canonical.code})`}`);
      lines.push('temporary worktrees removed');
      return { output: lines.join('\n'), isError: !r.ok, mutated: r.integrated ? (r.record.files || []) : [] };
    },
  },
};

module.exports = { tools };
