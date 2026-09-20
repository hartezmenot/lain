'use strict';

/**
 * ONE LAIN — how a second launch finds the first instead of becoming a second.
 *
 * ------------------------------------------------------------------------
 * THE PROBLEM. LAIN Desktop has to be launchable on its own: from a shortcut,
 * from the Start menu, from a taskbar pin. Nobody should have to open a
 * terminal, run `lain` and type `/app` to get their application — and a window
 * that only exists because a CLI opened it is a child of a terminal, which is
 * exactly what the product is not.
 *
 * But "launchable on its own" and "one Core" are in tension. Two LAINs in one
 * account is two bot gateways polling the same Telegram token, two supervisors,
 * two model sessions, two writers on one session directory. So a direct launch
 * has to be able to DISCOVER a LAIN that is already running and hand the
 * request to it.
 *
 *                  LAIN Desktop.exe        (second launch)
 *                          │
 *                    control pipe  ──►  the LAIN already running
 *                          │                     │
 *                     (no Core found)        shows its window
 *                          │
 *                   start Core here
 *
 * ------------------------------------------------------------------------
 * WHAT THE CONTROL PIPE MAY DO, AND WHY IT IS SAFE THAT IT IS NOT AUTHENTICATED.
 *
 * This is the part to be careful about, so it is stated plainly.
 *
 * The desktop CHANNEL (harnessapp/ipc.js) carries the whole API — the
 * conversation, the sessions, a turn. It is per-run, randomly named, and its
 * first message must carry a secret handed to the child process at launch.
 * NONE of that changes, and nothing here weakens it.
 *
 * THIS pipe carries three verbs and no data:
 *
 *     show     open/focus the desktop window of the running LAIN
 *     status   is it up, since when, what is it hosting
 *     quit     shut down, through the ordinary shutdown path
 *
 * It reads no conversation, starts no turn, grants no permission, reveals no
 * credential and names no session. A Windows named pipe created with default
 * security is reachable by processes running as this user — and a process
 * running as this user can already read `~/.lain`, every transcript in it and
 * every credential beside them. So these three verbs give such a process
 * nothing it did not have, which is the ONLY reason an unauthenticated channel
 * is acceptable here. The moment a verb would carry more than this, it belongs
 * on the authenticated channel instead.
 *
 * `quit` is included deliberately: ending something is the direction that is
 * always safe to allow (see bin/lain-control.js, which exists on the same
 * principle).
 *
 * ------------------------------------------------------------------------
 * THE LOCK FILE IS A HINT, NOT A CLAIM.
 *
 * `core.json` records a pid and when it started. A pid is reused by the
 * operating system and a file survives a crash, so the file is never believed
 * on its own: liveness is decided by whether the CONTROL PIPE ANSWERS. A stale
 * lock therefore costs one failed connect and is then overwritten.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const config = require('./config');

/** How long a `discover` connect may take before the lock is called stale. */
const PROBE_MS = 1500;
/** How long a verb may take to be answered. `show` builds a window. */
const VERB_MS = 30_000;

let server = null;
let announced = null;

function lockFile() { return path.join(config.configDir(), 'core.json'); }

/**
 * The control pipe's name.
 *
 * DERIVED, NOT RANDOM — it has to be findable by a process that has no
 * relationship to this one yet. Keyed by the config directory so two LAIN
 * installations pointed at different `~/.lain` directories (a test run, a second
 * account) are genuinely separate instances rather than fighting over one name.
 */
