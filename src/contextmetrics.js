'use strict';

/**
 * LAIN'S OWN CONTEXT EFFICIENCY, over a time range — apart from any provider
 * cache. Read from what LAIN already records per FocusPacket
 * (<configDir>/metrics/focus.jsonl, counts only, written by focuspacket.js):
 *
 *   FocusPacket       packets built, their average size
 *   Selection reuse   packets served from the canonical Selection
 *   Evidence reuse    packets whose research artifact was reused, not rebuilt
 *   GUG reuse         UI-graph lookups answered from the graph
 *   LSP cache         language-server answers served from cache
 *   project graph     scans reused vs files rescanned
 *   full reads avoided  project files not sent because the packet chose fewer
 *
 * A figure LAIN does not record is null ("not measured"), never 0.
 */

const fs = require('fs');
const path = require('path');

function file() { return path.join(require('./config').configDir(), 'metrics', 'focus.jsonl'); }

function read({ from = 0, to = Date.now() + 1 } = {}) {
  let text = '';
  try { text = fs.readFileSync(file(), 'utf8'); } catch { return []; }
  const out = [];
  for (const ln of text.split('\n')) {
    if (!ln) continue;
    let r; try { r = JSON.parse(ln); } catch { continue; }
    if (r && Number.isFinite(r.at) && r.at >= from && r.at <= to) out.push(r);
  }
  return out;
}

function summary(range = {}) {
  const rows = read(range);
  if (!rows.length) return { packets: 0 };
  const n = (f) => rows.filter(f).length;
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const withSel = rows.filter((r) => r.selection);
  const withArt = rows.filter((r) => r.artifact);
  const withGug = rows.filter((r) => r.gug);
  const withLsp = rows.filter((r) => r.lsp && r.lsp.cached != null);
  return {
    packets: rows.length,
    avgChars: Math.round(sum('chars') / rows.length),
    approxTokens: Math.round(sum('chars') / 4),
    selection: withSel.length ? { packets: withSel.length, reused: n((r) => r.selection && r.selection.served === 'hit') } : null,
    evidence: withArt.length ? { packets: withArt.length, reused: n((r) => r.artifact && /^(hit|fresh|reused)$/.test(String(r.artifact.state))) } : null,
    gug: withGug.length ? { lookups: withGug.length, hits: n((r) => r.gug && r.gug.hit) } : null,
    lsp: withLsp.length ? { packets: withLsp.length, cached: rows.reduce((a, r) => a + (r.lsp && Number(r.lsp.cached) ? Number(r.lsp.cached) : 0), 0), requests: rows.reduce((a, r) => a + (r.lsp && Number(r.lsp.requests) ? Number(r.lsp.requests) : 0), 0) } : null,
    projectGraph: { reused: n((r) => r.projectGraph && r.projectGraph.reused), rescannedFiles: rows.reduce((a, r) => a + ((r.projectGraph && r.projectGraph.scanned) || 0), 0) },
    fullReadsAvoided: sum('fullReadsAvoided'),
    wholeFileRereads: null,
  };
}

module.exports = { read, summary, file };
