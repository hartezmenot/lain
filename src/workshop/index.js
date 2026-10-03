'use strict';

/** THE FRONTEND WORKSHOP — LAIN can see, drive and verify the frontend it edits. */

const path = require('path');
const cdp = require('../harness/cdp');
const browser = require('../harness/browser');
const wprofile = require('./profile');
const devserver = require('./devserver');
const inspect = require('./inspect');
const viewport = require('./viewport');
const { DevServers } = require('./devstate');
const { EVENT } = require('../events');

/** A preview that has not loaded by now has a problem worth naming. */
const NAV_TIMEOUT_MS = 30_000;
/** How long a freshly launched preview browser gets to open its debug port. */
const LAUNCH_TIMEOUT_MS = 25_000;

/** ONE WORKSHOP PER APP. */
class Workshop {
  constructor({ app = null } = {}) {
    this.app = app;
    /** projectPath -> { session, child, profile, url, processId } */
    this._open = new Map();
    this._opening = new Map();
    /** Screenshots taken as BEFORE, by project. See `capture`. */
    this._before = new Map();
    this.lastWhy = '';
    /** The first-class dev-server records, one per project. See devstate.js. */
    this.devServers = new DevServers({ processes: () => this.processes });
  }

  /** THE PROCESS AND ARTIFACT AUTHORITIES, and they are CREATED if absent. */
  get processes() {
    const h = this.app && require('../harnesslink').harnessFor(this.app);
    return (h && h.processes) || null;
  }

  get runtime() {
    const h = this.app && require('../harnesslink').harnessFor(this.app);
    return (h && h.runtime) || null;
  }

  _emit(name, payload) {
    try {
      const bus = this.app && this.app.events;
      if (bus && typeof bus.emit === 'function') bus.emit(name, payload);
    } catch { /* a companion channel may never take the work with it */ }
  }

  /** Can a Workshop run here at all, and if not, why not? Cheap, no launch. */
  /** CAN A PREVIEW OPEN, AND IN WHICH BROWSER? */
  availability({ environment = 'host' } = {}) {
    const client = cdp.clientAvailable();
    if (!client.ok) return { available: false, why: client.why, environment };
    const rt = require('../env/chromium');
    const found = rt.resolve({ policy: new rt.ChromiumRuntime().policy() });
    if (!found.ok) {
      return { available: false, why: found.why, remedy: found.remedy || '', environment };
    }
    return {
      available: true,
      why: `launchable: ${found.path}`,
      browserPath: found.path,
      // WHICH BROWSER, SAID PLAINLY. A person looking at a preview should be
      // able to tell whether it is the pinned build or their own Chrome.
      version: found.version || '',
      owned: found.owned,
      managed: found.managed,
      source: found.source,
      environment,
    };
  }

  /** The live preview for a project, or null. Never launches. */
  existing(projectPath) {
    const held = this._open.get(path.resolve(projectPath));
    return held && held.session && held.session.open ? held : null;
  }

  /** OPEN THE PREVIEW: get a dev server, get a browser, point one at the other. */
  open(projectPath, opts = {}) {
    const key = path.resolve(projectPath);
    const live = this.existing(key);
    if (live) return Promise.resolve({ ok: true, url: live.url, port: live.port, adopted: live.adopted, reused: true });
    if (this._opening.has(key)) return this._opening.get(key);
    const work = this._open_(key, opts).finally(() => this._opening.delete(key));
    this._opening.set(key, work);
    return work;
  }

