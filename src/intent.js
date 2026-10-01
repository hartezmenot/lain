'use strict';

/**
 * HISTORICAL USER TURNS vs CURRENT EFFECTIVE INTENT (2026-09-18).
 *
 * A person whose provider was rate limited switches model and says it again —
 * the same request five times, plus "continue", plus one new constraint. All of
 * that is legitimate history and stays in the session. What went wrong was the
 * CARRY-FORWARD: the handover and the working context listed every one of them
 * verbatim as a current instruction, so each new model re-acquired the task and
 * narrated it ("The steer is…", "Back on the two router bugs…").
 *
 * This derives ONE current intent:
 *   · a message equivalent to what is already asked (same content words) is
 *     COLLAPSED;
 *   · "continue" / "keep going" adds nothing and is collapsed;
 *   · a message that adds content (a new constraint — "and tell me where the
 *     blockage comes from") is MERGED, only its new clause kept;
 *   · a newer message beats an older one on conflict — they are listed in order
 *     and the rendering says so.
 *
 * It is not string dedupe: equivalence is measured on content words, so
 * rewording collapses and a genuinely new ask survives.
 */

const STOP = new Set(('a an the and or but if then so to of in on at for from by with without into onto about as is are was were be been '
  + 'it its this that these those there here i you we me my your our us please just also still now again same both all any '
  + 'do does did done make made can could should would will shall may might must not no yes ok okay thanks '
  + 'continue continuing carry keep going go ahead proceed resume on with the work task bugs bug two').split(/\s+/));

const CONTINUE_ONLY = /^\s*(?:ok(?:ay)?[,.\s]*)?(?:please\s+)?(?:continue|carry on|keep going|go on|go ahead|proceed|resume|next)\b[\s.!,]*(?:please)?[\s.!]*$/i;
const LEAD = /^\s*(?:ok(?:ay)?[,.\s]*)?(?:please\s+)?(?:continue|carry on|keep going|proceed|resume)\b(?:\s+(?:with|and|on))?[\s,:.-]*/i;

function words(s) {
  // Hyphens split (`rate-limit` = `rate limit`); a trailing plural `s` folds.
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .filter((w) => (w.length > 2 || /\d/.test(w)) && !STOP.has(w)));
}

/**
 * WORKING NARRATION IS NOT DURABLE STATE (§16). Sentences that announce what
 * is about to be done, or re-acknowledge the task, carry no fact, hypothesis,
 * evidence or decision — they are dropped before anything is handed over.
 */
