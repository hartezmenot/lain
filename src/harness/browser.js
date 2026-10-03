'use strict';

/** THE BROWSER HARNESS — an instrument, not a browsing tool. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cdp = require('./cdp');

/** The default port. 9222 is the DevTools convention and every tool knows it. */
const DEFAULT_PORT = 9222;
/** A page that has not loaded by now is a page with a problem. */
const NAV_TIMEOUT_MS = 20000;
/** How long to wait for a freshly launched browser to open its debug port. */
const LAUNCH_TIMEOUT_MS = 15000;

/** WHERE A BROWSER LIVES ON THIS MACHINE. */
function candidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge',
  ];
}

function findBrowser(explicit = null) {
  const tried = [];
  const list = explicit ? [explicit] : candidates();
  for (const p of list) {
    tried.push(p);
    try { if (fs.statSync(p).isFile()) return { ok: true, path: p, tried }; } catch { /* unreadable */ }
  }
  return { ok: false, tried };
}

/** CAN A BROWSER OBSERVATION HAPPEN AT ALL, AND IF NOT, WHY NOT? */
async function available({ port = DEFAULT_PORT, browserPath = null } = {}) {
  const client = cdp.clientAvailable();
  const found = findBrowser(browserPath);
  const live = await cdp.endpoint(port);
  const out = {
    available: false,
    state: 'OPTIONAL_UNAVAILABLE',
    why: '',
    client: client.ok,
    clientWhy: client.why,
    attachable: live.ok,
    launchable: found.ok,
    browserPath: found.ok ? found.path : null,
    port,
    browser: live.ok ? live.browser : null,
    tried: found.tried,
  };
  if (!client.ok) { out.why = client.why; return out; }
  if (browserPath && !found.ok) { out.state = 'MISCONFIGURED'; out.why = `configured browser binary is missing: ${browserPath}`; return out; }
  if (live.ok) { out.state = 'AVAILABLE'; out.available = true; out.why = `attachable: ${live.browser} on port ${port}`; return out; }
  if (found.ok) { out.state = 'AVAILABLE'; out.available = true; out.why = `launchable: ${found.path}`; return out; }
  out.why = `no browser is listening on port ${port} and no browser binary was found (looked in ${found.tried.length} places)`;
  return out;
}

/** ONE BROWSER SESSION — a connection, a page, and everything it saw. */
class BrowserSession {
  constructor(conn, { taskId = null, processId = null, base = null } = {}) {
    this.conn = conn;
    this.taskId = taskId;
    this.processId = processId;
    this.base = base;
    this.console = [];
    this.network = [];
    this.pageErrors = [];
    this.url = null;
    this.openedAt = Date.now();
  }

  get open() { return Boolean(this.conn && this.conn.open); }

  _collect() {
    this.conn.on((method, params) => {
      if (method === 'Runtime.consoleAPICalled') {
        const text = (params.args || []).map((a) => (a.value != null ? String(a.value) : (a.description || a.type))).join(' ');
        this.console.push({ level: params.type || 'log', text: text.slice(0, 2000), at: Date.now() });
      } else if (method === 'Log.entryAdded' && params.entry) {
        this.console.push({ level: params.entry.level || 'log', text: String(params.entry.text || '').slice(0, 2000), url: params.entry.url, at: Date.now() });
      } else if (method === 'Runtime.exceptionThrown') {
        const d = (params.exceptionDetails || {});
        const text = d.exception && (d.exception.description || d.exception.value);
        this.pageErrors.push({ text: String(text || d.text || 'uncaught exception').slice(0, 2000), at: Date.now() });
      } else if (method === 'Network.responseReceived' && params.response) {
        this.network.push({ url: String(params.response.url || '').slice(0, 500), status: params.response.status, at: Date.now() });
      }
      const cap = 500;
      if (this.console.length > cap) this.console.splice(0, this.console.length - cap);
      if (this.network.length > cap) this.network.splice(0, this.network.length - cap);
    });
  }

  /** Every console entry at error level, plus uncaught exceptions. */
  errors() {
    return [
      ...this.console.filter((c) => /error/i.test(c.level)),
      ...this.pageErrors.map((e) => ({ level: 'error', text: e.text, at: e.at })),
    ];
  }

  async enable() {
    this._collect();
    this.enabledDomains = new Set();
    for (const domain of ['Page', 'Runtime', 'Log', 'Network', 'DOM']) {
      // A DOMAIN THAT WILL NOT ENABLE IS NOT FATAL.
      try { await this.conn.send(`${domain}.enable`); this.enabledDomains.add(domain); } catch { /* availability remains explicit */ }
    }
  }

