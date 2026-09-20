'use strict';

/**
 * THE GOAL — what the user is trying to achieve.
 *
 * ------------------------------------------------------------------------
 * FOUR CONCEPTS, AND THEY MUST NOT COLLAPSE INTO EACH OTHER.
 *
 *   GOAL       what the user is trying to achieve.        Durable. Theirs.
 *   PLAN       the current strategy for reaching it.      Revisable.
 *   PLAN_STEP  the execution steps being worked through.  Runtime's.
 *   STEER      a correction to work already in flight.    Momentary.
 *
 * A task objective is NOT a goal. `task.objective` is whatever sentence started
 * the current unit of work — "fix the checkout race" — and it is replaced the
 * moment a person asks for something else. A goal outlives that: "stabilise the
 * CLI and finish the Harness" is true across a dozen tasks, and it is the thing
 * that says which of them were worth doing.
 *
 * A plan is not a goal either. A plan is one strategy, and it can be wrong,
 * replaced or abandoned while the goal is untouched.
 *
 * ------------------------------------------------------------------------
 * IT CHANGES ONLY WHEN THE PERSON CHANGES IT.
 *
 * Nothing in a turn writes here — not the model, not the runtime, not a
 * completion, not a failure. `/goal` is the only door, which is what makes it
 * safe to leave on screen and safe to carry into a resumed session. A goal that
 * a turn could quietly rewrite would be a second task objective wearing a
 * different label.
 *
 * ------------------------------------------------------------------------
 * ONE STORE. It lives on the session, is written by the session file, and is
 * read by everything else. There is deliberately no project-level goal file, no
 * config key and no `.lain` record of it: a second store is a second answer to
 * "what am I trying to do", and the day they disagreed neither would be
 * trustworthy.
 */

const crypto = require('crypto');

/** A goal is a direction, not a specification. Bounded like every other input. */
const MAX_GOAL = 2000;

/**
 * ------------------------------------------------------------------------
 * HOW A NEW REQUEST RELATES TO THE STANDING GOAL.
 *
 * THIS MODULE STILL HAS EXACTLY ONE DOOR, AND THIS IS NOT IT. `relate()`
 * reports a relationship; it never writes one. That distinction is the whole
 * reason it is safe to have here: the invariant at the top of this file is that
 * only `/goal` changes the goal, and a classifier that could act on its own
 * verdict would be the turn quietly rewriting the goal — the exact failure the
 * invariant exists to prevent.
 *
 * WHY CLASSIFY AT ALL, THEN. Because the projection that orients a worker has to
 * say whether the sentence it is carrying serves the standing goal or argues with
 * it, and because a request that plainly supersedes the direction should be
 * SURFACED to the person rather than silently executed under a goal it
 * contradicts.
 *
 * THE DEFAULT IS `CONTINUES_GOAL`, AND IT HAS TO BE. Almost everything a person
 * types during a project is another task under the same direction — "also fix
 * the timer", "check that test too", "implement the next step". A classifier
 * that treated those as new directions would ask for confirmation constantly,
 * and a surface that asks constantly is one people stop reading. So supersession
 * is recognised only from language that says so outright.
 */
const RELATION = Object.freeze({
  /** Another task under the same direction. The ordinary case, and the default. */
  CONTINUES_GOAL: 'CONTINUES_GOAL',
  /** A narrower piece explicitly carved out of the goal. */
  CHILD_TASK: 'CHILD_TASK',
  /** The same direction, restated or adjusted rather than replaced. */
  REFINES_GOAL: 'REFINES_GOAL',
  /** The person is calling the current direction off. */
  SUPERSEDES_GOAL: 'SUPERSEDES_GOAL',
  /** A direction with no relation to the stored one. */
  UNRELATED_NEW_GOAL: 'UNRELATED_NEW_GOAL',
  /** There is no goal to relate to. Not the same as "unrelated". */
  NO_GOAL: 'NO_GOAL',
});

