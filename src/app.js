'use strict';

/** The REPL shell. */

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
    /** ONE MORE CONVERSATION IN THE SAME PROCESS, or the process's own. */
    this._sibling = opts.sibling || null;
    this.cfg = this._sibling ? this._sibling.cfg : { ...config.load(), ...(opts.cfg || {}) };
    // WHAT MUST NEVER REACH A SCREEN, LEARNED BEFORE ANYTHING DRAWS
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
    // TWO FACTS THE REPL AND THE UI READ, both about input rather than about work.
    this.dispatching = 0;
    this.inputClosed = false;
    /** AGENT WORK THIS SESSION HAS STARTED, and what it is doing right now. */
    this.jobs = new (require('./agentjob').AgentJobs)({
      onChange: () => { if (this.ui && this.ui.enabled) this.ui.refresh(); },
    });
    // Per-App, never module scope.
    this.availability = this._sibling ? this._sibling.availability : new Availability(this.cfg.availability || {});
    /** Durable provider rows, refreshed off the hot path. */
    this._supervisedProviders = [];
    // THE SINK HANGS OFF `availability`, WHICH A SIBLING SHARES — so installing one again would replace the primary's with an identical closure over a…
    if (!this._sibling) {
      require('./providerhealth').installSink(this);
      require('./providerhealth').refresh(this, { adopt: true }); setImmediate(() => { try { require('./tempworkspaces').reconcile(this); } catch { /* next start */ } });   // + temp workspaces: finish, retain, never guess
    }
    /** Real request outcomes per connection — the ONLY thing that can make a connection REQUEST_READY. */
    this.connectionEvidence = this._sibling ? this._sibling.connectionEvidence : {};
    this.checkpoints = null; // created once the session exists (below)

    // A NEW SESSION IS EMPTY.
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

    // The terminal UI. Constructed always so commands can ask for a panel unconditionally, but only ENABLED on a TTY (see start()). On a pipe the linear…
    this.events = new (require('./events').EventBus)();
    this.ui = new UI(this);
  }

  /** Bind a session to this App, with everything that hangs off it. */
  adopt(session, { resumedFrom = null } = {}) {
    // A DESKTOP AUTHORIZATION BELONGS TO THE SESSION IT WAS GIVEN IN. Changing
    // session ends it; the next piece of work asks again. See computermcp.js.
    if (this._desktop && this.session && this.session.id !== session.id) this._desktop.permissions.revoke('the session changed');
    this.session = session;
    this.resumedFrom = resumedFrom;
    // Turns that ended in an EARLIER process are history, not a resting state. See ui/projection.js.
    this._turnsAtAdopt = (session.turns || []).length;
    // RESUMING loads that session's own snapshots back, so /undo and /changes still work on the work it did.
    this.checkpoints = new Checkpoints(session.id, session.cwd, { load: Boolean(resumedFrom) });
    this._projectBrief = undefined; // recomputed lazily for this session's cwd
    this._scan = undefined;         // ditto for the UI's project scan and tree
    this._tree = undefined;
    // WORK THAT WAS RUNNING WHEN THIS PROCESS DID NOT EXIST. Refreshed off the
    // hot path and read synchronously by systemPrompt — see refreshSupervisedJobs.
    this._supervisedJobs = [];
    // WHAT GIT SAYS ABOUT THIS TREE — reset for the same reason as the brief. See gitsnapshot.js.
    require('./gitsnapshot').reset(this);
    this.refreshSupervisedJobs();
    // AND WHICH ROUTES ARE SHUT. Read, never re-adopted — see the constructor.
    require('./providerhealth').refresh(this);
    try { require('./autocontinue').scheduleRecovery(this); } catch { /* a crashed Coding turn resumes by itself — autocontinue.js */ }
    return session;
  }

  /** THE LIVE SESSIONS IN THIS PROCESS, and which one a surface is looking at. */
  pool() { return require('./sessionpool').forApp(this); }

  // WHAT THE SUPERVISOR HAS BEEN DOING, cached for the synchronous readers that build prompts and draw frames.
  refreshSupervisedJobs() { return require('./runtimefacts').jobs(this); }

  // THE FILES THIS SESSION HAS WRITTEN — the checkpoint ledger's answer, the
  // same source pretest.js and /changes read. See gitsnapshot.touched.
  gitTouched() { return require('./gitsnapshot').touched(this); }

  // THE SHALLOW VIEW OF THIS SESSION'S PROJECT — memoised, and cleared by `adopt` alongside everything else that is per-session.
  projectScan() { return require('./projectcache').scan(this); }
  projectIsEmpty() { return require('./projectcache').isEmpty(this); }
  projectTree() { return require('./projectcache').tree(this); }

  // WHICH MODELS THIS APP CAN REACH lives in appcatalog.js — see the note there.
  connections() { return require('./appcatalog').connections(this); }
  catalog() { return require('./appcatalog').catalog(this); }
  ensureCatalog(opts) { return require('./appcatalog').ensureCatalog(this, opts); }


  /** One user message end-to-end. Returns the turn record. */
  async submit(text, { isPaste = false, forceMode = null, sameTask = false, from = null, typed = false } = {}) {
    require('./perfmark').reset(); if (!from || typed) this._lastInputAt = Date.now();   // perfmark: where this turn's ms went; the CLI self-updates only after a quiet minute (update/cli.js)
    // ONE WRITER PER SESSION, on EVERY path into a turn (typed, Harness, auto-resume, messaging): sessionlease.js.
    { const sh = require('./surfacehandoff'); if (!(await sh.claimWaiting(this))) { const why = sh.check(this).why || 'another surface holds this session'; try { this.render.notice('warn', why); } catch { /* no renderer */ } return { held: 'surface', why }; } }
    const verdict = require('./simple').identify(this, text);   // the message is the person's; nothing classifies it
    if (this.ui.enabled && (!verdict.sameTask || !this.ui.startedAt)) this.ui.startedAt = Date.now();   // elapsed is the task's
    require('./ui/alert').cancelPendingWait(this); this.abort = new AbortController(); require('./admissiontrace').note(this, 'submit:begin', { from });  // order matters: ui/alert.js
    require('./turnauthority').begin(this);   // the runtime learns which process owns this turn
    {
      const { EVENT } = require('./events');
      this.events.emit(verdict.sameTask ? EVENT.TASK_PROGRESS : EVENT.TASK_STARTED, {
        objective: (this.session.task && this.session.task.objective) || text,
        message: text,
        turns: (this.session.turns || []).length,
        from: from || 'user',
      });
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
      text = require('./simple').withSelection(this, text);   // S8: the editor selection rides on the message
      // A runtime Coding Agent (runtimedispatch.js) is a provider; everything else is the one turn.
      const stream = require('./runtimedispatch').routes(this, verdict).yes ? require('./runtimedispatch').run(this, text, verdict, { from, typed, signal: this.abort.signal })
        : runTurn(this.session, text, require('./jobrunner').turnOptions(this, {
        session: this.session,
        signal: this.abort.signal,
        from, typed, text,
        // Absent when there is no interactive UI, so ask_user reports that rather than returning a null the model reads as a dismissal.
        ask: require('./decisions').wrapAsk(this, require('./interaction').port(this) ? (q) => require('./interaction').ask(this, q) : this.ui.enabled ? (q) => this.ui.askUser(q) : null),
        // THE LIVENESS SIGNAL, and now also the PRIMARY JOB'S current activity.
        onStatus: (p) => this.notePhase(p),
        // ONLY THE ONES MARKED `NOW` are handed to the running turn.
        steer: () => {
          const take = [];
          for (let i = this.steerQueue.length - 1; i >= 0; i--) {
            if (this.steerQueue[i].mode === 'NOW') take.unshift(this.steerQueue.splice(i, 1)[0].text);
          }
          return take;
        },
      }));
      for await (const ev of stream) {
        // WHAT EACH EVENT DOES TO THE SCREEN lives in turnevents.js.
        turnEvents.apply(this, ev, ctx);
      }
      record = ctx.record;
    } finally {
      // Read BEFORE the controller is dropped.
      const cancelled = Boolean(this.abort && this.abort.signal.aborted);
      this.abort = null;
      // The turn is over however it ended — normally, by failure, or by Ctrl+C.
      if (this.ui.enabled) {
        this.ui.setPhase(null);
        this.ui.setInterrupted(cancelled);   // also clears `interrupting`
        // A provider that died, timed out or refused is an ERROR the header must carry — not a silent return to READY.
        this.ui.setFailed(!cancelled && record ? (record.providerFailure || false) : false);
        this.ui.endTurn();
      }
    }
    this.render.nl();
    require('./simple').settle(this, record);   // the lifecycle only describes the turn (IDLE now)
    if (this.ui.enabled) this.ui.setBusy(false);
    if (record) {
      this.render.turnSummary(record);
      // REQUEST_READY is earned by a request that actually succeeded.
      const pc = providerMod.resolve({ ...this.cfg, _evidence: this.connectionEvidence });
      connectionsMod.noteTurn(this.connectionEvidence, pc.connectionId || pc.provider, record);
    }
    require('./turnauthority').end(this, record);   // how it ended, for the runtime (a cancel is not a failure)
    try { this.session.save(); } catch (e) { this.render.notice('warn', `could not save session: ${e.message}`); } require('./admissiontrace').note(this, 'submit:settled', { stop: record && record.stopReason });

    // WHETHER ANOTHER TURN FOLLOWS THIS ONE — a queued steer, a question waiting on the person, a rate limit worth waiting out.
    return await require('./submitclose').after(this, record, text);
  }

  /** A LONG RATE LIMIT IS A DECISION, and the decision lives in ratelimit.js. */
  async handleRateLimit(record, text) { return require('./ratelimit').handle(this, record, text); }


  /** IS SOMETHING WAITING FOR AN ANSWER? */
  answerPending(text) {
    if (!this.pendingAsk) return false;
    const resolve = this.pendingAsk;
    this.pendingAsk = null;
    resolve(String(text == null ? '' : text).trim());
    return true;
  }

  /** WHERE THE TURN'S STATUS GOES — the screen, and the primary job's record. */
  notePhase(p) {
    if (this.ui.enabled) this.ui.setPhase(p);
    // AND THE WINDOW LOOKS AGAIN, NOW.
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

  /** START THE CONVERSATION'S WORK AND RETURN — the whole of the fix. */
  startPrimary(text, opts = {}) {
    return require('./jobrunner').startPrimary(this, text, opts);
  }

  /** `/bg <request>` — a second piece of work, on a forked session. */
  startBackground(text) {
    return require('./jobrunner').startBackground(this, text);
  }

  /** Route one input. */
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
    this.dispatching += 1;
    try {
      T.note(this, 'handle:admitted');
      // A TASK IS STARTED, NOT AWAITED, when the caller is the interactive loop.
      if (background) {
        const job = this.startPrimary(s, { isPaste, from });
        // Refused only when one already owns the session, which the steer path makes unreachable — falling back to the awaited turn keeps that impossible case…
        if (job) return job;
      }
      // NOT AWAITED, deliberately: `submit` mints `this.abort` before its first await, so by the time this returns the ordinary "a turn is running" signal is…
      return this.submit(s, { isPaste, from, forceMode, sameTask });   // sameTask: asserted by LAIN's own controls only
    } finally {
      this.dispatching -= 1;
    }
  }


  /** SOMETHING TRUE RIGHT NOW, that stops being news the moment work begins. */
  transient(level, message) {
    if (this.ui && this.ui.enabled) this.ui.noteSystem(message, level);
    else this.render.notice(level, message);
  }
  // The launch surfaces are written by launch.js, which owns them.
  splash() { return require('./ui/launch').writeSplash(this); }
  banner() { return require('./ui/launch').writeBanner(this); }

  /** THE DESKTOP BRIDGE AND ITS PERMISSION GATE, created on first use. */
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

  // WHAT YOU TYPED WHILE IT WAS WORKING lives in src/steerqueue.js
  queueSteer(text, mode = 'WAIT') { return require('./steerqueue').queue(this, text, mode); }
  promoteSteers() { return require('./steerqueue').promote(this); }
  takeBackSteer() { return require('./steerqueue').takeBack(this); }
  waitingSteers() { return require('./steerqueue').waiting(this); }
  drainSteers() { return require('./steerqueue').drain(this); }

  /** Everything that must be true before the first prompt is accepted. */
  async prepare() {
    // THE TRUST QUESTION IS ASKED BY repl.js, once the UI exists.

    if (this.cfg.model) return;               // already chosen; ask nobody anything
    // If a route already resolves without one — an env-var key, or the scripted provider — then there is no model question to answer, and asking it would…
    if (providerMod.resolve(this.cfg).protocol) return;
    await this.ensureCatalog();
    const cat = this.catalog();
    // The POLICY is catalog.js's — it is a question about models.
    const choice = catalogMod.chooseDefault(cat, this.cfg);
    if (choice && choice.model) {
      this.cfg.model = choice.model.id;
      this.cfg.connection = choice.connection.connectionId;
      try { config.save(this.cfg); } catch { /* an unwritable config still runs */ }
      this.transient('info', `model ${choice.model.displayName} via ${this.cfg.connection} — /model to change`);
      return;
    }
    if (choice && choice.error) this.render.notice('warn', choice.error);
    // Say WHICH wall this is.
    if (cat.models.length) {
      this.render.notice('warn',
        `No model selected. ${cat.models.length} available — /model to browse, or /model <name>. `
        + 'Set "default" on a connection in config.json to skip this.');
    }
  }

  /** THE INTERACTIVE SESSION — the loop itself lives in repl.js. */
  async start() { return require('./repl').start(this); }

  /** One-shot mode: `lain -p "..."`. */
  async once(text) {
    this.interactive = false;
    await this.prepare();
    try {
      await this.handle(text);
    } finally {
      // A ONE-SHOT MUST TEAR DOWN WHAT IT STARTED
      await require('./harnesslink').shutdown(this); if (require.cache[require.resolve('./workerruntime')]) require('./workerruntime').settle(this);   // specialists: stats onto the session, processes stopped
    }
    try { this.session.save(); } catch { /* best effort */ }
    // /resume is the ONLY way state crosses a session boundary, so a one-shot
    // run that never names its own session leaves no way back to it.
    this.render.write(C.dim(`  session ${this.session.id}  ·  resume with: lain --resume ${Session.shortId(this.session.id)}`) + '\n');
    return this.exitCode;
  }
}

module.exports = { App };
