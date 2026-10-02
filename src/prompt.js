'use strict';

/**
 * The system prompt.
 *
 * V1's was 3,543 tokens of persona plus an 827-token charter, re-sent on every
 * step of every turn. Most of it told the model how to behave in situations the
 * harness already handles, and some of it described machinery that had been
 * deleted. This one states the situation and gets out of the way.
 *
 * It does NOT prescribe a tool order. No "read before you edit", no "plan first",
 * no "verify after every change". The model decides.
 */

/**
 * THE STANDING POLICY — LAIN's constitution (discipline/constitution.js), about 500 tokens. It teaches judgment;
 * everything LAIN enforces mechanically (stale edits, permissions, blind retries, claim provenance, test integrity,
 * continuation, scope) lives in Core and reaches the model as a contextual message when it applies. The 3,500-token
 * wall of historical prohibitions it replaces was read on every request and enforced nothing.
 */
const BASE = `${require('./discipline/constitution').POLICY}

${require('./contextprovenance').TEACHING}`;

/**
 * WHAT TO DO FIRST, given what the user asked for.
 *
 * These are the workflows that make LAIN a coding assistant rather than a
 * prompt with tools attached: look before you build, trace before you fix,
 * narrow down before you diagnose, stage a build rather than emitting it whole.
 *
 * They are HINTS, not rules — none of them forbids a tool or imposes an order,
 * and the mode that selects them is a local guess (see mode.js). A wrong guess
 * costs one wrong paragraph, which the model is free to ignore the moment the
 * work contradicts it.
 *
 * Each is deliberately short. This text is on every request of the turn, so a
 * page of process here is a page of tokens per step, forever.
 */
