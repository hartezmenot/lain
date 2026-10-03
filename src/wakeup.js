'use strict';

/** ONE HIDDEN WAKE-UP FOR AN EXECUTION TURN THAT WENT IDLE (§26–27). */

const REQUIRES_EXECUTION = new Set(['PROJECT_IMPLEMENTATION', 'DIRECT_TOOL_TASK', 'LIVE_EXTERNAL_DIAGNOSTIC', 'PROJECT_DIAGNOSTIC']);

/** A reply that asks the person something is a decision point, not idleness. */
const ASKS = /\?\s*(?:[`*_)\]"'»]*\s*)$/;
/** A reply naming what stops it is a blocker, not idleness. */
const BLOCKER = /\b(?:blocked|cannot (?:proceed|continue|access|reach|run)|can'?t (?:proceed|continue|access|reach|run)|unable to|need(?:s)? (?:your|you to|a (?:credential|key|token|decision|permission))|permission|not permitted|no access|waiting (?:for|on) you)\b/i;

const MAX_WAKEUPS = 1;

/** PROJECT_IMPLEMENTATION is also the classifier's DEFAULT for anything it does not recognise ("reply with first"), so for the two project classes the… */
const ACTION_RE = /\b(?:fix|repair|patch|implement|add|build|create|write|change|update|edit|refactor|rename|remove|delete|migrate|wire|hook up|install|run|test|debug|diagnose|investigate|find out why|make (?:it|the|a|an|this|that|\w+\.\w+)|set up|configure|upgrade|bump|port|convert|replace|move)\b/i;
const NEEDS_ACTION_WORDS = new Set(['PROJECT_IMPLEMENTATION', 'PROJECT_DIAGNOSTIC']);

/** A NEGATED ACTION IS A CONSTRAINT, NOT A REQUEST. */
const NEGATED = /\b(?:do\s+not|don'?t|dont|never|without|avoid|no\s+need\s+to|must\s+not|mustn'?t|shouldn'?t|should\s+not)\b[^.,;!?\n]*/gi;
/** …AND A NEGATED LIST IS A LIST OF CONSTRAINTS. */
const NEGATION_HEADER = /^\W{0,3}(?:do\s+not|don'?t|dont|never|avoid|must\s+not|mustn'?t|should\s+not|shouldn'?t)\b[^.!?\n]{0,60}:\s*$/i;
const LIST_ITEM = /^(?:[-*•+]|\d+[.)])\s+/;
function stripNegated(text) {
  const out = [];
  let inList = false;
  let items = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (inList) {
      if (!t) { if (items) inList = false; out.push(''); continue; }
      if (LIST_ITEM.test(t)) { items += 1; out.push(''); continue; }
      inList = false;
    }
    if (NEGATION_HEADER.test(t)) { inList = true; items = 0; out.push(''); continue; }
    out.push(line);
  }
  return out.join('\n').replace(NEGATED, ' ');
}
function asksForAction(text) { return ACTION_RE.test(stripNegated(text)); }

const NOTE = '# Runtime state\n'
  + 'The current task is still pending. The last step produced text only: no tool call, no change, '
  + 'no verification, no question and no stated blocker. Continue from the current state and take the next '
  + 'concrete action with a tool. If something genuinely blocks you, name it exactly instead.';

/** Does this turn's work need tools at all? Decided from the class and the mode, never from the reply. */
function requiresExecution({ taskClass = null, execMode = 'AUTO', readOnly = false, request = null } = {}) {
  if (readOnly || execMode === 'PLAN') return false;
  if (!taskClass || !REQUIRES_EXECUTION.has(taskClass)) return false;
  if (NEEDS_ACTION_WORDS.has(taskClass) && request != null && !asksForAction(request)) return false;
  return true;
}

/** What to do when a step ends with no tool calls. */
function decide(record, text, { required = false, wakeups = 0, cls = null, smoke = null, readOnly = false } = {}) {
  if (!required || !record) return null;
  // A DECLARED READ-ONLY TASK (readonly.js) is decided here, whole: it ends with its REPORT (or a named gap) — never with silence, and never with "I…
  if (readOnly) {
    const said = String(text || record.text || '').trim();
    if (said && !REFUSES_FOR_WRITES.test(said)) return null;
    record.wakeFor = said ? 'readonly-refusal' : 'report';
    return wakeups < MAX_WAKEUPS ? 'wake' : 'no-progress';
  }
  // The request that started THIS turn must itself ask for action (see ACTION_RE).
  if ((cls === null || NEEDS_ACTION_WORDS.has(cls)) && record.userInput != null && !asksForAction(record.userInput)) return null;
  if ((record.mutations || []).length) {
    // CHANGED, BUT THE FINAL SMOKE HAS NOT PASSED SINCE (finalsmoke.js): one wake-up to run it as the last step.
    const said = String(text || record.text || '').trim();
    if (smoke === 'MISSING' && wakeups < MAX_WAKEUPS && !(said && (ASKS.test(said.slice(-240)) || BLOCKER.test(said)))) {
      record.wakeFor = 'smoke';
      return 'wake';
    }
    return null;
  }
  // A produced artifact (Cowork workbook, document) is the change, even though no project file moved.
  if ((record.actions || []).some((a) => a && a.ok && a.artifact)) return null;
  // The PERSON decided in this turn (ask_user answered) — "keep CommonJS" legitimately needs no change.
  if ((record.actions || []).some((a) => a && a.ok && a.name === 'ask_user')) return null;
  // READING IS NOT FIXING.
  const wantsChange = (cls === null || cls === 'PROJECT_IMPLEMENTATION') && record.userInput != null && asksForChange(record.userInput);
  const checked = (record.actions || []).some(isPassingCheck);
  const said = String(text || record.text || '').trim();
  // AN EMPTY CLOSING REPLY IS NOT AN ANSWER.
  if (!said && wantsChange) { record.wakeFor = 'empty'; return wakeups < MAX_WAKEUPS ? 'wake' : 'no-progress'; }
  if (record.toolCalls > 0 && (!wantsChange || checked)) return null;
  if (said && (ASKS.test(said.slice(-240)) || BLOCKER.test(said))) return null;
  return wakeups < MAX_WAKEUPS ? 'wake' : 'no-progress';
}

/** "I can't fulfil / proceed with this because it requires code changes" — a refusal on the grounds that writing is not allowed. */
const REFUSES_FOR_WRITES = /\b(?:can(?:no|')t|cannot|unable to|not able to|won'?t be able to)\b[^.\n]{0,60}\b(?:fulfil+|proceed|comply|complete|implement|modify|make (?:the |any )?(?:code )?changes?|change (?:the )?code|help with (?:that|this))\b|\b(?:requires?|would require) (?:making )?(?:code )?(?:changes|modifications)\b/i;

/** A request for a CHANGE to the project, negated clauses removed (see NEGATED). */
// `port` only as the verb ("port this to Rust") — "confirm the port is free" asks nothing to change.
const CHANGE_RE = /\b(?:fix|repair|patch|implement|add|build|create|write|change|update|edit|refactor|rename|remove|delete|migrate|wire|hook up|install|upgrade|bump|port\s+(?:\S+\s+){1,3}(?:to|from)|convert|replace|move)\b/i;
function asksForChange(text) { return CHANGE_RE.test(stripNegated(text)); }
/** A passing one of these is evidence that no change was needed. */
const CHECKS = new Set(['run_tests', 'validate']);
/** …and so is a passing TEST COMMAND run through the shell. */
const SHELL = /^(?:run_bash|run_powershell|run_cmd|run_command|process_run)$/;
const TEST_CMD = /\b(?:test|tests|jest|pytest|vitest|mocha|cargo test|go test|npm (?:run )?test|tsc|typecheck|lint)\b/i;
function isPassingCheck(a) {
  if (!a || !a.ok || a.denied) return false;
  return CHECKS.has(a.name) || (SHELL.test(a.name) && TEST_CMD.test(String(a.target || '')));
}

/** The note for THIS idle: nothing done at all, or investigated without the asked-for change. */
function noteFor(record) {
  if (record && record.wakeFor === 'smoke') {
    return '# Runtime state\nThe task changed files and the FINAL SMOKE has not run since the last change. Run it now as the last execution step '
      + '(see "Final smoke" above). Do not change anything after it passes. If something blocks it, say exactly what.';
  }
  if (record && record.wakeFor === 'smoke-failed') {
    return '# Runtime state\nThe FINAL SMOKE failed. Repair the reopened step (the failing test result names it), run that step\'s targeted test, '
      + 'then run the final smoke again as the last step. Completed steps stand; do not redo them.';
  }
  if (record && (record.wakeFor === 'report' || record.wakeFor === 'readonly-refusal')) {
    return '# Runtime state\nThis task is READ-ONLY and nothing is to be changed — no modification was requested, so none is missing. '
      + 'It is finished by its report: continue the investigation with the read tools if evidence is still needed, then report what you found '
      + 'from the evidence gathered. If something genuinely cannot be established, say exactly what remains unknown.';
  }
  if (record && record.wakeFor === 'empty') {
    return '# Runtime state\nThe last step ended with no answer and no tool call. The task is still pending and no file has been changed. '
      + 'Take the next concrete action with a tool call. If something genuinely blocks you, or no change is needed, say exactly why.';
  }
  if (!record || !(record.toolCalls > 0)) return NOTE;
  return '# Runtime state\n'
    + 'The current task is still pending. The request asks for a change, and this turn has changed no file and run no passing check — '
    + 'what you found is not yet the fix. Make the change and verify it with a tool. If something genuinely blocks you, '
    + 'or no change is needed, say exactly why (and run the check that proves it).';
}

/** A TURN THAT CLOSES ON A STATED BLOCKER is not a finished task — the strip says BLOCKED, never DONE */
const STATED_BLOCKER = /\b(?:blocker|blocked(?: by| on)?|cannot proceed|can'?t proceed|unable to (?:proceed|continue|complete|finish))\b|\bI (?:cannot|can'?t|am unable to|was unable to|could not|couldn'?t) (?:proceed|continue|complete|perform|interact|access|reach|do (?:this|that|it))\b/i;
function statesBlocker(text) { const t = String(text || '').trim(); return Boolean(t) && STATED_BLOCKER.test(t.slice(-500)); }

module.exports = { stripNegated, isPassingCheck, NOTE, MAX_WAKEUPS, REQUIRES_EXECUTION, ACTION_RE, asksForAction, asksForChange, requiresExecution, decide, noteFor, statesBlocker };
