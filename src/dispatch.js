'use strict';

/**
 * CORE ASSIGNS; CAPABILITIES DO NOT VOLUNTEER (2026-09-24).
 *
 * ------------------------------------------------------------------------
 * THE DEFECT. Specialist capabilities appeared because they existed:
 * `migration_plan` was on every request and its trigger fired on "move the
 * button to the right", Laya ranked files nobody asked it to, a geometry
 * specialist (Violetto, retired 2026-09-24) was handed work outside geometry,
 * and the flagship was shown machinery it did not need to understand.
 *
 * THE RULE. Once per input, Core classifies the request deterministically and
 * decides which owner may take part — normal tools, the migration planner,
 * a Laya role, the flagship. A capability never decides it is relevant; a
 * specialist receives a bounded job from here, returns one result to Core, and
 * cannot summon another specialist (workers.js has no code path that could).
 *
 *     installed ≠ needed · available ≠ invoke · warm ≠ participate
 *     complex ≠ migration · UI task ≠ a worker · project task ≠ Laya
 *
 * This is the whole of it: an assignment on the session, read by the tool
 * vocabulary (tools/index.js), the prompt (prompt.js) and the Core hooks
 * (geometryjob.js, gugedit.js, layacontext.js, layaevidence.js), plus a
 * telemetry row per input. It is not an orchestrator and it plans nothing.
 * ------------------------------------------------------------------------
 */

const intent = require('./migrationintent');
const tech = require('./tech');

// ---- MIGRATION: A STATE TRANSITION, NOT A MULTI-STEP TASK ------------------

/** Verbs that can describe a transition. A verb alone never makes one. */
const TRANSITION_VERB = /\b(?:migrat\w*|convert(?:ed|ing|s)?|port(?:ed|ing|s)?|switch(?:ed|ing|es)?|transition\w*|translat\w*|re-?writ\w*|replac\w*|turn(?:ed|ing|s)?|chang\w*|mov\w*|merg\w*|consolidat\w*|unif\w*|split\w*|upgrad\w*|downgrad\w*|swap\w*|relocat\w*|shift\w*)\b/i;
/** The user naming a migration outright, or porting/rewriting into another technology. */
const STRONG_VERB = /\b(?:migrat\w*|port(?:ed|ing|s)?|re-?writ\w*|convert(?:ed|ing|s)?|translat\w*)\b/i;

/** Persistence, wire and data representations — the things a migration moves between. */
const REPRESENTATION = /\b(?:json|jsonl|ya?ml|toml|ini|sqlite\d?|postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|leveldb|lmdb|indexeddb|localstorage|csv|xml|protobuf|msgpack|grpc|rest|graphql|websockets?|ipc|flat[- ]files?|database|db)\b/i;
const VERSION = /\bv\d+(?:\.\d+)*\b|\bversion\s*\d+/i;
/** A version only means a contract transition when it is the version OF a contract. */
const CONTRACT_NOUN = /\b(?:schema|api|protocol|format|config(?:uration)?|ipc|message|wire|storage|database|persistence|interface|manifest)s?\b/i;
/** Units of ownership: moving one of these between owners is a transition. */
const STRUCTURE = /\b(?:repo(?:sitor(?:y|ies))?s?|monorepo|packages?|modules?|services?|subsystems?|agents?|backends?|providers?|stores?|databases?|crates?|librar(?:y|ies)|layers?|ownership|owner)\b/i;
/** A plural unit — "merge these three agents" merges established implementations. */
const PLURAL_STRUCTURE = /\b(?:repos|repositories|packages|modules|services|subsystems|agents|backends|providers|stores|databases|crates|libraries|apps|implementations)\b/i;
/** A target that names a representation the old one is being replaced BY. */
const SYSTEM_NOUN = /\b(?:system|layer|abstraction|format|schema|store|storage|api|provider|registry|backend|framework|runtime|engine|pipeline)s?\b/i;

