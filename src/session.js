'use strict';

/** A session owns the conversation and everything derived from it. */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { EvidenceLedger, BODY_READS } = require('./evidence');
const { Task } = require('./task');
const msgfold = require('./msgfold');

/** Pessimistic on purpose — see `contextChars`. */
const CHARS_PER_TOKEN = 3.6;
/** Messages at the end that keep their full body: the current working set. */


const KEEP_RECENT = 10;
/** A tool result smaller than its own stub is left alone. */
const TOOL_STUB_MIN = 400;
/** Declarations kept in an elided read's stub, and how much room they get. */
const RESIDUE_UNITS = 25;
const RESIDUE_CHARS = 700;
/** How much of a long assistant message survives — the opening is the finding. */
const ASSISTANT_KEEP = 400;

/** How many characters of CONVERSATION fit, given the resolved provider. */
function budgetChars(pc) {
  // An explicit override, because the advertised context length is metadata and metadata is frequently wrong — a local model served behind an…
  const forced = Number(process.env.LAIN_CONTEXT_CHARS);
  if (Number.isFinite(forced) && forced > 0) return Math.floor(forced);
  const ctx = Number(pc && pc.ctx) || 128000;
  const out = Number(pc && pc.maxTokens) || 4096;
  const reserve = 4000;                                  // system prompt + tool schemas
  const usable = Math.max(4000, ctx - out - reserve);
  return Math.floor(usable * CHARS_PER_TOKEN);
}

