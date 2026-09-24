'use strict';
/**
 * THE OWNERSHIP BOUNDARY, per call: RAW (the router's bytes, before any LAIN
 * code) → NORMALIZED (the session's tool_calls) → EXECUTED (the tool result).
 * A difference between RAW and NORMALIZED would be LAIN's adapter; a bad name or
 * path already in RAW was generated upstream of LAIN.
 *
 *   node bench/readonly-diagnostic/analyze.js <tag> [--out <dir>]
 */
const fs = require('fs');
const path = require('path');
const outArg = process.argv.indexOf('--out');
const OUT = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(__dirname, '..', 'out', 'readonly-diagnostic');
const dir = path.join(OUT, process.argv[2]);
const wire = path.join(dir, 'wire');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const session = fs.existsSync(path.join(dir, 'session.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) : null;
const reqs = fs.readdirSync(wire).filter((f) => /-req\.json$/.test(f)).sort();

const raw = [];
for (const f of reqs) {
  const idx = f.slice(0, 3);
  const pf = path.join(wire, `${idx}-parsed.json`);
  const p = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : { note: 'no parsed response (canned/refused)' };
  const body = JSON.parse(fs.readFileSync(path.join(wire, f), 'utf8'));
  const tail = body.messages[body.messages.length - 1];
  const tailText = typeof tail.content === 'string' ? tail.content : JSON.stringify(tail.content);
  const rs = tailText.indexOf('# Runtime state');
  raw.push({ idx, finish: p.finish, status: p.status, usage: p.usage, text: (p.content || '').slice(0, 400), reasoningChars: p.reasoningChars,
    calls: (p.toolCalls || []).map((c) => ({ name: c.name, args: c.arguments })), wakeNote: rs >= 0 ? tailText.slice(rs, rs + 400).replace(/\n/g, ' ') : null,
    tools: (body.tools || []).length });
}

const msgs = (session && session.messages) || [];
const results = new Map(msgs.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m]));
const norm = [];
for (const m of msgs) if (m.role === 'assistant') for (const tc of m.tool_calls || []) {
  const r = results.get(tc.id);
  norm.push({ name: tc.name, args: tc.arguments, result: r ? String(r.content).slice(0, 220).replace(/\n/g, ' | ') : null, isError: r ? Boolean(r.isError) : null });
}

console.log(`CASE ${meta.case} (${meta.tag}) model=${meta.model} requests=${meta.requests} exit=${meta.exit} wall=${Math.round(meta.wallMs / 1000)}s`);
console.log(`mode=${session && session.mode} class=${session && session.taskClassVerdict && session.taskClassVerdict.cls}`);
const turn = session && session.turns && session.turns[session.turns.length - 1];
console.log(`turn: stop=${turn && turn.stopReason} wakeups=${turn && turn.wakeups} toolCalls=${turn && turn.toolCalls}`);
console.log(`fixture: added=${JSON.stringify(meta.fixtureDiff.added)} modified=${JSON.stringify(meta.fixtureDiff.modified)} removed=${JSON.stringify(meta.fixtureDiff.removed)}`);
console.log(`workers: ledger=${JSON.stringify((session && session.workerLedger) || []).slice(0, 600)} stats=${JSON.stringify((session && session.workerStats) || null).slice(0, 400)}`);
let k = 0;
for (const r of raw) {
  console.log(`\n[${r.idx}] finish=${r.finish} status=${r.status} tools_offered=${r.tools} usage=${JSON.stringify(r.usage)} reasoningChars=${r.reasoningChars}`);
  if (r.wakeNote) console.log(`   WAKE NOTE ON THIS REQUEST: ${r.wakeNote}`);
  if (r.text) console.log(`   TEXT: ${r.text.replace(/\n/g, ' | ')}`);
  for (const c of r.calls) {
    const n = norm[k++] || {};
    const same = n.name === c.name && JSON.stringify(safe(n.args)) === JSON.stringify(safe(c.args));
    console.log(`   RAW   ${c.name} ${c.args}`);
    console.log(`   NORM  ${n.name} ${n.args}  ${same ? '(== raw)' : '(!! DIFFERS from raw)'}`);
    console.log(`   EXEC  ${n.isError ? 'ERR ' : 'ok  '}${n.result}`);
  }
}
const finalText = turn && turn.text;
console.log(`\nFINAL TEXT: ${String(finalText || (msgs.filter((m) => m.role === 'assistant').slice(-1)[0] || {}).content || '').slice(0, 1500)}`);
function safe(s) { try { return JSON.parse(s); } catch { return s; } }
