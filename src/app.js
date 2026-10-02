'use strict';

/**
 * The REPL shell.
 *
 * Reads input, decides command-vs-content, keeps ONE task identity, runs the
 * turn, renders. Everything else lives in its own module with its own owner.
 * V1's equivalent was 17,511 lines and also owned the plan runner, permission
 * gates, model picker, OAuth flows, a web dashboard and 77 commands.
 *
 * All state hangs off the instance. Nothing is at module scope, so two Apps in
 * one process cannot see each other's session (V1 could).
 */

const path = require('path');
const config = require('./config');
const { Session } = require('./session');
const { runTurn } = require('./turn');
const turnEvents = require('./turnevents');
const { Renderer, C } = require('./render');
const { Input } = require('./input');
const providerMod = require('./provider');
const toolRegistry = require('./tools');
const commands = require('./commands');
const { Availability } = require('./availability');
const connectionsMod = require('./connections');
const catalogMod = require('./catalog');
const { Checkpoints } = require('./checkpoint');
const { UI } = require('./ui');
const { onInterrupt } = require('./interrupt');


class App {
  constructor(opts = {}) {
    /**
     * ONE MORE CONVERSATION IN THE SAME PROCESS, or the process's own.
     *
     * A SIBLING is an App built by src/sessionpool.js to hold a session the
     * window has open beside the one the terminal is on. It is the ordinary App
     * — same turn loop, same tools, same gates — with three differences, all of
     * them consequences of having no terminal of its own:
     *
     *   · it renders to a sink, so it can never write over the CLI's frame
     *   · its `ui` is constructed and never enabled, so it draws nothing
     *   · it SHARES the facts that are about the process rather than about a
     *     conversation — the config object, `availability`, connection
     *     evidence — because two answers to "is this route rate limited" is
     *     two wrong answers half the time
     *
     * Everything a conversation owns — session, checkpoints, abort, jobs,
     * events, handover, project caches — is its own. See sessionpool.js.
     */
    this._sibling = opts.sibling || null;
    this.cfg = this._sibling ? this._sibling.cfg : { ...config.load(), ...(opts.cfg || {}) };
    // ---- WHAT MUST NEVER REACH A SCREEN, LEARNED BEFORE ANYTHING DRAWS ----
    //
    // connections.js registers each credential as it resolves one, which covers
    // every route LAIN actually uses. This is the earlier, cheaper pass: the
    // config file and the environment are read here, at construction, so the
    // filter is armed before the first byte of the first frame. See
    // src/redact.js for why the filter sits on the writer rather than on each
    // of the surfaces that could leak.
    require('./redact').registerFrom(this.cfg);
    this.interactive = opts.interactive !== false;
    this.interaction = opts.interaction || null;
    this.render = new Renderer(opts.out || process.stdout);
    this.cwd = opts.cwd || process.cwd();
    this.wantExit = false;
    this.exitCode = 0;
    this.abort = null;
    /** When the "press Ctrl+C again to exit" confirmation was armed, or 0. */
    this._exitArmedAt = 0;
    this._exitTimer = null;
    /** Steers waiting to be handed to the turn in flight. See queueSteer(). */
    this.steerQueue = [];
    // TWO FACTS THE REPL AND THE UI READ, both about input rather than about
    // work. `dispatching` is the window between a line leaving the queue and
    // `submit` minting `this.abort` — opened by the input gateway's await, and
    // a COUNTER because a held sentence recovers by submitting from inside the
    // dispatch it replaced. `inputClosed` says stdin has ended, so UI.askUser
    // never opens a question nobody can answer. Both deadlocks are documented
    // at the readers: src/repl.js and src/ui/index.js.
    this.dispatching = 0;
    this.inputClosed = false;
    /**
     * AGENT WORK THIS SESSION HAS STARTED, and what it is doing right now.
     *
     * Per-App, never module scope, for the same reason every other piece of
     * session state here is: two LAINs in one process must not see each
     * other's work. See src/agentjob.js for why at most one of these may own
     * `this.session`, and src/jobrunner.js for how the other kind is forked.
     */
    this.jobs = new (require('./agentjob').AgentJobs)({
      onChange: () => { if (this.ui && this.ui.enabled) this.ui.refresh(); },
    });
    // Per-App, never module scope. TWO HALVES WITH DIFFERENT LIFETIMES: the
    // breaker is still in-memory by design, because a restart legitimately knows
    // nothing about whether a server is up; a rate limit is not, because "retry
    // in 4 hours" is a fact whose future outlasts this process. See
    // availability.hydrate and providerhealth.js.
    // A RATE LIMIT IS A FACT ABOUT A ROUTE, NOT ABOUT A CONVERSATION, so a
    // sibling reads and writes the primary's — one shut route, one answer.
    this.availability = this._sibling ? this._sibling.availability : new Availability(this.cfg.availability || {});
    /** Durable provider rows, refreshed off the hot path. */
    this._supervisedProviders = [];
    // THE SINK HANGS OFF `availability`, WHICH A SIBLING SHARES — so installing
    // one again would replace the primary's with an identical closure over a
    // different App. It reads only shared state, so nothing would change today;
    // it is skipped because "the sibling reassigned the process's sink" is a
    // sentence that stops being harmless the moment the sink reads anything
    // session-shaped. ADOPTION is skipped for the plainer reason: a sibling is
    // not a process, and the durable rows are adopted once per process (see
    // providerhealth.refresh).
    if (!this._sibling) {
      require('./providerhealth').installSink(this);
      require('./providerhealth').refresh(this, { adopt: true }); setImmediate(() => { try { require('./tempworkspaces').reconcile(this); } catch { /* next start */ } });   // + temp workspaces: finish, retain, never guess
    }
    /** Real request outcomes per connection — the ONLY thing that can make a
     *  connection REQUEST_READY. A credential on disk never does. Shared for
     *  the same reason availability is: a request that really succeeded is
     *  evidence once, not once per open conversation. */
    this.connectionEvidence = this._sibling ? this._sibling.connectionEvidence : {};
    this.checkpoints = null; // created once the session exists (below)

    // A NEW SESSION IS EMPTY. Resuming happens only here, only because the user
    // asked for it on the command line. There is no lookup of a previous
    // session, no scan of the cwd, and nothing to inherit.
    if (opts.session) {
      // THE POOL ALREADY HAS THE SESSION — resumed or newly made. Adopting it
      // here rather than re-reading it keeps one load per session.
      this.adopt(opts.session, { resumedFrom: opts.resumedFrom || null });
    } else if (opts.resume) {
      const restored = Session.resume(opts.resume);
      if (!restored) {
        this.render.notice('error', `No session "${opts.resume}". Nothing was resumed; starting a new session.`);
        this.adopt(new Session({ cwd: this.cwd }));
      } else {
        this.adopt(restored, { resumedFrom: opts.resume });
      }
    } else {
      this.adopt(new Session({ cwd: this.cwd }));
    }

    // The terminal UI. Constructed always so commands can ask for a panel
    // unconditionally, but only ENABLED on a TTY (see start()). On a pipe the
    // linear renderer runs and every command falls back to plain text — which
    // is what keeps `lain -p ... | grep` and the whole test suite working.
    // WHAT IS HAPPENING, AS NAMED FACTS — the contract a companion renders.
    // LAIN owns this and nothing else does: a companion (the dashboard — and
    // the Probe window, before the Probe integration was removed in 2026-09)
    // SUBSCRIBES; it never computes a second version of the same state from
    // prose, which is what the design forbids and what the Probe was
    // previously reduced to doing. See src/events.js.
    this.events = new (require('./events').EventBus)();
    this.ui = new UI(this);
  }

