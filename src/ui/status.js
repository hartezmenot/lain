'use strict';

/** THE LLM STATUS STRIP — the row (or three) immediately above the INPUT box. */

const T = require('./text');
const { P, ACTOR, paintActor } = require('./paint');
// THE FIGURES ON THE ROW live next door — see ui/telemetry.js. Re-exported below,
// because /copy and the tests have always imported them from here.
const { tok, tokens, mmss, clockAt } = require('./telemetry');

/** WHO IS ACTING, in its own column. */
const ACTOR_COL = 9;
/** Below this the actor is abbreviated; it is never dropped. */
const ACTOR_FULL_WIDTH = 56;

/** Which verb a tool call deserves in the strip. */
const VERB = {
  write_file: 'WRITING', edit_file: 'WRITING',
  read_file: 'READING', list_dir: 'READING',
  grep: 'SEARCHING', glob: 'SEARCHING',
  run_bash: 'RUNNING', run_powershell: 'RUNNING', run_cmd: 'RUNNING',
  plan_write: 'PLANNING', plan_step_done: 'PLANNING',
  // ASKING, not WAITING.
  ask_user: 'ASKING USER',
  // AN MCP ACTION IS NOT "RUNNING".
  computer: 'RUNNING MCP',
  // THE HARNESS TOOLS GET THE WORDS THE HARNESS ALREADY USES
  verify_task: 'VERIFYING',
  observe: 'OBSERVING',
  // A SERVICE IS STARTED, NOT RUN.
  service_start: 'STARTING',
  // AND CHECKING ONE IS A QUESTION, not an execution — it is the step that
  // replaced `sleep 5 && hope`.
  service_check: 'CHECKING',
  // NO IMPLEMENTATION WORDS ON SCREEN (2026-10-01): `job_wait` is how a model collects a background shell, and to a
  // person that is "waiting for the shell". run_background starts one; observe_* is a monitor.
  job_wait: 'WAITING FOR SHELL', job_status: 'CHECKING SHELL', job_stop: 'STOPPING SHELL', run_background: 'STARTING SHELL',
  observe_start: 'STARTING MONITOR', observe_stop: 'STOPPING MONITOR', delegate: 'STARTING AGENT',
  run_tests: 'TESTING', verify_task: 'VERIFYING',
};

/** How much of a provider's own error text a single row will carry. */
const MAX_DETAIL = 160;

const SPIN = ['◐', '◓', '◑', '◒'];

/** Why a turn ended, in the words the strip uses. */
/** AND IN ONE WORD. Every reason but `aborted` used to rest on `INTERRUPTED`, which tells somebody they stopped a turn they never touched, and hides a… */
/** `blocked` IS NO LONGER PRODUCED, and is kept deliberately. */
const STOPPED_WORD = {
  aborted: 'STOPPED',
  'max-steps': 'STEP LIMIT',
  blocked: 'BLOCKED',
  provider: 'FAILED',
  'no-credential': 'NOT AUTHENTICATED',
  'no-progress': 'BLOCKED',
  length: 'CUT OFF',
  refused: 'MODEL REFUSED',
  crashed: 'INTERRUPTED',
};

const STOPPED_BECAUSE = {
  // YOUR limit, not LAIN's — the default is no limit at all.
  'max-steps': 'the step limit you configured was reached',
  aborted: 'you stopped it',
  provider: 'the provider stopped answering',
  'no-progress': 'no change and no passing check, even after one wake-up — the task is still pending',
  blocked: 'no new evidence',
  'no-credential': 'no usable credential',
  length: 'the reply hit the model output limit, even after one resume — not a finished task',
  refused: 'the model stopped with a safety/refusal finish — not a finished task',
  crashed: 'LAIN was closed mid-turn; the turn was recovered — type continue to resume',
};

/** The live state as { word, detail, colour } — or null when nothing is running and nothing has happened yet. */
const { stepTime, shortCommand, modelRow } = require('./liverow');   // the live row's words (S5.1)

