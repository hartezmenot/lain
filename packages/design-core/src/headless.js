'use strict';

/**
 * THE HEADLESS PREVIEW DRIVER — `design_interact` and "Run test" when no Design window is attached. A headless
 * Chromium of its own (own profile directory, own debug port, no window), driven over CDP: trusted mouse and keyboard
 * events dispatched INTO THE PAGE, never the machine's pointer, keyboard or windows. The Design runtime in the page
 * draws the virtual cursor and ripple, so screenshots show where each action landed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BROWSERS = {
  win32: () => {
    const pf = process.env.ProgramFiles || 'C:\\Program Files'; const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [path.join(pf, 'Google/Chrome/Application/chrome.exe'), path.join(pf86, 'Google/Chrome/Application/chrome.exe'), path.join(local, 'Google/Chrome/Application/chrome.exe'), path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'), path.join(pf, 'Microsoft/Edge/Application/msedge.exe')];
  },
  darwin: () => ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: () => ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium', '/usr/bin/microsoft-edge'],
};

function findBrowser() {
  const list = [process.env.LAIN_CHROMIUM, ...(BROWSERS[process.platform] || BROWSERS.linux)()].filter(Boolean);
  for (const p of list) {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return p;
      if (st.isDirectory()) {   // a Playwright browsers folder: chromium-*/chrome-linux/chrome
        for (const d of fs.readdirSync(p).filter((x) => /^chromium/.test(x)).sort().reverse()) {
          for (const c of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-win/chrome.exe', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) { const f = path.join(p, d, c); if (fs.existsSync(f)) return f; }
        }
      }
    } catch { /* not here */ }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Page {
  constructor(ws, sessionId, browser) { this.ws = ws; this.sessionId = sessionId; this.browser = browser; }
  send(method, params = {}) { return this.browser.call(method, params, this.sessionId); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result ? r.result.value : undefined;
  }
}

class Headless {
  constructor() { this.proc = null; this.ws = null; this.id = 0; this.pending = new Map(); this.handlers = []; this.dir = null; this.errors = []; this.navs = 0; this.loads = 0; }

