'use strict';

/** MODEL SEARCH — split out of catalog.js because it is an ALGORITHM, not a fact about routing. */
/** SEARCH THE WAY PEOPLE TYPE. */

/** Everything about a model a person might type at it. */
function haystack(m) {
  const parts = [m.displayName, m.id];
  for (const c of m.connections || []) {
    parts.push(c.provider, c.connectionId, c.route, c.upstreamId);
    for (const u of Object.values(c.upstreamByEffort || {})) parts.push(u);
  }
  return parts.filter(Boolean).join(' ');
}

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Split on punctuation and where letters meet digits: `qwen3.8` → qwen,3,8. */
function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** How well does this model answer this query? */
function rankModel(m, qSquashed, qTokens) {
  const name = m.displayName.toLowerCase();
  const nameSquashed = squash(name);
  const idSquashed = squash(m.id);
  const nameTokens = tokenize(name);
  const allTokens = tokenize(haystack(m));

  if (nameSquashed === qSquashed || idSquashed === qSquashed) return 0;   // exact
  if (nameSquashed.startsWith(qSquashed)) return 1;                       // prefix
  if (nameSquashed.includes(qSquashed)) return 2;                         // contiguous, in the name
  if (idSquashed.includes(qSquashed)) return 3;                           // contiguous, in the id

  if (qTokens.every((t) => nameTokens.includes(t))) return 4;             // every word, in the name

  // A PREFIX OF A WORD, never a substring of one.
  const prefixOf = (t, list) => list.some((x) => x.startsWith(t));
  if (qTokens.every((t) => prefixOf(t, nameTokens))) return 5;            // every word, by prefix
  if (qTokens.every((t) => prefixOf(t, allTokens))) return 6;            // every word, incl. provider
  return -1;
}

function search(catalog, query, limit = 60) {
  const raw = String(query || '').trim();
  const all = (catalog && catalog.models) || [];
  if (!raw) return all.slice(0, limit);

  const qSquashed = squash(raw);
  const qTokens = tokenize(raw);
  if (!qSquashed) return all.slice(0, limit);

  const scored = [];
  for (const m of all) {
    const r = rankModel(m, qSquashed, qTokens);
    if (r >= 0) scored.push({ m, r });
  }

  // NOTHING SATISFIED THE AND. Rather than an empty screen, offer what matched
  // most of the query — clearly ordered, so the near-misses are visibly that.
  if (!scored.length && qTokens.length > 1) {
    for (const m of all) {
      const toks = tokenize(haystack(m));
      const hit = qTokens.filter((t) => toks.includes(t)).length;
      if (hit) scored.push({ m, r: 10 - hit });
    }
  }

  return scored
    // A shorter name containing the same words is the more specific answer:
    // for `qwen 3.7`, `qwen3.7 Max` beats `qwen3.7 Max Thinking Preview`.
    .sort((a, b) => a.r - b.r
      || a.m.displayName.length - b.m.displayName.length
      || a.m.displayName.localeCompare(b.m.displayName))
    .slice(0, limit)
    .map((x) => x.m);
}


module.exports = { search, squash, tokenize, haystack, rankModel };