  /**
   * Bind a session to this App, with everything that hangs off it.
   * THE ONE PLACE a session becomes current. `/resume` and `/new` previously
   * assigned `this.session` directly and left `checkpoints` pointing at the
   * PREVIOUS session — so `/undo` after `/resume` reverted the other session's
   * work, and the cached project brief described the old cwd. Session-scoped
   * companions are rebound here or the leak comes back.
   */
  adopt(session, { resumedFrom = null } = {}) {
    // A DESKTOP AUTHORIZATION BELONGS TO THE SESSION IT WAS GIVEN IN. Changing
    // session ends it; the next piece of work asks again. See computermcp.js.
    if (this._desktop && this.session && this.session.id !== session.id) this._desktop.permissions.revoke('the session changed');
    this.session = session;
    this.resumedFrom = resumedFrom;
    // Turns that ended in an EARLIER process are history, not a resting state. See ui/projection.js.
    this._turnsAtAdopt = (session.turns || []).length;
    // RESUMING loads that session's own snapshots back, so /undo and /changes
    // still work on the work it did. Snapshots were always written and never
    // read, which made both report "nothing" after a resume while the bytes
    // needed to perform the undo sat on disk.
    //
    // A NEW session loads nothing — there is nothing of its own to load, and
    // the directory is keyed by session id, so it could not reach another
    // session's snapshots even if it tried.
    this.checkpoints = new Checkpoints(session.id, session.cwd, { load: Boolean(resumedFrom) });
    this._projectBrief = undefined; // recomputed lazily for this session's cwd
    this._scan = undefined;         // ditto for the UI's project scan and tree
    this._tree = undefined;
    // WORK THAT WAS RUNNING WHEN THIS PROCESS DID NOT EXIST. Refreshed off the
    // hot path and read synchronously by systemPrompt — see refreshSupervisedJobs.
    this._supervisedJobs = [];
    // WHY THE NEXT TURN IS A RECOVERY, or null. One turn's lifetime; see
    // inputgate.js, which is the only thing that sets it.
    this._handover = null;
    // WHAT GIT SAYS ABOUT THIS TREE — reset for the same reason as the brief. See gitsnapshot.js.
    require('./gitsnapshot').reset(this); require('./layacontext').prewarm(this);   // + a consuming (or explicitly shadowed) Laya role loads off the hot path
    this.refreshSupervisedJobs();
    // AND WHICH ROUTES ARE SHUT. Read, never re-adopted — see the constructor.
    // Without this the handover's route section would be whatever was true when
    // the process started, and a limit hit an hour into a long session is
    // exactly the one a replacement model most needs to be told about.
    require('./providerhealth').refresh(this);
    try { require('./autocontinue').scheduleRecovery(this); } catch { /* a crashed Coding turn resumes by itself — autocontinue.js */ }
    return session;
  }

