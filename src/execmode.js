'use strict';

/**
 * AUTO · MANUAL · PLAN — the session's execution mode (§11–12), cycled with
 * Shift+Tab and shown quietly beside the composer.
 *
 *   AUTO    inspect, edit and test within the ordinary permissions
 *   MANUAL  inspect freely; every mutation or command stops for a yes
 *   PLAN    discuss, research, plan — nothing is changed or executed
 *
 * ONE STRUCTURAL GATE, in tools/index.execute, the door every call uses; the
 * prompt is told the mode too, but the prompt is advice and this is the lane.
 *
 * FOCUS and FAST are PRESENTATION/EXECUTION PREFERENCES on the same session
 * (§9, §14). They never create another runtime and never skip verification,
 * required reads or permissions — they change guidance and what is drawn.
 */

const MODES = Object.freeze(['AUTO', 'MANUAL', 'PLAN']);

function of(session) {
  const m = session && session.execMode;
  return MODES.includes(m) ? m : 'AUTO';
}

function set(session, mode) {
  const m = String(mode || '').toUpperCase();
  if (!session || !MODES.includes(m)) return of(session);
  session.execMode = m;
  return m;
}

function cycle(session) {
  return set(session, MODES[(MODES.indexOf(of(session)) + 1) % MODES.length]);
}

function prefs(session) {
  // The EXECUTION PROFILE (FAST/NORMAL/ECO) is its own axis — profile.js. The fast boolean stays for older readers.
  const profile = require('./profile').of(session);
  return { focus: Boolean(session && session.focus), fast: profile === 'FAST', profile };
}

/** Tools that only read, even though a mutating flag might suggest otherwise. */
const ALWAYS_READ = new Set(['plan_write', 'plan_findings', 'plan_step_done', 'report_finding', 'scratch', 'ask_user', 'concept', 'architecture', 'wiring',
  'request_browser', 'request_computer', 'job_status', 'job_wait', 'understand', 'engineering_brief', 'review_changes']);

/** Does this call change the machine: a write, a command, a process? */
function acts(name, tool) {
  if (ALWAYS_READ.has(name)) return false;
  return Boolean(tool && tool.mutates);
}

/**
 * The mode's verdict on one call, before anything runs.
 * @returns {Promise<{ok:true}|{ok:false,output:string}>}
 */
async function gate(ctx, name, tool, input) {
  const session = ctx && (ctx.session || (ctx.app && ctx.app.session));
  const mode = of(session);
  if (mode === 'AUTO' || !acts(name, tool)) return { ok: true };
  if (ctx && ctx.workOrder && ctx.workOrder.bounded) return { ok: true };   // a subagent's lane is its order
  if (mode === 'PLAN') {
    return { ok: false, output: `DENIED PLAN_MODE: ${name} would change or execute something, and PLAN mode only discusses and plans. `
      + 'Describe it in the plan; the person accepts the plan (/plan accept) or switches to AUTO (Shift+Tab) to execute.' };
  }
  // MANUAL: stop at the boundary and ask, through the one decision seam.
  const app = ctx && ctx.app;
  if (!app || !require('./interaction').available(app)) {
    return { ok: false, output: `DENIED MANUAL_MODE: ${name} needs the person's yes in MANUAL mode and nobody is present to give it.` };
  }
  if (session._manualTurnGrant && session._manualTurnGrant === (ctx.turnId || null)) return { ok: true };
  const target = require('./describe').describeTarget(name, input || {});
  const answer = await require('./decisions').ask(app, {
    type: 'PERMISSION_REQUEST',
    title: 'MANUAL · allow this step?',
    question: `${name}${target ? ` · ${target}` : ''}`,
    options: ['Allow once', 'Allow for this turn', 'Deny'],
  }, ctx && ctx.signal);
  if (answer === 'Allow for this turn') { session._manualTurnGrant = ctx.turnId || null; return { ok: true }; }
  if (answer === 'Allow once') return { ok: true };
  return { ok: false, output: `DENIED MANUAL_MODE: the person did not allow ${name}. Nothing was changed.` };
}

const GUIDANCE = {
  PLAN: 'Execution mode: PLAN. Discuss, research and refine the plan with the person. Read what you need; do not edit files, run commands or start processes. There is no execution progress yet — the plan is not accepted.',
  MANUAL: 'Execution mode: MANUAL. Inspect freely. Every edit, command or process pauses for the person\'s yes, so batch related changes into one clear step.',
  FOCUS: 'Focus: reuse fresh project intelligence, read receipts and plan findings before re-reading; say only findings, changes, blockers, verification and the result.',
  FAST: 'Fast: deterministic tools first, targeted reads, targeted tests before broad ones, no optional exploration, minimal prose. Never skip required reads, verification or permissions.',
};

/** The mode and preferences as one short framed-context paragraph, or ''. */
function guidance(session) {
  const out = [];
  const mode = of(session);
  if (GUIDANCE[mode]) out.push(GUIDANCE[mode]);
  const p = prefs(session);
  if (p.focus) out.push(GUIDANCE.FOCUS);
  const prof = require('./profile').guidance(session);
  if (prof) out.push(prof);
  return out.length ? `# Working mode\n${out.join('\n')}` : '';
}

/** The quiet label beside the composer: `AUTO`, `PLAN · FOCUS`, … */
function label(session) {
  const p = prefs(session);
  return [of(session), p.focus ? 'FOCUS' : '', require('./profile').label(session)].filter(Boolean).join(' · ');
}

module.exports = { MODES, of, set, cycle, prefs, acts, gate, guidance, label, GUIDANCE };
