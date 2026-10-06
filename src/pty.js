'use strict';

/** THE PROJECT TERMINAL — a real one, owned by Core. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const SOURCE = path.join(__dirname, '..', 'native', 'pty.cs');

/** How much output one terminal keeps for a panel that was not looking. */
const SCROLLBACK = 256 * 1024;
/** How many terminals one session may hold open at once. */
const MAX_TERMINALS = 4;

/** WHERE THE BRIDGE IS BUILT: beside the app (an installed version's own folder, or a checkout's native/build) — never in the person's data folder. */
function homeDir() {
  return path.join(__dirname, '..', 'native', 'build', 'pty');
}

function compiler() {
  const root = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64');
  let best = null;
  try {
    for (const name of fs.readdirSync(root)) {
      if (!/^v4\./.test(name)) continue;
      const exe = path.join(root, name, 'csc.exe');
      if (fs.existsSync(exe)) best = exe;
    }
  } catch { /* reported by the caller */ }
  return best;
}

/** BUILD (or reuse) THE CONPTY BRIDGE. */
function ensureBridge() {
  if (process.platform !== 'win32') return { ok: false, why: 'the project terminal is a Windows pseudoconsole' };
  let src;
  try { src = fs.readFileSync(SOURCE); } catch (e) { return { ok: false, why: `the terminal bridge source is missing: ${e.message}` }; }
  const stamp = crypto.createHash('sha256').update(src).digest('hex').slice(0, 12);
  const dir = homeDir();
  const exe = path.join(dir, `lain-pty-${stamp}.exe`);
  if (fs.existsSync(exe)) return { ok: true, exe, built: false };
  const csc = compiler();
  if (!csc) return { ok: false, why: 'no C# compiler was found (Microsoft.NET\\Framework64\\v4.*\\csc.exe), so the terminal cannot be built' };
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the build will say */ }
  try {
    execFileSync(csc, [
      '-nologo', '-optimize+', '-target:exe', `-out:${exe}`,
      '-r:System.dll', '-r:System.Web.Extensions.dll',
      SOURCE,
    ], { stdio: 'pipe', timeout: 120_000, windowsHide: true });
  } catch (e) {
    const said = String((e && (e.stdout || e.stderr)) || (e && e.message) || '').trim().split('\n').slice(0, 6).join('\n');
    return { ok: false, why: `the terminal bridge did not build: ${said || 'the compiler failed'}` };
  }
  if (!fs.existsSync(exe)) return { ok: false, why: 'the compiler reported success and produced no program' };
  return { ok: true, exe, built: true };
}

/** WHICH SHELL. PowerShell where it exists, because it is what a person on this machine actually has open; `cmd.exe` is the floor that is always present. */
function defaultShell() {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const pwsh = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(pwsh)) return `"${pwsh}" -NoLogo`;
  return path.join(sysRoot, 'System32', 'cmd.exe');
}

/** One live pseudoconsole. */
class Terminal {
  constructor({ id, cwd, shell, cols, rows, child }) {
    this.id = id;
    this.cwd = cwd;
    this.shell = shell;
    this.cols = cols;
    this.rows = rows;
    this.child = child;
    this.pid = 0;
    this.exitCode = null;
    this.startedAt = Date.now();
    /** What the shell has written. Bounded — a terminal is not a log. */
    this.buffer = Buffer.alloc(0);
    /** Bytes dropped off the front, so a reader knows it is not the beginning. */
    this.dropped = 0;
    this._line = '';
  }

  get alive() { return this.exitCode === null && this.child && this.child.exitCode === null; }

  _append(buf) {
    this.buffer = Buffer.concat([this.buffer, buf]);
    if (this.buffer.length > SCROLLBACK) {
      const cut = this.buffer.length - SCROLLBACK;
      this.buffer = this.buffer.slice(cut);
      this.dropped += cut;
    }
  }

