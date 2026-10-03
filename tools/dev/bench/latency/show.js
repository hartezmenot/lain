'use strict';
// node bench/latency/show.js <result.json> [baseline.json] — the in-process numbers side by side.
const fs = require('fs');
const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const b = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
const f = (s) => (s && s.n ? `${s.p50}/${s.p95}/${s.max}` : '-');
for (const [k, v] of Object.entries((a.inproc || {}).scenarios || {})) {
  const o = b && b.inproc && b.inproc.scenarios[k];
  console.log(`${k.padEnd(6)} total ${f(v.total).padEnd(20)} pre ${f(v.preRequest).padEnd(18)} between ${f(v.betweenSteps).padEnd(20)} post ${f(v.postResponse)}`);
  if (o) console.log(`${'  was'.padEnd(6)} total ${f(o.total).padEnd(20)} pre ${f(o.preRequest).padEnd(18)} between ${f(o.betweenSteps).padEnd(20)} post ${f(o.postResponse)}`);
  const m = Object.entries(v.marks || {}).map(([mk, s]) => `${mk}=${s.p50}`).join(' ');
  if (m) console.log(`       ${m}`);
}
if (a.cli) for (const [k, v] of Object.entries(a.cli)) console.log(`cli ${k} total ${f(v.total)} toRequest ${f(v.toRequest)} after ${f(v.afterResponse)}`);