function liveState(s = {}, now = Date.now()) {
  const {
    phase, phaseSince = 0, interrupting, interrupted, failed, retryCancelled,
    steerQueued, lastTurn, pendingCompletion, awaitingUser, lastCheckFailed,
    waitingUntil, waitingLabel, finalSmoke,
  } = s;
  const age = phaseSince ? now - phaseSince : 0;
  const secs = age >= 1500 ? `${Math.round(age / 1000)}s` : '';

  // A DELIBERATE WAIT OUTRANKS EVERYTHING
  if (waitingUntil && waitingUntil > now) {
    const rl = require('../ratelimit');
    return {
      actor: 'NET',
      word: 'WAITING FOR LIMIT RESET',
      detail: `${rl.human(waitingUntil - now)} · ${waitingLabel || 'the provider is rate limited'} · Esc to stop waiting`,
      colour: 'warn',
    };
  }

  // THE ACTOR IS DECLARED BY WHOEVER STARTED THE WORK, never guessed here.
  const actorOf = (p) => (p && p.actor && ACTOR[p.actor] ? p.actor : 'LAIN');

  if (interrupting) return { actor: 'LAIN', word: 'INTERRUPTING', detail: 'cancelling the turn', colour: 'warn', spin: true };
  // AN EXTERNAL MODEL IS A DIFFERENT KIND OF WAIT and says so in its own words:
  // it is not this machine working and it is not LAIN's own model thinking.
  if (phase && phase.phase === 'EXTERNAL') {
    return {
      actor: 'EXTERNAL',
      word: phase.word || 'REVIEWING',
      detail: phase.detail || 'the investigation packet',
      colour: 'external', spin: true, age: secs,
    };
  }
  if (phase && phase.phase === 'MCP') {
    return {
      actor: 'MCP',
      word: phase.word || 'DESKTOP',
      detail: phase.detail || phase.target || '',
      colour: 'warn', spin: true, age: secs,
    };
  }
  if (phase && phase.phase === 'RETRYING') {
    // THE RATE-LIMIT WAIT, stated three ways because each answers a different question: what is wrong, when it ends, and how to stop waiting.
    const at = phase.resumeAt || (phaseSince ? phaseSince + (phase.waitMs || 0) : now);
    const left = phase.resumeAt
      ? Math.max(0, phase.resumeAt - now)
      : Math.max(0, (phase.waitMs || 0) - age);
    // WHAT IS BEING RETRIED, in the same vocabulary a finished failure uses.
    const f = failureRow({ kind: phase.kind, status: phase.status, message: phase.reason });
    const word = phase.rateLimited ? 'RATE LIMITED' : (phase.kind ? f.word : 'RETRYING');
    // WHAT SURVIVES A NARROW TERMINAL, in order.
    const parts = [
      // THE STATUS CODE FIRST AMONG THE DETAILS.
      ...(phase.status ? [{ text: String(phase.status), short: String(phase.status), drop: 2 }] : []),
      { text: `retrying at ${clockAt(at)}`, short: `at ${clockAt(at).slice(0, 5)}`, drop: 1 },
      { text: `${mmss(left)} remaining`, short: mmss(left), drop: 4 },
      { text: `attempt ${phase.attempt}/${phase.of}`, short: `${phase.attempt}/${phase.of}`, drop: 0 },
      { text: 'Esc to cancel', short: 'Esc ✕', drop: 3 },
    ];
    const net = word === 'NETWORK' || word === 'RATE LIMITED';
    return { actor: net ? 'NET' : 'LAIN', word, parts, colour: 'warn', spin: true };
  }
  if (phase) {
    switch (phase.phase) {
      case 'WAITING_MODEL':
      case 'RECEIVING': {
        // The wire decides the state (modelRow): Waiting for <model> · Thinking · Writing.
        if (phase.live) return modelRow(phase, now, steerQueued, actorOf(phase));
        const steer = steerQueued ? ' · steer queued' : '';
        if (phase.phase === 'RECEIVING') return { actor: actorOf(phase), word: 'RECEIVING', detail: 'model response', colour: 'info', spin: true, age: secs };
        return { actor: actorOf(phase), word: 'WORKING', detail: 'waiting for model' + steer, colour: 'info', spin: true, age: secs };
      }
      case 'RUNNING_TOOL': {
        // `Running <label> · <step time> · esc to interrupt` — a shell's own description when it gave one (S5.1); a tool
        // with its own verb says it (`Reading src/a.js`, `Waiting for shell · #3`), never an implementation name.
        const who = phase.tool === 'computer' ? 'MCP' : 'TOOL';
        const shellish = /^(shell|run_(bash|powershell|cmd))$/.test(String(phase.tool || ''));
        const verb = VERB[phase.tool];
        const jobWord = /^job_/.test(String(phase.tool || '')) && phase.label && verb ? `${sentence(verb).replace(/\s+shell$/i, '')} ${phase.label}` : null;   // `Waiting for tests · #3`
        const word = jobWord || (phase.label ? `Running ${phase.label}` : shellish ? `Running ${shortCommand(phase.target)}`
          : verb && verb !== 'RUNNING' ? sentence(verb) : `Running ${String(phase.tool || '').replace(/_/g, ' ')}`);
        const what = shellish || phase.label ? '' : String(phase.target || '');
        return { actor: who, word, detail: [what, stepTime(age), 'esc to interrupt'].filter(Boolean).join(' · '), colour: 'info', spin: true, cased: true, path: Boolean(what) };
      }
      default: break;
    }
  }
  // AN OPERATION IS THE PRESENT; A RESTING STATE IS THE PAST
  if (s.op && s.op.text && !awaitingUser && !pendingCompletion && !steerQueued) {
    return {
      actor: 'LAIN',
      word: s.op.text,
      detail: '',
      colour: s.op.level === 'warn' ? 'warn' : 'meta',
      // NO SPINNER. A note is not work in flight, and a glyph that turns would make the window title claim LAIN was busy - see ui/workclock.js on why nothing…
      op: true,
    };
  }
  if (retryCancelled) return { actor: 'USER', word: 'RETRY CANCELLED', detail: 'the wait was stopped; the task is intact', colour: 'warn' };
  if (interrupted) return { actor: 'USER', word: 'INTERRUPTED', detail: 'you stopped the turn; nothing was lost', colour: 'warn' };
  if (failed) {
    // NETWORK IS NOT LAIN. Attributing a gateway timeout to LAIN puts the
    // blame — and the debugging — in the wrong place.
    const f = failureRow(failed);
    const net = ['NETWORK', 'RATE LIMITED', 'DAILY LIMIT', 'WEEKLY LIMIT', 'STREAM STALLED'].includes(f.word);
    return { actor: net ? 'NET' : 'LAIN', word: f.word, detail: f.detail, colour: 'bad' };
  }
  if (steerQueued) return { actor: 'USER', word: 'STEERING', detail: 'queued for the next model turn', colour: 'warn' };
  // A FINISHED PLAN IS NOT A FINISHED TASK, and the strip must not imply it is.
  if (awaitingUser) {
    return { actor: 'LAIN', word: 'WAITING FOR YOU', detail: String(awaitingUser), colour: 'warn' };
  }
  if (pendingCompletion) {
    return { actor: 'LAIN', word: 'VERIFYING', detail: String(pendingCompletion), colour: 'warn' };
  }
  if (lastTurn) {
    const bits = [];
    if (lastTurn.filesChanged) bits.push(`${lastTurn.filesChanged} file${lastTurn.filesChanged === 1 ? '' : 's'} changed`);
    if (lastTurn.toolCalls) bits.push(`${lastTurn.toolCalls} tool call${lastTurn.toolCalls === 1 ? '' : 's'}`);
    // A TURN THAT WAS CUT SHORT IS NOT DONE.
    const cut = lastTurn.stopReason && lastTurn.stopReason !== 'end';
    if (cut) {
      // A DEAD PROVIDER IS NOT LAIN, resting or otherwise —. It keeps the
      // NET actor here for the same reason the live row gives it one.
      const net = lastTurn.stopReason === 'provider';
      return {
        actor: net ? 'NET' : 'LAIN',
        word: STOPPED_WORD[lastTurn.stopReason] || 'INTERRUPTED',
        detail: [STOPPED_BECAUSE[lastTurn.stopReason] || lastTurn.stopReason, ...bits].join(' · '),
        colour: net || lastTurn.stopReason === 'no-credential' ? 'bad' : 'warn',
      };
    }
    // A FAILING CHECK OUTRANKS A FINISHED TURN
    if (lastCheckFailed) {
      const why = `${lastCheckFailed.command}`
        + (lastCheckFailed.exitCode != null ? ` exited ${lastCheckFailed.exitCode}` : ' failed');
      return {
        actor: 'LAIN',
        word: 'NOT VERIFIED',
        detail: [why, ...bits].join(' · '),
        colour: 'warn',
      };
    }
    // A TURN THAT CLOSED ON A STATED BLOCKER is not a finished task (wakeup.statesBlocker).
    if (lastTurn.blocker) return { actor: 'LAIN', word: 'BLOCKED', detail: ['the model reported a blocker', ...bits].join(' · '), colour: 'warn' };
    // ✓ DONE MEANS THE TASK IS VERIFIED, not that the model stopped: a changed
    // tree whose final smoke has not passed since the change is not done (finalsmoke.js).
    if (finalSmoke && finalSmoke.state && finalSmoke.state !== 'NOT_REQUIRED' && finalSmoke.state !== 'PASSED') {
      const running = finalSmoke.state === 'RUNNING';
      return { actor: 'LAIN', word: running ? 'VERIFYING' : 'NOT VERIFIED', detail: [finalSmoke.why, ...bits].join(' · '), colour: 'warn' };
    }
    // THE RECEIPT closes a finished turn: `✓ DONE · 2 files changed · 4 tool calls · in 18.2k · out 1.1k · cache 12.8k`.
    const receipt = require('./activityline').receipt(lastTurn.usage);
    return { actor: 'LAIN', word: 'DONE', detail: [...bits, receipt].filter(Boolean).join(' · '), colour: 'ok', tick: true };
  }
  return { actor: 'LAIN', word: 'READY', detail: '', colour: 'meta' };
}

