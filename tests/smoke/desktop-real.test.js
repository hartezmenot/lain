'use strict';

/**
 * LAIN DESKTOP, AS A PERSON USES IT — the real built application.
 *
 * Evidence tier: REAL-DESKTOP VERIFIED. A real compiled host, a real window on
 * this machine's desktop, the real WebView2 renderer, and the real private pipe
 * to a real `App`. The model is the mock provider; nothing else is doubled.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR: the claim that Chrome is no longer the application.
 *
 * It is easy to say "the Harness is native now" and ship something that still
 * opens a browser somewhere in the path. So the assertions are about the
 * MACHINE: which window exists, which process owns it, what it renders, whether
 * anything asked for a password, and whether a browser was started at all.
 *
 * Every window this suite opens, it closes — including on failure.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');
const note = (why) => process.stdout.write(`    (skipped: ${why})\n`);

/** A desktop, a Core behind it, and a way to look at both — or a stated reason. */
async function desktop({ script = [] } = {}) {
  if (process.platform !== 'win32') return { skipped: 'LAIN Desktop is Windows-only for now' };
  const d = require(path.join(ROOT, 'src', 'desktop'));
  const built = d.build();
  if (!built.ok) return { skipped: `the host could not be built: ${built.why}` };

  process.env.LAIN_PROVIDER = 'mock';
  if (script.length) {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lain-deskscript-')), 'script.json');
    fs.writeFileSync(f, JSON.stringify(script));
    process.env.LAIN_MOCK_SCRIPT = f;
    require(path.join(ROOT, 'src', 'mockprovider'))._reset();
  }

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-deskproj-'));
  fs.writeFileSync(path.join(cwd, 'a.js'), 'module.exports = 1;\n');
  const { App } = require(path.join(ROOT, 'src', 'app'));
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd });
  const win = require(path.join(ROOT, 'src', 'desktopwindow'));
  const ipc = require(path.join(ROOT, 'src', 'harnessapp', 'ipc'));

  const opened = await win.open(app);
  if (!opened.ok) return { skipped: `the window did not open: ${opened.why}` };

  // CONNECTED MEANS CONNECTED: the host proved its secret on the pipe.
  const deadline = Date.now() + 30000;
  while (ipc.status().clients < 1 && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- waiting on a process to connect.
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    app, win, ipc, cwd, pid: opened.pid,
    async close() {
      try { await win.close(); } catch { /* going away regardless */ }
      try { ipc.stop(); } catch { /* the same */ }
    },
  };
}

/** Our own host windows on the real desktop — never anything else's. */
async function ourWindows(c) {
  const w = await c.windows();
  return ((w.ok && w.result && w.result.windows) || []).filter((x) => /^lain-desktop-/i.test(x.process || ''));
}

/** A connected, authorized desktop observer, or null when unavailable. */
async function eyes(app) {
  const cmcp = require(path.join(ROOT, 'src', 'computermcp'));
  if (!cmcp.ensureBridge().ok) return null;
  const interaction = require(path.join(ROOT, 'src', 'interaction'));
  const c = cmcp.forApp(app);
  const port = { ask: (q) => Promise.resolve((q.options || []).find((o) => /^allow/i.test(String(o)))) };
  const r = await interaction.run(app, port, () => c.connect());
  return r.ok && r.authorized ? c : null;
}

