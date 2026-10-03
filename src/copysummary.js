'use strict';

/** WHAT A PERSON ACTUALLY PASTES SOMEWHERE ELSE — the task summary, and the diagnostic context. */

const MAX_ANSWER = 4000;
const MAX_TOOL_RESULT = 2000;
const MAX_STEER = 400;

/** The turn a summary is about: the most recent one that a person started. */
function initiatingTurn(session) {
  const turns = (session && session.turns) || [];
  for (let i = turns.length - 1; i >= 0; i--) {
    // A CONTINUATION IS NOT AN INITIATION.
    if (!turns[i].from || turns[i].from === 'user' || turns[i].typed) return turns[i];
  }
  return turns[turns.length - 1] || null;
}

/** Every turn from the initiating one to the end — the span a task occupies. */
function turnSpan(session) {
  const turns = (session && session.turns) || [];
  const start = initiatingTurn(session);
  if (!start) return [];
  const i = turns.indexOf(start);
  return i < 0 ? turns.slice(-1) : turns.slice(i);
}

function trim(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more characters)` : t;
}

/** THE PUBLIC TEXT OF A RECORD, OR NOTHING AT ALL. */
const TEXT_KEYS = ['text', 'message', 'content', 'value'];

function publicText(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string') return entry.trim();
  if (typeof entry === 'number' || typeof entry === 'boolean') return String(entry);
  if (Array.isArray(entry)) {
    // An array of parts: keep the textual ones, drop the rest.
    return entry.map(publicText).filter(Boolean).join(' ').trim();
  }
  if (typeof entry !== 'object') return '';
  for (const k of TEXT_KEYS) {
    const v = entry[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    // One level of nesting only — `{ text: { text: … } }` happens; deeper is
    // a structure nobody meant to be read as a sentence.
    if (v && typeof v === 'object' && typeof v.text === 'string' && v.text.trim()) return v.text.trim();
  }
  return '';
}

/** Files this session changed, from the ledger that already tracks them. */
function changed(app) {
  try {
    return require('./ui/panes').changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd }) || [];
  } catch { return []; }
}

/** WHAT WAS PROVED, from the Harness rather than from anything the model said. */
function verification(app) {
  const out = [];
  try {
    const harness = require('./harnesslink').existing(app);
    const task = harness && harness.runtime && typeof harness.runtime.latest === 'function'
      ? harness.runtime.latest() : null;
    for (const v of (task && task.verifications ? task.verifications : []).slice(-4)) {
      out.push(`${v.verdict || 'UNKNOWN'}  ${v.why || ''}`.trim());
    }
  } catch { /* no harness in this session */ }
  try {
    const last = app.session.lifecycle && app.session.lifecycle.lastCommand;
    if (last && last.command) {
      out.push(`${last.ok === false ? 'FAILED' : 'PASSED'}  ${last.command}`);
    }
  } catch { /* no lifecycle */ }
  return out;
}

/** What is still outstanding — plan steps and the completion gate's reason. */
function remaining(app) {
  const out = [];
  const plan = app.session.plan;
  if (plan && Array.isArray(plan.steps)) {
    for (const s of plan.steps) {
      if (s.status !== 'done' && s.status !== 'DONE') out.push(`[${s.status}] ${s.text}`);
    }
  }
  if (app.pendingCompletion) out.push(String(app.pendingCompletion));
  return out;
}

/** What this project itself says would run it. Derived, never guessed. */
function howToRun(app) {
  try {
    const profile = require('./harness/profile').forProject(app.session.cwd || process.cwd());
    return profile && !profile.empty ? (profile.found || []) : [];
  } catch { return []; }
}

/** `/copy` — THE TASK SUMMARY. */
function summary(app) {
  const s = app.session;
  const start = initiatingTurn(s);
  const span = turnSpan(s);
  if (!start && !(s.task && s.task.objective)) return null;

  const out = [];
  const section = (title, lines) => {
    const rows = (Array.isArray(lines) ? lines : [lines]).filter((l) => String(l || '').trim());
    if (!rows.length) return;
    if (out.length) out.push('');
    out.push(title, ...rows);
  };

  section('USER REQUEST', trim((start && start.userInput) || (s.task && s.task.objective) || '', 1500));

  // MID-TURN CORRECTIONS ARE PART OF THE REQUEST.
  const steers = [];
  for (const t of span) {
    for (const st of (t.steerTexts || [])) {
      // A RECORD, NOT A STRING — see publicText. One with no public text is
      // internal and is omitted rather than rendered as [object Object].
      const said = publicText(st);
      if (said) steers.push(`⚑ ${trim(said, MAX_STEER)}`);
    }
  }
  section('STEERS', steers.slice(-6));

  // THE RESULT IS THE LAST THING LAIN SAID, not a digest of everything it said.
  const answers = span.map((t) => t.text).filter((x) => String(x || '').trim());
  section('RESULT', trim(answers[answers.length - 1] || '', MAX_ANSWER));

  const files = changed(app);
  section('CHANGED', files.map((f) => `${f.rel}  ${f.kind}  +${f.added} -${f.removed}`));

  section('VERIFICATION', verification(app));
  section('REMAINING', remaining(app));
  section('HOW TO RUN', howToRun(app));

  // A TURN THAT DID NOT FINISH SAYS SO. Reporting a cut-short turn's answer
  // as a plain RESULT is the one way this summary could actively mislead.
  const last = span[span.length - 1];
  if (last && last.stopReason && last.stopReason !== 'end') {
    section('NOTE', `the last turn ended early: ${last.stopReason}`);
  }
  return out.length ? out.join('\n') : null;
}

/** `/copy context` — THE DIAGNOSTIC EXPORT. */
function context(app, { all = false } = {}) {
  const s = app.session;
  const span = all ? ((s.turns || []).slice()) : turnSpan(s);
  if (!span.length) return null;

  const out = [];
  const push = (head, body) => {
    const text = trim(body, MAX_ANSWER);
    if (!text) return;
    if (out.length) out.push('');
    out.push(head, text);
  };

  out.push(`# LAIN diagnostic context — ${span.length} turn(s)`);
  if (s.cwd) out.push(`# project: ${s.cwd}`);
  if (s.task && s.task.objective) out.push(`# objective: ${trim(s.task.objective, 300)}`);

  for (const t of span) {
    // The person's words first, because they are what everything after is a response to.
    const who = t.from && t.from !== 'user' && !t.typed ? `USER (via ${t.from})` : 'USER';
    push(who, t.userInput);

    for (const st of (t.steerTexts || [])) {
      const said = publicText(st);
      if (said) push('USER (mid-turn)', said);
    }

    // WHAT THE TOOLS DID. Summaries, not bodies: an `actions` entry already carries the shape a diagnosis needs — which tool, on what, and what came back…
    for (const a of (t.actions || [])) {
      const label = [a.verb || a.tool, a.target].filter(Boolean).join(' ');
      const detail = a.summary || a.detail || a.result || '';
      if (!label && !detail) continue;
      push('TOOL', `${label}${detail ? `\n${trim(detail, MAX_TOOL_RESULT)}` : ''}`);
    }

    for (const e of (t.errors || [])) push('ERROR', typeof e === 'string' ? e : (e.message || JSON.stringify(e)));

    // AND WHAT LAIN SAID IN PUBLIC. `t.reasoning` is deliberately not read
    // here or anywhere in this file — see the header.
    push('LAIN', t.text);

    if (t.stopReason && t.stopReason !== 'end') push('LAIN (turn ended early)', String(t.stopReason));
  }
  return out.join('\n');
}

module.exports = { summary, context, publicText, initiatingTurn, turnSpan, changed, verification, remaining, howToRun };