const MODE_GUIDANCE = {
  IMPLEMENT: `This is an implementation request.
Find the existing architecture before you add to it. Search for the systems this touches — the feature it belongs to, where that state is owned, the API between them, the settings or config it should hang off, and the tests that already cover it. Fit into what is there; do not invent a second place for something the project already does.
Work outwards from the owner of the state: make the backing behaviour real and check it, THEN connect the surface to it, so the interface never controls something that does not exist.
Finish the whole path. The user's words name the part they can see — a "button", a "page", a "command" — so if that part does not exist when you stop, the feature is not done however correct the backend is. Check the surface layer by name before you report.
Give the new behaviour its OWN test, named for what it does, alongside the existing ones — and cover the round trip, not just one direction (off → on → off). Do not fold your assertions into an unrelated test that already passes: that test now fails for two reasons and describes neither.
Keep the change as small as it can be and still be correct — do not tidy unrelated code on the way past.`,

  MIGRATE: `This is a MIGRATION: the user is describing a final state that DIFFERS from the current one. "Migrate X to Y" does not mean "add Y" — it means that when you are finished the project contains Y and does NOT contain X. The most common way this goes wrong is a model that writes the new implementation perfectly, leaves the old one exactly where it was, and reports success.
Call migration_plan FIRST, with the user's own words. It resolves the scope, settles what happens to the old implementation, produces a file-by-file replacement map and the responsibilities to carry across, and marks the data and config that must be left strictly alone — all measured locally, at no token cost, and it asks the user directly about anything the request genuinely left open. Work from the contract it returns instead of re-deriving the project.
SCOPE IS THE EXPENSIVE MISTAKE. "Change Agent B to Vue" leaves Agent A and Agent C on React, and a project is allowed to be heterogeneous — three components in three languages can be exactly right. Never widen a scoped migration to the whole repository.
Translate STRUCTURE, not syntax. Take the responsibilities the contract lists, build the target's shape first, then fill it in and adapt the APIs. Data and configuration usually need no migration at all — a JSON file is read by whichever implementation is running.
Build and verify the target BEFORE retiring the source, then use migration_activate to retire it: it checkpoints the tree, moves the old files into the migration archive, re-verifies the final state and puts everything back if that fails. Do not delete the old files by hand.
Finish with migration_verify and read both halves. A target that exists and passes its tests is half of what was asked for; the other half is that the old implementation is no longer active, nothing still imports it, and the code deliberately left outside the scope is untouched.`,

  REFACTOR: `This is a restructuring request. The behaviour is already correct — the job is to change the shape without changing what it does.
Establish the baseline FIRST: find the tests that cover this code and run them, so you have a green result to compare against. If nothing covers it, say so before you start — restructuring untested code is a rewrite with no way to tell whether it worked.
Find every caller before you move anything. symbols answers "who uses this name" and dependents answers "what imports this file"; a rename that misses one caller is the single most common way this goes wrong, and it is silent until something runs.
Change structure only. Do not fix bugs, add features or tidy unrelated code on the way past — a diff that does two things cannot be reviewed as either, and if the tests then fail nobody can tell which half broke them.
Re-run the same tests at the end and compare against the baseline you took. Unchanged behaviour is the whole claim being made, so it is the thing to actually check.
Restructuring means the OLD shape stops existing. Adding the new one and leaving the old beside it is not a refactor — it is a second implementation, and the tests will pass either way. Check with find_residue, and review_changes will tell you whether the diff is the shape you meant or a set of files rewritten whole.`,

  BUGFIX: `This is a bug report.
Do not rewrite the thing the user named. Trace the path first: the trigger, the handler, the call it makes, the thing that owns the state, and what comes back. Find the ONE link where reality stops matching the expectation, and say which link it was. Then fix only that.
Reproduce it if you cheaply can — a failing check now is what proves the fix later.
A GREEN TEST SUITE DOES NOT DISPROVE THE REPORT. If the tests pass and the user says it is broken, the tests do not cover the path they described — that narrows the search, it does not end it. Read the code along the path the USER described, starting from the thing they touched, and compare what each step actually sends and stores against what the next step expects. Do not conclude "no issue found" until you have read that path and can say what it does.
Collect the evidence before reasoning about it. If it runs, run it and read the error; if it is a web page, fetch it and read what it actually returns; if something was just edited, look at the diff. A stack trace with a file and a line is worth more than any amount of reading the source and imagining what it does.
Then try to disprove your own fix, specifically — not by re-reading it, but by asking what would still be broken: is there a second code path to the same behaviour, another caller that was not updated, an older copy of the thing you changed, a state where the trigger fires before the fix runs? Look for those with symbols and grep. A fix you have attacked and cannot break is a different claim from a fix you wrote and liked.`,

  TROUBLESHOOT: `The user has a problem but does not know the cause. Do not guess at one.
Narrow it down with evidence, cheapest checks first: is it configured, is it running, is the thing being produced at all, does it get where it is going, does the request succeed, is the display simply stale? Read logs and error output before reading source.
Say what you have ruled out and what you have not. If the evidence does not yet identify the cause, say so and name the next check — do not present a plausible story as a finding.
Close with four short labelled parts, in this order: Finding, Likely cause, Recommended fix, Verification. Leave one out entirely if you genuinely do not have it — an empty heading is better than a guess dressed as an answer.`,

  AUDIT: `This is an assessment. Do not change anything unless the user asks.
Map it deterministically first — structure, entry points, config, dependencies, tests, build — and use search to answer structural questions rather than reading everything.
Report what you actually found: what exists and works, what is wired to what, what is NOT connected, what is missing, what looks risky, and the single most useful next step. Be specific about files. Do not dump code back at the user.`,

  EXPLAIN: `The user wants to understand something, not change it. Do not modify files.
Read what is actually there, follow it to the pieces it depends on, and explain what it does, why it exists and how it connects — in plain language, at the level of someone new to this codebase.`,

  NEW_PROJECT: `This is a new project. Do not emit the whole thing in one go — that wastes tokens and fails in ways that are hard to unpick.
Build it in stages, and make each stage actually run before starting the next: a skeleton that starts, then the core behaviour, then the pieces around it, then the surface, then wiring, then tests. If a stage does not work, fix it before continuing.
If the language or framework was not specified, pick a sensible one and say in one sentence why. Only ask the user if the choice genuinely changes what gets built.`,

  RESUME: `Pick up the work that already exists. The plan, what is already done, and what has been inspected are in your context — use them.
Do not re-plan from scratch, do not redo finished steps, and do not re-read files that have not changed. Continue from the first thing that is genuinely still outstanding.`,

  // ---- NOT "Answer the user." — THIS WAS THE OTHER HALF OF THE P0 BUG -----
  //
  // Second person addressed to "the user" is confusable with the user
  // speaking, and once this rides on the wire under `role: 'user'`
  // (contextfit.buildWire, framed by contextprovenance.js), a model that
  // received the sentence "Answer the user. This does not need the project
  // inspected or any files changed." right after a genuine diagnostic
  // request answered the SENTENCE instead of the request. Rewritten as a
  // description of the situation rather than an instruction phrased at a
  // human — third person throughout, nothing here says "the user" as if
  // addressing them.
  CHAT: `This is a conversational message, not a task. It does not require inspecting the project or changing files to respond to.`,
};