/**
 * Language that CALLS OFF a direction. Deliberately narrow and deliberately
 * explicit: each of these is a person saying, in words, that the thing they
 * asked for before is no longer what they want.
 *
 * `instead` is required to carry a scope word ("instead focus", "instead work
 * on") because a bare "instead" is ordinary mid-task English — "use a map
 * instead" adjusts an implementation and changes no direction at all.
 */
const SUPERSEDE_RE = /\b(?:stop working on|forget (?:the )?(?:previous|earlier|old)|abandon (?:the )?(?:previous|earlier|old)|(?:the )?new goal is|change (?:of )?direction|drop (?:the )?(?:previous|current|old)|instead (?:focus|work on|do)|scrap (?:the )?(?:previous|current|old))\b/i;

/** Language that RESTATES the direction rather than replacing it. */
const REFINE_RE = /\b(?:refine (?:the )?goal|narrow (?:the )?goal|broaden (?:the )?goal|(?:update|adjust|revise) (?:the )?goal)\b/i;

/** Language that explicitly carves a piece out of the standing direction. */
const CHILD_RE = /\b(?:as part of (?:the|this) goal|under (?:the|this) goal|(?:the )?(?:first|next|last) step (?:of|towards|toward))\b/i;

/**
 * HOW DOES THIS SENTENCE STAND TO THE STANDING GOAL?
 *
 * @returns {{relation, consequential:boolean, ambiguous:boolean, why:string}}
 *   `consequential` — acting on this would change what the work is FOR, which is
 *     the only case worth interrupting a person about.
 *   `ambiguous` — it reads as superseding but does not name a replacement, so
 *     LAIN genuinely cannot tell what the new direction is. §4: ask then, and
 *     only then.
 */
function relate(session, text) {
  const t = String(text == null ? '' : text).trim();
  const current = get(session);
  if (!current) {
    return { relation: RELATION.NO_GOAL, consequential: false, ambiguous: false, why: 'no goal is set' };
  }
  if (!t) {
    return { relation: RELATION.CONTINUES_GOAL, consequential: false, ambiguous: false, why: 'nothing was said' };
  }
  if (SUPERSEDE_RE.test(t)) {
    // A REPLACEMENT NAMED, OR A DIRECTION MERELY CANCELLED? "the new goal is X"
    // says what to do next; "stop working on X" does not, and LAIN must not
    // invent the successor. That is the one case §4 wants a question for.
    const names = /\b(?:new goal is|instead (?:focus|work on|do))\b/i.test(t);
    return {
      relation: RELATION.SUPERSEDES_GOAL,
      consequential: true,
      ambiguous: !names,
      why: names ? 'the request names a replacement direction' : 'the request calls off the direction without naming a replacement',
    };
  }
  if (REFINE_RE.test(t)) {
    return { relation: RELATION.REFINES_GOAL, consequential: true, ambiguous: false, why: 'the request adjusts the direction rather than replacing it' };
  }
  if (CHILD_RE.test(t)) {
    return { relation: RELATION.CHILD_TASK, consequential: false, ambiguous: false, why: 'the request places itself under the standing goal' };
  }
  return {
    relation: RELATION.CONTINUES_GOAL,
    consequential: false,
    ambiguous: false,
    why: 'an ordinary task under the standing goal — the default, and almost always right',
  };
}

/**
 * A STABLE HANDLE FOR ONE GOAL, so a fork, a work order and a resumed session
 * can all say they are serving the SAME direction rather than an equal-looking
 * one.
 *
 * DERIVED, NOT RANDOM, and that is what makes it work for records written before
 * ids existed: the same text set at the same moment is the same goal, so a
 * legacy row gets the id it would have been given. A random id would have made
 * every old session's goal unidentifiable, and §14's "same goal identity" test
 * unanswerable for them.
 */
function idFor(text, setAt) {
  return 'G' + crypto.createHash('sha256')
    .update(String(text || '') + '|' + String(setAt || ''))
    .digest('hex').slice(0, 12);
}

/** What `/goal` shows in front of the composer while it is being written. */
const PROMPT = 'GOAL';

/** The goal this session is working towards, or null. */
function get(session) {
  const g = session && session.goal;
  return g && g.text ? g : null;
}

