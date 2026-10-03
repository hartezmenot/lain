'use strict';

/** BACKGROUND WORK IN ONE PLACE (Simplify S7). */

const fs = require('fs');
const path = require('path');
const jobsMod = require('../jobs');
const { shellPrefix } = require('./shell');
const { via, KIND } = require('./via');

function jobsOf(app) {
  if (!app._jobs) {
    app._jobs = new jobsMod.Jobs({
      // Every chunk feeds the OUTPUT pane, so a running suite is watchable.
      onEvent: (job) => {
        if (!app.ui || !app.ui.enabled) return;
        app.ui.noteOutput(`${job.id} · ${job.command}`, job.tail(60), job.exitCode);
      },
    });
  }
  return app._jobs;
}

/** `sessions/<session>/jobs/` — where a job's whole output is written. */
function logDir(session) {
  return path.join(require('../config').sessionsDir(), String((session && session.id) || 'nosession'), 'jobs');
}

/** START A COMMAND AS A JOB — the one place that turns a request into a child (run_background and observe_start). */
function startFor(app, ctx, { command, shell, timeoutMs, cwd } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, why: 'a command is required' };
  const want = String(shell || '').toLowerCase();
  const picked = ['bash', 'powershell', 'cmd'].includes(want) ? want : (process.platform === 'win32' ? 'powershell' : 'bash');
  const where = require('./shell').resolveCwd(ctx || {}, { cwd });
  if (where.error) return { ok: false, why: where.error };
  let logFile = null;
  try { const d = logDir((ctx && ctx.session) || app.session); fs.mkdirSync(d, { recursive: true }); logFile = d; } catch { logFile = null; }
  const job = jobsOf(app).start({ command: cmd, shell: shellPrefix(picked), cwd: where.cwd, timeoutMs: Number(timeoutMs) || undefined, logDir: logFile });
  return { ok: true, job, shell: picked, cwd: where.cwd };
}

/** A process the person detached with /bg, or an agent: those live in the App's job registry (agentjob.js). */
function detachedJob(app, id) {
  const j = app && app.jobs && typeof app.jobs.get === 'function' ? app.jobs.get(String(id).replace(/^#/, '')) : null;
  return j && (j.kind === 'process' || j.kind === 'subagent') ? j : null;
}

/** THE ONE RESULT: a finished job rejoins the session it came from — delivered once, on the next request. */
function rejoinResult(app, session, { id, command, exitCode, state, output, label = null }) {
  if (!app || !session) return;
  try {
    const bg = require('../bgdetach');
    const ok = exitCode === 0 && !/fail|cancel|timeout/i.test(String(state || ''));
    const s = bg.summarize(command, exitCode, output, /timeout/i.test(String(state || '')));
    bg.rejoin(app, session, { jobId: id, kind: 'process', label: label || String(command).slice(0, 80), ok, summary: s.text, counts: s.counts, tail: String(output || '').slice(-2000), at: Date.now() });
  } catch { /* job_status still has it */ }
}

function describeDetached(j) {
  const s = j.summary();
  const head = `job #${s.id} · ${s.state} · ${String(s.request || '').slice(0, 80)} · ${Math.round((s.elapsedMs || 0) / 1000)}s`
    + (j.pid ? ` · pid ${j.pid}` : '');
  return s.result ? `${head}\n${s.result}` : `${head}\nstill running — its result rejoins this task when it finishes.`;
}

async function waitDetached(j, limitMs) {
  const limit = Number(limitMs) || 0;
  if (!j.done) await (limit > 0 ? require('../deadline').race(j.wait(), limit) : j.wait());
  return { output: describeDetached(j), meta: { job: j.id, state: j.state, detached: true } };
}

const tools = {};

tools.run_background = {
  mutates: true,
  schema: {
    name: 'run_background',
    description:
      'Start a long command and KEEP WORKING while it runs — a dev server, a long build, a long suite while you do '
      + 'other work. Returns a job id immediately. When it ends, its result REJOINS this session by itself — never wait '
      + 'for it or poll it. It ends when LAIN exits. If you need the result before anything else, run it in the foreground.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'the command line to run' },
        description: { type: 'string', description: 'a few words for the person on what this does' },
        shell: { type: 'string', description: 'bash | powershell | cmd. Defaults to the best on this host.' },
        cwd: { type: 'string', description: 'directory to run in; defaults to the working directory' },
        timeout_ms: { type: 'number', description: 'give up after this long. Default 30 minutes.' },
      },
      required: ['command'],
    },
  },
  async run(input, ctx) {
    const app = ctx && ctx.app;
    if (!app) return { output: 'background jobs are not available in this context', isError: true };
    const command = String(input.command || '').trim();
    if (!command) return { output: 'run_background needs a command', isError: true };
    const { EVENT, busOf } = require('../events');
    const started = startFor(app, ctx, { command, shell: input.shell, timeoutMs: input.timeout_ms, cwd: input.cwd });
    if (!started.ok) return { output: started.why, isError: true };
    const { job, shell } = started;
    job.label = String(input.description || '').trim() || null;   // the live row says `Waiting for tests · #3`
    busOf(app).emit(EVENT.JOB_STARTED, { id: job.id, command, shell });
    require('../inflight').noteJob(ctx && ctx.session, job, command);   // a force-closed LAIN leaves a record of it
    const session = (ctx && ctx.session) || app.session;
    Promise.resolve(job.wait()).then((s) => {
      require('../inflight').jobEnded(ctx && ctx.session, job, s);
      busOf(app).emit(EVENT.JOB_COMPLETED, { id: job.id, state: s.state, exitCode: s.exitCode, command });
      // ONE RESULT — unless something already collected it (collect(), the person's /jobs wait).
      if (!job._collected) rejoinResult(app, session, { id: job.id, command, exitCode: s.exitCode, state: s.state, output: job.tail(60), label: job.label });
    }).catch(() => {});
    return {
      output: `${via(KIND.JOB)} job ${job.id} started: ${command}\n`
        + 'It is running now — carry on with other work. Its result rejoins this session by itself when it ends; do not wait for it or poll it.'
        + (job.logFile ? ` Output: ${job.logFile}` : ''),
      meta: { job: job.id, state: job.state },
    };
  },
};