/** WHAT A STUB TELLS THE MODEL TO DO NEXT. */
function rerunAdvice(name) {
  if (String(name) === 'read_file' || String(name) === 'read_symbol') {
    return ' Re-run the call for only the part you need — a range (offset/limit, 40–120 lines) or read_symbol for one definition; repeating the whole read is elided again.';
  }
  return ' Re-run the call if you need the rest.';
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

class Session {
  /** A brand-new, EMPTY session. Touches no previous session's state. */
  constructor({ id = null, cwd = process.cwd() } = {}) {
    this.id = id || newId();
    this.createdAt = new Date().toISOString();
    this.cwd = cwd;
    /** The conversation, including the tool protocol. See turn.js. */
    this.messages = [];
    this.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 0 };
    this.turns = [];
    /** The active task, or null. ONE place — see task.js. */
    this.task = null;
    /** Lifecycle + liveness for the active task. Fed by turn.js on every turn. */
    this.lifecycle = null;
    /** Session-scoped evidence: what content is already in context. */
    // OWNED, so a mutation can tell this session's writes from another's — see
    // evidence.js `foreignWrite`. Two jobs share a filesystem and not a ledger.
    this.evidence = new EvidenceLedger(this.cwd, this.id);
    /** Session-owned plan, or null. A plan NEVER arrives from anywhere else. */
    this.plan = null;
    /** The workflow this session is doing — see mode.js. Restored on /resume so
     *  a resumed bugfix keeps tracing rather than reverting to a generic turn. */
    this.mode = null;
    /** ONE OWNER for compaction and provider projections. */
    this.contextAuthority = new (require('./contextauthority').ContextAuthority)(this);
    /** WHAT THE OTHER ACTORS SAID — the external reviewer and the desktop bridge, in the order they spoke. */
    this.actors = [];
    // WHO ANSWERS A CHAT TURN, and which website thread is this one's.
    require('./modelsource/sessionstate').attach(this);
    require('./sessionviews').attach(this);   // Chat/Coding views, pins, panel, project — see there
    require('./journey').attach(this);          // the session journey — see there
    // Cowork uploads wait here only until the next active Harness task adopts
    // them. Metadata is persisted; bytes remain in this session's scratch.
    this.coworkInputs = [];
    this.goal = null;    // the standing goal, changed only by /goal — goal.js   // its own module: see there
  }

  file() {
    return path.join(config.sessionsDir(), `${this.id}.json`);
  }

  // ------------------------------------------------------ context window ----

  /** How big the conversation currently is, in characters. */
  contextChars() {
    let n = 0;
    for (const m of this.messages) n += msgfold.messageChars(m);
    return n;
  }

  /** ELIDE THE BULK, KEEP THE SHAPE. */
  /** WHAT WAS JUST ELIDED IS NO LONGER "ALREADY IN CONTEXT". */
  _forgetElided(tc) {
    if (!tc || !this.evidence) return;
    if (!BODY_READS.has(String(tc.name))) return;
    let p = null;
    try {
      const a = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
      p = a && a.path;
    } catch { p = null; }
    if (p) this.evidence.elide(String(p));
    // AND THE READ IS RECORDED AS INCOMPLETE, so repeating it is narrowed
    // instead of elided again (readcoverage.js).
    if (p) require('./readcoverage').noteElided(this, String(p));
  }

  /** WHAT THE FILE CONTAINED, WHEN ITS BODY NO LONGER FITS. */
  _semanticResidue(tc) {
    if (!tc || !BODY_READS.has(String(tc.name))) return '';
    let p = null;
    try {
      const a = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
      p = a && a.path;
    } catch { return ''; }
    if (!p) return '';
    try {
      const abs = path.isAbsolute(p) ? p : path.resolve(this.cwd || process.cwd(), p);
      const s = require('./structure').extractFile(abs, String(p));
      const all = s && Array.isArray(s.units) ? s.units : [];
      if (!all.length) return '';
      // SPEND THE ROOM ON THE API SURFACE
      const meaty = all.filter((u) => u.kind !== 'variable');
      const rest = all.filter((u) => u.kind === 'variable');
      const units = [...meaty, ...rest].slice(0, RESIDUE_UNITS);
      let out = '';
      for (const u of units.sort((a, b) => a.line - b.line)) {
        const row = `\n  ${String(u.line).padStart(5)}  ${String(u.kind).padEnd(8)} `
          + `${u.container ? `${u.container}.` : ''}${u.name}`;
        if (out.length + row.length > RESIDUE_CHARS) break;
        out += row;
      }
      if (!out) return '';
      // PRESENT TENSE, DELIBERATELY.
      return `\nThe body is gone. What this file defines, read from disk just now `
        + `(${(s.units || []).length} declarations):${out}`
        + '\nread_symbol returns any one of these without the rest of the file.';
    } catch { return ''; }
  }

  compact({ budgetChars = 0, maxMessages = 0, keepRecent = KEEP_RECENT, force = false } = {}) {
    const before = this.contextChars();
    const beforeCount = this.messages.length;
    const overCount = maxMessages > 0 && beforeCount > maxMessages;
    if (!force && !overCount && budgetChars > 0 && before <= budgetChars) {
      return { compacted: false, before, after: before, elided: 0, folded: 0, beforeMessages: beforeCount, afterMessages: beforeCount };
    }

    // Which tool produced each result — the stub is useless without it, and the
    // tool message itself only carries an id.
    const toolFor = new Map();
    for (const m of this.messages) {
      for (const tc of (m && m.tool_calls) || []) toolFor.set(String(tc.id), tc);
    }

    const last = this.messages.length - 1;
    const frontier = Math.max(1, last - keepRecent + 1);   // index 0 is the objective
    let elided = 0;

    for (let i = 1; i < frontier; i++) {
      const m = this.messages[i];
      // 'stub' is final. 'truncated' is NOT: a result kept in part because it was the live one becomes an ordinary old result once the work moves on, and…
      if (m && m.role === 'assistant') elided += msgfold.elideArguments(m);
      if (!m || m.elided === 'stub') continue;
      const body = String(m.content || '');

      if (m.role === 'tool') {
        if (body.length <= TOOL_STUB_MIN) continue;
        const tc = toolFor.get(String(m.tool_call_id));
        const name = (tc && tc.name) || 'tool';
        const args = tc ? String(tc.arguments || '').slice(0, 120) : '';
        const head = (body.split('\n').find((l) => l.trim()) || '').slice(0, 140);
        const orig = m.origChars || body.length;
        m.content =
          `[elided to fit the context window] ${name}${args ? ' ' + args : ''} returned ${orig} chars.`
          + (head ? ` First line: ${head}` : '')
          + rerunAdvice(name)
          + this._semanticResidue(tc);
        m.elided = 'stub';
        m.origChars = orig;
        elided += body.length - m.content.length;
        this._forgetElided(tc);              // see _forgetElided
        continue;
      }

      if (m.elided) continue;
      if (m.role === 'assistant' && body.length > ASSISTANT_KEEP * 2) {
        m.content = body.slice(0, ASSISTANT_KEEP) + `\n[…${body.length - ASSISTANT_KEEP} chars elided to fit the context window]`;
        m.elided = 'stub';
        elided += body.length - m.content.length;
      }
    }

    // STILL over. Then the RECENT working set is itself bigger than the window — one read of a 400KB file will do it — and keeping it whole is no longer a…
    if (budgetChars > 0 && this.contextChars() > budgetChars) {
      for (let i = frontier; i <= last && this.contextChars() > budgetChars; i++) {
        const m = this.messages[i];
        if (!m || m.elided === 'stub' || m.role !== 'tool') continue;
        const body = String(m.content || '');
        if (body.length <= TOOL_STUB_MIN) continue;
        const tc = toolFor.get(String(m.tool_call_id));
        const name = (tc && tc.name) || 'tool';

        // The LAST result is the one the model is working from right now, so it is TRUNCATED rather than stubbed: the head of a file or a search is usually the…
        if (i >= last - 1) {
          const note = (n) => `\n[…${n} more chars — this result is larger than the context window. `
            + `Read a range, or narrow the search, to see the rest.]`;
          // The note itself occupies the window, so it comes out of the room
          // before the slice — otherwise the trim lands exactly one note over.
          const room = Math.max(TOOL_STUB_MIN, budgetChars - (this.contextChars() - body.length) - note(body.length).length);
          if (body.length <= room) continue;
          m.origChars = m.origChars || body.length;
          m.content = body.slice(0, room) + note(body.length - room);
          m.elided = 'truncated';
          // A HEAD IS NOT THE FILE. Whole-file evidence is exactly what this
          // claim no longer supports, so it is retracted here too.
          this._forgetElided(tc);
        } else {
          m.origChars = m.origChars || body.length;
          // NAME THE CALL, OR THE ADVICE IS UNFOLLOWABLE
          const args2 = tc ? String(tc.arguments || '').slice(0, 120) : '';
          m.content = `[elided to fit the context window] ${name}${args2 ? ' ' + args2 : ''}`
            + ` returned ${m.origChars} chars.` + rerunAdvice(name)
            + this._semanticResidue(tc);
          m.elided = 'stub';
          this._forgetElided(tc);
        }
        elided += body.length - m.content.length;
      }
    }

    // AND THE OTHER KIND OF TOO-BIG: TOO MANY MESSAGES
    let foldedCount = maxMessages > 0 ? this._foldOldest(maxMessages, keepRecent) : 0;
    // STILL OVER THE CHARACTER BUDGET AFTER ELISION.
    if (budgetChars > 0 && this.contextChars() > budgetChars) {
      const floor = Math.max(1, this.messages.length - Math.max(1, keepRecent));
      const cut = msgfold.charCut(this.messages, Math.floor(budgetChars * msgfold.FOLD_CHAR_TARGET), floor);
      if (cut > 1) foldedCount += this._foldAt(cut, floor);
    }

    const after = this.contextChars();
    return {
      compacted: elided > 0 || foldedCount > 0,
      before, after, elided,
      folded: foldedCount,
      beforeMessages: beforeCount,
      afterMessages: this.messages.length,
    };
  }

  /** Fold the oldest exchanges into one summary message until at most `maxMessages` remain. */
  _foldOldest(maxMessages, keepRecent = KEEP_RECENT) {
    const target = Math.max(2, Math.floor(maxMessages));
    if (this.messages.length <= target) return 0;
    // Never fold into the recent working set, even if that leaves us over: a request that is still refused is better than one that has lost the step it is…
    const floor = Math.max(1, this.messages.length - Math.max(1, keepRecent));
    return this._foldAt(Math.min(floor, this.messages.length - target + 1), floor);
  }

  /** Fold messages[1 .. cut) into one summary, snapped to a call/result unit boundary. */
  _foldAt(cut, floor) {
    // SNAP TO A UNIT BOUNDARY, or this is the 400 the comment above warns about.
    const isAnswer = (i) => this.messages[i] && this.messages[i].role === 'tool';
    while (cut < floor && isAnswer(cut)) cut += 1;
    while (cut > 1 && isAnswer(cut)) cut -= 1;
    if (cut <= 1) return 0;
    const gone = this.messages.slice(1, cut);
    if (!gone.length) return 0;
    for (const m of gone) for (const tc of (m && m.tool_calls) || []) this._forgetElided(tc);
    // ONE SUMMARY, WHICH SUPERSEDES THE PREVIOUS ONE
    const folded = msgfold.foldSummary(gone);
    const summary = {
      role: 'user',
      content: folded.content,
      elided: 'folded',
      // HOW MANY REAL MESSAGES THIS STANDS FOR, not how many array slots it replaced.
      foldedCount: folded.foldedCount,
      // THE PARTS, kept so the NEXT fold can merge instead of re-reading prose it would have to parse.
      said: folded.said,
      calls: folded.calls,
    };
    this.messages.splice(1, gone.length, summary);
    return gone.length - 1;
  }

  toJSON() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      cwd: this.cwd,
      messages: this.messages,
      usage: this.usage,
      turns: this.turns,
      task: this.task ? this.task.toJSON() : null,
      lifecycle: this.lifecycle ? this.lifecycle.toJSON() : null,
      evidence: this.evidence.toJSON(),
      plan: this.plan ? this.plan.toJSON() : null,
      planHistory: (this.planHistory || []).slice(-5).map((p) => p.toJSON()),
      mode: this.mode || null,
      ...(this.title ? { title: this.title } : {}),
      // WHERE A CONTINUED SESSION CAME FROM (externalsessions.js): external:<runtime>:<id>.
      ...(this.origin ? { origin: this.origin } : {}),
      execMode: this.execMode || null, focus: Boolean(this.focus), fast: Boolean(this.fast), profile: this.profile || null,
      decisions: Array.isArray(this.decisions) ? this.decisions.slice(-20) : [],
      bgResults: Array.isArray(this._bgResults) ? this._bgResults.slice(-20) : [],
      taskClassVerdict: this.taskClassVerdict || null,
      ...require('./readonly').toJSON(this),
      actors: this.actors,
      // THE RECORD THAT SOMETHING LEFT THIS MACHINE.
      external: this.external ? this.external.toJSON() : [],
      // THE CHAT SOURCE SURVIVES A RESUME. See modelsource/sessionstate.js.
      ...require('./modelsource/sessionstate').toJSON(this),
      ...require('./sessionviews').toJSON(this),
      ...require('./planhandoff').toJSON(this),
      ...require('./journey').toJSON(this),
      ...require('./evidencerefs').toJSON(this),
      ...require('./workbench').toJSON(this),   // Chat's supervision of the Agent (workbench.js)
      cowork: this.cowork ? require('./cowork/sessionstate').from(this.cowork) : null,   // cowork (frozen, S9) loads only for a cowork session
      coworkInputs: this.cowork ? require('./cowork/attachments').pending(this) : [],
      goal: require('./goal').toJSON(this),
      pausedGoals: require('./goal').pausedToJSON(this),
      // WHAT LAIN DID AND CHECKED: transaction receipts (mutation.js), verification
      // runs (verifycontract.js) and the non-progress state (progress.js).
      mutationReceipts: Array.isArray(this.mutationReceipts) ? this.mutationReceipts.slice(-60) : [],
      // THE QUICK CHANGES' RESULTS (changeclass.js) — small, bounded, what the IDE's Changes panel lists.
      quickChanges: Array.isArray(this.quickChanges) ? this.quickChanges.slice(-20) : [],
      // THE COMMITTED TASK CHECKPOINT (taskcheckpoint.js) — where the work stands, as last committed.
      checkpoint: this.checkpoint || null,
      verification: this.verification || null,
      progress: require('./progress').toJSON(this),
      // A TURN IN FLIGHT, so a force-close can be recovered (inflight.js).
      inflight: this.inflight || null,
      bgJobs: Array.isArray(this.bgJobs) ? this.bgJobs.slice(-20) : [],
      workerLedger: Array.isArray(this.workerLedger) ? this.workerLedger.slice(-200) : [],   // workers.js
      workerStats: this.workerStats && typeof this.workerStats === 'object' ? this.workerStats : null,   // workerruntime.stats, per process
    };
  }

  /** Explicit lifecycle clear. This never compacts and never reads a provider profile. */
  clearContext() {
    if (this.contextAuthority) return this.contextAuthority.clearContext();
    const removed = this.messages.length;
    const chars = this.contextChars();
    this.messages = [];
    return { removed, chars };
  }

  save() {
    const dir = config.sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const f = this.file();
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2), 'utf8');
    fs.renameSync(tmp, f);
    return f;
  }

  /** EXPLICIT restore. The only path that crosses a session boundary. Returns null when the id is unknown — callers must not fall back to "the most recent… */
  static resume(id) {
    const f = path.join(config.sessionsDir(), `${String(Session.match(id) || id)}.json`);
    let data;
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
    if (!data || typeof data !== 'object') return null;
    const s = new Session({ id: data.id, cwd: data.cwd });
    s.createdAt = data.createdAt || s.createdAt;
    s.messages = Array.isArray(data.messages) ? data.messages : [];
    // MERGED, NOT REPLACED.
    if (data.usage && typeof data.usage === 'object') s.usage = { ...s.usage, ...data.usage };
    s.turns = Array.isArray(data.turns) ? data.turns : [];
    // Restoring THIS session's task, evidence and plan is the whole point of an
    // explicit resume. None of it can reach any other session.
    s.task = Task.from(data.task);
    s.lifecycle = require('./lifecycle').Lifecycle.from(data.lifecycle);
    // The ledger's owner is restored too — the resumed session notes its writes under its own id, so `noInspection` never mistakes its second write to a…
    s.evidence = EvidenceLedger.from(data.evidence, s.cwd, s.id);
    s.plan = require('./plan').Plan.from(data.plan);
    s.planHistory = (Array.isArray(data.planHistory) ? data.planHistory : []).map((p) => require('./plan').Plan.from(p)).filter(Boolean).slice(-5);
    s.mode = data.mode || null; if (typeof data.title === 'string') s.title = data.title;
    if (data.origin && typeof data.origin === 'object') s.origin = data.origin;
    s.execMode = data.execMode || null; s.focus = Boolean(data.focus); s.fast = Boolean(data.fast); s.profile = data.profile ? (require('./profile').normalize(data.profile) || null) : null;   // SLOW (retired) → ECO
    s.decisions = Array.isArray(data.decisions) ? data.decisions : [];
    s._bgResults = Array.isArray(data.bgResults) ? data.bgResults : [];
    s.taskClassVerdict = data.taskClassVerdict || null;
    // A declared read-only task stays read-only across a resume, and holds its project again.
    require('./readonly').fromJSON(s, data); require('./readonly').restore(s);
    // The other voices come back with the rest of the story. A session written
    // before this existed simply has none, which is the true answer for it.
    s.actors = Array.isArray(data.actors) ? data.actors : [];
    s.external = require('./externalstate').ExternalLedger.from(data.external);
    require('./modelsource/sessionstate').restore(s, data);
    require('./sessionviews').restore(s, data);
    require('./planhandoff').restore(s, data);
    require('./journey').restore(s, data);
    require('./evidencerefs').restore(s, data);
    require('./workbench').restore(s, data);
    s.cowork = data.cowork ? require('./cowork/sessionstate').from(data.cowork) : null;
    s.coworkInputs = Array.isArray(data.coworkInputs) ? data.coworkInputs.slice(0, 8) : [];
    s.goal = require('./goal').from(data.goal);
    s.pausedGoals = require('./goal').pausedFrom(data.pausedGoals);
    s.mutationReceipts = Array.isArray(data.mutationReceipts) ? data.mutationReceipts.slice(-60) : [];
    s.quickChanges = Array.isArray(data.quickChanges) ? data.quickChanges.slice(-20) : [];
    require('./taskcheckpoint').restore(s, data);
    s.verification = data.verification && typeof data.verification === 'object' ? data.verification : null;
    require('./progress').restore(s, data.progress);
    // A TURN THAT WAS IN FLIGHT WHEN ITS PROCESS DIED is repaired here — lost
    // calls classified by inspecting reality, never replayed (inflight.js).
    s.inflight = data.inflight && typeof data.inflight === 'object' ? data.inflight : null;
    s.bgJobs = Array.isArray(data.bgJobs) ? data.bgJobs : [];
    s.workerLedger = Array.isArray(data.workerLedger) ? data.workerLedger : [];
    s.workerStats = data.workerStats && typeof data.workerStats === 'object' ? data.workerStats : null;
    try {
      const inf = require('./inflight');
      const r = s.inflight ? inf.recover(s) : null;
      const jobs = inf.recoverJobs(s);
      if (jobs.length && s.recovered) s.recovered.line += ` · ${jobs.length} background job(s) left by the closed LAIN`;
      if ((r && !r.live) || jobs.length) s.save();
    } catch { /* the session still loads */ }
    return s;
  }

  /** The short form a person types: `20260815-224200-ayze` → `ayze`. */
  static shortId(id) {
    const s = String(id || '');
    const tail = s.split('-').pop();
    return tail || s;
  }

  /** Resolve what the user typed to a real session id. */
  static match(input) {
    const want = String(input || '').trim();
    if (!want) return null;
    const all = Session.list(500);
    if (all.includes(want)) return want;
    const byToken = all.filter((id) => Session.shortId(id) === want);
    if (byToken.length === 1) return byToken[0];
    if (byToken.length > 1) return null;
    const byPrefix = all.filter((id) => id.startsWith(want));
    return byPrefix.length === 1 ? byPrefix[0] : null;
  }

  /** Session ids, newest first. Used by `/sessions` — never to auto-resume. */
  static list(limit = 20) {
    let names = [];
    try { names = fs.readdirSync(config.sessionsDir()); } catch { return []; }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .sort()
      .reverse()
      .slice(0, limit);
  }
}


module.exports = { Session, newId, budgetChars, CHARS_PER_TOKEN, KEEP_RECENT, TOOL_STUB_MIN, ASSISTANT_KEEP };
