'use strict';

/**
 * THE PRIVATE CHANNEL BETWEEN LAIN DESKTOP AND LAIN CORE.
 *
 * ------------------------------------------------------------------------
 * WHY A SECOND TRANSPORT AND NOT A SECOND SERVER.
 *
 * The Harness application used to be a page in somebody's Chrome, reached over
 * loopback HTTP, and everything that makes that safe — origin checks, a launch
 * token, a signed session cookie — exists because a BROWSER is an untrusted
 * client that anything else on the machine can also talk to. LAIN Desktop is
 * not that: it is a process LAIN started, and the relationship is already
 * trusted at launch.
 *
 * So the desktop gets a channel with no URL, no cookie, no password and no
 * listening TCP port: a Windows named pipe, created per run under a random
 * name, whose first message must carry the secret that only the process LAIN
 * spawned was given.
 *
 *     LAIN Desktop ──trusted local IPC──► Core        (this file)
 *     a browser    ──authenticated HTTP──► Core        (server.js, unchanged)
 *
 * ------------------------------------------------------------------------
 * ONE ROUTE TABLE. THIS IS THE POINT.
 *
 * Every request here goes through `routes.dispatch` — the same call
 * `server.js` makes for an HTTP request, against the same `App`. There is no
 * desktop copy of a route, of session handling, of the turn loop, of
 * permissions or of trust. A capability that reaches the desktop reaches it
 * because Core already offers it, and a rule Core enforces is enforced for the
 * desktop too, because it is the same code deciding.
 *
 * WHAT THE TRANSPORT DOES NOT DO: it does not grant anything. `gate.js`,
 * `trust.js` and `permissions.js` still decide what an answer permits — being
 * local is not being authorised, which is the mistake this file exists to
 * avoid making twice.
 */

const crypto = require('crypto');
const net = require('net');

const routes = require('./routes');

/** One line may not exceed this. The same bound the HTTP body has. */
const MAX_LINE = 8 * 1024 * 1024;

/** A connection that has not proven itself in this long is dropped. */
const HELLO_TIMEOUT_MS = 10_000;

let server = null;
let state = null;

function pipeName(id) { return `\\\\.\\pipe\\lain-harness-${id}`; }

/**
 * START THE CHANNEL. Returns what a host needs to connect and nothing a log
 * should carry: the secret is handed to the child directly, never printed.
 *
 * @returns {Promise<{ok: boolean, why?: string, pipe?: string, secret?: string}>}
 */
