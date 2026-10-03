'use strict';

/**
 * THE ASSISTANT, DRIVEN THROUGH THE REAL WINDOW (native host + WebView2, the
 * mock model, an isolated profile — tests/harness/appdriver.js).
 *
 *   "Remind me in 2 minutes to stretch" typed in Chat is answered by Core with
 *   no model; the task shows in Chat › Schedules and BOT › Assistant (one
 *   store); Run now delivers with receipts (desktop through the real host's
 *   notification verb); quiet hours save through Core; Home search finds the
 *   task; MODEL › Runtimes shows each runtime's capability matrix.
 */

const assert = require('assert');
const { test } = require('../helpers');

module.exports = async function () {
  await test('ASSISTANT REAL UI: Chat reminder → Schedules → BOT › Assistant → Run now → receipts; Home search; runtime matrix', async () => {
    const drv = require('../harness/appdriver');
    const mp = require('../../src/mockprovider');
    const realChat = mp.chat;
    let modelCalls = 0;
    mp.chat = async function* () { modelCalls += 1; yield { type: 'text', chunk: 'model' }; yield { type: 'usage', inputTokens: 1, outputTokens: 1 }; };
    const d = await drv.open({ script: [], width: 1400, height: 880 });
    if (d.skipped) { mp.chat = realChat; process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const errors = [];
    await d.page.conn.send('Runtime.enable');
    d.page.conn.on((m, p) => { if (m === 'Runtime.exceptionThrown') errors.push(JSON.stringify(p.exceptionDetails).slice(0, 300)); });
    try {
      await d.until("!document.getElementById('app').hidden");
      // CHAT: a reminder, answered by Core.
      await d.js("LAIN.nav.go('chat')");
      await d.until("document.getElementById('ask') && document.getElementById('ask').offsetParent !== null");
      await d.js("LAIN.chat.ask('Remind me in 2 minutes to stretch')");
      await d.until("/Scheduled: stretch/.test(document.getElementById('chatHost').innerText)", 30000);
      assert.strictEqual(modelCalls, 0, 'no model for a reminder');

      // CHAT › SCHEDULES — the same Core task.
      await d.click('#chatSchedBtn');
      await d.until("!document.getElementById('chatSched').hidden && /stretch/.test(document.getElementById('chatSched').innerText)", 20000);
      const sched = await d.js("document.getElementById('chatSched').innerText");
      assert.ok(/Upcoming/.test(sched) && /Recurring/.test(sched) && /Watches/.test(sched) && /Completed/.test(sched), sched.slice(0, 300));
      assert.ok(/no model/.test(sched), 'the policy is shown');

      // BOT › ASSISTANT — settings and the same list; quiet hours saved through Core.
      await d.js("LAIN.nav.go('bot', { section: 'assistant' })");
      await d.until("/Quiet hours/.test(document.getElementById('botPane').innerText) && /stretch/.test(document.getElementById('botPane').innerText)", 20000);
      const pane = await d.js("document.getElementById('botPane').innerText");
      for (const w of ['Desktop notifications', 'Default delivery', 'Quiet hours', 'Background execution', 'Condition checks', 'Missed runs', 'What Telegram may do', 'Edit code', 'Computer control']) assert.ok(pane.toLowerCase().includes(w.toLowerCase()), `BOT › Assistant shows ${w}`);   // headings are CSS-uppercased
      await d.js("(() => { const f = Array.from(document.querySelectorAll('#botPane .field')).find((x) => /Quiet hours/.test(x.innerText)); f.querySelector('.toggle').click(); return true; })()");
      await d.until("LAIN.assistant.get() && LAIN.assistant.get().settings.quietHours.enabled === true", 15000);
      assert.strictEqual(d.app.cfg.assistant.quietHours.enabled, true, 'saved in Core config');

      // RUN NOW — delivered with receipts; desktop goes through the real host.
      await d.js("(() => { const row = Array.from(document.querySelectorAll('#botPane .trow')).find((r) => /stretch/.test(r.innerText)); Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Run now').click(); return true; })()");
      await d.until("(LAIN.assistant.get().activity || []).some((a) => a.title === 'stretch')", 20000);
      const act = await d.js("LAIN.assistant.get().activity.find((a) => a.title === 'stretch')");
      assert.strictEqual(act.outcome, 'ok');
      assert.deepStrictEqual(act.deliveries.map((x) => `${x.target}:${x.state}`), ['desktop:DELIVERED'], JSON.stringify(act.deliveries));
      assert.strictEqual(modelCalls, 0, 'still no model');

      // HOME SEARCH finds the task and the assistant settings.
      const hits = await d.js("LAIN.search.query('stretch').map((e) => e.group + ':' + e.title)");
      assert.ok(hits.some((h) => h === 'Assistant:stretch'), JSON.stringify(hits).slice(0, 300));
      const hs = await d.js("LAIN.search.query('quiet hours').map((e) => e.title)");
      assert.ok(hs.includes('Assistant settings'), JSON.stringify(hs).slice(0, 300));

      // MODEL › RUNTIMES — every runtime card carries the capability matrix.
      await d.js("LAIN.nav.go('model', { section: 'runtimes' })");
      await d.until("document.querySelectorAll('.rtcard .rtcaps').length > 0", 30000);
      const cells = await d.js("Array.from(document.querySelector('.rtcard .rtcaps').querySelectorAll('.ck')).map((x) => x.textContent)");
      assert.deepStrictEqual(cells, ['DISCOVERY', 'TELEMETRY', 'EXECUTION', 'SESSIONS', 'USAGE', 'LIMITS', 'STREAMING', 'CANCEL', 'BOT', 'CHAT', 'AGENT']);
      assert.deepStrictEqual(errors, [], 'no page exceptions');
    } finally {
      mp.chat = realChat;
      await d.close();
      try { require('fs').rmSync(require('../../src/assistant/store').dir(), { recursive: true, force: true }); } catch { /* isolated */ }
    }
  });
};
