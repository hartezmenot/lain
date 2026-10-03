'use strict';

/** THE DESKTOP BRIDGE SEAM. */

const { spawn } = require('child_process');

/** Operation → the permission it requires. */
const OPS = Object.freeze({
  'screen.capture': 'screen',
  'mouse.move': 'mouse',
  'mouse.click': 'mouse',
  'mouse.drag': 'mouse',
  'mouse.scroll': 'mouse',
  'keyboard.type': 'keyboard',
  'keyboard.key': 'keyboard',
  'window.list': 'window',
  'window.focus': 'window',
  'window.active': 'window',
  'window.close': 'window',
  displays: 'window',
  'cursor.get': 'screen',
  // READS of the accessibility tree. `screen` is the capability they need: they
  // see what is on this machine, they change nothing.
  'uia.tree': 'screen',
  'uia.find': 'screen',
  'uia.getValue': 'screen',
  'wait.window': 'screen',
  'wait.control': 'screen',
  'wait.gone': 'screen',
  // ACTIONS AIMED BY THE TREE. `uia.invoke` presses a control the way a person
  // does; `uia.setValue` puts text into one; `uia.focus` moves the caret.
  'uia.invoke': 'mouse',
  'uia.setValue': 'keyboard',
  'uia.focus': 'window',
  'clipboard.read': 'clipboard',
  'clipboard.write': 'clipboard',
  // COMPUTER CONTROL (Phase CU): primitives, the target lock, the kill switch, one frame of a window.
  'mouse.button': 'mouse',
  'mouse.moveRel': 'mouse',
  'keyboard.down': 'keyboard',
  'keyboard.up': 'keyboard',
  'keyboard.hold': 'keyboard',
  'window.capture': 'screen',
  'control.arm': 'window',
  'control.disarm': 'window',
  'control.kill': 'window',
  'control.resume': 'window',
  'control.state': 'screen',
});

const STATE = Object.freeze({
  NOT_CONFIGURED: 'NOT CONFIGURED',
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
});

const HELLO_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 15_000;
/** AN OPERATION THAT IS *SUPPOSED* TO BLOCK MUST NOT BE CUT OFF BY THE PIPE. */
const CALL_GRACE_MS = 5_000;
const MAX_CALL_TIMEOUT_MS = 120_000;

function callDeadline(params) {
  const asked = Number(params && params.timeoutMs);
  if (!Number.isFinite(asked) || asked <= 0) return CALL_TIMEOUT_MS;
  return Math.min(MAX_CALL_TIMEOUT_MS, Math.max(CALL_TIMEOUT_MS, asked + CALL_GRACE_MS));
}
const MAX_LINE = 4_000_000;      // a screenshot arrives as one line

/** EVERY CONFIGURED SERVER, by name. */
function servers(cfg = {}) {
  const m = cfg.mcp || cfg.desktopBridge || null;
  if (!m) return [];
  const one = (id, s) => {
    if (!s || !Array.isArray(s.command) || !s.command.length) return null;
    return {
      id,
      command: s.command.map(String),
      cwd: s.cwd || undefined,
      // A server inherits NOTHING by default.
      env: s.env && typeof s.env === 'object' ? { ...s.env } : {},
      name: s.name || s.command[0],
      enabled: s.enabled !== false,
    };
  };
  if (m.servers && typeof m.servers === 'object') {
    return Object.entries(m.servers).map(([id, s]) => one(id, s)).filter(Boolean);
  }
  const legacy = one('desktop', m);
  return legacy ? [legacy] : [];
}

/** The server the DESKTOP tool talks to. */
function settings(cfg = {}) {
  const all = servers(cfg).filter((s) => s.enabled);
  if (!all.length) return null;
  return all.find((s) => s.id === 'desktop') || all[0];
}

function configured(cfg) { return settings(cfg) !== null; }

class Bridge {
  constructor(cfg, permissions) {
    this.cfg = cfg || {};
    this.permissions = permissions;
    this.child = null;
    this.state = configured(this.cfg) ? STATE.DISCONNECTED : STATE.NOT_CONFIGURED;
    this.reason = configured(this.cfg) ? 'not started' : 'no bridge command in config';
    this.capabilities = [];
    this.info = null;
    this._pending = new Map();
    this._seq = 0;
    this._buf = '';
    /** Bounded record of what actually went across, for the control window. */
    this.activity = [];
  }

  _note(text, ok = true) {
    this.activity.push({ at: Date.now(), text: String(text), ok });
    if (this.activity.length > 100) this.activity.shift();
  }

