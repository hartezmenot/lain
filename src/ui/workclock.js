'use strict';

/** ONE CLOCK FOR THE WHOLE TASK — `00:07:31`, and it means elapsed WORK. */

const STATE = Object.freeze({
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED',
});

/** A clock that has never been started. */
function create() {
  return { state: STATE.IDLE, accumulated: 0, since: 0, startedAt: 0 };
}

/** THE USER PRESSED ENTER. */
function start(c, now = Date.now()) {
  if (!c) return c;
  c.state = STATE.RUNNING;
  c.accumulated = 0;
  c.since = now;
  c.startedAt = now;
  return c;
}

/** Work cannot progress. The value is banked and held. */
function pause(c, now = Date.now()) {
  if (!c || c.state !== STATE.RUNNING) return c;
  c.accumulated += Math.max(0, now - c.since);
  c.since = 0;
  c.state = STATE.PAUSED;
  return c;
}

/** Work can progress again. */
function resume(c, now = Date.now()) {
  if (!c || c.state === STATE.IDLE || c.state === STATE.RUNNING) return c;
  c.since = now;
  c.state = STATE.RUNNING;
  return c;
}

/** The task reached a terminal state. */
function settle(c, now = Date.now()) {
  if (!c) return c;
  if (c.state === STATE.RUNNING) c.accumulated += Math.max(0, now - c.since);
  c.since = 0;
  c.state = c.state === STATE.IDLE ? STATE.IDLE : STATE.STOPPED;
  return c;
}

/** Elapsed WORK milliseconds. Pure. */
function elapsed(c, now = Date.now()) {
  if (!c) return 0;
  const live = c.state === STATE.RUNNING ? Math.max(0, now - c.since) : 0;
  return Math.max(0, c.accumulated) + live;
}

/** `HH:MM:SS`, always — never `7:31`, never `1h 14m`. */
function hhmmss(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** WHAT THE STRIP IS HANDED: the value, and whether it is still moving. */
function reading(c, now = Date.now()) {
  const ms = elapsed(c, now);
  return {
    ms,
    text: hhmmss(ms),
    state: (c && c.state) || STATE.IDLE,
    running: Boolean(c && c.state === STATE.RUNNING),
    paused: Boolean(c && c.state === STATE.PAUSED),
    // NOTHING TO SHOW YET is different from zero seconds of work. A clock that
    // was never started must not put `00:00:00` beside an idle prompt.
    shown: Boolean(c && c.state !== STATE.IDLE),
  };
}

/** ADVANCE THE CLOCK FROM THE AUTHORITATIVE STATE WORD. */
function apply(c, state, now = Date.now()) {
  if (!c) return c;
  switch (state) {
    case 'working': return resume(c, now);
    case 'paused': return pause(c, now);
    // success / error / idle: see the header. Terminal state is endTurn's.
    default: return c;
  }
}

module.exports = { STATE, create, start, pause, resume, settle, elapsed, hhmmss, reading, apply };
