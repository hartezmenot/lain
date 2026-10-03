'use strict';

/** THE LIVE ROW'S WORDS (S5.1) for ui/status.js: what it is waiting for, how long the step has taken, what arrived. */

/** `9s`, `2m 23s` — how long this step has taken. */
function stepTime(ms) { return require('./thoughtrow').dur(ms); }

/** A command, shortened for the live row. */
function shortCommand(cmd) {
  const c = String(cmd || '').replace(/\s+/g, ' ').trim();
  return c.length > 48 ? `${c.slice(0, 47)}…` : c;
}

/** THE LIVE ROW WHILE A REQUEST IS OPEN (S5.1): `◐ <state> · <what> · <step time> · ↓<tokens> · esc to interrupt`, the state being `Waiting for <model>`… */
function modelRow(phase, now, steerQueued, actor) {
  const live = phase.live;
  const model = live.model ? require('../catalog').displayName(live.model) : 'the model';
  const progress = require('../streamprogress');
  const quiet = now - (live.lastDataAt || live.startedAt);
  const latest = Math.max(live.lastToolAt || 0, live.lastTextAt || 0, live.lastReasoningAt || 0);
  let word = `Waiting for ${model}`;
  let what = '';
  if (live.lastDataAt && live.tool && latest === live.lastToolAt) { word = 'Writing'; what = `${live.tool.name || 'a tool'} call · ${progress.size(live.tool.bytes)}`; }
  else if (live.lastDataAt && latest && latest === live.lastTextAt) word = 'Writing';
  else if (live.lastDataAt && latest && latest === live.lastReasoningAt) word = 'Thinking';
  const chars = (live.textChars || 0) + (live.reasoningChars || 0) + ((live.tool && live.tool.bytes) || 0);
  const parts = [what, stepTime(now - live.startedAt), chars ? `↓~${require('./activityline').tok(Math.ceil(chars / 4))}` : '',
    quiet >= 30000 ? `no data for ${Math.floor(quiet / 1000)}s` : '', steerQueued ? 'steer queued' : '', 'esc to interrupt'].filter(Boolean);
  return { actor, word, detail: parts.join(' · '), colour: quiet >= 30000 ? 'warn' : 'violet', spin: true, cased: true };
}

module.exports = { stepTime, shortCommand, modelRow };