  /**
   * THE LIVE SESSIONS IN THIS PROCESS, and which one a surface is looking at.
   *
   * A running turn belongs to ONE of these, never to the process — see
   * sessionpool.js for the defect that sentence describes. Called on a sibling,
   * it returns the same pool: there is one set of live sessions, not one per
   * conversation.
   */
  pool() { return require('./sessionpool').forApp(this); }

  // WHAT THE SUPERVISOR HAS BEEN DOING, cached for the synchronous readers that
  // build prompts and draw frames. Fire-and-forget; see runtimefacts.js for why
  // it may never be awaited on the hot path, and for the one caller that does.
  refreshSupervisedJobs() { return require('./runtimefacts').jobs(this); }

  // THE FILES THIS SESSION HAS WRITTEN — the checkpoint ledger's answer, the
  // same source pretest.js and /changes read. See gitsnapshot.touched.
  gitTouched() { return require('./gitsnapshot').touched(this); }

  // THE SHALLOW VIEW OF THIS SESSION'S PROJECT — memoised, and cleared by
  // `adopt` alongside everything else that is per-session. Lives in
  // projectcache.js; see the note there for why a directory walk may not sit on
  // a keystroke, and why the clearing stays in adopt.
  projectScan() { return require('./projectcache').scan(this); }
  projectIsEmpty() { return require('./projectcache').isEmpty(this); }
  projectTree() { return require('./projectcache').tree(this); }

  // WHICH MODELS THIS APP CAN REACH lives in appcatalog.js — see the note
  // there. These stay as methods because every caller in the tree, and every
  // test, already asks the app.
  connections() { return require('./appcatalog').connections(this); }
  catalog() { return require('./appcatalog').catalog(this); }
  ensureCatalog(opts) { return require('./appcatalog').ensureCatalog(this, opts); }

  // THE SYSTEM PROMPT. Assembled in appprompt.js, for the reason every other
  // seam in this file exists: app.js is the REPL shell, and what goes into a
  // request changes for entirely different reasons than how input is read.
  systemPrompt() { return require('./appprompt').build(this); }

  // Decide what this input MEANS. The decision lives in identify.js; this is
  // the seam, so app.js stays the REPL shell.
  identify(text, isPaste, forceMode = null, sameTask = false, from = null) {
    return require('./identify').identify(this, text, isPaste, forceMode, sameTask, from);
  }

