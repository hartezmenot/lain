'use strict';

/** THE GOAL — what the user is trying to achieve. */

const crypto = require('crypto');

/** A goal is a direction, not a specification. Bounded like every other input. */
const MAX_GOAL = 2000;

/** HOW A NEW REQUEST RELATES TO THE STANDING GOAL. */
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

/** Language that CALLS OFF a direction. */
const SUPERSEDE_RE = /\b(?:stop working on|forget (?:the )?(?:previous|earlier|old)|abandon (?:the )?(?:previous|earlier|old)|(?:the )?new goal is|change (?:of )?direction|drop (?:the )?(?:previous|current|old)|instead (?:focus|work on|do)|scrap (?:the )?(?:previous|current|old))\b/i;

/** Language that RESTATES the direction rather than replacing it. */
const REFINE_RE = /\b(?:refine (?:the )?goal|narrow (?:the )?goal|broaden (?:the )?goal|(?:update|adjust|revise) (?:the )?goal)\b/i;

/** Language that explicitly carves a piece out of the standing direction. */
const CHILD_RE = /\b(?:as part of (?:the|this) goal|under (?:the|this) goal|(?:the )?(?:first|next|last) step (?:of|towards|toward))\b/i;

/** HOW DOES THIS SENTENCE STAND TO THE STANDING GOAL? */
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
    // A REPLACEMENT NAMED, OR A DIRECTION MERELY CANCELLED?
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

/** A STABLE HANDLE FOR ONE GOAL, so a fork, a work order and a resumed session can all say they are serving the SAME direction rather than an… */
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

/** Its stable id, or ''. */
function id(session) {
  const g = get(session);
  if (!g) return '';
  return g.id || idFor(g.text, g.setAt || null);
}

/** SET IT. The only mutation, and it is reached only from `/goal`. */
function set(session, value) {
  if (!session) return null;
  const t = String(value == null ? '' : value).trim().slice(0, MAX_GOAL);
  if (!t) return clear(session);
  const prev = get(session);
  const now = new Date().toISOString();
  const history = (session.goal && Array.isArray(session.goal.history)) ? session.goal.history.slice(-9) : [];
  if (prev && prev.text !== t) history.push({ text: prev.text, until: now });
  // THE SAME TEXT RE-ENTERED IS THE SAME GOAL, and keeps its id and its timestamp.
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

/** WHAT THE SYSTEM PROMPT IS TOLD, or ''. */
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

/** Put it back on a resumed session. */
function from(data) {
  if (!data || typeof data !== 'object' || !data.text) return null;
  const text_ = String(data.text).slice(0, MAX_GOAL);
  const setAt = data.setAt || null;
  return {
    // A RECORD WRITTEN BEFORE IDS EXISTED STILL GETS THE ID IT WOULD HAVE HAD.
    id: typeof data.id === 'string' && data.id ? data.id : idFor(text_, setAt),
    text: text_,
    setAt,
    updatedAt: data.updatedAt || null,
    history: Array.isArray(data.history) ? data.history.slice(-9) : [],
  };
}

// continuity --

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

/** DELETE: remove one goal. */
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
