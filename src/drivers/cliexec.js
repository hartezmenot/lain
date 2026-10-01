'use strict';

/**
 * RUNNING A RUNTIME'S OWN PROGRAM — owned, streamed, cancellable.
 *
 * The one way runtime adapters start a runtime process for work:
 *
 *   - NO SHELL. An npm `.cmd` shim is read to find the program it launches
 *     (a native .exe, or a .js run by node), and that program is started
 *     directly — so the pid LAIN registers IS the runtime, and stopping it
 *     stops the runtime, not a cmd.exe in front of it.
 *   - OWNED. Every process is registered in runtimeregistry.js (pid + start
 *     time, stopped with its owner). Cancel stops exactly that registered
 *     process tree; nothing is ever found or killed by name.
 *   - STREAMED. stdout is split into lines as they arrive; the caller parses
 *     them (stream-json, NDJSON, JSON-RPC). stderr is kept as a short tail for
 *     the error a person reads.
 *   - REDACTED. Anything returned for display passes through redact.js.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** Resolve a `.cmd` npm shim to { command, prefix } that starts the real program. */
function resolveShim(bin) {
  if (!bin || !/\.cmd$/i.test(bin)) return { command: bin, prefix: [] };
  let text = '';
  try { text = fs.readFileSync(bin, 'utf8'); } catch { return { command: bin, prefix: [], shim: true }; }
  const dp0 = path.dirname(bin);
  const m = /"%dp0%\\([^"]+\.(?:exe|js|cjs|mjs))"/i.exec(text);
  if (!m) return { command: bin, prefix: [], shim: true };
  const target = path.join(dp0, m[1]);
  if (/\.exe$/i.test(target)) return { command: target, prefix: [] };
  const node = fs.existsSync(path.join(dp0, 'node.exe')) ? path.join(dp0, 'node.exe') : process.execPath;
  return { command: node, prefix: [target] };
}

/**
 * START a runtime process. Returns { child, lines (async iterator), done (promise
 * of { code, stderr }), cancel() }. `onLine` may be used instead of iterating.
 */
function start(bin, args, { cwd = process.cwd(), env = {}, stdin = null, signal = null, purpose = 'runtime', label = null, spawnFn = spawn } = {}) {
  const r = resolveShim(bin);
  if (r.shim) throw new Error(`cannot start ${path.basename(bin)} without a shell`);
  const child = spawnFn(r.command, [...r.prefix, ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const recordId = require('../runtimeregistry').register(child, { purpose, label: label || path.basename(bin), command: [r.command, ...r.prefix, ...args.map((a) => (String(a).length > 80 ? `${String(a).slice(0, 77)}…` : a))].join(' '), policy: { onOwnerExit: 'stop' } });
  let stderr = '';
  const queue = []; let wake = null; let ended = false; let buf = '';
  const push = (l) => { queue.push(l); if (wake) { const w = wake; wake = null; w(); } };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l) push(l); } });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-6000); });
  const done = new Promise((resolve) => {
    child.on('error', (e) => { stderr += `\n${e.message}`; });
    child.on('close', (code) => { if (buf.trim()) push(buf.trim()); ended = true; if (wake) { const w = wake; wake = null; w(); } resolve({ code, stderr: require('../redact').text(stderr) }); });
  });
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (recordId) require('../runtimeregistry').stop(recordId);
    else { try { child.kill(); } catch { /* gone */ } }
  };
  if (signal) { if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); }
  if (stdin != null) { child.stdin.end(String(stdin)); } else child.stdin.end();
  async function* lines() {
    for (;;) {
      if (queue.length) { yield queue.shift(); continue; }
      if (ended) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r2) => { wake = r2; });
    }
  }
  return { child, pid: child.pid, recordId, lines, done, cancel, get cancelled() { return cancelled; } };
}

/** Run to completion and collect stdout (bounded). */
async function collect(bin, args, opts = {}) {
  const run = start(bin, args, opts);
  const out = [];
  let size = 0;
  const t = opts.timeoutMs ? setTimeout(() => run.cancel(), opts.timeoutMs) : null;
  for await (const l of run.lines()) { size += l.length; if (size < 2_000_000) out.push(l); }
  const d = await run.done;
  if (t) clearTimeout(t);
  return { ok: d.code === 0 && !run.cancelled, code: d.code, lines: out, stderr: d.stderr, cancelled: run.cancelled };
}

module.exports = { resolveShim, start, collect };
