'use strict';

/**
 * FAST · NORMAL · ECO — the session's EXECUTION PROFILE (Simplify S5.1). Behaviour is the same in all three; only spend
 * differs, and only in these four ways:
 *
 *                                   NORMAL          FAST            ECO
 *   default effort (none chosen)    model default   lowest native   lowest native    (fabric/effortcaps.js)
 *   parallel read-only calls/step   2               4               2
 *   tool output cap (head+tail)     normal          normal          tighter          (toolbudget.js)
 *   compaction threshold            normal          normal          earlier          (compactAt)
 *
 * A profile never changes the tools array or the system prompt, so toggling it mid-session keeps the cache. An
 * explicit effort (config, session or project) wins over the profile's default, and the header says so.
 * `/fast` and `/eco` toggle; `/normal` resets. SLOW (retired) reads as ECO.
 */

const PROFILES = Object.freeze(['FAST', 'NORMAL', 'ECO']);
/** Retired profiles and what they read as now. */
const MIGRATE = Object.freeze({ SLOW: 'ECO' });

/** Independent read-only tool calls of one step run at most this many at once. */
const CONCURRENCY = Object.freeze({ FAST: 4, NORMAL: 2, ECO: 2 });
/** The tool-output cap, as a share of the normal one. */
const OUTPUT_SCALE = Object.freeze({ FAST: 1, NORMAL: 1, ECO: 0.5 });
/** Compaction starts at this share of the context window. */
const COMPACT_AT = Object.freeze({ FAST: 0.8, NORMAL: 0.8, ECO: 0.6 });
/** The context budget is the same for every profile (ECO's half budget, which stubbed results, is gone). */
const BUDGET_SCALE = Object.freeze({ FAST: 1, NORMAL: 1, ECO: 1 });

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

/** `/fast` or `/eco` again returns to NORMAL; `on`/`off` are explicit. */
function toggle(current, target, arg = '') {
  const t = normalize(target) || 'NORMAL';
  const a = String(arg || '').toLowerCase();
  if (t === 'NORMAL') return 'NORMAL';
  if (a === 'off') return 'NORMAL';
  if (a === 'on') return t;
  return normalize(current) === t ? 'NORMAL' : t;
}

const pick = (table, profile) => table[normalize(profile) || 'NORMAL'];
const scale = (profile) => pick(BUDGET_SCALE, profile);
const concurrency = (profile) => pick(CONCURRENCY, profile);
const outputScale = (profile) => pick(OUTPUT_SCALE, profile);
const compactAt = (profile) => pick(COMPACT_AT, profile);

/** Every profile may delegate: the profile changes spend, not behaviour. */
function allowsExtraAgents() { return { ok: true }; }

/** No profile adds words to the prompt. */
function guidance() { return ''; }

/** The header/composer tag: '' for NORMAL; `FAST · effort high (your setting)` when an explicit effort wins. */
function label(session) {
  const p = of(session);
  if (p === 'NORMAL') return '';
  const e = session && session._effortSeen;
  return e && e.explicit && e.effort ? `${p} · effort ${e.effort} (your setting)` : p;
}

module.exports = { PROFILES, MIGRATE, BUDGET_SCALE, CONCURRENCY, OUTPUT_SCALE, COMPACT_AT, normalize, of, set, toggle, scale, concurrency, outputScale, compactAt, allowsExtraAgents, guidance, label };
