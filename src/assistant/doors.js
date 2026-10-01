'use strict';

/**
 * THE ASSISTANT'S HOUSE DOORS — how the BOT's model reaches the one task store
 * when the deterministic door (intent.js) did not already handle the sentence.
 * Same store, same validation, same channel permissions: a door is not a
 * second path around them.
 *
 *   assistant.list      read    reminders, schedules, watches, recent activity
 *   assistant.schedule  change  create a task (structured args), or a sentence
 *                               intent.js understands (args.text)
 *   assistant.cancel    change  cancel one task by id
 *   assistant.open      navigate  BOT › Assistant
 *
 * COST SAFEGUARD: a recurring task that runs a MODEL is not saved from here —
 * the person confirms its policy in Chat › Schedules, which the door opens.
 * FROM TELEGRAM the channel's scopes apply exactly as they do to intent.js.
 */

function fromOf(app) { const s = app && app.session; return (s && s.inflight && s.inflight.from) || null; }

function DOORS(KIND, go) {
  const store = require('./store');
  const intent = () => require('./intent');
  const line = (t) => `${t.id} · ${t.title} — ${t.type}, ${require('./schedule').describe(t)}${t.nextRun ? `, next ${new Date(t.nextRun).toLocaleString()}` : ''} (${t.state})`;
  return [
    {
      id: 'assistant.list', kind: KIND.READ, what: 'the person’s reminders, schedules, watches and recent assistant activity (from Core)',
      run: () => {
        const live = store.list({ states: ['scheduled', 'watching', 'paused'] });
        const act = store.activity({ limit: 8 });
        return { ok: true, text: `${live.length ? live.map(line).join('\n') : 'No active reminders, schedules or watches.'}${act.length ? `\n\nRecent:\n${act.map((a) => `${new Date(a.at).toLocaleString()} · ${a.title}: ${a.outcome}${a.deliveryState ? `, delivery ${a.deliveryState.toLowerCase()}` : ''}`).join('\n')}` : ''}` };
      },
    },
    {
      id: 'assistant.schedule', kind: KIND.CHANGE,
      what: 'create a reminder, scheduled/recurring task or watch in Core (args: text — a sentence like "remind me at 7 pm to call Sam"; or type reminder|scheduled|recurring, title, instruction, at (ISO time) or every day|weekday|week|month + time HH:MM, action notify|limits_summary|usage_summary|runtime_status|run_tests|bot_prompt, targets [desktop, chat, telegram], modelPolicy)',
      run: async (app, a) => {
        const from = fromOf(app);
        const sc = intent().scopes(app);
        if (from === 'messaging' && !sc.reminders) return { ok: false, why: 'not allowed from Telegram for this account (permission "reminders" is off)' };
        if (a.text) {
          const r = await intent().interpret(app, String(a.text).slice(0, 400), { from });
          return r ? { ok: true, text: r.text } : { ok: false, why: 'that sentence is not one Noema schedules without a model; pass structured arguments' };
        }
        const kind = String(a.action || 'notify');
        if (kind === 'run_tests' && from === 'messaging' && !sc.runTests) return { ok: false, why: 'not allowed from Telegram for this account (permission "runTests" is off)' };
        if (kind === 'agent_task' || kind === 'edit_code') return { ok: false, why: 'Coding Agent work is not scheduled unattended; the person starts it' };
        const type = String(a.type || (a.every ? 'recurring' : 'scheduled'));
        const schedule = type === 'recurring' ? { every: String(a.every || 'day'), at: String(a.time || a.at || '09:00'), ...(a.weekday != null ? { weekday: Number(a.weekday) } : {}) } : { at: Date.parse(a.at) };
        const spec = {
          type, title: String(a.title || a.instruction || 'Reminder').slice(0, 80), instruction: a.instruction ? String(a.instruction).slice(0, 2000) : null,
          action: { kind: type === 'reminder' ? 'notify' : kind, args: kind === 'bot_prompt' ? { include: Array.isArray(a.include) ? a.include.filter((x) => ['limits', 'usage'].includes(x)) : [] } : {} },
          modelPolicy: a.modelPolicy || (kind === 'bot_prompt' ? 'BOT_MODEL' : 'NO_MODEL'), schedule,
          delivery: { targets: Array.isArray(a.targets) && a.targets.length ? a.targets : (from === 'messaging' ? ['telegram'] : ['desktop']) },
          origin: from === 'messaging' ? 'telegram' : 'desktop', sessionId: app.session ? app.session.id : null,
          projectRoot: kind === 'run_tests' && app.session ? app.session.cwd : null,
        };
        const n = store.normalize(spec);
        if (!n.ok) return { ok: false, why: n.why };
        // COST SAFEGUARD: the person confirms what a recurring model task will use.
        if (n.task.type === 'recurring' && n.task.modelPolicy !== 'NO_MODEL') {
          go(app, 'assistant.schedule', 'chat', 'schedules');
          return { ok: false, why: `a recurring task that runs a model (${n.task.modelPolicy}) every time it fires is saved only after the person confirms its policy — Chat › Schedules is open for that` };
        }
        const r = store.create(n.task);
        if (!r.ok) return { ok: false, why: r.why };
        try { require('./scheduler').poke(app); } catch { /* the clock picks it up */ }
        return { ok: true, text: `Scheduled: ${line(r.task)} · delivers to ${r.task.delivery.targets.join(' + ')} · ${r.task.modelPolicy === 'NO_MODEL' ? 'no model' : r.task.modelPolicy}` };
      },
    },
    {
      id: 'assistant.cancel', kind: KIND.CHANGE, what: 'cancel one reminder, schedule or watch (args: id from assistant.list)',
      run: (app, a) => {
        if (fromOf(app) === 'messaging' && !intent().scopes(app).reminders) return { ok: false, why: 'not allowed from Telegram for this account (permission "reminders" is off)' };
        const r = store.cancel(String(a.id || ''));
        return r.ok ? { ok: true, text: `Cancelled: ${r.task.title}` } : r;
      },
    },
    {
      id: 'assistant.open', kind: KIND.NAVIGATE, what: 'open BOT › Assistant (schedules, activity, notifications, quiet hours, Telegram permissions)',
      run: (app) => go(app, 'assistant.open', 'bot', 'assistant'),
    },
  ];
}

module.exports = { DOORS };