  // HEADLESS BY DEFAULT (Phase 8.2): the preview is drawn INSIDE LAIN, live and interactive
  // (stream.js), so a second Chromium window beside it is noise. "Open externally" is the person's browser.
  async _open_(key, { taskId = null, headless = true } = {}) {
    const avail = this.availability();
    if (!avail.available) { this.lastWhy = avail.why; return { ok: false, why: avail.why }; }

    // ---- 1. A URL TO PREVIEW, through the existing process authority ----
    this._emit(EVENT.BROWSER_STARTED, { taskId: String(taskId || ''), what: 'workshop' });
    const started = await this.devServers.start(key, { taskId });
    if (!started.ok) { this.lastWhy = started.why; return { ok: false, why: started.why, devServer: started.devServer }; }
    const ds = started.devServer;
    const serve = { url: ds.url, port: ds.port, processId: ds.processId, adopted: ds.adopted, why: started.why || '' };
    // ASK THE PAGE ONCE BEFORE SHOWING IT A 500 here is structured evidence for the window (devstate.probe), and it does not stop the preview opening — the…
    const probed = await this.devServers.probe(key);
    const preview = probed.ok ? probed.preview : null;

    // ---- 2. A BROWSER, on this PROJECT'S OWN profile --------------------
    let profile;
    try { profile = wprofile.ensure(key); } catch (e) {
      return { ok: false, why: `could not prepare the preview profile: ${(e && e.message) || e}` };
    }
    const launched = await this._launch(key, headless);
    if (!launched.ok) { this.lastWhy = launched.why; return launched; }
    // OWNED BEFORE ANYTHING ELSE CAN FAIL.
    this._open.set(key, {
      session: null, child: launched.child, profile, url: serve.url, port: serve.port,
      processId: serve.processId, adopted: serve.adopted,
    });

    const tab = await cdp.newTab(launched.base, 'about:blank');
    if (!tab.ok || !tab.target || !tab.target.webSocketDebuggerUrl) {
      await this.close(key);
      return { ok: false, why: 'the preview browser would not give LAIN a page to drive' };
    }
    const conn = new cdp.Connection(tab.target.webSocketDebuggerUrl);
    const opened = await conn.connect();
    if (!opened.ok) { await this.close(key); return { ok: false, why: opened.why }; }

    const session = new browser.BrowserSession(conn, { base: launched.base });
    session.targetId = tab.target.id || null;
    // Page, Runtime, Log, Network, DOM — the same set the verification browser enables, because the console and network observations are the same…
    await session.enable();
    const held = this._open.get(key);
    held.session = session;

    const nav = await session.navigate(serve.url, NAV_TIMEOUT_MS);
    if (!nav.ok) {
      // A PREVIEW THAT WILL NOT LOAD IS STILL AN OPEN WORKSHOP.
      return { ok: true, url: serve.url, port: serve.port, adopted: serve.adopted, loaded: false, why: nav.why, preview, devServer: this.devServers.get(key) };
    }
    this._emit(EVENT.BROWSER_OBSERVED, { taskId: String(taskId || ''), what: 'preview', url: serve.url });
    return { ok: true, url: serve.url, port: serve.port, adopted: serve.adopted, loaded: true, why: serve.why, preview, devServer: this.devServers.get(key) };
  }

  /** LAUNCH THE PREVIEW BROWSER. */
  async _launch(projectPath, headless) {
    // THE LAUNCH IS env/chromium.js's, AND THE LIFETIME IS STILL OURS --
    const rt = require('../env/chromium');
    const runtime = new rt.ChromiumRuntime({ processes: null, events: this.bus });
    const got = await runtime.launch(rt.PURPOSE.WORKSHOP, {
      projectPath,
      headless,
    });
    if (!got.ok) return { ok: false, why: got.why, detail: got.detail || '', code: got.code || '' };
    const inst = got.instance;
    // WHICH BROWSER THE PREVIEW IS, for the status surface and for evidence.
    this.lastBrowser = { version: inst.version, owned: inst.owned, managed: inst.managed, source: inst.source };
    return { ok: true, base: inst.base, port: inst.port, child: inst.child, instance: inst };
  }

  // ------------------------------------------------------------ observing --

  /** The page, or a stated reason there is not one. Every reader goes through it. */
  _page(projectPath) {
    const held = this.existing(projectPath);
    if (!held) return { ok: false, why: 'the workshop is not open for this project' };
    return { ok: true, session: held.session, held };
  }

