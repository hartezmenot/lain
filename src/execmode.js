'use strict';

/** PERMISSION MODES (Simplify S5) — Ask · Accept edits · Plan · Auto, per session, cycled with Shift+Tab and shown in the status line. */

const MODES = Object.freeze(['ASK', 'ACCEPT_EDITS', 'PLAN', 'AUTO']);
const WORD = Object.freeze({ ASK: 'Ask', ACCEPT_EDITS: 'Accept edits', PLAN: 'Plan', AUTO: 'Auto' });

function norm(m) { return require('./permrules').modeName(m); }

/** The session's mode: what the person chose, else the default from their settings (and the project's, if stricter). */
function of(session) {
  const m = session && norm(session.execMode);
  if (m) return m;
  if (!session) return 'AUTO';
  if (!session._defaultMode || session._defaultMode.cwd !== session.cwd) {
    let mode = 'AUTO';
    try { mode = require('./permrules').of(require('./config').load(), session.cwd).defaultMode; } catch { mode = 'AUTO'; }
    session._defaultMode = { cwd: session.cwd, mode };
  }
  return session._defaultMode.mode;
}

function set(session, mode) {
  const m = norm(mode);
  if (!session || !m) return of(session);
  const prev = of(session);
  if (m === 'PLAN' && prev !== 'PLAN') session._modeBeforePlan = prev;   // where an approved plan returns to
  session.execMode = m;
  return m;
}

function cycle(session) {
  return set(session, MODES[(MODES.indexOf(of(session)) + 1) % MODES.length]);
}

/** What actually applies now: AUTO in an untrusted project, with a person there to trust it, is ACCEPT_EDITS. */
function effective(app, session = null) {
  const s = session || (app && app.session);
  const m = of(s);
  if (m !== 'AUTO' || !app || !app.cfg) return m;
  if (!require('./interaction').available(app)) return m;
  return require('./trust').levelOf(app.cfg, s.cwd) === 'TRUSTED' ? m : 'ACCEPT_EDITS';
}

/** Auto as the person's explicit choice (not just the default), in force, with them present: Computer comes with it. */
function autoChosen(app, session = null) {
  const s = session || (app && app.session);
  if (!s || !app) return false;
  const chosen = norm(s.execMode) === 'AUTO' || norm(app.cfg && app.cfg.permissions && app.cfg.permissions.defaultMode) === 'AUTO';
  return chosen && effective(app, s) === 'AUTO' && require('./interaction').available(app);
}

function prefs(session) {
  const profile = require('./profile').of(session);
  return { focus: Boolean(session && session.focus), fast: profile === 'FAST', profile };
}

/** Tools that only read (or whose inner calls are gated on their own), whatever their flag says. */
const ALWAYS_READ = new Set(['plan_write', 'plan_findings', 'plan_step_done', 'report_finding', 'scratch', 'ask_user', 'concept', 'architecture', 'wiring',
  'request_browser', 'request_computer', 'job_status', 'understand', 'engineering_brief', 'review_changes', 'todo_write', 'exit_plan', 'Skill', 'tool_search', 'Agent']);
const SHELLS = /^(shell|run_(bash|powershell|cmd))$/;

function acts(name, tool) {
  if (ALWAYS_READ.has(name)) return false;
  return Boolean(tool && tool.mutates);
}

function computerReads(name, input) {
  const op = String((input && input.op) || '');
  if (name === 'computer_capture') return true;
  if (name === 'computer' && input && input.action) return require('./tools/computerone').reads(input);
  if (name !== 'computer' && name !== 'computer_ui') return false;
  const ops = require('./computer').OPS;
  return Boolean((ops[op] && ops[op].reads) || require('./computercontrol').READ_OPS.has(op));
}

/** read · edit · command · computer · act — what one call would do. */
function kind(name, tool, input, app = null) {
  const i = input || {};
  if (name === 'call_tool') {
    const inner = String(i.name || '');
    if (!inner.includes('/')) return 'read';   // a LAIN tool is gated again by its own execute
    return mcpReadOnly(app, inner.split('/')[0]) ? 'read' : 'act';
  }
  if (!acts(name, tool)) return 'read';
  if (SHELLS.test(name)) return !i.background && require('./readonly').looksOnly(i.command || i.cmd || '') ? 'read' : 'command';
  if (name === 'computer' || /^computer_/.test(name)) return computerReads(name, i) ? 'read' : 'computer';   // computer_ui too
  if (require('./mutation').isSourceMutation(name)) return 'edit';
  return 'act';
}

