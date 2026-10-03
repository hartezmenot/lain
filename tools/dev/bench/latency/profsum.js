'use strict';

/**
 * Summarise a V8 .cpuprofile: self and inclusive time per function and per file, restricted to Noema's own code
 * (src/) unless --all. `node bench/latency/profsum.js <file.cpuprofile> [--top 40] [--all]`
 */

const fs = require('fs');
const file = process.argv[2];
const top = Number((process.argv.indexOf('--top') >= 0 && process.argv[process.argv.indexOf('--top') + 1]) || 40);
const all = process.argv.includes('--all');
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = p.timeDeltas;
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) || 0) + (dt[i] || 0) / 1000);
const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const key = (n) => `${n.callFrame.functionName || '(anon)'} ${String(n.callFrame.url).replace(/^.*[\\/](src|bench|node_modules)[\\/]/, '$1/')}:${n.callFrame.lineNumber + 1}`;
const fileOf = (n) => String(n.callFrame.url).replace(/^.*[\\/](src)[\\/]/, '$1/');
const selfFn = new Map(); const incFn = new Map(); const selfFile = new Map(); const incFile = new Map();
let total = 0;
for (const [id, ms] of self) {
  total += ms;
  const n = byId.get(id);
  selfFn.set(key(n), (selfFn.get(key(n)) || 0) + ms);
  selfFile.set(fileOf(n), (selfFile.get(fileOf(n)) || 0) + ms);
  // inclusive: walk ancestors, count each distinct key once per sample stack
  const seenK = new Set(); const seenF = new Set();
  for (let cur = id; cur != null; cur = parent.get(cur)) {
    const a = byId.get(cur);
    const k = key(a); const f = fileOf(a);
    if (!seenK.has(k)) { seenK.add(k); incFn.set(k, (incFn.get(k) || 0) + ms); }
    if (!seenF.has(f)) { seenF.add(f); incFile.set(f, (incFile.get(f) || 0) + ms); }
  }
}
const show = (title, m, filter) => {
  process.stdout.write(`\n== ${title} ==\n`);
  [...m.entries()].filter(([k]) => all || filter(k)).sort((a, b) => b[1] - a[1]).slice(0, top)
    .forEach(([k, v]) => process.stdout.write(`${v.toFixed(0).padStart(8)} ms  ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}\n`));
};
process.stdout.write(`total sampled ${total.toFixed(0)} ms\n`);
show('inclusive by file (src/)', incFile, (k) => k.startsWith('src/'));
show('self by file', selfFile, () => true);
show('inclusive by function (src/)', incFn, (k) => / src\//.test(k));
show('self by function', selfFn, () => true);
