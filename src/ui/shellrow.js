'use strict';

/** A SHELL COMMAND IN THE FEED (2026-09-23). */

const SHELL = /^(?:run_(?:bash|powershell|cmd)|python_run|process_run)$/;

function is(a) { return Boolean(a && SHELL.test(String(a.name || '')) && !a.running); }

function push(out, a) {
  const { verbOf } = require('./phrasing');
  out.push({
    kind: 'action', subject: String(a.target || ''), verb: verbOf(a.name), failed: !a.ok, path: null,
    text: `${a.ok ? '› ' : '✗› '}${a.target || a.name}`,
  });
  if (Array.isArray(a.tail) && a.tail.length) {
    // THE END OF WHAT IT SAID, the way a terminal leaves it: how much came
    // before (muted), then the last lines in the text colour.
    const earlier = (Number(a.lines) || a.tail.length) - a.tail.length;
    if (earlier > 0) out.push({ kind: 'action', text: `    (${earlier} earlier line${earlier === 1 ? '' : 's'})` });
    for (const l of a.tail) out.push({ kind: 'action', out: true, text: `    ${l}` });
  } else if (a.note && (!a.ok || a.brief)) out.push({ kind: 'action', text: `    ${a.note}` });
  else if (a.output && !a.brief) out.push({ kind: 'action', text: '    ↳ /jobs' });
  if (a.ms || a.exitCode != null) out.push({ kind: 'action', text: `    ${completion(a)}` });
}

/** `Command completed in 1.2s · exit code 0` — only what was measured. */
function completion(a) {
  const secs = a.ms ? ` in ${(a.ms / 1000).toFixed(a.ms < 10000 ? 1 : 0)}s` : '';
  const code = a.exitCode != null ? ` · exit code ${a.exitCode}` : '';
  return `Command ${a.ok ? 'completed' : 'failed'}${secs}${code}`;
}

module.exports = { is, push, completion, SHELL };
