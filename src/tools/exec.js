'use strict';

/** PYTHON AND PROGRAMS — execution that is not "a shell command in disguise". */

const fs = require('fs');
const path = require('path');

const jobsMod = require('../jobs');

/** Enough output to diagnose; never unbounded. */
const MAX_OUTPUT = 200_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** WHICH PYTHON, and where it came from. */
function findPython(cfg = {}) {
  const tried = [];
  const configured = (cfg.python && cfg.python.exe)
    || (cfg.probe && cfg.probe.python)
    || process.env.LAIN_PYTHON;
  if (configured) {
    tried.push(configured);
    if (exists(configured)) return { ok: true, exe: configured, source: 'config', tried };
  }
  for (const name of ['python3', 'python', 'py']) {
    tried.push(name);
    // A bare name resolves through PATH at spawn time; `where`/`which` here
    // would be a second resolution free to disagree with the first.
    if (onPath(name)) return { ok: true, exe: name, source: 'PATH', tried };
  }
  return {
    ok: false,
    tried,
    why: 'no Python was found. Set "python": { "exe": "<path>" } in the config, or put one on PATH.',
  };
}

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/** Is `name` runnable from PATH? Resolved once, the way spawn will resolve it. */
function onPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  // REMEMBERED (pathlookup.js, Phase 8.3): the window's state read asks for Python on every poll (the Cowork
  // capabilities), and each ask walked every PATH directory × extension.
  if (!dirs.length) return false;
  return require('../pathlookup').find(name, exts) !== null;
}

/** Run a program directly and collect everything about it. */
function execute(file, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal, input = null, env = process.env } = {}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve({ ok: false, interrupted: true, error: 'interrupted before it started' });
      return;
    }
    let child;
    try {
      child = require('../harness/processes').spawnOwned({ command: file, args, cwd, env });
    } catch (e) {
      resolve({ ok: false, error: `could not start ${file}: ${e.message}`, startFailed: true });
      return;
    }
    let out = '';
    let err = '';
    let truncated = false;
    const cap = (s, add) => {
      if (s.length >= MAX_OUTPUT) { truncated = true; return s; }
      const next = s + add;
      if (next.length > MAX_OUTPUT) { truncated = true; return next.slice(0, MAX_OUTPUT); }
      return next;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out = cap(out, d); });
    child.stderr.on('data', (d) => { err = cap(err, d); });

    const started = Date.now();
    let settled = false;
    const done = async (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { await require('../harness/processes').stopTree(child); }
      catch (e) { r.ok = false; r.error = e.message; r.cleanupError = e.message; }
      resolve({ pid: child.commandPid || child.pid, ownerPid: child.pid, elapsedMs: Date.now() - started, stdout: out, stderr: err, truncated, ...r });
    };
    const timer = setTimeout(() => {
      done({ ok: false, timedOut: true, exitCode: null, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    const onAbort = () => done({ ok: false, interrupted: true, exitCode: null, error: 'interrupted by the user' });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => done({ ok: false, exitCode: null, error: e.message }));
    child.on('close', (code) => {
      const result = child.commandResult;
      if (result && result.error) return done({ ok: false, startFailed: true, error: result.error, exitCode: null });
      if (result) code = result.code;
      done({ ok: code === 0, exitCode: code });
    });

    if (input != null) { try { child.stdin.write(String(input)); } catch { /* closed */ } }
    try { child.stdin.end(); } catch { /* closed */ }
  });
}

/** What a run reads like: the facts first, then what it printed. */
/** WHICH MECHANISM ACTUALLY RAN — . */
// The stamp itself lives in via.js: shell.js and jobs.js say the same thing,
// and two of the three used to spell it their own way.
const { via, KIND } = require('./via');
const execution = require('../execution');
const attemptsMod = require('../attempts');
const { resolveCwd } = require('./shell');

function report(what, r, mechanism = '') {
  const head = r.timedOut ? `${what} TIMED OUT after ${Math.round(r.elapsedMs / 1000)}s`
    : r.interrupted ? `${what} was interrupted`
      : r.startFailed || r.exitCode === null ? `${what} could not run`
        : `${what} exited ${r.exitCode} after ${Math.round(r.elapsedMs / 1000)}s`;
  // THE MECHANISM GOES ON THE HEAD LINE, not after it.
  const bits = [mechanism ? `${head} ${mechanism}` : head];
  if (r.pid) bits.push(`pid ${r.pid}`);
  if (r.error) bits.push(`reason: ${r.error}`);
  // KEPT APART. A traceback is not a result.
  if (r.stdout && r.stdout.trim()) bits.push(`\n--- stdout ---\n${r.stdout.trim()}`);
  if (r.stderr && r.stderr.trim()) bits.push(`\n--- stderr ---\n${r.stderr.trim()}`);
  if (!r.stdout && !r.stderr) bits.push('(it printed nothing)');
  if (r.truncated) bits.push('\n[output was truncated]');
  return bits.join(r.stdout || r.stderr ? '\n' : ' · ');
}

const tools = {};