/**
 * WHAT GROUNDING THIS REQUEST ACTUALLY NEEDS — see taskclass.js for the
 * defect this closes. Added ALONGSIDE the mode guidance above, never
 * replacing it: PROJECT_IMPLEMENTATION gets nothing extra here (§13 forbids
 * loosening its guards), and the other three classes get one explicit
 * sentence saying what they do NOT need, because the failure this exists to
 * prevent was the model inventing a demand for a project, an architecture
 * owner, or an implementation target that a live or direct task never had.
 */
const CLASS_GUIDANCE = {
  LIVE_EXTERNAL_DIAGNOSTIC: 'This is a diagnostic against something OUTSIDE the project — a native application, a running process, the desktop, or a page in a browser. It does not require the project source, an architecture owner, or an implementation target. Ground it against the LIVE target: request_browser for a page, Computer MCP for the desktop; observe real state, act if asked, and verify the result actually changed rather than assuming the action landed. When the person asked what something shows, the observation IS the answer — report it; do not search the project for where it came from unless they asked.',
  DIRECT_TOOL_TASK: 'This is one concrete, deterministic operation — not a project task. Do the operation with the tool that matches it, and confirm the result. It does not need to be turned into an implementation request, a plan, or a search of the project.',
  PROJECT_DIAGNOSTIC: 'This asks what is true about the project, not for a fix. Read, run tests, check logs — say what you found. Do not implement a change unless the person asks for one; naming what is broken is the whole answer here.',
};

/**
 * WHAT IS ALREADY ESTABLISHED — the state a long or resumed task needs in order
 * to continue rather than start its investigation again.
 *
 * Everything here is a fact LAIN already holds: what the user has since
 * decided, which files have been touched, whether the last check passed, and
 * what has already been read. Producing it costs no request, and it is the
 * difference between `--resume` restoring a SCREEN and restoring a working
 * context.
 *
 * Deliberately short and capped. It rides on every request of the turn, so it
 * carries CONCLUSIONS — "settings.js was changed", "the suite is failing" —
 * and never the evidence behind them: the model can re-read a file, but it
 * cannot re-derive a decision the user made an hour ago.
 *
 * Ordered by what survives scarcity. The user's own corrections come first,
 * because a constraint they stated is the one thing that cannot be recovered
 * by looking at the repository.
 */
const MAX_STEERS = 4;
const MAX_FILES = 8;
/** Durable project truths carried on every request. See the memory block below. */
const MAX_MEMORY = 6;

/**
 * @param {object}  o
 * @param {boolean} o.opened  this turn has already sent its first request. The
 *   ONCE-PER-TURN facts — the previous turn was cut off, the task is blocked —
 *   were stated then. Re-stating them in the tail of every later step made them
 *   read as a fresh instruction each time: 65 steps of one saved session opened
 *   "Resuming at the exact stop point".
 * @param {object} [o.app]  the running App, read-only, ONLY for the
 *   clarification budget (§15) — it is the one durable fact this function
 *   needs that lives on the app rather than the session. Optional: callers
 *   that build a prompt with no App (a test, appprompt.js's legacy path)
 *   simply do not get this section, which is the existing behaviour for
 *   every field below when its source is absent.
 */
