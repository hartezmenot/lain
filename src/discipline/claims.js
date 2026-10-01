'use strict';

/**
 * CLAIM PROVENANCE (Execution Discipline §28) — a completion report is a set of TYPED claims, and Noema checks each
 * against what it actually observed:
 *
 *   CHANGED       something was modified          → the mutation ledger must show it
 *   VERIFIED(id)  something was checked and held   → a current check (or Preview observation) must support it
 *   INFERRED      reasoned, not observed          → accepted as stated
 *   NOT_CHECKED   explicitly not verified         → accepted as stated
 *
 * A VERIFIED claim with no supporting evidence is DOWNGRADED, never silently kept: "Windows package verified" with no
 * packaging run on record becomes NOT_CHECKED, and the person is told. Domain words need domain evidence — a passing
 * unit suite does not verify an installer, a build, or a button on screen.
 */

const TYPES = Object.freeze(['CHANGED', 'VERIFIED', 'INFERRED', 'NOT_CHECKED']);
const VERIFY_WORDS = /\b(verified|confirmed|tested|tests? (?:now )?pass(?:es|ed)?|(?:is|are) passing|passes|works(?: correctly| as expected)?|is (?:now )?working|builds? (?:cleanly|successfully)|built successfully|green)\b/i;
const NEGATION = /\b(not|n't|never|unable|cannot|could not|didn't|haven't|wasn't|unverified|untested|no longer)\b/i;

/** Words that name a kind of reality, and the commands/observations that can speak for it. */
const DOMAINS = [
  { name: 'packaging', claim: /\b(windows (?:package|installer|build)|installer|setup\.exe|msi\b|package[ds]?\b|packaging|release build|distribution)\b/i, evidence: /\b(setup|install|release|package|dist|msbuild|pkg|electron-builder|wix|nsis)\b|\.exe\b/i },
  { name: 'build', claim: /\b(build|compiles?|compiled)\b/i, evidence: /\b(build|compile|tsc|cargo|make|webpack|vite|gradle|mvn|dotnet|go build|csc)\b/i },
  { name: 'UI', claim: /\b(button|page|screen|ui|preview|click|render(?:s|ed)?|layout|moved|visible)\b/i, evidence: null /* a Preview observation */ },
  { name: 'tests', claim: /\btests?\b|\bsuite\b/i, evidence: /\b(test|jest|vitest|mocha|pytest|unittest|go test|cargo test|run\.js|spec)\b/i },
];

function words(s) { return new Set(String(s || '').toLowerCase().match(/[a-z0-9_]{4,}/g) || []); }

/** Sentences in a report that claim verification. Negated ones are not claims of success. */
function extract(text) {
  const out = [];
  for (const raw of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim();
    if (s.length < 6 || s.length > 400) continue;
    const typed = /^\s*(CHANGED|VERIFIED|INFERRED|NOT[_ ]CHECKED)\s*(?:\(([A-Z]\d+)\))?\s*[:-]\s*(.+)$/i.exec(s);
    if (typed) { out.push({ type: typed[1].toUpperCase().replace(' ', '_'), check: typed[2] || null, text: typed[3].trim() }); continue; }
    if (VERIFY_WORDS.test(s) && !NEGATION.test(s)) out.push({ type: 'VERIFIED', check: null, text: s });
  }
  return out.slice(0, 20);
}

/**
 * CROSS-CHECK. `ledger` is the task's CheckLedger, `gen` the current generation, `changed` the files the task wrote.
 * @returns claims with { accepted, as, why, checkIds }
 */
function crossCheck(claims, { ledger, gen = 0, changed = [] } = {}) {
  const checks = ledger ? ledger.all() : [];
  const current = checks.filter((c) => c.latest && c.latest.gen === gen && ['PASS', 'OBSERVED'].includes(c.latest.state));
  return (claims || []).map((cl) => {
    const type = TYPES.includes(cl.type) ? cl.type : 'VERIFIED';
    if (type === 'INFERRED' || type === 'NOT_CHECKED') return { ...cl, type, accepted: true, as: type, why: '', checkIds: [] };
    if (type === 'CHANGED') {
      const ok = changed.length > 0;
      return { ...cl, type, accepted: ok, as: ok ? 'CHANGED' : 'NOT_CHECKED', why: ok ? '' : 'Noema recorded no change in this task', checkIds: [] };
    }
    // VERIFIED
    if (cl.check) {
      const c = ledger && ledger.get(cl.check);
      const ok = Boolean(c && current.includes(c));
      return { ...cl, type, accepted: ok, as: ok ? 'VERIFIED' : 'NOT_CHECKED', why: ok ? '' : c ? `${cl.check} is not a passing check of the current state` : `${cl.check} is not a check Noema observed`, checkIds: ok ? [c.id] : [] };
    }
    const domains = DOMAINS.filter((d) => d.claim.test(cl.text));
    const support = current.filter((c) => {
      if (!domains.length) return ledger.discrimination(c, gen) !== 'LOW' || overlap(cl.text, c);
      return domains.every((d) => (d.evidence ? c.kind === 'COMMAND' && d.evidence.test(c.command || '') : c.kind === 'OBSERVATION'));
    });
    if (support.length) return { ...cl, type, accepted: true, as: 'VERIFIED', why: '', checkIds: support.map((c) => c.id).slice(0, 4) };
    const why = domains.length ? `no ${domains.map((d) => d.name).join(' + ')} evidence on record for the current state`
      : 'no current check on record exercises it';
    return { ...cl, type, accepted: false, as: 'NOT_CHECKED', why, checkIds: [] };
  });
}

function overlap(text, c) {
  const a = words(text); const b = words(`${c.command || ''} ${c.text || ''} ${c.target ? JSON.stringify(c.target) : ''}`);
  let n = 0; for (const w of a) if (b.has(w)) n += 1;
  return n >= 2;
}

module.exports = { extract, crossCheck, TYPES, DOMAINS };
