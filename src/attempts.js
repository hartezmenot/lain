'use strict';

/** THE ATTEMPT LEDGER — what this command has already done, here, today. */

/** Enough to cover a long turn; old entries fall off the front. */
const MAX_COMMANDS = 60;
const MAX_ATTEMPTS_PER_COMMAND = 8;

/** The key a command is remembered by. */
function keyOf(command) {
  return String(command == null ? '' : command).trim().replace(/\s+/g, ' ');
}

/** How long ago, in words a person and a model both read the same way. */
function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

class AttemptLog {
  constructor({ now = () => Date.now() } = {}) {
    /** @type {Map<string, Array<object>>} command → attempts, oldest first */
    this.byCommand = new Map();
    this._now = now;
  }

  /** Put one finished execution on the record. */
  record({ command, shell = '', cwd = '', classification = '', exitCode = null } = {}) {
    const key = keyOf(command);
    if (!key) return;
    let list = this.byCommand.get(key);
    if (!list) {
      list = [];
      this.byCommand.set(key, list);
      // Oldest command out first. A Map preserves insertion order, so the first
      // key is the least recently STARTED — good enough, and it cannot grow.
      if (this.byCommand.size > MAX_COMMANDS) {
        this.byCommand.delete(this.byCommand.keys().next().value);
      }
    }
    list.push({ shell, cwd, classification, exitCode, at: this._now() });
    if (list.length > MAX_ATTEMPTS_PER_COMMAND) list.shift();
  }

  /** Everything already known about this command, oldest first. */
  priorFor(command) {
    return this.byCommand.get(keyOf(command)) || [];
  }

  /** WHAT THE RECORD SAYS about a command that has just failed again. */
  note({ command, shell = '', cwd = '', current = null } = {}) {
    const prior = this.priorFor(command);
    if (!prior.length) return '';
    const past = prior.filter((a) => a.classification && a.classification !== 'OK');
    if (!past.length) {
      const ok = prior[prior.length - 1];
      return `[ALREADY RUN: this exact command SUCCEEDED ${ago(this._now() - ok.at)}`
        + `${ok.shell ? ` under ${ok.shell}` : ''}${ok.cwd && ok.cwd !== cwd ? ` in ${ok.cwd}` : ''}.]`;
    }

    const lines = [`ATTEMPT ${prior.length + 1} of this command. Previously:`];
    for (let i = 0; i < past.length; i++) {
      const a = past[i];
      const where = [a.shell ? `shell=${a.shell}` : null, a.cwd && a.cwd !== cwd ? `cwd=${a.cwd}` : null]
        .filter(Boolean).join(' ');
      lines.push(` ${i + 1}. ${a.classification}${a.exitCode != null ? ` (exit ${a.exitCode})` : ''}`
        + `${where ? ` — ${where}` : ''}, ${ago(this._now() - a.at)}`);
    }

    // THE CONCLUSION THE HISTORY SUPPORTS
    const all = current && current.classification && current.classification !== 'OK'
      ? [...past, { ...current, shell: current.shell || shell, cwd: current.cwd || cwd }]
      : past;
    const classes = new Set(all.map((a) => a.classification));
    const shells = new Set(all.map((a) => a.shell).filter(Boolean));
    if (classes.size === 1 && shells.size > 1) {
      lines.push(`All ${all.length} failed the same way (${[...classes][0]}) under ${shells.size} different shells, `
        + 'so the shell is not the difference.');
    } else if (classes.size === 1 && all.length > 1) {
      lines.push(`All ${all.length} failed the same way (${[...classes][0]}); nothing about the failure changed.`);
    }
    const dirs = new Set(all.map((a) => a.cwd).filter(Boolean));
    if (dirs.size > 1) lines.push(`It has been run from ${dirs.size} different directories.`);
    return `[${lines.join('\n ')}]`;
  }

  /** Everything on the record, newest command last. For reports and tests. */
  history() {
    const out = [];
    for (const [command, attempts] of this.byCommand) out.push({ command, attempts: [...attempts] });
    return out;
  }

  /** The commands that failed more than once and never succeeded — the shape of a loop, in one list. */
  loops() {
    const out = [];
    for (const [command, attempts] of this.byCommand) {
      const failed = attempts.filter((a) => a.classification && a.classification !== 'OK');
      if (failed.length < 2) continue;
      if (attempts.some((a) => a.classification === 'OK')) continue;
      out.push({
        command,
        attempts: failed.length,
        classifications: [...new Set(failed.map((a) => a.classification))],
        shells: [...new Set(failed.map((a) => a.shell).filter(Boolean))],
      });
    }
    return out;
  }
}

/** The ledger for a session, created on first use. */
function forSession(session) {
  if (!session) return null;
  if (!session.attempts) session.attempts = new AttemptLog();
  return session.attempts;
}

module.exports = { AttemptLog, forSession, keyOf, MAX_COMMANDS, MAX_ATTEMPTS_PER_COMMAND };