  async element(projectPath, selector) {
    const p = this._page(projectPath);
    return p.ok ? inspect.element(p.session, selector) : p;
  }

  async pick(projectPath) {
    const p = this._page(projectPath);
    return p.ok ? inspect.pick(p.session) : p;
  }

  /** The element at a page coordinate — a click on the preview image. */
  async pickAt(projectPath, x, y) {
    const p = this._page(projectPath);
    return p.ok ? inspect.pickAt(p.session, x, y) : p;
  }

  async picked(projectPath) {
    const p = this._page(projectPath);
    return p.ok ? inspect.picked(p.session) : p;
  }

  async unpick(projectPath) {
    const p = this._page(projectPath);
    return p.ok ? inspect.unpick(p.session) : p;
  }

  async axTree(projectPath, selector = null) {
    const p = this._page(projectPath);
    return p.ok ? inspect.axTree(p.session, selector) : p;
  }

  /** The page measured for the GUG (gug.js fromDom) — bounded, deterministic. */
  async measure(projectPath, max = 400) {
    const p = this._page(projectPath);
    return p.ok ? inspect.measure(p.session, max) : p;
  }

  /** Console and network, summarised. Cheap: both are accumulated already. */
  observations(projectPath) {
    const p = this._page(projectPath);
    if (!p.ok) return p;
    return {
      ok: true,
      url: p.session.url || p.held.url,
      viewport: p.session.viewport || 'desktop',
      console: inspect.consoleReport(p.session),
      network: inspect.networkReport(p.session),
    };
  }

  // ------------------------------------------------------------- driving --

  async navigate(projectPath, url) {
    const p = this._page(projectPath);
    if (!p.ok) return p;
    // ONLY WITHIN THE PREVIEW'S OWN ORIGIN.
    const target = String(url || '');
    const base = p.held.url;
    const abs = target.startsWith('http') ? target : new URL(target, base).href;
    if (!abs.startsWith(new URL(base).origin)) {
      return { ok: false, why: 'the workshop previews this project, not the web' };
    }
    return p.session.navigate(abs, NAV_TIMEOUT_MS);
  }

  async click(projectPath, selector) {
    const p = this._page(projectPath);
    return p.ok ? p.session.click(String(selector)) : p;
  }

  async type(projectPath, selector, text) {
    const p = this._page(projectPath);
    return p.ok ? p.session.type(String(selector), String(text == null ? '' : text)) : p;
  }

  async reload(projectPath) {
    const p = this._page(projectPath);
    if (!p.ok) return p;
    // RELOADED FROM THE SERVER, AND FINISHED LOADING.
    const url = p.session.url || p.held.url;
    try { await p.session.conn.send('Network.setCacheDisabled', { cacheDisabled: true }); } catch { /* best effort */ }
    const r = await p.session.navigate(url);
    try { await p.session.conn.send('Network.setCacheDisabled', { cacheDisabled: false }); } catch { /* best effort */ }
    return r.ok ? { ok: true, why: 'reloaded' } : { ok: false, why: r.why };
  }

  async viewport(projectPath, name, opts = {}) {
    const p = this._page(projectPath);
    return p.ok ? viewport.apply(p.session, name, opts) : p;
  }

  /** FORGET WHAT EARLIER LOADS SAID. */
  _resetLogs(session) {
    if (!session) return;
    if (Array.isArray(session.console)) session.console.length = 0;
    if (Array.isArray(session.network)) session.network.length = 0;
    if (Array.isArray(session.pageErrors)) session.pageErrors.length = 0;
  }

  // ------------------------------------------------------------ evidence --