  /** Start the bridge and complete the handshake. Never throws. */
  async connect() {
    const s = settings(this.cfg);
    if (!s) {
      this.state = STATE.NOT_CONFIGURED;
      this.reason = 'no bridge command in config';
      return { ok: false, state: this.state, reason: this.reason };
    }
    if (this.state === STATE.CONNECTED) return { ok: true, state: this.state };
    this.state = STATE.CONNECTING;
    this.reason = '';
    try {
      this.child = spawn(s.command[0], s.command.slice(1), {
        cwd: s.cwd,
        env: s.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return this._down(`could not start the bridge: ${e.message}`);
    }
    this.child.on('error', (e) => this._down(`bridge process error: ${e.message}`));
    this.child.on('exit', (code, sig) => this._down(`bridge exited (${sig || `code ${code}`})`));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this._onData(d));
    // A bridge's stderr is diagnostics, not protocol. Kept, bounded, shown.
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => this._note(`bridge stderr: ${String(d).trim().slice(0, 200)}`, false));

    const hello = await this._send({ op: 'hello', client: 'lain', version: 1 }, HELLO_TIMEOUT_MS);
    if (!hello.ok) return this._down(`handshake failed: ${hello.error}`);
    this.capabilities = Array.isArray(hello.capabilities) ? hello.capabilities.filter((c) => OPS[c]) : [];
    this.info = { name: hello.name || s.name, version: hello.version || null };
    this.state = STATE.CONNECTED;
    this.reason = '';
    this._note(`connected to ${this.info.name} · ${this.capabilities.length} capability(ies)`);
    return { ok: true, state: this.state, capabilities: this.capabilities, info: this.info };
  }

  _down(reason) {
    const wasConnected = this.state === STATE.CONNECTED;
    this.state = configured(this.cfg) ? STATE.DISCONNECTED : STATE.NOT_CONFIGURED;
    this.reason = String(reason || 'disconnected');
    this.capabilities = [];
    for (const [, p] of this._pending) p.reject(new Error(this.reason));
    this._pending.clear();
    if (wasConnected) this._note(this.reason, false);
    // A bridge that dies while it holds permission does not get to keep it.
    if (wasConnected && this.permissions) this.permissions.revoke('the bridge disconnected');
    return { ok: false, state: this.state, reason: this.reason };
  }

  _onData(chunk) {
    this._buf += chunk;
    if (this._buf.length > MAX_LINE * 2) { this._down('bridge sent an oversized message'); return; }
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this._note(`unparseable line from bridge: ${line.slice(0, 120)}`, false); continue; }
      const p = this._pending.get(msg.id);
      if (!p) continue;
      this._pending.delete(msg.id);
      p.resolve(msg);
    }
  }

  /** How long this one call may take, from what the caller asked the screen for. */
  static deadlineFor(params) { return callDeadline(params); }

  _send(payload, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve) => {
      if (!this.child || this.child.killed) { resolve({ ok: false, error: 'the bridge is not running' }); return; }
      const id = ++this._seq;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve({ ok: false, error: `no answer within ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this._pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); },
      });
      try { this.child.stdin.write(JSON.stringify({ id, ...payload }) + '\n'); }
      catch (e) { clearTimeout(timer); this._pending.delete(id); resolve({ ok: false, error: e.message }); }
    });
  }

  /** Perform one operation. */
  async call(op, params = {}) {
    const cap = OPS[op];
    if (!cap) return { ok: false, error: `unknown desktop operation "${op}"` };
    if (this.state !== STATE.CONNECTED) {
      return { ok: false, error: `the desktop bridge is ${this.state}${this.reason ? ` — ${this.reason}` : ''}` };
    }
    if (this.capabilities.length && !this.capabilities.includes(op)) {
      return { ok: false, error: `this bridge does not offer ${op}` };
    }
    const allowed = this.permissions ? this.permissions.check(cap) : { ok: false, why: 'no permission system' };
    if (!allowed.ok) {
      // NOT AN ERROR TO ROUTE AROUND. The caller is told exactly what is missing
      // and must go and ask the user for it.
      return { ok: false, denied: true, capability: cap, error: `permission to ${cap} is ${allowed.why}` };
    }
    const r = await this._send({ op, params }, callDeadline(params));
    if (this.permissions) this.permissions.used(cap, op);
    this._note(`${op} — ${r.ok ? 'ok' : `failed: ${r.error}`}`, Boolean(r.ok));
    // The control window shows each action as it happens, not a summary after.
    try { require('./controlwindow').write(this._app || null); } catch { /* no window open */ }
    if (!r.ok) return { ok: false, error: r.error || 'the bridge refused' };
    return { ok: true, result: r.result };
  }

  /** Stop the bridge and drop every grant with it. */
  close(why = 'closed') {
    if (this.permissions) this.permissions.revoke(why);
    if (this.child) { try { this.child.kill(); } catch { /* already gone */ } }
    this.child = null;
    this.state = configured(this.cfg) ? STATE.DISCONNECTED : STATE.NOT_CONFIGURED;
    this.reason = why;
    this.capabilities = [];
    return true;
  }

  /** What every status surface reads. Never claims more than is true. */
  status() {
    const perms = this.permissions ? this.permissions.state() : { active: false, capabilities: {}, log: [] };
    return {
      state: this.state,
      reason: this.reason,
      configured: configured(this.cfg),
      name: this.info ? this.info.name : (settings(this.cfg) || {}).name || null,
      capabilities: this.capabilities,
      permissions: perms,
      target: perms.target || null,
      activity: this.activity.slice(-20),
    };
  }
}

module.exports = {
  servers, Bridge, OPS, STATE, settings, configured, HELLO_TIMEOUT_MS, CALL_TIMEOUT_MS,
  callDeadline, CALL_GRACE_MS, MAX_CALL_TIMEOUT_MS };