/** An MCP server the PERSON set to Read-only trust (its own readOnlyHint never counts): mcpreg then runs only its read-only tools. */
function mcpReadOnly(app, id) {
  try {
    const e = require('./integrations').store(app).mcp[id];
    return Boolean(e) && require('./mcpreg').trustOf(e) === 'READ_ONLY';
  } catch { return false; }
}

const PLAN_REFUSAL = 'Plan mode: read-only — investigate, then call exit_plan with the plan.';

/** The mode's verdict on one call, before anything runs. */
async function gate(ctx, name, tool, input) {
  const app = ctx && ctx.app;
  const session = ctx && (ctx.session || (app && app.session));
  const k = kind(name, tool, input, app);
  const cwd = (ctx && ctx.cwd) || (session && session.cwd) || process.cwd();
  const rules = app && app.cfg ? require('./permrules').of(app.cfg, session && session.cwd) : null;
  if (rules) {
    const denied = require('./permrules').first(rules.deny, name, input, cwd);
    if (denied) return { ok: false, output: `Denied by your permission rules: ${denied}` };
  }
  // In AUTO the first computer call turns Computer Control on, a look as much as a click (the desktop still asks).
  if (k === 'read') return /^computer/.test(name) && effective(app, session) === 'AUTO' ? autoComputer(app) : { ok: true };
  const mode = effective(app, session);
  if (mode === 'PLAN') return { ok: false, output: PLAN_REFUSAL };
  if (mode === 'AUTO') return k === 'computer' ? autoComputer(app) : { ok: true };
  if (mode === 'ACCEPT_EDITS' && k === 'edit') return { ok: true };
  if (rules && require('./permrules').first(rules.allow, name, input, cwd)) return { ok: true };
  return askFirst(ctx, name, input, mode);
}

/** AUTO turns Computer Control on at the person's tier (INTERACT by default); the desktop's own authorization still asks. */
async function autoComputer(app) {
  const cc = require('./computercontrol');
  if (!app || cc.enabled(app)) return { ok: true };
  const tier = String((app.cfg && app.cfg.computer && app.cfg.computer.tier) || 'INTERACT').toUpperCase();
  const r = await cc.enable(app, { tier, by: 'auto', ask: true });
  return r.ok ? { ok: true } : { ok: false, output: `Computer Control is off: ${r.why}` };
}

async function askFirst(ctx, name, input, mode) {
  const app = ctx && ctx.app;
  const session = ctx && (ctx.session || (app && app.session));
  if (!app || !require('./interaction').available(app)) {
    return { ok: false, output: `${WORD[mode]} mode: ${name} needs the person's yes and nobody is present to give it.` };
  }
  if (session._manualTurnGrant && session._manualTurnGrant === (ctx.turnId || null)) return { ok: true };
  const target = require('./describe').describeTarget(name, input || {});
  const answer = await require('./decisions').ask(app, {
    type: 'PERMISSION_REQUEST',
    title: `${WORD[mode]} · allow this?`,
    question: `${name}${target ? ` · ${target}` : ''}`,
    options: ['Allow once', 'Allow for this turn', 'Deny'],
  }, ctx && ctx.signal);
  if (answer === 'Allow for this turn') { session._manualTurnGrant = ctx.turnId || null; return { ok: true }; }
  if (answer === 'Allow once') return { ok: true };
  return { ok: false, output: `The person did not allow ${name}. Nothing was changed.` };
}

const GUIDANCE = {
  PLAN: 'Execution mode: PLAN. Discuss, research and refine the plan with the person. Read what you need; do not edit files, run commands or start processes. There is no execution progress yet — the plan is accepted by the person.',
  ASK: 'Execution mode: MANUAL. Inspect freely. Every edit, command or process pauses for the person\'s yes, so batch related changes into one clear step.',
  FOCUS: 'Focus: reuse fresh project intelligence, read receipts and plan findings before re-reading; say only findings, changes, blockers, verification and the result.',
  FAST: 'Fast: deterministic tools first, targeted reads, targeted tests before broad ones, no optional exploration, minimal prose. Never skip required reads, verification or permissions.',
};

/** Legacy prompt guidance: the mode and preferences as one short paragraph, or ''. */
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

/** The quiet label beside the composer: `Auto`, `Plan · FOCUS`, … */
function label(session) {
  const p = prefs(session);
  return [WORD[of(session)], p.focus ? 'FOCUS' : '', require('./profile').label(session)].filter(Boolean).join(' · ');
}

module.exports = { MODES, WORD, of, set, cycle, effective, autoChosen, prefs, acts, kind, gate, guidance, label, GUIDANCE, PLAN_REFUSAL };
