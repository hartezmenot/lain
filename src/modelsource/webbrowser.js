'use strict';

/** THE WEB MODEL BROWSER — one authenticated page per source, kept alive. */

const fs = require('fs');
const path = require('path');
const cdp = require('../harness/cdp');
const browser = require('../harness/browser');
const webprofile = require('./webprofile');

/** How long a freshly launched browser gets to announce its debug port. */
const LAUNCH_TIMEOUT_MS = 25_000;
/** A site that has not loaded by now has a problem worth naming. */
const NAV_TIMEOUT_MS = 45_000;

/** ONE BROWSER, ONE PAGE PER SOURCE. */
class WebModelBrowser {
  constructor({ bus = null, headless = false } = {}) {
    this.bus = bus;
    // Overridable ONLY so the conformance suite can prove the launch arguments; a headless web-model browser cannot be logged into and is never the…
    this.headless = headless === true;
    /** sourceId -> { session, processId, profile, port } */
    this._pages = new Map();
    this._opening = new Map();
    this.lastWhy = '';
  }

  /** CAN THIS RUN AT ALL, AND IF NOT, WHY NOT? */
  availability() {
    const client = cdp.clientAvailable();
    if (!client.ok) return { available: false, why: client.why };
    const found = browser.findBrowser();
    if (!found.ok) {
      return {
        available: false,
        why: `no Chromium-family browser was found (looked in ${found.tried.length} places, including ${found.tried[0]})`,
      };
    }
    return { available: true, why: `launchable: ${found.path}`, browserPath: found.path };
  }

  /** The live page for a source, or null. Never launches. */
  existing(sourceId) {
    const held = this._pages.get(String(sourceId));
    return held && held.session && held.session.open ? held.session : null;
  }

  /** GET THE PAGE, launching the authenticated browser if it is not up. */
  page(sourceId, { launch = true, signal = null } = {}) {
    const key = String(sourceId);
    const live = this.existing(key);
    if (live) return Promise.resolve({ ok: true, session: live });
    if (!launch) return Promise.resolve({ ok: false, why: 'the browser for this source is not open' });
    if (this._opening.has(key)) return this._opening.get(key);
    const opening = this._open(key, signal).finally(() => this._opening.delete(key));
    this._opening.set(key, opening);
    return opening;
  }

  async _open(sourceId, signal) {
    const avail = this.availability();
    if (!avail.available) { this.lastWhy = avail.why; return { ok: false, why: avail.why }; }
    if (signal && signal.aborted) return { ok: false, why: 'cancelled before the browser opened' };

    let profile;
    try { profile = webprofile.ensure(sourceId); } catch (e) {
      const why = `could not prepare the saved-login profile: ${(e && e.message) || e}`;
      this.lastWhy = why;
      return { ok: false, why };
    }

    const started = await this._launch(sourceId, profile, avail.browserPath, signal);
    if (!started.ok) { this.lastWhy = started.why; return started; }
    // OWNED BEFORE IT CAN BE LOST
    this._pages.set(sourceId, { session: null, processId: started.processId, profile, port: started.port, child: started.child });

    const tab = await cdp.newTab(started.base, 'about:blank');
    if (!tab.ok || !tab.target || !tab.target.webSocketDebuggerUrl) {
      const why = 'the browser opened but would not give LAIN a page to drive';
      this.lastWhy = why;
      await this.close(sourceId);
      return { ok: false, why };
    }
    const conn = new cdp.Connection(tab.target.webSocketDebuggerUrl);
    const opened = await conn.connect();
    if (!opened.ok) { this.lastWhy = opened.why; await this.close(sourceId); return { ok: false, why: opened.why }; }

    const session = new browser.BrowserSession(conn, { base: started.base });
    session.targetId = tab.target.id || null;
    // Page + Runtime only.
    try { await conn.send('Page.enable'); } catch { /* navigation still works */ }
    try { await conn.send('Runtime.enable'); } catch { /* evaluate still works */ }
    this._pages.set(sourceId, { session, processId: started.processId, profile, port: started.port, child: started.child });
    return { ok: true, session };
  }

  /** LAUNCH IT, HEADFUL, ON THE PERSISTENT PROFILE. */
  async _launch(sourceId, profile, browserPath, signal) {
    // SHARED LAUNCHER, UNCHANGED PROFILE DESIGN
    const rt = require('../env/chromium');
    const runtime = new rt.ChromiumRuntime({ processes: null, events: this.events || null });
    const got = await runtime.launch(rt.PURPOSE.WEBMODEL, {
      sourceId, headless: this.headless, signal,
    });
    if (!got.ok) return { ok: false, why: got.why, detail: got.detail || '', code: got.code || '' };
    const inst = got.instance;
    return { ok: true, base: inst.base, port: inst.port, processId: inst.child ? inst.child.pid : null, child: inst.child, instance: inst };
  }

  _kill(child) {
    try { if (child && child.pid) child.kill(); } catch { /* already gone */ }
  }

  /** GO SOMEWHERE, and say plainly when the page did not arrive. */
  async navigate(sourceId, url, timeoutMs = NAV_TIMEOUT_MS) {
    const got = await this.page(sourceId);
    if (!got.ok) return got;
    return got.session.navigate(String(url), timeoutMs);
  }

  /** Close one source's page and the browser behind it. The login SURVIVES. */
  async close(sourceId) {
    const key = String(sourceId);
    const held = this._pages.get(key);
    this._pages.delete(key);
    if (!held) return { ok: true };
    try {
      if (held.session) {
        if (held.session.targetId && held.session.open) {
          try { await held.session.conn.send('Target.closeTarget', { targetId: held.session.targetId }, 1500); } catch { /* the socket close still follows */ }
        }
        held.session.close('the web model source was disconnected');
      }
    } catch { /* closing is best effort; the kill below is what frees the port */ }
    this._kill(held.child);
    return { ok: true };
  }

  /** Everything, on shutdown. */
  async closeAll() {
    for (const key of [...this._pages.keys()]) {
      // eslint-disable-next-line no-await-in-loop -- closing is bounded and rare
      await this.close(key);
    }
    return { ok: true };
  }
}

/** THE ONE PER APP. Held on the App because a browser holding a login is session-scoped state, and module scope is where two Apps start sharing it. */
function forApp(app) {
  if (!app) return new WebModelBrowser();
  if (!app._webModelBrowser) {
    app._webModelBrowser = new WebModelBrowser({
      bus: app.events || null,
      headless: process.env.LAIN_WEBMODEL_HEADLESS === '1',
    });
  }
  return app._webModelBrowser;
}

module.exports = { WebModelBrowser, forApp, LAUNCH_TIMEOUT_MS, NAV_TIMEOUT_MS };
