'use strict';

/** TASK LIFECYCLE + LIVENESS. */

const crypto = require('crypto');

/** First-person, future-tense statements of outstanding work. See saysMoreToDo. */
const MORE_TO_DO = [
  /\bI (?:still |now )?(?:need|have) to\b/i,
  /\bI(?:'ll| will| am going to| shall) (?:now |then |next )?(?:run|check|verify|test|inspect|investigate|look|continue|fix|add)\b/i,
  /\bstill (?:needs?|has|have|to be) (?:to )?(?:be )?(?:verif|test|check|run|investigat|fix|done|confirm)/i,
  /\b(?:not|yet to be) (?:yet )?(?:verified|tested|confirmed|checked)\b/i,
  /\blet me (?:now |then )?(?:run|check|verify|test|inspect|look)\b/i,
  /\bnext,? I(?:.ll| will)?\b/i,
];

/** THE MODEL ASKING THE PERSON TO DO SOMETHING. */
const ASKS_USER = [
  /\b(?:now|then|next|please|first)[, ]+(?:go (?:and )?)?(?:press|click|tap|hit|open|close|launch|start|type|enter|move|select|switch|change)\b/i,
  /\b(?:let me know|tell me|report back|say)\s+(?:when|once|after|what)\b/i,
  /\bonce you(?:'ve| have)?\s+(?:done|pressed|clicked|opened|changed|typed)\b/i,
  /\bcan you (?:please )?(?:press|click|open|type|run|check|confirm|tell)\b/i,
];

const STATE = Object.freeze({
  ACTIVE: 'ACTIVE',
  IDLE: 'IDLE',   // the simple path (simple.js): no turn running, nothing judged
  DONE: 'DONE',
  // THE ARBITER'S HONEST ENDINGS (discipline/arbiter.js): finished without the evidence the contract asks for, or
  // finished with explicit asks still open — each said as what it is, never rounded up to DONE.
  DONE_UNVERIFIED: 'DONE_UNVERIFIED',
  PARTIAL: 'PARTIAL',
  BLOCKED: 'BLOCKED',
  NEEDS_USER: 'NEEDS_USER',
  NEEDS_AUTH: 'NEEDS_AUTH',
  FAILED: 'FAILED',
});

const TERMINAL = new Set([STATE.DONE, STATE.DONE_UNVERIFIED, STATE.PARTIAL, STATE.BLOCKED, STATE.NEEDS_USER, STATE.NEEDS_AUTH, STATE.FAILED]);

/** How many unproductive TURNS — narration, no tools, nothing changed — before the task is BLOCKED. */
const NUDGE_BUDGET = 2;

/** A PRINTABLE separator, deliberately. */
const FP_SEP = '|#|';

function fingerprint(name, input, output) {
  const h = crypto.createHash('sha1');
  h.update(String(name));
  h.update(FP_SEP);
  h.update(JSON.stringify(input || {}));
  h.update(FP_SEP);
  h.update(String(output == null ? '' : output).slice(0, 4000));
  return h.digest('hex').slice(0, 16);
}

/** Text that only ANNOUNCES work. Used only alongside a zero-work turn. */
// The adverb slot matters: "I'll now continue" is plainly narration, and without
// it the pattern only matched when the verb followed the pronoun immediately.
const NARRATION_RE = /^\W*(ok(ay)?|right|alright|sure|now|so)?[\s,.:-]*(let me |i'?ll |i am |i'?m |going to |about to |we'?ll )?(now |then |just |also |next |quickly |first |go ahead and )*(continu\w*|resum\w*|pick(ing|ed)? up|proceed\w*|start\w*|look\w*|check\w*|inspect\w*|investigat\w*|trac\w*|dig\w*|gather\w*|work\w* on)\b/i;
const FINDING_RE = /\b(found|because|caused|returns?|fails?|error|missing|null|undefined|line \d+|is set to|root cause|fixed|passes|verified|reproduc)\b/i;

function isNarrationOnly(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 400) return false;
  if (!NARRATION_RE.test(t)) return false;
  return !FINDING_RE.test(t);
}

/** Text that CLAIMS THE WORK SUCCEEDED. */
const SUCCESS_RE = /\b(all (?:the )?tests? (?:now )?pass|tests? (?:are )?passing|tests? affirm|suite is green|successful(?:ly)? (?:implement|complet|fix|updat|appli)|implementation (?:is )?(?:complete|successful)|everything (?:now )?works?|works? (?:correctly|as expected)|(?:is|are) now (?:working|fixed|complete)|verified (?:that )?(?:it|this) works|done[.!]?$)/i;
const NEGATED_RE = /\b(?:do(?:es)?n'?t|do not|does not|not all|fail(?:s|ed|ing)|still (?:broken|failing|red)|cannot|can'?t|unable)\b/i;

function claimsSuccess(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // Judge the CLOSING statement. A trace that mentions a passing test halfway
  // through and then reports a failure is not claiming success.
  const tail = t.slice(-600);
  if (!SUCCESS_RE.test(tail)) return false;
  return !NEGATED_RE.test(tail);
}

class Lifecycle {
  constructor(objective = '') {
    this.objective = String(objective);
    this.state = STATE.ACTIVE;
    this.reason = '';
    this.seen = new Map();      // fingerprint -> count (task-scoped, interleaving-safe)
    this.quiet = new Set();     // fingerprints the user said "let it run" about
    this.nudges = 0;
    this.evidence = {
      filesChanged: new Set(),
      commandsRun: 0,
      toolCalls: 0,
      verifiedChecks: 0,
      userConfirmed: false,
    };
    /** The most recent command this task ran, and whether it succeeded: `{ command, ok, exitCode }` or null. */
    this.lastCommand = null;
    this.blockers = [];
    this.turns = 0;
    // THE TASK'S BELIEF / EVIDENCE STATE — outcome, asks, criteria, CheckState, integrity flags (discipline/).
    this.discipline = new (require('./discipline').Discipline)(objective);
  }

  get isActive() { return this.state === STATE.ACTIVE; }
  get isTerminal() { return TERMINAL.has(this.state); }

  /** The user pushed back / rephrased / steered. That is new information. */
  noteUserInput() {
    this.nudges = 0;
    this.seen.clear();                 // a correction earns an un-prejudiced start
    // AND SO DOES THE ADVISORY.
    this.quiet.clear();
    if (this.state === STATE.BLOCKED || this.state === STATE.NEEDS_USER) {
      this.state = STATE.ACTIVE;
      this.reason = '';
    }
    return this;
  }

  /** Context was compacted. Explicitly not a new task and not progress. */
  noteCompaction() { return this; }

  /** Observe ONE completed tool call. */
  observeTool({ name, input, output, isError = false, mutated = [], exitCode = null, noMatch = false, searchLike = false, denied = false, finalSmoke = false, detached = false }) {
    this.evidence.toolCalls += 1;
    // A CALL REFUSED BEFORE IT RAN (PLAN/MANUAL mode, permission, lease) is no verdict on anything: PLAN refusing `run_tests` closed the turn as "NOT…
    if (/^run_/.test(name) && !denied) {
      this.evidence.commandsRun += 1;
      // Recorded per command, so the LAST one is always the current verdict.
      const raw = String((input && input.command) || name);
      const verdict = require('./evidencekind').classifyCommand({ command: raw, exitCode, isError, noMatch, searchLike });
      this.lastCommand = {
        command: raw.replace(/\s+/g, ' ').slice(0, 120),
        ok: verdict.ok,
        exitCode: exitCode == null ? null : Number(exitCode),
        kind: verdict.kind,
        masked: verdict.masked,
        note: verdict.note || '',
      };
      // A command that ran clean AFTER something was changed is the shape of a verification.
      if (verdict.ok === true && this.evidence.filesChanged.size > 0) this.evidence.verifiedChecks += 1;
    }
    for (const m of mutated) this.evidence.filesChanged.add(m);
    // EVERY CHANGE INVALIDATES A FINAL SMOKE THAT RAN BEFORE IT (finalsmoke.js) — and starts a new GENERATION of
    // evidence: a check observed before it says nothing about the state after it (discipline/checks.js).
    if (mutated.length) this.mutationSeq = (this.mutationSeq || 0) + 1;
    if (this.discipline) {
      const ok = /^run_/.test(name) ? (this.lastCommand ? this.lastCommand.ok : null) : !isError;
      try { this.discipline.observe({ name, input, output, ok, exitCode, gen: this.mutationSeq || 0, changed: [...this.evidence.filesChanged], denied }); } catch { /* evidence bookkeeping never costs a call */ }
    }
    if (finalSmoke && !denied) {
      this.smoke = detached
        ? { ok: null, running: true, seq: this.mutationSeq || 0, command: String((input && input.command) || name), at: Date.now() }
        : { ok: Boolean(this.lastCommand && this.lastCommand.ok === true), running: false, seq: this.mutationSeq || 0, command: String((input && input.command) || name), at: Date.now() };
    }

    const fp = fingerprint(name, input, output);
    const n = (this.seen.get(fp) || 0) + 1;
    this.seen.set(fp, n);

    // A MUTATION IS PROGRESS BY DEFINITION — something on disk is different now — and it also clears the narration ladder `observeTurn` keeps.
    if (mutated.length) { this.nudges = 0; return { repeated: 1, key: fp, isError: Boolean(isError) }; }
    // `repeated` COUNTS OCCURRENCES: 1 is the first sighting, 3 means three
    // identical results. The count the user is shown is this number.
    return { repeated: n, key: fp, isError: Boolean(isError) };
  }

  /** "LET IT RUN" — the user has seen this exact loop and waved it through. */
  letRun(key) {
    if (key) this.quiet.add(String(key));
    return this;
  }

  /** Observe a whole finished TURN. */
  observeTurn({ toolCalls = 0, text = '', mutated = 0 } = {}) {
    this.turns += 1;
    // Any tool work at all means the turn was productive. A closing sentence is
    // how a working turn ENDS — this is the V1 miscount, fixed at the source.
    if (toolCalls > 0 || mutated > 0) { this.nudges = 0; return { productive: true }; }
    if (isNarrationOnly(text)) {
      this.nudges += 1;
      // COUNTED, AND THAT IS ALL IT IS
      return { productive: false, narrationOnly: true, narrations: this.nudges };
    }
    // Substantive prose with no tools is legitimate: answering a question,
    // explaining a design. Not progress on files, not a stall either.
    return { productive: false };
  }

  /** DOES THE MODEL'S CLOSING CLAIM MATCH THE EVIDENCE? */
  contradiction(text) {
    const last = this.lastCommand;
    if (last && last.ok !== true && claimsSuccess(text)) {
      if (last.ok === null) {
        return `The last check does not verify that: ${last.command} — ${last.note || 'its exit code proves nothing about this requirement'}. `
          + 'Run something that actually checks it before treating this as done.';
      }
      return `The last check was still failing when that was written: ${last.command}`
        + `${last.exitCode != null ? ` (exit ${last.exitCode})` : ''}. Run it again before treating this as done.`;
    }
    // CLAIM PROVENANCE: a VERIFIED claim LAIN has no evidence for is downgraded, and the person is told which.
    if (!this.discipline) return null;
    const { extract, crossCheck, DOMAINS } = require('./discipline/claims');
    const active = this.evidence.filesChanged.size > 0 || this.evidence.commandsRun > 0;
    const claims = extract(text).filter((c) => c.type === 'VERIFIED' && (active || DOMAINS.some((d) => d.claim.test(c.text))));
    if (!claims.length) return null;
    const bad = crossCheck(claims, { ledger: this.discipline.checks, gen: this.mutationSeq || 0, changed: [...this.evidence.filesChanged] }).filter((c) => !c.accepted);
    if (!bad.length) return null;
    this.discipline.claims = [...(this.discipline.claims || []), ...bad].slice(-20);
    return `Not verified by LAIN — ${bad.map((c) => `"${c.text.slice(0, 80)}" (${c.why})`).join('; ')}. Treat ${bad.length === 1 ? 'it' : 'them'} as NOT_CHECKED.`;
  }

  noteAuthFailure(provider, detail = '') {
    this.state = STATE.NEEDS_AUTH;
    this.reason = `authentication failed for ${provider}${detail ? ': ' + detail : ''}`;
    this.blockers.push(this.reason);
    return this;
  }

  /** A PROVIDER ANSWERED, SO AN AUTH REFUSAL IS NO LONGER THE STATE. */
  noteProviderAnswered() {
    if (this.state === STATE.NEEDS_AUTH) {
      this.state = STATE.ACTIVE;
      this.reason = '';
    }
    return this;
  }

  needsUser(question) {
    this.state = STATE.NEEDS_USER;
    this.reason = String(question || 'this needs a decision from you');
    return this;
  }

  /** DOES THE MODEL SAY IT STILL HAS WORK? */
  static saysMoreToDo(text) {
    const t = String(text || '');
    return MORE_TO_DO.some((re) => re.test(t));
  }

  /** IS THE MODEL ASKING THE PERSON TO DO SOMETHING? */
  static asksUserToAct(text) {
    const t = String(text || '');
    return ASKS_USER.some((re) => re.test(t));
  }

  fail(why) { this.state = STATE.FAILED; this.reason = String(why || 'failed'); return this; }

  /** COMPLETION REQUIRES EVIDENCE, AND A CHANGE REQUIRES A CHECK. */
  /** A DETACHED FINAL SMOKE REJOINED (/bg). */
  settleSmoke(ok, { command = '', exitCode = null } = {}) {
    if (!this.smoke || !this.smoke.running) return false;
    const current = this.smoke.seq === (this.mutationSeq || 0);
    this.smoke = { ...this.smoke, running: false, ok: Boolean(ok) && current };
    this.lastCommand = { command: String(command || this.smoke.command).slice(0, 120), ok: Boolean(ok), exitCode, kind: 'COMMAND_EXIT_STATUS', masked: false, note: 'background final smoke' };
    this.evidence.commandsRun += 1;
    if (ok && this.evidence.filesChanged.size > 0) this.evidence.verifiedChecks += 1;
    return current;
  }

  /** COMPLETION IS THE ARBITER'S DECISION (discipline/arbiter.js), with verifycontract.js as the single authority on how much proof a change needs. */
  complete({ verified = false, userConfirmed = false, note = '', cwd = null, discretion = 'STRONG', objective = '', changeClass = null } = {}) {
    if (verified) this.evidence.verifiedChecks += 1;
    if (userConfirmed) this.evidence.userConfirmed = true;
    if (this.discipline) {
      const v = require('./discipline/arbiter').evaluate(this, { cwd, discretion, objective: objective || this.objective, changeClass });
      this.discipline.verdict = { state: v.state, why: v.why, at: Date.now() };
      if (!v.ok) return { ok: false, state: this.state, verdict: v.state, why: v.why, ...(v.failedCheck ? { failedCheck: v.failedCheck } : {}), ...(v.unverified ? { unverified: true } : {}), ...(v.smoke ? { smoke: v.smoke } : {}), remaining: v.remaining || [] };
      this.state = STATE.DONE;
      this.reason = note || v.why;
      return { ok: true, state: this.state, verdict: v.state, why: this.reason, level: v.level || null };
    }
    const e = this.evidence;
    const has = e.filesChanged.size > 0 || e.commandsRun > 0 || e.verifiedChecks > 0 || e.userConfirmed;
    if (!has) {
      return { ok: false, state: this.state, why: 'no completion evidence: nothing changed, no command ran, nothing verified' };
    }
    // A RED CHECK IS NOT A FINISHED TASK.
    const last = this.lastCommand;
    // ok false (a real failure) AND ok null (masked/no-match — proves nothing) both block completion; only ok true clears this gate.
    if (last && last.ok !== true && !e.userConfirmed) {
      return {
        ok: false,
        state: this.state,
        why: last.ok === null
          ? `the last command does not verify this: ${last.command}${last.note ? ` — ${last.note}` : ''}`
          : `the last command failed${last.exitCode != null ? ` (exit ${last.exitCode})` : ''}: ${last.command}`,
        failedCheck: last,
      };
    }
    // AN UNVERIFIED CHANGE IS NOT A FINISHED TASK.
    if (e.filesChanged.size > 0 && e.verifiedChecks === 0 && !e.userConfirmed) {
      return {
        ok: false,
        state: this.state,
        why: `${e.filesChanged.size} file(s) changed but nothing has been run to check them`,
        unverified: true,
      };
    }
    // THE FINAL SMOKE IS THE TERMINAL STEP (finalsmoke.js): a changed tree is
    // complete only once the final suite has run AND passed after the last change.
    if (cwd && !e.userConfirmed) {
      const fs = require('./finalsmoke');
      const st = fs.state(this, cwd);
      if (st !== 'NOT_REQUIRED' && st !== 'PASSED') return { ok: false, state: this.state, why: fs.why(st, cwd), smoke: st };
    }
    this.state = STATE.DONE;
    this.reason = note || `${e.filesChanged.size} file(s) changed, ${e.commandsRun} command(s) run`
      + (last && last.ok ? `, last check passed: ${last.command}` : '');
    return { ok: true, state: this.state, why: this.reason };
  }

  summary() {
    return {
      state: this.state,
      reason: this.reason,
      objective: this.objective,
      turns: this.turns,
      toolCalls: this.evidence.toolCalls,
      filesChanged: this.evidence.filesChanged.size,
      commandsRun: this.evidence.commandsRun,
      repeatedObservations: [...this.seen.values()].filter((n) => n > 1).length,
      nudges: this.nudges,
      lastCommand: this.lastCommand,
    };
  }

  toJSON() {
    return {
      objective: this.objective, state: this.state, reason: this.reason,
      nudges: this.nudges, turns: this.turns, blockers: this.blockers,
      lastCommand: this.lastCommand, mutationSeq: this.mutationSeq || 0, smoke: this.smoke || null,
      evidence: { ...this.evidence, filesChanged: [...this.evidence.filesChanged] },
      discipline: this.discipline ? this.discipline.toJSON() : null,
    };
  }

  static from(data) {
    if (!data || typeof data !== 'object') return null;
    const l = new Lifecycle(data.objective);
    l.state = data.state || STATE.ACTIVE;
    l.reason = data.reason || '';
    l.nudges = data.nudges || 0;
    l.turns = data.turns || 0;
    l.blockers = Array.isArray(data.blockers) ? data.blockers : [];
    // Restored so a resumed task cannot complete on the strength of a check
    // that was still failing when the session ended.
    l.lastCommand = data.lastCommand && typeof data.lastCommand === 'object' ? data.lastCommand : null;
    // THE FINAL SMOKE survives a resume too: a restart must not forget that the tree changed after it (finalsmoke.js).
    l.mutationSeq = Number(data.mutationSeq) || 0;
    l.smoke = data.smoke && typeof data.smoke === 'object' ? { ...data.smoke, running: false } : null;
    const e = data.evidence || {};
    l.evidence = {
      filesChanged: new Set(e.filesChanged || []),
      commandsRun: e.commandsRun || 0,
      toolCalls: e.toolCalls || 0,
      verifiedChecks: e.verifiedChecks || 0,
      userConfirmed: Boolean(e.userConfirmed),
    };
    // THE BELIEF / EVIDENCE STATE survives a resume; a session saved before it existed starts one from its objective.
    if (data.discipline) l.discipline = require('./discipline').Discipline.from(data.discipline);
    return l;
  }
}

module.exports = { STATE, TERMINAL, Lifecycle, fingerprint, isNarrationOnly, claimsSuccess, NUDGE_BUDGET };
