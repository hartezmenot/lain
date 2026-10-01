'use strict';

/**
 * A SMALL DEBUG ADAPTER speaking the real Debug Adapter Protocol over stdio,
 * for a toy language: each line of the program is `name = <number>`,
 * `name = name + <number>`, `print <name>`, `crash` (the ADAPTER dies) or
 * `null <name>` (sets a variable to null). Lines run one at a time; a
 * breakpoint stops before its line; next / stepIn / stepOut move one line
 * (stepIn and stepOut behave as next — there are no functions); continue runs
 * to the next breakpoint or the end.
 *
 * Every answer the tests read comes from here, through LAIN's DAP client.
 */

const fs = require('fs');

let seq = 0;
let buf = Buffer.alloc(0);
let program = null;
let lines = [];
let pc = 0;
const vars = {};
let bps = new Set();
let stopOnEntry = false;

function send(o) {
  const b = Buffer.from(JSON.stringify({ seq: ++seq, ...o }), 'utf8');
  process.stdout.write(`Content-Length: ${b.length}\r\n\r\n`);
  process.stdout.write(b);
}
const reply = (req, body = {}, ok = true, message = undefined) => send({ type: 'response', request_seq: req.seq, command: req.command, success: ok, body, message });
const event = (name, body = {}) => send({ type: 'event', event: name, body });

function stopped(reason) { event('stopped', { reason, threadId: 1, allThreadsStopped: true }); }

function run(untilBreakpoint) {
  while (pc < lines.length) {
    if (untilBreakpoint && bps.has(pc + 1)) { stopped('breakpoint'); return; }
    step();
    untilBreakpoint = true;
  }
  event('exited', { exitCode: 0 });
  event('terminated');
}

function step() {
  const ln = lines[pc].trim();
  pc += 1;
  let m;
  if ((m = /^(\w+)\s*=\s*(\w+)\s*\+\s*(\d+)$/.exec(ln))) vars[m[1]] = Number(vars[m[2]]) + Number(m[3]);
  else if ((m = /^(\w+)\s*=\s*(\d+)$/.exec(ln))) vars[m[1]] = Number(m[2]);
  else if ((m = /^print\s+(\w+)$/.exec(ln))) event('output', { category: 'stdout', output: `${vars[m[1]]}\n` });
  else if ((m = /^null\s+(\w+)$/.exec(ln))) vars[m[1]] = null;
  else if (ln === 'crash') process.exit(3);
}

function handle(req) {
  const a = req.arguments || {};
  switch (req.command) {
    case 'initialize': return reply(req, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true, supportsEvaluateForHovers: true });
    case 'launch':
      program = a.program;
      lines = fs.readFileSync(program, 'utf8').split(/\r?\n/).filter((l, i, all) => i < all.length - 1 || l.trim());
      stopOnEntry = Boolean(a.stopOnEntry);
      reply(req);
      event('initialized');
      return undefined;
    case 'setBreakpoints': bps = new Set((a.breakpoints || []).map((b) => b.line)); return reply(req, { breakpoints: (a.breakpoints || []).map((b) => ({ verified: b.line <= lines.length, line: b.line })) });
    case 'setExceptionBreakpoints': return reply(req);
    case 'configurationDone': reply(req); if (stopOnEntry) stopped('entry'); else setImmediate(() => run(true)); return undefined;
    case 'threads': return reply(req, { threads: [{ id: 1, name: 'main' }] });
    case 'stackTrace': return reply(req, { stackFrames: [{ id: 1, name: '<toy>', line: pc + 1, column: 1, source: { path: program, name: 'program' } }], totalFrames: 1 });
    case 'scopes': return reply(req, { scopes: [{ name: 'Locals', variablesReference: 100, expensive: false }] });
    case 'variables': return reply(req, { variables: Object.keys(vars).map((k) => ({ name: k, value: String(vars[k]), type: vars[k] === null ? 'null' : 'number', variablesReference: 0 })) });
    case 'evaluate': {
      const e = String(a.expression).trim();
      if (e in vars) return reply(req, { result: String(vars[e]), variablesReference: 0 });
      const m = /^(\w+)\s*\+\s*(\d+)$/.exec(e);
      if (m && m[1] in vars) return reply(req, { result: String(Number(vars[m[1]]) + Number(m[2])), variablesReference: 0 });
      return reply(req, {}, false, `cannot evaluate ${e}`);
    }
    case 'continue': reply(req, { allThreadsContinued: true }); setImmediate(() => { if (pc < lines.length) { step(); run(true); } else run(true); }); return undefined;
    case 'next': case 'stepIn': case 'stepOut':
      reply(req);
      setImmediate(() => { if (pc < lines.length) step(); if (pc >= lines.length) { event('exited', { exitCode: 0 }); event('terminated'); } else stopped('step'); });
      return undefined;
    case 'pause': reply(req); stopped('pause'); return undefined;
    case 'terminate': case 'disconnect': reply(req); event('terminated'); setTimeout(() => process.exit(0), 20); return undefined;
    default: return reply(req, {}, false, `unsupported ${req.command}`);
  }
}

process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf('\r\n\r\n');
    if (h < 0) return;
    const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.slice(0, h).toString())[1]);
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.slice(h + 4, h + 4 + len).toString('utf8'));
    buf = buf.slice(h + 4 + len);
    handle(msg);
  }
});
