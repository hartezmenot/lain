'use strict';

/** WHEN A TASK RUNS NEXT — plain arithmetic on the task's schedule, in its own time zone. */

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function validate(type, s) {
  if (!s || typeof s !== 'object') return { ok: false, why: 'a task needs a schedule' };
  if (type === 'watch') { if (s.poll != null && !(Number(s.poll) >= 30)) return { ok: false, why: 'a watch checks at most every 30 seconds' }; return { ok: true }; }
  if (s.at != null && typeof s.at === 'number') return Number.isFinite(s.at) ? { ok: true } : { ok: false, why: 'at is a time' };
  if (type !== 'recurring' && !s.every) return { ok: false, why: 'a one-time task needs a time (at)' };
  if (!['day', 'weekday', 'week', 'month', 'hours'].includes(s.every)) return { ok: false, why: 'every is day, weekday, week, month or hours' };
  if (s.every === 'hours') return Number(s.interval) >= 1 ? { ok: true } : { ok: false, why: 'every N hours needs N ≥ 1' };
  if (!HHMM.test(String(s.at || ''))) return { ok: false, why: 'a recurring time is HH:MM' };
  if (s.every === 'week' && !(Number(s.weekday) >= 0 && Number(s.weekday) <= 6)) return { ok: false, why: 'a weekly task needs a weekday (0–6)' };
  if (s.every === 'month' && !(Number(s.monthday) >= 1 && Number(s.monthday) <= 31)) return { ok: false, why: 'a monthly task needs a day of the month' };
  return { ok: true };
}

/** Wall-clock parts of `ms` in time zone `tz`. */
function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
/** The epoch ms of wall-clock y-mo-d h:mi in `tz` (DST-safe to the minute). */
function wall(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = partsIn(guess, tz);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    const want = Date.UTC(y, mo - 1, d, h, mi);
    if (shown === want) break;
    guess += want - shown;
  }
  return guess;
}
function daysIn(y, mo) { return new Date(Date.UTC(y, mo, 0)).getUTCDate(); }

/** The next run strictly after `after` (or the one-time time, even if past — the scheduler handles missed runs). */
function next(task, after = Date.now()) {
  const s = task.schedule || {};
  const tz = task.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (task.type === 'watch') return after + Math.max(30, Number(s.poll) || 60) * 1000;
  if (typeof s.at === 'number') return task.runs ? null : s.at;
  if (s.every === 'hours') return after + Number(s.interval) * 3600e3;
  const [H, M] = String(s.at).split(':').map(Number);
  const p = partsIn(after, tz);
  for (let add = 0; add < 400; add++) {
    const base = new Date(Date.UTC(p.y, p.mo - 1, p.d + add));
    const y = base.getUTCFullYear(); const mo = base.getUTCMonth() + 1; const d = base.getUTCDate(); const wd = base.getUTCDay();
    if (s.every === 'weekday' && (wd === 0 || wd === 6)) continue;
    if (s.every === 'week' && wd !== Number(s.weekday)) continue;
    if (s.every === 'month' && d !== Math.min(Number(s.monthday), daysIn(y, mo))) continue;
    const t = wall(y, mo, d, H, M, tz);
    if (t > after) return t;
  }
  return null;
}

/** "tomorrow 08:00", "daily at 08:00", "every Friday at 17:00" — for a person. */
function describe(task) {
  const s = task.schedule || {};
  const wd = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (task.type === 'watch') return `checked every ${Math.max(30, Number(s.poll) || 60)} s`;
  if (typeof s.at === 'number') return new Date(s.at).toLocaleString();
  if (s.every === 'hours') return `every ${s.interval} h`;
  if (s.every === 'day') return `daily at ${s.at}`;
  if (s.every === 'weekday') return `weekdays at ${s.at}`;
  if (s.every === 'week') return `every ${wd[Number(s.weekday)]} at ${s.at}`;
  if (s.every === 'month') return `monthly on day ${s.monthday} at ${s.at}`;
  return '';
}

module.exports = { validate, next, describe, partsIn, wall };
