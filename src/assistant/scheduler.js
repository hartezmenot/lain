'use strict';

/**
 * THE ASSISTANT SCHEDULER — timers and condition checks inside LAIN's Core
 * process. It is not a model and keeps no model loaded: it sleeps until the
 * next due task (at most a minute, for watches), runs what is due through
 * actions.js, delivers through delivery.js, and writes one activity row per run.
 *
 * ONE SCHEDULER PER LAIN HOME. A lease file (<configDir>/assistant/scheduler.lease:
 * pid + that pid's start time, runtimeregistry identity) makes a second LAIN
 * process a reader, never a second clock — so a task fires once. A lease whose
 * holder is provably gone is taken over.
 *
 * MISSED RUNS (LAIN was not running when a task was due), per the task's policy:
 *   deliver_late   run it now and say it was missed ("Missed at 08:00")
 *   run_once       run it now (once, however many were missed)
 *   skip           record the miss, move on to the next occurrence
 *
 * QUIET HOURS (cfg.assistant.quietHours { enabled, start, end }): a delivery
 * that falls inside them is DEFERRED to their end, never discarded — except an
 * urgent task, or an exact reminder when cfg.assistant.quietExactReminders is
 * 'deliver' (the default).
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');

const MAX_SLEEP_MS = 60 * 1000;
const GRACE_MS = 60 * 1000;

function root(app) { return (app && app._sibling) || app; }
function settings(app) { const c = (root(app) && root(app).cfg) || {}; return c.assistant || {}; }
function leaseFile() { return path.join(store.dir(), 'scheduler.lease'); }

/** TAKE THE LEASE, or report who holds it. */
function acquire() {
  const reg = require('../runtimeregistry');
  fs.mkdirSync(store.dir(), { recursive: true });
  const me = { pid: process.pid, start: null, at: Date.now() };
  // ONE OS QUERY FOR BOTH PROCESSES (Phase 8.1: each Windows answer is a PowerShell start,
  // and this ran two on every CLI launch). A holder whose pid is plainly gone costs none.
  let cur = null;
  try { cur = JSON.parse(fs.readFileSync(leaseFile(), 'utf8')); } catch { cur = null; }
  if (cur && cur.pid === process.pid) return { ok: true, lease: cur };
  let holderGone = false;
  if (cur && cur.pid) { try { process.kill(cur.pid, 0); } catch (e) { holderGone = e.code === 'ESRCH'; } }
  let known = {};
  try { known = reg.startTimes(cur && cur.pid && !holderGone ? [process.pid, cur.pid] : [process.pid]); } catch { known = {}; }
  me.start = known[process.pid] || null;
  if (cur && cur.pid && !holderGone) {
    const alive = reg.same(cur.pid, cur.start, known);
    if (alive !== false) return { ok: false, holder: cur, why: `the scheduler runs in another LAIN process (pid ${cur.pid})` };
  }
  fs.writeFileSync(leaseFile(), JSON.stringify(me));
  return { ok: true, lease: me };
}
function release() { try { const cur = JSON.parse(fs.readFileSync(leaseFile(), 'utf8')); if (cur.pid === process.pid) fs.unlinkSync(leaseFile()); } catch { /* none */ } }