  /** A SCREENSHOT, KEPT AS A HARNESS ARTIFACT. */
  async capture(projectPath, { as = null, taskId = null, name = null } = {}) {
    const p = this._page(projectPath);
    if (!p.ok) return p;
    const shot = await p.session.screenshot();
    if (!shot.ok) return shot;
    const vp = p.session.viewport || 'desktop';
    const label = String(name || `${as || 'shot'}-${vp}.png`);
    let kept = null;
    const rt = this.runtime;
    if (rt && taskId) {
      try { kept = rt.keep(taskId, { kind: 'screenshot', name: label, body: shot.buffer }); } catch { kept = null; }
    }
    const record = {
      ok: true,
      viewport: vp,
      url: p.session.url || p.held.url,
      at: Date.now(),
      bytes: shot.buffer.length,
      path: kept ? kept.path : null,
      // THE IMAGE ITSELF, for the frontend to draw immediately. Not persisted
      // here — the artifact above is the durable copy.
      dataUrl: `data:image/png;base64,${shot.buffer.toString('base64')}`,
    };
    if (as === 'before') this._before.set(`${path.resolve(projectPath)}:${vp}`, record);
    return record;
  }

  /** The BEFORE for this project and viewport, or null. */
  before(projectPath, vp = 'desktop') {
    return this._before.get(`${path.resolve(projectPath)}:${vp}`) || null;
  }

  /** VERIFY THE FRONTEND AT ONE OR MORE VIEWPORTS. */
  async verify(projectPath, { viewports = ['desktop', 'mobile'], taskId = null, selector = null } = {}) {
    const p = this._page(projectPath);
    if (!p.ok) return { ok: false, why: p.why };
    const results = [];
    for (const name of viewports) {
      // EACH VIEWPORT IS JUDGED ON ITS OWN PAGE LOAD
      this._resetLogs(p.session);
      // eslint-disable-next-line no-await-in-loop -- a viewport sweep is
      // ordered by definition: each one reloads the page under new metrics.
      const applied = await this.viewport(projectPath, name);
      // A moment for the reloaded page to emit what it is going to emit. Without
      // it a fast page is judged before its own error has been logged.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 500));
      if (!applied.ok) { results.push({ viewport: name, ok: false, why: applied.why }); continue; }
      // eslint-disable-next-line no-await-in-loop
      const over = await viewport.overflow(p.session);
      const obs = this.observations(projectPath);
      // eslint-disable-next-line no-await-in-loop
      const shot = await this.capture(projectPath, { as: 'after', taskId, name: `verify-${name}.png` });
      let el = null;
      if (selector) {
        // eslint-disable-next-line no-await-in-loop
        const got = await this.element(projectPath, selector);
        el = got.ok ? got.element : { missing: got.why };
      }
      const checks = [
        { name: 'no console errors', ok: obs.ok ? obs.console.errors === 0 : false, detail: obs.ok ? `${obs.console.errors} error(s)` : obs.why },
        { name: 'no failed requests', ok: obs.ok ? obs.network.failed === 0 : false, detail: obs.ok ? `${obs.network.failed} failed` : obs.why },
        { name: 'no horizontal overflow', ok: over.ok ? !over.overflowing : false, detail: over.ok ? (over.overflowing ? `overflows by ${over.by}px — widest: ${over.worst}` : 'fits') : over.why },
      ];
      results.push({
        viewport: name,
        ok: checks.every((c) => c.ok),
        width: applied.width,
        checks,
        element: el,
        screenshot: shot.ok ? { path: shot.path, dataUrl: shot.dataUrl } : null,
      });
    }
    // Hand the window back, so the preview a person looks at afterwards is the
    // one they were working in rather than the last viewport tested.
    await viewport.clear(p.session);
    return {
      ok: results.length > 0 && results.every((r) => r.ok),
      results,
      // SAID PLAINLY, because it is the boundary this module lives inside.
      note: 'workshop observations — the task is settled by the harness, not here',
    };
  }

  // ------------------------------------------------------------ lifecycle --

