'use strict';

/**
 * A FINAL SMOKE STEP only where the verification contract asks for broad proof (finalsmoke.js, verifycontract.js) —
 * a task the person framed as a release, or one whose changes already reach project-wide files. Never a ritual
 * appended to every plan.
 */
function terminalSmoke(session) {
  const cls = session && session.taskClassVerdict && session.taskClassVerdict.cls;
  if (cls !== 'PROJECT_IMPLEMENTATION') return;
  const life = session.lifecycle;
  const fs = require('../finalsmoke');
  const objective = (life && life.objective) || (session.task && session.task.objective) || '';
  const broad = life && life.evidence && life.evidence.filesChanged.size ? fs.state(life, session.cwd) !== 'NOT_REQUIRED'
    : require('../verifycontract').requirement(session.cwd || process.cwd(), [], { objective }).needsSuite;
  if (broad) fs.ensureTerminal(session.plan, session.cwd);
}

/**
 * THE PLAN, REACHABLE BY THE MODEL.
 *
 * plan.js owned a complete plan implementation — steps, completion, steer
 * semantics, protection of finished work — and `/plan` let the USER drive it.
 * The model could not touch it. That left three things permanently dead in real
 * use, which is how it was found: not by reading the code, but by watching a
 * real task finish with an empty plan view and a 0% progress bar.
 *
 *   - `App.maybeComplete()` requires `plan.isFinished`, so with no plan it
 *     returned false forever. The completion screen and its evidence check —
 *     both implemented, both tested — could never fire on a real task.
 *   - The PLAN view had nothing to show.
 *   - Progress was always 0%.
 *
 * This file adds NO plan logic. Every rule still lives in plan.js: the Plan
 * class creates the steps, promotes the next one, and refuses to rewrite
 * completed work. This is the adapter that lets the model call it.
 *
 * WHAT THESE TOOLS CANNOT DO, and why that matters:
 *
 *   - They cannot COMPLETE A TASK. `plan_step_done` finishes a step; whether
 *     the task is done is still decided by `lifecycle.complete()`, which
 *     demands real evidence — a changed file, a command that ran, a verified
 *     check. A model that writes a one-step plan and immediately marks it done
 *     has produced a finished checklist and no evidence, and completion is
 *     refused exactly as before.
 *   - They cannot rewrite history. Completed steps are evidence and plan.js
 *     will not touch them.
 *   - They cannot start or redefine the task. Task identity is task.js's, and
 *     nothing here writes it.
 *
 * A plan remains OPTIONAL. Nothing requires the model to write one, and small
 * work should not have one — the tool descriptions say so, because a plan for
 * "fix this typo" is pure overhead.
 */

const { Plan } = require('../plan');

const MAX_STEPS = 20;
const MAX_STEP_CHARS = 200;

/** Plans live on the session; without one there is nowhere to put a plan. */
function sessionOf(ctx) {
  return ctx && ctx.session ? ctx.session : null;
}