function start(app) {
  return new Promise((resolve) => {
    if (server && state) {
      resolve({ ok: true, already: true, pipe: state.pipe, secret: state.secret });
      return;
    }
    if (process.platform !== 'win32') {
      resolve({ ok: false, why: 'the desktop channel is a Windows named pipe' });
      return;
    }
    const id = crypto.randomBytes(12).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const pipe = pipeName(id);

    server = net.createServer((socket) => {
      // ---- THIS SOCKET BELONGS TO THIS CHANNEL, AND ONLY THIS ONE --------
      //
      // Every handler below used to read the module-level `state`, which is
      // whatever channel is current WHEN THE EVENT FIRES rather than the one
      // this connection was accepted on. That is wrong the moment Core restarts
      // its channel — an ordinary event, and one the desktop is built to
      // survive:
      //
      //   1. the old host is connected            channel A, clients 1
      //   2. `stop()` closes the server and drops `state`; the socket stays up,
      //      because closing a server does not close connections it accepted
      //   3. `start()` installs channel B, clients 0
      //   4. the new host connects                channel B, clients 1
      //   5. the OLD socket finally closes        channel B, clients 0  ← wrong
      //
      // Step 5 decremented a count belonging to a channel that socket had never
      // spoken to, and the application read as disconnected while its window was
      // sitting there connected. Found by the full smoke tier (the ordering in
      // 4/5 only inverts under load); it passed in isolation every time.
      const chan = state;
      socket.setNoDelay(true);
      let buf = '';
      let greeted = false;
      const hello = setTimeout(() => {
        if (!greeted) { try { socket.destroy(); } catch { /* gone */ } }
      }, HELLO_TIMEOUT_MS);
      if (hello.unref) hello.unref();

      const reply = (obj) => {
        if (socket.destroyed) return;
        try { socket.write(`${JSON.stringify(obj)}\n`); } catch { /* the peer went away */ }
      };

      socket.on('data', async (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.length > MAX_LINE * 2) { socket.destroy(); return; }
        let nl;
        // eslint-disable-next-line no-cond-assign
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { reply({ ok: false, why: 'unparseable message' }); continue; }

          // ---- PROVE IT FIRST -------------------------------------------
          //
          // A named pipe is reachable by anything running as this user, so the
          // pipe's NAME is not the credential. The first message must carry the
          // secret handed to the process LAIN itself started; a timing-safe
          // comparison, because a wrong answer should say nothing about how
          // wrong it was.
          if (!greeted) {
            // THIS CHANNEL'S SECRET, not the current one's: a connection proves
            // itself against the channel that accepted it or against nothing.
            const given = String((msg && msg.secret) || '');
            const want = Buffer.from(chan.secret, 'utf8');
            const got = Buffer.from(given, 'utf8');
            const ok = got.length === want.length && crypto.timingSafeEqual(got, want);
            if (!ok) { reply({ ok: false, why: 'refused' }); socket.destroy(); return; }
            greeted = true;
            clearTimeout(hello);
            chan.clients += 1;
            chan.sockets.add(socket);
            // THE TRAY (fabric/tray.js): this process feeds it now; the host gets the current quota once.
            setImmediate(() => { try { const t = require('../fabric/tray'); t.bind(app); t.changed(app, { force: true }); } catch { /* presentation only */ } });
            reply({ id: msg.id || 0, ok: true, hello: true, pid: process.pid });
            continue;
          }

          // ---- THEN IT IS AN ORDINARY REQUEST ---------------------------
          const id2 = msg.id;
          const method = String(msg.method || 'POST').toUpperCase();
          const path = String(msg.path || '');
          const body = msg.body && typeof msg.body === 'object' ? msg.body : {};
          // A REQUEST ON A CHANNEL THAT HAS BEEN STOPPED IS NOT SERVED. Core
          // took this channel down; a socket that outlived it must not still be
          // reaching routes through it.
          if (chan !== state) { reply({ id: id2, code: 409, body: { ok: false, why: 'this channel is closed' } }); socket.destroy(); return; }
          if (!path.startsWith('/api/')) { reply({ id: id2, code: 404, body: { ok: false, why: 'no such route' } }); continue; }
          try {
            const r = await routes.dispatch(app, method, path, body);
            reply({ id: id2, code: r.code, body: r.body });
          } catch (e) {
            reply({ id: id2, code: 500, body: { ok: false, why: (e && e.message) || String(e) } });
          }
        }
      });

      socket.on('error', () => { /* a host that died mid-write is not an error here */ });
      socket.on('close', () => { clearTimeout(hello); chan.sockets.delete(socket); if (greeted) chan.clients = Math.max(0, chan.clients - 1); });
    });

    server.on('error', (e) => {
      server = null;
      state = null;
      resolve({ ok: false, why: `the desktop channel could not start: ${(e && e.message) || e}` });
    });

    state = { pipe, secret, clients: 0, sockets: new Set() };
    server.listen(pipe, () => resolve({ ok: true, pipe, secret }));
  });
}

function status() {
  return state
    ? { running: true, pipe: state.pipe, clients: state.clients }
    : { running: false, pipe: null, clients: 0 };
}

/**
 * SAY SOMETHING TO THE WINDOW ITSELF — the one direction that was missing.
 *
 * ------------------------------------------------------------------------
 * EVERYTHING ELSE ON THIS CHANNEL IS A REQUEST THE RENDERER MADE. This is Core
 * speaking to the HOST, and it exists because of one thing a window can be that
 * a page cannot: hidden. When X sends LAIN to the tray, `open` has to be able
 * to bring the window back, and there was nothing that could say so — `open`
 * saw a live process, reported "already open", and left a hidden window hidden.
 *
 * DELIBERATELY NOT A ROUTE, AND DELIBERATELY NOT GENERAL. A message here
 * carries a `host` verb and nothing else; the host acts on the ones it knows
 * and forwards nothing to the renderer. It is not a way to run code in the
 * window, and the renderer never sees it. See native/host.cs `FromCore`.
 */
/**
 * TELL THE WINDOW THAT CORE STATE MOVED — the fix for polled latency.
 *
 * ------------------------------------------------------------------------
 * A POLL IS A FALLBACK, NOT A CLOCK.
 *
 * The renderer asks for `/api/state` on a timer. That is the right shape for a
 * surface that cannot be pushed to, and it was the WRONG shape for the one
 * thing a person actually watches: a turn settling. An answer that existed at
 * T appeared at up to T + the poll interval, and the application looked slower
 * than the work it was reporting — for no reason except that nobody had told
 * it to look again.
 *
 * So Core says "look now" the moment authoritative state moves. It carries NO
 * STATE: the window still reads `/api/state`, so there is exactly one read
 * model and no second version of the truth to drift. The timer stays as the
 * fallback it always should have been.
 *
 * It is not debounced or batched. A wake is a few bytes on a pipe, and a timer
 * added to smooth them out would be the delay this exists to remove.
 */