  /** What a status view may know. Cheap, and never launches anything. */
  status(projectPath) {
    const key = path.resolve(projectPath || (this.app && this.app.session && this.app.session.cwd) || process.cwd());
    const held = this.existing(key);
    const detected = devserver.detect(key);
    return {
      project: key,
      open: Boolean(held),
      url: held ? held.url : null,
      port: held ? held.port : null,
      adopted: held ? Boolean(held.adopted) : false,
      viewport: held && held.session ? (held.session.viewport || 'desktop') : null,
      devServer: { ok: detected.ok, why: detected.why, ...this.devServers.get(key) },
      available: this.availability(),
      profile: wprofile.describe(key),
    };
  }


  /** Where the page is now — the page a change request targets when nothing is selected. */
  async pageUrl(projectPath) {
    const p = this._page(projectPath);
    if (!p.ok) return null;
    const s = p.session;
    if (s && typeof s.evaluate === 'function') {
      const r = await s.evaluate('location.href', 3000).catch(() => null);
      if (r && r.ok && r.value) return String(r.value);
    }
    return (s && s.url) || null;
  }

  // the frame preview (2026-09-30) --

  async frameOpen(projectPath, { taskId = null } = {}) {
    const key = path.resolve(projectPath);
    if (!this._frames) this._frames = new Map();
    const held = this._frames.get(key);
    if (held && held.proxy && held.proxy.server) return { ok: true, ...this.frameState(key), reused: true };
    const started = await this.devServers.start(key, { taskId });
    if (!started.ok) { this.lastWhy = started.why; return { ok: false, why: started.why, devServer: started.devServer }; }
    const ds = started.devServer;
    const { PreviewProxy } = require('./proxy');
    const proxy = new PreviewProxy({ target: ds.url, root: key, waker: (rule) => this._wake(key, rule, taskId) });
    const up = await proxy.start();
    if (!up.ok) return up;
    this._frames.set(key, { proxy, target: ds.url, port: ds.port, processId: ds.processId, adopted: ds.adopted, viewport: (held && held.viewport) || { name: 'desktop', w: 1440, h: 900 }, path: null, openedAt: Date.now() });
    this._emit(EVENT.BROWSER_STARTED, { taskId: String(taskId || ''), what: 'preview' });
    return { ok: true, ...this.frameState(key) };
  }

  /** What every surface draws the preview from. Null when this project has none open. */
  frameState(projectPath) {
    const key = path.resolve(projectPath || '.');
    const f = this._frames && this._frames.get(key);
    if (!f || !f.proxy || !f.proxy.server) return null;
    return { url: f.proxy.url, target: f.target, port: f.proxy.port, devPort: f.port, adopted: Boolean(f.adopted), viewport: f.viewport, path: f.path, capabilities: f.proxy.view(), stats: { requests: f.proxy.stats.requests, documents: f.proxy.stats.documents, errors: f.proxy.stats.errors } };
  }

  /** The viewport and page every surface shares (the window reports them; Core keeps them). */
  frameSet(projectPath, { viewport = null, page = null } = {}) {
    const key = path.resolve(projectPath);
    const f = this._frames && this._frames.get(key);
    if (!f) return { ok: false, why: 'the preview is not open' };
    if (viewport && typeof viewport === 'object') {
      const w = Math.round(Number(viewport.w)); const h = Math.round(Number(viewport.h));
      if (w >= 240 && w <= 4096 && h >= 240 && h <= 4096) f.viewport = { name: String(viewport.name || 'custom').slice(0, 20), w, h };
    }
    if (typeof page === 'string') f.path = page.slice(0, 500);
    return { ok: true, ...this.frameState(key) };
  }

  frameCapability(projectPath, name, mode) {
    const key = path.resolve(projectPath);
    const f = this._frames && this._frames.get(key);
    if (!f) return { ok: false, why: 'the preview is not open' };
    const r = f.proxy.setMode(String(name || ''), mode === 'default' ? null : mode);
    // A CAPABILITY TURNED AWAY FROM LIVE puts its woken backend back to sleep — nothing it started keeps running.
    const rule = r.ok ? f.proxy.rules().find((x) => x.name === name) : null;
    if (rule && rule.mode !== 'live') {
      const rec = f.proxy.release(name);
      if (rec) require('./capability').sleep(rec, { processes: this.processes }).catch(() => null);
      return { ...r, capabilities: f.proxy.view() };
    }
    return r;
  }

