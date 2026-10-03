'use strict';

/** THE CHECKS — the things that can produce evidence, one function each. */

const fs = require('fs');
const path = require('path');
const testing = require('../testing');
const execution = require('../execution');
const { httpProbe, HEALTH, spawnOwned, stopTree } = require('./processes');

/** Which shell `runCommand` actually spawns through. See verdictForRun. */
const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';

const VERDICT = Object.freeze({
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  INCONCLUSIVE: 'INCONCLUSIVE',
});

/** How long a check may take before it is INCONCLUSIVE — not FAILED. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** How much of a check's output is carried in the result. The rest is an artifact. */
const MAX_OUTPUT = 20_000;

function clip(s, n = MAX_OUTPUT) {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more characters kept as an artifact)` : t;
}

/** Run a command line and come back with everything needed to judge it. */
function runCommand(command, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve({ interrupted: true, stdout: '', stderr: '', exitCode: null, ms: 0 });
    let child;
    const began = Date.now();
    try {
      child = spawnOwned({ command: String(command), cwd });
    } catch (e) {
      resolve({ startFailed: true, error: String((e && e.message) || e), stdout: '', stderr: '', exitCode: null, ms: 0 });
      return;
    }
    let out = '';
    let err = '';
    const cap = (s, add) => (s.length > MAX_OUTPUT * 4 ? s : s + add);
    if (child.stdout) child.stdout.on('data', (b) => { out = cap(out, b.toString()); });
    if (child.stderr) child.stderr.on('data', (b) => { err = cap(err, b.toString()); });
    let settled = false;
    const done = async (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort && signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* older node */ } }
      try { await stopTree(child); } catch (e) { extra.cleanupError = e.message; extra.startFailed = true; extra.error = e.message; }
      resolve({ stdout: out, stderr: err, exitCode: null, ms: Date.now() - began, ...extra });
    };
    const timer = setTimeout(() => {
      done({ timedOut: true });
    }, Math.max(1000, timeoutMs));
    const onAbort = signal ? () => done({ interrupted: true }) : null;
    if (onAbort) { try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* older node */ } }
    child.on('error', (e) => done({ startFailed: true, error: String((e && e.message) || e) }));
    child.on('close', (code) => {
      const result = child.commandResult;
      done(result && result.error ? { startFailed: true, error: result.error }
        : { exitCode: result ? result.code : code });
    });
  });
}

/** A COMMAND THAT DID NOT RUN IS NOT A COMMAND THAT FAILED. */
function verdictForRun(r, { expectExit = 0, command = '' } = {}) {
  if (r.interrupted) return { verdict: VERDICT.INCONCLUSIVE, why: 'the check was interrupted before it finished' };
  if (r.timedOut) return { verdict: VERDICT.INCONCLUSIVE, why: 'the check timed out before it finished' };
  if (r.startFailed) return { verdict: VERDICT.INCONCLUSIVE, why: `the command could not start: ${r.error}` };
  if (!Number.isInteger(r.exitCode)) return { verdict: VERDICT.INCONCLUSIVE, why: 'the command produced no exit status' };
  // THE SHELL MUST BE NAMED OR HALF THE CLASSIFICATION IS SKIPPED, and this cost a wrong verdict in its first test run: execution.js consults a per-shell…
  const note = execution.annotate({
    exitCode: r.exitCode, stderr: r.stderr, stdout: r.stdout,
    shell: SHELL, command: String(command || ''), cwd: '',
  }, {});
  const cls = note && note.verdict && note.verdict.class;
  if (cls === execution.CLASS.COMMAND_NOT_FOUND) {
    return { verdict: VERDICT.INCONCLUSIVE, why: 'the command is not installed on this machine' };
  }
  if (cls === execution.CLASS.DEPENDENCY_MISSING) {
    return { verdict: VERDICT.INCONCLUSIVE, why: 'a dependency it needs is not installed' };
  }
  if (Number(r.exitCode) === Number(expectExit)) {
    return { verdict: VERDICT.PASSED, why: `exit ${r.exitCode}` };
  }
  return { verdict: VERDICT.FAILED, why: `exit ${r.exitCode}, expected ${expectExit}` };
}

// ------------------------------------------------------------- the checks --

const RUNNERS = {
  /** Any command. `expect_exit` defaults to 0. */
  async command(spec, ctx) {
    const command = String(spec.command || '').trim();
    if (!command) return { verdict: VERDICT.INCONCLUSIVE, why: 'no command given' };
    const r = await runCommand(command, {
      cwd: spec.cwd || ctx.cwd, timeoutMs: Number(spec.timeout_ms) || undefined, signal: ctx.signal,
    });
    const v = verdictForRun(r, { expectExit: spec.expect_exit == null ? 0 : Number(spec.expect_exit), command });
    return { ...v, output: clip(`${r.stdout || ''}${r.stderr || ''}`), ms: r.ms, command };
  },

  /** A build. Same runner, different word, because a report reads better for it. */
  async build(spec, ctx) {
    return RUNNERS.command({ ...spec, kind: 'command' }, ctx);
  },

  /** A TEST SUITE, classified by testing.js. */
  async tests(spec, ctx) {
    let command = String(spec.command || '').trim();
    if (!command) {
      const report = testing.discover(ctx.cwd);
      const suite = testing.primary(report);
      if (!suite) {
        return { verdict: VERDICT.INCONCLUSIVE, why: 'no test suite was found in this project, so nothing was run' };
      }
      command = suite.command;
    }
    const r = await runCommand(command, {
      cwd: spec.cwd || ctx.cwd, timeoutMs: Number(spec.timeout_ms) || undefined, signal: ctx.signal,
    });
    const note = execution.annotate({
      exitCode: r.exitCode, stderr: r.stderr, stdout: r.stdout, shell: SHELL, command, cwd: ctx.cwd,
    }, {});
    const classified = testing.classifyRun({
      output: `${r.stdout || ''}${r.stderr || ''}`,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      interrupted: r.interrupted,
      classification: note && note.verdict && note.verdict.class,
    });
    // THE MAPPING, and it is the whole reason testing.js is reused rather than re-derived: BLOCKED is INCONCLUSIVE, which is the honest answer that a…
    let verdict = VERDICT.INCONCLUSIVE;
    if (classified.state === testing.STATE.TESTS_PASSED) verdict = VERDICT.PASSED;
    else if (classified.state === testing.STATE.TESTS_FAILED) verdict = VERDICT.FAILED;
    else if (classified.state === 'TESTS_PARTIAL') {
      verdict = classified.counts && classified.counts.failed > 0 ? VERDICT.FAILED : VERDICT.INCONCLUSIVE;
    }
    const c = classified.counts || {};
    return {
      verdict,
      why: `${classified.state}: ${classified.why}`,
      output: clip(`${r.stdout || ''}${r.stderr || ''}`),
      ms: r.ms,
      command,
      counts: { passed: c.passed || 0, failed: c.failed || 0, skipped: c.skipped || 0 },
    };
  },

  /** An HTTP endpoint answers, and optionally answers with something. */
  async http(spec, ctx) {
    const url = String(spec.url || '').trim();
    if (!url) return { verdict: VERDICT.INCONCLUSIVE, why: 'no url given' };
    const r = await httpProbe(url, Number(spec.timeout_ms) || 5000);
    if (r.status == null) return { verdict: VERDICT.INCONCLUSIVE, why: `nothing answered at ${url} — ${r.why}` };
    const want = spec.expect_status == null ? null : Number(spec.expect_status);
    if (want != null) {
      return r.status === want
        ? { verdict: VERDICT.PASSED, why: `HTTP ${r.status} from ${url}` }
        : { verdict: VERDICT.FAILED, why: `HTTP ${r.status} from ${url}, expected ${want}` };
    }
    return r.ok
      ? { verdict: VERDICT.PASSED, why: `HTTP ${r.status} from ${url}` }
      : { verdict: VERDICT.FAILED, why: `HTTP ${r.status} from ${url}` };
  },

  /** A file exists, and optionally contains something. */
  async file(spec, ctx) {
    const p = path.resolve(ctx.cwd || process.cwd(), String(spec.path || ''));
    if (!spec.path) return { verdict: VERDICT.INCONCLUSIVE, why: 'no path given' };
    let text = null;
    let exists = false;
    try { text = fs.readFileSync(p, 'utf8'); exists = true; } catch (e) {
      // A DIRECTORY, OR AN UNREADABLE FILE, IS NOT AN ABSENT ONE.
      if (e && e.code && e.code !== 'ENOENT') {
        return { verdict: VERDICT.INCONCLUSIVE, why: `${spec.path} could not be read: ${e.code}` };
      }
    }
    const mustExist = spec.must_exist !== false;
    if (mustExist && !exists) return { verdict: VERDICT.FAILED, why: `${spec.path} does not exist` };
    if (!mustExist) {
      return exists
        ? { verdict: VERDICT.FAILED, why: `${spec.path} still exists` }
        : { verdict: VERDICT.PASSED, why: `${spec.path} is gone` };
    }
    if (spec.contains) {
      const hit = String(text).includes(String(spec.contains));
      return hit
        ? { verdict: VERDICT.PASSED, why: `${spec.path} contains the expected text` }
        : { verdict: VERDICT.FAILED, why: `${spec.path} does not contain the expected text` };
    }
    return { verdict: VERDICT.PASSED, why: `${spec.path} exists` };
  },

  /** A managed service is up and answering. */
  async process(spec, ctx) {
    const pm = ctx.processes;
    if (!pm) return { verdict: VERDICT.INCONCLUSIVE, why: 'there is no process manager in this context' };
    const p = spec.process_id ? pm.get(spec.process_id) : pm.named(ctx.taskId, String(spec.name || ''));
    if (!p) return { verdict: VERDICT.INCONCLUSIVE, why: `no managed process called "${spec.name || spec.process_id}"` };
    const r = await pm.check(p.processId);
    if (r.health === HEALTH.HEALTHY) return { verdict: VERDICT.PASSED, why: `${p.name}: ${r.why}` };
    if (r.health === HEALTH.UNHEALTHY) return { verdict: VERDICT.FAILED, why: `${p.name}: ${r.why}` };
    return { verdict: VERDICT.INCONCLUSIVE, why: `${p.name}: ${r.why}` };
  },

  /** A BROWSER FLOW. Delegated whole to the browser harness. */
  async browser(spec, ctx) {
    if (!ctx.browser) return { verdict: VERDICT.INCONCLUSIVE, why: 'no browser harness in this context' };
    return ctx.browser.verify(spec, ctx);
  },

  /** AN OBSERVATION, ROUTED. */
  async observation(spec, ctx) {
    if (!ctx.observer) return { verdict: VERDICT.INCONCLUSIVE, why: 'no observation plane in this context' };
    const o = await ctx.observer.observe(spec.goal || spec.about, spec, ctx);
    if (!o.ok) return { verdict: VERDICT.INCONCLUSIVE, why: o.why, source: o.source };
    if (spec.expect == null) return { verdict: VERDICT.PASSED, why: o.summary, source: o.source };
    const hit = String(o.value == null ? o.summary : o.value).includes(String(spec.expect));
    return {
      verdict: hit ? VERDICT.PASSED : VERDICT.FAILED,
      why: hit ? `observed: ${o.summary}` : `expected "${spec.expect}", observed: ${o.summary}`,
      source: o.source,
    };
  },
};

const KINDS = Object.freeze(Object.keys(RUNNERS));

/** RUN ONE CHECK. Never throws — a runner that blows up becomes INCONCLUSIVE with the exception as the reason, because "the check crashed" is genuinely… */
async function run(spec, ctx = {}) {
  const kind = String((spec && spec.kind) || '');
  const label = String((spec && spec.label) || kind || 'check');
  if (ctx.signal && ctx.signal.aborted) return { kind, label, verdict: VERDICT.INCONCLUSIVE, why: 'verification cancelled before this check ran' };
  const runner = RUNNERS[kind];
  if (!runner) {
    return { kind, label, verdict: VERDICT.INCONCLUSIVE, why: `unknown check kind "${kind}" — known: ${KINDS.join(', ')}` };
  }
  const began = Date.now();
  try {
    const r = await runner(spec, ctx);
    return { kind, label, ms: Date.now() - began, ...r };
  } catch (e) {
    return { kind, label, ms: Date.now() - began, verdict: VERDICT.INCONCLUSIVE, why: `the check itself failed: ${(e && e.message) || e}` };
  }
}

module.exports = { run, RUNNERS, KINDS, VERDICT, runCommand, verdictForRun, SHELL, MAX_OUTPUT, DEFAULT_TIMEOUT_MS };
