'use strict';

/** THE PRIVATE CHANNEL BETWEEN LAIN DESKTOP AND LAIN CORE. */

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

/** START THE CHANNEL. Returns what a host needs to connect and nothing a log should carry: the secret is handed to the child directly, never printed. */
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
      // THIS SOCKET BELONGS TO THIS CHANNEL, AND ONLY THIS ONE
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

          // PROVE IT FIRST
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
          // A REQUEST ON A CHANNEL THAT HAS BEEN STOPPED IS NOT SERVED.
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

/** SAY SOMETHING TO THE WINDOW ITSELF — the one direction that was missing. */
/** TELL THE WINDOW THAT CORE STATE MOVED — the fix for polled latency. */
/** COALESCED (2026-10-01). */
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

/** A CORE EVENT FOR THE RENDERER — `{event: {type, ...}}`. */
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

/** OPEN A SURFACE IN THE WINDOW — `{nav: {tab, section}}`, the same navigation a clicked reminder or the tray sends the page. */
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
  // CLOSING A SERVER DOES NOT CLOSE WHAT IT ACCEPTED.
  if (state) for (const socket of state.sockets) { try { socket.destroy(); } catch { /* already gone */ } }
  server = null;
  state = null;
  return { ok: true, stopped: true };
}

module.exports = { start, stop, status, toHost, wake, emit, navigate, queueNavigation, takeNavigation, pipeName, MAX_LINE, HELLO_TIMEOUT_MS };