  /** One user message end-to-end. Returns the turn record. */
  async submit(text, { isPaste = false, forceMode = null, sameTask = false, from = null, typed = false } = {}) {
    require('./perfmark').reset(); if (!from || typed) this._lastInputAt = Date.now();   // perfmark: where this turn's ms went; the CLI self-updates only after a quiet minute (update/cli.js)
    // ONE WRITER PER SESSION, on EVERY path into a turn (typed, Harness, auto-resume, messaging): sessionlease.js.
    { const sh = require('./surfacehandoff'); if (!(await sh.claimWaiting(this))) { const why = sh.check(this).why || 'another surface holds this session'; try { this.render.notice('warn', why); } catch { /* no renderer */ } return { held: 'surface', why }; } }
    // SIMPLE (simple.js): the message is the person's; nothing classifies it. LEGACY: identify.js.
    const simple = require('./simple').on(this);
    const verdict = simple ? require('./simple').identify(this, text) : this.identify(text, isPaste, forceMode, sameTask, from);
    if (this.ui.enabled && (!verdict.sameTask || !this.ui.startedAt)) this.ui.startedAt = Date.now();   // elapsed is the task's
    require('./ui/alert').cancelPendingWait(this); this.abort = new AbortController(); require('./admissiontrace').note(this, 'submit:begin', { from });  // order matters: ui/alert.js
    if (!simple) require('./gitsnapshot').prefetch(this, this.gitTouched());   // legacy: git state on the live tail
    require('./turnauthority').begin(this);   // the runtime learns which process owns this turn
    {
      const { EVENT } = require('./events');
      this.events.emit(verdict.sameTask ? EVENT.TASK_PROGRESS : EVENT.TASK_STARTED, {
        objective: (this.session.task && this.session.task.objective) || text,
        message: text,
        turns: (this.session.turns || []).length,
        from: from || 'user',
      });
      if (!simple) require('./harnesslink').beginTurn(this, verdict, text);   // legacy: the harness task record
    }
    // Whatever was outstanding last time is no longer the news; this turn will
    // decide again when it ends.
    this.pendingCompletion = null;
    if (this.ui.enabled) { this.ui.beginTurn(verdict); this.ui.setLiveUser(text, from, typed); }  // verdict: see ui/alert.js
    let record = null;
    // Carried across the whole event stream: prose buffered until the call it
    // preceded, and the finished record when it arrives. See turnevents.js.
    const ctx = { liveText: '', record: null };
    try {
      text = await require('./interaction').prepareInput(this, text);   // always: staged Cowork inputs reach the turn from EVERY surface
      // A runtime Coding Agent (runtimedispatch.js) is a provider; legacy also routes to assistant/turn and geometryjob.
      const direct = simple ? (require('./runtimedispatch').routes(this, verdict).yes ? { runtime: true } : {})
        : require('./assistant/turn').routes(this, text, from) || (require('./runtimedispatch').routes(this, verdict).yes ? { runtime: true } : require('./geometryjob').routes(this, verdict));
      const stream = direct.runtime ? require('./runtimedispatch').run(this, text, verdict, { from, typed, signal: this.abort.signal })
        : direct.yes ? require('./geometryjob').run(this, text, verdict, { from, typed, plan: direct.plan }) : runTurn(this.session, text, require('./jobrunner').turnOptions(this, {
        session: this.session,
        signal: this.abort.signal,
        from, typed, text,
        // Absent when there is no interactive UI, so ask_user reports that
        // rather than returning a null the model reads as a dismissal.
        // ONE CORE DECISION per question, answerable from here or Telegram (decisions.js).
        ask: require('./decisions').wrapAsk(this, require('./interaction').port(this) ? (q) => require('./interaction').ask(this, q) : this.ui.enabled ? (q) => this.ui.askUser(q) : null),
        // THE LIVENESS SIGNAL, and now also the PRIMARY JOB'S current activity.
        // turn.js computes this immediately before every provider call and
        // every tool; it is a local callback with no request and no token
        // behind it. Routing it through `notePhase` is what lets `/jobs` say
        // what the conversation is doing without a second source of truth.
        onStatus: (p) => this.notePhase(p),
        // ONLY THE ONES MARKED `NOW` are handed to the running turn. A steer
        // defaults to WAIT - it lands after the work in flight finishes - and
        // pressing Enter again promotes it to NOW, which is delivered here at
        // the next step boundary. Both are safe; the difference is how long it
        // waits, and only the user knows which they meant.
        steer: () => {
          const take = [];
          for (let i = this.steerQueue.length - 1; i >= 0; i--) {
            if (this.steerQueue[i].mode === 'NOW') take.unshift(this.steerQueue.splice(i, 1)[0].text);
          }
          return take;
        },
      }));
      for await (const ev of stream) {
        // WHAT EACH EVENT DOES TO THE SCREEN lives in turnevents.js. This loop
        // owns running the turn; drawing every kind of thing a turn can produce
        // is a separate job with a separate owner.
        turnEvents.apply(this, ev, ctx);
      }
      record = ctx.record;
    } finally {
      // Read BEFORE the controller is dropped. Going straight from INTERRUPTING
      // to INTERRUPTED matters: clearing first and setting the resting state
      // afterwards left one frame of READY between them, which reads as "the
      // cancel finished and everything is fine" for an instant.
      const cancelled = Boolean(this.abort && this.abort.signal.aborted);
      this.abort = null;
      // The turn is over however it ended — normally, by failure, or by Ctrl+C.
      // Clearing here rather than on the `done` event means an exception can
      // never leave a spinner running over a turn that is not happening.
      //
      // The in-flight feed is dropped at the same moment. `runTurn` appends the
      // finished turn to `session.turns` BEFORE yielding `done`, so the
      // persisted record is already on screen — keeping the live copy as well
      // rendered every call of the turn twice.
      if (this.ui.enabled) {
        this.ui.setPhase(null);
        this.ui.setInterrupted(cancelled);   // also clears `interrupting`
        // A provider that died, timed out or refused is an ERROR the header must
        // carry — not a silent return to READY.
        // THE FAILURE ITSELF, not a boolean. A 502 and a refused request both
        // used to arrive here as `true` and were drawn as `ERROR — the provider
        // did not answer`, which is the right sentence for one of them and a
        // misdiagnosis for the other.
        this.ui.setFailed(!cancelled && record ? (record.providerFailure || false) : false);
        this.ui.endTurn();
      }
    }
    this.render.nl();
    // SIMPLE: the lifecycle only describes the turn (IDLE now). LEGACY: the completion policy decides, before the redraw.
    if (simple) require('./simple').settle(this, record); else this.maybeComplete(record);
    if (this.ui.enabled) this.ui.setBusy(false);
    if (record) {
      this.render.turnSummary(record);
      // LEGACY ONLY: the closing sentence checked against the evidence (simple has no judges of prose).
      const disagree = !simple && ((this.session.lifecycle && this.session.lifecycle.contradiction(record.text)) || require('./runcheck').check(record.text, this.session.cwd));
      if (disagree) {
        // ON THE TURN IT IS ABOUT: a TUI notice floats under every later turn.
        const kept = (this.session.turns || [])[this.session.turns.length - 1];
        if (this.ui.enabled && kept && kept.turnId === record.turnId) kept.contradiction = disagree;
        else this.render.notice('warn', disagree);
      }
      // REQUEST_READY is earned by a request that actually succeeded.
      const pc = providerMod.resolve({ ...this.cfg, _evidence: this.connectionEvidence });
      connectionsMod.noteTurn(this.connectionEvidence, pc.connectionId || pc.provider, record);
    }
    require('./turnauthority').end(this, record);   // how it ended, for the runtime (a cancel is not a failure)
    if (!simple) require('./harnesslink').endTurn(this, record);   // legacy: the harness task record
    try { this.session.save(); } catch (e) { this.render.notice('warn', `could not save session: ${e.message}`); } require('./admissiontrace').note(this, 'submit:settled', { stop: record && record.stopReason });

    // WHETHER ANOTHER TURN FOLLOWS THIS ONE — a queued steer, a question
    // waiting on the person, a rate limit worth waiting out. Moved out whole when
    // this file crossed the god-object guard; see src/submitclose.js.
    return await require('./submitclose').after(this, record, text);
  }

