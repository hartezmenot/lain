'use strict';

/** A RATE LIMIT THAT LASTS HOURS IS NOT A RETRY — it is a decision. */

/** Longer than this and it is worth asking rather than sitting through. */
const ASK_ABOVE_MS = 90_000;

/** How often the countdown redraws. Once a second is all a clock needs. */
const TICK_MS = 1000;

/** Is this failure a wait long enough to be worth a question? */
function worthAsking(failure) {
  if (!failure || failure.kind !== 'RATE_LIMITED') return false;
  return Number(failure.retryAfterMs) > ASK_ABOVE_MS;
}

/** `4h 12m`, `12m 30s`, `45s` — a duration at the scale a person reads it. */
function human(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n <= 0) return 'now';
  // WHOLE SECONDS FIRST, THEN SPLIT INTO FIELDS.
  const total = Math.ceil(n / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  // A weekly reset in DAYS: "96h 0m" makes a person do the division.
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** The absolute clock time the limit clears, for "can I go and do something". */
/** How long a window this is, in the words a person uses: weekly and daily limits say so. */
function windowWord(ms) {
  if (ms >= 3 * 86400000) return 'WEEKLY LIMIT';
  if (ms >= 6 * 3600000) return 'DAILY LIMIT';
  return 'RATE LIMITED';
}

function at(resumeAt) {
  try {
    const d = new Date(resumeAt);
    const hhmm = d.toTimeString().slice(0, 5);
    // A reset days away needs its DAY — "around 08:00" for a weekly limit is a lie by omission.
    return resumeAt - Date.now() > 20 * 3600000 ? `${d.toLocaleDateString('en-US', { weekday: 'long' })} ${hhmm}` : hhmm;
  } catch { return '—'; }
}

/** What LAIN sends itself when the clock runs out. */
const RESUME_PROMPT = 'The rate limit has reset. Nothing changed while it was waiting and nothing '
  + 'was lost. Continue from exactly where you stopped — do not start again, and do not repeat '
  + 'work you have already done. If you were in fact finished, say so and say what you concluded.';

/** The answers, as the panel's values. */
const CHOICE = Object.freeze({ WAIT: 'WAIT', CHANGE: 'CHANGE', FAILOVER: 'FAILOVER' });

/** The question itself, as an adapter for the ONE interaction panel. */
function adapter({ provider, resumeAt, model, alternative = null, exhausted = false, routes = 0 }) {
  const left = Math.max(0, resumeAt - Date.now());
  const { KIND, MODE } = require('./ui/panel');
  const items = [
    // NAMES THE ROUTE, NOT THE MODEL. "opus is rate limited" is the sentence
    // that causes the confusion this whole offer exists to correct.
    { label: `${provider || 'the provider'} is rate limited${model ? ` for ${model}` : ''}.`, selectable: false },
    { label: `It clears in ${human(left)} — around ${at(resumeAt)}.`, selectable: false },
  ];
  if (exhausted && routes > 1) {
    // THE HONEST SENTENCE FOR THE CASE WITH NO WAY OUT.
    items.push({ label: `All ${routes} configured providers for this model are rate limited.`, selectable: false });
  }
  items.push({ label: '', selectable: false });

  // FIRST, WHEN IT EXISTS, because it is the answer that costs nothing.
  if (alternative) {
    items.push({
      label: `Switch provider — same model (${model}) on ${alternative.connectionId}, now`,
      value: CHOICE.FAILOVER,
    });
  }
  items.push({ label: `Wait for the reset — LAIN carries on by itself in ${human(left)}`, value: CHOICE.WAIT });
  items.push({ label: 'Change model — pick another model and retry now', value: CHOICE.CHANGE });
  return {
    title: windowWord(left),
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    items,
    cursor: items.findIndex((i) => i.value),
    footer: '↑↓ choose · Enter confirm · Esc = wait',
  };
}

/** ASK WHAT TO DO ABOUT A LONG LIMIT, THEN DO IT. */
async function handle(app, record, text) {
  const f = record.providerFailure;
  const resumeAt = f.resumeAt || (Date.now() + (f.retryAfterMs || 0));

  // THE EXECUTOR IS BLOCKED.
  try {
    if (app.session && app.session.task) {
      app.session.task.blockExecutor(
        `${f.provider || 'the provider'} rate limited${f.retryAfterMs ? `, clears ${at(resumeAt)}` : ''}`);
    }
  } catch { /* a bookkeeping failure must not swallow the rate limit itself */ }

  // NOBODY TO ASK is not a reason to invent an answer. Off a TTY it reports
  // the limit and stops, exactly as any other provider failure would.
  if (!app.ui.enabled) {
    // NOBODY TO ASK still means saying which of the two facts is true — the report is the only thing a scripted run gets, so "one route is limited" and…
    const alt = require('./failover').pick(app, { model: app.cfg.model, exclude: [f.connectionId] });
    const tail = alt.ok
      ? ` The same model is available on ${alt.route.connectionId} — /steer to ${alt.route.connectionId}.`
      : alt.exhausted ? ` ${alt.why}.` : '';
    app.render.notice('warn',
      `${f.provider} is rate limited — it clears in ${human(resumeAt - Date.now())} (${at(resumeAt)}).${tail}`);
    return record;
  }

  // IS THE MODEL RATE LIMITED, OR IS ONE ROAD TO IT?
  const failover = require('./failover');
  const alt = failover.pick(app, { model: app.cfg.model, exclude: [f.connectionId] });

  const choice = await app.ui.ask(adapter({
    provider: f.provider, resumeAt, model: app.cfg.model,
    alternative: alt.ok ? alt.route : null,
    exhausted: alt.exhausted,
    routes: alt.routes.length,
  }));

  // SAME MODEL, DIFFERENT PROVIDER
  if (choice === CHOICE.FAILOVER && alt.ok) {
    const moved = failover.apply(app, alt.route);
    app.transient('info', `${moved.kind} — ${app.cfg.model} via ${alt.route.connectionId}`);
    return await app.submit(text, { sameTask: true, from: 'provider-failover' });
  }

  // ---- CHANGE MODEL ----------------------------------------------------
  if (choice === CHOICE.CHANGE) {
    const before = `${app.cfg.model}::${app.cfg.connection}`;
    await require('./modelcommand').pickCommand(app, { args: [], rest: '' }, {
      // REQUIRED HERE, not inherited.
      C: require('./render').C, config: require('./config'), refreshCatalog: () => {},
    });
    // ONLY RETRY IF SOMETHING ACTUALLY CHANGED.
    if (`${app.cfg.model}::${app.cfg.connection}` === before) {
      app.transient('info', 'unchanged — still rate limited');
      return record;
    }
    return await app.submit(text, { sameTask: true, from: 'rate-limit-switch' });
  }

  // WAIT (also what Escape means)
  app.abort = new AbortController();
  let ok;
  try {
    ok = await app.ui.waitForReset(resumeAt, {
      provider: f.provider,
      label: `waiting for ${f.provider || 'the provider'} to reset`,
    });
  } finally {
    app.abort = null;
  }
  // Interrupted mid-wait: the user came back and wants control. Not a failure
  // and not a completion — the prompt simply returns to them.
  if (!ok) { app.transient('info', 'stopped waiting — the prompt is yours'); return record; }
  if (app.ui.enabled) app.ui.noteActor('note', 'the rate limit reset — carrying on');

  // THE ONE PLACE LAIN STILL COMPOSES A PROMPT, AND WHY
  return await app.submit(RESUME_PROMPT, { sameTask: true, from: 'rate-limit-resume' });
}

module.exports = { worthAsking, human, at, windowWord, adapter, handle, CHOICE, RESUME_PROMPT, ASK_ABOVE_MS, TICK_MS };