tools.python_run = {
  mutates: true,
  schema: {
    name: 'python_run',
    description:
      'Run Python — a script file, or a short snippet. The interpreter is spawned DIRECTLY, not '
      + 'through a shell, so the exit code, the pid and stderr are the real ones and a path with a '
      + 'space needs no quoting. Use this for OCR, image measurement, computer vision, data work '
      + "and the project's own scripts. stdout and stderr come back separately: a traceback is not "
      + 'a result. For anything slow, use run_background instead so you can keep working.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'path to a .py file to run' },
        code: { type: 'string', description: 'a short snippet, instead of a file' },
        args: { type: 'array', items: { type: 'string' }, description: 'arguments passed to the script' },
        cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
        timeout_ms: { type: 'number', description: 'default 120000' },
      },
    },
  },
  async run(input, ctx) {
    const cfg = (ctx.app && ctx.app.cfg) || {};
    const py = findPython(cfg);
    if (!py.ok) {
      return { output: `PYTHON NOT CONFIGURED — ${py.why}\nLooked for: ${py.tried.join(', ')}`, isError: true };
    }
    const file = String(input.file || '').trim();
    const code = String(input.code || '');
    if (!file && !code) return { output: 'python_run needs a file or code', isError: true };
    const where = resolveCwd(ctx, input);
    if (where.error) return { output: where.error, isError: true };

    const extra = Array.isArray(input.args) ? input.args.map(String) : [];
    // `-I` isolates from the user's site-packages and PYTHONPATH for a snippet, so a one-liner cannot be changed by whatever is installed globally.
    const argv = file ? [file, ...extra] : ['-I', '-c', code, ...extra];
    const r = await execute(py.exe, argv, {
      cwd: where.cwd, timeoutMs: Number(input.timeout_ms) || undefined, signal: ctx.signal,
    });
    const stamp = via(KIND.PYTHON, execution.contextLine({
      executable: py.exe, note: `found on ${py.source}`, cwd: where.cwd,
    }));
    const note = annotationFor(r, { command: `python ${argv.join(' ')}`, cwd: where.cwd, ctx });
    return {
      output: execution.leadWith(report(file || 'snippet', r, stamp), note.text),
      isError: !r.ok,
      exitCode: r.exitCode,
      meta: { python: py.exe, pid: r.pid, exitCode: r.exitCode, cwd: where.cwd, classification: note.verdict.class },
    };
  },
};

/** The classification block for a DIRECT spawn. */
function annotationFor(r, { command, cwd, ctx }) {
  if (r.interrupted) return { text: '', verdict: { class: execution.CLASS.INTERRUPTED } };
  return execution.annotate(
    {
      exitCode: r.exitCode,
      stderr: r.stderr,
      stdout: r.stdout,
      shell: '',
      command,
      cwd,
      timedOut: r.timedOut,
      startFailed: r.startFailed,
    },
    { attempts: attemptsMod.forSession(ctx.session) },
  );
}

tools.process_run = {
  mutates: true,
  schema: {
    name: 'process_run',
    description:
      'Run a program directly — an .exe, a binary, a tool — with its arguments as a LIST. No shell '
      + 'is involved, so nothing is re-parsed and a path with spaces needs no quoting, and the exit '
      + 'code and pid are the program\'s own rather than a shell\'s. Use this when you mean "run '
      + 'this program"; use run_bash when you mean "run this shell command" (pipes, redirection, '
      + '&&). For anything slow, use run_background instead.',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string', description: 'path to the executable, or a name on PATH' },
        args: { type: 'array', items: { type: 'string' }, description: 'arguments, one per element — never one joined string' },
        cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
        timeout_ms: { type: 'number', description: 'default 120000' },
      },
      required: ['program'],
    },
  },
  async run(input, ctx) {
    const program = String(input.program || '').trim();
    if (!program) return { output: 'process_run needs a program', isError: true };
    // A missing program is said plainly, rather than arriving as a shell's
    // "not recognized as an internal or external command".
    if (!exists(program) && !onPath(program)) {
      return {
        output: `no such program: ${program}. It is not a path that exists and not on PATH.`
          + `\n[CLASSIFICATION: ${execution.CLASS.COMMAND_NOT_FOUND}]`,
        isError: true,
        meta: { classification: execution.CLASS.COMMAND_NOT_FOUND },
      };
    }
    const where = resolveCwd(ctx, input);
    if (where.error) return { output: where.error, isError: true };
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const r = await execute(program, args, {
      cwd: where.cwd, timeoutMs: Number(input.timeout_ms) || undefined, signal: ctx.signal,
    });
    const stamp = via(KIND.PROCESS, execution.contextLine({
      note: 'spawned directly, no shell', cwd: where.cwd,
    }));
    const note = annotationFor(r, { command: `${program} ${args.join(' ')}`, cwd: where.cwd, ctx });
    return {
      output: execution.leadWith(report(path.basename(program), r, stamp), note.text),
      isError: !r.ok,
      exitCode: r.exitCode,
      meta: { program, pid: r.pid, exitCode: r.exitCode, cwd: where.cwd, classification: note.verdict.class },
    };
  },
};

module.exports = { tools, findPython, execute, report, onPath, MAX_OUTPUT, DEFAULT_TIMEOUT_MS };