/** COLLECT A JOB — not a model tool: the person's `/jobs wait`, tests and LAIN's own code. A collected job does not rejoin. */
const collect = {
  async run(input, ctx) {
    const app = ctx && ctx.app;
    const job = app && app._jobs && app._jobs.get(input.id);
    if (job) {
      job._collected = true;
      const s = await job.wait(Number(input.limit_ms) || null);
      return { output: describe(job, s), meta: { job: job.id, state: s.state } };
    }
    const det = detachedJob(app, input.id);
    if (det) return waitDetached(det, input.limit_ms);
    return { output: `no job "${input.id}". Start one with run_background.`, isError: true };
  },
};

tools.job_status = {
  mutates: false,
  schema: {
    name: 'job_status',
    description:
      'What a background job is doing right now, with its recent output — ONE read, when you have been doing something '
      + 'else and want to check. Never ask repeatedly: its result rejoins this session by itself when it ends. '
      + 'With no id, lists every job of this session.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'a job id, or omit for all of them' } } },
  },
  async run(input, ctx) {
    const app = ctx && ctx.app;
    const jobs = app && app._jobs;
    if (input.id) {
      const local = jobs && jobs.get(String(input.id).replace(/^#/, ''));
      if (local) return { output: describe(local, local.summary()), meta: { job: local.id, state: local.state } };
      const det = detachedJob(app, input.id);
      if (det) return { output: describeDetached(det), meta: { job: det.id, state: det.state, detached: true } };
      return { output: `no job "${input.id}".`, isError: true };
    }
    if (!jobs || !jobs.all().length) return { output: 'no background jobs have been started.' };
    const rows = jobs.all().map((j) => {
      const s = j.summary();
      return `${s.id}  ${s.state.padEnd(10)} ${Math.round(s.elapsedMs / 1000)}s  ${(j.label ? `${j.label} · ` : '')}${s.command.slice(0, 60)}`;
    });
    return { output: rows.join('\n'), meta: { jobs: jobs.all().length } };
  },
};

tools.job_stop = {
  mutates: true,
  schema: {
    name: 'job_stop',
    description: 'Stop a background job that is still running. A stopped job keeps the output it produced.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'the job id' } }, required: ['id'] },
  },
  async run(input, ctx) {
    const app = ctx && ctx.app;
    const job = app && app._jobs && app._jobs.get(String(input.id).replace(/^#/, ''));
    if (!job) return { output: `no job "${input.id}".`, isError: true };
    if (job.done) return { output: `job ${job.id} had already finished (${job.state}).` };
    const s = job.cancel('stopped by the model');
    return { output: `job ${job.id} stopped after ${Math.round(s.elapsedMs / 1000)}s.`, meta: { job: job.id, state: s.state } };
  },
};

/** What a job's result reads like: the tail (failures and totals live there); the whole stream is in its log file. */
function describe(job, s) {
  const secs = Math.round(s.elapsedMs / 1000);
  const head = s.done
    ? `job ${s.id} ${s.state}${s.exitCode === null ? '' : ` (exit ${s.exitCode})`} after ${secs}s`
    : `job ${s.id} is still ${s.state} after ${secs}s`;
  const body = job.tail(40).trim();
  return [
    head,
    via(KIND.JOB),
    `command: ${s.command}`,
    job.logFile ? `full output: ${job.logFile}` : '',
    body ? `\n${body}` : '(no output yet)',
  ].filter(Boolean).join('\n');
}

module.exports = { tools, jobsOf, startFor, describe, collect, rejoinResult, logDir };
