'use strict';

/**
 * PLANS. Optional, and OWNED BY THE SESSION.
 *
 * V1 kept the plan in `<cwd>/.lain/plan.md`, so a plan outlived the run that
 * wrote it. It then needed a session stamp to tell "mine" from "abandoned here
 * by someone else" — and the check was applied on some paths and not others, so
 * `/plan run` in a brand-new session could execute a previous session's plan
 * while the banner advertised it as "Active plan".
 *
 * V2 removes the possibility rather than guarding it. A plan is a field on the
 * Session object and is serialized inside the session file. There is no plan
 * file in the project, nothing to discover in a cwd, no ownership stamp, no
 * similarity heuristic, and no code path that can load a plan from anywhere
 * except the session being resumed. A new session cannot inherit a plan because
 * there is nowhere for it to inherit one from.
 *
 * "change the button text" needs no plan. Plans are for work worth tracking, and
 * nothing here forces one to exist.
 *
 * STEER SEMANTICS (rule 24): a steer adjusts what is LEFT. Completed steps are
 * evidence and are never rewritten, never renumbered away, never deleted. The
 * reason for the change is recorded in Decisions so it survives compaction.
 */

const STATUS = Object.freeze({ TODO: 'todo', ACTIVE: 'active', DONE: 'done', DROPPED: 'dropped' });
/** How many completed steps the compact digest shows before folding the rest. */
const DIGEST_DONE = 6;
/** Dropped steps kept as history (they are not work; the list is bounded). */
const DROPPED_KEEP = 100;

/**
 * A STEP'S IDENTITY IS ITS ID; ITS NUMBER IS ITS PLACE (2026-09-30, Gate 3 §81).
 *
 * THE DEFECT: "Continuing step 3… step 4… step 3…" — and, in real sessions, "step 224", "step 3325". A revision
 * (plan_write with the remaining work reworded) DROPPED every open step and APPENDED the new list, numbered after
 * everything before it. The same work came back as 6, then 9, then 224, while the model kept its own numbering;
 * the prompt's `→ 6.` and the model's "step 3" disagreed, and each continuation flipped between them. Totals
 * counted the dropped rows ("7/3328 done").
 *
 * NOW: a step has a stable `id`; `n` is its position among the LIVE steps (1…k), so "step 3 of 5" means the same
 * thing to every surface and to the model. A revision RECONCILES — an open step the new list still contains keeps
 * its id, status and findings (only its wording follows the model); only work genuinely gone is dropped, and it
 * leaves `steps` for `dropped` (history, never work). Completed steps are never touched.
 */
