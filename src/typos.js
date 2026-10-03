'use strict';

/**
 * TYPO FORENSICS — the one-character defects that cost hours.
 *
 * `getUsers` written as `getUser`. `messages` written as `message`. `warth`
 * where `width` was meant. Every one of them is valid syntax, so the parser
 * says nothing; every one of them is a name that resolves to nothing, so the
 * program dies at the moment it is reached — often far from the typo, often
 * only on a path the tests do not take.
 *
 * A model reads straight past these. It is reading for MEANING, and `getUser`
 * means what `getUsers` means, so nothing snags. That is not a failure of
 * attention that more attention fixes; it is what reading for meaning IS. The
 * machine, which reads for identity rather than meaning, finds them instantly.
 *
 * THE RULE THAT MAKES IT WORTH READING: this reports a name only when it can
 * NAME WHAT WAS PROBABLY MEANT. An unresolved identifier on its own is not
 * enough — a project can reach a name in ways a scanner cannot see, and a
 * checker that flags a working file is a checker the model learns to skip past.
 * So there are two gates, and both must open:
 *
 *   1. the name resolves to nothing — not declared, not imported, not a global
 *   2. something very close to it DOES exist, in this file or this project
 *
 * With both, the report is specific enough to act on without checking:
 *
 *     src/api.js:40  getUser is not defined here. getUsers is (src/api.js:12).
 *
 * With only the first, this says nothing at all.
 */

/** Levenshtein distance, bounded. */
function distance(a, b, max = 2) {
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return max + 1;
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    let best = curr[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < best) best = curr[j];
    }
    if (best > max) return max + 1;
    const t = prev; prev = curr; curr = t;
  }
  return prev[m];
}

/** WHY THESE TWO NAMES ARE PROBABLY THE SAME NAME. */
function relation(used, candidate) {
  if (used === candidate) return null;
  const u = used.toLowerCase();
  const c = candidate.toLowerCase();

  if (u === c) return 'differs only in capitalisation';
  // SINGULAR AND PLURAL, both directions.
  if (`${u}s` === c) return 'the plural exists; this is the singular';
  if (u === `${c}s`) return 'the singular exists; this is the plural';
  if (`${u}es` === c || u === `${c}es`) return 'singular/plural mismatch';

  const len = Math.max(used.length, candidate.length);
  // Short names are excluded outright. `id` and `at` are one edit apart and are
  // not each other; below five characters the distance measure says nothing.
  if (len < 5) return null;

  // ONE NAME INSIDE THE OTHER IS A NAMING CHOICE, NOT A TYPO
  if (u.includes(c) || c.includes(u)) return null;

  const d = distance(u, c, 2);
  if (d === 1) return 'one character different';
  if (d === 2) return 'two characters different';
  return null;
}

/** The closest thing to `name` among `candidates`. */
function nearMiss(name, candidates) {
  let best = null;
  for (const c of candidates) {
    const why = relation(name, c);
    if (!why) continue;
    if (!best || c.length < best.name.length) best = { name: c, why };
  }
  return best;
}

/** Names used in a file that resolve to nothing, each with what was probably meant. */
function unresolved(model, extra = new Set()) {
  if (!model || !model.supported) return [];
  const { GLOBALS } = require('./codemodel');
  const out = [];
  const seen = new Set();
  const candidates = new Set([...model.bindings, ...extra]);

  for (const u of model.used) {
    if (seen.has(u.name)) continue;
    if (model.bindings.has(u.name) || GLOBALS.has(u.name)) continue;
    const near = nearMiss(u.name, candidates);
    // GATE TWO. No near miss, no report — see the header. An unresolved name with nothing close to it is far more likely to be something the scanner cannot…
    if (!near) continue;
    seen.add(u.name);
    out.push({ name: u.name, line: u.line, suggestion: near.name, why: near.why, calls: u.calls });
  }
  return out;
}

/** The report, phrased for a model that has just written the file. */
function report(findings, where) {
  if (!findings || !findings.length) return '';
  const rows = findings.map((f) => `  ${where}:${f.line}  ${f.name}${f.calls ? '()' : ''} is not defined here `
    + `— ${f.suggestion} is (${f.why})`);
  return `\n\nUNRESOLVED NAME${findings.length > 1 ? 'S' : ''} — valid syntax, but nothing declares `
    + `${findings.length > 1 ? 'these' : 'this'}:\n${rows.join('\n')}`;
}

module.exports = { distance, relation, nearMiss, unresolved, report };
