'use strict';

/**
 * DELIVERING AN ASSISTANT RESULT — to each of the task's targets, with a
 * receipt per target; the run's delivery state is DELIVERED, PARTIAL or FAILED.
 * Nothing is dropped silently: a target that cannot receive says why.
 *
 *   desktop    the LAIN window's host: a native notification that, when
 *              clicked, opens BOT › Assistant (or the task's origin). With no
 *              window running, FAILED: "no LAIN window".
 *   chat       LAIN Chat › Schedules (the activity the window shows) —
 *              DELIVERED when recorded; it never writes into a conversation.
 *   telegram   the Phase-5 Telegram channel (one channel, one bot): the same
 *              delivery path a BOT reply takes, to the approved people.
 *
 * Quiet hours are applied by the scheduler BEFORE delivery (deferral), never here.
 */

async function toDesktop(app, task, text) {
  try {
    const r0 = (app && app._sibling) || app;
    if (r0 && r0.cfg && r0.cfg.assistant && r0.cfg.assistant.notifications === false) return { state: 'FAILED', why: 'desktop notifications are off (BOT › Assistant)' };
    const ipc = require('../harnessapp/ipc');
    const payload = JSON.stringify({ title: `LAIN · ${task.title}`.slice(0, 64), text: String(text).slice(0, 240), nav: { tab: 'bot', section: 'assistant', task: task.id } });
    const r = ipc.toHost(`remind:${payload}`);
    if (r && r.ok) return { state: 'DELIVERED' };
    return { state: 'FAILED', why: (r && r.why) || 'no LAIN window is running' };
  } catch (e) { return { state: 'FAILED', why: e.message }; }
}

async function toTelegram(app, task, text) {
  try {
    const bc = require('../botconnect');
    const r = (app && app._sibling) || app;
    const s = (r.cfg && r.cfg.bot && r.cfg.bot.platforms && r.cfg.bot.platforms.telegram) || {};
    const to = (s.allowUsers || []).map(String);
    if (!to.length) return { state: 'FAILED', why: 'no approved Telegram user' };
    const own = r._botService;
    if (!own || own.stopped || !own.gateway) { const svc = await bc.service(app).catch(() => ({})); return { state: 'FAILED', why: svc.owner === 'external' ? 'messaging runs in another LAIN process' : 'Telegram messaging is not running' }; }
    const gw = own.gateway;
    const accountId = s.accountId || 'default';
    const bad = [];
    for (const chatId of to) {
      const e = { platform: 'telegram', accountId, chatId, senderId: chatId, kind: 'dm', threadId: '', replyTo: '', timestamp: Date.now() };
      // eslint-disable-next-line no-await-in-loop -- a handful of approved people
      const rows = await gw.delivery.sendMessage(e, `⏰ ${task.title}\n${text}`.slice(0, 3900), { id: `assistant:${task.id}:${Date.now()}:${chatId}`, kind: 'notice' }).catch((err) => [{ state: 'failed', why: err.message }]);
      const miss = (rows || []).find((x) => x.state !== 'delivered');
      if (miss) bad.push(miss.why || miss.state);
    }
    return bad.length ? { state: 'FAILED', why: `Telegram did not confirm: ${bad[0]}` } : { state: 'DELIVERED', to: to.length };
  } catch (e) { return { state: 'FAILED', why: e.message }; }
}

/** DELIVER to every target. Returns { deliveries: [{target, state, why}], state }. */
async function deliver(app, task, text, { toDesktopFn = toDesktop, toTelegramFn = toTelegram } = {}) {
  const deliveries = [];
  for (const target of task.delivery.targets) {
    let r;
    if (target === 'desktop') r = await toDesktopFn(app, task, text);
    else if (target === 'telegram') r = await toTelegramFn(app, task, text);
    else if (target === 'chat') r = { state: 'DELIVERED', where: 'LAIN Chat › Schedules' };
    else r = { state: 'FAILED', why: `unknown target ${target}` };
    deliveries.push({ target, ...r });
  }
  const ok = deliveries.filter((d) => d.state === 'DELIVERED').length;
  const state = ok === deliveries.length ? 'DELIVERED' : ok === 0 ? 'FAILED' : 'PARTIAL';
  return { deliveries, state };
}

module.exports = { deliver, toDesktop, toTelegram };