/** Targets that are values, not representations: 8px, right, dark, 10% smaller. */
const VALUE = /^(?:-?\d[\d.,]*\s*(?:px|%|em|rem|pt|vh|vw|ms|s|x)?|left|right|top|bottom|up|down|centr?e|center|middle|start|end|front|back|smaller|larger|bigger|wider|narrower|taller|shorter|red|green|blue|black|white|gr[ae]y|yellow|orange|purple|pink|dark|light|bold|italic|true|false|on|off|visible|hidden|rem|em|px|percent|pixels?|one|two|three|four|half)$/i;
/** Visual properties: changing one of these is an edit, never a migration. */
const UI_PROPERTY = /\b(?:padding|margin|width|height|size|colou?r|font|border|radius|spacing|gap|opacity|position|alignment|align|label|text|title|icon|button|toggle|switch|lever|dimension|layout|offset|inset|shadow|z-?index|line-height|placeholder|tooltip|theme|logo|image|style|css)s?\b/i;

const COMPAT = /\b(?:compatib\w*|coexist\w*|backward\w*|side by side|alongside|keep(?:ing)?\s+(?:the\s+)?old|old\s+(?:state|data|format|files?)|backfill\w*|while\s+(?:preserving|keeping|supporting)|transition(?:al)?\s+period)\b/i;

/** "to read the JSON" is a purpose, not a destination: the loader is not becoming JSON. */
const PURPOSE_VERB = /^(?:read|write|load|save|handle|show|display|support|accept|return|call|work|be|do|make|send|parse|match|include|allow|avoid|fix|keep|get|set|find|check|run|print|log|render|pass|reflect|see|stop|start|say|point)\b/i;

const lastWord = (s) => { const w = String(s || '').trim().split(/\s+/); return w[w.length - 1] || ''; };
const tidy = (s) => String(s || '').replace(/^(?:use|using)\s+/i, '').replace(/^(?:an?|the|a new|new|our|my|this|that|these|those)\s+/i, '').replace(/[.,;:!?]+$/, '').trim();

/** What kind of thing a phrase names, or '' when it names nothing a migration can move between. */
function kindOf(phrase) {
  const p = tidy(phrase);
  if (!p) return '';
  if (PURPOSE_VERB.test(p)) return 'purpose';
  if (VALUE.test(p) || VALUE.test(lastWord(p))) return 'value';
  // A PATH ENDS IN "/" ("move this to lib/"): the empty word resolves to nothing, and used to throw here.
  for (const w of p.split(/[\s/]+/).filter(Boolean)) {
    const t = tech.resolve(w.replace(/[.,;:!?]+$/, ''));
    if (t && t.known &&!(intent.AMBIGUOUS.has(t.id) && !/^[A-Z]/.test(w))) return 'technology';
  }
  if (REPRESENTATION.test(p)) return 'persistence';
  if (VERSION.test(p)) return 'version';
  if (STRUCTURE.test(p) || SYSTEM_NOUN.test(p)) return 'structure';
  return 'thing';
}

