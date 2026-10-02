'use strict';

/**
 * THE TASK CONTRACT AND COMPLETION, AS TOOLS (Execution Discipline §17–§18, §26, §28).
 *
 *   task_contract       record or revise the requested outcome, the explicit asks, acceptance criteria (with the
 *                       evidence that meets them), facts, hypotheses, open questions, blockers and scaffolding; and
 *                       DISCLOSE test changes Noema flagged. Noema stores it; the model proposes and revises.
 *   request_completion  ask Noema to finish the task, with typed claims (CHANGED / VERIFIED(check) / INFERRED /
 *                       NOT_CHECKED). The completion arbiter decides — the model cannot certify its own work.
 *
 * Neither changes the project, so both stay available in every mode.
 */

function lifeOf(ctx) {
  const s = (ctx && ctx.app && ctx.app.session) || (ctx && ctx.session) || null;
  const life = s && s.lifecycle;
  if (life && !life.discipline) life.discipline = new (require('../discipline').Discipline)(life.objective || '');
  return { session: s, life };
}

function modelOf(ctx) { const app = ctx && ctx.app; return (app && ((app.session && app.session.model) || (app.cfg && app.cfg.model))) || ''; }

const ITEM = { type: 'object', additionalProperties: true };
const tools = {
  task_contract: {
    mutates: false,
    schema: {
      name: 'task_contract',
      description: 'Record or revise what this task must achieve and what is known. Set `outcome` (the observable result that shows it is done), `asks` (each explicit ask, with status OPEN/ADDRESSED/DEFERRED), `criteria` (acceptance criteria; mark MET with evidence {check: id from a check or Preview observation, expect?: text the observation must contain}), `facts` ({text, kind: STRUCTURAL|EXECUTION, owner?: file}), `hypotheses`, `questions`, `blockers`, `scaffold` ([{path, status: ACTIVE|KEPT|REMOVED}]), or `disclose` ({ids:[...], note}) for flagged test changes. Returns the current task state.',
      parameters: {
        type: 'object',
        properties: {
          outcome: { type: 'string' },
          asks: { type: 'array', items: ITEM },
          criteria: { type: 'array', items: ITEM },
          facts: { type: 'array', items: ITEM },
          hypotheses: { type: 'array', items: { type: 'string' } },
          questions: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
          scaffold: { type: 'array', items: ITEM },
          checks: { type: 'array', items: ITEM, description: '[{id, relevance: RELEVANT|UNRELATED, note}] — your judgment of a recorded check; an UNRELATED failure needs a reason and is reported' },
          disclose: ITEM,
        },
      },
    },
    run: async (input = {}, ctx) => {
      const { life } = lifeOf(ctx);
      if (!life) return { output: 'no task is in progress', isError: true };
      const d = life.discipline; const c = d.contract;
      const notes = [];
      if (input.outcome) c.setOutcome(input.outcome, 'model');
      for (const a of input.asks || []) { if (!c.ask(a.id, { status: a.status ? String(a.status).toUpperCase() : undefined, note: a.note, text: a.text })) notes.push(`ask ${a.id || '?'} not found`); }
      for (const k of input.criteria || []) {
        const r = c.criterion(k.id, { text: k.text, askIds: k.asks || k.askIds, status: k.status ? String(k.status).toUpperCase() : undefined, evidence: k.evidence && k.evidence.check ? { check: String(k.evidence.check), expect: k.evidence.expect || null } : null });
        if (!r) notes.push(`criterion ${k.id || '?'} needs text`);
        else if (k.evidence && k.evidence.check && !d.checks.get(k.evidence.check)) notes.push(`${k.evidence.check} is not a check or observation Noema recorded`);
      }
      for (const f of input.facts || []) c.fact(f.text || f, { kind: f.kind, owner: f.owner, provenance: f.provenance || 'model', gen: life.mutationSeq || 0 });
      for (const h of input.hypotheses || []) c.note('hypotheses', h);
      for (const q of input.questions || []) c.note('questions', q);
      for (const b of input.blockers || []) c.note('blockers', b);
      for (const s of input.scaffold || []) c.scaffold(s.path, String(s.status || 'ACTIVE').toUpperCase());
      for (const k of input.checks || []) {
        if (!k.note && String(k.relevance || '').toUpperCase() === 'UNRELATED') { notes.push(`${k.id}: say why it is unrelated (note)`); continue; }
        if (!d.checks.judge(k.id, { relevance: k.relevance, note: k.note })) notes.push(`${k.id} is not a check Noema recorded`);
      }
      if (input.disclose) { const done = d.disclose(input.disclose.ids || ['all'], input.disclose.note || ''); notes.push(`disclosed ${done.map((f) => f.id).join(', ') || 'nothing'}`); }
      const satisfied = require('../discipline/arbiter').outcomeSatisfied(life);
      const state = require('../discipline/digest').digest(life, { cwd: ctx && ctx.cwd });
      return { output: `${notes.length ? `${notes.join('; ')}\n` : ''}${satisfied ? 'OUTCOME SATISFIED — every acceptance criterion is evidenced. Report and request completion; do not keep changing things.\n' : ''}${state || 'recorded'}` };
    },
  },

  request_completion: {
    mutates: false,
    schema: {
      name: 'request_completion',
      description: 'Ask Noema to finish this task. Give typed `claims` ([{type: CHANGED|VERIFIED|INFERRED|NOT_CHECKED, text, check?: id}]) and mark `asks` ({A1: "ADDRESSED"|"DEFERRED"}). Use state "BLOCKED" (with layer and reason) or "NEEDS_DECISION" (with question) instead when that is the truth. Noema decides: DONE, DONE_UNVERIFIED, PARTIAL, BLOCKED or NEEDS_DECISION. Set accept_unverified / accept_partial to finish honestly without the missing evidence or asks.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          claims: { type: 'array', items: ITEM },
          asks: { type: 'object', additionalProperties: { type: 'string' } },
          state: { type: 'string', enum: ['DONE', 'BLOCKED', 'NEEDS_DECISION'] },
          layer: { type: 'string' }, reason: { type: 'string' }, question: { type: 'string' },
          accept_unverified: { type: 'boolean' }, accept_partial: { type: 'boolean' },
        },
      },
    },
    run: async (input = {}, ctx) => {
      const { session, life } = lifeOf(ctx);
      if (!life) return { output: 'no task is in progress', isError: true };
      const d = life.discipline;
      for (const [id, st] of Object.entries(input.asks || {})) d.contract.ask(id, { status: String(st).toUpperCase() });
      const claims = (input.claims || []).map((c) => ({ type: String(c.type || 'VERIFIED').toUpperCase().replace(' ', '_'), text: String(c.text || ''), check: c.check || null }));
      const discretion = require('../discipline/profile').discretion(modelOf(ctx)).level;
      const changeClass = (session && session._changeClass && session._changeClass.class) || null;
      let readOnly = false;
      try { readOnly = require('../readonly').active(session); } catch { readOnly = false; }
      const v = require('../discipline/arbiter').evaluate(life, { cwd: (ctx && ctx.cwd) || (session && session.cwd), requested: true, request: { state: input.state, layer: input.layer, reason: input.reason, question: input.question }, claims, discretion, changeClass, readOnly });
      d.claims = v.claims || [];
      d.verdict = { state: v.state, why: v.why, at: Date.now() };
      life._completionRequests = (life._completionRequests || 0) + 1;
      if (v.state !== 'DONE' || (v.claims || []).some((c) => !c.accepted)) life._falseCompletions = (life._falseCompletions || 0) + 1;
      const settle = (state, why) => { life.state = state; life.reason = why; };
      const claimLines = (v.claims || []).map((c) => `  ${c.accepted ? c.as : `${c.type} → ${c.as}`}${c.checkIds && c.checkIds.length ? `(${c.checkIds.join(',')})` : ''}: ${c.text.slice(0, 100)}${c.why ? ` — ${c.why}` : ''}`);
      let head;
      if (v.state === 'DONE') { settle('DONE', v.why); head = `DONE — ${v.why}`; }
      else if (v.state === 'BLOCKED') { settle('BLOCKED', v.why); head = `BLOCKED — ${v.why}`; }
      else if (v.state === 'NEEDS_DECISION') { life.needsUser(v.why); head = `NEEDS_DECISION — ${v.why}`; }
      // DONE_UNVERIFIED SETTLES AT ONCE (2026-10-02): the disclosure is the outcome. Asking for a second call with
      // accept_unverified cost a whole model turn to restate an honest result.
      else if (v.state === 'DONE_UNVERIFIED') { settle('DONE_UNVERIFIED', v.why); head = `DONE_UNVERIFIED — ${v.why}. Report the change and exactly what is not verified, in a sentence or two.`; }
      else if (v.state === 'PARTIAL' && input.accept_partial) { settle('PARTIAL', v.why); head = `PARTIAL — ${v.why}. Report what remains.`; }
      else head = `NOT COMPLETE (${v.state}) — ${v.why}. ${v.state === 'PARTIAL' ? 'Address or defer the remaining asks, or call again with accept_partial.' : 'Resolve this before requesting completion again.'}`;
      const output = [head, ...(claimLines.length ? ['claims:', ...claimLines] : [])].join('\n');
      // A SETTLED TASK ENDS THE TURN (turn.js): the verdict is Noema's, so there is nothing left to re-verify — a model
      // that kept going re-checked a finished task four times in a real GLM run (2026-10-01).
      if (life.state !== 'ACTIVE' || v.state === 'NEEDS_DECISION') life._closed = { state: v.state, text: output };
      return { output, meta: { verdict: v.state } };
    },
  },
};

module.exports = { tools };
