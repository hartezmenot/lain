'use strict';

/**
 * DRIVE THE REAL LAIN DESKTOP — the application a person uses, not its API.
 *
 * ------------------------------------------------------------------------
 * IT DRIVES THE PRODUCT, WHICH IS WHY IT CHANGED.
 *
 * This used to start the loopback Harness server and point a Harness-owned
 * headless Chromium at the URL. That was the product once. It is not any more:
 * the browser Harness and its HTTP transport were removed in 2026-09-15, so a
 * driver built on them would have been testing a rendering of the application
 * rather than the application.
 *
 * So it now launches the REAL native host, over the REAL private pipe, and
 * attaches to its REAL WebView2 renderer. Every interaction still goes through
 * the DOM — clicks, typing, Enter — so a test built on this is REAL-UI VERIFIED
 * for the shipped shell. The model is the mock provider; nothing else is
 * doubled.
 *
 * ------------------------------------------------------------------------
 * THE DEBUGGING PORT IS THE ONLY WAY IN, AND IT IS DEV-ONLY.
 *
 * A release host opens no port (native/host.cs gates it on `--dev`, and
 * src/desktop.js refuses to pass one without it — pinned by
 * tests/unit/desktopboundary.test.js). A test is development, so it asks for
 * one; that is the whole reason the switch exists.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// ISOLATED BEFORE ANYTHING OF CORE'S IS REQUIRED. Whoever loads this driver —
// the test runner or a scratch script — gets a run-owned profile, never the
// person's real ~/.lain-v2. See tests/harness/isolation.js.
const isolation = require('./isolation');
isolation.ensure();

function scriptFile(steps) {
  const p = path.join(isolation.tmp('appdrv-'), 'script.json');
  fs.writeFileSync(p, JSON.stringify(steps));
  return p;
}

/**
 * @param {object} o
 *   cwd       project directory (created when absent)
 *   script    mock provider steps
 *   width, height
 * @returns {Promise<Driver>} or `{ skipped: why }`
 */
