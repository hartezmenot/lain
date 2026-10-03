'use strict';

/** `/bg` — DETACH THE WORK THAT IS BLOCKING THE FOREGROUND (§28–31, §71). */

const MAX_TAIL = 1500;
const DETACHED_CAP_MS = 2 * 60 * 60 * 1000;

function fgOf(app) {
  if (!app._fgProcs) app._fgProcs = [];
  return app._fgProcs;
}

/** A foreground tool registers the process it is waiting on. */
function register(app, entry) {
  if (!app) return () => {};
  const list = fgOf(app);
  list.push(entry);
  return () => { const i = list.indexOf(entry); if (i >= 0) list.splice(i, 1); };
}

function running(app) { return fgOf(app).slice(); }

function planStep(app) {
  const plan = app.session && app.session.plan;
  const st = plan && plan.steps ? (plan.steps.find((s) => s.status === 'active') || plan.steps.find((s) => s.status !== 'done' && s.status !== 'dropped')) : null;
  return st ? st.text : null;
}

function summarize(command, code, output, timedOut) {
  let counts = null;
  try { counts = require('./testing').counts(output); } catch { counts = null; }
  if (counts && counts.seen) {
    const total = (counts.passed || 0) + (counts.failed || 0);
    return { text: `${counts.passed}/${total}${counts.failed ? ` · ${counts.failed} failed` : ''}`, counts };
  }
  if (timedOut) return { text: 'timed out', counts: null };
  return { text: code === 0 ? 'exit 0' : `exit ${code}`, counts: null };
}

/** Record a finished background result against the session it came from. */
function rejoin(app, session, r) {
  session._bgResults = Array.isArray(session._bgResults) ? session._bgResults : [];
  session._bgResults.push({ ...r, delivered: false });
  if (session._bgResults.length > 20) session._bgResults.shift();
  const runs = session.verification && Array.isArray(session.verification.runs) ? session.verification.runs : null;
  if (runs && r.counts) runs.push({ level: 'background', ok: r.ok, at: new Date().toISOString(), evidence: `${r.label}: ${r.summary}`, failures: [] });
  try { require('./tools/shell').noteVerified({ session }, r.label, r.tail); } catch { /* telemetry only */ }
  try { require('./notify').attention(app, 'BACKGROUND_COMPLETE', `${r.label} · ${r.summary}`, { jobId: r.jobId }); } catch { /* notifications are best effort */ }
  try { app.render.notice(r.ok ? 'info' : 'warn', `BG COMPLETE · ${r.label} · ${r.summary}`); } catch { /* no renderer */ }
  try { if (app.ui && app.ui.enabled) app.ui.refresh(); } catch { /* nothing drawn */ }
}

/** The results not yet seen by the model, as one framed-context section, and marked delivered. */
function takeContext(session) {
  const list = (session && session._bgResults) || [];
  const fresh = list.filter((r) => !r.delivered);
  if (!fresh.length) return '';
  for (const r of fresh) r.delivered = true;
  const lines = ['# Background results (rejoined)'];
  for (const r of fresh) {
    lines.push(`#${r.jobId} ${r.kind === 'branch' ? 'branch' : r.kind === 'agent' ? 'agents' : 'process'} · ${r.label} · ${r.ok ? 'OK' : 'NOT OK'} · ${r.summary}${r.step ? ` · plan step: ${r.step}` : ''}`);
    if (r.tail) lines.push(r.tail.slice(-MAX_TAIL));
  }
  return lines.join('\n');
}

/** Detach the newest foreground process into a background job. */
function detachProcess(app, which = null, { by = 'the user (/bg)' } = {}) {
  const list = fgOf(app);
  const entry = which && list.includes(which) ? which : list[list.length - 1];
  if (!entry) return null;
  const session = app.session;
  const job = app.jobs.create({ request: entry.label, primary: false, session: null, kind: 'process' });
  job.parentSessionId = session.id;
  job.planStep = planStep(app);
  job.pid = entry.pid || null;
  job.state = 'RUNNING';
  job.startedAt = entry.startedAt || Date.now();
  job.detail = `pid ${entry.pid || '?'} · ${entry.tool || 'command'}`;
  const turnId = entry.turnId || null;
  list.splice(list.indexOf(entry), 1);
  entry.detach(job, ({ code, output, timedOut }) => {
    const s = summarize(entry.label, code, output, timedOut);
    const ok = code === 0 && !timedOut;
    job.resultSummary = s.text;
    job._finish(ok ? 'SUCCEEDED' : 'FAILED', { result: { exitCode: code }, error: ok ? null : s.text });
    app.jobs.changed();
    rejoin(app, session, { jobId: job.id, kind: 'process', label: entry.label, ok, summary: s.text, counts: s.counts,
      tail: String(output || '').slice(-MAX_TAIL), step: job.planStep, turnId, pid: entry.pid || null, at: Date.now() });
  }, by);
  app.jobs.changed();
  return job;
}

module.exports = { register, running, detachProcess, takeContext, rejoin, summarize, DETACHED_CAP_MS };