  send(obj) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) return false;
    try { this.child.stdin.write(`${JSON.stringify(obj)}\n`); return true; } catch { return false; }
  }

  /** Keystrokes, verbatim. Base64 so control bytes survive the journey. */
  write(data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return this.send({ op: 'input', data: bytes.toString('base64') });
  }

  resize(cols, rows) {
    const c = Math.max(20, Math.min(500, Number(cols) || this.cols));
    const r = Math.max(5, Math.min(200, Number(rows) || this.rows));
    this.cols = c; this.rows = r;
    return this.send({ op: 'resize', cols: c, rows: r });
  }

  /** Ctrl+C — a console event, so the shell interrupts its child rather than exiting. */
  interrupt() { return this.send({ op: 'signal', name: 'int' }); }

  /** What a panel that has not been looking needs to draw itself. */
  read({ since = 0 } = {}) {
    const from = Math.max(0, Number(since) - this.dropped);
    const slice = this.buffer.slice(Math.min(from, this.buffer.length));
    return {
      id: this.id,
      data: slice.toString('base64'),
      at: this.dropped + this.buffer.length,
      dropped: this.dropped,
      alive: this.alive,
      exitCode: this.exitCode,
      cols: this.cols,
      rows: this.rows,
      pid: this.pid,
      cwd: this.cwd,
    };
  }

  close() {
    if (!this.child) return;
    this.send({ op: 'kill' });
    const child = this.child;
    setTimeout(() => { try { if (child.exitCode === null) child.kill(); } catch { /* gone */ } }, 1500).unref?.();
  }
}

/** THE TERMINALS ONE APP HAS OPEN. */
function stateOf(app) {
  if (!app._terminals) app._terminals = new Map();
  return app._terminals;
}

function list(app) {
  return [...stateOf(app).values()].map((t) => ({
    id: t.id, pid: t.pid, cwd: t.cwd, shell: t.shell,
    alive: t.alive, exitCode: t.exitCode, cols: t.cols, rows: t.rows,
    startedAt: t.startedAt, bytes: t.dropped + t.buffer.length,
  }));
}

function get(app, id) { return stateOf(app).get(String(id || '')) || null; }

/** OPEN ONE. */
function open(app, { cwd = null, cols = 120, rows = 30, shell = null } = {}) {
  const map = stateOf(app);
  const living = [...map.values()].filter((t) => t.alive).length;
  if (living >= MAX_TERMINALS) return { ok: false, why: `this session already has ${living} terminals open` };

  const built = ensureBridge();
  if (!built.ok) return built;

  const dir = cwd || (app.session && app.session.cwd) || app.cwd;
  if (!dir || !fs.existsSync(dir)) return { ok: false, why: `the project directory does not exist: ${dir}` };
  const cmd = shell || defaultShell();

  const id = `t${crypto.randomBytes(4).toString('hex')}`;
  const child = spawn(built.exe, [
    '--shell', cmd, '--cwd', dir,
    '--cols', String(cols), '--rows', String(rows),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  require('./runtimeregistry').register(child, {
    purpose: 'terminal', label: `terminal ${id} · ${path.basename(dir)}`,
    session: app.session ? app.session.id : null, project: dir, command: cmd,
    policy: { onOwnerExit: 'stop', onProjectClose: false },
  });

  const t = new Terminal({ id, cwd: dir, shell: cmd, cols, rows, child });
  map.set(id, t);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    t._line += chunk;
    let nl;
    // eslint-disable-next-line no-cond-assign
    while ((nl = t._line.indexOf('\n')) >= 0) {
      const line = t._line.slice(0, nl).trim();
      t._line = t._line.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ev === 'data') { try { t._append(Buffer.from(String(msg.data || ''), 'base64')); } catch { /* skip */ } }
      else if (msg.ev === 'ready') t.pid = Number(msg.pid) || 0;
      else if (msg.ev === 'exit') t.exitCode = Number(msg.code) || 0;
      else if (msg.ev === 'error') { t.error = String(msg.why || ''); t._append(Buffer.from(`\r\n[LAIN] ${t.error}\r\n`, 'utf8')); }
    }
  });
  // THE BRIDGE'S OWN STDERR IS THE BRIDGE FAILING, not the shell's output.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { t._append(Buffer.from(`\r\n[LAIN terminal] ${String(chunk).trim()}\r\n`, 'utf8')); });
  child.on('exit', (code) => { if (t.exitCode === null) t.exitCode = Number(code) || 0; });
  child.on('error', (e) => { t.error = e.message; if (t.exitCode === null) t.exitCode = -1; });

  return { ok: true, terminal: t };
}

/** Close one. The conversation and the session are untouched. */
function close(app, id) {
  const t = get(app, id);
  if (!t) return { ok: false, why: 'no such terminal' };
  t.close();
  return { ok: true, id: t.id };
}

/** EVERY TERMINAL THIS APP HOLDS, ended. */
function closeAll(app) {
  const map = stateOf(app);
  let n = 0;
  for (const t of map.values()) { if (t.alive) { t.close(); n += 1; } }
  map.clear();
  return { ok: true, closed: n };
}

module.exports = {
  ensureBridge, open, close, closeAll, get, list, defaultShell, homeDir,
  Terminal, SCROLLBACK, MAX_TERMINALS, SOURCE,
};