function workingContext({ session, opened = false } = {}) {
  if (!session) return '';
  // ---- EVERYTHING BELOW IS "WHAT WAS ALREADY TRUE WHEN THIS TURN STARTED" --
  //
  // Computed ONCE, before the turn's first request (jobrunner.js turnOptions
  // builds `liveContinuing` up front), and reused UNCHANGED, verbatim, for
  // every later step of the same turn. Once is correct: the turn's own
  // opening request already carried every line of it, and that opening
  // request stays in the conversation history for the rest of the turn.
  //
  // REPEATING IT ON EVERY CONTINUATION WAS THE EXACT MECHANISM BEHIND A REAL,
  // REPORTED DEFECT. A single focused correction ("fix two router bugs...")
  // produced repeated mid-task restatement — "The steer is...", "Back on the
  // two router bugs..." — appearing between ordinary reads, many steps into a
  // task nobody had corrected again. The block was authority-correct (framed
  // as generated context, never the user speaking — see contextprovenance.js)
  // and small (capped; see the length test below) — and still amplified into
  // compulsive re-acknowledgment, because "the user has since said... these
  // override the original request" reads as an ANNOUNCEMENT, and a model
  // handed the same announcement at the tail of its context on every step
  // treats it as news every time.
  //
  // A correction typed DURING a turn is unaffected by this gate — that is
  // `app.queueSteer`'s live, consume-once `steer()` callback (app.js), an
  // entirely different path from this durable per-turn recap. So is the
  // clarification-budget directive (prompt.build, below) — deliberately NOT
  // gated the same way, because it is a hard constraint on tool use that must
  // never be missed, not an informational correction already delivered once.
  if (opened) return '';
  const parts = [];
  const task = session.task;
  const life = session.lifecycle;

  // ONE CURRENT INTENT, not every steer verbatim (intent.js): repeated asks
  // collapse, new constraints merge, a correction wins. History is untouched.
  if (task && Array.isArray(task.steers) && task.steers.length) {
    const intent = require('./intent');
    const said = intent.render(intent.effective(task.objective, task.steers.slice(-MAX_STEERS)));
    if (said) parts.push(said);
  }

  // ---- WHAT IS DURABLY TRUE ABOUT THIS PROJECT ----------------------------
  //
  // memory.js has held exactly this since it was written — DECISION,
  // SOURCE_OF_TRUTH, FACT, LIMITATION, NOTE, kept per project, on disk,
  // surviving both compaction and `/new` — and nothing ever put it in front of
  // the model. It was reachable from `/note` and a UI pane, so the one reader
  // that could act on it was the only one who never saw it.
  //
  // It belongs HERE, beside the user's own corrections and above everything
  // derived from the repository, for the reason that file gives: a decision has
  // reasoning behind it that the transcript no longer holds, and a model that
  // cannot see the decision tidies away the thing it deliberately chose.
  //
  // Capped like everything else here, and silent when the project has none —
  // which is most projects, most of the time.
  try {
    const mem = require('./memory');
    const groups = mem.grouped(session.cwd || '');
    if (groups.length) {
      const rows = [];
      for (const g of groups) {
        for (const it of g.items) {
          if (rows.length >= MAX_MEMORY) break;
          rows.push(`- ${g.kind}: ${String(it.text || '').replace(/\s+/g, ' ').slice(0, 160)}`);
        }
      }
      const total = groups.reduce((n, g) => n + g.items.length, 0);
      if (rows.length) {
        parts.push('Known about this project (recorded earlier, still true — do not re-derive or undo these):\n'
          + rows.join('\n')
          + (total > rows.length ? `\n- (${total - rows.length} more, see /note)` : ''));
      }
    }
  } catch { /* no store yet, or an unreadable one — not this turn's problem */ }

  if (life && life.evidence) {
    const files = [...(life.evidence.filesChanged || [])];
    if (files.length) {
      const shown = files.slice(0, MAX_FILES).map((f) => require('path').basename(f));
      parts.push(`Files changed so far: ${shown.join(', ')}${files.length > MAX_FILES ? ` (+${files.length - MAX_FILES} more)` : ''}`);
    }
    const last = life.lastCommand;
    if (last) {
      const verdict = last.ok === true ? 'passed'
        : last.ok === false ? `FAILED${last.exitCode != null ? ` (exit ${last.exitCode})` : ''}`
        : `INCONCLUSIVE${last.note ? ` — ${last.note}` : ''}`;
      parts.push(`Last check: ${last.command} — ${verdict}`);
    }
  }

  // ---- COMMANDS THAT KEEP FAILING ----------------------------------------
  //
  // A conclusion, like everything else here, and one that cannot be recovered
  // from the transcript without reading all of it: this command has been run
  // three times, it has failed the same way each time, and the shells it was
  // tried under are not the difference. Carried because the alternative is
  // discovering it a fourth time.
  if (session.attempts && typeof session.attempts.loops === 'function') {
    const loops = session.attempts.loops();
    if (loops.length) {
      const rows = loops.slice(0, 3).map((l) => `- ${l.command.slice(0, 90)} — ${l.attempts} attempts, `
        + `all ${l.classifications.join('/')}${l.shells.length > 1 ? `, across ${l.shells.length} shells` : ''}`);
      parts.push(`Still failing after repeated attempts:\n${rows.join('\n')}`);
    }
  }

  // ---- A MIGRATION IN FLIGHT, which changes how everything else reads ----
  //
  // While a migration is half-done the project genuinely contains two
  // implementations of one thing, and that is the intended state rather than a
  // defect. A model that does not know it — after a compaction, after
  // `/resume`, or simply several turns later — reads the duplicate as
  // something to tidy up, and "fixes" whichever half it meets first.
  //
  // Three lines at most, and only while one is actually running. The contract
  // itself is a document and migration_verify prints it; what belongs on every
  // request is the fact that one exists and what has not gone yet.
  try {
    const M = require('./migration');
    const c = M.latest(session.cwd || '');
    if (c && c.stage !== M.STAGE.COMPLETE && c.stage !== M.STAGE.ROLLED_BACK && c.stage !== M.STAGE.FAILED) {
      const outstanding = M.finalState(c).inactive.slice(0, 4);
      parts.push(`A migration is in progress (${c.stage}): ${require('./migrationbrief').oneLine(c)}.`
        + (outstanding.length ? `\nNot yet retired: ${outstanding.join(', ')}. ` : ' ')
        + 'migration_verify checks both halves against the contract; do not "tidy up" the duplication by hand.');
    }
  } catch { /* no manifest, or an unreadable one — the turn is not about this */ }

  // ---- WHERE THE LAST TURN STOPPED, AND WHY --------------------------------
  //
  // THE GAP THIS FILLS, found by tracing the handover rather than by a failing
  // test. Compaction elides bodies and folds the oldest exchanges; the system
  // prompt is rebuilt from the plan, the changed files and the last check. None
  // of those records that the previous turn was CUT OFF — so a turn that died
  // on a rate limit, was interrupted with Ctrl+C, or ran out of steps handed the
  // next request a context in which the work simply appeared to have stopped
  // for no reason. That is the "it behaves like it was told the task for the
  // first time again" report: the objective and the plan survived, and the fact
  // that execution was interrupted at a known point did not.
  //
  // ONLY WHEN IT DID NOT END NORMALLY. A turn that finished says nothing here,
  // because "the last turn ended" is not news.
  const turns = Array.isArray(session.turns) ? session.turns : [];
  const lastTurn = turns[turns.length - 1] || null;
  // `opened` is always false here — the function returned above otherwise —
  // kept explicit rather than removed so this block's own reason for existing
  // (once, at turn open, never on a continuation) stays visible at the call site.
  if (!opened && lastTurn && lastTurn.stopReason && lastTurn.stopReason !== 'end') {
    const why = {
      aborted: 'the user interrupted it',
      provider: 'the provider stopped answering',
      'max-steps': 'it reached the step budget',
      'no-credential': 'there was no usable credential',
    }[lastTurn.stopReason] || lastTurn.stopReason;
    const acts = Array.isArray(lastTurn.actions) ? lastTurn.actions : [];
    const inFlight = acts.length ? acts[acts.length - 1] : null;
    parts.push(`The previous turn did NOT finish: ${why}, after ${lastTurn.steps || 0} step(s)`
      + (inFlight ? `, last call \`${inFlight.name}${inFlight.target ? ' ' + inFlight.target : ''}\`` : '')
      + '. Nothing after that point was done. Continue this task from there — do not restart it, '
      + 'and do not assume the remaining steps were completed.');
  }

  // ---- WHAT IS BLOCKING IT, if anything ------------------------------------
  //
  // Same argument. `NEEDS_USER` after an ask_user, `NEEDS_AUTH` after a refused
  // credential and `BLOCKED` are facts about the task that no amount of reading
  // the transcript recovers once the transcript has been folded.
  if (!opened && life && life.state && life.state !== 'ACTIVE' && life.state !== 'DONE') {
    parts.push(`This task is currently ${life.state}${life.reason ? `: ${life.reason}` : ''}. `
      + 'Resolve or acknowledge that before doing anything else.');
  }

  const seen = session.evidence && typeof session.evidence.digest === 'function'
    ? session.evidence.digest(6)
    : '';
  if (seen) parts.push(seen);

  return parts.join('\n\n');
}

