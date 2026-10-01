'use strict';

/**
 * THE CONTINUITY DIGEST (Execution Discipline §40–§41) — what a model needs to continue a task after compaction, a
 * handover or a model switch without re-deriving it, in the order that survives scarcity:
 *
 *   OUTCOME · EXPLICIT ASKS · ESTABLISHED FACTS (+provenance, freshness) · CHANGES · CHECKS (baseline → latest) ·
 *   OPEN QUESTIONS · HYPOTHESES · BLOCKERS · TEST-INTEGRITY FLAGS
 *
 * Conclusions and references only — never the evidence itself. Stale facts are marked stale rather than dropped, so
 * a model re-validates "the server is running" instead of trusting it.
 */

const MAX_LINES = 40;

function digest(life, { cwd = null, request = true } = {}) {
  const d = life && life.discipline;
  if (!d) return '';
  const c = d.contract;
  const gen = life.mutationSeq || 0;
  const changed = [...((life.evidence && life.evidence.filesChanged) || [])];
  const rel = (p) => { try { return require('path').relative(cwd || process.cwd(), String(p)).replace(/\\/g, '/'); } catch { return String(p); } };
  const out = [];
  if (c.outcome) out.push(`OUTCOME: ${c.outcome.text}`);
  else if (c.request && request) out.push(`REQUEST: ${c.request.slice(0, 200)}`);
  if (c.asks.length > 1) out.push(`ASKS: ${c.asks.map((a) => `${a.id} ${a.status === 'OPEN' ? '○' : a.status === 'DEFERRED' ? '→' : '✓'} ${a.text.slice(0, 70)}`).join(' · ')}`);
  for (const cr of c.liveCriteria()) {
    const holds = require('./arbiter').criterionHolds(cr, d, gen);
    out.push(`CRITERION ${cr.id} [${holds ? 'EVIDENCED' : cr.status}]: ${cr.text.slice(0, 120)}`);
  }
  for (const f of c.facts.slice(-10)) out.push(`FACT ${f.id}${c.fresh(f, { changed }) ? '' : ' (STALE — revalidate)'} [${f.kind.toLowerCase()}, ${f.provenance}]: ${f.text.slice(0, 140)}`);
  if (changed.length) out.push(`CHANGES (generation ${gen}): ${changed.slice(0, 12).map(rel).join(', ')}${changed.length > 12 ? ` +${changed.length - 12}` : ''}`);
  for (const k of d.checks.all().slice(-8)) {
    if (!k.latest) continue;
    const label = k.kind === 'OBSERVATION' ? `${k.tool}${k.target ? ` ${JSON.stringify(k.target).slice(0, 40)}` : ''}` : k.command.slice(0, 80);
    out.push(`CHECK ${k.id} ${label}: ${k.baseline === 'UNKNOWN' ? '' : `${k.baseline} → `}${k.latest.state}${k.latest.gen !== gen ? ' (before the latest change)' : ''} · ${d.checks.discrimination(k, gen)}/${k.realism}${k.latest.classification ? ` · ${k.latest.classification}` : ''}`);
  }
  for (const q of c.questions.filter((x) => x.status === 'OPEN')) out.push(`OPEN QUESTION ${q.id}: ${q.text.slice(0, 140)}`);
  for (const h of c.hypotheses.filter((x) => x.status === 'OPEN')) out.push(`HYPOTHESIS ${h.id}: ${h.text.slice(0, 140)}`);
  for (const b of c.blockers.filter((x) => x.status === 'OPEN')) out.push(`BLOCKER ${b.id}: ${b.text.slice(0, 140)}`);
  for (const i of d.integrity.filter((x) => x.status === 'UNDISCLOSED')) out.push(`TEST CHANGE ${i.id} ${i.kind} ${i.file} — disclose it (task_contract disclose) before claiming verification`);
  for (const s of c.scaffolding.filter((x) => x.status === 'ACTIVE')) out.push(`SCAFFOLDING ${s.path} — remove it or keep it deliberately`);
  return out.slice(0, MAX_LINES).join('\n');
}

module.exports = { digest };