  async launch({ width = 390, height = 844, dpr = 2, mobile = true } = {}) {
    if (typeof globalThis.WebSocket !== 'function') throw new Error(`Node ${process.version} has no WebSocket — the headless preview needs Node 22 or newer`);
    const bin = findBrowser();
    if (!bin) throw new Error('no Chromium, Chrome or Edge found for the headless preview (set LAIN_CHROMIUM to one)');
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-design-'));
    const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${this.dir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--mute-audio', '--hide-scrollbars',
      // NOTHING LEAVES THE MACHINE: no update checks, sync, metrics or safe-browsing pings from the preview browser.
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings', '--disable-domain-reliability',
      '--metrics-recording-only', '--disable-client-side-phishing-detection', '--disable-default-apps', '--no-service-autorun', 'about:blank'];
    if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');
    this.proc = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
    const portFile = path.join(this.dir, 'DevToolsActivePort');
    let lines = null;
    for (let i = 0; i < 150 && !lines; i++) { await sleep(100); try { const t = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/); if (t.length >= 2) lines = t; } catch { /* not yet */ } }
    if (!lines) { this.close(); throw new Error('the headless browser did not open its debug port'); }
    this.ws = new globalThis.WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
    await new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', () => rej(new Error('the debug socket failed'))); });
    this.ws.addEventListener('message', (m) => {
      let msg; try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result || {}); return; }
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(String((msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description) || msg.params.exceptionDetails.text).split('\n')[0].slice(0, 300));
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') this.errors.push((msg.params.args || []).map((a) => (a.value != null ? String(a.value) : a.description || a.type)).join(' ').slice(0, 300));
      if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) this.navs += 1;
      if (msg.method === 'Page.loadEventFired') this.loads += 1;
      for (const h of this.handlers) { try { h(msg); } catch { /* listener */ } }
    });
    const { targetId } = await this.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.call('Target.attachToTarget', { targetId, flatten: true });
    this.page = new Page(this.ws, sessionId, this);
    for (const d of ['Page', 'Runtime', 'Log']) await this.page.send(`${d}.enable`);
    await this.viewport({ width, height, dpr, mobile });
    return this;
  }

  call(method, params = {}, sessionId = null) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} timed out`)); }, 20000);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify(sessionId ? { id, sessionId, method, params } : { id, method, params }));
    });
  }

  viewport({ width = 390, height = 844, dpr = 2, mobile = true } = {}) {
    this.size = { width, height };
    return this.page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
  }

  async goto(url, { timeoutMs = 15000 } = {}) {
    const before = this.loads;
    await this.page.send('Page.navigate', { url });
    await this.settle({ fromLoads: before, timeoutMs });
  }

  /** Wait for the runtime after a load (or a fixed settle when nothing navigated). */
  async settle({ fromLoads = null, timeoutMs = 8000, quietMs = 350 } = {}) {
    const end = Date.now() + timeoutMs;
    if (fromLoads != null) while (this.loads <= fromLoads && Date.now() < end) await sleep(40);
    await sleep(quietMs);
    while (Date.now() < end) { try { if (await this.page.eval('Boolean(window.__lainDesign)')) break; } catch { /* navigating */ } await sleep(60); }
  }

  async screenshot() { const r = await this.page.send('Page.captureScreenshot', { format: 'png' }); return Buffer.from(r.data, 'base64'); }

  close() {
    try { if (this.ws) this.ws.close(); } catch { /* gone */ }
    try { if (this.proc) this.proc.kill(); } catch { /* gone */ }
    const dir = this.dir; this.dir = null;
    if (dir) setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the browser still holds it */ } }, 500);
  }
}

const FIND = (t) => `(() => {
  const t = ${JSON.stringify(t)};
  let n = null;
  if (typeof t === 'string') n = document.querySelector('[data-lain-id="' + t + '"]') || document.getElementById(t);
  else if (t && t.node) n = document.querySelector('[data-lain-id="' + t.node + '"]');
  else if (t && t.selector) n = document.querySelector(t.selector);
  else if (t && t.text) n = [...document.querySelectorAll('a,button,[role=button],input,[data-lain-id]')].find((x) => (x.innerText || x.value || x.getAttribute('aria-label') || '').trim() === t.text) || null;
  if (!n) return null;
  n.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = n.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), id: n.getAttribute('data-lain-id'), visible: r.width > 0 && r.height > 0 };
})()`;

/**
 * RUN STEPS against the page: [{ action: 'click'|'type'|'press'|'scroll'|'drag'|'hover'|'wait', target?, x?, y?,
 * text?, key?, dy?, to?, ms? }]. Each step returns what it observed: url, DOM change counts, console errors, and a
 * screenshot when asked. Trusted CDP input, dispatched into this page only.
 */
async function runSteps(h, steps, { screenshots = 'last' } = {}) {
  const page = h.page;
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const errsBefore = h.errors.length; const loadsBefore = h.loads; const navsBefore = h.navs;
    try { await page.eval('window.__lainDesign && (window.__lainDesign.setMode("live"), window.__lainDesign.mark())'); } catch { /* no runtime */ }
    let res = { ok: true };
    const point = async () => {
      if (s.x != null && s.y != null) return { x: s.x, y: s.y };
      const p = await page.eval(FIND(s.target));
      if (!p) throw new Error(`no element ${JSON.stringify(s.target)} on this screen`);
      return p;
    };
    const mouse = (type, p, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse', ...extra });
    const showCursor = (p, click) => page.eval(`window.__lainDesign && window.__lainDesign.cursor(${p.x}, ${p.y}, ${click ? 'true' : 'false'})`).catch(() => {});
    try {
      if (s.action === 'click' || s.action === 'tap') {
        const p = await point(); await showCursor(p, true);
        await mouse('mouseMoved', p); await mouse('mousePressed', p); await mouse('mouseReleased', p);
        res.at = p;
      } else if (s.action === 'hover') { const p = await point(); await showCursor(p, false); await mouse('mouseMoved', p); res.at = p; } else if (s.action === 'longpress') {
        const p = await point(); await showCursor(p, true); await mouse('mousePressed', p); await sleep(s.ms || 650); await mouse('mouseReleased', p); res.at = p;
      } else if (s.action === 'type') {
        if (s.target) { const p = await point(); await mouse('mousePressed', p); await mouse('mouseReleased', p); }
        await page.send('Input.insertText', { text: String(s.text || '') });
      } else if (s.action === 'press') {
        const key = String(s.key || 'Enter');
        const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Tab' ? 9 : key.toUpperCase().charCodeAt(0), text: key === 'Enter' ? '\r' : key.length === 1 ? key : undefined });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
      } else if (s.action === 'scroll') {
        const p = s.target ? await point() : { x: Math.round(h.size.width / 2), y: Math.round(h.size.height / 2) };
        await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: s.dx || 0, deltaY: s.dy == null ? 300 : s.dy });
      } else if (s.action === 'drag' || s.action === 'swipe') {
        const a = await point(); const b = s.to ? (s.to.x != null ? s.to : await page.eval(FIND(s.to))) : { x: a.x + (s.dx || 0), y: a.y + (s.dy || 0) };
        await showCursor(a, false); await mouse('mouseMoved', a); await mouse('mousePressed', a);
        for (let k = 1; k <= 8; k++) await mouse('mouseMoved', { x: Math.round(a.x + ((b.x - a.x) * k) / 8), y: Math.round(a.y + ((b.y - a.y) * k) / 8) }, { buttons: 1 });
        await mouse('mouseReleased', b); await showCursor(b, false); res.at = b;
      } else if (s.action === 'wait') { await sleep(Math.min(10000, s.ms || 500)); } else if (s.action === 'goto') {
        await h.goto(new URL(s.url, await page.eval('location.href')).href);
      } else throw new Error(`unknown action "${s.action}" (click, tap, hover, longpress, type, press, scroll, drag, swipe, wait, goto)`);
    } catch (e) { res = { ok: false, why: e.message }; }
    // SETTLE: a navigation waits for its load; anything else for animations and handlers to finish.
    await sleep(120);
    if (h.navs > navsBefore) await h.settle({ fromLoads: loadsBefore, timeoutMs: 10000, quietMs: s.settleMs || 400 }); else await sleep(s.settleMs || 400);
    let obs = {};
    try { obs = await page.eval('window.__lainDesign ? window.__lainDesign.observe() : { url: location.pathname + location.search, title: document.title }'); } catch (e) { obs = { why: e.message }; }
    const step = { step: i + 1, action: s.action, target: s.target || null, ...res, url: obs.url, title: obs.title, navigated: h.navs > navsBefore, changes: obs.changes || null, errors: h.errors.slice(errsBefore) };
    if (screenshots === 'each' || (screenshots === 'last' && i === steps.length - 1)) { try { step.screenshot = await h.screenshot(); } catch { /* none */ } }
    out.push(step);
    if (!res.ok && s.stopOnFail !== false) break;
  }
  return out;
}

module.exports = { Headless, runSteps, findBrowser };