/**
 * @param {string} platform  the raw `process.platform`. Kept as the parameter
 *   because every caller and test already passes it, but it is no longer what
 *   reaches the model: `environment.summary` reports the OS by its real name
 *   along with the shell, runtimes and package manager that actually decide
 *   whether a command will run. `Platform: win32` was the whole of what the
 *   model used to be told, and it left every one of those to be guessed at.
 */
function build({ cwd, platform, model, mode = null, session = null, checkpoints = null, jobs = null, providers = null, runtime = null, separate = false, opened = false, app = null } = {}) {
  let env = '';
  if (platform) {
    // Never fatal. A prompt that failed to build because a directory could not
    // be read would take the whole turn with it, and orientation is a
    // convenience — the model still has a shell and can ask the machine itself.
    try { env = require('./environment').summary(cwd || process.cwd()); } catch { env = `OS: ${platform}`; }
  }
  const facts = [
    cwd ? `Working directory: ${cwd}` : null,
    env || null,
    model ? `You are being served by: ${model}` : null,
  ].filter(Boolean);
  let out = facts.length ? `${BASE}\n\n${facts.join('\n')}` : BASE;
  // THE BOT'S PROFILE (botprofile.js) — in the stable half, for BOT (Chat-view) turns only.
  if (app && session && session.thread === 'chat') {
    try { const pb = require('./botprofile').promptBlock(((app._sibling || app).cfg) || {}); if (pb) out += `\n\n${pb}`; } catch { /* a preference never costs the prompt */ }
  }
  // ---- WHERE THE STABLE HALF ENDS ---------------------------------------
  //
  // Everything above is identical for the life of a session: the instructions,
  // the directory, the OS, the model's name. Everything below changes from turn
  // to turn. `separate` hands the two back apart so the caller can put the
  // changing half where a change costs only itself — see promptparts.js for the
  // measurement that made this worth doing.
  const stable = out;
  let live = '';
  // An OBSERVATION (taskclass 3b) is reported, not troubleshot: the project
  // mode framing ("the user has a problem…") sent a page read into a hunt.
  const observing = Boolean(session && session.taskClassVerdict && session.taskClassVerdict.observe);
  const guide = !observing && mode && MODE_GUIDANCE[mode];
  if (guide) live += `# This request\n${guide}`;
  const working = require('./execmode').guidance(session);
  if (working) live += `${live ? '\n\n' : ''}${working}`;
  // THE TASK'S STATE (discipline/): outcome, asks, criteria, checks, flags — and how much proof the change needs,
  // from the ONE verification authority. The final smoke is named only when that contract asks for broad proof.
  const taskLines = require('./discipline/promptstate').lines(session, model);
  if (taskLines) live += `${live ? '\n\n' : ''}# Task state\n${taskLines}`;
  // WHICH GROUNDING STRATEGY, from taskclass.js — consumed from the session
  // where identify.js already settled it, never re-derived here.
  const taskClass = session && session.taskClassVerdict;
  if (taskClass) {
    const extra = CLASS_GUIDANCE[taskClass.cls];
    // WHAT KIND OF PROJECT (EMPTY / EXISTING, recorded or not) — projectcache.state —
    // and, for a declared read-only task, what it may change (readonly.js).
    const projectLine = app && /^PROJECT_/.test(String(taskClass.cls || '')) ? require('./projectcache').stateLine(app) : '';
    const maskLine = require('./readonly').statusLine(session);
    live += `${live ? '\n\n' : ''}# Grounding\n${require('./taskclass').statusLine(taskClass)}`
      + (projectLine ? `\n${projectLine}` : '')
      + (maskLine ? `\n${maskLine}` : '')
      + (extra ? `\n${extra}` : '');
  }
  // ---- IS THIS A HANDOVER, OR AN ORDINARY CONTINUATION? -------------------
  //
  // Two renderings of ONE set of facts, never both. The working context is the
  // per-turn increment for a model that has been here all along; the handover
  // is what a model that has NOT needs — the same sources, re-measured against
  // disk, with what was merely claimed marked as claimed.
  //
  // It replaces rather than accompanies, because the two overlap almost
  // entirely and printing both would be the same state twice in two voices at
  // exactly the moment the request is trying to be small. See handover.js.
  let established = '';
  let heading = 'Already established';
  try {
    const packet = require('./handover').build(session, {
      cwd, checkpoints, jobs, providers, toModel: model || '',
      // WHAT THE RUNTIME SAW, when this turn is a recovery. The one input to the
      // packet that does not come out of the session file — and the only one
      // that can describe a failure the session file did not survive. See
      // inputgate.js, which is the only thing that sets it, for one turn.
      runtime,
      opened,
    });
    if (packet) { established = packet; heading = 'Session handover — continue this work'; }
  } catch { /* a handover that cannot be built must not take the turn with it */ }
  if (!established) established = workingContext({ session, opened });
  // ---- THE CLARIFICATION BUDGET, IF SPENT — NEVER DROPPED BY THE BRANCH --
  //
  // Appended AFTER the handover/working-context choice above, rather than
  // being inside either branch, on purpose: a handover packet REPLACES the
  // working context (see the comment above — "never both"), and folding the
  // budget directive into workingContext alone meant it silently vanished on
  // exactly the turns §15 cares most about — a recovery, a resume, a model
  // switch — because those are handover turns. This is the standing
  // constraint restated regardless of which rendering was chosen, which is
  // the whole point of a fact that must survive every path that reaches the
  // model. See clarify.js `directive`.
  try {
    const clarify = require('./clarify');
    const budget = app && app._clarify instanceof clarify.Clarifications ? app._clarify : null;
    if (budget && budget.exhausted) {
      established = established ? `${established}\n\n${budget.directive()}` : budget.directive();
    }
  } catch { /* clarify state is a courtesy, never a reason to fail the prompt */ }
  if (established) live += `${live ? '\n\n' : ''}# ${heading}\n${established}`;
  // BACKWARD COMPATIBLE BY DEFAULT. Every existing caller and test asked for
  // one string and still gets exactly the string it got before — the halves are
  // rejoined in the original order. Only a caller that asks is given the seam.
  if (separate) return { stable, live };
  return live ? `${stable}\n\n${live}` : stable;
}

module.exports = { build, workingContext, BASE, MODE_GUIDANCE };
