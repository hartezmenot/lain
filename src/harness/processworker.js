'use strict';

// This stable tree root survives the command's shell.
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
    const mark = `\0LAIN-EOF:${spec.eof}\0`;
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.stdout.once('end', () => process.stdout.write(mark));
    child.stderr.once('end', () => process.stderr.write(mark));
  }
  if (child.pid && process.connected) process.send({ startedPid: child.pid }, () => {});
  child.once('error', (e) => report({ error: e.message }));
  child.once('exit', (code, signal) => report({ code, signal }));
});