function controlPipe() {
  const key = require('crypto').createHash('sha256')
    .update(path.resolve(config.configDir()).toLowerCase()).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\lain-core-${key}`;
}

/** Is this process id one we could plausibly still be? Cheap, and advisory. */
function alive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/** What the lock file says, or null. Never trusted on its own — see the header. */
function read() {
  try {
    const data = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch { return null; }
}

/**
 * ASK THE RUNNING LAIN SOMETHING. Resolves `null` when there is not one.
 *
 * @param {string} verb  'show' | 'status' | 'quit'
 * @returns {Promise<object|null>}
 */
function ask(verb, { timeout = VERB_MS } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(null); return; }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let sock;
    try { sock = net.connect(controlPipe()); } catch { finish(null); return; }
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* gone */ } finish(null); }, timeout);
    if (timer.unref) timer.unref();
    let buf = '';
    sock.on('connect', () => { try { sock.write(`${JSON.stringify({ verb })}\n`); } catch { /* gone */ } });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      let msg = null;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch { msg = null; }
      try { sock.end(); } catch { /* gone */ }
      finish(msg);
    });
    sock.on('error', () => { clearTimeout(timer); finish(null); });
    sock.on('close', () => { clearTimeout(timer); finish(null); });
  });
}

/**
 * IS A LAIN ALREADY RUNNING? The answer is whether it ANSWERS, not whether a
 * file exists — see the header.
 *
 * @returns {Promise<{running: boolean, pid?: number, since?: number, surface?: string}>}
 */
async function discover() {
  const lock = read();
  const reply = await ask('status', { timeout: PROBE_MS });
  if (!reply || !reply.ok) return { running: false, stale: Boolean(lock && !alive(lock.pid)) };
  return { running: true, pid: reply.pid, since: reply.since, surface: reply.surface, desktop: reply.desktop };
}

/**
 * BECOME THE LAIN THIS ACCOUNT IS RUNNING.
 *
 * Fails softly: a LAIN that cannot take the lock still works completely, it is
 * simply not the one a direct Desktop launch will find. That is the right
 * failure — refusing to start because a pipe name was taken would turn a
 * cosmetic collision into an outage.
 *
 * @returns {Promise<{ok: boolean, why?: string, pipe?: string}>}
 */
function announce(app, { surface = 'cli' } = {}) {
  return new Promise((resolve) => {
    if (announced) { resolve({ ok: true, already: true, pipe: announced.pipe }); return; }
    if (process.platform !== 'win32') { resolve({ ok: false, why: 'the control pipe is a Windows named pipe' }); return; }
    const pipe = controlPipe();
    server = net.createServer((socket) => {
      socket.setNoDelay(true);
      let buf = '';
      const reply = (obj) => { try { socket.end(`${JSON.stringify(obj)}\n`); } catch { /* the peer went away */ } };
      const cap = setTimeout(() => { try { socket.destroy(); } catch { /* gone */ } }, VERB_MS + 5000);
      if (cap.unref) cap.unref();
      socket.on('error', () => { /* a probe that gave up is normal */ });
      socket.on('data', async (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.length > 4096) { socket.destroy(); return; }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        let msg = null;
        try { msg = JSON.parse(buf.slice(0, nl)); } catch { reply({ ok: false, why: 'unparseable' }); return; }
        clearTimeout(cap);
        reply(await handle(app, String((msg && msg.verb) || ''), { surface }));
      });
    });
    server.on('error', (e) => { server = null; resolve({ ok: false, why: e.message }); });
    server.listen(pipe, () => {
      announced = { pipe, since: Date.now(), surface };
      try {
        fs.mkdirSync(config.configDir(), { recursive: true });
        fs.writeFileSync(lockFile(), JSON.stringify({
          pid: process.pid, pipe, since: announced.since, surface, host: os.hostname(),
        }, null, 2), 'utf8');
      } catch { /* the pipe is the real lock; the file is a hint */ }
      resolve({ ok: true, pipe });
    });
    if (server.unref) server.unref();
  });
}

/**
 * THE THREE VERBS. Nothing else is reachable from here, by construction: an
 * unknown verb is refused rather than falling through to anything.
 */
async function handle(app, verb, { surface }) {
  if (verb === 'status') {
    let desktop = false;
    try { desktop = require('./desktopwindow').alive(); } catch { desktop = false; }
    return { ok: true, pid: process.pid, since: announced ? announced.since : 0, surface, desktop };
  }
  if (verb === 'show') {
    // THE RUNNING LAIN OPENS ITS OWN WINDOW. The launcher that asked does not
    // get a channel, a secret or a handle — it gets a yes or a no.
    try {
      const r = await require('./desktopwindow').open(app);
      return { ok: Boolean(r.ok || r.already), already: Boolean(r.already), why: r.why || '' };
    } catch (e) { return { ok: false, why: (e && e.message) || String(e) }; }
  }
  if (verb === 'quit') {
    // THROUGH THE ONE SHUTDOWN SEQUENCE — src/teardown.js — and on the next tick
    // so this answer is written before the process starts tearing itself down.
    // A `quit` that skipped the sequence would leave exactly the orphans the
    // sequence exists to prevent.
    app.wantExit = true;
    setTimeout(async () => {
      try { await require('./teardown').shutdown(app, { why: 'you quit LAIN' }); } catch { /* going anyway */ }
      process.exit(0);
    }, 10);
    return { ok: true, quitting: true };
  }
  return { ok: false, why: `unknown verb ${verb || '(none)'}` };
}

/** Stop being the lock holder. Safe to call twice. */
function release() {
  if (server) { try { server.close(); } catch { /* already down */ } server = null; }
  if (announced) {
    const lock = read();
    if (lock && lock.pid === process.pid) { try { fs.unlinkSync(lockFile()); } catch { /* gone */ } }
    announced = null;
  }
}

/** What this process announced, or null. For `/status` and diagnostics. */
function status() {
  return announced ? { holding: true, pipe: announced.pipe, since: announced.since, surface: announced.surface } : { holding: false };
}

module.exports = { announce, discover, ask, release, status, read, controlPipe, lockFile, alive, PROBE_MS };
