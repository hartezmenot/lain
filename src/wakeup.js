'use strict';

/**
 * ONE HIDDEN WAKE-UP FOR AN EXECUTION TURN THAT WENT IDLE (§26–27).
 *
 * The failure: a task that needs execution — a bug fix, a direct tool request,
 * a live diagnostic — gets a reply of prose and nothing else. No tool call, no
 * change, no question, no blocker, no evidence. The turn ends and the task sits
 * there looking answered.
 *
 * WHAT THIS DOES. Exactly once per turn, when the WHOLE turn so far has made no
 * tool call and changed nothing and the reply is neither a question nor a
 * stated blocker, the loop takes one more step with a structural note riding
 * the framed `<lain-context>` tail (never a `role:'user'` message, never in the
 * transcript, never a new turn, never touching the work clock). If the model
 * goes idle a second time the turn ends as `no-progress`, drawn BLOCKED, which
 * is the truth: it stopped, and it said why it did not act or it did not.
 *
 * NOT A JUDGE. The model had already ended its turn on its own; this does not
 * stop anything, it gives the work one chance to continue. It is bounded to one
 * because a loop that re-asks forever is the token burn the project forbids.
 */

const REQUIRES_EXECUTION = new Set(['PROJECT_IMPLEMENTATION', 'DIRECT_TOOL_TASK', 'LIVE_EXTERNAL_DIAGNOSTIC', 'PROJECT_DIAGNOSTIC']);

