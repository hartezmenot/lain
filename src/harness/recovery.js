'use strict';

/** THE RECOVERY ENGINE — what to do about a failure, decided from its KIND. */

const execution = require('../execution');

const KIND = Object.freeze({
  TRANSIENT: 'TRANSIENT',
  ENVIRONMENTAL: 'ENVIRONMENTAL',
  PERMISSION: 'PERMISSION',
  LOGICAL: 'LOGICAL',
  UNKNOWN: 'UNKNOWN',
});

const ACTION = Object.freeze({
  RETRY: 'RETRY',
  DIAGNOSE: 'DIAGNOSE',
  REQUEST_APPROVAL: 'REQUEST_APPROVAL',
  REPLAN: 'REPLAN',
  ESCALATE: 'ESCALATE',
});

/** One retry per distinct failure. A second identical failure is information. */
const RETRY_BUDGET = 1;
/** Long enough for a port to finish closing; short enough not to be a wait. */
const RETRY_AFTER_MS = 750;

/** WHAT KIND OF FAILURE IS THIS? */
const TRANSIENT_SIGNS = [
  /\bECONNRESET\b/i, /\bEPIPE\b/i, /\bEAGAIN\b/i, /\bEBUSY\b/i, /\bETIMEDOUT\b/i,
  /\bsocket hang up\b/i, /temporarily unavailable/i, /\block(ed)? by another process\b/i,
  /address already in use/i,
];
const ENVIRONMENTAL_SIGNS = [
  /\bENOENT\b/i, /not recognized as an internal or external command/i,
  /command not found/i, /No such file or directory/i, /is not installed/i,
  /ModuleNotFoundError/i, /Cannot find module/i, /no browser is listening/i,
  /no browser binary was found/i, /has no global WebSocket/i,
];
const PERMISSION_SIGNS = [
  /\bEACCES\b/i, /\bEPERM\b/i, /permission denied/i, /access is denied/i,
  /requires elevation/i, /not authorized/i, /\brefused by the user\b/i,
  /PERMISSION_REQUIRED/, /\bREFUSED\b/,
];
const LOGICAL_SIGNS = [
  /assertion/i, /\bAssertionError\b/, /test(s)? failed/i, /\bSyntaxError\b/,
  /\bTypeError\b/, /\bReferenceError\b/, /did not contain/i, /expected .* (but )?(got|received)/i,
];

const BY_CLASS = Object.freeze({
  [execution.CLASS.COMMAND_NOT_FOUND]: KIND.ENVIRONMENTAL,
  [execution.CLASS.SHELL_MISSING]: KIND.ENVIRONMENTAL,
  [execution.CLASS.DEPENDENCY_MISSING]: KIND.ENVIRONMENTAL,
  [execution.CLASS.NO_SUCH_PATH]: KIND.ENVIRONMENTAL,
  [execution.CLASS.PERMISSION_DENIED]: KIND.PERMISSION,
  [execution.CLASS.TIMED_OUT]: KIND.TRANSIENT,
  [execution.CLASS.INTERRUPTED]: KIND.TRANSIENT,
  [execution.CLASS.SOURCE_ERROR]: KIND.LOGICAL,
  [execution.CLASS.SHELL_SYNTAX]: KIND.LOGICAL,
  [execution.CLASS.APPLICATION_ERROR]: KIND.LOGICAL,
});

function matches(list, text) { return list.some((re) => re.test(text)); }

function classify(failure = {}) {
  const cls = failure.classification;
  if (cls && BY_CLASS[cls]) {
    return { kind: BY_CLASS[cls], why: `the execution layer classified this as ${cls}` };
  }
  if (failure.timedOut) return { kind: KIND.TRANSIENT, why: 'it timed out, which may or may not repeat' };
  if (failure.interrupted) return { kind: KIND.TRANSIENT, why: 'it was interrupted before it finished' };
  const text = `${failure.error || ''}\n${failure.output || ''}`;
  // PERMISSION IS TESTED BEFORE ENVIRONMENTAL because "access is denied" on Windows is often reported for a path that also does not exist, and routing a…
  if (matches(PERMISSION_SIGNS, text)) return { kind: KIND.PERMISSION, why: 'it was refused' };
  if (matches(ENVIRONMENTAL_SIGNS, text)) return { kind: KIND.ENVIRONMENTAL, why: 'something this machine needs is absent' };
  if (matches(TRANSIENT_SIGNS, text)) return { kind: KIND.TRANSIENT, why: 'the error is one that commonly clears on its own' };
  if (matches(LOGICAL_SIGNS, text)) return { kind: KIND.LOGICAL, why: 'the program ran and was wrong' };
  if (failure.exitCode != null && Number(failure.exitCode) !== 0) {
    return { kind: KIND.LOGICAL, why: `it exited ${failure.exitCode} with nothing that names a machine problem` };
  }
  return { kind: KIND.UNKNOWN, why: 'nothing in the failure identifies its kind' };
}

/** THE LEDGER. What has already failed, how, and how often. */
class Attempts {
  constructor() { this._seen = new Map(); }

  key(operation, kind) { return `${String(operation || 'operation')}::${kind}`; }

  count(operation, kind) { return this._seen.get(this.key(operation, kind)) || 0; }

  record(operation, kind) {
    const k = this.key(operation, kind);
    const n = (this._seen.get(k) || 0) + 1;
    this._seen.set(k, n);
    return n;
  }

  clear() { this._seen.clear(); }
}

/** WHAT SHOULD HAPPEN NEXT. */
function recommend(failure = {}, { operation = '', attempts = null } = {}) {
  const { kind, why } = classify(failure);
  const ledger = attempts || new Attempts();
  const attempt = ledger.record(operation, kind);

  if (kind === KIND.PERMISSION) {
    return {
      kind, attempt, action: ACTION.REQUEST_APPROVAL, retryAfterMs: 0,
      why: `${why} — this needs consent, and working around a refusal is never the answer`,
    };
  }
  if (kind === KIND.ENVIRONMENTAL) {
    return {
      kind, attempt, action: ACTION.DIAGNOSE, retryAfterMs: 0,
      why: `${why} — running it again cannot install it, so the next move is to find out what is missing`,
    };
  }
  if (kind === KIND.LOGICAL) {
    return {
      kind, attempt, action: ACTION.REPLAN, retryAfterMs: 0,
      why: `${why} — the same input will produce the same output, so something has to change first`,
    };
  }
  if (kind === KIND.TRANSIENT) {
    if (attempt <= RETRY_BUDGET) {
      return {
        kind, attempt, action: ACTION.RETRY, retryAfterMs: RETRY_AFTER_MS,
        why: `${why} — worth exactly one more attempt`,
      };
    }
    return {
      kind, attempt, action: ACTION.DIAGNOSE, retryAfterMs: 0,
      why: 'this failed the same way twice, so it is not transient after all — treat it as an environment problem',
    };
  }
  return {
    kind, attempt, action: attempt <= RETRY_BUDGET ? ACTION.RETRY : ACTION.ESCALATE, retryAfterMs: RETRY_AFTER_MS,
    why: attempt <= RETRY_BUDGET
      ? `${why} — one attempt is cheap and settles whether it repeats`
      : 'an unidentifiable failure that repeats is not something to keep guessing at',
  };
}

/** THE SENTENCE A MODEL OR A PERSON READS. */
function explain(verdict) {
  return `${verdict.kind}: ${verdict.why}  [next: ${verdict.action}]`;
}

module.exports = { classify, recommend, explain, Attempts, KIND, ACTION, BY_CLASS, RETRY_BUDGET, RETRY_AFTER_MS };
