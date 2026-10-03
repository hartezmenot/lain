'use strict';

/** ROOT-CAUSE CANDIDATES — findings that are probably one problem. */

const F = require('./findings');

/** Below this many members it is not a group, it is a finding. */
const MIN_GROUP = 2;
const MAX_GROUPS = 8;

/** The things a finding is ABOUT — the keys it can be joined on. */
function anchorsOf(f) {
  const out = new Set();
  if (f.file) out.add(`file:${f.file}`);
  if (f.symbol) out.add(`symbol:${bare(f.symbol)}`);
  if (f.actual) out.add(`symbol:${bare(f.actual)}`);
  if (f.expected) out.add(`symbol:${bare(f.expected)}`);
  for (const s of f.related.symbols) out.add(`symbol:${bare(s)}`);
  for (const r of f.related.files) out.add(`file:${String(r).split(':')[0]}`);
  for (const t of f.related.tests) out.add(`file:${String(t).split(':')[0]}`);
  return out;
}

/** `ProviderRegistry.resolve` and `resolve` are the same name for joining. */
function bare(name) {
  const s = String(name || '').trim();
  const dot = s.lastIndexOf('.');
  return dot > 0 ? s.slice(dot + 1) : s;
}

/** Union-find over findings, joined by shared anchors. */
function cluster(findings) {
  const parent = findings.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const x = find(a); const y = find(b); if (x !== y) parent[y] = x; };

  const byAnchor = new Map();
  findings.forEach((f, i) => {
    for (const a of anchorsOf(f)) {
      if (!byAnchor.has(a)) byAnchor.set(a, []);
      byAnchor.get(a).push(i);
    }
  });
  for (const [, members] of byAnchor) {
    // AN ANCHOR SHARED BY HALF THE PROJECT JOINS NOTHING.
    if (members.length > Math.max(6, findings.length * 0.5)) continue;
    for (let i = 1; i < members.length; i++) union(members[0], members[i]);
  }

  const groups = new Map();
  findings.forEach((_, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });
  return [...groups.values()].map((idx) => idx.map((i) => findings[i]));
}

/** HOW MUCH THE GROUPING EVIDENCE ACTUALLY SUPPORTS. */
function confidenceOf(members) {
  const sources = new Set(members.map((m) => m.source));
  const symbols = new Set(members.map((m) => m.symbol && bare(m.symbol)).filter(Boolean));
  const sharedSymbol = [...symbols].some((s) => members.filter((m) => m.symbol && bare(m.symbol) === s).length >= 2);
  if (sources.size >= 3 && sharedSymbol) return 'HIGH';
  if (sources.size >= 2 && sharedSymbol) return 'HIGH';
  if (sources.size >= 2) return 'MEDIUM';
  return 'LOW';
}

/** WHAT AREA THIS GROUP IS IN, said as a place rather than as a theory. */
function areaOf(members) {
  const counts = new Map();
  for (const m of members) {
    if (!m.file) continue;
    const dir = String(m.file).split('/').slice(0, -1).join('/') || '.';
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  const symbols = new Map();
  for (const m of members) {
    if (!m.symbol) continue;
    const s = bare(m.symbol);
    symbols.set(s, (symbols.get(s) || 0) + 1);
  }
  const topSymbol = [...symbols.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topSymbol && topSymbol[1] >= 2) return topSymbol[0];
  const topDir = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return topDir ? topDir[0] : 'several files';
}

/** The sentence explaining the group — INFERRED, and marked as such. */
function hypothesisFor(members, area) {
  const cats = new Set(members.map((m) => m.category));
  const has = (...c) => c.every((x) => cats.has(x));

  if (has(F.CATEGORY.MIGRATION_RESIDUE, F.CATEGORY.TEST)) {
    return `A migration around ${area} is partly done: the replacement exists, the old implementation is still `
      + 'present, and a test is failing. A test that still exercises the old path keeps it alive.';
  }
  if (has(F.CATEGORY.MIGRATION_RESIDUE, F.CATEGORY.TYPO) || has(F.CATEGORY.MIGRATION_RESIDUE, F.CATEGORY.SYMBOL)) {
    return `A migration around ${area} changed one side and not the other: something was renamed or moved, and a `
      + 'reference to the old name survives.';
  }
  if (has(F.CATEGORY.TYPE, F.CATEGORY.TEST)) {
    return `A contract around ${area} changed on one side only — a producer and a consumer no longer agree, and `
      + 'the suite is showing it.';
  }
  if (has(F.CATEGORY.SYNTAX, F.CATEGORY.TEST)) {
    return `A file in ${area} does not parse, so anything importing it fails at load. The test failures are `
      + 'very likely a consequence of that rather than separate defects.';
  }
  if (cats.size === 1) {
    return `${members.length} findings of the same kind in ${area}. They may share one cause, or simply one area.`;
  }
  return `${members.length} findings from ${new Set(members.map((m) => m.source)).size} different evidence sources `
    + `all touch ${area}.`;
}

/** Group findings into root-cause candidates. */
function candidates(findings) {
  // Informational and unverified rows are excluded from grouping: they are not defects, and letting them join clusters produces groups whose "shared…
  const material = findings.filter((f) => f.severity !== F.SEVERITY.INFO && f.severity !== F.SEVERITY.UNVERIFIED);
  if (material.length < MIN_GROUP) return [];

  const groups = cluster(material)
    .filter((g) => g.length >= MIN_GROUP)
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_GROUPS);

  return groups.map((members, i) => {
    const area = areaOf(members);
    return {
      id: `ROOT-CAUSE #${String(i + 1).padStart(3, '0')}`,
      area,
      members: [...members].sort(F.bySeverityThenFile),
      confidence: confidenceOf(members),
      hypothesis: hypothesisFor(members, area),
      sources: [...new Set(members.map((m) => m.source))],
    };
  });
}

module.exports = { candidates, cluster, anchorsOf, confidenceOf, areaOf, hypothesisFor, bare, MIN_GROUP, MAX_GROUPS };