/** A reply that asks the person something is a decision point, not idleness. */
const ASKS = /\?\s*(?:[`*_)\]"'»]*\s*)$/;
/** A reply naming what stops it is a blocker, not idleness. */
const BLOCKER = /\b(?:blocked|cannot (?:proceed|continue|access|reach|run)|can'?t (?:proceed|continue|access|reach|run)|unable to|need(?:s)? (?:your|you to|a (?:credential|key|token|decision|permission))|permission|not permitted|no access|waiting (?:for|on) you)\b/i;

const MAX_WAKEUPS = 1;

/**
 * PROJECT_IMPLEMENTATION is also the classifier's DEFAULT for anything it does
 * not recognise ("reply with first"), so for the two project classes the
 * request itself must ask for action. DIRECT_TOOL_TASK and
 * LIVE_EXTERNAL_DIAGNOSTIC are positive signals on their own.
 */
const ACTION_RE = /\b(?:fix|repair|patch|implement|add|build|create|write|change|update|edit|refactor|rename|remove|delete|migrate|wire|hook up|install|run|test|debug|diagnose|investigate|find out why|make (?:it|the|a|an|this|that|\w+\.\w+)|set up|configure|upgrade|bump|port|convert|replace|move)\b/i;
const NEEDS_ACTION_WORDS = new Set(['PROJECT_IMPLEMENTATION', 'PROJECT_DIAGNOSTIC']);

/**
 * A NEGATED ACTION IS A CONSTRAINT, NOT A REQUEST. "Do not modify the test
 * file. do not change test/run.js please" matched `change` and `test`, so a
 * correct prose acknowledgement ("I haven't modified test/run.js") was woken
 * and the model, told to act, asked "What feature should I add?" (live,
 * 2026-09-18). The negated clause is removed before looking for an action.
 */
const NEGATED = /\b(?:do\s+not|don'?t|dont|never|without|avoid|no\s+need\s+to|must\s+not|mustn'?t|shouldn'?t|should\s+not)\b[^.,;!?\n]*/gi;
function asksForAction(text) { return ACTION_RE.test(String(text || '').replace(NEGATED, ' ')); }

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

/**
 * What to do when a step ends with no tool calls.
 * @returns {'wake'|'no-progress'|null}
 */
function decide(record, text, { required = false, wakeups = 0, cls = null, smoke = null } = {}) {
  if (!required || !record) return null;
  // The request that started THIS turn must itself ask for action (see ACTION_RE).
  if ((cls === null || NEEDS_ACTION_WORDS.has(cls)) && record.userInput != null && !asksForAction(record.userInput)) return null;
  if ((record.mutations || []).length) {
    // CHANGED, BUT THE FINAL SMOKE HAS NOT PASSED SINCE (finalsmoke.js): one
    // wake-up to run it as the last step. A second idle ends the turn; the
    // strip then says NOT VERIFIED, never DONE.
    const said = String(text || record.text || '').trim();
    if ((smoke === 'MISSING' || smoke === 'FAILED') && wakeups < MAX_WAKEUPS && !(said && (ASKS.test(said.slice(-240)) || BLOCKER.test(said)))) {
      record.wakeFor = smoke === 'FAILED' ? 'smoke-failed' : 'smoke';
      return 'wake';
    }
    return null;
  }
  // A produced artifact (Cowork workbook, document) is the change, even though no project file moved.
  if ((record.actions || []).some((a) => a && a.ok && a.artifact)) return null;
  // The PERSON decided in this turn (ask_user answered) — "keep CommonJS" legitimately needs no change.
  if ((record.actions || []).some((a) => a && a.ok && a.name === 'ask_user')) return null;
  // READING IS NOT FIXING. Live acceptance, 2026-09-18: "Find and fix these
  // bugs" → five reads → "Found both bugs: 1. … 2. …", finish_reason stop, and
  // the strip said ✓ DONE with nothing changed. Tool calls alone excused a
  // turn from this check, so an investigation that stopped short of the change
  // it was asked for was promoted to a finished task. When the request asks
  // for a CHANGE, only a change — or a passing check proving none is needed —
  // ends the turn; reads do not.
  const wantsChange = (cls === null || cls === 'PROJECT_IMPLEMENTATION') && record.userInput != null && asksForChange(record.userInput);
  const checked = (record.actions || []).some(isPassingCheck);
  if (record.toolCalls > 0 && (!wantsChange || checked)) return null;
  const said = String(text || record.text || '').trim();
  if (said && (ASKS.test(said.slice(-240)) || BLOCKER.test(said))) return null;
  return wakeups < MAX_WAKEUPS ? 'wake' : 'no-progress';
}

/** A request for a CHANGE to the project, negated clauses removed (see NEGATED). */
const CHANGE_RE = /\b(?:fix|repair|patch|implement|add|build|create|write|change|update|edit|refactor|rename|remove|delete|migrate|wire|hook up|install|upgrade|bump|port|convert|replace|move)\b/i;
function asksForChange(text) { return CHANGE_RE.test(String(text || '').replace(NEGATED, ' ')); }
/** A passing one of these is evidence that no change was needed. */
const CHECKS = new Set(['run_tests', 'validate']);
/**
 * …and so is a passing TEST COMMAND run through the shell. Live, 2026-09-19:
 * "fix applyDiscount" on code already fixed → read, `npm test` via run_bash
 * (pass), "no bug to fix" — and the turn ended BLOCKED "no-progress", because
 * only the run_tests TOOL counted as a check. Same pattern the activity box
 * uses for TESTING (ui/activitybox.js kindOf).
 */
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
  if (!record || !(record.toolCalls > 0)) return NOTE;
  return '# Runtime state\n'
    + 'The current task is still pending. The request asks for a change, and this turn has changed no file and run no passing check — '
    + 'what you found is not yet the fix. Make the change and verify it with a tool. If something genuinely blocks you, '
    + 'or no change is needed, say exactly why (and run the check that proves it).';
}

/**
 * A TURN THAT CLOSES ON A STATED BLOCKER is not a finished task — the strip says
 * BLOCKED, never DONE (live: 'Blocker: LAIN for Chrome extension is not
 * communicating' drew a green DONE, 2026-09-19). Stricter than BLOCKER above,
 * which only decides whether to nudge: judged on the closing text only.
 */
const STATED_BLOCKER = /\b(?:blocker|blocked(?: by| on)?|cannot proceed|can'?t proceed|unable to (?:proceed|continue|complete|finish))\b|\bI (?:cannot|can'?t|am unable to|was unable to|could not|couldn'?t) (?:proceed|continue|complete|perform|interact|access|reach|do (?:this|that|it))\b/i;
function statesBlocker(text) { const t = String(text || '').trim(); return Boolean(t) && STATED_BLOCKER.test(t.slice(-500)); }

module.exports = { isPassingCheck, NOTE, MAX_WAKEUPS, REQUIRES_EXECUTION, ACTION_RE, asksForAction, asksForChange, requiresExecution, decide, noteFor, statesBlocker };
