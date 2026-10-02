'use strict';

/**
 * THE ASSISTANT'S DETERMINISTIC DOOR — sentences Core can answer or act on
 * without a model: creating reminders, schedules and watches, listing them,
 * and questions whose answers are already in Core state (limits, runtimes,
 * the loaded local model, usage). Same answers from the desktop, CHAT and
 * Telegram, because they all reach Core through app.submit.
 *
 * NOT A VERB ROUTER. Anything that is not one of these shapes returns null and
 * goes to the BOT's model as before. Anything ambiguous also returns null —
 * a wrong reminder is worse than a model turn.
 *
 * REMIND ≠ RUN. "remind me to run the tests" is a reminder (notification only);
 * "run the tests tomorrow at 9" schedules execution. The shapes below keep them
 * apart, and a reminder can never execute anything (store.normalize enforces it).
 *
 * PERMISSIONS FROM A CHANNEL. A message from Telegram (`from: 'messaging'`) may
 * only do what that channel's scopes allow (cfg.bot.platforms.telegram.scopes:
 * reminders, readUsage, readProject, runTests, editCode, computer). Defaults:
 * reminders ✓ · read usage ✓ · read project ✓ · run tests ✗ · edit code ✗ · computer ✗.
 */

const store = require('./store');

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
const WD = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DEFAULT_SCOPES = Object.freeze({ reminders: true, readUsage: true, readProject: true, runTests: false, editCode: false, computer: false });

function root(app) { return (app && app._sibling) || app; }
function num(s) { const n = Number(s); return Number.isFinite(n) ? n : NUM[String(s).toLowerCase()] || null; }

/** "8", "8:30", "8 pm", "20:15", "7pm" → { h, m } */
function clock(s) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(String(s || '').trim());
  if (!m) return null;
  let h = Number(m[1]); const mi = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return { h, m: mi };
}
function hhmm(c) { return `${String(c.h).padStart(2, '0')}:${String(c.m).padStart(2, '0')}`; }

/** An absolute time from "in 2 minutes", "at 7 pm", "tomorrow at 8", "tomorrow morning". */
function when(text, now = Date.now()) {
  const t = text.toLowerCase();
  let m = /\bin\s+(\d+|an?|one|two|three|five|ten|fifteen|twenty|thirty)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/.exec(t);
  if (m) { const n = num(m[1]); const u = m[2][0]; return now + n * (u === 's' ? 1e3 : u === 'm' ? 6e4 : u === 'h' ? 36e5 : 864e5); }
  const tomorrow = /\btomorrow\b/.test(t);
  m = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/.exec(t);
  let c = m ? clock(m[1]) : null;
  if (!c && tomorrow && /\bmorning\b/.test(t)) c = { h: 8, m: 0 };
  if (!c && tomorrow && /\bevening\b/.test(t)) c = { h: 19, m: 0 };
  if (!c && /\btonight\b/.test(t)) c = { h: 20, m: 0 };
  if (!c && tomorrow) c = { h: 9, m: 0 };   // "tomorrow" alone: 09:00 — the confirmation says so
  if (!c) return null;
  const d = new Date(now); d.setSeconds(0, 0); d.setHours(c.h, c.m);
  if (tomorrow) d.setDate(d.getDate() + 1);
  else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** "every day at 8", "every morning", "every friday", "every night", "weekdays at 9" → a recurring schedule. */
function cadence(text) {
  const t = text.toLowerCase();
  const at = (() => { const m = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/.exec(t); return m ? clock(m[1]) : null; })();
  if (/\bevery\s+(morning|day)\b|\bdaily\b/.test(t)) return { every: 'day', at: hhmm(at || (/\bmorning\b/.test(t) ? { h: 8, m: 0 } : { h: 9, m: 0 })) };
  if (/\bevery\s+(night|evening)\b|\bnightly\b/.test(t)) return { every: 'day', at: hhmm(at || { h: 21, m: 0 }) };
  if (/\b(every\s+)?weekdays?\b/.test(t)) return { every: 'weekday', at: hhmm(at || { h: 9, m: 0 }) };
  const w = /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t);
  if (w) return { every: 'week', weekday: WD[w[1]], at: hhmm(at || { h: 9, m: 0 }) };
  if (/\bevery\s+week\b|\bweekly\b/.test(t)) return { every: 'week', weekday: 1, at: hhmm(at || { h: 9, m: 0 }) };
  if (/\bevery\s+month\b|\bmonthly\b/.test(t)) return { every: 'month', monthday: 1, at: hhmm(at || { h: 9, m: 0 }) };
  const h = /\bevery\s+(\d+)\s+hours?\b/.exec(t);
  if (h) return { every: 'hours', interval: Number(h[1]) };
  return null;
}

