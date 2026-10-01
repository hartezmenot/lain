'use strict';

/**
 * CHAT ACCEPTANCE (Phase 8.2; the 2026-09-30 Chat) — a first visit, in the real window, real input:
 *
 *   · conversations live in the rail's Conversations room, with New conversation right there
 *   · the composer is centred on the conversation, sized for writing, and grows with what is written
 *   · with no model chosen the route says "Select model" — never a model under an unselected provider
 *   · the Coding Agent waits for a folder, and says so
 *   · a folder is attached (Create project — LAIN's own dialog) and it works
 *
 * (The 8.2 drawer, its one-time hint and the "Conversations" side button were replaced by the rail's room.)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

module.exports = async function () {
  await test('CHAT ACCEPTANCE: conversations in the rail, a centred growing composer, "Select model" with nothing chosen, the Coding Agent gated on a folder — then attached', async () => {
    const drv = require('../harness/appdriver');
    const d = await drv.open({ width: 1600, height: 900, script: [] });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const R = require('../harness/realinput')(d);
    const where = drv.tmp('chataccept-home-');
    try {
      await d.until("!document.getElementById('app').hidden");
      await d.surface('chat');

      // CONVERSATIONS LIVE IN THE RAIL — with New conversation right there.
      await d.until("!!document.getElementById('newChat') && document.getElementById('newChat').offsetParent !== null", 10000);
      assert.match(await d.js("document.getElementById('railRoom').innerText"), /Conversations/);
      const room = await d.js("(() => { const r = document.getElementById('railRoom').getBoundingClientRect(); return { left: r.left, w: r.width }; })()");
      assert.ok(room.w >= 180 && room.left < 40, `the room is in the rail: ${JSON.stringify(room)}`);
      await R.click("document.getElementById('newChat')");
      await d.until("/New conversation/.test(document.getElementById('chatTitle').textContent)", 10000);

      // THE COMPOSER: centred on the conversation, sized for writing, growing with what is written.
      const geo = await d.js("(() => { const b = document.getElementById('ask').closest('.box').getBoundingClientRect(); const h = document.getElementById('chatHost').getBoundingClientRect(); return { w: b.width, h: b.height, c: b.left + b.width / 2, hc: h.left + h.width / 2, hostW: h.width }; })()");
      assert.ok(geo.w >= 600 && geo.w <= 960, `a composer sized for writing, not a sliver in a canvas: ${JSON.stringify(geo)}`);
      assert.ok(Math.abs(geo.c - geo.hc) <= 24, `centred on the conversation: ${JSON.stringify(geo)}`);
      await R.click("document.getElementById('ask')");
      const oneLine = await d.js("document.getElementById('ask').getBoundingClientRect().height");
      await R.type('one');
      await R.key('Enter', { shift: true });
      await R.type('two');
      await R.key('Enter', { shift: true });
      await R.type('three');
      const grown = await d.js("document.getElementById('ask').getBoundingClientRect().height");
      assert.ok(grown >= oneLine + 20, `it grows with what is written: ${oneLine}px → ${grown}px for three lines`);
      await d.js("(() => { const a = document.getElementById('ask'); a.value = ''; a.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");

      // NOTHING CHOSEN (this profile has no account): the route says "Select model" — no provider mark, no effort,
      // never a model under an unselected provider (Phase 8.4.1). With one, the model sits next to it (modelaccept-real).
      const cells = await d.js("Array.from(document.querySelectorAll('#composerCells .cell')).map((x) => x.getAttribute('data-cell') + (x.classList.contains('need') ? ':need' : ''))");
      assert.deepStrictEqual(cells, ['model:need', 'exec'], `nothing selected: one "Select model" pill, and the mode icon: ${JSON.stringify(cells)}`);
      assert.strictEqual(await d.js("document.querySelector('#composerCells .cell.need .mt').textContent"), 'Select model');

      // THE CODING AGENT WAITS FOR A FOLDER — and says so.
      await d.until("document.getElementById('laneAgent').getAttribute('aria-disabled') === 'true'", 10000);
      await R.hover("document.getElementById('laneAgent')");
      await d.until("!!document.getElementById('laneTip') && /works in a project folder/.test(document.getElementById('laneTip').textContent)", 5000);
      await R.click("document.getElementById('laneAgent')");
      await d.until("!!document.querySelector('.pop') && /works in a project folder/i.test(document.querySelector('.pop').innerText)", 5000);
      assert.match(await d.js("document.querySelector('.pop').innerText"), /Choose a folder[\s\S]*Create project[\s\S]*Clone from GitHub/);

      // ATTACH A FOLDER: Create project, in LAIN's own dialog.
      await R.click(R.byText('.pop button, .pop .opt, .pop *', /^Create project/));
      await d.until("!!document.querySelector('.dlg') && document.querySelectorAll('.dlg input').length >= 2", 10000);
      await R.click("document.querySelectorAll('.dlg input')[0]");
      await R.key('a', { ctrl: true });
      await R.text('acc-shop');
      await R.click("document.querySelectorAll('.dlg input')[1]");
      await R.key('a', { ctrl: true });
      await R.text(where);
      await R.click(R.byText('.dlg button', 'Create'));
      await d.until("document.getElementById('laneAgent').getAttribute('aria-disabled') === 'false'", 20000);
      assert.ok(fs.existsSync(path.join(where, 'acc-shop')), 'the folder was made');
      assert.match(await d.js("document.getElementById('chatProj').innerText"), /acc-shop/);

      // THE CODING AGENT ENABLES.
      await R.click("document.getElementById('laneAgent')");
      await d.until("document.getElementById('laneAgent').getAttribute('aria-selected') === 'true'", 10000);
    } finally {
      await d.close();
      try { await require('../../src/harnesslink').shutdown(d.app); } catch { /* nothing held */ }
    }
  });
};
