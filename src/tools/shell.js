'use strict';

/**
 * SHELL. Deliberately unrestricted.
 *
 * There is no command classifier standing between the model and the machine,
 * and no "is this command safe" heuristic. The model may run git, curl, npm,
 * pytest, Get-Process, a project's own scripts — anything the user's own shell
 * would run. LAIN's job is to execute it faithfully and report exactly what
 * happened.
 *
 * V1 additionally REWROTE the model's shell command into a different tool on
 * Windows (`cat x` -> read_file). That silently broke `cat x | head -20`, whose
 * whole pipeline became a filename. V2 does not touch the command string. If the
 * model wants a shell, it gets a shell.
 *
 * Three explicit tools rather than one `run_shell` with a mode flag, because the
 * model choosing PowerShell should be a different call from the model choosing
 * bash — not a parameter it can get wrong silently.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A RESTRICTION. Which interpreter ran the
 * command, which directory it ran in, and what KIND of failure came back are now
 * stated on the result by execution.js. None of that alters what runs. It ends
 * the loop where a model re-runs one command under three shells to discover a
 * fact the machine had before the first attempt — see execution.js.
 */

const { via, KIND } = require('./via');
const execution = require('../execution');
const attemptsMod = require('../attempts');

const MAX_OUTPUT = 100_000; // characters returned to the model

/**
 * HOW LONG A FOREGROUND COMMAND MAY RUN — was two minutes, and two minutes is
 * shorter than a great many ordinary commands.
 *
 * Reported from real use as work being cut off at 120s. A test suite, an
 * install, a build, a container pull: all of them routinely pass two minutes on
 * a real project, and every one of them was being KILLED and handed back as a
 * failure. The model then has to guess whether the command was wrong, and the
 * usual guess is to try it again.
 *
 * Ten minutes, and overridable per call with `timeout_ms` and per machine with
 * LAIN_SHELL_TIMEOUT_MS. It is still bounded, because a FOREGROUND command
 * holds the turn: something that runs longer than this is not a command to wait
 * on, it is a job — which is what `run_background` is for, and which the
 * timeout message now says. See execution.js CLASS.TIMED_OUT for that sentence
 * and why it had to exist.
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.LAIN_SHELL_TIMEOUT_MS) || 600_000;

/**
 * SHELL IDENTITY LIVES IN execution.js — one definition, shared by the
 * foreground tools here, background jobs, and the environment summary in the
 * system prompt. These are re-exported rather than reimplemented so that every
 * caller resolves the same bash and spawns with the same prefix.
 */
const { findBash, isWslShim, shellPrefix } = execution;

/**
 * End a command AND whatever it started.
 *
 * `child.kill()` ends the shell; the thing the shell launched is a grandchild
 * that inherits the pipes and keeps running. On Windows `taskkill /T` walks the
 * tree; elsewhere the owned command has its own process group. The request
 * starts immediately; finish awaits bounded cleanup and reports any failure.
 */
function killTree(child) {
  require('../harness/processes').stopTree(child).catch(() => { /* finish reports cleanup failure */ });
}