const NARRATION_RE = /^\s*(?:the steer is\b|back (?:on|to)\b|one (?:last|more) (?:read|look|check)\b|let me\b|let's\b|now (?:i(?:'ll| will)?|let)\b|(?:i(?:'ll| will| am going to| need to))\s+(?:now\s+)?(?:read|look|check|pull|open|inspect|continue|start)\b|reading\b|pulling\b|continuing\b|resuming\b|next,? i\b|on to\b|ok(?:ay)?,? (?:so|now)\b)/i;

/** The durable part of a note: its non-narration sentences, or ''. */
function durable(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).filter((s) => s.trim() && !NARRATION_RE.test(s)).join(' ').trim();
}

/** Does `text` ask for anything the covered words do not already hold? */
function novelty(text, covered) {
  const w = words(text);
  const fresh = [...w].filter((x) => !covered.has(x));
  return { fresh, ratio: w.size ? fresh.length / w.size : 0 };
}

/** An explicit correction is never collapsed, whatever words it shares. */
const CORRECTION_RE = /\b(?:actually|instead|rather than|no longer|scratch that|forget (?:that|it)|change of plan|override|on second thought|ignore (?:that|what i said))\b/i;
const NEGATED_RE = /\b(?:do not|don'?t|never|not|no)\s+(\w{3,})/gi;

/** Verbs the earlier text negated ("do not touch") that this text now asks for plainly. */
function flipsPolarity(text, coveredText) {
  const negated = new Set([...String(coveredText).matchAll(NEGATED_RE)].map((m) => m[1].toLowerCase()));
  if (!negated.size) return false;
  const stillNegated = new Set([...String(text).matchAll(NEGATED_RE)].map((m) => m[1].toLowerCase()));
  return [...words(text)].some((w) => negated.has(w) && !stillNegated.has(w));
}

function clauses(text) {
  return String(text || '').split(/(?<=[.;!?])\s+|\s+(?:and then|, and|; and)\s+|\n+/).map((c) => c.trim()).filter(Boolean);
}

/**
 * @param {string} objective        the task as first stated
 * @param {Array<string|{text}>} later  later user messages / steers, oldest first
 * @returns {{objective, constraints:string[], collapsed:number, total:number}}
 */
function effective(objective, later = []) {
  const covered = words(objective);
  let coveredText = String(objective || '');
  const constraints = [];
  let collapsed = 0;
  for (const raw of later) {
    const text = String((raw && raw.text) != null ? raw.text : raw || '').trim();
    if (!text) continue;
    if (CONTINUE_ONLY.test(text)) { collapsed += 1; continue; }
    const body = text.replace(LEAD, '').trim() || text;
    // A CORRECTION — explicit, or a negated ask now made plainly — is the newer
    // instruction and always survives, whole.
    if (CORRECTION_RE.test(body) || flipsPolarity(body, coveredText)) {
      constraints.push(`${body.replace(/\s+/g, ' ').slice(0, 220)} (correction — overrides anything earlier it conflicts with)`);
      coveredText += ` ${body}`;
      for (const w of words(body)) covered.add(w);
      continue;
    }
    const n = novelty(body, covered);
    if (n.fresh.length < 2 && n.ratio < 0.34) { collapsed += 1; continue; }
    // Keep only the clauses that carry the new content — the rest repeats.
    const kept = clauses(body).filter((c) => novelty(c, covered).fresh.length >= 1);
    const add = (kept.length ? kept : [body]).join(' ').replace(/\s+/g, ' ').slice(0, 220);
    constraints.push(add);
    coveredText += ` ${body}`;
    for (const w of words(body)) covered.add(w);
  }
  return { objective: String(objective || '').replace(/\s+/g, ' ').trim(), constraints, collapsed, total: later.length };
}

/** The working-context / handover rendering. Empty when there is nothing to add. */
function render(eff, { objective = true } = {}) {
  if (!eff || (!eff.constraints.length && !eff.collapsed)) return '';
  const lines = [objective
    ? 'CURRENT INTENT (resolved from everything the person said — act on this, not on each message):'
    : 'CURRENT INTENT = the Task above, plus (resolved from everything said since — act on this, not on each message):'];
  if (objective && eff.objective) lines.push(`- ${eff.objective.slice(0, 300)}`);
  for (const c of eff.constraints) lines.push(`- ${c}`);
  if (eff.constraints.length > 1) lines.push('Where these conflict, the later one wins.');
  if (eff.collapsed) lines.push(`(${eff.collapsed} repeated or "continue" message${eff.collapsed === 1 ? '' : 's'} collapsed — they asked for the same thing again; history is kept.)`);
  return lines.join('\n');
}

/**
 * THE WIRE: an earlier user message that a LATER user message repeats is
 * replaced — on the wire only — by a framed pointer, so a new model reads the
 * request once instead of five times. The first message (the objective) and
 * the latest user message are never touched; nothing is removed, so every
 * protocol still sees the same turn structure.
 *
 * NEVER A MESSAGE ALREADY SENT IN THIS CACHE LINEAGE (`frozen`, 2026-09-24).
 * Folding a repeat that already went out rewrites history: every byte after
 * it loses the provider's prefix cache and is billed again (measured: one
 * repeated question reset the cache epoch on the next request). The fold is
 * for a model that has NOT read the conversation — a new model or route, a
 * cold lineage — which is exactly when nothing is frozen.
 */
function foldRepeats(messages, { frozen = null } = {}) {
  const users = [];
  messages.forEach((m, i) => { if (m && m.role === 'user' && !m._live && !m._steer && typeof m.content === 'string') users.push(i); });
  if (users.length < 3) return messages;
  const out = messages.slice();
  const lastUser = users[users.length - 1];
  for (let k = 1; k < users.length; k++) {
    const i = users[k];
    if (i === lastUser) continue;
    if (frozen && frozen.has(messages[i])) continue;
    const text = messages[i].content;
    if (/^<lain-context>/.test(text)) continue;
    // Equivalent to ANY other request (the objective before it, or a copy after
    // it) — the first and the latest are always kept, so nothing is lost.
    const others = users.filter((j) => j !== i).map((j) => messages[j].content);
    const a = words(text);
    const repeated = CONTINUE_ONLY.test(text)
      || (a.size > 0 && others.some((t) => { const b = words(t); return [...a].filter((x) => b.has(x)).length / a.size >= 0.7; }));
    if (!repeated) continue;
    out[i] = { ...messages[i], content: '<lain-context>\nA repeat of a request the person made again (after a rate limit, a model switch or a retry). The same request is stated elsewhere in this conversation; the latest message is the current one.\n</lain-context>' };
  }
  return out;
}

module.exports = { effective, render, foldRepeats, durable, words, CONTINUE_ONLY, NARRATION_RE };