  /**
   * A LONG RATE LIMIT IS A DECISION, and the decision lives in ratelimit.js.
   * Moved out whole when this file crossed the god-object guard. It is not a
   * wrapper with logic in it: the module already owned the threshold, the
   * question and the resume prompt, and the flow that asks the question was the
   * one piece of that subject still living here.
   */
  async handleRateLimit(record, text) { return require('./ratelimit').handle(this, record, text); }

  // THE COMPLETION POLICY lives in completion.js — see the note there. It stays
  // a method because every caller, and every test, already asks the app.
  maybeComplete(record = null) { return require('./completion').maybeComplete(this, record); }

  /**
   * IS SOMETHING WAITING FOR AN ANSWER? Then this line is it.
   * ONE implementation, because there are two moments it can arrive at: the
   * REPL loop when nothing is running, and the input handler when something is.
   * The second one is not an optimisation — it is the only way the answer can
   * ever arrive during a turn.
   *
   * `ask_user`'s "Other…" and the human external relay both park on
   * `pendingAsk`, and both are asked from INSIDE a turn. Queued input waits for
   * the turn to end, and the turn is waiting for the answer, so the queue was
   * the wrong place for it: the relay asked for a pasted review and then could
   * not be given one. An answer is never a new task, so it never needs to wait
   * its turn behind one.
   *
   * @returns {boolean} true when the line was consumed as an answer.
   */
  answerPending(text) {
    if (!this.pendingAsk) return false;
    const resolve = this.pendingAsk;
    this.pendingAsk = null;
    resolve(String(text == null ? '' : text).trim());
    return true;
  }