/**
 * TOOLS WHOSE EXIT 1 MEANS "NOTHING MATCHED", not "something went wrong".
 *
 * POSIX defines it for `grep`; ripgrep, ack, ag, git-grep and findstr all copy
 * it. Only the LAST command decides the status of a pipeline, so that is the
 * one inspected — `rg foo | head` exits as `head` does, and `ls | grep foo`
 * exits as the grep does.
 */
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
    // ALREADY CANCELLED. `addEventListener('abort')` never fires on a signal
    // that has already fired, so without this an interrupt arriving between the
    // model's tool call and the spawn started a process nobody was waiting for
    // and then waited for it anyway.
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
      // Referenced IPC owns a detached guardian; it survives caller death long
      // enough to terminate the command tree, while normal calls await it.
      // Node's Windows shell launch supplies cmd.exe's verbatim /s /c quoting.
      // Treating its command text as a normal argv item escapes embedded quotes
      // and makes quoted file paths reach programs with literal quote characters.
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
    // stderr is ALSO kept on its own, while the merged stream stays exactly as
    // it was for display. Classification reads stderr only: a shell reports its
    // parse errors there, and a test suite prints its failures to stdout, so
    // judging the merged stream would classify a failing test as a shell fault.
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

    /**
     * CTRL+C MUST LAND NOW.
     *
     * Two separate problems, both measured by pressing Ctrl+C during
     * `run_bash sleep 30` and watching the screen:
     *
     *   1. `child.kill()` kills the SHELL, not what the shell started. The
     *      grandchild inherits the pipes, so `close` does not fire until it
     *      finishes on its own — the screen sat on "Interrupting…" for the
     *      remaining 24 seconds. `killTree` ends the whole group.
     *   2. Even a clean kill is a race we do not need to win. The user has
     *      already said stop, so the result is settled HERE rather than waiting
     *      for the process to be reaped. A grandchild that somehow survives can
     *      no longer hold the interface hostage.
     */
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
      // Naming the executable turns "bash failed" into something the model can
      // actually route around — it can see that the shell itself is missing and
      // reach for run_powershell or run_cmd instead of retrying the command.
      finish({
        output: `could not start ${shell} (${file}): ${e.message}`,
        isError: true, exitCode: null, startFailed: true, stderr: e.message,
      });
    });

    // EARLY COMPLETION: every byte is in (both markers) and the exit code is known — the result goes back now and
    // the tree is cleaned up behind it (processes.deferStop). Without the markers (a background grandchild still
    // holds a pipe) nothing changes: the result waits for `close`, as it always did.
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
      // WHICH MECHANISM RAN THIS, AND WHERE. The vocabulary for the stamp lives
      // in via.js because three tools say it and two of them used to spell it
      // differently; the shell-and-directory detail comes from execution.js for
      // the same reason.
      parts.push(via(KIND.SHELL, execution.contextLine({ shell, cwd })));
      if (out) parts.push(truncated ? out + '\n[output truncated]' : out);
      if (timedOut) parts.push(`[timed out after ${Math.round(timeoutMs / 1000)}s]`);
      // ---- A SEARCH THAT FOUND NOTHING IS AN ANSWER, NOT A FAULT ----------
      //
      // `grep` exits 1 to mean NO MATCH. Reported as an error it reads to the
      // model as "that command broke", and the reply to a broken command is to
      // try the same question another way — sed, a wider grep, then reading the
      // whole file. Observed in a real session: a `grep` exit 1 sitting in the
      // middle of a reread loop over regions that were already settled.
      //
      // So for tools whose exit 1 is defined as "no match", exit 1 is a clean
      // result that SAYS it found nothing. Exit 2 and above stay errors,
      // because for these tools that really is a fault.
      // ZERO FILES SEARCHED IS NOT "NO MATCH" (2026-09-18). ripgrep says so on
      // stderr when its glob/type filter selected nothing; that result says
      // nothing about whether the text exists anywhere.
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

/**
 * WHERE DOES THIS RUN — asked once per call, answered explicitly.
 *
 * `cwd` is a parameter rather than something the model arranges with `cd`,
 * because `cd` inside a shell command changes the directory of a process that
 * exits one line later. A model that wants a command to run in `tests/` and
 * writes `cd tests && node run.js` has taken on the shell's separator rules, its
 * quoting and its error handling to express one fact the spawn already accepts
 * as an argument. The session's own directory is never mutated by this.
 */
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

      // An interrupt is the user's decision, not a failure of the command, and
      // annotating it would put a CLASSIFICATION on something nobody ran. A
      // detach (/bg) is the same: the command is still running elsewhere.
      if (r.interrupted || r.detached) return r;

      const { text, verdict } = execution.annotate(
        { ...r, shell: runIn, cwd: where.cwd, command },
        { attempts: attemptsMod.forSession(ctx.session) },
      );
      // ---- THE ONE PLACE A REAL TEST RESULT EXISTS ------------------------
      //
      // "Is it done?" asked from a phone deserves an answer with evidence under
      // it, and the only evidence LAIN ever holds is a runner stating its own
      // counts. This is where that text is, so this is where it is reported —
      // to the runtime, which keeps it, so a SECOND window can see a result
      // this process observed.
      //
      // `seen` IS THE WHOLE GUARD. testing.counts sets it only when a real
      // summary line was parsed; a build log with the word "passed" in it, or a
      // command that is not a test run at all, sets nothing and reports nothing.
      // Inventing a `0 passed` for every shell command would be worse than
      // silence, because a screen would then show it.
      try { noteVerified(ctx, command, r.output); } catch { /* never fail a tool over telemetry */ }
      return {
        ...r,
        output: execution.leadWith(r.output, text),
        meta: { ...(r.meta || {}), shell: runIn, cwd: where.cwd, classification: verdict.class },
      };
    },
  };
}

/**
 * A TEST RUN THAT STATED ITS OWN NUMBERS, reported to the runtime.
 *
 * Extracted rather than inlined so it can be tested directly, and so the tool
 * path reads as one line. Reports NOTHING unless the runner actually printed a
 * summary — see `seen` in testing.js — because a fabricated zero on a status
 * screen is worse than a screen that says nothing was checked.
 */
function noteVerified(ctx, command, output) {
  const session = ctx && ctx.session;
  if (!session || !session.id) return false;
  const c = require('../testing').counts(output);
  if (!c || !c.seen) return false;
  if (ctx.app) require('../sessionjournal').note(ctx.app, { type: 'verified', label: String(command).slice(0, 60), passed: c.passed, failed: c.failed, detail: c.skipped ? `${c.skipped} skipped` : '' });
  return true;
}

module.exports = { tools, run, findBash, isWslShim, shellPrefix, resolveCwd, noteVerified, searchLike, MAX_OUTPUT };