function minutes(hhmm) { const [h, m] = String(hhmm || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; }
/** When quiet hours end, if `now` is inside them; else null. */
function quietUntil(app, now = Date.now()) {
  const q = settings(app).quietHours;
  if (!q || !q.enabled) return null;
  const s = minutes(q.start); const e = minutes(q.end);
  if (s == null || e == null || s === e) return null;
  const d = new Date(now); const cur = d.getHours() * 60 + d.getMinutes();
  const inside = s < e ? cur >= s && cur < e : cur >= s || cur < e;
  if (!inside) return null;
  const end = new Date(now); end.setSeconds(0, 0);
  end.setHours(Math.floor(e / 60), e % 60);
  if (end.getTime() <= now) end.setDate(end.getDate() + 1);
  return end.getTime();
}

/** RUN ONE TASK now: action or watch, delivery, activity, next run. */
async function runTask(app, t, { now = Date.now(), missedAt = null, deliverFn } = {}) {
  const runId = `run_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let result;
  if (t.type === store.TYPE.WATCH) {
    const w = await require('./watches').evaluate(app, t.watch, t.memo || {}, now).catch((e) => ({ fire: false, memo: t.memo || {}, error: e.message }));
    store.update(t.id, (x) => ({ ...x, memo: w.memo, lastChecked: now, nextRun: require('./schedule').next(x, now) }));
    if (!w.fire) return { fired: false };
    result = { ok: true, text: w.text };
  } else {
    store.update(t.id, (x) => ({ ...x, state: store.STATE.RUNNING }));
    // BACKGROUND EXECUTION OFF (BOT › Assistant): nothing runs unattended — the task says it was due instead.
    const unattended = t.action && ['run_tests', 'bot_prompt'].includes(t.action.kind) && settings(app).background === false;
    result = unattended ? { ok: false, text: `${t.title} was due but did not run: background execution is off (BOT › Assistant).` }
      : await require('./actions').run(app, t).catch((e) => ({ ok: false, text: `The task failed: ${e.message}` }));
  }
  const text = missedAt ? `Missed at ${new Date(missedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — delivering now.\n${result.text}` : result.text;
  const d = await (deliverFn || require('./delivery').deliver)(app, t, text);
  const row = store.appendActivity({
    runId, taskId: t.id, at: Date.now(), type: t.type, title: t.title, outcome: result.ok ? 'ok' : 'failed', missedAt: missedAt || null,
    summary: String(result.text || '').slice(0, 2000), model: result.model || null, modelPolicy: t.modelPolicy,
    deliveries: d.deliveries, deliveryState: d.state, origin: t.origin || null,
  });
  store.update(t.id, (x) => {
    const runs = (x.runs || 0) + 1;
    const nxt = x.type === store.TYPE.WATCH ? x.nextRun : require('./schedule').next({ ...x, runs }, now);
    const finished = x.type === store.TYPE.REMINDER || x.type === store.TYPE.SCHEDULED;
    return { ...x, runs, lastRun: row.at, result: { outcome: row.outcome, summary: row.summary.slice(0, 300) }, deliveryState: d.state,
      state: finished ? (result.ok ? store.STATE.DONE : store.STATE.FAILED) : (x.type === store.TYPE.WATCH ? store.STATE.WATCHING : store.STATE.SCHEDULED),
      nextRun: finished ? null : nxt, deferredUntil: null };
  });
  return { fired: true, row };
}

/** ONE PASS: everything due (and not deferred) runs; returns what ran. */
async function tick(app, { now = Date.now(), startup = false, deliverFn } = {}) {
  const ran = [];
  const quiet = quietUntil(app, now);
  const exactThrough = (settings(app).quietExactReminders || 'deliver') === 'deliver';
  for (const t of store.list({ states: [store.STATE.SCHEDULED, store.STATE.WATCHING] })) {
    const due = t.deferredUntil || t.nextRun;
    if (t.type === store.TYPE.WATCH && settings(app).conditionChecks === false) continue;   // condition checks off: watches wait
    if (!due || due > now) continue;
    // QUIET HOURS: deferred to their end, never dropped.
    const urgent = t.urgent === true || (t.type === store.TYPE.REMINDER && exactThrough);
    if (quiet && !urgent && t.type !== store.TYPE.WATCH) {
      store.update(t.id, (x) => ({ ...x, deferredUntil: quiet }));
      store.appendActivity({ runId: null, taskId: t.id, at: now, type: t.type, title: t.title, outcome: 'deferred', summary: `Quiet hours — deferred to ${new Date(quiet).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`, deliveries: [], deliveryState: 'PENDING' });
      continue;
    }
    // MISSED (LAIN was not running): the task's own policy decides.
    const missed = t.type !== store.TYPE.WATCH && !t.deferredUntil && now - t.nextRun > GRACE_MS;
    if (missed && t.missedPolicy === 'skip') {
      const nxt = require('./schedule').next({ ...t, runs: (t.runs || 0) + 1 }, now);
      store.update(t.id, (x) => ({ ...x, nextRun: nxt, state: nxt ? x.state : store.STATE.DONE }));
      store.appendActivity({ runId: null, taskId: t.id, at: now, type: t.type, title: t.title, outcome: 'missed', missedAt: t.nextRun, summary: `Missed at ${new Date(t.nextRun).toLocaleString()} — skipped by policy; next ${nxt ? new Date(nxt).toLocaleString() : 'none'}.`, deliveries: [], deliveryState: 'PENDING' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- tasks run one after another, in order
    const r = await runTask(app, t, { now, missedAt: missed && t.missedPolicy === 'deliver_late' ? t.nextRun : null, deliverFn });
    if (r.fired) ran.push(r.row);
  }
  return ran;
}

/**
 * START the clock for this LAIN process (if it holds the lease). Idempotent.
 *
 * NOT ON THE FIRST PROMPT'S PATH (Phase 8.2): the lease records this process's OS
 * identity, and on Windows that answer is a PowerShell start (~250 ms) that ran
 * synchronously in every CLI launch before the prompt appeared. It is asked
 * without blocking; the clock starts when it is known (the lease logic itself is
 * unchanged, and finds the identity already there).
 */
function start(app) {
  const r = root(app);
  if (r._assistantScheduler) return r._assistantScheduler.status();
  const pending = { starting: true, status: () => ({ running: false, why: 'starting' }), poke() {}, stop() { pending.cancelled = true; } };
  r._assistantScheduler = pending;
  const reg = require('../runtimeregistry');
  const warm = typeof reg.startTimesAsync === 'function' ? reg.startTimesAsync([process.pid]) : Promise.resolve(null);
  warm.catch(() => null).then(() => {
    if (r._assistantScheduler !== pending || pending.cancelled) return;
    r._assistantScheduler = null;
    begin(app);
  });
  return pending.status();
}

function begin(app) {
  const r = root(app);
  if (r._assistantScheduler) return r._assistantScheduler.status();
  const lease = acquire();
  if (!lease.ok) { r._assistantScheduler = { status: () => ({ running: false, why: lease.why, holder: lease.holder }), stop() {} }; return r._assistantScheduler.status(); }
  let timer = null; let stopped = false; let busy = false; let lastTick = null; let lastError = null;
  const loop = async (startup) => {
    if (stopped) return;
    if (!busy) {
      busy = true;
      try { await tick(app, { startup }); lastError = null; } catch (e) { lastError = e.message; }
      busy = false; lastTick = Date.now();
    }
    if (stopped) return;
    const next = store.list({ states: [store.STATE.SCHEDULED, store.STATE.WATCHING] }).map((t) => t.deferredUntil || t.nextRun).filter(Boolean).sort((a, b) => a - b)[0];
    const wait = Math.max(1000, Math.min(MAX_SLEEP_MS, next ? next - Date.now() : MAX_SLEEP_MS));
    timer = setTimeout(() => loop(false), wait);
    if (timer.unref) timer.unref();
  };
  r._assistantScheduler = {
    status: () => ({ running: !stopped, pid: process.pid, lastTick, lastError, inProcess: true }),
    poke: () => { if (timer) clearTimeout(timer); loop(false); },
    stop: () => { stopped = true; if (timer) clearTimeout(timer); release(); },
  };
  loop(true);
  return r._assistantScheduler.status();
}

function stop(app) { const r = root(app); if (r._assistantScheduler) { r._assistantScheduler.stop(); r._assistantScheduler = null; } }
function poke(app) { const r = root(app); if (r._assistantScheduler && r._assistantScheduler.poke) r._assistantScheduler.poke(); }
function status(app) { const r = root(app); return r._assistantScheduler ? r._assistantScheduler.status() : { running: false, why: 'not started' }; }

module.exports = { start, stop, poke, status, tick, runTask, quietUntil, acquire, release, GRACE_MS };