function newStepId() { return `st_${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 7)}`; }
/** A step's words as the model tends to vary them: numbering, "(done)" marks, case and punctuation dropped. */
function normStep(t) {
  return String(t || '').toLowerCase()
    .replace(/^\s*(?:step\s*)?\d+\s*[.):\-–—]\s*/i, '')
    .replace(/\s*[([]?\s*(?:done|completed|✓|✔|in progress|current)\s*[)\]]?\s*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function wordsOf(t) { return new Set(normStep(t).split(' ').filter((w) => w.length > 2)); }
/** Same step, reworded? Equal words, or most of them shared. */
function sameStep(a, b) {
  const x = normStep(a); const y = normStep(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const A = wordsOf(a); const B = wordsOf(b);
  if (!A.size || !B.size) return false;
  let both = 0;
  for (const w of A) if (B.has(w)) both += 1;
  return both / (A.size + B.size - both) >= 0.6;
}
/** What the model wrote, without its own numbering or a "(done)" mark. */
function cleanStep(t) {
  return String(t || '').trim().replace(/^\s*(?:step\s*)?\d+\s*[.):\-–—]\s*/i, '').replace(/\s*[([]\s*(?:done|completed|✓|✔)\s*[)\]]\s*$/i, '').trim();
}

class Plan {
  constructor(objective = '') {
    /**
     * A DISPLAY LABEL. NOT AN AUTHORITY. See tools/plan.js, which is the only
     * thing that fills it, and src/authority.js, which is what it is checked
     * against.
     *
     * It reads like a third objective and used to behave like one: `plan_write`
     * took the MODEL's `objective` in preference to the task's, so a plan could
     * be filed under a direction that argued with the task it served and nothing
     * compared them. The field stays — session files carry it and `describe()`
     * prints it — but it is derived from the task unless the model's version is
     * checked and found compatible.
     *
     * NOTHING SHOULD READ THIS TO LEARN WHAT THE WORK IS. `authority.project()`
     * deliberately omits it from the plan rung for exactly that reason: two
     * objective-shaped strings in one projection is a choice a consumer should
     * never be asked to make.
     */
    this.objective = String(objective);
    this.createdAt = new Date().toISOString();
    this.steps = [];       // [{ id, n, text, status, note, completedAt }] — LIVE steps; n = place, 1…k
    this.dropped = [];     // [{ id, text, droppedAt, why }] — history, never work
    this.decisions = [];   // [{ text, at, reason }]
    /**
     * WHEN THIS PLAN STOPPED BEING THE WORK IN HAND, or null while it still is.
     *
     * A plan does not disappear when its task completes — the PLAN pane is the
     * record of what was done, and deleting it would throw that away. But it
     * also stops being an answer to "how far along is LAIN right now", and
     * that distinction had no representation at all: `progressOf` read the
     * session's plan unconditionally, so a task that finished at 2/2 left
     * `STEP 2/2 ████ 100%` sitting in the status strip through the idle
     * prompt and into the whole of the next turn, above a model that had not
     * yet decided whether it needed a plan.
     *
     * Retired is a property of the PLAN, not a flag the screen sets, because
     * every surface that draws progress has to agree about it. Adding work
     * un-retires it: a reopened plan is the work in hand again.
     */
    this.retiredAt = null;
  }

  /** This plan's work is finished. It remains readable; it is no longer live. */
  retire(reason = '') {
    if (!this.retiredAt) {
      this.retiredAt = new Date().toISOString();
      if (reason) this.decisions.push({ text: String(reason).slice(0, 200), at: this.retiredAt, reason: 'retired' });
    }
    return this;
  }

  /** Is this plan the work in hand? */
  get isLive() { return !this.retiredAt; }

  /**
   * @param {object} [o.origin]  WHO PUT THIS STEP HERE — `llm` (the runtime
   *   planning its own execution), `user` (a plan the person composed), or
   *   `steer` (a correction to work in flight). Kept because the three are
   *   answerable to different things: a model may revise its own steps freely,
   *   and it must not quietly drop one a person asked for. Defaults to `llm`,
   *   which is who adds steps when nobody says otherwise.
   */
  addSteps(texts, { origin = 'llm' } = {}) {
    // NEW WORK REOPENS THE PLAN. Steps arriving after a task was called done
    // mean the task was not done, and the progress the strip draws has to
    // follow the work rather than the verdict that preceded it.
    if (String(texts && texts.length ? texts.join('') : '').trim()) this.retiredAt = null;
    for (const t of texts) {
      const text = cleanStep(t);
      if (!text) continue;
      this.steps.push({ id: newStepId(), n: this.steps.length + 1, text, status: STATUS.TODO, note: '', completedAt: null, origin: String(origin) });
    }
    if (this.steps.length && !this.steps.some((s) => s.status === STATUS.ACTIVE)) {
      const first = this.steps.find((s) => s.status === STATUS.TODO);
      if (first) first.status = STATUS.ACTIVE;
    }
    return this;
  }

  /** Numbers follow places: live steps are 1…k, whatever was dropped. */
  renumber() {
    this.steps.forEach((s, i) => { s.n = i + 1; if (!s.id) s.id = newStepId(); });
    return this;
  }
  /** Take the DROPPED rows out of the live list (kept as bounded history), then renumber. */
  settleDropped(why = '') {
    const gone = this.steps.filter((s) => s.status === STATUS.DROPPED);
    if (gone.length) {
      const at = new Date().toISOString();
      this.steps = this.steps.filter((s) => s.status !== STATUS.DROPPED);
      for (const s of gone) this.dropped.push({ id: s.id || newStepId(), text: s.text, droppedAt: s.droppedAt || at, why: s.why || why || '', origin: s.origin || null });
      if (this.dropped.length > DROPPED_KEEP) this.dropped.splice(0, this.dropped.length - DROPPED_KEEP);
    }
    return this.renumber();
  }
  /** "step 3 of 5" — the one way every surface and the model count. */
  position(step = this.current()) {
    if (!step) return { index: null, total: this.steps.length };
    const i = this.steps.indexOf(step);
    return { index: i >= 0 ? i + 1 : null, total: this.steps.length };
  }
  byId(id) { return this.steps.find((s) => s.id === id) || null; }

  /**
   * A REVISION FROM THE MODEL (plan_write again) — RECONCILED, NEVER RE-APPENDED.
   *
   *   an open step the new list still names (reworded or not)   kept: id, status, findings; wording updated
   *   a step the new list names that is already DONE             skipped — finished work is not re-added
   *   an open step the new list no longer names                   dropped (to history)
   *   a genuinely new step                                        added
   *
   * The open steps follow the new order, with the step in hand first: re-planning does not switch the work that
   * is under way. Returns what changed, or `unchanged`.
   */
  revise(texts, { origin = 'llm', why = 'plan revised by the model' } = {}) {
    const incoming = (Array.isArray(texts) ? texts : []).map(cleanStep).filter(Boolean);
    const done = this.steps.filter((s) => s.status === STATUS.DONE);
    const open = this.steps.filter((s) => s.status === STATUS.TODO || s.status === STATUS.ACTIVE);
    const active = open.find((s) => s.status === STATUS.ACTIVE) || null;
    const used = new Set();
    const next = [];
    let skippedDone = 0;
    let added = 0;
    let reworded = 0;
    for (const text of incoming) {
      if (done.some((s) => sameStep(s.text, text))) { skippedDone += 1; continue; }
      const hit = open.find((s) => !used.has(s) && sameStep(s.text, text));
      if (hit) {
        used.add(hit);
        if (hit.text !== text) { hit.text = text; reworded += 1; }
        next.push(hit);
      } else {
        next.push({ id: newStepId(), n: 0, text, status: STATUS.TODO, note: '', completedAt: null, origin: String(origin) });
        added += 1;
      }
    }
    const droppedNow = open.filter((s) => !used.has(s));
    const unchanged = !added && !droppedNow.length && !reworded && next.every((s, i) => s === open[i]);
    if (unchanged) return { unchanged: true, kept: open.length, added: 0, dropped: 0, skippedDone };
    // THE STEP IN HAND stays in hand when the new list still has it.
    if (active && used.has(active)) { next.splice(next.indexOf(active), 1); next.unshift(active); }
    for (const s of next) if (s.status === STATUS.ACTIVE && s !== active) s.status = STATUS.TODO;
    const at = new Date().toISOString();
    for (const s of droppedNow) { s.status = STATUS.DROPPED; s.droppedAt = at; s.why = why; }
    // Finished and dropped rows keep their places in the array for settleDropped; the open ones follow the new order.
    const others = this.steps.filter((s) => s.status === STATUS.DONE || s.status === STATUS.DROPPED);
    this.steps = [...others, ...next];
    if (next.length && !next.some((s) => s.status === STATUS.ACTIVE)) next[0].status = STATUS.ACTIVE;
    if (next.length) this.retiredAt = null;
    this.settleDropped(why);
    if (droppedNow.length || added) this.decisions.push({ text: `${why}: ${added} added, ${droppedNow.length} dropped, ${used.size} kept`, at, reason: 'revision' });
    return { unchanged: false, kept: used.size, added, dropped: droppedNow.length, reworded, skippedDone };
  }

  current() {
    return this.steps.find((s) => s.status === STATUS.ACTIVE)
      || this.steps.find((s) => s.status === STATUS.TODO)
      || null;
  }

  /** Mark the active step done WITH a note, and promote the next todo. */
  complete(note = '') {
    const cur = this.current();
    if (!cur) return null;
    cur.status = STATUS.DONE;
    cur.note = String(note || '').slice(0, 400);
    cur.completedAt = new Date().toISOString();
    const next = this.steps.find((s) => s.status === STATUS.TODO);
    if (next) next.status = STATUS.ACTIVE;
    // ---- THE LAST STEP FINISHING DOES **NOT** RETIRE THE PLAN -----------
    //
    // It is tempting, and it is wrong, and this pass tried it and was caught by
    // tests/integration/continuation.test.js — "implemented with every step
    // ticked does NOT finish the task".
    //
    // A TICKED CHECKLIST IS NOT A COMPLETED TASK. That is one of this program's
    // load-bearing rules: a model that marks its own steps done has reported on
    // itself, and completion is settled from EVIDENCE (completion.js), which can
    // and does refuse. Retiring here would retire the plan on the model's
    // say-so, and a refused completion would then be left with no live plan to
    // carry on from — the work would look finished on every surface that draws
    // progress while the harness was still saying it was not.
    //
    // §21's requirement — that active plan_step state clears when a plan is
    // genuinely finished — is already met, by the two triggers that are
    // evidence-gated rather than self-reported:
    //
    //   completion.js  retires it when the task is ACCEPTED as complete
    //   identify.js    retires a finished plan when a NEW request arrives
    //
    // Both are the right authority. This is deliberately not a third.
    return { done: cur, next: next || null };
  }

  get completed() { return this.steps.filter((s) => s.status === STATUS.DONE); }
  get remaining() { return this.steps.filter((s) => s.status === STATUS.TODO || s.status === STATUS.ACTIVE); }
  get isFinished() { return this.steps.length > 0 && this.remaining.length === 0; }

  /**
   * Apply a user steer.
   *
   * COMPLETED STEPS ARE UNTOUCHABLE. `drop` and `replace` silently skip a done
   * step rather than modifying it — rewriting finished work is how a model gets
   * invited to redo it, which is the exact token burn V1 suffered.
   *
   * The steer text ALWAYS lands in decisions, even when it changes no step, so
   * the rationale is durable.
   */
  steer(text, { drop = [], replace = [], append = [] } = {}) {
    const reason = String(text || '').trim();

    const dropSet = new Set(drop.map(Number));
    for (const s of this.steps) {
      if (s.status === STATUS.DONE) continue;               // evidence — never dropped
      if (dropSet.has(s.n)) s.status = STATUS.DROPPED;
    }
    for (const r of replace) {
      const s = this.steps.find((x) => x.n === Number(r.n));
      if (!s || s.status === STATUS.DONE) continue;         // evidence — never rewritten
      s.text = String(r.text);
    }
    for (const t of append) {
      const text2 = cleanStep(t);
      // STEER-ORIGIN, and marked as such: this step exists because a person
      // corrected work already in flight. See `addSteps` on why origin is kept.
      if (text2) { this.steps.push({ id: newStepId(), n: this.steps.length + 1, text: text2, status: STATUS.TODO, note: '', completedAt: null, origin: 'steer' }); this.retiredAt = null; }
    }
    // Exactly one active step, and it is the first thing still to do.
    for (const s of this.steps) if (s.status === STATUS.ACTIVE) s.status = STATUS.TODO;
    const next = this.steps.find((s) => s.status === STATUS.TODO);
    if (next) next.status = STATUS.ACTIVE;

    if (reason) this.decisions.push({ text: reason, at: new Date().toISOString(), reason: 'user steer' });
    // DROPPED WORK LEAVES THE LIVE LIST; the numbers that remain are places again.
    return this.settleDropped(reason);
  }

  /** A failed check is recorded and the work continues. The plan is NEVER reset. */
  recordFailure(what) {
    this.decisions.push({ text: String(what || '').slice(0, 400), at: new Date().toISOString(), reason: 'failure' });
    return this;
  }

  /** Compact digest for the system prompt. Stable within a step. */
  digest(maxChars = 700, { session = null } = {}) {
    if (!this.steps.length) return '';
    const done = this.completed.length;
    const lines = [`Plan: ${this.objective} (${done}/${this.steps.length} done)`];
    const shown = this.steps.filter((s) => s.status !== STATUS.DROPPED);
    const doneRows = shown.filter((s) => s.status === STATUS.DONE);
    const newestDone = new Set(doneRows.slice(-DIGEST_DONE).map((s) => s.n));
    let hiddenDone = 0;
    for (const s of shown) {
      const mark = s.status === STATUS.DONE ? '✓' : s.status === STATUS.ACTIVE ? '→' : s.status === STATUS.DROPPED ? '✗' : '·';
      if (s.status === STATUS.DONE) {
        hiddenDone += 1;
        if (!newestDone.has(s.n)) continue;
      }
      lines.push(`${mark} ${s.n}. ${s.text}${s.status === STATUS.DONE && s.note ? ` (done: ${s.note})` : ''}`.slice(0, 160));
    }
    if (hiddenDone > DIGEST_DONE) {
      lines.splice(1, 0, `  ✓ ${hiddenDone - DIGEST_DONE} earlier completed step(s) omitted — the full list is in /plan`);
    }
    if (this.decisions.length) {
      lines.push('Decisions:');
      for (const d of this.decisions.slice(-4)) lines.push(`- ${d.text}`.slice(0, 160));
    }
    // ---- WHAT THE STEP IN HAND HAS ALREADY ESTABLISHED --------------------
    //
    // Only the ACTIVE step, and only what it recorded. This is the half that
    // survives a compaction, a rate-limit resume and a `/resume` — see
    // src/planfindings.js for why those facts cannot live in the conversation.
    const activeStep = this.steps.find((s) => s.status === STATUS.ACTIVE);
    // DERIVED FIRST, so what Core already knows is there whether or not the
    // model remembered to write it down. The SESSION is passed in rather than
    // held on the plan: a plan with a back-reference to its session is a second
    // way for the two to disagree about which session it belongs to.
    // See planfindings.derive.
    if (activeStep && session) {
      try { require('./planfindings').derive(session, activeStep); } catch { /* the model's own record still stands */ }
    }
    const found = require('./planfindings').lines(activeStep);
    if (found) lines.push(found);
    const out = lines.join('\n');
    return out.length > maxChars ? out.slice(0, maxChars) + '…' : out;
  }

  toJSON() {
    return {
      objective: this.objective, createdAt: this.createdAt, retiredAt: this.retiredAt,
      steps: this.steps, dropped: this.dropped.slice(-DROPPED_KEEP), decisions: this.decisions,
    };
  }

  static from(data) {
    if (!data || typeof data !== 'object') return null;
    const p = new Plan(data.objective);
    p.createdAt = data.createdAt || p.createdAt;
    p.steps = Array.isArray(data.steps) ? data.steps : [];
    p.dropped = Array.isArray(data.dropped) ? data.dropped : [];
    p.decisions = Array.isArray(data.decisions) ? data.decisions : [];
    p.retiredAt = data.retiredAt || null;
    // A PLAN SAVED BEFORE 2026-09-30 kept dropped rows in `steps` and numbered by append order: settled here, so
    // "step 3325 of 3328" comes back as the place it really is among the live steps. Ids are given where missing.
    p.settleDropped('dropped before this build');
    const actives = p.steps.filter((s) => s.status === STATUS.ACTIVE);
    for (const s of actives.slice(1)) s.status = STATUS.TODO;
    if (!actives.length) { const first = p.steps.find((s) => s.status === STATUS.TODO); if (first) first.status = STATUS.ACTIVE; }
    return p;
  }
}


/**
 * The  command. It lives here because every branch of it is a plan
 * operation; commands.js is a registry, not a place for plan rules.
 *
 * `C` is passed in so this module stays usable without the rendering stack.
 */
async function runCommand(app, { args = [], rest = '' } = {}, { C } = {}) {
    const { Plan } = require('./plan');
    const sub = (args[0] || '').toLowerCase();
    const tail = rest.slice(sub.length).trim();
    const w = (s) => app.render.write(s);

    // ---- /plan IS FOR DISCUSSING THE PLAN (§12) -----------------------------
    // Bare `/plan` enters PLAN mode: discussion only, no execution progress.
    // `/plan accept` leaves it and execution begins. See modecommands.js.
    if (sub === 'accept' || sub === 'go') return require('./modecommands').acceptPlan(app, { C });
    if (!sub && require('./execmode').of(app.session) !== 'PLAN') {
      require('./execmode').set(app.session, 'PLAN');
      // Machinery, not the work: the operation row on a TUI, one dim line on a pipe.
      if (app.ui && app.ui.enabled) require('./ui/operation').say(app, 'PLAN · discussing — /plan accept or Shift+Tab to execute', 'info');
      else w(C.dim('  PLAN · discussing — nothing is changed until you accept (/plan accept) or Shift+Tab to AUTO\n'));
    }

    // ---- BARE `/plan` IS AN EDITOR, NOT A DUMP --------------------------
    //
    // It used to be `show`: print the plan and stop. That is the one thing a
    // person almost never wants from a command they typed on purpose — the plan
    // is already on screen, and what they came to do is CHANGE it.
    //
    // No plan          -> the composer, empty.
    // A plan already   -> a three-way choice, because "replace" and "add" are
    // in progress         genuinely different intentions and guessing between
    //                     them silently discards work either way.
    //
    // `show` survives as an explicit subcommand for anyone who does want to read
    // it, and it is what every non-interactive surface falls back to.
    if (!sub) {
      const live = app.session.plan && app.session.plan.steps.length ? app.session.plan : null;
      // INTERACTIVE MEANS SOMEBODY CAN ANSWER, NOT THAT A SCREEN IS DRAWN.
      //
      // This asked only whether the UI was enabled, which is a fact about
      // OUTPUT. `LAIN_FORCE_TUI=1` bypasses exactly one thing — the isTTY check
      // on the screen — so a piped run draws real frames while nothing can ever
      // be typed into them. Bare `/plan` therefore opened the three-way choice,
      // read EOF, took it for a dismissal and printed `Plan unchanged.` — the
      // fallback three lines below exists to prevent precisely that, and could
      // not fire.
      //
      // `input.isTTY` is the honest question: a pipe is not a keyboard. It is
      // the same byte-level fact `_consume` already uses to tell Ctrl+J from a
      // line separator, so the two cannot drift apart.
      const interactive = Boolean(app.ui && app.ui.enabled && app.input && app.input.isTTY);
      if (!interactive) {
        // NOTHING TO TYPE INTO — a pipe, `-p`, a test. Read it out rather than
        // opening a mode nobody can close. The subcommands still work.
        if (!live) { w(C.dim('  No plan. /plan step <text> adds one.\n')); return; }
        return runCommand(app, { args: ['show'], rest: 'show' }, { C });
      }
      const compose = require('./composemode');
      const plancompose = require('./plancompose');
      if (!live) {
        // `PLAN › _` — the composer's label is the whole interface.
        compose.open(app, compose.KIND.PLAN_REPLACE, { prefill: '' });
        return;
      }
      // THE PLAN SHELF (ui/shelf.js) — Continue · Edit · Add · New · Delete. A
      // person with no panel never reaches here (see above), so there is no
      // second path. Escape and EOF arrive as null and change nothing.
      const { shelf } = require('./ui/shelf');
      const mark = (s) => (s.status === STATUS.DONE ? '✓' : s.status === STATUS.ACTIVE ? '◐' : s.status === STATUS.DROPPED ? '–' : '○');
      const shown = live.steps.slice(0, 8).map((s, i) => `${mark(s)} ${i + 1}. ${s.text}`);
      if (live.steps.length > 8) shown.push(`  … ${live.steps.length - 8} more`);
      let picked = null;
      try {
        picked = await app.ui.ask(shelf({
          title: `Plan · ${live.completed.length}/${live.steps.length} done`,
          context: shown,
          actions: [
            { label: 'Continue', value: 'continue' },
            { label: 'Edit', value: 'edit' },
            { label: 'Add', value: 'add' },
            { label: 'New', value: 'new' },
            { label: 'Delete', value: 'delete', confirm: 'Delete this plan? Its steps stop steering the work.', yes: 'Delete' },
          ],
        }));
      } catch { picked = null; }
      const action = picked && picked.action;
      // ---- CONTINUE MEANS CONTINUE THE PLAN -----------------------------
      //
      // This fell through to nothing: every other action was handled and
      // `continue` simply closed the shelf, so the button did what Escape did.
      // It now resumes execution at the first step that is not finished — never
      // at step 1 — through the named PLAN_CONTINUE action. See
      // src/continueactions.js for why there are three named actions rather than
      // one `continue()` whose meaning depends on the menu that called it.
      if (action === 'continue') {
        // CONTINUING THE PLAN IS ACCEPTING IT: execution leaves PLAN mode (§12),
        // exactly as `/plan accept` does.
        require('./execmode').set(app.session, 'AUTO');
        if (live) { live.acceptedAt = live.acceptedAt || Date.now(); }
        const cont = require('./continueactions');
        const r = await cont.planContinue(app);
        if (r.outcome === cont.OUTCOME.NOTHING_TO_DO) w(C.dim(`  ${r.why}\n`));
        else if (r.outcome === cont.OUTCOME.QUEUED) w(C.dim(`  QUEUED — ${r.why}\n`));
        return;
      }
      // THE REMAINING WORK IS WHAT IS EDITED. Completed steps are evidence and
      // are never offered for rewriting — see plancompose.asLine.
      if (action === 'edit') compose.open(app, compose.KIND.PLAN_REPLACE, { prefill: plancompose.asLine(live) });
      else if (action === 'add') compose.open(app, compose.KIND.PLAN_ADD, { prefill: '' });
      else if (action === 'new') compose.open(app, compose.KIND.PLAN_NEW, { prefill: '' });
      else if (action === 'delete') {
        // DEPENDENT STATE GOES WITH IT: an outstanding "plan finished but not
        // verified" is a statement about this plan and must not outlive it.
        app.session.plan = null;
        app.pendingCompletion = null;
        try { app.session.save(); } catch { /* the change still holds for this run */ }
      }
      return;
    }

    if (sub === 'clear') { app.session.plan = null; w(C.dim('  Plan cleared (this session only).\n')); return; }

    if (sub === 'step') {
      if (!tail) { w(C.dim('  Usage: /plan step <text>\n')); return; }
      if (!app.session.plan) app.session.plan = new Plan(app.session.task ? app.session.task.objective : 'session plan');
      app.session.plan.addSteps([tail]);
      w(C.green(`  added step ${app.session.plan.steps.length}\n`));
      return;
    }
    if (sub === 'done') {
      if (!app.session.plan) { w(C.dim('  No plan.\n')); return; }
      const r = app.session.plan.complete(tail);
      if (!r) { w(C.dim('  No open step.\n')); return; }
      w(C.green(`  ✓ step ${r.done.n} done`) + (r.next ? C.dim(`  → next: ${r.next.n}. ${r.next.text}`) : C.dim('  all steps complete')) + '\n');
      // Finishing the last step is the moment completion becomes possible. The
      // evidence safeguard inside maybeComplete() still decides whether it IS
      // complete — a finished checklist with nothing done is not completion.
      app.maybeComplete();
      return;
    }
    if (sub === 'drop') {
      if (!app.session.plan) { w(C.dim('  No plan.\n')); return; }
      // Completed steps are evidence — plan.steer() refuses to touch them.
      app.session.plan.steer(`dropped step ${tail}`, { drop: [Number(tail)] });
      w(C.dim(`  dropped step ${tail} (completed steps are never dropped)\n`));
      return;
    }
    // ---- THIS IS WHERE THE PLAN PANE WENT --------------------------------
    //
    // `/plan show` printed `p.digest()` — one line per step, no progress, no
    // evidence — because the PLAN PANE was one keystroke away and carried the
    // rest: the bar, the percentage that comes from COMPLETED work rather than
    // the active index, and the Why/Files/Status behind each step.
    //
    // There is no pane. So the command renders what the pane rendered, using
    // the pane's own function (ui/views.js `planView`), and the measurement
    // has one implementation rather than two that can disagree about whether
    // a started step counts as a finished one.
    const p = app.session.plan;
    if (!p || !p.steps.length) { w(C.dim('  No plan. Plans are optional; add one with /plan step <text>.\n')); return; }
    const width = (app.render && app.render.width) || 80;
    for (const line of require('./ui/views').planView({
      plan: p, width, evidence: app.session.evidence,
      // EVERY STEP THAT HAS SOMETHING TO SHOW, SHOWS IT. See planView's note on
      // `detail`: expansion used to be a keystroke in a pane, and a completed
      // step's NOTE — the evidence of what was actually done — went dark with
      // the pane that had the keystroke.
      detail: true,
    })) w(line + '\n');
}

/** A step is finished when its STATUS says so — steps carry `status`, never a `done` boolean. */
function stepDone(s) { return Boolean(s) && (s.status === STATUS.DONE || s.status === STATUS.DROPPED || s.done === true); }

/**
 * A PLAN CORE SEEDS FROM WORK IT ALREADY DID — the runtime's door (§20: the
 * doors that append steps are the runtime, /plan and /steer; a person's
 * sentence is never one). The deterministic steps Core completed before the
 * model (resolving the symbol, inspecting dependents) arrive DONE with their
 * evidence; the rest are TODO for the model to tick with plan_step_done. It is
 * a projection of execution, not a gate: nothing waits on it.
 */
function seedFromCore(session, { objective = '', done = [], remaining = [] } = {}) {
  if (!session) return null;
  const p = new Plan(String(objective || ''));
  p.addSteps([...done.map((d) => d[0]), ...remaining], { origin: 'core' });
  for (const [, note] of done) p.complete(note);
  session.plan = p;
  return p;
}

module.exports = { runCommand, Plan, STATUS, stepDone, seedFromCore, sameStep, cleanStep };