  /**
   * WHERE THE TURN'S STATUS GOES — the screen, and the primary job's record.
   *
   * ONE SOURCE. The status strip and `/jobs` are two readings of the same
   * fact, so both are fed from the callback turn.js already calls before every
   * provider request and every tool. A second phase tracker would be free to
   * disagree with the strip, and the day it did, `/jobs` would be lying about
   * work the user can see happening.
   */
  notePhase(p) {
    if (this.ui.enabled && p && p.phase === 'ENDED' && !require('./simple').on(this)) require('./completion').preview(this, (this.session.turns || []).slice(-1)[0]);   // before the settle frame
    if (this.ui.enabled) this.ui.setPhase(p);
    // AND THE WINDOW LOOKS AGAIN, NOW. This is called before every provider
    // request and every tool, which is exactly when what a person is watching
    // changes. Without it the application waited for its next poll and appeared
    // slower than the work it was reporting. It carries no state — the window
    // still reads /api/state — see harnessapp/ipc.js wake().
    require('./sessionstatus').touch(this, { phase: p || null });   // records the phase, wakes, emits session.status
    // AND THE JOURNAL (sessionjournal.js): the phase and how far through, recorded only when it changes — what a
    // surface in another process, or the phone, reads. Costs no request and no token.
    require('./turnauthority').reportProgress(this, p);
    const job = this.jobs.primary();
    if (job && p) {
      job.phase = p.phase || p.word || null;
      job.detail = String(p.detail || p.tool || '').slice(0, 80);
      this.jobs.changed();
    }
  }

  /**
   * START THE CONVERSATION'S WORK AND RETURN — the whole of the fix.
   *
   * `submit` is unchanged and still awaits a turn to completion; every internal
   * caller that sequences on it (rate-limit resume, troubleshoot, the
   * investigation loop, `-p`) keeps working exactly as before. This is the
   * INTERACTIVE entry point, and the only thing it does differently is not wait.
   *
   * See src/jobrunner.js for why the primary job adopts `this.abort` rather
   * than minting a controller of its own.
   */
  startPrimary(text, opts = {}) {
    return require('./jobrunner').startPrimary(this, text, opts);
  }

  /** `/bg <request>` — a second piece of work, on a forked session. */
  startBackground(text) {
    return require('./jobrunner').startBackground(this, text);
  }

