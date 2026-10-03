'use strict';

/**
 * LAYA GATE, UI EDITION — "which control does the person mean?"
 *
 *   node bench/specialist-workers/locate/ui-gate.js
 *
 * Laya's native shape is a decision over SHORT labels, so it gets a second
 * chance on the kind of evidence it was built for: the 41 interactive controls
 * of a real page (the Harness UI, extracted from its own HTML), asked about the
 * way a person names them — by what they do, not by their id. Same arms as the
 * file gate, plus `laya-choice-all`: the choice head over EVERY control, no
 * cosine shortlist in front of it. Writes out/laya-ui-gate.json.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.LAIN_CONFIG_DIR = process.env.LAIN_CONFIG_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'lain-laya-ui-'));
const la = require('../../../src/locateassist');
const rt = require('../../../src/workerruntime');

function controls() {
  const html = require('../../../src/harnesslocation').load().html();
  const re = /<(button|input|select|a|textarea)\b([^>]*)>([^<]{0,60})/gi;
  const out = [];
  let m;
  const dec = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
  while ((m = re.exec(html))) {
    const a = m[2];
    const g = (k) => { const x = a.match(new RegExp(`${k}="([^"]*)"`)); return x ? dec(x[1]) : ''; };
    const id = g('id') || `${m[1]}${out.length}`;
    const text = [m[1], dec(m[3].trim()), g('aria-label') || g('title') || g('placeholder'), `#${id}`].filter(Boolean).join(' ');
    out.push({ id, text });
  }
  return out;
}

const Q = [
  { q: 'the gear that opens preferences', t: ['settingsBtn'] },
  { q: 'make the picture bigger', t: ['ivIn'] },
  { q: 'halt what it is doing right now', t: ['crumbStop'] },
  { q: 'the box where I type my question', t: ['ask'] },
  { q: 'preview at iPad width', t: ['button27'] },
  { q: 'take a screenshot before my change', t: ['wsBefore'] },
  { q: 'point at a component on the page to ask about it', t: ['wsPick', 'wsAttach'] },
  { q: 'submit my message', t: ['send'] },
  { q: 'jump to a file by typing its name', t: ['quickQ'] },
  { q: 'attach a document to the conversation', t: ['attachPill', 'attachFile'] },
  { q: 'check the page at every screen size', t: ['wsVerify'] },
  { q: 'the list of my earlier conversations', t: ['railBtn'] },
  { q: 'save the file I edited', t: ['srcSave'] },
  { q: 'search inside the open source file', t: ['srcFindBtn'] },
  { q: 'view the image in the Windows photo app', t: ['ivExternal'] },
  { q: 'shrink the image', t: ['ivOut'] },
  { q: 'change which AI model answers', t: ['modelPill'] },
  { q: 'restart the preview dev server', t: ['wsRestart'] },
  { q: 'refresh the preview page', t: ['wsReload'] },
  { q: 'add another folder to work in', t: ['addProjectBtn'] },
];

(async () => {
  const list = controls();
  const ids = new Set(list.map((x) => x.id));
  for (const q of Q) if (!q.t.some((t) => ids.has(t))) throw new Error(`target missing: ${q.q} -> ${q.t} (have ${[...ids].join(',')})`);
  const app = { cfg: { workers: {} } };
  const w = rt.info(app, 'laya');
  const warmed = w && w.usable ? await rt.warm(app, 'laya') : false;
  const rows = [];
  const score = (rankedIds, t) => { const i = rankedIds.findIndex((id) => t.includes(id)); return i < 0 ? null : i + 1; };
  for (const q of Q) {
    const row = { q: q.q, targets: q.t };
    let t = Date.now();
    row.lexical = { rank: score(la.lexical(q.q, list).map((r) => r.id), q.t), ms: Date.now() - t };
    if (warmed) {
      for (const [arm, req] of [['laya-cos', { mode: 'cos', k: 40 }], ['laya-choice', { mode: 'choice', k: 12 }], ['laya-choice-all', { mode: 'choice', k: 40, shortlist: 48 }]]) {
        t = Date.now();
        const r = await rt.call(app, 'laya', { op: 'rank', query: q.q, items: list, ...req }, { timeoutMs: 60000 });
        row[arm] = { rank: score(r ? r.ranked.map((x) => x.id) : [], q.t), ms: Date.now() - t, top: r && r.ranked[0] ? r.ranked[0].p : null, abstain: r ? r.abstain : null };
      }
      t = Date.now();
      const f = await la.rank(app, null, q.q, { laya: 'cos', list });
      row.fused = { rank: score(f.ranked.map((x) => x.id), q.t), ms: Date.now() - t };
    }
    rows.push(row);
    console.log(q.q.padEnd(52), Object.entries(row).filter(([k]) => !['q', 'targets'].includes(k)).map(([k, v]) => `${k} ${v.rank || '-'}`).join(' · '));
  }
  rt.stop(app);
  const arms = ['lexical', ...(warmed ? ['laya-cos', 'laya-choice', 'laya-choice-all', 'fused'] : [])];
  const summary = { at: new Date().toISOString(), controls: list.length, queries: Q.length };
  for (const a of arms) {
    const rs = rows.map((r) => r[a]);
    const ms = rs.map((x) => x.ms).sort((x, y) => x - y);
    summary[a] = {
      'hit@1': +(rs.filter((x) => x.rank === 1).length / rs.length).toFixed(3),
      'hit@3': +(rs.filter((x) => x.rank && x.rank <= 3).length / rs.length).toFixed(3),
      'hit@5': +(rs.filter((x) => x.rank && x.rank <= 5).length / rs.length).toFixed(3),
      mrr: +(rs.reduce((s, x) => s + (x.rank ? 1 / x.rank : 0), 0) / rs.length).toFixed(3),
      medianMs: ms[Math.floor(ms.length / 2)],
      ...(a.startsWith('laya-choice') ? { confidentWrong: rs.filter((x) => x.top >= 0.5 && x.rank !== 1).length, abstained: rs.filter((x) => x.abstain).length } : {}),
    };
  }
  const out = path.join(__dirname, '..', 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'laya-ui-gate.json'), JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 1));
})();