/**
 * COALESCED (2026-10-01). It was sent for EVERY turn event — every streamed text chunk — and every wake made the
 * window rebuild the whole /api/state (25–55 ms of Core's event loop each), so a streaming turn competed with its own
 * screen. The first wake goes at once; further wakes inside WAKE_COALESCE_MS become ONE trailing wake. The window still
 * sees the settled state within that window — and no longer reads it dozens of times a second.
 */
const WAKE_COALESCE_MS = 120;
let wakeAt = 0;
let wakeTimer = null;
function wake() {
  if (!server || !state || !state.clients) return { ok: false, why: 'no window is connected' };
  const now = Date.now();
  if (now - wakeAt < WAKE_COALESCE_MS) {
    if (!wakeTimer) { wakeTimer = setTimeout(() => { wakeTimer = null; wake(); }, WAKE_COALESCE_MS - (now - wakeAt)); if (wakeTimer.unref) wakeTimer.unref(); }
    return { ok: true, coalesced: true };
  }
  wakeAt = now;
  const line = `${JSON.stringify({ wake: 1 })}
`;
  let sent = 0;
  for (const socket of state.sockets) {
    if (socket.destroyed) continue;
    try { socket.write(line); sent += 1; } catch { /* the peer went away */ }
  }
  return { ok: sent > 0, sent };
}

/**
 * A CORE EVENT FOR THE RENDERER — `{event: {type, ...}}`.
 *
 * Carries a small, already-projected fact (a session's status changed) so the
 * rail updates for a session nobody is looking at without the renderer
 * re-deriving anything. The host relays every non-`host` line unchanged. It is
 * followed by the read model on the renderer's next /api/state as usual; an
 * event is never the only place a fact lives.
 */
function emit(event) {
  if (!server || !state || !state.clients) return { ok: false, why: 'no window is connected' };
  const line = `${JSON.stringify({ event })}\n`;
  let sent = 0;
  for (const socket of state.sockets) {
    if (socket.destroyed) continue;
    try { socket.write(line); sent += 1; } catch { /* the peer went away */ }
  }
  return { ok: sent > 0, sent };
}

function toHost(verb) {
  if (!server || !state || !state.clients) return { ok: false, why: 'no window is connected' };
  const line = `${JSON.stringify({ host: String(verb) })}\n`;
  let sent = 0;
  for (const socket of state.sockets) {
    if (socket.destroyed) continue;
    try { socket.write(line); sent += 1; } catch { /* the peer went away */ }
  }
  return { ok: sent > 0, sent };
}

/**
 * OPEN A SURFACE IN THE WINDOW — `{nav: {tab, section}}`, the same navigation a
 * clicked reminder or the tray sends the page. A tab and a section name from the
 * page's own list; the page ignores anything else. It carries no data.
 */
const NAV_TABS = new Set(['home', 'ide', 'chat', 'model', 'usage', 'mcp', 'settings']);
function navigate(nav) {
  if (!nav || !NAV_TABS.has(String(nav.tab))) return { ok: false, why: 'unknown surface' };
  if (!server || !state || !state.clients) return { ok: false, why: 'no window is connected' };
  const line = `${JSON.stringify({ nav: { tab: String(nav.tab), section: nav.section ? String(nav.section).slice(0, 40) : null } })}\n`;
  let sent = 0;
  for (const socket of state.sockets) {
    if (socket.destroyed) continue;
    try { socket.write(line); sent += 1; } catch { /* the peer went away */ }
  }
  return { ok: sent > 0, sent };
}

/** A window about to open should start at this surface: the page asks for it once it has booted. */
let queuedNav = null;
function queueNavigation(nav) { queuedNav = nav && NAV_TABS.has(String(nav.tab)) ? { tab: String(nav.tab), section: nav.section ? String(nav.section).slice(0, 40) : null, at: Date.now() } : null; }
function takeNavigation() { const n = queuedNav; queuedNav = null; return n && Date.now() - n.at < 120000 ? { tab: n.tab, section: n.section } : null; }

function stop() {
  if (!server) return { ok: true, stopped: false };
  try { server.close(); } catch { /* already closing */ }
  // CLOSING A SERVER DOES NOT CLOSE WHAT IT ACCEPTED. Without this the host's
  // socket stays half-open against a channel that no longer exists, and the
  // host cannot tell "Core is restarting" from "Core is ignoring me" — it just
  // waits on a pipe nobody is reading. Ending them is what makes its reconnect
  // loop start, which is the behaviour the desktop is built on.
  if (state) for (const socket of state.sockets) { try { socket.destroy(); } catch { /* already gone */ } }
  server = null;
  state = null;
  return { ok: true, stopped: true };
}

module.exports = { start, stop, status, toHost, wake, emit, navigate, queueNavigation, takeNavigation, pipeName, MAX_LINE, HELLO_TIMEOUT_MS };
