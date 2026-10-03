'use strict';

/**
 * `lain -p` WAITS FOR ITS OWN BACKGROUND WORK (S12). A one-shot that started a `run_background` job or a background
 * agent used to exit with the work still running and its result undelivered (results rejoin on the NEXT request, and
 * a one-shot has none). Now it waits for the jobs started in THIS run — never older ones — prints each result, and
 * exits. `--no-wait` keeps the old behaviour. Ctrl+C stops everything.
 */

/** Every job both registries hold right now, by registry-qualified id. */
function jobIds(app) {
  const ids = new Set();
  try { for (const j of require('./tools/jobs').jobsOf(app).all()) ids.add(`shell:${j.id}`); } catch { /* none */ }
  try { for (const j of app.jobs.all()) ids.add(`agent:${j.id}`); } catch { /* none */ }
  return ids;
}

/** The jobs started since `before`: [{ key, kind, job }]. */
function startedSince(app, before) {
  const out = [];
  try { for (const j of require('./tools/jobs').jobsOf(app).all()) if (!before.has(`shell:${j.id}`)) out.push({ key: `shell:${j.id}`, kind: 'shell', job: j }); } catch { /* none */ }
  try { for (const j of app.jobs.all()) if (!before.has(`agent:${j.id}`) && !j.primary) out.push({ key: `agent:${j.id}`, kind: 'agent', job: j }); } catch { /* none */ }
  return out;
}

/** One finished job, as lines for the terminal. */
function describe({ kind, job }) {
  if (kind === 'shell') {
    const s = job.summary();
    const head = `job #${s.id} · ${s.state}${s.exitCode != null ? ` · exit ${s.exitCode}` : ''} · ${String(s.command).slice(0, 100)}`;
    const tail = job.tail(20).trimEnd();
    return tail ? `${head}\n${tail.split('\n').map((l) => `  ${l}`).join('\n')}` : head;
  }
  const s = job.summary();
  const head = `${s.kind === 'process' ? 'process' : 'agent'} #${s.id} · ${s.word} · ${String(s.request || '').slice(0, 100)}`;
  const body = String(s.result || s.error || '').trimEnd();
  return body ? `${head}\n${body.split('\n').map((l) => `  ${l}`).join('\n')}` : head;
}

/**
 * Wait for the jobs started since `before`, then print their results. Resolves to the number of jobs waited for.
 * `write` is the terminal. Ctrl+C stops every job this process holds and ends the wait.
 */
async function waitAndReport(app, before, { write, dim = (s) => s } = {}) {
  const seen = new Map();
  let announced = false;
  let stop = null;
  const interrupted = new Promise((resolve) => { stop = resolve; });
  const onSigint = () => {
    try { require('./tools/jobs').jobsOf(app).stopAll('stopped (Ctrl+C)'); } catch { /* none */ }
    try { app.jobs.cancelAll('stopped (Ctrl+C)'); } catch { /* none */ }
    stop(true);
  };
  process.on('SIGINT', onSigint);
  let wasInterrupted = false;
  try {
    for (;;) {
      const now = startedSince(app, before);
      for (const x of now) seen.set(x.key, x);
      const running = now.filter((x) => !x.job.done);
      if (!running.length) break;
      if (!announced) {
        write(dim(`  waiting for ${running.length} background job${running.length === 1 ? '' : 's'} started in this run — Ctrl+C stops ${running.length === 1 ? 'it' : 'them'}`) + '\n');
        announced = true;
      }
      // One settles (or Ctrl+C), then look again: a job may have started another.
      // eslint-disable-next-line no-await-in-loop -- waits on the jobs themselves, no polling
      const r = await Promise.race([interrupted, ...running.map((x) => Promise.resolve(x.job.wait()).then(() => false))]);
      if (r === true) { wasInterrupted = true; break; }
    }
  } finally { process.removeListener('SIGINT', onSigint); }
  for (const x of seen.values()) write(`${describe(x)}\n`);
  return { waited: seen.size, interrupted: wasInterrupted };
}

module.exports = { jobIds, startedSince, waitAndReport, describe };