  /**
   * Route one input.
   *
   * `background` is the INTERACTIVE caller saying "start it and give me the
   * prompt back". Everything else — `-p`, the investigation loop, a rate-limit
   * resume — leaves it off and gets the awaited turn it has always had, which
   * is why none of those paths had to change.
   */
  async handle(text, { isPaste = false, from = null, background = false, forceMode = null, asText = false, sameTask = false } = {}) {
    let s = String(text == null ? '' : text);
    if (!s.trim()) return;
    // An outstanding question consumes this line as the ANSWER. It is not
    // classified, does not touch task identity and cannot start a task.
    const T = require('./admissiontrace'); T.note(this, 'handle', { chars: s.length }); if (this.answerPending(s)) { T.note(this, 'handle:answer'); return; }
    // A COMPOSED LINE IS A GOAL OR A PLAN (composemode.js). A CAPTURED goal comes back as
    // `{ run }`: it is the work, and continues below as the person's own message.
    const composed = require('./composemode').take(this, s);
    if (composed && !composed.run) return void T.note(this, 'handle:composer');
    if (composed) { s = composed.run; isPaste = false; asText = true; T.note(this, 'handle:goal'); }
    // A bare `/` is someone reaching for the command menu, not a prompt. It is
    // never spent on a model request; the palette comes back instead.
    if (!isPaste && !asText && s.trim() === '/') { this.ui.updateMenus('/'); return; }
    // A paste is content by construction and can never be a command.
    if (!isPaste && !asText && commands.looksLikeCommand(s)) return commands.run(this, s);
    { const pre = await require('./capgate').prompt(this, s, { isPaste, asText }); if (pre.handled) return; s = pre.text; }   // `/<skill>`; SessionStart / UserPromptSubmit hooks (capgate.js)
    // ---- THE INPUT GATEWAY -----------------------------------------------
    //
    // AFTER the command check and BEFORE anything reaches a model — the only
    // correct position. A command is about LAIN rather than about the work
    // (`/models` must answer while a route is shut, `/resume` is how a person
    // recovers by hand), so commands are never held; an answer to an open
    // question is taken further up for the same reason. Everything left is a
    // sentence for a model, and only the Guardian is in a position to know
    // whether one can reach it. See inputgate.js — when the answer is no, it is
    // never "drop it". The await below is why `this.dispatching` exists.
    this.dispatching += 1;
    try {
      const gate = await require('./inputgate').admit(this, s, { from });
      T.note(this, gate.held ? 'handle:held' : 'handle:admitted'); if (gate.held) return gate.result;
      // A TASK IS STARTED, NOT AWAITED, when the caller is the interactive loop.
      // The job owns the turn from here; see src/jobrunner.js and the note in
      // src/repl.js at the line that used to await this.
      if (background) {
        const job = this.startPrimary(s, { isPaste, from });
        // Refused only when one already owns the session, which the steer path
        // makes unreachable — falling back to the awaited turn keeps that
        // impossible case correct rather than silent.
        if (job) return job;
      }
      // NOT AWAITED, deliberately: `submit` mints `this.abort` before its first
      // await, so by the time this returns the ordinary "a turn is running"
      // signal is true and the counter below can safely go back down.
      return this.submit(s, { isPaste, from, forceMode, sameTask });   // sameTask: asserted by LAIN's own controls only
    } finally {
      this.dispatching -= 1;
    }
  }


  /**
   * SOMETHING TRUE RIGHT NOW, that stops being news the moment work begins.
   *
   * Model discovery and model selection are STATE, not conversation: "model X
   * via Y — /models to change" is worth reading while you are choosing, and is
   * scenery once you have chosen. Written to the transcript it was neither —
   * it sat permanently at the foot of Context, below the actual conversation,
   * for the rest of the session, and it was the last thing on screen when the
   * model went quiet, which is exactly the moment it reads as "stuck at model
   * selection".
   *
   * As a story note it appears where and when it is true, dimmed, and the next
   * turn clears it — see ui/story.js. Outside the TUI it is an ordinary notice,
   * because a scrolling terminal has no state to clear.
   */
  transient(level, message) {
    if (this.ui && this.ui.enabled) this.ui.noteSystem(message, level);
    else this.render.notice(level, message);
  }
  // The launch surfaces are written by launch.js, which owns them.
  splash() { return require('./ui/launch').writeSplash(this); }
  banner() { return require('./ui/launch').writeBanner(this); }

  /**
   * THE DESKTOP BRIDGE AND ITS PERMISSION GATE, created on first use. Both are
   * per-App and in memory: a grant that outlived the process that asked for it
   * would be one nobody remembers giving. With nothing configured this still
   * exists and reports NOT CONFIGURED, which is what the status views show.
   */
  desktop() {
    if (!this._desktop) {
      const permissions = new (require('./permissions').Permissions)();
      const bridge = new (require('./mcp').Bridge)(this.cfg, permissions);
      bridge._app = this;          // so each action can reach the control window
      this._desktop = { permissions, bridge };
    }
    return this._desktop;
  }

  // The Ctrl+C confirmation state lives on this instance; the POLICY and its
  // side effects both live in interrupt.js. See armExit/disarmExit there.
  armExit() { return require('./interrupt').armExit(this); }
  disarmExit() { return require('./interrupt').disarmExit(this); }