  async navigate(url, timeoutMs = NAV_TIMEOUT_MS) {
    const target = String(url);
    this.loadedAt = Date.now();   // a project write after this makes the page stale (writeclock.js)
    let finish;
    const loaded = new Promise((resolve) => {
      const off = this.conn.on((method) => {
        if (method === 'Page.loadEventFired') finish(true);
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
      finish = (ok) => { clearTimeout(timer); off(); this._loads.delete(finish); resolve(ok); };
      if (!this._loads) this._loads = new Set();
      this._loads.add(finish);
    });
    let r;
    try { r = await this.conn.send('Page.navigate', { url: target }, timeoutMs); } catch (e) {
      finish(false);
      return { ok: false, why: `navigation failed: ${(e && e.message) || e}` };
    }
    if (r && r.errorText) { finish(false); return { ok: false, why: `navigation failed: ${r.errorText}` }; }
    const didLoad = await loaded;
    this.url = target;
    return { ok: didLoad, loaded: didLoad, why: didLoad ? `loaded ${target}` : `navigated to ${target}, but the load event did not fire within ${timeoutMs}ms` };
  }

  /** EVALUATE AN EXPRESSION IN THE PAGE. */
  async evaluate(expression, timeoutMs = cdp.CALL_TIMEOUT_MS) {
    let r;
    try {
      r = await this.conn.send('Runtime.evaluate', {
        expression: String(expression), returnByValue: true, awaitPromise: true,
      }, timeoutMs);
    } catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      return { ok: false, why: `the page threw: ${String(text).slice(0, 400)}` };
    }
    return { ok: true, value: r && r.result ? r.result.value : undefined };
  }

  /** WHAT IS THIS ELEMENT? */
  async element(selector) {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(String(selector))});
      if (!el) return { exists: false };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value;
      return {
        exists: true,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').trim().slice(0, 2000),
        value: 'value' in el ? String(el.value == null ? '' : el.value).slice(0, 500) : null,
        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        attributes: attrs,
      };
    })()`;
    return this.evaluate(expr);
  }

  /** THE ACCESSIBILITY TREE, which answers a different question from the DOM. */
  async axTree(selector = null) {
    try {
      if (selector) {
        const doc = await this.conn.send('DOM.getDocument', { depth: 1 });
        const node = await this.conn.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: String(selector) });
        if (!node || !node.nodeId) return { ok: false, why: `no element matches ${selector}` };
        const ax = await this.conn.send('Accessibility.getPartialAXTree', { nodeId: node.nodeId, fetchRelatives: false });
        return { ok: true, nodes: (ax.nodes || []).map(axRow) };
      }
      const ax = await this.conn.send('Accessibility.getFullAXTree', { max_depth: 6 });
      return { ok: true, nodes: (ax.nodes || []).slice(0, 300).map(axRow) };
    } catch (e) {
      return { ok: false, why: `the accessibility tree is not available: ${(e && e.message) || e}` };
    }
  }

  async click(selector) {
    const r = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(String(selector))});
      if (!el) return 'missing';
      el.click();
      return 'clicked';
    })()`);
    if (!r.ok) return { ok: false, why: r.why };
    return r.value === 'clicked'
      ? { ok: true, why: `clicked ${selector}` }
      : { ok: false, why: `nothing matches ${selector}` };
  }

  /** TYPE INTO A FIELD, and dispatch the events a framework listens for. */
  async type(selector, text) {
    const r = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(String(selector))});
      if (!el) return 'missing';
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      if (setter && setter.set) setter.set.call(el, ${JSON.stringify(String(text))});
      else el.value = ${JSON.stringify(String(text))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'typed';
    })()`);
    if (!r.ok) return { ok: false, why: r.why };
    return r.value === 'typed' ? { ok: true, why: `typed into ${selector}` } : { ok: false, why: `nothing matches ${selector}` };
  }

  /** Wait for a selector to appear. Bounded, and it says so when it gives up. */
  async waitFor(selector, timeoutMs = 8000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (!this.open) return { ok: false, why: 'browser session closed' };
      // eslint-disable-next-line no-await-in-loop -- polling the page is the
      // only way to wait for arbitrary DOM; the deadline is the caller's.
      const el = await this.element(selector);
      if (el.ok && el.value && el.value.exists) return { ok: true, why: `${selector} appeared` };
      if (Date.now() >= deadline) return { ok: false, why: `${selector} did not appear within ${timeoutMs}ms` };
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** A PNG of the page, as a Buffer, or null with the reason. */
  async screenshot({ selector = null, pad = 16 } = {}) {
    try {
      let clip = null;
      if (selector) {
        const at = await this.conn.send('Runtime.evaluate', { returnByValue: true, expression: `(() => { const e = document.querySelector(${JSON.stringify(String(selector))}); if (!e) return null;
          e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }; })()` }, 10000);
        const b = at && at.result ? at.result.value : null;
        if (!b || !(b.w > 0 && b.h > 0)) return { ok: false, why: `${selector} is not on the page, or has no area` };
        const x = Math.max(0, b.x - pad); const y = Math.max(0, b.y - pad);
        clip = { x, y, width: Math.ceil(b.w + (b.x - x) + pad), height: Math.ceil(b.h + (b.y - y) + pad), scale: 1 };
      }
      const r = await this.conn.send('Page.captureScreenshot', clip ? { format: 'png', clip, captureBeyondViewport: true } : { format: 'png' }, 20000);
      if (!r || !r.data) return { ok: false, why: 'the browser returned no image data' };
      return { ok: true, buffer: Buffer.from(r.data, 'base64') };
    } catch (e) {
      return { ok: false, why: `the screenshot failed: ${(e && e.message) || e}` };
    }
  }

  close(why = 'closed by the harness') {
    if (this._loads) for (const finish of [...this._loads]) finish(false);
    if (this.conn) this.conn.close(why);
  }
}

function axRow(n) {
  return {
    role: n.role && n.role.value,
    name: n.name && n.name.value,
    disabled: Boolean((n.properties || []).find((p) => p.name === 'disabled' && p.value && p.value.value)),
    ignored: Boolean(n.ignored),
  };
}

module.exports = {
  BrowserSession, available, findBrowser, candidates,
  DEFAULT_PORT, NAV_TIMEOUT_MS, LAUNCH_TIMEOUT_MS, axRow,
};