/**
 * Where a result should go: the channels named in the sentence, plus the
 * channel it was asked from (Telegram) — or, from the desktop, the person's
 * default delivery (BOT › Assistant: e.g. Desktop + Telegram).
 */
function targetsFor(text, from, app = null) {
  const t = text.toLowerCase();
  const out = new Set();
  if (from === 'messaging' || /\b(to|on|via)\s+telegram\b|\btelegram me\b/.test(t)) out.add('telegram');
  if (/\b(on|to)\s+(my\s+)?(desktop|computer|pc)\b/.test(t)) out.add('desktop');
  if (/\b(in|to)\s+(lain\s+)?chat\b/.test(t)) out.add('chat');
  if (from !== 'messaging') {
    const c = (app && root(app) && root(app).cfg) || {};
    const defaults = (c.assistant && Array.isArray(c.assistant.defaultTargets) && c.assistant.defaultTargets.length) ? c.assistant.defaultTargets : ['desktop'];
    for (const d of defaults) out.add(d);
  }
  return [...out];
}

/** A project the person named ("run the LAIN tests") — from the projects LAIN has sessions in. */
function namedProject(name, openDir = null) {
  const n = String(name || '').toLowerCase();
  if (!n || ['the', 'this', 'my', 'our', 'project', 'all'].includes(n)) return null;
  if (openDir && require('path').basename(openDir).toLowerCase() === n) return openDir;
  let rows = [];
  try { rows = require('../sessionindex').summaries({ limit: 300 }) || []; } catch { rows = []; }
  const path = require('path');
  const hit = rows.map((r) => r.cwd).filter(Boolean).find((d) => path.basename(d).toLowerCase() === n)
    || rows.map((r) => r.cwd).filter(Boolean).find((d) => path.basename(d).toLowerCase().includes(n));
  return hit || false;
}

function projectName(app, id) {
  if (!id || id === '(none)') return 'no project';
  try { const s = root(app).session; if (s && s.cwd && require('../journey').projectId(s.cwd) === id) return require('path').basename(s.cwd); } catch { /* */ }
  return id;
}

function scopes(app) {
  const c = root(app).cfg || {};
  const s = (c.bot && c.bot.platforms && c.bot.platforms.telegram && c.bot.platforms.telegram.scopes) || {};
  return { ...DEFAULT_SCOPES, ...s };
}
function allowed(app, from, scope) { return from !== 'messaging' || scopes(app)[scope] === true; }
function refuse(scope) { return { handled: true, text: `That is not allowed from Telegram for this account (permission "${scope}" is off). Change it in BOT › Permissions.` }; }

function fmtTask(t) { return `${t.title} — ${t.type}${t.nextRun ? `, next ${new Date(t.nextRun).toLocaleString()}` : ''}${t.state !== 'scheduled' && t.state !== 'watching' ? ` (${t.state})` : ''}`; }

/**
 * MATCH one message: null (not ours — the model takes it), or a thunk that
 * performs it and resolves to { handled: true, text, task? }. Synchronous, so
 * Core can decide the route before any stream starts.
 * `from` is app.submit's origin ('messaging' for Telegram).
 */
