'use strict';

/**
 * THE DESKTOP BOUNDARY — what the native host is allowed to be.
 *
 * ------------------------------------------------------------------------
 * THE PROPERTY THESE PIN, in one sentence: LAIN Desktop is a PRESENTATION
 * HOST. It owns a window and a pipe; it owns no authority.
 *
 * That is easy to say and easy to lose. A host gains a convenience method, then
 * a "just for the desktop" shortcut, and one release later the renderer can ask
 * for things no browser client could — which is a second runtime wearing the
 * costume of a UI. These tests fail when that starts.
 *
 * The real window, the real renderer and the real turn are proven in
 * tests/smoke/desktop-real.test.js. What is here is the shape of the seam,
 * which is worth checking on every run rather than only where a desktop exists.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');

module.exports = async function () {
  await test('DESKTOP: the host decides nothing — it forwards a route and interprets none', () => {
    const src = fs.readFileSync(path.join(ROOT, 'native', 'host.cs'), 'utf8');

    // NO SECOND RUNTIME. A host that knew about sessions, tasks, permissions or
    // models would be duplicating an authority that already exists.
    for (const forbidden of ['Session', 'Permission', 'TrustLevel', 'RunTurn', 'ModelRoute']) {
      assert.ok(!new RegExp(`\\bclass\\s+${forbidden}\\b`).test(src),
        `the host must not define ${forbidden} — that authority is Core's`);
    }

    // NO ROUTE TABLE OF ITS OWN. The host forwards what the renderer asked for;
    // the moment it keeps its own list of allowed paths there are two answers
    // to "what can this application do".
    // Sorted: which order they appear in a source file is not a property worth
    // pinning, but WHICH ONES EXIST very much is.
    const routes = [...src.matchAll(/"\/api\/[a-z/]+"/gi)].map((m) => m[0]).sort();
    assert.deepStrictEqual(routes, ['"/api/desktop/drop"', '"/api/desktop/quit"', '"/api/session/new"'],
      `the host names only routes IT originates — a drop, a quit and a tray session: ${routes.join(', ')}`);
    // AND NONE OF THEM DECIDES ANYTHING. Each is a request Core answers: a file
    // the OS handed the window, a shutdown Core performs, a session Core makes.
    // The host holds no state behind any of them.
    assert.ok(!/\bif\s*\([^)]*lane\s*==/.test(src), 'the host does not interpret a lane');

    // THE RENDERER'S MESSAGE IS PASSED THROUGH, not parsed and rebuilt.
    assert.match(src, /core\.Send\(json\)/, 'a renderer request is forwarded verbatim');
  });

  await test('DESKTOP: the channel proves a secret and is not a port', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'harnessapp', 'ipc.js'), 'utf8');
    assert.match(src, /timingSafeEqual/, 'the secret is compared in constant time');
    assert.match(src, /\\\\\\\\\.\\\\pipe\\\\/, 'it is a named pipe');
    assert.ok(!/listen\(\s*\d/.test(src), 'and it never listens on a numeric port');

    // ONE ROUTE TABLE. This is the whole argument for the transport.
    assert.match(src, /routes\.dispatch\(app, method, path, body\)/,
      'every desktop request goes through the same dispatch HTTP uses');

    // AND NOTHING OUTSIDE /api IS REACHABLE THROUGH IT.
    assert.match(src, /path\.startsWith\('\/api\/'\)/, 'the channel carries API routes only');

    // ---- CORE→HOST IS A VERB, NOT A CHANNEL INTO THE RENDERER ----------
    //
    // `toHost` exists for one thing a window can be that a page cannot: hidden.
    // It must stay a closed vocabulary — a message that could carry code, a
    // route or a script would be the "renderer can do anything" hatch wearing a
    // different name. It carries `{host: <verb>}` and the host forwards none of
    // it onward.
    assert.match(src, /JSON\.stringify\(\{ host: String\(verb\) \}\)/,
      'a host message carries a verb and nothing else');
    const host = fs.readFileSync(path.join(ROOT, 'native', 'host.cs'), 'utf8');
    const verbs = [...host.matchAll(/verb ==+ "([a-z]+)"/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(verbs, ['exit', 'hide', 'show'], `a closed vocabulary: ${verbs.join(', ')}`);
    // AND A HOST MESSAGE NEVER REACHES THE PAGE.
    assert.match(host, /if \(verb != null\) \{[\s\S]*?return;\s*\}\s*ToRenderer\(json\);/,
      'a host verb is acted on and never forwarded to the renderer');
  });

  await test('DESKTOP: a restarted channel is not confused by the sockets of the old one', async () => {
    // ---- THE DEFECT, AND WHY IT ONLY SHOWED UNDER LOAD -----------------
    //
    // Core restarting its channel is an ordinary event the desktop is built to
    // survive. Every socket handler read the MODULE-LEVEL `state` — whatever
    // channel is current when the event fires — rather than the channel the
    // connection was accepted on. So:
    //
    //   the new host connects           channel B, clients 1
    //   the OLD socket finally closes   channel B, clients 0   ← wrong
    //
    // The application then read as disconnected with its window sitting there
    // connected. Which of those two happens first depends on timing, which is
    // why the full smoke tier caught it once and isolation never did.
    if (process.platform !== 'win32') return;
    const net = require('net');
    const ipc = require('../../src/harnessapp/ipc');
    const { App } = require('../../src/app');
    const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false });

    const greet = async (row) => {
      const s = net.connect(row.pipe);
      await new Promise((r, j) => { s.once('connect', r); s.once('error', j); });
      s.write(`${JSON.stringify({ id: 0, secret: row.secret })}\n`);
      await new Promise((r) => s.once('data', r));
      return s;
    };

    // A CLEAN SLATE, ASSERTED RATHER THAN ASSUMED. `start` returns the channel
    // that is already up if there is one, so a test that inherited a live
    // channel would be measuring somebody else's sockets.
    ipc.stop();
    const a = await ipc.start(app);
    assert.strictEqual(a.ok, true, a.why || '');
    assert.ok(!a.already, 'this test owns the channel it is measuring');
    assert.strictEqual(ipc.status().clients, 0, 'and it starts with no clients');
    const oldSocket = await greet(a);
    assert.strictEqual(ipc.status().clients, 1, 'the first channel has its client');

    // CORE RESTARTS ITS CHANNEL — a new pipe and a new secret, as a real
    // restart mints.
    ipc.stop();
    const b = await ipc.start(app);
    assert.strictEqual(b.ok, true, b.why || '');
    assert.notStrictEqual(b.pipe, a.pipe, 'a restart is a new pipe');

    const newSocket = await greet(b);
    assert.strictEqual(ipc.status().clients, 1, 'the new host is connected');

    // NOW THE OLD SOCKET FINALLY DIES. It belongs to a channel that no longer
    // exists and must not touch this one's count.
    //
    // WAITED FOR, NOT SLEPT THROUGH. A fixed delay makes the test say "it did
    // not break within 400ms", which is a weaker claim that gets weaker under
    // load — and load is what found the defect. Waiting on the socket's own
    // close, then letting the server's handler run, measures the thing itself.
    //
    // IT MAY ALREADY BE CLOSED, and that is the ordinary case: `stop()` ends the
    // sockets its channel accepted, which is half the fix. Waiting
    // unconditionally on a `close` that has already fired waits forever — this
    // test hung exactly that way once. Either order proves the same invariant:
    // channel A's socket never touches channel B's count.
    if (!oldSocket.destroyed) {
      await new Promise((r) => { oldSocket.once('close', r); oldSocket.destroy(); });
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(ipc.status().clients, 1,
      'a socket from the previous channel did not disconnect the current one');

    try { newSocket.destroy(); } catch { /* already gone */ }
    ipc.stop();
  });

  await test('DESKTOP: a debugging port is development-only, and gated twice', () => {
    const host = fs.readFileSync(path.join(ROOT, 'native', 'host.cs'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'src', 'desktop.js'), 'utf8');
    // THE HOST REFUSES IT WITHOUT --dev …
    assert.match(host, /args\.Has\("dev"\)\s*&&\s*!String\.IsNullOrEmpty\(debugPort\)/,
      'the host opens a port only in dev mode');
    // … AND THE LAUNCHER NEVER PASSES IT WITHOUT dev EITHER.
    assert.match(js, /if \(dev && debugPort\) args\.push\('--debug-port'/,
      'and the launcher only offers one in dev mode');
    // A RELEASE HAS NO DEVTOOLS EITHER.
    assert.match(host, /AreDevToolsEnabled = dev;/, 'devtools follow the same switch');
    assert.match(host, /AreDefaultContextMenusEnabled = dev;/, 'and so does the browser context menu');
  });

  await test('DESKTOP: the window cannot navigate away from the application', () => {
    const src = fs.readFileSync(path.join(ROOT, 'native', 'host.cs'), 'utf8');
    assert.match(src, /NavigationStarting/, 'navigation is inspected');
    assert.match(src, /e\.Cancel = true;/, 'and anything unexpected is cancelled');
    assert.match(src, /NewWindowRequested/, 'a popup is not a second application window');
    assert.match(src, /OpenExternally/, 'a real link goes to the person’s own browser');
  });

  await test('DESKTOP: a dropped file becomes an artifact, never a path handed onward', () => {
    const routes = require('../../src/harnessapp/routes');
    assert.ok(routes.ROUTES['POST /api/desktop/drop'], 'the drop route exists');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'harnessapp', 'routes.js'), 'utf8');
    const route = src.slice(src.indexOf("'POST /api/desktop/drop'"), src.indexOf("'POST /api/cowork/artifact'"));
    // IT GOES THROUGH THE EXISTING STAGING AUTHORITY, which names, bounds and
    // scopes it to the session — the same one a browser upload uses.
    assert.match(route, /cowork\/attachments'\)\.stage/, 'staging is the existing authority');
    // AND THE ABSOLUTE PATH NEVER LEAVES THIS ROUTE.
    assert.ok(!/staged\.push\([^)]*abs/.test(route), 'no absolute path is returned to the caller');
    assert.match(route, /path2\.basename\(abs\)/, 'only the base name is ever reported');
  });

  await test('DESKTOP: the application is LAUNCHED, not summoned from a command', () => {
    // ---- THE PRODUCT INVARIANT THIS REPLACES A TEST FOR -------------------
    //
    // It used to assert that `/app` opened the window and `/app browser` opened
    // the HTTP one. Both are gone (2026-09-15): `/app` was a command to conjure
    // the product from inside the other surface, which is a shape LAIN no longer
    // has, and the browser surface it could open went with the browser Harness.
    //
    // LAIN Desktop is launched like an application — a shortcut, the Start menu,
    // `LAIN.exe` — and the CLI is not in that path at all.
    assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'appcommand.js')), '/app is gone, not merely hidden');
    const commands = fs.readFileSync(path.join(ROOT, 'src', 'commands.js'), 'utf8');
    assert.ok(!/define\('\/app'/.test(commands), 'and nothing defines it');
    assert.ok(!/appcommand/.test(commands.replace(/\/\/.*$/gm, '')), 'and nothing registers it');

    // THE ENTRY POINT IS A LAUNCH. `--desktop` builds Core and a window with no
    // REPL; the host started with no pipe starts Core itself.
    const cli = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
    assert.match(cli, /opts\.desktop/, 'the CLI has a launch flag');
    const host = fs.readFileSync(path.join(ROOT, 'native', 'host.cs'), 'utf8');
    assert.match(host, /Launcher\.Start\(\)/, 'and a double-clicked host starts Core rather than refusing');

    // AND IT NEVER FALLS BACK TO A BROWSER. A native failure that quietly
    // opened Chrome would hide exactly the regression it should report.
    assert.ok(!/chrome|msedge|--app=/i.test(host.replace(/^\s*(\/\/|\*).*$/gm, '')),
      'the host names no browser to fall back to');
  });
};