/** Its text, or '' — the form most callers want. */
function text(session) {
  const g = get(session);
  return g ? g.text : '';
}

/**
 * Its stable id, or ''. Recovered for a goal that predates ids, so no caller has
 * to care whether the session file was written before or after this existed.
 */
function id(session) {
  const g = get(session);
  if (!g) return '';
  return g.id || idFor(g.text, g.setAt || null);
}

/**
 * SET IT. The only mutation, and it is reached only from `/goal`.
 *
 * The previous goal is kept in `history` rather than overwritten in place. A
 * person who rewrites a goal mid-project is making a decision, and losing what
 * it replaced makes the session unable to say what changed or when — which is
 * exactly the question a resumed session is asked.
 */
function set(session, value) {
  if (!session) return null;
  const t = String(value == null ? '' : value).trim().slice(0, MAX_GOAL);
  if (!t) return clear(session);
  const prev = get(session);
  const now = new Date().toISOString();
  const history = (session.goal && Array.isArray(session.goal.history)) ? session.goal.history.slice(-9) : [];
  if (prev && prev.text !== t) history.push({ text: prev.text, until: now });
  // THE SAME TEXT RE-ENTERED IS THE SAME GOAL, and keeps its id and its
  // timestamp. Someone re-typing their own direction has not changed it, and a
  // new id there would make every work order issued before the re-entry look
  // like it served a different direction.
  if (prev && prev.text === t) return session.goal;
  session.goal = { id: idFor(t, now), text: t, setAt: now, history };
  return session.goal;
}

/** Drop it. Only `/goal clear` and a brand-new session reach this. */
function clear(session) {
  if (!session) return null;
  session.goal = null;
  return null;
}

/**
 * WHAT THE SYSTEM PROMPT IS TOLD, or ''.
 *
 * SHORT, AND MARKED AS DIRECTION RATHER THAN AS THE TASK. A model handed a goal
 * as though it were the request will start working on the goal — and the goal
 * is usually far larger than the sentence the person actually just typed. It is
 * context for judging what matters, not an instruction to act on.
 */
function forPrompt(session) {
  const t = text(session);
  if (!t) return '';
  return `THE USER'S STANDING GOAL — the direction this work serves, not this turn's request:\n  ${t}`;
}

/** What a session file carries. Ids and text; nothing derived. */
function toJSON(session) {
  const g = get(session);
  if (!g) return null;
  return {
    id: id(session),
    text: g.text,
    setAt: g.setAt || null,
    updatedAt: g.updatedAt || null,
    history: Array.isArray(g.history) ? g.history.slice(-9) : [],
  };
}

/**
 * Put it back on a resumed session.
 *
 * A session saved before goals existed has none, and that is the true answer
 * for it rather than a fallback.
 */
function from(data) {
  if (!data || typeof data !== 'object' || !data.text) return null;
  const text_ = String(data.text).slice(0, MAX_GOAL);
  const setAt = data.setAt || null;
  return {
    // A RECORD WRITTEN BEFORE IDS EXISTED STILL GETS THE ID IT WOULD HAVE HAD.
    // `idFor` is a function of the text and the moment, so this is recovery
    // rather than invention — see its header.
    id: typeof data.id === 'string' && data.id ? data.id : idFor(text_, setAt),
    text: text_,
    setAt,
    updatedAt: data.updatedAt || null,
    history: Array.isArray(data.history) ? data.history.slice(-9) : [],
  };
}

// ---------------------------------------------------------------- continuity --
//
// GOALS ARE RESUMABLE, AND STILL LIGHTWEIGHT. A person can hold more than one
// direction across a project — "finish the Harness", then "fix the release
// blocker", then back. `session.goal` stays the ONE ACTIVE goal every consumer
// reads (the prompt, the authority chain, background forks); the others wait in
// `session.pausedGoals`. There are exactly two states because there are exactly
// two behaviours: ACTIVE is the direction the work serves, PAUSED is kept and
// serves nothing. No completion state: nothing here can observe that a goal was
// achieved, and a state no code sets is a promise, not a fact.

const STATE = Object.freeze({ ACTIVE: 'ACTIVE', PAUSED: 'PAUSED' });
const MAX_PAUSED = 12;