async function open({ cwd = null, script = [], width = 1280, height = 820, resume = null } = {}) {
  if (process.platform !== 'win32') return { skipped: 'Noema Desktop is Windows-only for now' };
  const desktop = require(path.join(ROOT, 'src', 'desktop'));
  const built = desktop.build();
  if (!built.ok) return { skipped: `the desktop host could not be built: ${built.why}` };

  const dir = cwd || isolation.tmp('appproj-');
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = scriptFile(script);
  require(path.join(ROOT, 'src', 'mockprovider'))._reset();

  const { App } = require(path.join(ROOT, 'src', 'app'));
  const app = new App({
    out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false },
    interactive: false,
    cwd: dir,
    ...(resume ? { resume } : {}),
  });

  const win = require(path.join(ROOT, 'src', 'desktopwindow'));
  const ipc = require(path.join(ROOT, 'src', 'harnessapp', 'ipc'));
  const port = 9600 + Math.floor(Math.random() * 350);
  const opened = await win.open(app, { dev: true, debugPort: port });
  if (!opened.ok && !opened.already) { return { skipped: `the window did not open: ${opened.why}` }; }

  // CONNECTED MEANS CONNECTED: the host proved its secret on the pipe.
  const upBy = Date.now() + 30000;
  while (ipc.status().clients < 1 && Date.now() < upBy) {
    // eslint-disable-next-line no-await-in-loop -- waiting on a real process to connect.
    await new Promise((r) => setTimeout(r, 200));
  }

  const cdp = require(path.join(ROOT, 'src', 'harness', 'cdp'));
  let target = null;
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- waiting on a renderer to listen.
    const got = await cdp.endpoint(port).catch(() => ({ ok: false }));
    const first = got && got.ok ? (got.targets || []).find((t) => t.webSocketDebuggerUrl) : null;
    if (first) { target = first; break; }
    // eslint-disable-next-line no-await-in-loop -- the same wait.
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!target) { await win.close(); ipc.stop(); return { skipped: 'the renderer did not expose a debugging port' }; }

  const { BrowserSession } = require(path.join(ROOT, 'src', 'harness', 'browser'));
  const conn = new cdp.Connection(target.webSocketDebuggerUrl);
  const attached = await conn.connect();
  if (!attached.ok) { await win.close(); ipc.stop(); return { skipped: `could not attach to the renderer: ${attached.why}` }; }
  const page = new BrowserSession(conn, {});
  await page.enable();
  try { await page.conn.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); } catch { /* the host window is the size it is */ }

  const d = {
    app, page, cwd: dir, port, pid: opened.pid,
    /** Evaluate in the page; throws on a page exception. */
    async js(expr) {
      const r = await page.evaluate(expr, 30000);
      if (!r.ok) throw new Error(r.why);
      return r.value;
    },
    /** Wait until `expr` is truthy in the page. */
    async until(expr, timeoutMs = 20000) {
      const end = Date.now() + timeoutMs;
      let last;
      while (Date.now() < end) {
        try { last = await d.js(expr); if (last) return last; } catch (e) { last = e.message; }
        // eslint-disable-next-line no-await-in-loop -- polling the real UI.
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`timed out waiting for: ${expr} (last: ${JSON.stringify(last)})`);
    },
    /**
     * GO TO A SURFACE THE WAY A PERSON WOULD (Phase 8.2): the app panel when it is on
     * screen (every surface but the IDE), otherwise the IDE's small LAIN switcher at
     * the top-left.
     */
    async surface(tab) {
      const how = await d.js(`(() => {
        const t = document.querySelector('.gtab[data-tab="${tab}"]');
        if (t && t.offsetParent !== null && t.getBoundingClientRect().width > 0) { t.click(); return 'rail'; }
        const s = document.getElementById('surfBtn');
        if (!s || s.offsetParent === null) return 'none';
        s.click();
        return 'switcher';
      })()`);
      if (how === 'switcher') {
        await d.until("!!document.querySelector('.surfpop')", 5000);
        await d.js(`(() => { const want = { home: 'Home', ide: 'IDE', chat: 'Chat', model: 'Model', usage: 'Usage', mcp: 'MCP & Skills', settings: 'Settings' }['${tab}']; const b = Array.from(document.querySelectorAll('.surfpop button')).find((x) => x.textContent.startsWith(want)); b.click(); return true; })()`);
      } else if (how === 'none') throw new Error(`no visible navigation to ${tab}`);
      await d.until(`LAIN.nav.tab() === '${tab}'`, 5000);
      return how;
    },
    async click(selector) {
      const r = await page.click(selector);
      if (r && r.ok === false) throw new Error(`click ${selector}: ${r.why}`);
      return r;
    },
    /** Type into a field the way a person does: focus, set, input event. */
    async type(selector, text) {
      await d.js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    },
    async press(key, selector = null) {
      if (selector) await d.js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      const code = key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0;
      await page.conn.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, text: key === 'Enter' ? '\r' : undefined });
      await page.conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
    },
    async shot(file) {
      const r = await page.screenshot();
      if (r.ok) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, r.buffer); }
      return r.ok ? file : null;
    },
    /**
     * RELOAD THE APPLICATION IN PLACE. Not a navigation: the host refuses to
     * navigate anywhere (native/host.cs `NavigationStarting`), which is the
     * point of it being an application rather than a browser.
     */
    async reload() {
      await page.conn.send('Page.reload', { ignoreCache: false });
      await d.until("!!document.getElementById('app') && !document.getElementById('app').hidden", 40000);
    },
    async close() {
      try { conn.close(); } catch { /* going away */ }
      // THIS CORE ENDS WITH THE TEST: its terminals go the way teardown.js ends them on a real exit.
      // A shell left open held the runner's event loop, and a run that had passed never exited.
      for (const a of [app, app._sibling]) { try { if (a) require(path.join(ROOT, 'src', 'pty')).closeAll(a); } catch { /* none held */ } }
      // THE WINDOW AND THE CHANNEL, in that order and both awaited: a host left
      // running is a window on somebody's desktop that outlived its test, and
      // this repository has already paid for that once.
      try { await win.close(); } catch { /* going away regardless */ }
      try { ipc.stop(); } catch { /* stopped */ }
      // ITS SUPERVISOR TOO (Gate 3, 2026-09-30): the detached `lain-supervisor serve --home <this run's home>` this
      // Core started outlived every scratch run that ended with close() — 59 orphans were found. Only processes this
      // client spawned are stopped (supervisor.cleanupOwned), exactly as tests/run.js ends a tier.
      try { await require(path.join(ROOT, 'src', 'supervisor')).cleanupOwned(); } catch { /* legacyprocs.scan reports any left */ }
      try { await require(path.join(ROOT, 'src', 'harness', 'processes')).cleanupOwned(); } catch { /* none held */ }
    },
  };
  return d;
}

module.exports = { open, tmp: isolation.tmp, cleanup: isolation.cleanup, isolated: isolation.isolated };