  // ---- WHAT YOU TYPED WHILE IT WAS WORKING lives in src/steerqueue.js ----
  //
  // Two modes, one safety property, and a bug that turned on the difference
  // between them — see that file's header. Kept as methods here because every
  // caller (repl.js, the key handler, the turn's step boundary) has always
  // reached them through the App, and the seam is about where the code lives.
  queueSteer(text, mode = 'WAIT') { return require('./steerqueue').queue(this, text, mode); }
  promoteSteers() { return require('./steerqueue').promote(this); }
  takeBackSteer() { return require('./steerqueue').takeBack(this); }
  waitingSteers() { return require('./steerqueue').waiting(this); }
  drainSteers() { return require('./steerqueue').drain(this); }

  /**
   * Everything that must be true before the first prompt is accepted.
   *
   * Deliberately not in the constructor: it does I/O and can fail, and a
   * constructor that reaches the network is a constructor that can hang a
   * launch. Both entry points call it, so one-shot and interactive runs start
   * from the same state.
   */
  async prepare() {
    // THE TRUST QUESTION IS ASKED BY repl.js, once the UI exists.
    //
    // It was here first, and here is too early: `prepare()` runs BEFORE
    // `ui.enable()`, so `app.ui.enabled` was false, there was nobody to ask,
    // and the question silently never appeared. Verified against the real
    // binary — a brand-new directory started with no question at all.

    if (this.cfg.model) return;               // already chosen; ask nobody anything
    // If a route already resolves without one — an env-var key, or the scripted
    // provider — then there is no model question to answer, and asking it would
    // be a warning about a problem the user does not have.
    if (providerMod.resolve(this.cfg).protocol) return;
    await this.ensureCatalog();
    const cat = this.catalog();
    // The POLICY is catalog.js's — it is a question about models. This applies
    // and persists the answer, so the choice shows up in /config rather than
    // being re-derived invisibly on every launch.
    const choice = catalogMod.chooseDefault(cat, this.cfg);
    if (choice && choice.model) {
      this.cfg.model = choice.model.id;
      this.cfg.connection = choice.connection.connectionId;
      try { config.save(this.cfg); } catch { /* an unwritable config still runs */ }
      this.transient('info', `model ${choice.model.displayName} via ${this.cfg.connection} — /model to change`);
      return;
    }
    if (choice && choice.error) this.render.notice('warn', choice.error);
    // Say WHICH wall this is. "No provider configured" was the message even when
    // a route was configured, reachable and advertising thousands of models —
    // the user had simply not picked one, which is a different problem with a
    // different fix.
    if (cat.models.length) {
      this.render.notice('warn',
        `No model selected. ${cat.models.length} available — /model to browse, or /model <name>. `
        + 'Set "default" on a connection in config.json to skip this.');
    }
  }

  /**
   * THE INTERACTIVE SESSION — the loop itself lives in repl.js.
   *
   * It was ~200 lines inside this class, which made the App the owner of both
   * "decide what one message means and run it" and "read a terminal, route
   * every keystroke, drain a queue and shut down cleanly". Those change for
   * entirely different reasons, and the second is what pushed this file past
   * the god-object guard. Same seam completion.js, identify.js and
   * interrupt.js already draw.
   */
  async start() { return require('./repl').start(this); }

  /** One-shot mode: `lain -p "..."`. */
  async once(text) {
    this.interactive = false;
    await this.prepare();
    try {
      await this.handle(text);
    } finally {
      // ---- A ONE-SHOT MUST TEAR DOWN WHAT IT STARTED ---------------------
      //
      // FOUND BY A HANGING TEST, which is the only way this shows up. `-p`
      // never goes through repl.start(), so it never reached the teardown
      // there — and the moment a turn could start a MANAGED SERVICE, that
      // stopped being a tidiness question: a dev server holds the event loop
      // open, so `lain -p "start the server"` simply never exited, and the
      // service outlived it as an orphan on a port nobody recorded. That is
      // the exact failure this repository already paid ninety processes for.
      //
      // In the `finally` so a thrown turn cleans up too, and awaited so the
      // process is genuinely free to exit when this returns.
      await require('./harnesslink').shutdown(this); require('./workerruntime').settle(this);   // specialists: stats onto the session, processes stopped
    }
    try { this.session.save(); } catch { /* best effort */ }
    // /resume is the ONLY way state crosses a session boundary, so a one-shot
    // run that never names its own session leaves no way back to it.
    this.render.write(C.dim(`  session ${this.session.id}  ·  resume with: lain --resume ${Session.shortId(this.session.id)}`) + '\n');
    return this.exitCode;
  }
}

module.exports = { App };
