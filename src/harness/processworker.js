'use strict';

// This stable tree root survives the command's shell. Its guardian terminates
// it and its descendants from outside the subtree on completion or owner death.
// It never makes task or verification decisions.
//
// END OF OUTPUT IS SAID IN-BAND (2026-10-01). When the spec carries `eof`, the command's stdout/stderr are relayed
// through this process and, once each stream has ENDED, a marker `\0NOEMA-EOF:<nonce>\0` is written on it. Order
// within a pipe is guaranteed, so the caller knows it has every byte without waiting for the whole tree to be
// killed and every pipe holder to exit — the ~160 ms that used to sit between "echo finished" and the tool result.
// A background grandchild that keeps the pipe open means no marker: the caller then waits for close, as before.
const { spawn } = require('child_process');
// Stay as an OS tree root after the shell exits. The guardian kills this tree
// from outside it, then confirms exit before releasing ownership.
setInterval(() => {}, 60_000);
process.once('message', (spec) => {
  if (!process.connected) return;
  let child;
  const relay = Boolean(spec.eof);
  const opts = { cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: relay ? ['inherit', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'] };
  const report = (message) => { if (process.connected) process.send(message, () => {}); };
  try {
    child = spec.args ? spawn(spec.command, spec.args, opts)
      : spawn(spec.command, { ...opts, shell: spec.shell || true });
  } catch (e) { report({ error: e.message }); return; }
  if (relay) {
    const mark = `\0NOEMA-EOF:${spec.eof}\0`;
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.stdout.once('end', () => process.stdout.write(mark));
    child.stderr.once('end', () => process.stderr.write(mark));
  }
  if (child.pid && process.connected) process.send({ startedPid: child.pid }, () => {});
  child.once('error', (e) => report({ error: e.message }));
  child.once('exit', (code, signal) => report({ code, signal }));
});
