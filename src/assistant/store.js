'use strict';

/** ASSISTANT TASKS — the one Core record for everything the BOT does later. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPE = Object.freeze({ REMINDER: 'reminder', SCHEDULED: 'scheduled', RECURRING: 'recurring', WATCH: 'watch' });
const STATE = Object.freeze({ SCHEDULED: 'scheduled', WATCHING: 'watching', RUNNING: 'running', DONE: 'done', FAILED: 'failed', CANCELLED: 'cancelled', PAUSED: 'paused' });
const POLICY = Object.freeze(['NO_MODEL', 'BOT_MODEL', 'LOCAL_CHEAP', 'RESEARCH', 'CODING_AGENT']);
const MISSED = Object.freeze(['deliver_late', 'skip', 'run_once']);
const TARGETS = Object.freeze(['desktop', 'chat', 'telegram']);
const ACTIONS = Object.freeze(['notify', 'limits_summary', 'usage_summary', 'runtime_status', 'run_tests', 'bot_prompt', 'agent_task']);

function dir() { return path.join(require('../config').configDir(), 'assistant'); }
function file() { return path.join(dir(), 'tasks.json'); }
function activityFile() { return path.join(dir(), 'activity.jsonl'); }

function readAll() {
  try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); return j && j.tasks ? j : { version: 1, tasks: {} }; } catch { return { version: 1, tasks: {} }; }
}
function writeAll(d) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, file());
}

function defaults(type) {
  return {
    [TYPE.REMINDER]: { missedPolicy: 'deliver_late', modelPolicy: 'NO_MODEL', action: { kind: 'notify' } },
    [TYPE.SCHEDULED]: { missedPolicy: 'run_once', modelPolicy: 'NO_MODEL' },
    [TYPE.RECURRING]: { missedPolicy: 'skip', modelPolicy: 'NO_MODEL' },
    [TYPE.WATCH]: { missedPolicy: 'skip', modelPolicy: 'NO_MODEL' },
  }[type] || {};
}

/** VALIDATE a new task; returns { ok, task } or { ok:false, why }. */
function normalize(input = {}, now = Date.now()) {
  const t = { ...defaults(input.type), ...input };
  if (!Object.values(TYPE).includes(t.type)) return { ok: false, why: `type is one of ${Object.values(TYPE).join(', ')}` };
  if (!t.title || typeof t.title !== 'string') return { ok: false, why: 'a task needs a title' };
  if (!POLICY.includes(t.modelPolicy)) return { ok: false, why: `modelPolicy is one of ${POLICY.join(', ')}` };
  if (!MISSED.includes(t.missedPolicy)) return { ok: false, why: `missedPolicy is one of ${MISSED.join(', ')}` };
  if (t.type !== TYPE.WATCH && (!t.action || !ACTIONS.includes(t.action.kind))) return { ok: false, why: `action is one of ${ACTIONS.join(', ')}` };
  if (t.type === TYPE.WATCH && (!t.watch || !require('./watches').KINDS.includes(t.watch.kind))) return { ok: false, why: `a watch is one of ${require('./watches').KINDS.join(', ')}` };
  if (t.type === TYPE.WATCH) { const w = require('./watches').validate(t.watch); if (!w.ok) return w; }
  // REMIND ≠ RUN: a reminder only ever notifies; running something is a scheduled task.
  if (t.type === TYPE.REMINDER && t.action.kind !== 'notify') return { ok: false, why: 'a reminder only notifies — to RUN something at a time, schedule it' };
  // A MODEL-BACKED ACTION needs a model policy that names a model.
  if (t.action && ['bot_prompt'].includes(t.action.kind) && t.modelPolicy === 'NO_MODEL') t.modelPolicy = 'BOT_MODEL';
  if (t.action && t.action.kind === 'agent_task') t.modelPolicy = 'CODING_AGENT';
  const targets = (t.delivery && Array.isArray(t.delivery.targets) ? t.delivery.targets : ['desktop']).filter((x) => TARGETS.includes(x));
  if (!targets.length) return { ok: false, why: `deliver to at least one of ${TARGETS.join(', ')}` };
  t.delivery = { targets };
  t.timezone = t.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sched = require('./schedule');
  const sv = sched.validate(t.type, t.schedule);
  if (!sv.ok) return sv;
  t.id = t.id || `at_${crypto.randomBytes(5).toString('hex')}`;
  t.state = t.type === TYPE.WATCH ? STATE.WATCHING : STATE.SCHEDULED;
  t.createdAt = now;
  t.nextRun = sched.next(t, now);
  t.lastRun = null; t.runs = 0; t.result = null; t.deliveryState = null;
  t.requiredCapabilities = require('./actions').capabilitiesFor(t);
  return { ok: true, task: t };
}

function create(input, now = Date.now()) {
  const n = normalize(input, now);
  if (!n.ok) return n;
  const d = readAll();
  d.tasks[n.task.id] = n.task;
  writeAll(d);
  return { ok: true, task: n.task };
}

function get(id) { return readAll().tasks[id] || null; }
function list({ states = null } = {}) {
  return Object.values(readAll().tasks).filter((t) => !states || states.includes(t.state)).sort((a, b) => (a.nextRun || Infinity) - (b.nextRun || Infinity));
}
function update(id, fn) {
  const d = readAll();
  const t = d.tasks[id];
  if (!t) return null;
  d.tasks[id] = fn({ ...t }) || t;
  writeAll(d);
  return d.tasks[id];
}
function cancel(id) { const t = update(id, (x) => ({ ...x, state: STATE.CANCELLED, nextRun: null })); return t ? { ok: true, task: t } : { ok: false, why: 'no such task' }; }
function pause(id) { const t = update(id, (x) => ({ ...x, state: STATE.PAUSED })); return t ? { ok: true, task: t } : { ok: false, why: 'no such task' }; }
function resume(id, now = Date.now()) {
  const t = update(id, (x) => ({ ...x, state: x.type === TYPE.WATCH ? STATE.WATCHING : STATE.SCHEDULED, nextRun: require('./schedule').next(x, now) }));
  return t ? { ok: true, task: t } : { ok: false, why: 'no such task' };
}
function remove(id) { const d = readAll(); if (!d.tasks[id]) return { ok: false, why: 'no such task' }; delete d.tasks[id]; writeAll(d); return { ok: true }; }

/** ONE ACTIVITY ROW per run — the canonical execution + delivery history of a task. */
function appendActivity(row) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.appendFileSync(activityFile(), `${JSON.stringify(row)}\n`);
  return row;
}
function activity({ from = 0, taskId = null, limit = 200 } = {}) {
  let text = '';
  try { text = fs.readFileSync(activityFile(), 'utf8'); } catch { return []; }
  const rows = [];
  for (const ln of text.split('\n')) { if (!ln) continue; try { const r = JSON.parse(ln); if (r.at >= from && (!taskId || r.taskId === taskId)) rows.push(r); } catch { /* skip */ } }
  return rows.slice(-limit).reverse();
}

module.exports = { TYPE, STATE, POLICY, MISSED, TARGETS, ACTIONS, create, normalize, get, list, update, cancel, pause, resume, remove, appendActivity, activity, file, activityFile, dir };
