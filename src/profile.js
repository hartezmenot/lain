'use strict';

/** FAST · NORMAL · ECO — the session's EXECUTION PROFILE (Simplify S5.1). */

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

/**
 * LAIN EFFORT (S12a) — for a model with NO native effort (fabric/effortcaps.forRequest), Low / High / Max moves the
 * same knobs the profile sets, around the profile's own value. High is the profile unchanged. Nothing here reaches the
 * cached prefix: the system prompt and the tools array are byte-identical at every level (the tail line is in
 * simpleprompt.effortLine; the thinking switch is a request field).
 */
const LAIN_EFFORT = Object.freeze({
  low: Object.freeze({ concurrency: 2, output: 0.6, compactShift: -0.1 }),
  high: Object.freeze({ concurrency: null, output: 1, compactShift: 0 }),
  max: Object.freeze({ concurrency: 4, output: 1.5, compactShift: 0.1 }),
});
const effortOf = (e) => LAIN_EFFORT[String(e || '').toLowerCase()] || LAIN_EFFORT.high;

const pick = (table, profile) => table[normalize(profile) || 'NORMAL'];
const scale = (profile) => pick(BUDGET_SCALE, profile);
const concurrency = (profile, lainEffort = null) => effortOf(lainEffort).concurrency || pick(CONCURRENCY, profile);
const outputScale = (profile, lainEffort = null) => pick(OUTPUT_SCALE, profile) * effortOf(lainEffort).output;
const compactAt = (profile, lainEffort = null) => Math.min(0.92, Math.max(0.4, pick(COMPACT_AT, profile) + effortOf(lainEffort).compactShift));

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

module.exports = { PROFILES, MIGRATE, BUDGET_SCALE, CONCURRENCY, OUTPUT_SCALE, COMPACT_AT, LAIN_EFFORT, normalize, of, set, toggle, scale, concurrency, outputScale, compactAt, allowsExtraAgents, guidance, label };
