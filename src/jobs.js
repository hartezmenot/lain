'use strict';

/** WORK THAT OUTLIVES A TOOL CALL — so a long command cannot mute the model. */

const { spawn } = require('child_process');

const STATE = Object.freeze({
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT',
});

/** States in which a job is over and its result will not change. */
const FINAL = new Set([STATE.SUCCEEDED, STATE.FAILED, STATE.CANCELLED, STATE.TIMED_OUT]);

/** How much of a job's output is kept. Enough to diagnose; never unbounded. */
const MAX_OUTPUT = 200_000;
const LOG_MAX = 50 * 1024 * 1024;   // a job's log file stops growing here
/** Jobs kept after they finish, so a result can still be read. */
const MAX_KEPT = 20;
/** Nothing runs forever unattended. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

let seq = 0;

class Job {
  constructor({ command, shell, cwd, timeoutMs, logDir = null }) {
    seq += 1;
    this.id = `j${seq}`;
    // THE WHOLE OUTPUT, streamed to a file under the session folder (S7); memory keeps a bounded copy.
    this.logFile = logDir ? require('path').join(logDir, `${this.id}.log`) : null;
    this.logBytes = 0;
    this.command = String(command);
    this.shell = shell;
    this.cwd = cwd;
    this.state = STATE.QUEUED;
    this.exitCode = null;
    this.output = '';
    this.truncated = false;
    this.startedAt = null;
    this.endedAt = null;
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    this.child = null;
    this._waiters = [];
    this._timer = null;
    /** PER-JOB OUTPUT SUBSCRIBERS. */
    this._subs = [];
  }

  /** Subscribe to this job's output. */
  on(event, fn) {
    if (event !== 'output' || typeof fn !== 'function') return () => {};
    this._subs.push(fn);
    return () => { this._subs = this._subs.filter((s) => s !== fn); };
  }

  get elapsedMs() {
    if (!this.startedAt) return 0;
    return (this.endedAt || Date.now()) - this.startedAt;
  }

  get done() { return FINAL.has(this.state); }

  _append(chunk) {
    if (this.logFile && this.logBytes < LOG_MAX) {
      const s = String(chunk);
      try { require('fs').appendFileSync(this.logFile, s); this.logBytes += Buffer.byteLength(s); } catch { /* memory still has it */ }
    }
    if (this.output.length >= MAX_OUTPUT) { this.truncated = true; return; }
    this.output += String(chunk);
    if (this.output.length > MAX_OUTPUT) {
      this.output = this.output.slice(0, MAX_OUTPUT);
      this.truncated = true;
    }
  }

  /** Settle once, and wake everything waiting. */
  _finish(state, code = null) {
    if (this.done) return;
    this.state = state;
    this.exitCode = code;
    this.endedAt = Date.now();
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w(this.summary());
  }

  start(onEvent) {
    const [cmd, args] = this.shell;
    try {
      this.child = spawn(cmd, [...args, this.command], {
        cwd: this.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this._append(`could not start: ${e.message}\n`);
      this._finish(STATE.FAILED, null);
      return this;
    }
    this.state = STATE.RUNNING;
    this.startedAt = Date.now();
    const take = (d) => {
      this._append(d);
      // The OUTPUT pane is fed as the bytes arrive, so a running suite is
      // watchable rather than a blank pane until it ends.
      if (onEvent) onEvent(this);
      // AND ANYONE WATCHING THIS PARTICULAR JOB.
      for (const s of this._subs) {
        try { s(d, this); } catch { /* an observer's bug is not the job's */ }
      }
    };
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', take);
    this.child.stderr.on('data', take);
    this.child.on('error', (e) => { this._append(`\n${e.message}\n`); this._finish(STATE.FAILED, null); if (onEvent) onEvent(this); });
    this.child.on('close', (code) => {
      if (this.done) return;                       // cancelled or timed out
      this._finish(code === 0 ? STATE.SUCCEEDED : STATE.FAILED, code);
      if (onEvent) onEvent(this);
    });
    this._timer = setTimeout(() => {
      if (this.done) return;
      try { this.child.kill(); } catch { /* already gone */ }
      this._append(`\n[timed out after ${Math.round(this.timeoutMs / 1000)}s]\n`);
      this._finish(STATE.TIMED_OUT, null);
      if (onEvent) onEvent(this);
    }, this.timeoutMs);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  /** Resolve when the job ends — ON THE EVENT, never on a timer. */
  wait(limitMs = null) {
    if (this.done) return Promise.resolve(this.summary());
    return new Promise((resolve) => {
      this._waiters.push(resolve);
      if (!limitMs) return;
      const t = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== resolve);
        resolve(this.summary());               // still RUNNING, honestly
      }, limitMs);
      if (t.unref) t.unref();
    });
  }

  cancel(why = 'cancelled') {
    if (this.done) return this.summary();
    try { if (this.child) this.child.kill(); } catch { /* already gone */ }
    this._append(`\n[${why}]\n`);
    this._finish(STATE.CANCELLED, null);
    return this.summary();
  }

  /** The last `n` lines — what a person actually wants to see. */
  tail(n = 40) {
    let text = this.output;
    if (this.truncated && this.logFile) {   // the true end is in the file
      try { const fs = require('fs'); const size = fs.statSync(this.logFile).size; const fd = fs.openSync(this.logFile, 'r'); const len = Math.min(size, 64 * 1024); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, size - len); fs.closeSync(fd); text = b.toString('utf8'); } catch { text = this.output; }
    }
    const lines = text.split('\n');
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
  }

  summary() {
    return {
      id: this.id,
      state: this.state,
      command: this.command,
      exitCode: this.exitCode,
      elapsedMs: this.elapsedMs,
      bytes: this.output.length,
      truncated: this.truncated,
      done: this.done,
    };
  }
}

/** Every job of this session. */
class Jobs {
  constructor({ onEvent = null } = {}) {
    this.list = [];
    this.onEvent = onEvent;
  }

  start({ command, shell, cwd, timeoutMs, logDir = null }) {
    const job = new Job({ command, shell, cwd, timeoutMs, logDir });
    this.list.push(job);
    // Finished jobs are kept so a result can still be read, but not forever.
    while (this.list.length > MAX_KEPT) {
      const oldest = this.list.findIndex((j) => j.done);
      if (oldest < 0) break;
      this.list.splice(oldest, 1);
    }
    return job.start(this.onEvent);
  }

  get(id) { return this.list.find((j) => j.id === String(id)) || null; }
  running() { return this.list.filter((j) => !j.done); }
  all() { return this.list.slice(); }

  /** Stop everything. Called when the session ends; never leaves an orphan. */
  stopAll(why = 'the session ended') {
    for (const j of this.running()) j.cancel(why);
    return true;
  }
}

module.exports = { Jobs, Job, STATE, FINAL, MAX_OUTPUT, MAX_KEPT, DEFAULT_TIMEOUT_MS };
