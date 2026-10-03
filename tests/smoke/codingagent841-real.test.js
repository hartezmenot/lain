'use strict';

/**
 * THE CODING AGENT SIDECAR (Phase 8.4.1) IN THE REAL WINDOW — read at 1280×720 and 1600×900, at interface zoom 125 % and 150 %.
 *
 *   readable           conversation type is body-size (15 px) at 100 %; headers are 12.5 px and up
 *   turns              YOU / CODING AGENT headers with a time, one thin rule between turns — no bubbles, no glow
 *   the task strip     TASK · state · Phase n/7 · summary · [Open full Coding Chat], a band of its own above the conversation
 *   the composer       larger, grows as it is typed in; "+ @ /" and a labelled Send/Start/Continue/Stop
 *   the route          Provider · Model · Effort on one line, and Execution "Normal ▾" (Normal · Fast · Eco — never Slow)
 *   nothing selected   "Select model" and NO model or effort shown — in the sidecar, the tracker and the status bar
 *   (2026-09-30: sizes follow the four-gate spec §5/§23 — the sidecar is IDE-density, 12.5–13.5 px)
 *   the panel          narrower than the editor beside it
 *
 * Fixtures only: the fake `claude` behind Claude Code (the Coding Agent's route), a seeded plan and conversation.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const SCENES = [[1280, 720, [100, 125, 150]], [1600, 900, [100]]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function () {
  await test('CODING AGENT 8.4.1: readable, flat turns, a task strip, a larger composer, one-line route, "Select model" — at 1280×720, 1600×900 and zoom 125/150 %', async () => {
    const drv = require('../harness/appdriver');
    const fx = require('../harness/fabricfixtures');
    const store = require('../../src/fabric/store');
    const si = require('../../src/sessionintel');
    const F = require('../../src/fabric/index');
    const { Plan } = require('../../src/plan');
    const shots = process.env.LAIN_SHOTS_DIR || tmpdir('ca841-');
    const problems = [];
    const saved = process.env.FAKE_CLAUDE_HOME;
    for (const [w, h, zooms] of SCENES) {
      const d = await drv.open({ width: w, height: h, script: [] });
      if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
      const R = require('../harness/realinput')(d);
      const root = d.app._sibling || d.app;
      const at = (name) => path.join(shots, `${w}x${h}-${name}.png`);
      const fail = (m) => problems.push(`${w}x${h}: ${m}`);
      const text = (sel) => d.js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);
      try {
        await d.until("!document.getElementById('app').hidden", 30000);
        const home = path.join(tmpdir('ca841-home-'), 'own-claude'); fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ fake: true, email: 'dora@example.com' }));
        process.env.FAKE_CLAUDE_HOME = home;
        await fx.claudeRuntime(root, tmpdir('ca841-claude-'));
        await d.reload();
        await d.surface('ide');
        await d.until("!!document.querySelector('#ideBotHost #composerCells')", 20000);

        // ---- NOTHING SELECTED: "Select model" (2026-09-30 route pill), and no model or effort shown ------------------------------
        await d.js('LAIN.poll()');
        await d.until("!!document.querySelector('#ideBotHost [data-cell=model].need')", 15000);
        assert.strictEqual((await text('#ideBotHost [data-cell=model].need .mt')).trim(), 'Select model');
        assert.strictEqual(await d.js("document.querySelectorAll('#ideBotHost [data-cell=provider], #ideBotHost [data-cell=effort], #ideBotHost [data-cell=model]:not(.need)').length"), 0, 'no model without a provider');
        // THE TOP BAR is the usage tracker now: it names no model; with no route it says "Usage".
        assert.strictEqual((await text('#trackerText')).trim(), 'Usage', 'the tracker invents nothing without a route');
        assert.match(await text('#sbModel'), /^\s*Select model\s*$/, 'the status bar names no model either');
        assert.ok(!(await d.js("/Choose provider/i.test(document.getElementById('main').innerText + document.getElementById('sbModel').innerText)")), 'no "Choose provider"');
        await d.shot(at('sidecar-unrouted'));

        // ---- A ROUTE, A PLAN AT PHASE 3 OF 7, AND A CONVERSATION ----------------------------------------------------------------
        const cm = F.family(root, 'claude').models[0];
        const chosen = await si.choose(root, root.session, { lane: 'coding', family: 'claude', model: cm.id });
        assert.ok(chosen.ok, chosen.why);
        const S = root.session;
        const p = new Plan('Rebuild the accounts screen');
        p.addSteps(['Read the accounts page', 'Group by provider', 'Add the ⋯ menus', 'Move setup to its own surface', 'Quota says what remains', 'Detach paths', 'Verify at 125% and 150%']);
        p.steps[0].status = 'done'; p.steps[1].status = 'done'; p.steps[2].status = 'active';
        S.plan = p; S.title = 'Rebuild the accounts screen';
        const t0 = Date.now() - 900000;
        const fence = String.fromCharCode(96).repeat(3);
        S.messages = S.messages || [];
        S.messages.push({ role: 'user', content: 'Rebuild the accounts screen so each provider is one section and setup entries stay out of the daily list.', ts: new Date(t0).toISOString(), thread: 'coding' });
        S.messages.push({ role: 'assistant', content: ['I read the current accounts page. Codex, Claude and Antigravity each get one section; imported entries move to Finish setup.', '', 'Next: the ⋯ menus, then quota bars that say what remains.', '', `${fence}js`, 'function providerSection(f) { return U.section({ id: f.id }); }', fence].join('\n'), ts: new Date(t0 + 240000).toISOString(), thread: 'coding', by: 'agent' });
        S.messages.push({ role: 'user', content: 'Good. Keep Detach and Sign out distinct — Detach never signs out.', ts: new Date(t0 + 420000).toISOString(), thread: 'coding' });
        await d.js('LAIN.poll()');
        await d.until("!!document.querySelector('#agentTask:not([hidden]) [data-task-open]') && document.querySelectorAll('#ideBotHost .msg').length >= 3", 20000);

        for (const z of zooms) {
          await d.js(`LAIN.appearance.set({ zoom: ${z} })`);
          await sleep(900);
          const narrow = await d.js('window.innerWidth <= 900');
          // AT 150 % ON A 1280 PX WINDOW THE IDE IS THE NARROW LAYOUT: the sidecar is one tap away and then takes the width.
          if (narrow && !(await d.js("document.getElementById('main').classList.contains('show-bot')"))) { await d.js('LAIN.ide.toggleBot()'); await sleep(500); }
          const tag = `zoom ${z}%${narrow ? ' (narrow layout)' : ''}`;
          const m = await d.js(`(function () {
            var q = function (s) { return document.querySelector(s); };
            var cs = function (e) { return getComputedStyle(e); };
            var rect = function (e) { var r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height }; };
            var msgs = Array.prototype.slice.call(document.querySelectorAll('#ideBotHost .msg'));
            var who = msgs.map(function (m) { return { name: (m.querySelector('.who .nm') || {}).textContent.trim(), at: (m.querySelector('.who .at') || {}).textContent || '', size: parseFloat(cs(m.querySelector('.who .nm') || m.querySelector('.who')).fontSize) }; });
            var user = q('#ideBotHost .msg.user .body');
            var body = q('#ideBotHost .msg .body');
            var task = q('#agentTask'), stream = q('#ideBotHost .stream'), ask = q('#ask'), send = q('#send'), lbl = q('#send .lbl');
            var editor = q('.editor-col'), bot = q('#ideBot');
            var exec = q('#ideBotHost [data-cell=exec]');
            var prov = q('#ideBotHost [data-cell=provider]');
            var box = ask.closest('.box');
            return {
              who: who, bodySize: parseFloat(cs(body).fontSize), userBubble: { bg: cs(user).backgroundColor, border: cs(user).borderTopWidth, radius: cs(user).borderTopLeftRadius },
              rule: msgs.length > 1 ? cs(msgs[1]).borderTopWidth : null, glow: msgs.some(function (m) { return cs(m).boxShadow !== 'none'; }),
              task: { text: task.innerText, r: rect(task), border: cs(task).borderBottomWidth, shadow: cs(task).boxShadow, hasOpen: !!q('#agentTask [data-task-open]'), size: parseFloat(cs(task.querySelector('.tk-sum') || task.querySelector('b')).fontSize) },
              stream: rect(stream), ask: rect(box || ask), askSize: parseFloat(cs(ask).fontSize),
              askChips: box ? Array.prototype.filter.call(box.querySelectorAll('.chip'), function (c) { return c.getBoundingClientRect().width > 0; }).length : 0, askEmpty: !ask.value,
              buttons: ['addBtn', 'atBtn', 'slashBtn'].map(function (i) { var b = document.getElementById(i); return b && b.getBoundingClientRect().width > 0 ? b.textContent.trim() || i : null; }),
              // THE SIDECAR'S SEND IS AN ICON (2026-09-30: a label overflowed at 1280) — named for assistive tech, and a real target.
              send: { text: (lbl && cs(lbl).display !== 'none' ? lbl.textContent : '') || send.getAttribute('aria-label') || send.title || '', w: rect(send).w, visible: rect(send).w > 0 },
              route: { provider: prov ? (prov.getAttribute('aria-label') || prov.getAttribute('data-tip') || '') : '', model: (q('#ideBotHost [data-cell=model] .mt') || {}).textContent, exec: exec ? (exec.getAttribute('aria-label') || exec.innerText).trim() : null, sameRow: exec && prov ? Math.abs(rect(exec).top + rect(exec).h / 2 - (rect(prov).top + rect(prov).h / 2)) < 30 : false },
              panels: { bot: rect(bot).w, editor: editor && cs(editor).display !== 'none' ? rect(editor).w : null },
              overflow: document.documentElement.scrollWidth - window.innerWidth
            };
          })()`);
          // READABLE AT IDE DENSITY (the four-gate spec §5, which replaces 8.4.1's full-Chat sizes for the sidecar):
          // conversation and composer 12.5–13.5 px, turn heading and task metadata 11–12 px, at 100 %.
          const inRange = (v, lo, hi) => v >= lo - 0.05 && (z !== 100 || v <= hi + 0.05);
          if (!inRange(m.bodySize, 12.5, 13.5)) fail(`${tag}: conversation text is ${m.bodySize}px`);
          if (m.who.some((x) => !inRange(x.size, 11, 12.5))) fail(`${tag}: a turn heading is ${JSON.stringify(m.who.map((x) => x.size))}px`);
          if (m.task.size < 11) fail(`${tag}: the task summary is ${m.task.size}px`);
          if (!inRange(m.askSize, 12.5, 13.5)) fail(`${tag}: the composer text is ${m.askSize}px`);
          // TURNS: YOU / CODING AGENT, with a time; a rule between; no bubble, no glow
          if (!m.who.some((x) => /^you$/i.test(x.name)) || !m.who.some((x) => /^coding agent$/i.test(x.name))) fail(`${tag}: headers ${JSON.stringify(m.who.map((x) => x.name))}`);
          if (m.who.some((x) => !/\d{1,2}:\d{2}/.test(x.at))) fail(`${tag}: a header has no time: ${JSON.stringify(m.who)}`);
          if (m.userBubble.border !== '0px' || m.userBubble.bg !== 'rgba(0, 0, 0, 0)') fail(`${tag}: the user turn is a bubble ${JSON.stringify(m.userBubble)}`);
          if (!(parseFloat(m.rule) >= 0.5 && parseFloat(m.rule) <= 1.2)) fail(`${tag}: turns are not divided by a thin rule (${m.rule})`);   // 1px CSS, scaled by the window's zoom
          if (m.glow) fail(`${tag}: a turn has a shadow`);
          // THE TASK STRIP
          // THE POSITION IS CORE'S COMMITTED CHECKPOINT (taskcheckpoint.js): "Phase 3 / 7" (spec §22).
          if (!/TASK/.test(m.task.text) || !/Phase 3 \/ 7/.test(m.task.text) || !/Ready|Running|Paused|Interrupted|Complete/.test(m.task.text) || !/Rebuild the accounts screen/.test(m.task.text) || !m.task.hasOpen) fail(`${tag}: the task strip reads "${m.task.text.replace(/\s+/g, ' ')}" header=${await d.js('JSON.stringify(LAIN.state().header)')}`);
          if (m.task.r.bottom > m.stream.top + 1) fail(`${tag}: the task strip overlaps the conversation`);
          if (m.task.border === '0px' && !/inset/.test(m.task.shadow || '')) fail(`${tag}: the task strip is not separated from the conversation`);
          // THE COMPOSER (compact in the sidecar: + and @ as buttons; commands by typing "/")
          if (!m.buttons[0] || m.buttons[1] !== '@') fail(`${tag}: composer buttons ${JSON.stringify(m.buttons)}`);
          if (!m.send.visible || !/^(Send|Start|Continue|Stop)\b/.test(m.send.text) || m.send.w < 28) fail(`${tag}: the send button is "${m.send.text}" (${m.send.w}px)`);
          if (m.ask.h < 56) fail(`${tag}: the composer is ${m.ask.h}px tall (spec §23: 56–64 px at least)`);
          // AT REST (empty, no context chips) it stays compact: §23's 56–64 px, with a pixel of rounding.
          if (z === 100 && m.askEmpty && !m.askChips && m.ask.h > 65) fail(`${tag}: the resting composer is ${m.ask.h}px tall (spec §23: 56–64 px)`);
          // THE ROUTE: the provider's mark (named), the model pill, on one row
          const lane = await d.js("JSON.stringify(LAIN.intel.sel('coding'))");
          const sel = JSON.parse(lane);
          if (!m.route.provider.includes(sel.familyLabel) || !m.route.model) fail(`${tag}: route ${JSON.stringify(m.route)} vs ${sel.familyLabel}`);
          if (!/Normal/.test(m.route.exec || '')) fail(`${tag}: execution reads "${m.route.exec}"`);
          if (!m.route.sameRow && !narrow) fail(`${tag}: Normal is not on the route's row`);
          // THE PANEL IS NARROWER THAN THE EDITOR
          if (m.panels.editor != null && m.panels.bot >= m.panels.editor) fail(`${tag}: the sidecar (${Math.round(m.panels.bot)}px) is not narrower than the editor (${Math.round(m.panels.editor)}px)`);
          if (m.overflow > 1) fail(`${tag}: the page overflows by ${m.overflow}px`);
          await d.shot(at(`sidecar-z${z}`));
        }
        await d.js('LAIN.appearance.set({ zoom: 100 })'); await sleep(700);
        await d.js("document.getElementById('main').classList.remove('show-bot')"); await sleep(300);   // the narrow layout's own toggle is not the wide layout's

        // ---- THE COMPOSER GROWS AS IT IS TYPED IN (real keystrokes) ---------------------------------------------------------------
        const before = await d.js("document.getElementById('ask').getBoundingClientRect().height");
        await R.click("document.getElementById('ask')");
        await R.type('Please also check what happens when an account is signed out while its request is running, and say so in the row. '.repeat(3));
        const grown = await d.js("document.getElementById('ask').getBoundingClientRect().height");
        if (!(grown > before + 20)) fail(`the composer did not grow (${before} → ${grown})`);
        await d.shot(at('sidecar-typing'));
        await d.js("(function(){var a=document.getElementById('ask');a.value='';a.dispatchEvent(new Event('input',{bubbles:true}));})()");

        // ---- EXECUTION: Normal · Fast · Eco — never Slow (the mode menu's segmented control) -------------------------------------------
        await R.click("document.querySelector('#ideBotHost [data-cell=exec]')");
        await d.until("!!document.querySelector('.modepop .u-seg')", 5000);
        const opts = await d.js("Array.from(document.querySelectorAll('.modepop .u-seg')[1].querySelectorAll('[data-seg]')).map((b) => b.textContent.trim())");
        assert.deepStrictEqual(opts, ['Normal', 'Fast', 'Eco'], 'no Slow');
        await d.js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
      } finally {
        if (saved === undefined) delete process.env.FAKE_CLAUDE_HOME; else process.env.FAKE_CLAUDE_HOME = saved;
        await d.close();
        try { await require('../../src/harnesslink').shutdown(d.app); } catch { /* nothing held */ }
        await fx.reset();
        try { fs.unlinkSync(store.file()); } catch { /* none */ } store.reset();
      }
    }
    assert.deepStrictEqual(problems, [], problems.join('\n'));
    if (process.env.LAIN_SHOTS_DIR) process.stdout.write(`    screenshots: ${shots}\n`);
  });
};
