'use strict';

/** SHELL. Deliberately unrestricted. */

const { via, KIND } = require('./via');
const execution = require('../execution');
const attemptsMod = require('../attempts');

const MAX_OUTPUT = 100_000; // characters returned to the model

/** HOW LONG A FOREGROUND COMMAND MAY RUN — was two minutes, and two minutes is shorter than a great many ordinary commands. */
const DEFAULT_TIMEOUT_MS = Number(process.env.LAIN_SHELL_TIMEOUT_MS) || 600_000;

/** SHELL IDENTITY LIVES IN execution.js — one definition, shared by the foreground tools here, background jobs, and the environment summary in the… */
const { findBash, isWslShim, shellPrefix } = execution;

/** End a command AND whatever it started. */
function killTree(child) {
  require('../harness/processes').stopTree(child).catch(() => { /* finish reports cleanup failure */ });
}

/** TOOLS WHOSE EXIT 1 MEANS "NOTHING MATCHED", not "something went wrong". */
const SEARCH_LIKE = /^(?:sudo\s+)?(?:git\s+grep|grep|egrep|fgrep|zgrep|rg|ripgrep|ag|ack|ack-grep|findstr)\b/i;

function searchLike(command) {
  const text = String(command || '').trim();
  if (!text) return false;
  // The last segment of the pipeline, ignoring pipes inside quotes.
  const segments = text.split(/\|(?![^'"]*['"][^'"]*$)/);
  const last = segments[segments.length - 1].trim().replace(/^[({\s]+/, '');
  return SEARCH_LIKE.test(last);
}

function run(command, opts) {
  // A PREVIOUS COMMAND'S TREE IS STILL BEING CLEANED UP (processes.deferStop): wait for it, so a leftover never
  // overlaps this command. Usually already done — the model request in between takes far longer.
  const procs = require('../harness/processes');
  const t0 = Date.now();
  return procs.settle().then(() => { require('../perfmark').add('shell:settle', Date.now() - t0); return runNow(command, opts); });
}

function runNow(command, { shell, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal, detach = null, env = null }) {
  return new Promise((resolve) => {
    // ALREADY CANCELLED. `addEventListener('abort')` never fires on a signal that has already fired, so without this an interrupt arriving between the…
    if (signal && signal.aborted) {
      return resolve({ output: '[interrupted by the user]', isError: true, exitCode: null, interrupted: true });
    }
    const [file, prefix] = shellPrefix(shell);
    const args = [...prefix, command];
    // END OF OUTPUT, IN-BAND (processworker.js): each stream ends with this marker once the command closed it.
    const nonce = require('crypto').randomBytes(8).toString('hex');
    const MARK = `\0LAIN-EOF:${nonce}\0`;
    const ended = { out: false, err: false };

    let child;
    try {
      // Referenced IPC owns a detached guardian; it survives caller death long enough to terminate the command tree, while normal calls await it.
      child = require('../harness/processes').spawnOwned(process.platform === 'win32' && shell === 'cmd'
        ? { command, cwd, shell: file, eof: nonce, ...(env ? { env } : {}) }
        : { command: file, args, cwd, eof: nonce, ...(env ? { env } : {}) });
    } catch (e) {
      return resolve({
        output: `could not start ${shell} (${file}): ${e.message}`,
        isError: true, exitCode: null, startFailed: true, stderr: e.message,
      });
    }

    let out = '';
    // stderr is ALSO kept on its own, while the merged stream stays exactly as it was for display.
    let err = '';
    let truncated = false;
    const append = (buf) => {
      if (truncated) return;
      out += buf.toString('utf8');
      if (out.length > MAX_OUTPUT) { out = out.slice(0, MAX_OUTPUT); truncated = true; }
    };
    // A marker may arrive split across chunks: the last few bytes of each stream are held back until the next chunk.
    const held = { out: '', err: '' };
    const take = (which, buf) => {
      let text = held[which] + buf.toString('utf8');
      const at = text.indexOf(MARK);
      if (at >= 0) { ended[which] = true; text = text.slice(0, at) + text.slice(at + MARK.length); held[which] = ''; return text; }
      if (ended[which]) return text;
      const keep = Math.min(text.length, MARK.length - 1);
      held[which] = text.slice(text.length - keep);
      return text.slice(0, text.length - keep);
    };
    const flushHeld = (which) => { const t = held[which]; held[which] = ''; return t; };
    child.stdout.on('data', (buf) => { const t = take('out', buf); if (t) append(Buffer.from(t, 'utf8')); maybeEarly(); });
    child.stderr.on('data', (buf) => {
      const t = take('err', buf);
      if (t) { append(Buffer.from(t, 'utf8')); if (err.length < MAX_OUTPUT) err += t; }
      maybeEarly();
    });

    let timedOut = false;
    let settled = false;
    // DETACHED BY /bg: the tool call already returned; the same child keeps
    // running and its end is reported to the background job instead. See bgdetach.js.
    let detachedDone = null;
    let unregister = () => {};
    let defer = false;
    const finish = async (result) => {
      if (detachedDone) {
        const done = detachedDone;
        detachedDone = null;
        try { await require('../harness/processes').stopTree(child); } catch { /* already gone */ }
        done({ code: result.exitCode, output: out, timedOut: Boolean(result.timedOut) });
        return;
      }
      if (settled) return;
      settled = true;
      unregister();
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const procs = require('../harness/processes');
      for (const late of procs.lateFailures()) { result.output += `\n[an earlier command's process tree did not stop cleanly: ${late}]`; }
      if (defer) { procs.deferStop(child); resolve(result); return; }
      try { await procs.stopTree(child); }
      catch (e) { result.isError = true; result.cleanupError = e.message; result.output += `\n${e.message}`; }
      resolve(result);
    };

    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

    /** CTRL+C MUST LAND NOW. */
    const onAbort = () => {
      killTree(child);
      finish({ output: '[interrupted by the user]', isError: true, exitCode: null, interrupted: true });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (detach && detach.app) {
      unregister = require('../bgdetach').register(detach.app, {
        label: detach.label || command, tool: detach.tool || 'run_bash', pid: child.pid, startedAt: Date.now(), turnId: detach.turnId || null,
        cwd: detach.cwd || cwd, input: detach.input || {},
        detach(job, onDone, by = 'the user (/bg)') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          detachedDone = onDone;
          const cap = setTimeout(() => { timedOut = true; killTree(child); }, require('../bgdetach').DETACHED_CAP_MS);
          if (cap.unref) cap.unref();
          resolve({ output: `DETACHED by ${by} → background job #${job.id} (pid ${child.pid}). The same process keeps running; its result rejoins this task when it finishes. Continue with independent work — do not start it again.`,
            isError: false, exitCode: null, detached: true, jobId: job.id });
        },
      });
    }

    child.on('error', (e) => {
      // Naming the executable turns "bash failed" into something the model can actually route around — it can see that the shell itself is missing and reach…
      finish({
        output: `could not start ${shell} (${file}): ${e.message}`,
        isError: true, exitCode: null, startFailed: true, stderr: e.message,
      });
    });

    // EARLY COMPLETION: every byte is in (both markers) and the exit code is known — the result goes back now and the tree is cleaned up behind it…
    function maybeEarly() {
      // A /bg-DETACHED command is `settled` for the turn but still owes its job the result (detachedDone).
      if ((settled && !detachedDone) || !ended.out || !ended.err) return;
      const r = child.commandResult;
      if (!r || r.error) return;
      defer = true;
      complete(r.code);
    }
    child.on('message', () => setImmediate(maybeEarly));
    child.on('close', (code) => complete(code));
    function complete(code) {
      if (settled && !detachedDone) return;
      { const t = flushHeld('out'); if (t) append(Buffer.from(t, 'utf8')); }
      { const t = flushHeld('err'); if (t) { append(Buffer.from(t, 'utf8')); if (err.length < MAX_OUTPUT) err += t; } }
      const result = child.commandResult;
      if (result && result.error) return finish({ output: `could not start ${shell} (${file}): ${result.error}`, isError: true, exitCode: null, startFailed: true, stderr: result.error });
      if (result) code = result.code;
      const parts = [];
      // WHICH MECHANISM RAN THIS, AND WHERE.
      parts.push(via(KIND.SHELL, execution.contextLine({ shell, cwd })));
      if (out) parts.push(truncated ? out + '\n[output truncated]' : out);
      if (timedOut) parts.push(`[timed out after ${Math.round(timeoutMs / 1000)}s]`);
      // A SEARCH THAT FOUND NOTHING IS AN ANSWER, NOT A FAULT
      const noneSearched = code === 1 && searchLike(command) && /No files were searched/i.test(err);
      const noMatch = code === 1 && searchLike(command) && !noneSearched;
      if (noneSearched) parts.push('[NO FILES SEARCHED — the filter selected nothing; this says nothing about whether the text exists]');
      if (noMatch) parts.push('[no match]');
      else if (!noneSearched && code !== 0 && code !== null) parts.push(`[exit ${code}]`);
      finish({
        output: parts.join('\n') || '[no output]',
        isError: (code !== 0 && !noMatch && !noneSearched) || timedOut,
        noneSearched,
        noMatch,
        exitCode: code,
        timedOut,
        stderr: err,
      });
    }
  });
}

const SHELLS = [
  ['run_bash', 'bash', 'Run a command with bash/sh.'],
  ['run_powershell', 'powershell', 'Run a command with PowerShell.'],
  ['run_cmd', 'cmd', 'Run a command with cmd.exe (Windows).'],
];

/** WHERE DOES THIS RUN — asked once per call, answered explicitly. */
function resolveCwd(ctx, input) {
  const base = ctx.cwd || process.cwd();
  const want = input && input.cwd ? String(input.cwd).trim() : '';
  if (!want) return { cwd: base };
  const path = require('path');
  const abs = path.isAbsolute(want) ? want : path.resolve(base, want);
  try {
    if (!require('fs').statSync(abs).isDirectory()) return { error: `cwd is not a directory: ${want}` };
  } catch { return { error: `no such directory for cwd: ${want} (resolved to ${abs})` }; }
  return { cwd: abs };
}

const tools = {};
for (const [name, shell, desc] of SHELLS) {
  tools[name] = {
    mutates: true, // a shell command can do anything; treat it as mutating
    schema: {
      name,
      description: `${desc} No command restrictions. Returns combined stdout+stderr, the exit code, and — `
        + 'when it fails — what KIND of failure it was and the fact about this shell that explains it. '
        + 'Pass `cwd` to run somewhere else instead of writing a `cd` into the command. '
        + 'Output a later step needs goes under $LAIN_SCRATCH (kept for the whole task), not /tmp.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'the command line to execute' },
          cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
          timeout_ms: {
            type: 'number',
            description: 'optional timeout in milliseconds. The default is generous; if the command is '
              + 'genuinely long-running, prefer run_background over raising this, so the turn is not held',
          },
        },
        required: ['command'],
      },
    },
    async run(input, ctx) {
      const command = String((input && input.command) || '').trim();
      if (!command) return { output: 'no command given', isError: true };
      const where = resolveCwd(ctx, input);
      if (where.error) return { output: where.error, isError: true };

      // ANOTHER SHELL'S SYNTAX, noticed before anything runs (shellsyntax.js): the command runs UNCHANGED
      // in the shell it was written for, and the result says so — never half a pipeline in the wrong one.
      const mm = require('../shellsyntax').mismatch(shell, command);
      const runIn = mm && (mm.run !== 'bash' || findBash()) ? mm.run : shell;
      // OUTPUT A LATER STEP NEEDS belongs to the task, not /tmp: $LAIN_SCRATCH lasts for the whole task (pathmap.js).
      const scratch = require('./pathmap').scratchFor(ctx.session);
      const r = await run(command, {
        shell: runIn,
        cwd: where.cwd,
        timeoutMs: Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
        detach: ctx.app ? { app: ctx.app, label: command, tool: name, turnId: ctx.turnId, cwd: where.cwd, input } : null,
        env: scratch ? { ...process.env, LAIN_SCRATCH: scratch } : null,
      });
      if (runIn !== shell && r && typeof r.output === 'string') {
        r.output = `[ran with ${runIn === 'powershell' ? 'PowerShell' : 'bash'}: ${mm.why} — use ${runIn === 'powershell' ? 'run_powershell' : 'run_bash'} for it next time]\n${r.output}`;
        r.meta = { ...(r.meta || {}), rerouted: { from: shell, to: runIn, why: mm.why } };
      }

      // An interrupt is the user's decision, not a failure of the command, and annotating it would put a CLASSIFICATION on something nobody ran.
      if (r.interrupted || r.detached) return r;

      const { text, verdict } = execution.annotate(
        { ...r, shell: runIn, cwd: where.cwd, command },
        { attempts: attemptsMod.forSession(ctx.session) },
      );
      // THE ONE PLACE A REAL TEST RESULT EXISTS
      try { noteVerified(ctx, command, r.output); } catch { /* never fail a tool over telemetry */ }
      return {
        ...r,
        output: execution.leadWith(r.output, text),
        meta: { ...(r.meta || {}), shell: runIn, cwd: where.cwd, classification: verdict.class },
      };
    },
  };
}

/** A TEST RUN THAT STATED ITS OWN NUMBERS, reported to the runtime. */
function noteVerified(ctx, command, output) {
  const session = ctx && ctx.session;
  if (!session || !session.id) return false;
  const c = require('../testing').counts(output);
  if (!c || !c.seen) return false;
  if (ctx.app) require('../sessionjournal').note(ctx.app, { type: 'verified', label: String(command).slice(0, 60), passed: c.passed, failed: c.failed, detail: c.skipped ? `${c.skipped} skipped` : '' });
  return true;
}

module.exports = { tools, run, findBash, isWslShim, shellPrefix, resolveCwd, noteVerified, searchLike, MAX_OUTPUT };