function match(app, text, { from = null, now = Date.now() } = {}) {
  const done = (x) => () => Promise.resolve(x);
  const raw = String(text || '').trim();
  if (!raw || raw.length > 400 || raw.startsWith('/')) return null;
  const t = raw.toLowerCase().replace(/[‘’]/g, "'");
  const r = root(app);
  const session = r.session;
  const origin = from === 'messaging' ? 'telegram' : 'desktop';
  const base = { origin, sessionId: session ? session.id : null };
  const create = (spec) => {
    const res = store.create({ ...base, ...spec }, now);
    if (!res.ok) return { handled: true, text: `I could not set that up: ${res.why}` };
    try { require('./scheduler').poke(app); } catch { /* the clock picks it up */ }
    const x = res.task;
    const policy = x.modelPolicy === 'NO_MODEL' ? 'no model' : `uses a model (${x.modelPolicy.replace('_', ' ').toLowerCase()})`;
    return { handled: true, task: x, text: `${x.type === 'watch' ? 'Watching' : 'Scheduled'}: ${x.title} — ${require('./schedule').describe(x)}${x.type === 'recurring' && x.nextRun ? ` (next ${new Date(x.nextRun).toLocaleString()})` : ''} · delivers to ${x.delivery.targets.join(' + ')} · ${policy}.` };
  };

  // ---- LISTING ------------------------------------------------------------
  if (/^(what|which|list|show)( are)?( my)? (reminders|schedules|scheduled tasks|watches|assistant tasks)\b|^what reminders do i have\b/.test(t)) {
    const kind = /reminder/.test(t) ? 'reminder' : /watch/.test(t) ? 'watch' : null;
    const rows = store.list({ states: ['scheduled', 'watching', 'paused'] }).filter((x) => !kind || x.type === kind);
    return done({ handled: true, text: rows.length ? rows.map(fmtTask).join('\n') : `No ${kind ? `${kind}s` : 'scheduled tasks'}.` });
  }
  if (/^what(?:'s| is) scheduled (for )?(tomorrow|today)\b/.test(t)) {
    const d = new Date(now); d.setHours(0, 0, 0, 0); if (/tomorrow/.test(t)) d.setDate(d.getDate() + 1);
    const lo = d.getTime(); const hi = lo + 864e5;
    const rows = store.list({ states: ['scheduled'] }).filter((x) => x.nextRun >= lo && x.nextRun < hi);
    return done({ handled: true, text: rows.length ? rows.map(fmtTask).join('\n') : `Nothing is scheduled ${/tomorrow/.test(t) ? 'tomorrow' : 'today'}.` });
  }
  if (/^which (tasks|reminders|schedules) failed\b|^what failed\b/.test(t)) {
    const rows = store.activity({ from: now - 7 * 864e5 }).filter((x) => x.outcome === 'failed' || x.deliveryState === 'FAILED' || x.deliveryState === 'PARTIAL');
    return done({ handled: true, text: rows.length ? rows.slice(0, 10).map((x) => `${new Date(x.at).toLocaleString()} · ${x.title}: ${x.outcome === 'failed' ? 'failed' : `delivery ${x.deliveryState.toLowerCase()}`}${(x.deliveries || []).filter((y) => y.state !== 'DELIVERED').map((y) => ` — ${y.target}: ${y.why}`).join('')}`).join('\n') : 'No assistant task failed in the last 7 days.' });
  }

  // ---- WATCHES -----------------------------------------------------------
  const watch = /^(?:tell|notify|ping|alert) me (?:when|if) (.+)$/.exec(t);
  if (watch) {
    if (!allowed(app, from, 'reminders')) return done(refuse('reminders'));
    const c = watch[1];
    const targets = targetsFor(raw, from, app);
    if (/(claude).*(reset|quota|limit)/.test(c)) return () => Promise.resolve(create({ type: 'watch', title: 'Claude window reset', watch: { kind: 'window_reset', source: 'claude-code', label: 'Claude Code' }, schedule: { poll: 60 }, delivery: { targets } }));
    const cx = /codex(?: account)?\s*(\d+)?.*reset/.exec(c);
    if (cx) {
      const accts = require('../accountinstances').list(app).filter((v) => v.driver_id === 'codex');
      const pick = cx[1] ? accts.find((v) => new RegExp(`\\b${cx[1]}\\b`).test(v.display_name)) : accts[0];
      if (!pick) return done({ handled: true, text: 'I could not find that Codex account.' });
      return () => Promise.resolve(create({ type: 'watch', title: `${pick.display_name} reset`, watch: { kind: 'window_reset', source: pick.id, label: pick.display_name }, schedule: { poll: 60 }, delivery: { targets } }));
    }
    if (/telegram.*(stops?|isn'?t|not|down|fails?)/.test(c)) return () => Promise.resolve(create({ type: 'watch', title: 'Telegram stops being operational', watch: { kind: 'channel_state', platform: 'telegram', when: 'down' }, schedule: { poll: 60 }, delivery: { targets: targets.filter((x) => x !== 'telegram').length ? targets.filter((x) => x !== 'telegram') : ['desktop'] } }));
    // Z.AI IS API-ONLY IN LAIN (2026-09-29): no Start Plan watch — the honest answer instead.
    if (/zcode|start plan/.test(c)) return done({ handled: true, text: "LAIN integrates Z.ai through its API and does not use ZCode's Start Plan — ZCode does not report its plan to LAIN, so there is nothing to watch. Z.ai API quota is under MODEL › API." });
    const rt = /(claude code|opencode|zcode|llama\.?cpp|ollama) (?:is|becomes) (operational|running|ready)/.exec(c);
    if (rt) { const id = { 'claude code': 'claude-code', opencode: 'opencode', zcode: 'zcode', 'llama.cpp': 'llamacpp', llamacpp: 'llamacpp', ollama: 'ollama' }[rt[1]]; return () => Promise.resolve(create({ type: 'watch', title: `${rt[1]} ${rt[2]}`, watch: { kind: 'runtime_state', runtime: id, state: rt[2] === 'operational' ? 'Operational' : rt[2] === 'running' ? 'Running' : 'Ready' }, schedule: { poll: 120 }, delivery: { targets } })); }
    return null;
  }

  // ---- RECURRING -----------------------------------------------------------
  const cad = /^every\b|\b(daily|nightly|weekly|monthly)\b|^(on )?weekdays\b/.test(t) ? cadence(t) : null;
  if (cad) {
    if (!allowed(app, from, 'reminders')) return done(refuse('reminders'));
    const targets = targetsFor(raw, from, app);
    if (/\b(limits?|quota)\b/.test(t)) return () => Promise.resolve(create({ type: 'recurring', title: 'Model limits summary', action: { kind: 'limits_summary' }, schedule: cad, delivery: { targets } }));
    if (/\bwhich project used the most\b|\b(token|usage)\b/.test(t)) return () => Promise.resolve(create({ type: 'recurring', title: 'Usage by project', action: { kind: 'usage_summary', args: { range: cad.every === 'day' ? 'today' : '7d', by: 'project' } }, schedule: cad, delivery: { targets } }));
    if (/\b(runtimes?|running)\b/.test(t)) return () => Promise.resolve(create({ type: 'recurring', title: 'Runtime status', action: { kind: 'runtime_status' }, schedule: cad, delivery: { targets } }));
    const rem = /\bremind me (?:to )?(.+?)(?:\s+every\b.*)?$/.exec(t);
    if (rem) return () => Promise.resolve(create({ type: 'recurring', title: rem[1].slice(0, 80), instruction: raw, action: { kind: 'notify' }, schedule: cad, delivery: { targets } }));
    return null;   // a recurring MODEL task needs its policy shown before saving — the Schedules form does that
  }

  // ---- REMIND vs RUN -------------------------------------------------------
  const remind = /^remind me\b(.*)$/.exec(t);
  if (remind) {
    if (!allowed(app, from, 'reminders')) return done(refuse('reminders'));
    const at = when(t, now);
    if (!at) return done({ handled: true, text: 'When should I remind you? (e.g. "in 20 minutes", "at 7 pm", "tomorrow at 8")' });
    const what = (/\bto\s+(.+?)(?:\s+(?:in|at|tomorrow|tonight)\b.*)?$/.exec(raw.replace(/^remind me\s*/i, '')) || [])[1] || 'Reminder';
    return () => Promise.resolve(create({ type: 'reminder', title: what.trim().replace(/[.!]$/, '').slice(0, 80) || 'Reminder', instruction: `Reminder: ${what.trim()}`, action: { kind: 'notify' }, schedule: { at }, delivery: { targets: targetsFor(raw, from, app) } }));
  }
  const run = /^(?:(?:tomorrow|today|tonight|at \d{1,2}(?::\d{2})?(?: ?[ap]m)?|in \d+ \w+)[\s,]*)*run (?:the |this |my )?(?:([\w.-]+?)(?:'s)? )?(?:project(?:'s)? )?tests?\b/.exec(t);
  if (run && /\b(tomorrow|today|tonight|at \d|in \d)/.test(t)) {
    if (!allowed(app, from, 'runTests')) return done(refuse('runTests'));
    const at = when(t, now);
    if (!at) return null;
    // THE PROJECT NAMED, or the one open. A name LAIN has no project for is said, never guessed.
    const named = namedProject(run[1], session && session.cwd);
    if (named === false) return done({ handled: true, text: `I don't know a project called "${run[1]}" — open it in LAIN once, then ask again.` });
    const projectRoot = named || (session && session.cwd ? session.cwd : null);
    if (!projectRoot) return done({ handled: true, text: 'Open the project first — I run its tests in its own folder.' });
    return () => Promise.resolve(create({ type: 'scheduled', title: `Run tests · ${require('path').basename(projectRoot)}`, instruction: raw, action: { kind: 'run_tests' }, schedule: { at }, projectRoot, projectId: require('../journey').projectId(projectRoot), delivery: { targets: targetsFor(raw, from, app) } }));
  }

  // ---- DETERMINISTIC QUESTIONS (no model) ---------------------------------
  if (/\b(quota|limits?|usage windows?)\b/.test(t) && /\b(left|remaining|how much|what(?:'s| is)|show)\b/.test(t) && !/\btoken/.test(t)) {
    if (!allowed(app, from, 'readUsage')) return done(refuse('readUsage'));
    const full = require('./actions').limitsText(app);
    if (/claude/.test(t)) {
      const ls = full.split('\n').filter((l) => /claude/i.test(l));
      return done({ handled: true, text: ls.length ? `Claude quota (as Claude Code reported it)\n${ls.join('\n')}` : 'Claude Code has not reported its usage windows to LAIN yet — they arrive with its first run through LAIN.' });
    }
    return done({ handled: true, text: full });
  }
  if (/\b(which|what) runtimes? (are|is) running\b|\bis (opencode|claude code|zcode|ollama|llama\.?cpp) (running|operational|up)\b/.test(t)) {
    if (!allowed(app, from, 'readUsage')) return done(refuse('readUsage'));
    return async () => {
    const txt = await require('./actions').runtimeText(app);
    const one = /\bis (opencode|claude code|zcode|ollama|llama\.?cpp)\b/.exec(t);
    return ({ handled: true, text: one ? (txt.split('\n').find((l) => l.toLowerCase().startsWith(one[1].replace('llamacpp', 'llama.cpp'))) || `${one[1]} is not installed or not found.`) : txt });
    };
  }
  if (/\b(which|what) local model is (loaded|running)\b/.test(t)) {
    const s = require('../local/llamacpp').status();
    return done({ handled: true, text: s.length ? s.map((x) => `${x.model} — llama.cpp, pid ${x.pid}, port ${x.port}, context ${x.ctx}`).join('\n') : 'No local model is loaded right now.' });
  }
  if (/\bwhen does (the )?zcode start plan expire\b|\bstart plan (expiry|balance)\b/.test(t)) {
    return done({ handled: true, text: "LAIN integrates Z.ai through its API and does not use ZCode's Start Plan — ZCode does not report its plan to LAIN, so there is nothing to watch. Z.ai API quota is under MODEL › API." });
  }
  if (/\bis telegram (operational|working|up|connected)\b/.test(t)) {
    return async () => {
    const c = await require('../botconnect').telegram(app).catch(() => null);
    return ({ handled: true, text: c ? `Telegram: ${String(c.status || 'unknown').toLowerCase()} — ${c.summary || ''}` : 'Telegram status could not be read.' });
    };
  }
  const used = /^how (?:much|many tokens) did ([\w.-]+) use (today|this week)\b/.exec(t);
  if (used) {
    if (!allowed(app, from, 'readUsage')) return done(refuse('readUsage'));
    const u = require('../usage');
    const from0 = used[2] === 'today' ? (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })() : now - 7 * 864e5;
    const rows = u.read({ from: from0 }).filter((x) => { const p = projectName(app, x.project); return p.toLowerCase() === used[1] || String(x.project || '').toLowerCase() === used[1]; });
    const s = u.sum(rows, {});
    return done({ handled: true, text: `${used[1]} ${used[2]}: ${s.requests} request(s) · input ${s.input.toLocaleString()} · output ${s.output.toLocaleString()} tokens (as reported)${s.estimated.rows ? ` · ${(s.estimated.input + s.estimated.output).toLocaleString()} estimated by LAIN` : ''}.` });
  }
  return null;
}

/** INTERPRET one message: the matched answer, or null (the model takes it). */
async function interpret(app, text, opts = {}) { const m = match(app, text, opts); return m ? m() : null; }

module.exports = { interpret, match, when, cadence, clock, targetsFor, scopes, DEFAULT_SCOPES, projectName };
