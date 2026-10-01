'use strict';

/**
 * FAST · NORMAL · ECO — the session's EXECUTION PROFILE: how much it spends to
 * get the same result. Orthogonal to AUTO/MANUAL/PLAN (authority: what may
 * happen) and to FOCUS (presentation: what is said). Every profile has the SAME
 * correctness bar — the same reads required, the same verification, the same
 * final smoke, the same permissions. Only strategy and resource use differ.
 *
 *   FAST    finish as quickly as safely possible: independent reads run in
 *           parallel (bounded), a larger context budget, delegation to
 *           subagents with DISJOINT ownership and A/B when genuinely useful.
 *           Never duplicate agents on the same files (subagents.js enforces
 *           disjoint write scopes), never skip verification.
 *   NORMAL  balanced default: the main agent first, delegation only when it
 *           clearly helps, moderate concurrency, normal budget.
 *   ECO     token economy (`/eco`): ONE agent, serial tool flow,
 *           no subagents and no A/B unless the person explicitly asks, a smaller
 *           context budget, deterministic tools used aggressively, and every
 *           tool offered with COMPACT descriptions (schemacompact.js — the one
 *           lever measured to change the payload: −14.9% input on a fixture).
 *           It never sleeps and never strips a tool; fewer TOKENS, not less care.
 *
 *   (SLOW was removed in Phase 8.1: ECO is the conservative profile. A session
 *   or config saved as SLOW reads — and is re-saved — as ECO.)
 *
 * `/fast` and `/eco` TOGGLE (profile.toggle): typing the active one again
 * returns to NORMAL; `/normal` resets.
 * Orthogonal to EFFORT (the model's reasoning depth) and to the RUN STRATEGY
 * (runstrategy.js: Normal / Phased / Long Context Phasing).
 *
 * Session preference: persisted with the session, survives a model switch and
 * a resume; a new session starts NORMAL unless `executionProfile` is configured.
 */

const PROFILES = Object.freeze(['FAST', 'NORMAL', 'ECO']);
/** Retired profiles and what they read as now. */
const MIGRATE = Object.freeze({ SLOW: 'ECO' });

/** Context budget multiplier (contextbudget.charsFor). */
// FAST WAS 1.6 — a BIGGER context for the profile meant to be quicker, i.e. more input to prefill on every request.
// Speed comes from doing less, not from carrying more (2026-10-01).
const BUDGET_SCALE = Object.freeze({ FAST: 1, NORMAL: 1, ECO: 0.5 });
/** Independent read-only tool calls of one step run at most this many at once. */
const CONCURRENCY = Object.freeze({ FAST: 4, NORMAL: 2, ECO: 1 });

function normalize(p) {
  const raw = String(p || '').toUpperCase();
  const v = MIGRATE[raw] || raw;
  return PROFILES.includes(v) ? v : null;
}

/** The profile in force. A legacy `fast: true` session reads as FAST. */
function of(session, cfg = null) {
  const set = normalize(session && session.profile);
  if (set) return set;
  if (session && session.fast) return 'FAST';
  return normalize(cfg && cfg.executionProfile) || 'NORMAL';
}

function set(session, p) {
  const v = normalize(p);
  if (!session || !v) return of(session);
  session.profile = v;
  session.fast = v === 'FAST';     // the older boolean, for anything still reading it
  return v;
}

/**
 * WHAT `/fast` OR `/eco` LEADS TO. Bare, each is a TOGGLE of its own profile:
 * FAST→/fast→NORMAL, NORMAL→/fast→FAST, ECO→/fast→FAST, and the same for ECO.
 * `on`/`off` are explicit and never flip. `/normal` is always NORMAL.
 */
function toggle(current, target, arg = '') {
  const t = normalize(target) || 'NORMAL';
  const a = String(arg || '').toLowerCase();
  if (t === 'NORMAL') return 'NORMAL';
  if (a === 'off') return 'NORMAL';
  if (a === 'on') return t;
  return normalize(current) === t ? 'NORMAL' : t;
}

const scale = (profile) => BUDGET_SCALE[normalize(profile) || 'NORMAL'];
const concurrency = (profile) => CONCURRENCY[normalize(profile) || 'NORMAL'];

/** The person explicitly asked for delegation / a comparison, overriding ECO. */
const OVERRIDE_RE = /\b(?:sub-?agents?|delegat\w*|in parallel|parallel(?:ise|ize)?|a\/b|ab[ _-]?(?:test|compare)|two (?:approaches|candidates))\b/i;

/**
 * May this session spend extra MODEL work on `delegate` / `ab_compare`?
 * ECO refuses unless the task's own words asked for it; NORMAL and FAST allow
 * (FAST's parallel split still has to be disjoint — subagents.js).
 */
function allowsExtraAgents(session, tool) {
  if (of(session) !== 'ECO') return { ok: true };
  const said = [session && session.task && session.task.objective, ...((session && session.task && session.task.steers) || []).map((s) => s && s.text)].join(' ');
  if (OVERRIDE_RE.test(said)) return { ok: true, override: true };
  return {
    ok: false,
    output: `DENIED ECO_PROFILE: ${tool} spends additional model work, and this session runs ECO (serialized token economy). `
      + 'Do the work yourself, serially, with deterministic tools first. The person can /normal or /fast, or ask for it explicitly.',
  };
}

const GUIDANCE = {
  FAST: 'Execution profile: FAST — lowest latency to a verified result. Go straight to the owner the project index or the request names; '
    + 'no preliminary surveys or exploration you do not need. Issue independent reads/searches together in one step (they run in parallel). '
    + 'Prefer the smallest change that meets the request. No subagents or A/B unless the work is genuinely parallel and large. '
    + 'Verify with the targeted check that proves THIS change — not the whole suite unless the change is broad. '
    + 'Narrate briefly: one line per finding, then act. Never skip required reads, verification or permissions.',
  NORMAL: '',
  ECO: 'Execution profile: ECO — token economy. Work alone and serially; no subagents, no A/B. Every step is a model call, so BATCH cheap deterministic '
    + 'lookups (locate, symbols, dependents, a targeted read_symbol/range) into ONE step before thinking again. Reuse project intelligence, read '
    + 'receipts and findings; never re-read what is already in context; small targeted reads, targeted tests, minimal prose, no optional exploration. '
    // Measured live 2026-09-19: ECO fixed three failures one per cycle (fix → suite → fix → suite …) and
    // spent MORE input tokens than FAST (346k vs 263k): every cycle resends the whole context.
    + 'When a run shows several failures, read and fix them all, then run the check ONCE — never a full re-run after each single fix. '
    + 'Same verification bar, and the final smoke still runs last. Never skip required reads, verification or permissions.',
};

function guidance(session) { return GUIDANCE[of(session)] || ''; }

/** The header/composer tag: '' for NORMAL — the default says nothing. */
function label(session) { const p = of(session); return p === 'NORMAL' ? '' : p; }

module.exports = { PROFILES, MIGRATE, BUDGET_SCALE, CONCURRENCY, normalize, of, set, toggle, scale, concurrency, allowsExtraAgents, guidance, label, OVERRIDE_RE };