/** The strip, as `rows` lines of exactly `width` cells. */
/** WHY A TURN STOPPED lives in ui/failure.js — the words, not the drawing. */
const { failureRow, FAILURE } = require('./failure');

/** THE STATES THE PAUSE MARK BELONGS TO. */
/** IN-PROGRESS STATES THAT ARE NOT `info` COLOURED. */
const ACTIVE_WORDS = new Set(['VERIFYING', 'STEERING', 'INTERRUPTING']);

const PAUSED_MARK = (() => {
  try { return require('../termtitle').PAUSED_WORDS; } catch { return new Set(); }
})();

function sentence(word) {
  const w = String(word || '');
  if (!w) return w;
  return w.split(' ').map((part, i) => {
    if (i === 0) return part.charAt(0) + part.slice(1).toLowerCase();
    return acronym(part) ? part : part.toLowerCase();
  }).join(' ');
}

/** IS THIS SHORT CAPITALISED TOKEN AN ACRONYM, or just a shouted word? */
function acronym(part) {
  if (part.length > 4 || part !== part.toUpperCase()) return false;
  return !/[AEIOU]/.test(part);
}

function statusStrip(s = {}, width = 80, rows = 1, now = Date.now()) {
  const w = Math.max(20, width);
  const out = [];
  const st = liveState(s, now);

  // THE TRAIL — the last completed calls of this turn, oldest first, so the eye travels down into the live row.
  const full = w >= ACTOR_FULL_WIDTH;
  const col = full ? ACTOR_COL : 5;
  const label = (id) => {
    const a = ACTOR[id] || ACTOR.LAIN;
    return paintActor(id, T.pad(full ? a.id : a.short, col - 1)) + ' ';
  };

  // THE TRAIL BELONGS TO A TURN IN FLIGHT, and it ends when the turn does.
  const working = Boolean(st.spin);
  const recent = working && Array.isArray(s.recent) ? s.recent : [];
  const trailRows = Math.max(0, rows - 1);
  if (trailRows > 0) {
    for (const a of recent.slice(-trailRows)) {
      const mark = a.ok === false ? P.bad('✗') : P.ok('✓');
      const verb = (VERB[a.name] || 'RAN').toLowerCase();
      const who = a.actor && ACTOR[a.actor] ? a.actor : 'TOOL';
      const line = `${mark} ${label(who)}${P.meta(verb)} ${a.target ? P.path(a.target) : P.meta(a.name)}`;
      out.push(T.fit(line, w));
    }
    while (out.length < trailRows) out.unshift(' '.repeat(w));
  }

  // WHAT RIDES ON THE LIVE ROW, AND WHAT NO LONGER DOES
  const prog = '';
  // THE MARK SAYS WHICH OF FIVE THINGS THIS ROW IS
  const paused = PAUSED_MARK.has(String(st.word || '').toUpperCase());
  const spin = st.colour === 'bad' ? '✕'
    : paused ? 'Ⅱ'
      : st.spin ? SPIN[Math.floor(now / 250) % SPIN.length]
        : st.tick ? '✓'
          : st.op ? '›' : '·';
  const paint = P[st.colour] || P.plain;
  /** THE STATE, IN SENTENCE CASE */
  // WHICH WORDS ARE SHOUTED, AND WHICH ARE SPOKEN
  const quiet = st.colour !== 'bad' && (st.colour === 'info' || st.colour === 'violet' || st.op || paused
    || ACTIVE_WORDS.has(String(st.word || '').toUpperCase()));
  const word = paint(quiet && !st.cased ? sentence(st.word) : st.word);
  /** WHO, ONLY WHEN IT IS NOT LAIN */
  // LAIN AND `TOOL` ARE BOTH LAIN.
  const actor = st.actor || 'LAIN';
  const who = actor === 'LAIN' || actor === 'TOOL' ? '' : label(actor);
  // A multi-part detail is fitted by dropping the least important part, never
  // by clipping the sentence — see the RETRYING branch above.
  let text = st.detail || '';
  // WHAT ELSE IS RUNNING rides on the one live row while work is in flight: `· 1 shell · 1 monitor · 2 agents`.
  const bg = st.spin && s.background ? require('./activityline').backgroundLabel(s.background) : '';
  if (bg) text = text ? `${text} · ${bg}` : bg;
  if (st.parts) {
    const room = w - 6 - col - st.word.length;
    const join = (list, key) => list.map((p) => p[key] || p.text).join(' · ');
    const shed = (list) => {
      const worst = list.reduce((a, b) => (a.drop < b.drop ? a : b));
      return list.filter((p) => p !== worst);
    };
    // A LADDER, NOT A SWITCH.
    let keep = st.parts.slice();
    const floor = Math.ceil(st.parts.length / 2);
    while (keep.length > floor && join(keep, 'text').length > room) keep = shed(keep);
    let key = 'text';
    if (join(keep, key).length > room) { keep = st.parts.slice(); key = 'short'; }
    while (keep.length > 1 && join(keep, key).length > room) keep = shed(keep);
    text = join(keep, key);
  }
  const detail = st.path ? P.path(text) : P.meta(text);
  // THE RIGHT-HAND COLUMN: WHAT IT COSTS, AND HOW LONG IT HAS TAKEN --
  const clock = s.clock && s.clock.shown ? s.clock.text : '';
  const rightPlain = [prog, clock].filter(Boolean).join('  ');
  // A PAUSED CLOCK IS DIMMER THAN A RUNNING ONE, so a frozen figure reads as
  // deliberately held rather than as a screen that has stopped updating.
  const paintClock = s.clock && s.clock.paused ? P.warn : P.meta;
  const right = prog
    ? P.meta(prog) + (clock ? '  ' + paintClock(clock) : '')
    : (clock ? paintClock(clock) : '');
  // NO LEADING PAD. The content frame owns the outer margin and the layout draws this region inside it (ui/views.js `contentBounds`), so two columns of…
  const left = `${paint(spin)} ${who}${word}${text ? P.meta(' · ') + detail : ''}`;
  const room = w - rightPlain.length - 2;
  const line = rightPlain
    ? T.pad(T.clip(left, room), room) + '  ' + right
    : T.fit(left, w);
  out.push(T.fit(line, w));
  return out;
}

module.exports = { statusStrip, liveState, failureRow, FAILURE, mmss, clockAt, tok, tokens, VERB, ACTOR_COL, ACTOR_FULL_WIDTH };