const STRONG_KINDS = new Set(['technology', 'persistence']);
const until = '(?=$|[.;!?]|,|\\s+(?:while|and|but|so|keeping|preserving|without|because|with)\\b)';
const FROM_TO = new RegExp(`\\bfrom\\s+(.+?)\\s+(?:to|into|onto)\\s+(.+?)${until}`, 'i');
const REPLACE_WITH = /\breplac\w*\s+(.+?)\s+with\s+(.+?)(?=$|[.;!?]|,|\s+(?:while|and|but|so|keeping|preserving|without)\b)/i;
const ARROW = /([A-Za-z][\w+#./-]*)\s*(?:->|→|=>)\s*([A-Za-z][\w+#./-]*)/;
const TO_ONLY = new RegExp(`\\b(?:to|into|in|onto)\\s+(.+?)${until}`, 'i');

function result(eligible, trigger, fields = {}) {
  return { eligible, trigger, current: fields.current || '', target: fields.target || '', kind: fields.kind || '',
    boundary: fields.boundary || '', compatibility: Boolean(fields.compatibility), why: fields.why || '' };
}

/**
 * DOES THIS REQUEST DESCRIBE A REAL OLD STATE → NEW STATE TRANSITION?
 *
 * Eligible only when Core can name the current representation (or the user
 * named the migration outright and the tree will say what it is), the target
 * representation, and the boundary. A multi-step, multi-file or complicated
 * request is not one; neither is a value change ("the padding to 8px", "the
 * button to the right", "the theme to dark") however it is phrased.
 */
function migrationTransition(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s || !TRANSITION_VERB.test(s)) return result(false, 'none', { why: 'no transition verb' });
  const paths = intent.parse(s).paths || [];
  const boundary = paths.length ? paths.join(', ') : (/\b(?:whole|entire|all of|across the|project[- ]wide)\b/i.test(s) ? 'project' : 'named scope');
  const compatibility = COMPAT.test(s);
  const both = (trigger, a, b) => {
    const ka = kindOf(a); const kb = kindOf(b);
    if (ka === 'value' || kb === 'value' || kb === 'purpose') return result(false, `${trigger}:value`, { current: tidy(a), target: tidy(b), why: 'the target is a value or a purpose, not a representation' });
    if (tidy(a).toLowerCase() === tidy(b).toLowerCase()) return result(false, `${trigger}:same`, { why: 'the same thing on both sides' });
    const at = s.search(/\b(?:from|with)\b/i);
    const subject = at > 0 ? s.slice(0, at) : '';
    if (STRONG_KINDS.has(ka) || STRONG_KINDS.has(kb)) return result(true, trigger, { current: tidy(a), target: tidy(b), kind: STRONG_KINDS.has(ka) ? ka : kb, boundary, compatibility, why: 'a named representation on at least one side' });
    if (ka === 'version' && kb === 'version' && CONTRACT_NOUN.test(s)) return result(true, trigger, { current: tidy(a), target: tidy(b), kind: 'contract version', boundary, compatibility, why: 'a versioned contract changes version' });
    // A UNIT OF OWNERSHIP MOVING: "move the auth module from core to server". The owners are plain names.
    if (trigger === 'from-to' && STRUCTURE.test(subject) && !UI_PROPERTY.test(subject)) return result(true, 'ownership', { current: tidy(a), target: tidy(b), kind: 'ownership', boundary, compatibility, why: 'a unit of ownership moves between owners' });
    // AN ESTABLISHED REPRESENTATION REPLACED BY A NEW SYSTEM: "local geometry tokens with a centralized design-token system".
    if (trigger === 'replace-with' && kb === 'structure' && !UI_PROPERTY.test(tidy(b))) return result(true, trigger, { current: tidy(a), target: tidy(b), kind: 'representation', boundary, compatibility, why: 'an established representation is replaced by a new system' });
    return result(false, `${trigger}:no-representation`, { current: tidy(a), target: tidy(b), why: 'neither side names a representation, contract or owner' });
  };
  let m = ARROW.exec(s);
  if (m) return both('arrow', m[1], m[2]);
  m = FROM_TO.exec(s);
  if (m) return both('from-to', m[1], m[2]);
  m = REPLACE_WITH.exec(s);
  if (m) return both('replace-with', m[1], m[2]);
  // MERGING ESTABLISHED IMPLEMENTATIONS, OR SPLITTING A REPOSITORY.
  if (/\b(?:merg\w*|consolidat\w*|unif\w*|combin\w*)\b/i.test(s) && PLURAL_STRUCTURE.test(s) && !UI_PROPERTY.test(s)) {
    return result(true, 'merge', { current: (s.match(PLURAL_STRUCTURE) || [''])[0], target: 'one', kind: 'ownership', boundary, compatibility, why: 'several established implementations become one' });
  }
  if (/\bsplit\w*\b/i.test(s) && /\b(?:repo(?:sitory)?|monorepo)\b/i.test(s)) {
    return result(true, 'split', { current: 'one repository', target: 'several', kind: 'ownership', boundary, compatibility, why: 'a repository is split' });
  }
  // ONLY A TARGET: the user said "migrate"/"port"/"rewrite", or named a technology to move to.
  m = TO_ONLY.exec(s);
  if (m) {
    const k = kindOf(m[1]);
    if (k === 'value' || k === 'purpose') return result(false, `to:${k}`, { target: tidy(m[1]), why: `the target is a ${k}, not a representation` });
    if (STRONG_VERB.test(s) && STRONG_KINDS.has(k)) return result(true, 'strong-verb+representation', { current: '(measured from the tree)', target: tidy(m[1]), kind: k, boundary, compatibility, why: 'ported or rewritten into another technology' });
    if (/\bmigrat\w*\b/i.test(s) && !UI_PROPERTY.test(s)) {
      return result(true, 'explicit-migrate', { current: '(measured from the tree)', target: tidy(m[1]), kind: k || 'thing', boundary, compatibility, why: 'the user asked for a migration by name' });
    }
    if (STRONG_KINDS.has(k) && !UI_PROPERTY.test(s.slice(0, m.index))) return result(true, 'to-representation', { current: '(measured from the tree)', target: tidy(m[1]), kind: k, boundary, compatibility, why: 'moved onto another technology' });
    return result(false, 'to:no-representation', { target: tidy(m[1]), why: 'the target names no representation' });
  }
  return result(false, 'verb-only', { why: 'a transition verb with no target' });
}

// ---- THE ASSIGNMENT --------------------------------------------------------

/**
 * WHAT KIND OF WORK THIS IS, FOR DISPATCH. Deterministic and cheap; mode.js's
 * verdict is an input, never re-derived.
 */
/** "this", "that one", "the one here", "this dropdown": the words point, and the Harness knows at what. */
const DEICTIC = /\b(?:this|that|these|those|it|here|the one (?:here|there|i (?:selected|clicked|picked)))\b/i;

function classOf(text, mode, migration, observations = [], referent = null) {
  const s = String(text || '');
  if (migration.eligible) return 'MIGRATION';
  // A CAPTURED LIVE OBSERVATION named in the request: the work is over UI evidence.
  if (observations.length) return 'UI_EVIDENCE';
  // THE PERSON POINTED AT SOMETHING (an editor selection, a Workshop node) and
  // the request refers to it: Core resolves the referent from Harness state.
  if (referent && referent.kind && DEICTIC.test(s)) return 'SELECTION';
  let g = null;
  try { g = require('./geometryjob').parse(s); } catch { g = null; }
  if (g) return 'UI_GEOMETRY';
  if (/\b(?:computer|screen|window|ui tree|uia|accessibility|dom|browser|devtools)\b/i.test(s) && /\b(?:inspect|look|see|observe|broken|wrong|diagnos\w*|check)\b/i.test(s)) return 'UI_EVIDENCE';
  if (/\b(?:trace|flow|how does|where does|walk me through|explain)\b/i.test(s)) return 'TRACE';
  return mode === 'CHAT' || mode === 'EXPLAIN' ? 'QUESTION' : 'GENERAL';
}

/** Is a migration contract already in flight in this project? Read once per input, never per tool lookup. */
function migrationInFlight(cwd) {
  try {
    const M = require('./migration');
    const c = M.latest(cwd || '');
    return Boolean(c && c.stage !== M.STAGE.COMPLETE && c.stage !== M.STAGE.ROLLED_BACK && c.stage !== M.STAGE.FAILED);
  } catch { return false; }
}

const LEDGER_MAX = 100;

/**
 * ONE ASSIGNMENT PER INPUT (identify.js). Kept on the session for the tool
 * vocabulary and the hooks to read, and appended to `dispatchLedger`.
 */
function assign(app, text, { mode = null } = {}) {
  const session = app && app.session;
  const migration = migrationTransition(text);
  const inFlight = migration.eligible ? false : migrationInFlight(session && session.cwd);
  let observations = [];
  try { observations = require('./observationstore').mentioned(text); } catch { observations = []; }
  // WHAT THE PERSON IS POINTING AT, from Core-owned Harness state (harnesscontext.js) — never guessed.
  let referent = null;
  try { referent = require('./harnesscontext').referent(app, session); } catch { referent = null; }
  const cls = classOf(text, mode, migration, observations, referent);
  let geometry = null;
  if (cls === 'UI_GEOMETRY' || cls === 'SELECTION') { try { geometry = require('./geometryjob').parse(text); } catch { geometry = null; } }
  const d = {
    at: Date.now(),
    cls,
    migration: { ...migration, inFlight, offered: migration.eligible || inFlight || mode === 'MIGRATE', invoked: 0, ok: 0, followedBy: [] },
    geometry,
    observations,
    referent,
    text: String(text || '').slice(0, 500),
    // WHO MAY TAKE PART. Everything not named here does not.
    owners: owners(cls, migration, geometry, referent),
    jobs: [],
  };
  if (session) {
    Object.defineProperty(d, 'turnKey', { value: (session.messages || []).filter((x) => x.role === 'user').length, enumerable: false });
    session.dispatch = d;
    const l = session.dispatchLedger = Array.isArray(session.dispatchLedger) ? session.dispatchLedger : [];
    l.push(d);
    if (l.length > LEDGER_MAX) l.splice(0, l.length - LEDGER_MAX);
    // THE ROLES THIS ASSIGNMENT NAMES may prepare context IN THE BACKGROUND
    // (layacontext.js): enqueued, never awaited — optional worker delay never
    // becomes user delay.
    try { require('./layacontext').enqueue(app, session, { type: 'input', text }); } catch { /* background only */ }
  }
  return d;
}

/**
 * The owners Core allows for a class, cheapest first. A Laya role named here
 * may be DISPATCHED (in its mode: SHADOW records, AUTO/FORCE consume after
 * Core validates); it is never the one that decides it is relevant.
 */
function owners(cls, migration, geometry, referent = null) {
  switch (cls) {
    case 'MIGRATION': return ['deterministic', 'migration_planner', 'flagship'];
    case 'UI_GEOMETRY': return ['deterministic', 'flagship'];
    case 'UI_EVIDENCE': return ['deterministic', 'laya:ui_evidence_narrower', 'flagship'];
    // AN EXPLICIT SELECTION IS CORE'S (AST / GUG); Laya correlates only across surfaces or when the words are ambiguous.
    case 'SELECTION': return referent && referent.explicit
      ? ['deterministic', 'laya:cross_surface_correlator', 'flagship']
      : ['deterministic', 'laya:selection_resolver', 'laya:cross_surface_correlator', 'flagship'];
    default: return ['deterministic', 'flagship'];
  }
}

/** May Core hand work of this role to a specialist for this input? */
function allows(session, owner) {
  const d = session && session.dispatch;
  return Boolean(d && d.owners.includes(owner));
}

/** Are the migration tools part of this input's vocabulary? */
function offersMigration(session) {
  const d = session && session.dispatch;
  return Boolean(d && d.migration && d.migration.offered);
}

/** A specialist job Core dispatched, on the current assignment. */
function job(session, row) {
  const d = session && session.dispatch;
  const r = { at: Date.now(), consumed: false, late: false, redundant: false, ...row };
  if (d) d.jobs.push(r);
  return r;
}

/**
 * SETTLE THE ASSIGNMENT when the turn closes (turnclose.js), from the turn's
 * own record: was migration_plan invoked, did it answer, and was its output
 * acted on — verified, activated, or code changed after it.
 */
function settle(session, record) {
  const d = session && session.dispatch;
  if (!d || !d.migration || !record) return null;
  const acts = Array.isArray(record.actions) ? record.actions : [];
  const at = acts.findIndex((a) => a && a.name === 'migration_plan');
  d.migration.invoked = acts.filter((a) => a && a.name === 'migration_plan').length;
  d.migration.ok = acts.filter((a) => a && a.name === 'migration_plan' && a.ok !== false).length;
  d.migration.followedBy = at >= 0 ? acts.slice(at + 1).map((a) => a && a.name).filter(Boolean).slice(0, 20) : [];
  d.migration.used = Boolean(d.migration.ok && d.migration.followedBy.some((n) => USE.test(n)));
  d.settled = true;
  return d;
}
const USE = /^migration_(?:verify|activate)$|^(?:edit_file|write_file|apply_patch|replace_symbol|insert_near_symbol|remove_symbol|move_file|delete_file|insert_at|delete_range|append_file)$/;

/** Totals for `/workers` and reports. */
function summary(session) {
  const l = (session && session.dispatchLedger) || [];
  const out = { inputs: l.length, byClass: {}, migration: { eligible: 0, offered: 0, invoked: 0, used: 0, triggers: {} }, jobs: {} };
  for (const d of l) {
    out.byClass[d.cls] = (out.byClass[d.cls] || 0) + 1;
    const m = d.migration || {};
    if (m.eligible) out.migration.eligible += 1;
    if (m.offered) out.migration.offered += 1;
    if (m.invoked) out.migration.invoked += 1;
    if (m.used) out.migration.used += 1;
    out.migration.triggers[m.trigger || 'none'] = (out.migration.triggers[m.trigger || 'none'] || 0) + 1;
    for (const j of d.jobs || []) {
      const k = `${j.worker}:${j.role}`;
      const s = out.jobs[k] = out.jobs[k] || { dispatched: 0, shadow: 0, consumed: 0, late: 0, redundant: 0 };
      s.dispatched += 1; if (j.mode === 'SHADOW') s.shadow += 1; if (j.consumed) s.consumed += 1; if (j.late) s.late += 1; if (j.redundant) s.redundant += 1;
    }
  }
  return out;
}

/**
 * WHO TAKES THIS REQUEST — the conversation (BOT / Chat), the Coding Agent, or
 * "ask first" — decided ONCE, in Core, from mode.js's verdict (its mode AND its
 * intent signals) and what the surface supplies. The surface supplies FACTS
 * and PREFERENCES only:
 *
 *   surface        'ide' | 'chat'
 *   pane           the IDE sub-tab the words were typed in ('bot' | 'agent')
 *   preferred      the person's chosen route ('bot' | 'agent' | null)
 *   explicitAgent  the person asked for the Agent by name (a button)
 *
 * and never its own opinion of what the words mean (2026-09-25: the Harness
 * had grown a second classifier, and the two disagreed about "plan how to fix
 * X"). The verdict is kept on the session so identify.js consumes it for the
 * same input instead of classifying twice.
 *
 * Returns { executor: 'conversation' | 'agent' | 'propose', reason, verdict }.
 */
function route(app, text, { surface = 'ide', pane = null, preferred = null, explicitAgent = false } = {}) {
  const session = app && app.session;
  const done = (executor, reason, verdict = null) => ({ executor, reason, verdict });
  if (explicitAgent || pane === 'agent' || preferred === 'agent') return done('agent', pane === 'agent' ? 'the AGENT tab' : 'chosen');
  if (preferred === 'bot') return done('conversation', 'chosen');
  const ho = session ? require('./planhandoff').handoff(session) : null;
  const pre = Boolean(ho && ho.state === 'PREFILLED');
  if (pre && surface !== 'chat') return done('agent', 'the handoff from Chat is implementation work');
  const taskV = require('./task').classify(text, { activeTask: session && session.task });
  let projectEmpty = false;
  try { projectEmpty = typeof app.projectIsEmpty === 'function' ? app.projectIsEmpty() : false; } catch { projectEmpty = false; }
  const v = require('./mode').classify(text, { taskKind: taskV.kind, activeMode: session && session.mode, projectEmpty, joinsActiveTask: Boolean(taskV.sameTask) });
  if (session) session._routedVerdict = { text: String(text || ''), verdict: v, at: Date.now() };
  const i = v.intent || {};
  if (i.navigate || i.setting) return done('conversation', 'LAIN navigation or a setting', v);
  if (i.plan) return done('conversation', 'planning or investigation — answered, not implemented', v);
  if (i.question) return done('conversation', 'a question', v);
  if (v.readOnly) return done('conversation', `read-only (${String(v.mode).toLowerCase()})`, v);
  if (v.mode) return done(surface === 'chat' ? 'agent' : 'propose', `changes code (${String(v.mode).toLowerCase()})`, v);
  return done('conversation', 'unclassified — the conversation decides', v);
}

/** identify.js: the verdict route() already made for exactly this input, once. */
function takeRouted(session, text) {
  const r = session && session._routedVerdict;
  if (!r || r.text !== String(text || '') || Date.now() - r.at > 120000) return null;
  session._routedVerdict = null;
  return r.verdict;
}

module.exports = { route, takeRouted, migrationTransition, kindOf, assign, owners, allows, offersMigration, job, settle, summary, classOf, DEICTIC };