const tools = {
  plan_write: {
    // Not a filesystem mutation: there is no plan file, and there is nothing to
    // snapshot or undo. The plan is a field on the session object.
    mutates: false,
    schema: {
      name: 'plan_write',
      description:
        'Record a short plan for work worth tracking (roughly 3-7 steps). Optional — skip it for small, '
        + 'single-edit tasks. Calling it again REPLACES the steps not yet done; steps already completed are '
        + 'kept and never rewritten. The plan is shown to the user and drives the progress display.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'the remaining steps, in order, each one short and concrete',
          },
          /**
           * KEPT IN THE SCHEMA, DEMOTED IN MEANING.
           *
           * It used to read "optional one-line restatement of the goal", which
           * invited the model to write a THIRD objective-shaped field beside the
           * user's goal and the task — and nothing compared them, so this could
           * silently coexist:
           *
           *     GOAL   stabilise provider continuation
           *     TASK   repair handover
           *     PLAN   redesign frontend
           *
           * The description now says what the field is for, and the run() below
           * refuses to let it become authority. Removing the parameter outright
           * would break every model that has learned to send it; accepting it
           * and not trusting it costs nothing and keeps the wire compatible.
           */
          objective: {
            type: 'string',
            description: 'optional short LABEL for this plan, for display. It is not the goal and not '
              + 'the task: LAIN owns those, and a label that contradicts them is ignored.',
          },
        },
        required: ['steps'],
      },
    },
    async run(input, ctx) {
      const session = sessionOf(ctx);
      if (!session) return { output: 'no session is active, so there is nowhere to keep a plan', isError: true };

      const steps = (Array.isArray(input.steps) ? input.steps : [])
        .map((s) => String(s == null ? '' : s).trim().slice(0, MAX_STEP_CHARS))
        .filter(Boolean)
        .slice(0, MAX_STEPS);
      if (!steps.length) return { output: 'plan_write needs at least one non-empty step', isError: true };

      // ---- THE PLAN'S LABEL IS NOT AN AUTHORITY -----------------------------
      //
      // This line used to be `input.objective || session.task.objective` — the
      // model's word FIRST, the task's only as a fallback. So a plan could be
      // filed under an objective that contradicted the task it was supposed to
      // serve, and nothing in the tree compared the two.
      //
      // The order is now inverted and the model's version is CHECKED rather than
      // preferred. A label that shares no content with the task or the goal is
      // reported back and dropped; the plan is still written, because the STEPS
      // are the useful part and refusing them over a label would lose real work
      // for a display string. See src/authority.js `contradictions`.
      const authority = require('../authority');
      const stated = String(input.objective || '').trim();
      const derived = String((session.task && session.task.objective) || '').trim();
      const clash = stated ? authority.contradictions(session, { planObjective: stated }) : [];
      const objective = (stated && !clash.length) ? stated : derived;
      // WHAT THE MODEL IS TOLD when its label was dropped. Not an error: the
      // plan landed. It is a correction, and it names the authority it lost to,
      // so the next call does not repeat it.
      const note = clash.length
        ? ` — the objective you gave ("${clash[0].stated}") was not kept: it contradicts the `
          + `${clash[0].contradicts} ("${clash[0].authority}"), which LAIN owns. The plan is filed `
          + 'under that instead. Use plan steps to say HOW; the goal and the task belong to the user.'
        : '';

      const cp = require('../taskcheckpoint');
      if (!session.plan) {
        session.plan = new Plan(objective);
        session.plan.addSteps(steps);
        terminalSmoke(session);
        const c = cp.commit(session, 'plan recorded');
        const first = session.plan.current();
        return {
          output: `plan recorded — ${session.plan.steps.length} step(s). Step 1 of ${session.plan.steps.length}: ${first ? first.text : steps[0]}${note}`,
          meta: { steps: session.plan.steps.length, completed: 0, objectiveRejected: clash.length > 0, checkpoint: c && c.generation },
        };
      }

      // A REVISION — RECONCILED (plan.revise): an open step the new list still names keeps its place, id and
      // findings; finished steps are never re-added; only work that is gone is dropped. The numbers the model
      // is told are the ones every surface shows, so "step 3" means the same thing to both.
      const plan = session.plan;
      const r = plan.revise(steps);
      if (r.unchanged) {
        const cur = plan.current();
        const pos = plan.position(cur);
        return {
          output: `plan unchanged — ${plan.completed.length} step(s) already done, `
            + `${plan.remaining.length} still ahead${cur ? `; in hand: step ${pos.index} of ${pos.total}: ${cur.text}` : ''}`,
          meta: { steps: plan.steps.length, completed: plan.completed.length, unchanged: true },
        };
      }
      terminalSmoke(session);
      const c = cp.commit(session, 'plan revised');
      const cur = plan.current();
      const pos = plan.position(cur);
      return {
        output: `plan revised — ${plan.completed.length} done (unchanged), ${r.kept} kept, ${r.added} added, ${r.dropped} dropped`
          + `${r.skippedDone ? ` (${r.skippedDone} already-finished step(s) not re-added)` : ''}.`
          + `${cur ? ` In hand: step ${pos.index} of ${pos.total}: ${cur.text}` : ''}`,
        meta: { steps: plan.steps.length, completed: plan.completed.length, kept: r.kept, added: r.added, dropped: r.dropped, checkpoint: c && c.generation },
      };
    },
  },

  /**
   * WHAT THIS STEP HAS ALREADY ESTABLISHED.
   *
   * ------------------------------------------------------------------------
   * IT EXISTS SO A LONG STEP STOPS RE-DERIVING ITS OWN CONCLUSIONS.
   *
   * Facts settled early in a step live in the conversation, and the
   * conversation is the thing that gets shortened — by compaction, by a
   * rate-limit resume, by a continuation across a context boundary. What comes
   * back is a model that reads the same four files to rediscover the same four
   * facts, busily, without moving. See src/planfindings.js.
   *
   * WRITING HERE IS CHEAP AND BOUNDED: one short line per fact, capped, kept on
   * the step and persisted with the plan. It is not a scratchpad — a finding
   * that does not fit on a line was not a finding.
   */
  plan_findings: {
    mutates: false,
    schema: {
      name: 'plan_findings',
      description:
        'Record what the CURRENT plan step has already established, so it is not re-derived after a '
        + 'compaction or a resume. Use short factual lines. `settled` = decisions that no '
        + 'longer need working out; `landed` = what is already written to disk; `remaining` = what this step '
        + 'still owes (this one REPLACES what was there, so it can shrink); `evidence` = pointers such as a '
        + 'file, a symbol or a command. Call it when you settle something worth not losing.',
      parameters: {
        type: 'object',
        properties: {
          settled: { type: 'array', items: { type: 'string' }, description: 'decisions that are now fixed' },
          landed: { type: 'array', items: { type: 'string' }, description: 'changes already on disk' },
          remaining: { type: 'array', items: { type: 'string' }, description: 'what this step still owes — replaces the previous list' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'pointers: file, symbol, command' },
        },
      },
    },
    async run(input, ctx) {
      const session = sessionOf(ctx);
      if (!session) return { output: 'no session is active', isError: true };
      const plan = session.plan;
      if (!plan || !plan.steps.length) {
        return { output: 'there is no plan — plan_findings records what a STEP established, so write a plan first', isError: true };
      }
      const step = plan.current();
      if (!step) return { output: 'every step in the plan is already done', isError: true };
      const findings = require('../planfindings');
      const rec = findings.record(step, input || {});
      try { session.save(); } catch { /* the record survives in memory either way */ }
      const counts = findings.FIELDS.map((f) => `${f} ${rec[f].length}`).join(' · ');
      return {
        output: `recorded against step ${step.n} (${counts}). This survives compaction and resume — do not re-derive it.`,
        meta: { step: step.n, ...Object.fromEntries(findings.FIELDS.map((f) => [f, rec[f].length])) },
      };
    },
  },

  /**
   * A FINDING the person should know about — structured Core state (supervision.js),
   * turned by Chat into a decision. Blocking findings stop Long Context Phasing.
   * Work beyond the approved plan goes in `adds_work`: it is PROPOSED to the person,
   * never silently added (unless `consequence` says it is a direct consequence).
   */
  report_finding: {
    mutates: false,
    schema: {
      name: 'report_finding',
      description:
        'Report something you found that the person should decide on or know: an architectural choice, a '
        + 'problem outside the step, a risk, or extra work the approved plan did not include. Do not use it '
        + 'for progress narration. If the finding needs work beyond the approved plan, put that work in '
        + 'adds_work — it is proposed to the person, not added; do not start it until approved.',
      parameters: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['info', 'minor', 'major', 'critical'] },
          summary: { type: 'string', description: 'one sentence' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'pointers: file:line, symbol, command output' },
          affected: { type: 'array', items: { type: 'string' }, description: 'plan steps, files or systems affected' },
          possible_fix: { type: 'string' },
          blocking: { type: 'boolean', description: 'true when the plan cannot continue correctly without a decision' },
          adds_work: { type: 'string', description: 'work beyond the approved plan this finding needs' },
          consequence: { type: 'boolean', description: 'true when adds_work is a small direct consequence of the approved plan' },
        },
        required: ['summary'],
      },
    },
    async run(input, ctx) {
      const session = sessionOf(ctx);
      if (!session) return { output: 'no session is active', isError: true };
      const r = require('../supervision').reportFinding(session, input || {}, 'agent');
      if (!r.ok) return { output: r.why, isError: true };
      try { session.save(); } catch { /* recorded in memory */ }
      return { output: `finding recorded (${r.finding.severity}${r.finding.blocking ? ', blocking' : ''}).${r.delta ? (r.delta.state === 'PROPOSED' ? ' The extra work is PROPOSED to the person — do not start it until it is approved.' : ' Added to the plan as a consequence.') : ''}`, meta: { finding: r.finding.id, blocking: r.finding.blocking } };
    },
  },

  plan_step_done: {
    mutates: false,
    schema: {
      name: 'plan_step_done',
      description:
        'Mark the current plan step finished and move to the next. Pass a short note saying what actually '
        + 'happened (what changed, what the check showed) — the note is kept as the record of that step. '
        + 'Only call this once the step is genuinely done.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'what was done, concretely — e.g. "reset failures on success; 5/5 tests pass"' },
        },
        required: ['note'],
      },
    },
    async run(input, ctx) {
      const session = sessionOf(ctx);
      if (!session) return { output: 'no session is active', isError: true };
      const plan = session.plan;
      if (!plan || !plan.steps.length) {
        return { output: 'there is no plan — use plan_write first, or simply continue without one', isError: true };
      }
      const note = String(input.note || '').trim();
      const r = plan.complete(note);
      if (!r) return { output: 'every step in the plan is already done', isError: true };
      // THE CHECKPOINT COMMIT: the step's completion is on disk before the model hears it moved on.
      require('../taskcheckpoint').commit(session, `step ${r.done.n} done`);

      const done = plan.completed.length;
      const total = plan.steps.length;
      if (r.next) {
        return {
          output: `step ${r.done.n} of ${total} done (${done}/${total}). Next: step ${r.next.n} of ${total}: ${r.next.text}`,
          meta: { completed: done, total },
        };
      }
      // The plan is finished. That is NOT the same as the task being complete:
      // App.maybeComplete() still asks the lifecycle, which requires evidence
      // AND a check that is not currently failing.
      //
      // If the check IS failing, say so HERE — in the tool result, where the
      // model will read it on its next step and can act. Reporting it only to
      // the user would mean the one party able to fix it never hears about it.
      const life = session.lifecycle;
      const last = life && life.lastCommand;
      if (last && !last.ok) {
        return {
          output: `step ${r.done.n} done (${done}/${total}) — that was the last step, but the task is NOT complete: `
            + `the last command failed${last.exitCode != null ? ` (exit ${last.exitCode})` : ''}: ${last.command}. `
            + 'Fix what it reported and run it again until it passes.',
          meta: { completed: done, total, finished: true, failingCheck: last.command },
        };
      }
      return {
        output: `step ${r.done.n} done (${done}/${total}) — that was the last step. `
          + 'If anything remains unverified, verify it now rather than stopping here.',
        meta: { completed: done, total, finished: true },
      };
    },
  },
};

module.exports = { tools, MAX_STEPS, MAX_STEP_CHARS };
