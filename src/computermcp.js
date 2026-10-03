'use strict';

/** COMPUTER MCP — LAIN's structured eyes and hands on this desktop. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const mcp = require('./mcp');
const permissionsMod = require('./permissions');

/** Everything the bridge offers, and what each needs. See mcp.js OPS. */
const CAPS = Object.freeze(['screen', 'keyboard', 'mouse', 'window', 'clipboard']);

/** A batch may not be a program. */
const MAX_BATCH = 20;

/** The three verdicts, from the one place that owns them. */
const { VERDICT } = require('./harness/checks');

const HOME = () => process.env.LAIN_HOME || require('./home').userHome();
const SOURCE = path.join(__dirname, 'computermcp', 'bridge.cs');

/** The .NET Framework compiler that ships with Windows, or null. */
function compiler() {
  const roots = [process.env.SystemRoot || 'C:\\Windows'];
  for (const root of roots) {
    for (const fw of ['Framework64', 'Framework']) {
      const exe = path.join(root, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

/** The GAC assemblies UI Automation lives in, by full path. */
function references() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const gac = path.join(root, 'Microsoft.NET', 'assembly', 'GAC_MSIL');
  const out = [];
  for (const name of ['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase']) {
    const dir = path.join(gac, name);
    let versions = [];
    try { versions = fs.readdirSync(dir); } catch { versions = []; }
    const hit = versions.map((v) => path.join(dir, v, `${name}.dll`)).find((p) => fs.existsSync(p));
    if (!hit) return { ok: false, why: `${name}.dll is not in the assembly cache — UI Automation is unavailable on this machine` };
    out.push(hit);
  }
  return { ok: true, refs: out };
}

/** BUILD THE BRIDGE, ONCE PER SOURCE VERSION. */
function ensureBridge() {
  if (process.platform !== 'win32') {
    return { ok: false, why: 'Computer MCP V1 drives Windows UI Automation; this machine is not Windows' };
  }
  let source;
  try { source = fs.readFileSync(SOURCE); } catch (e) { return { ok: false, why: `the bridge source is missing: ${e.message}` }; }
  const stamp = require('crypto').createHash('sha256').update(source).digest('hex').slice(0, 12);
  const dir = path.join(HOME(), 'computermcp');
  const exe = path.join(dir, `bridge-${stamp}.exe`);
  if (fs.existsSync(exe)) return { ok: true, exe, built: false };
  const csc = compiler();
  if (!csc) return { ok: false, why: 'no .NET Framework compiler (csc.exe) on this machine, so the bridge cannot be built' };
  const refs = references();
  if (!refs.ok) return refs;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the build will say */ }
  try {
    execFileSync(csc, [
      '-nologo', '-optimize+', '-target:exe', `-out:${exe}`,
      ...refs.refs.map((r) => `-r:${r}`),
      '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll', '-r:System.Web.Extensions.dll', '-r:System.dll',
      SOURCE,
    ], { stdio: 'pipe', timeout: 120_000, windowsHide: true });
  } catch (e) {
    const said = String((e && (e.stdout || e.stderr)) || (e && e.message) || '').trim().slice(0, 400);
    return { ok: false, why: `the bridge did not build: ${said || 'the compiler failed'}` };
  }
  if (!fs.existsSync(exe)) return { ok: false, why: 'the compiler reported success and produced no program' };
  return { ok: true, exe, built: true };
}

/** THE WINDOWS GRAPHICS CAPTURE HELPER (computermcp/wgc.cs) — one frame of one window, then it exits. */
function unionWinmd() {
  const root = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'UnionMetadata');
  let versions = [];
  try { versions = fs.readdirSync(root).filter((d) => /^\d+\./.test(d)).sort().reverse(); } catch { return null; }
  for (const v of versions) { const f = path.join(root, v, 'Windows.winmd'); if (fs.existsSync(f)) return f; }
  return null;
}
function ensureWgc() {
  if (process.platform !== 'win32') return { ok: false, why: 'Windows only' };
  const src = path.join(__dirname, 'computermcp', 'wgc.cs');
  let source;
  try { source = fs.readFileSync(src); } catch (e) { return { ok: false, why: e.message }; }
  const stamp = require('crypto').createHash('sha256').update(source).digest('hex').slice(0, 12);
  const exe = path.join(HOME(), 'computermcp', `wgc-${stamp}.exe`);
  if (fs.existsSync(exe)) return { ok: true, exe };
  const winmd = unionWinmd();
  const csc = compiler();
  if (!winmd || !csc) return { ok: false, why: !winmd ? 'the Windows SDK union metadata is not installed — capture uses PrintWindow' : 'no csc.exe' };
  const fw = path.dirname(csc);
  try {
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    execFileSync(csc, ['-nologo', '-optimize+', '-target:exe', '-platform:x64', `-out:${exe}`, `-r:${winmd}`,
      `-r:${path.join(fw, 'System.Runtime.WindowsRuntime.dll')}`, `-r:${path.join(fw, 'System.Runtime.dll')}`, `-r:${path.join(fw, 'System.Threading.Tasks.dll')}`, src],
    { stdio: 'pipe', timeout: 120_000, windowsHide: true });
  } catch (e) { return { ok: false, why: `the capture helper did not build: ${String((e && (e.stdout || e.message)) || '').trim().slice(0, 200)}` }; }
  return fs.existsSync(exe) ? { ok: true, exe } : { ok: false, why: 'the capture helper was not produced' };
}

/** The synthetic config one Bridge needs to run one program. */
function bridgeConfig(exe) {
  return { mcp: { servers: { computer: { command: [exe], name: 'LAIN Computer MCP' } } } };
}

class ComputerMCP {
  constructor(app) {
    this.app = app;
    this.bridge = null;
    this.exe = null;
    this.why = '';
    /** What this session has actually done, for the Harness and `/mcp`. */
    this.steps = [];
    this.authorizedAt = 0;
  }

  get permissions() { return this.app.desktop().permissions; }

  /** Is the desktop authorized right now? One question, one answer. */
  get authorized() {
    const c = this.permissions.check('screen');
    return Boolean(c.ok && c.grant && c.grant.scope === permissionsMod.SCOPE.COMPUTER);
  }

  get connected() { return Boolean(this.bridge && this.bridge.state === mcp.STATE.CONNECTED); }

  _note(text, verdict = null) {
    this.steps.push({ at: Date.now(), text: String(text).slice(0, 200), verdict });
    if (this.steps.length > 60) this.steps.shift();
    try { require('./controlwindow').write(this.app); } catch { /* no window open */ }
  }

  /** CONNECT AND ASK. The question is asked ONCE per session; a reconnect while it still stands does not ask again. */
  async connect({ ask = true } = {}) {
    if (!this.connected) {
      const built = ensureBridge();
      if (!built.ok) { this.why = built.why; return { ok: false, why: built.why }; }
      this.exe = built.exe;
      this.bridge = new mcp.Bridge(bridgeConfig(built.exe), this.permissions);
      this.bridge._app = this.app;
      const r = await this.bridge.connect();
      if (!r.ok) { this.why = r.reason || 'the bridge did not start'; return { ok: false, why: this.why }; }
      this._note(`connected · ${this.bridge.capabilities.length} operations`);
    }
    if (this.authorized) return { ok: true, authorized: true, capabilities: this.bridge.capabilities, reused: true };
    if (!ask) return { ok: true, authorized: false, capabilities: this.bridge.capabilities };
    const granted = await this.authorize();
    return { ok: granted.ok, authorized: granted.ok, why: granted.why, capabilities: this.bridge.capabilities };
  }

  /** THE ONE QUESTION. Not a list of capabilities to tick: a person decides whether LAIN may use this computer, and everything the bridge offers is what… */
  async authorize() {
    const interaction = require('./interaction');
    if (!interaction.available(this.app)) {
      return { ok: false, why: 'no interactive surface — the desktop is never authorized unattended' };
    }
    const YES = 'Allow session';
    let answer = null;
    try {
      answer = await interaction.ask(this.app, {
        title: 'Allow LAIN to observe and control this computer?',
        question: [
          'LAIN will be able to see the windows on this machine, read their controls,',
          'move the mouse, click, type, and use the clipboard.',
          '',
          'This lasts for THIS LAIN SESSION. Disconnect, /mcp revoke or closing LAIN ends it.',
          'Actions that change files or reach outside this machine are still asked about separately.',
        ].join('\n'),
        options: [YES, 'Cancel'],
      });
    } catch { answer = null; }
    if (answer !== YES) {
      this.permissions.deny(CAPS, 'the user did not authorize the computer');
      this._note('authorization refused', VERDICT.FAILED);
      return { ok: false, why: 'the computer was not authorized' };
    }
    this.permissions.grant(CAPS, { scope: permissionsMod.SCOPE.COMPUTER });
    this.authorizedAt = Date.now();
    this._note('authorized for this session');
    return { ok: true };
  }

  /** End it: the bridge goes, and the authorization goes with it. */
  disconnect(why = 'disconnected') {
    const had = this.authorized;
    try { const r = (this.app && this.app._sibling) || this.app; if (r && r._computerControl) r._computerControl.on = false; } catch { /* no state */ }
    if (this.bridge) this.bridge.close(why);
    this.bridge = null;
    this.permissions.revoke(why);
    this._note(`disconnected — ${why}`);
    return { ok: true, wasAuthorized: had };
  }

  /** One operation. COMPUTER CONTROL admits it first (computercontrol.js: on for this session, the tier, the target lock, sensitive surfaces); the… */
  async call(op, params = {}, { internal = false } = {}) {
    if (!this.connected) return { ok: false, why: this.why || 'Computer MCP is not connected — /computer on' };
    if (!this.authorized) return { ok: false, why: 'the computer is not authorized for this session — /computer on' };
    const cc = require('./computercontrol');
    const a = cc.admit(this.app, op, params, { internal });
    if (!a.ok) return { ok: false, why: a.why, denied: true };
    if (op === 'uia.setValue') { const g = await cc.guardValue(this.app, this, a.params); if (!g.ok) return { ok: false, why: g.why, denied: true }; }
    const r = await this.bridge.call(op, a.params);
    const out = r.ok ? { ok: true, result: r.result } : { ok: false, why: r.error || 'the bridge refused', denied: Boolean(r.denied) };
    cc.noteResult(this.app, op, out);
    return out;
  }

  // ------------------------------------------------------------ observing --

  async windows() { return this.call('window.list'); }
  async active() { return this.call('window.active'); }
  async displays() { return this.call('displays'); }
  async tree(params) { return this.call('uia.tree', params); }
  async find(params) { return this.call('uia.find', params); }
  async value(params) { return this.call('uia.getValue', params); }
  async capture(params) { return this.call('screen.capture', params); }

  /** ONE FRAME OF ONE WINDOW, on demand: Windows Graphics Capture when the helper exists (GPU content, occluded windows), else the bridge's PrintWindow. */
  async captureWindow({ handle, path: out = null } = {}) {
    const a = require('./computercontrol').admit(this.app, 'window.capture', { handle });
    if (!a.ok) return { ok: false, why: a.why, denied: true };
    const w = ensureWgc();
    if (w.ok && handle != null) {
      const file = out || path.join(require('os').tmpdir(), `lain-wgc-${Date.now()}.png`);
      try {
        const said = execFileSync(w.exe, [String(handle), file], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
        const j = JSON.parse(String(said).trim().split(/\r?\n/).pop());
        if (j.ok && fs.existsSync(file)) return { ok: true, result: { path: file, region: { width: j.width, height: j.height }, method: 'Windows Graphics Capture' } };
      } catch { /* the bridge's PrintWindow below */ }
    }
    const r = await this.call('window.capture', { handle, path: out });
    if (r.ok && w && !w.ok) r.result.note = w.why;
    return r;
  }

  /** WHAT IS TRUE NOW, for one expectation. */
  async observe(expect = {}, { timeoutMs = 8000 } = {}) {
    if (expect.window) {
      // A WINDOW IS NAMED, OR NAMED WITHIN A PROCESS.
      const w = typeof expect.window === 'string' ? { title: expect.window } : (expect.window || {});
      const said = w.title || w.window || '';
      const r = await this.call('wait.window', { ...w, title: said, timeoutMs });
      const where = w.pid ? ` of pid ${w.pid}` : '';
      return { ok: r.ok && r.result && r.result.found === true, why: r.ok ? `window "${said}"${where} ${r.result.found ? 'is open' : 'never appeared'}` : r.why, observed: r.result };
    }
    if (expect.control) {
      const r = await this.call('wait.control', { ...expect.control, timeoutMs });
      return { ok: r.ok && r.result && r.result.found === true, why: r.ok ? `control ${describeTarget(expect.control)} ${r.result.found ? 'is present' : 'never appeared'}` : r.why, observed: r.result };
    }
    if (expect.gone) {
      const r = await this.call('wait.gone', { ...expect.gone, timeoutMs });
      return { ok: r.ok && r.result && r.result.gone === true, why: r.ok ? (r.result.gone ? 'it is gone' : 'it is still there') : r.why, observed: r.result };
    }
    if (expect.value) {
      const want = String(expect.value.contains == null ? '' : expect.value.contains);
      const deadline = Date.now() + timeoutMs;
      let last = null;
      for (;;) {
        const r = await this.call('uia.getValue', expect.value);
        last = r.ok ? r.result : null;
        const text = last ? String(last.value == null ? '' : last.value) : '';
        if (r.ok && text.toLowerCase().includes(want.toLowerCase())) return { ok: true, why: `it reads ${JSON.stringify(text.slice(0, 120))}`, observed: last };
        if (Date.now() >= deadline) {
          return { ok: false, why: r.ok ? `it reads ${JSON.stringify(text.slice(0, 120))}, not ${JSON.stringify(want)}` : r.why, observed: last };
        }
        await sleep(250);
      }
    }
    if (expect.foreground) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const r = await this.call('window.active');
        const title = (r.ok && r.result && r.result.window && r.result.window.title) || '';
        if (title.toLowerCase().includes(String(expect.foreground).toLowerCase())) return { ok: true, why: `"${title}" is in front`, observed: r.result };
        if (Date.now() >= deadline) return { ok: false, why: `"${title || 'nothing'}" is in front, not "${expect.foreground}"`, observed: r.result };
        await sleep(200);
      }
    }
    return { ok: null, why: 'nothing was expected, so nothing was checked' };
  }

  /** START AN APPLICATION — through the Harness process authority, never a second process manager, so it is owned, listed by `/ps`, and cleaned up with… */
  async openApp(command, { args = null, name = null, waitTitle = null, timeoutMs = 20000 } = {}) {
    const harness = require('./harnesslink').harnessFor(this.app);
    if (!harness || !harness.processes) return { ok: false, why: 'no process authority — an application cannot be owned' };
    // THE WINDOWS THAT WERE ALREADY THERE.
    const beforeWins = await this.windows().catch(() => null);
    const existed = new Set(((beforeWins && beforeWins.ok && beforeWins.result && beforeWins.result.windows) || []).map((w) => w.handle));
    const started = harness.processes.start({
      name: String(name || command), command: String(command), args: args || null, cwd: this.app.cwd || process.cwd(),
    });
    if (!started || started.ok === false) return { ok: false, why: (started && started.why) || 'the application did not start' };
    const pid = started.pid || (started.process && started.process.pid) || started.commandPid || null;
    this._note(`opened ${name || command}${pid ? ` · pid ${pid}` : ''}`);
    // ITS OWN WINDOW, waited for by PID where the OS gives us one.
    const deadline = Date.now() + timeoutMs;
    const wanted = waitTitle ? String(waitTitle).toLowerCase() : '';
    let seen = null;
    let sharing = [];
    while (Date.now() < deadline) {
      const wins = await this.windows();
      const rows = (wins.ok && wins.result && wins.result.windows) || [];
      const mine = pid ? rows.filter((w) => w.pid === pid) : [];
      const named = wanted ? rows.filter((w) => String(w.title || '').toLowerCase().includes(wanted)) : [];
      const fresh = (w) => !existed.has(w.handle);
      const both = mine.filter((w) => named.includes(w) && fresh(w));
      seen = both[0] || (wanted ? named.filter(fresh)[0] : null) || (mine.filter(fresh).length === 1 ? mine.filter(fresh)[0] : null);
      sharing = mine;
      if (seen) break;
      await sleep(250);
    }
    const why = seen ? ''
      : (sharing.length > 1
        ? `the application started and its process owns ${sharing.length} windows (${sharing.map((w) => JSON.stringify(w.title)).join(', ')}) — name the one you mean`
        : 'the application started and no window of its own appeared');
    return { ok: true, pid, process: started, window: seen, handle: seen ? seen.handle : null, why };
  }

  // -------------------------------------------------------------- acting --

  /** ONE ACTION, VERIFIED. */
  async act(spec = {}) {
    const action = String(spec.action || '');
    const trail = [];
    const say = (text, verdict = null) => { trail.push({ text, verdict }); this._note(text, verdict); };

    // ---- OBSERVE THE START STATE -----------------------------------------
    if (spec.start) {
      const before = await this.observe(spec.start, { timeoutMs: spec.startTimeoutMs || 4000 });
      if (before.ok === false) {
        say(`start state wrong: ${before.why}`, VERDICT.FAILED);
        return { verdict: VERDICT.FAILED, why: `nothing was done — ${before.why}`, trail, acted: false };
      }
      say(`start state: ${before.why}`);
    }

    const done = await this._perform(action, spec);
    if (!done.ok) {
      say(`${action} failed: ${done.why}`, VERDICT.FAILED);
      return { verdict: VERDICT.FAILED, why: done.why, trail, acted: false, denied: done.denied };
    }
    say(`${action}${describeTarget(spec.target) ? ` · ${describeTarget(spec.target)}` : ''} — delivered${done.method ? ` (${done.method})` : ''}`);

    // ---- OBSERVE THE RESULT ----------------------------------------------
    if (!spec.expect) {
      return {
        verdict: VERDICT.INCONCLUSIVE,
        why: 'the input was delivered and nothing was checked — say what should become true (`expect`) to get a verdict',
        trail, acted: true, result: done.result,
      };
    }
    const after = await this.observe(spec.expect, { timeoutMs: spec.timeoutMs || 8000 });
    if (after.ok === null) {
      return { verdict: VERDICT.INCONCLUSIVE, why: after.why, trail, acted: true, result: done.result };
    }
    const verdict = after.ok ? VERDICT.PASSED : VERDICT.FAILED;
    say(`observed: ${after.why}`, verdict);
    return { verdict, why: after.why, trail, acted: true, result: done.result, observed: after.observed };
  }

  /** The action itself. Nothing here decides whether it worked. */
  async _perform(action, spec) {
    const t = spec.target || {};
    switch (action) {
      case 'focus_window': {
        const r = await this.call('window.focus', { window: t.window || spec.window, handle: t.handle });
        if (!r.ok) return r;
        if (!r.result || r.result.focused !== true) {
          return { ok: false, why: `the OS did not put "${t.window || spec.window}" in front — ${(r.result && r.result.note) || 'it refused'}` };
        }
        return { ok: true, result: r.result };
      }
      case 'click_control': {
        const r = await this.call('uia.invoke', t);
        return r.ok ? { ok: true, result: r.result, method: r.result && r.result.method } : r;
      }
      case 'type_into': {
        const r = await this.call('uia.setValue', { ...t, text: String(spec.text == null ? '' : spec.text), append: Boolean(spec.append) });
        return r.ok ? { ok: true, result: r.result, method: r.result && r.result.method } : r;
      }
      case 'focus_control': {
        const r = await this.call('uia.focus', t);
        return r.ok ? { ok: true, result: r.result } : r;
      }
      case 'key': {
        const keys = Array.isArray(spec.keys) ? spec.keys : [spec.key];
        const r = await this.call('keyboard.key', { keys });
        return r.ok ? { ok: true, result: r.result } : r;
      }
      case 'type': {
        const r = await this.call('keyboard.type', { text: String(spec.text == null ? '' : spec.text) });
        return r.ok ? { ok: true, result: r.result } : r;
      }
      case 'click': {
        // NO COORDINATES IS NOT "WHEREVER THE MOUSE IS".
        if (!Number.isFinite(Number(spec.x)) || !Number.isFinite(Number(spec.y)) || spec.x == null || spec.y == null) {
          if (t.name || t.automationId || t.ref) return this._perform('click_control', spec);
          return { ok: false, why: 'click needs x and y, or a target to click (click_control) — nothing was clicked' };
        }
        const r = await this.call('mouse.click', { x: spec.x, y: spec.y, button: spec.button, count: spec.count });
        return r.ok ? { ok: true, result: r.result } : r;
      }
      case 'scroll': {
        const r = await this.call('mouse.scroll', { x: spec.x, y: spec.y, clicks: spec.clicks });
        return r.ok ? { ok: true, result: r.result } : r;
      }
      case 'drag': {
        const r = await this.call('mouse.drag', { fromX: spec.fromX, fromY: spec.fromY, toX: spec.toX, toY: spec.toY });
        return r.ok ? { ok: true, result: r.result } : r;
      }
      case 'close_window': {
        const r = await this.call('window.close', { window: t.window || spec.window, handle: t.handle });
        return r.ok ? { ok: true, result: r.result } : r;
      }
      case 'clipboard_write': {
        const r = await this.call('clipboard.write', { text: String(spec.text == null ? '' : spec.text) });
        return r.ok ? { ok: true, result: r.result } : r;
      }
      case 'clipboard_read': {
        const r = await this.call('clipboard.read', {});
        return r.ok ? { ok: true, result: r.result } : r;
      }
      default:
        return { ok: false, why: `there is no action "${action}"` };
    }
  }

  /** A BOUNDED SEQUENCE THAT STOPS THE MOMENT THE SCREEN DISAGREES. */
  async batch(steps = [], { continueUnverified = false } = {}) {
    const list = Array.isArray(steps) ? steps.slice(0, MAX_BATCH) : [];
    if (!list.length) return { verdict: VERDICT.INCONCLUSIVE, why: 'no steps', steps: [] };
    const done = [];
    for (let i = 0; i < list.length; i++) {
      const r = await this.act(list[i]);
      done.push({ step: i + 1, action: list[i].action, verdict: r.verdict, why: r.why });
      if (r.verdict === VERDICT.FAILED) {
        return { verdict: VERDICT.FAILED, why: `step ${i + 1} (${list[i].action}) failed: ${r.why}`, steps: done, stoppedAt: i + 1, remaining: list.length - i - 1 };
      }
      if (r.verdict === VERDICT.INCONCLUSIVE && !continueUnverified) {
        return { verdict: VERDICT.INCONCLUSIVE, why: `step ${i + 1} (${list[i].action}) could not be verified: ${r.why}`, steps: done, stoppedAt: i + 1, remaining: list.length - i - 1 };
      }
    }
    return { verdict: VERDICT.PASSED, why: `${done.length} step(s), each observed`, steps: done };
  }

  /** What every surface reads. Never claims more than is true. */
  status() {
    const built = this.exe ? { built: true, exe: this.exe } : { built: false };
    return {
      platform: process.platform,
      available: process.platform === 'win32',
      connected: this.connected,
      authorized: this.authorized,
      why: this.why || '',
      capabilities: this.bridge ? this.bridge.capabilities : [],
      permissions: this.permissions.state(),
      steps: this.steps.slice(-20),
      bridge: built,
    };
  }
}

/** Exactly the case labels `ComputerMCP.prototype._perform` handles — see its doc comment. */
const PERFORM_ACTIONS = new Set([
  'focus_window', 'click_control', 'type_into', 'focus_control', 'key', 'type',
  'click', 'scroll', 'drag', 'close_window', 'clipboard_write', 'clipboard_read',
]);

function describeTarget(t) {
  if (!t) return '';
  const bits = [];
  if (t.name) bits.push(JSON.stringify(t.name));
  if (t.automationId) bits.push(`#${t.automationId}`);
  if (t.controlType) bits.push(t.controlType);
  if (t.window) bits.push(`in ${JSON.stringify(t.window)}`);
  return bits.join(' ');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** One per App, created on first use. */
function forApp(app) {
  if (!app) return null;
  if (!app._computerMcp) app._computerMcp = new ComputerMCP(app);
  return app._computerMcp;
}

/** The one that already exists, for readers that must not create one. */
function existing(app) { return (app && app._computerMcp) || null; }

module.exports = { ComputerMCP, forApp, existing, ensureBridge, ensureWgc, compiler, references, CAPS, MAX_BATCH, VERDICT, describeTarget, PERFORM_ACTIONS };