function paused(session) {
  return session && Array.isArray(session.pausedGoals) ? session.pausedGoals : [];
}

/** Every goal, active first, as `{ id, text, state, setAt, updatedAt }`. */
function list(session) {
  const out = [];
  const g = get(session);
  if (g) out.push({ id: id(session), text: g.text, state: STATE.ACTIVE, setAt: g.setAt || null, updatedAt: g.updatedAt || g.setAt || null });
  for (const p of paused(session)) out.push({ ...p, state: STATE.PAUSED });
  return out;
}

function pauseActive(session, now) {
  const g = get(session);
  if (!g) return;
  const keep = paused(session).filter((p) => p.id !== id(session));
  keep.unshift({ id: id(session), text: g.text, setAt: g.setAt || null, updatedAt: now });
  session.pausedGoals = keep.slice(0, MAX_PAUSED);
  session.goal = null;
}

/** NEW: a fresh goal becomes active; the one it displaces is PAUSED, never lost. */
function create(session, value) {
  if (!session) return null;
  const t = String(value == null ? '' : value).trim().slice(0, MAX_GOAL);
  if (!t) return get(session);
  const now = new Date().toISOString();
  if (get(session) && get(session).text === t) return session.goal;
  pauseActive(session, now);
  session.goal = { id: idFor(t, now), text: t, setAt: now, updatedAt: now, history: [] };
  return session.goal;
}

/** CONTINUE: make this goal the active one. The active goal it replaces is paused. */
function activate(session, goalId) {
  if (!session || !goalId || goalId === id(session)) return get(session);
  const p = paused(session).find((x) => x.id === goalId);
  if (!p) return null;
  const now = new Date().toISOString();
  pauseActive(session, now);
  session.pausedGoals = paused(session).filter((x) => x.id !== goalId);
  session.goal = { id: p.id, text: p.text, setAt: p.setAt || now, updatedAt: now, history: [] };
  return session.goal;
}

/** EDIT: change a goal's words. Its identity, and whether it is active, are unchanged. */
function edit(session, goalId, value) {
  const t = String(value == null ? '' : value).trim().slice(0, MAX_GOAL);
  if (!session || !t) return null;
  if (!goalId || goalId === id(session)) {
    const prevId = id(session);
    const g = set(session, t);
    // `set` mints an id from the new text; an EDIT keeps the goal it edited.
    if (g && prevId) { g.id = prevId; g.updatedAt = new Date().toISOString(); }
    return g;
  }
  const p = paused(session).find((x) => x.id === goalId);
  if (!p) return null;
  p.text = t;
  p.updatedAt = new Date().toISOString();
  return p;
}

/**
 * DELETE: remove one goal. Removing the ACTIVE one leaves no active goal — the
 * next direction is chosen by a person, never promoted from the paused list
 * behind their back. The work order and the prompt read the goal through
 * `authority.project()`, which is rebuilt from the session, so nothing is left
 * pointing at a goal that no longer exists.
 */
function remove(session, goalId) {
  if (!session || !goalId) return false;
  if (goalId === id(session)) { clear(session); return true; }
  const before = paused(session).length;
  session.pausedGoals = paused(session).filter((x) => x.id !== goalId);
  return session.pausedGoals.length !== before;
}

function pausedToJSON(session) {
  return paused(session).slice(0, MAX_PAUSED).map((p) => ({ id: p.id, text: p.text, setAt: p.setAt || null, updatedAt: p.updatedAt || null }));
}

function pausedFrom(data) {
  if (!Array.isArray(data)) return [];
  return data.filter((p) => p && p.text && p.id).slice(0, MAX_PAUSED)
    .map((p) => ({ id: String(p.id), text: String(p.text).slice(0, MAX_GOAL), setAt: p.setAt || null, updatedAt: p.updatedAt || null }));
}

module.exports = {
  get, text, id, set, clear, forPrompt, toJSON, from, relate, idFor,
  list, create, activate, edit, remove, pausedToJSON, pausedFrom,
  RELATION, STATE, MAX_GOAL, PROMPT,
};