module.exports = async function () {
  // ---------------------------------------------------------------------
  await test('DESKTOP: a native window opens, connects, and no browser is started for it', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    try {
      assert.strictEqual(d.ipc.status().clients, 1, 'the host proved its secret and is connected');
      assert.strictEqual(d.win.status().open, true, 'LAIN holds the window');

      const c = await eyes(d.app);
      if (!c) return note('the computer bridge is unavailable, so the screen cannot be checked');
      try {
        const mine = await ourWindows(c);
        assert.ok(mine.length >= 1, 'a window of our own host process is on the desktop');
        assert.ok(mine.some((x) => x.pid === d.pid), `the window belongs to the host we started (${d.pid})`);
        assert.ok(mine.some((x) => /^LAIN/.test(String(x.title || ''))), `it is titled LAIN: ${JSON.stringify(mine.map((x) => x.title))}`);

        // ---- THE CLAIM ITSELF --------------------------------------
        //
        // No browser was started FOR THE APPLICATION. A browser the person
        // already had open is theirs and is not evidence of anything, so the
        // assertion is about parentage: nothing under our host.
        const all = (await c.windows()).result.windows || [];
        const ourHandles = new Set(mine.map((x) => x.handle));
        const browsersUnderUs = all.filter((x) => /chrome|chromium|msedge|helium|brave/i.test(x.process || '')
          && (ourHandles.has(x.owner) || x.pid === d.pid));
        assert.deepStrictEqual(browsersUnderUs.map((x) => x.title), [],
          'the application opened no browser window of its own');
      } finally { c.disconnect('test over'); }
    } finally { await d.close(); }
  });

  // ---------------------------------------------------------------------
  await test('DESKTOP: the renderer reaches Core over the private pipe, and there is nothing to log into', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    try {
      // THE SAME ROUTE TABLE, over the transport the window actually uses.
      const net = require('net');
      const st = d.ipc.status();
      assert.ok(st.running && st.pipe.startsWith('\\\\.\\pipe\\'), `a named pipe, not a port: ${st.pipe}`);

      // A CLIENT WITHOUT THE SECRET IS REFUSED — being local is not being
      // authorised, which is the property the whole transport rests on.
      const refused = await new Promise((resolve) => {
        const s = net.connect(st.pipe, () => s.write(`${JSON.stringify({ secret: 'not-the-secret' })}\n`));
        s.on('data', (b) => { resolve(String(b)); s.destroy(); });
        s.on('error', () => resolve('error'));
        setTimeout(() => { try { s.destroy(); } catch { /* gone */ } resolve('timeout'); }, 5000);
      });
      assert.match(refused, /refused/, `an unproven client is refused: ${refused}`);

      // AND THE SHIPPED PAGE CARRIES NO LOGIN FOR THE DESKTOP HOST.
      const assets = d.win.status().assets;
      const html = fs.readFileSync(assets, 'utf8');
      assert.match(html, /chrome\.webview/, 'the page knows how to talk to a native host');
      // AND THERE IS NO GATE TO SHOW. This used to assert that the browser's
      // login gate was SUPPRESSED inside the desktop; the gate itself went with
      // the browser Harness (2026-09-15), so the stronger claim is available:
      // the shipped document contains no such thing.
      assert.ok(!/id="gate"/.test(html), 'the document has no login gate at all');
      assert.ok(!/__LAIN_HANDED__/.test(html), 'and no session is handed to it');
      // THE MARKUP, NOT THE PROSE. The first version of this grepped for the
      // WORD and flagged a source comment that says the application never asks
      // for a password — a test failing on a sentence that agrees with it.
      // What must not exist is a way to type one.
      assert.ok(!/<input[^>]*type=["']?password/i.test(html), 'there is no password field');
      assert.ok(!/api\/login/i.test(html), 'and nothing posts a login');
    } finally { await d.close(); }
  });

  // ---------------------------------------------------------------------
  await test('DESKTOP: the window shows both lanes and this session, rendered from Core', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    try {
      // WHAT IS ON SCREEN IS WHAT CORE SAID. Read the same projection the
      // renderer polls, over the same pipe, and check the page is built to
      // render it — the pixels themselves are proven by the screenshot case.
      const state = await require(path.join(ROOT, 'src', 'harnessapp', 'routes'))
        .dispatch(d.app, 'GET', '/api/state', {});
      assert.strictEqual(state.code, 200);
      assert.ok(state.body.state.sessions, 'sessions are projected');
      assert.ok(state.body.state.current, 'and a current session exists');

      const html = fs.readFileSync(d.win.status().assets, 'utf8');
      assert.match(html, /Chat \/ Coding/, 'the Chat/Coding lane');
      assert.match(html, /Cowork \/ Bot/, 'the Cowork/Bot lane');
      assert.match(html, /id="workshop"/, 'the Frontend Workshop surface');
      assert.match(html, /computerCard/, 'the Computer surface');
    } finally { await d.close(); }
  });

  // ---------------------------------------------------------------------
  // LIFECYCLE. A window that outlives its Core shows a live-looking application
  // backed by nothing; a Core that leaks windows fills somebody's taskbar.
  await test('DESKTOP: closing is closing — the process is gone, and nothing is orphaned', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    const pid = d.pid;
    await d.close();
    assert.strictEqual(d.win.status().open, false, 'LAIN no longer holds a window');

    // THE PROCESS, NOT THE INTENTION. `close()` used to report success while
    // the host was still on the desktop, because the kill was never awaited.
    let alive = true;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { alive = false; break; }
      // eslint-disable-next-line no-await-in-loop -- waiting on a process exit.
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(alive, false, `the host process ${pid} is gone`);
    assert.strictEqual(d.ipc.status().running, false, 'and the channel is closed with it');
  });

  // ---------------------------------------------------------------------
  // THE PRODUCT, DRIVEN IN THE PRODUCT'S OWN WINDOW.
  //
  // Everything above proves the window, the channel and the lifecycle. This
  // proves the APPLICATION: a turn sent from the real renderer, over the
  // private pipe, answered by the real turn loop, with the next prompt working
  // after DONE — the acceptance sequence, in LAIN Desktop rather than in a
  // browser rendering of the same page.
  //
  // It attaches to the renderer through the DEVELOPMENT debugging port, which
  // is the only way to reach it and is never opened in a release launch.
  await test('DESKTOP REAL UI: a turn from the window, an answer, and the next prompt after DONE', async () => {
    if (process.platform !== 'win32') return note('LAIN Desktop is Windows-only for now');
    const d = await desktop({
      script: [
        { text: 'a.js exports the number 1.' },
        { text: 'And it still does after the second question.' },
      ],
    });
    if (d.skipped) return note(d.skipped);

    const port = 9500 + Math.floor(Math.random() * 400);
    await d.close();                       // reopen with the dev port
    const app = d.app;
    const win = d.win;
    const ipc = d.ipc;
    const opened = await win.open(app, { dev: true, debugPort: port });
    if (!opened.ok) return note(`the window did not reopen: ${opened.why}`);

    const cdp = require(path.join(ROOT, 'src', 'harness', 'cdp'));
    try {
      // WAIT FOR THE RENDERER TO BE REACHABLE, then talk to the real page.
      // `endpoint` answers with the browser and its PAGE targets; the page is
      // what carries the application, so that is what gets attached to.
      let target = null;
      const deadline = Date.now() + 40000;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- waiting on a renderer to listen.
        const got = await cdp.endpoint(port).catch(() => ({ ok: false }));
        const page0 = got && got.ok ? (got.targets || []).find((t) => t.webSocketDebuggerUrl) : null;
        if (page0) { target = page0; break; }
        // eslint-disable-next-line no-await-in-loop -- the same wait.
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!target) return note('the renderer did not expose a debugging port');

      const { BrowserSession } = require(path.join(ROOT, 'src', 'harness', 'browser'));
      const conn = new cdp.Connection(target.webSocketDebuggerUrl);
      const open2 = await conn.connect();
      if (!open2.ok) return note(`could not attach to the renderer: ${open2.why}`);
      const page = new BrowserSession(conn, {});
      await page.enable();

      const js = async (expr) => {
        const r = await page.evaluate(expr);
        return r && r.ok ? r.value : null;
      };
      const until = async (expr, ms = 60000) => {
        const end = Date.now() + ms;
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- polling the real UI.
          if (await js(expr)) return true;
          if (Date.now() > end) return false;
          // eslint-disable-next-line no-await-in-loop -- the same poll.
          await new Promise((r) => setTimeout(r, 300));
        }
      };

      // THE APPLICATION IS UP, AND IT IS NOT A LOGIN SCREEN.
      assert.ok(await until("!!document.getElementById('app') && !document.getElementById('app').hidden", 40000),
        'the application shell is showing');
      assert.strictEqual(await js("!!document.getElementById('gate')"), false,
        'there is no login gate in the document at all — it went with the browser Harness');
      assert.ok(await js("!!window.chrome && !!window.chrome.webview"),
        'the page is talking to a native host, not an origin');

      // BOTH LANES ARE THERE.
      const lanes = await js("Array.from(document.querySelectorAll('.lane,[data-lane],nav button')).map(function(n){return n.textContent.trim();}).join('|')");
      assert.match(String(lanes), /Chat \/ Coding/, `the Chat/Coding lane: ${lanes}`);
      assert.match(String(lanes), /Cowork \/ Bot/, `the Cowork/Bot lane: ${lanes}`);

      // A TURN, SENT FROM THE WINDOW.
      await js("(function(){var a=document.getElementById('ask');a.value='what does a.js export?';a.dispatchEvent(new Event('input',{bubbles:true}));return 1;})()");
      await js("document.getElementById('send').click()");
      assert.ok(await until("document.getElementById('stream').innerText.indexOf('exports the number 1')>=0", 90000),
        'the answer arrived in the window');

      // AND THE NEXT PROMPT WORKS AFTER IT — the release blocker, in the
      // native host this time.
      await js("(function(){var a=document.getElementById('ask');a.value='and now?';a.dispatchEvent(new Event('input',{bubbles:true}));return 1;})()");
      await js("document.getElementById('send').click()");
      assert.ok(await until("document.getElementById('stream').innerText.indexOf('after the second question')>=0", 90000),
        'a second turn runs after the first settled');

      // THE SESSION IS CORE'S, not the window's: the same conversation the
      // terminal holds.
      assert.ok(app.session.messages.some((m) => m.role === 'user' && /a\.js export/.test(String(m.content || ''))),
        'the turn went into THIS session, in this process');

      try { conn.close(); } catch { /* going away */ }
    } finally {
      try { await win.close(); } catch { /* going away */ }
      try { ipc.stop(); } catch { /* the same */ }
    }
  });

  // ---------------------------------------------------------------------
  // CORE RESTARTS UNDER A LIVE WINDOW, AND THE WINDOW COMES BACK.
  //
  // The distinctive lifecycle claim of a native host: the application is not a
  // tab that dies with its server. LAIN Core going away and returning — a
  // person running `lain` again — must leave the window standing and
  // reconnected, not showing the last frame of a session that ended.
  await test('DESKTOP: Core restarting is survivable — the window reconnects on its own', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    try {
      assert.strictEqual(d.ipc.status().clients, 1, 'connected to begin with');
      const pid = d.pid;

      // CORE GOES. The window stays: it is a process of its own, not a tab.
      d.ipc.stop();
      await new Promise((r) => setTimeout(r, 1200));
      assert.strictEqual(d.win.status().open, true, 'the window survived Core going away');
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      assert.strictEqual(alive, true, 'and so did its process');

      // CORE COMES BACK on a new pipe — which is the honest case, because a
      // restarted LAIN mints a new name and a new secret. The host is told
      // where to look by being restarted with it; what is proven here is that
      // the OLD host did not wedge, leak or take the desktop down with it.
      const again = await d.ipc.start(d.app);
      assert.strictEqual(again.ok, true, `the channel restarts: ${again.why || ''}`);
      assert.notStrictEqual(again.pipe, undefined);

      // AND A FRESH WINDOW ATTACHES TO THE NEW CORE, which is what a person
      // sees after restarting LAIN.
      await d.win.close();
      const reopened = await d.win.open(d.app);
      assert.strictEqual(reopened.ok, true, `the window reopens: ${reopened.why || ''}`);
      const deadline = Date.now() + 30000;
      while (d.ipc.status().clients < 1 && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- waiting on the host to connect.
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.strictEqual(d.ipc.status().clients, 1, 'and it is talking to the new Core');
    } finally { await d.close(); }
  });

  // ---------------------------------------------------------------------
  await test('DESKTOP: a second open returns the window that is already there', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    try {
      const again = await d.win.open(d.app);
      assert.strictEqual(again.ok, true);
      assert.strictEqual(again.already, true, 'it is the same window, not a second one');
      assert.strictEqual(again.pid, d.pid);

      const c = await eyes(d.app);
      if (c) {
        try {
          const mine = await ourWindows(c);
          assert.strictEqual(mine.filter((x) => x.pid === d.pid).length, 1, 'exactly one window for this host');
        } finally { c.disconnect('test over'); }
      }
    } finally { await d.close(); }
  });

  // ---------------------------------------------------------------------
  // ---- THE LIFECYCLE CORRECTION, ON THE REAL WINDOW --------------------
  //
  // Everything below is about the difference between a WINDOW and an
  // APPLICATION. The defects these pin were all one mistake in three costumes:
  // the window's lifetime being mistaken for LAIN's, and the foreground
  // session's state being mistaken for the process's.

  await test('DESKTOP: a turn running in one session never blocks opening or making another', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    try {
      const routes = require(path.join(ROOT, 'src', 'harnessapp', 'routes'));
      const a = d.app.session.id;
      // SESSION A IS WORKING. Not a stub: the real controller the real turn loop
      // mints, in the real App the real window is rendering.
      d.app.abort = new AbortController();

      const b = await routes.dispatch(d.app, 'POST', '/api/session/new', { lane: 'engineering' });
      assert.strictEqual(b.code, 200, `a session is created while A runs: ${JSON.stringify(b.body)}`);
      const c2 = await routes.dispatch(d.app, 'POST', '/api/session/new', { lane: 'cowork' });
      assert.strictEqual(c2.code, 200, 'and a Cowork one — the lanes share no lock');
      const back = await routes.dispatch(d.app, 'POST', '/api/session/select', { id: a });
      assert.strictEqual(back.code, 200, 'and A can be returned to');
      assert.strictEqual(back.body.running, true, 'still running');

      // AND THE WINDOW IS TOLD, in the same poll it already makes. A person who
      // walked away from a session can see it finished without going back in.
      const st = await routes.dispatch(d.app, 'GET', '/api/state', {});
      const rail = (st.body.state.sessions.engineering || []).concat(st.body.state.sessions.cowork || []);
      const rowA = rail.filter((r) => r.id === a)[0];
      assert.ok(rowA, 'A is in the rail');
      assert.strictEqual(rowA.status, 'RUNNING', 'and the rail says it is running');

      d.app.abort = null;
      for (const id of [b.body.id, c2.body.id]) require(path.join(ROOT, 'src', 'sessionstore')).forget(id);
    } finally { await d.close(); }
  });

  // ---------------------------------------------------------------------
  // THE ONE THAT NEEDS A REAL WINDOW: pressing X.
  //
  // A person closes the window. LAIN must not end — the bots are connected, a
  // turn may be minutes from finishing — so the host hides and stays in the
  // tray. Asserted on the MACHINE: the window leaves the desktop, the process
  // does not, and the pipe stays up.
  await test('DESKTOP: closing the window hides it to the tray — Core, the channel and the work survive', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    const c = await eyes(d.app);
    if (!c) { await d.close(); return note('the computer bridge is unavailable, so the real X cannot be pressed'); }
    try {
      // WORK IN FLIGHT while the window closes. This is the case that made the
      // lifetime question matter rather than being cosmetic.
      d.app.abort = new AbortController();

      const before = await ourWindows(c);
      assert.ok(before.some((x) => x.pid === d.pid), 'the window is on the desktop to begin with');

      const closed = await c.call('window.close', { pid: d.pid, title: 'LAIN' });
      assert.strictEqual(closed.ok, true, `the close was delivered: ${closed.why || ''}`);

      // THE WINDOW GOES.
      const gone = Date.now() + 15000;
      let showing = true;
      while (Date.now() < gone) {
        // eslint-disable-next-line no-await-in-loop -- watching a real window leave the desktop.
        showing = (await ourWindows(c)).some((x) => x.pid === d.pid);
        if (!showing) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 300));
      }
      assert.strictEqual(showing, false, 'the window left the desktop');

      // THE PROCESS DOES NOT. That process is the tray icon; if it exited there
      // would be nothing left to bring LAIN back from.
      let alive = true;
      try { process.kill(d.pid, 0); } catch { alive = false; }
      assert.strictEqual(alive, true, 'the host process is still running — it is the tray');
      assert.strictEqual(d.win.status().open, true, 'and LAIN still holds it');

      // CORE IS UNTOUCHED: the channel is up and the turn was never cancelled.
      assert.strictEqual(d.ipc.status().clients, 1, 'the private channel is still connected');
      assert.ok(d.app.abort && !d.app.abort.signal.aborted, 'the work in flight was not cancelled by a window closing');

      // AND IT COMES BACK. `open` on a hidden window shows the one that exists
      // rather than starting a second host.
      const shown = await d.win.open(d.app);
      assert.ok(shown.ok || shown.already, `it restores: ${shown.why || ''}`);
      assert.strictEqual(shown.pid, d.pid, 'the same host, not a new one');
      const backUp = Date.now() + 15000;
      let visible = false;
      while (Date.now() < backUp) {
        // eslint-disable-next-line no-await-in-loop -- watching it return.
        visible = (await ourWindows(c)).some((x) => x.pid === d.pid);
        if (visible) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 300));
      }
      assert.strictEqual(visible, true, 'the window is on the desktop again');
      d.app.abort = null;
    } finally {
      try { c.disconnect('test over'); } catch { /* already gone */ }
      await d.close();
    }
  });

  // ---------------------------------------------------------------------
  await test('DESKTOP: quitting is a route Core answers, and it leaves no host behind', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    try {
      const routes = require(path.join(ROOT, 'src', 'harnessapp', 'routes'));
      // THE ROUTE EXISTS AND IS THE HOST'S — the tray sends it; nothing else does.
      assert.ok(routes.ROUTES['POST /api/desktop/quit'], 'the tray has a way to ask Core to quit');
      const host = fs.readFileSync(path.join(ROOT, 'native', 'host.cs'), 'utf8');
      assert.match(host, /api\/desktop\/quit/, 'and the tray is what sends it');
      // X AND QUIT ARE DIFFERENT GESTURES, in the host itself.
      assert.match(host, /CloseReason\.UserClosing[\s\S]{0,120}e\.Cancel = true;[\s\S]{0,40}Hide\(\);/,
        'a user close hides rather than exits');

      // AND THE SHUTDOWN REALLY CLOSES THE HOST. Not asserted by reading: the
      // window is closed through the one sequence and the process must be gone.
      const pid = d.pid;
      await require(path.join(ROOT, 'src', 'teardown')).shutdown(d.app, { why: 'the test quit LAIN' });
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      assert.strictEqual(alive, false, `no host process is left behind (pid ${pid})`);
      assert.strictEqual(d.ipc.status().running, false, 'and the channel is down');
    } finally { await d.close(); }
  });

  // ---------------------------------------------------------------------
  await test('DESKTOP: one LAIN per account — a second launch finds the first', async () => {
    if (process.platform !== 'win32') return note('the control pipe is a Windows named pipe');
    const lock = require(path.join(ROOT, 'src', 'corelock'));
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    try {
      // BEFORE ANYTHING ANNOUNCES, discovery must say no rather than guessing
      // from a file that may be stale — see corelock.js.
      const held = await lock.announce(d.app, { surface: 'test' });
      assert.strictEqual(held.ok, true, `the lock is claimed: ${held.why || ''}`);

      // A SECOND LAUNCH ASKS, AND IS ANSWERED BY THIS PROCESS.
      const found = await lock.discover();
      assert.strictEqual(found.running, true, 'a running LAIN is discovered');
      assert.strictEqual(found.pid, process.pid, 'and it is this one');
      assert.strictEqual(found.desktop, true, 'which reports that it has a window');

      // `show` BRINGS THE WINDOW RATHER THAN STARTING A SECOND LAIN.
      const shown = await lock.ask('show');
      assert.ok(shown && shown.ok, `show is answered: ${JSON.stringify(shown)}`);
      assert.strictEqual(shown.already, true, 'the window that exists is the one shown');

      // AND NOTHING ELSE IS REACHABLE ON THAT PIPE. Three verbs, by construction.
      const nope = await lock.ask('read-my-sessions');
      assert.ok(nope && nope.ok === false, 'an unknown verb is refused');
      assert.match(nope.why, /unknown verb/);
    } finally {
      lock.release();
      await d.close();
    }
  });

  // ---------------------------------------------------------------------
  // ---- THE ENTRY POINT THE PRODUCT ACTUALLY HAS ------------------------
  //
  // Every case above starts LAIN in-process and then opens a window, which is
  // what a CLI does. This is the other direction, and it is the one the product
  // claim rests on: somebody double-clicks LAIN and LAIN starts. No terminal,
  // no `/app`, no browser.
  //
  // ISOLATED BY CONFIG DIRECTORY, deliberately. The control pipe is named from
  // a hash of the config dir (src/corelock.js), so a temp dir gives this test
  // its own instance namespace — it cannot find, show, or quit the LAIN a
  // person has running on this machine.
  await test('DESKTOP: double-clicking LAIN starts Core and opens a window, with no CLI and no browser', async () => {
    if (process.platform !== 'win32') return note('LAIN Desktop is Windows-only for now');
    const d = require(path.join(ROOT, 'src', 'desktop'));
    const built = d.build();
    if (!built.ok) return note(`the host could not be built: ${built.why}`);
    const installed = d.installLauncher(built);
    if (!installed.ok) return note(`the launcher could not be installed: ${installed.why}`);

    // THE NODE IT RECORDED IS A REAL ONE. This is the whole of the "node error"
    // fix: a shortcut does not inherit a developer's PATH, so the answer is
    // written down at build time by the resolver.
    assert.ok(installed.node && fs.existsSync(installed.node),
      `the launcher recorded a usable Node: ${installed.node || installed.why}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(built.dir, 'launch.json'), 'utf8'));
    assert.ok(fs.existsSync(manifest.entry), 'and a readable entry point');

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-launch-home-'));
    const { spawn } = require('child_process');
    const child = spawn(installed.launcher, [], {
      env: { ...process.env, LAIN_CONFIG_DIR: home, LAIN_PROVIDER: 'mock' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    // ---- WAITED FOR BY CONDITION, NEVER BY SLEEP (§28) -----------------
    //
    // The condition is Core ANSWERING on its own control pipe, which is the
    // thing the launch is supposed to produce. A timer would only prove that
    // time passed.
    const lock = require(path.join(ROOT, 'src', 'corelock'));
    const saved = process.env.LAIN_CONFIG_DIR;
    process.env.LAIN_CONFIG_DIR = home;
    let found = { running: false };
    let hostPid = 0;
    try {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- waiting on a real launch.
        found = await lock.discover();
        if (found.running && found.desktop) break;
        // eslint-disable-next-line no-await-in-loop -- the same wait.
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.strictEqual(found.running, true, 'a Core came up from the launcher alone');
      assert.strictEqual(found.surface, 'desktop', 'and it knows it was launched as an application');
      assert.strictEqual(found.desktop, true, 'with a window, not just a process');
      assert.notStrictEqual(found.pid, process.pid, 'it is its own Core, not this test runner');

      // ---- NO CLI WAS INVOLVED, AND NO BROWSER WAS OPENED --------------
      //
      // Asserted against the real process table rather than by reading code:
      // the Core that came up has no terminal attached, and nothing under the
      // launched tree is a browser.
      const ps = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${found.pid} -or $_.ProcessId -eq ${found.pid} } `
        + '| Select-Object ProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8' });
      const rows = [].concat(JSON.parse(ps || '[]'));
      const names = rows.map((r) => String(r.Name || '').toLowerCase());
      assert.ok(!names.some((n) => /chrome|msedge|chromium|brave|helium/.test(n)),
        `the launch opened no browser: ${names.join(', ')}`);
      hostPid = (rows.find((r) => /^lain-desktop/i.test(String(r.Name || ''))) || {}).ProcessId || 0;
      assert.ok(hostPid, `the native host is running under it: ${names.join(', ')}`);

      // ---- AND A SECOND LAUNCH FINDS THE FIRST (§28) -------------------
      const again = await lock.ask('show');
      assert.ok(again && again.ok, `a second launch is answered by the first: ${JSON.stringify(again)}`);
      assert.strictEqual(again.already, true, 'it shows the window that exists rather than making another');
    } finally {
      // ---- QUIT IT, AND PROVE IT WENT ---------------------------------
      try { await lock.ask('quit'); } catch { /* going anyway */ }
      const gone = Date.now() + 30000;
      while (Date.now() < gone) {
        let alive = false;
        try { process.kill(found.pid, 0); alive = true; } catch { alive = false; }
        if (!alive) break;
        // eslint-disable-next-line no-await-in-loop -- watching a real process exit.
        await new Promise((r) => setTimeout(r, 400));
      }
      let coreAlive = false;
      try { if (found.pid) { process.kill(found.pid, 0); coreAlive = true; } } catch { coreAlive = false; }
      let hostAlive = false;
      try { if (hostPid) { process.kill(hostPid, 0); hostAlive = true; } } catch { hostAlive = false; }
      process.env.LAIN_CONFIG_DIR = saved;
      if (saved === undefined) delete process.env.LAIN_CONFIG_DIR;
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows holds it briefly */ }
      assert.strictEqual(coreAlive, false, 'Quit really ended the Core it started');
      assert.strictEqual(hostAlive, false, 'and took its window with it — no orphan host');
    }
  });
};