  /** WAKE ONE CAPABILITY'S BACKEND (the proxy asks, on the first request it claims). Owned by the ProcessManager. */
  async _wake(key, rule, taskId) {
    const cap = require('./capability');
    const r = await cap.wake(key, rule, { processes: this.processes, taskId });
    const f = this._frames && this._frames.get(key);
    // THE PREVIEW CLOSED WHILE IT WOKE: what was started is stopped, never left behind.
    if (r.ok && !(f && f.proxy && f.proxy.server)) { await cap.sleep(r, { processes: this.processes }); return { ok: false, why: 'the preview closed while the capability woke' }; }
    return r;
  }

  /** Close the frame preview: the proxy always; the dev server only when LAIN started it (devstate owns that proof). */
  async frameClose(projectPath, { keepServer = false } = {}) {
    const key = path.resolve(projectPath);
    const f = this._frames && this._frames.get(key);
    if (!f) return { ok: true };
    // THE CAPABILITY BACKENDS IT WOKE go with it — each one LAIN started, by its own process record.
    for (const name of [...f.proxy.awake.keys()]) {
      // eslint-disable-next-line no-await-in-loop -- a handful at most
      await require('./capability').sleep(f.proxy.release(name), { processes: this.processes });
    }
    try { f.proxy.stop(); } catch { /* closing anyway */ }
    this._frames.delete(key);
    if (!keepServer && !f.adopted && f.processId && !this._open.has(key)) {
      try { await this.devServers.stop(key); } catch { /* the manager reports its own failures */ }
    }
    this._emit(EVENT.BROWSER_CLOSED, { taskId: '', what: 'preview' });
    return { ok: true };
  }

  /** Close one project's preview. The dev server is the ProcessManager's. */
  async close(projectPath) {
    const key = path.resolve(projectPath);
    if (this._frames && this._frames.has(key)) await this.frameClose(key, { keepServer: true });
    const held = this._open.get(key);
    this._open.delete(key);
    this._before.delete(`${key}:desktop`);
    if (!held) return { ok: true };
    try {
      if (held.session) {
        if (held.session.targetId && held.session.open) {
          try { await held.session.conn.send('Target.closeTarget', { targetId: held.session.targetId }, 1500); } catch { /* the socket close follows */ }
        }
        held.session.close('the workshop was closed');
      }
    } catch { /* closing is best effort; the kill below frees the port */ }
    try { if (held.child && held.child.pid) held.child.kill(); } catch { /* gone */ }
    // THE DEV SERVER IS NOT KILLED HERE when it was ADOPTED — it was already running and belongs to whoever started it.
    if (!held.adopted && held.processId) {
      try { await this.devServers.stop(key); } catch { /* the manager reports its own failures */ }
    }
    this._emit(EVENT.BROWSER_CLOSED, { taskId: '', what: 'workshop' });
    return { ok: true };
  }

  async closeAll() {
    for (const key of [...((this._frames && this._frames.keys()) || [])]) {
      // eslint-disable-next-line no-await-in-loop -- bounded and rare
      await this.frameClose(key);
    }
    for (const key of [...this._open.keys()]) {
      // eslint-disable-next-line no-await-in-loop -- bounded and rare
      await this.close(key);
    }
    return { ok: true };
  }
}

/** THE ONE PER APP. Held on the App, never at module scope. */
function forApp(app) {
  if (!app) return new Workshop();
  if (!app._workshop) app._workshop = new Workshop({ app });
  return app._workshop;
}

module.exports = { Workshop, forApp, NAV_TIMEOUT_MS };
