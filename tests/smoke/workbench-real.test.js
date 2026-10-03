'use strict';

/**
 * THE PALETTE WORKBENCH, DRIVEN THROUGH THE REAL WINDOW (Phase 8).
 *
 * Native host + WebView2, the mock model, an isolated profile
 * (tests/harness/appdriver.js). Walks what a person sees and presses:
 *
 *   six rooms (BOT and SESSION are not tabs) → Ctrl + / Ctrl 0 scales the whole
 *   window and Core keeps it → a palette card and Light mode, independent →
 *   the JetBrains keymap answers Ctrl+Shift+A with the command palette, and the
 *   keymap page names its chords → Agent Instructions: write, save, and a Reset
 *   that shows its diff and does nothing when cancelled → Feedback cannot be
 *   submitted before Review → USAGE opens on provider windows → no surface
 *   bleeds past the window at 960×640, 1280×720, 1600×900, 1280×720@150%, or at
 *   interface scale 80 and 200.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

module.exports = async function () {
  await test('WORKBENCH REAL UI: seven rooms, the app panel, zoom, palettes, keymap presets, Agent Instructions, feedback review, usage windows, responsive', async () => {
    const drv = require('../harness/appdriver');
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-workbench-'));
    fs.writeFileSync(path.join(proj, 'a.js'), 'module.exports = 1;\n');
    const agentsHomeWas = process.env.LAIN_AGENTS_HOME;
    process.env.LAIN_AGENTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-agents-home-'));
    const restore = () => { if (agentsHomeWas === undefined) delete process.env.LAIN_AGENTS_HOME; else process.env.LAIN_AGENTS_HOME = agentsHomeWas; };
    const d = await drv.open({ cwd: proj, script: [], width: 1400, height: 880 });
    if (d.skipped) { restore(); process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const errors = [];
    await d.page.conn.send('Runtime.enable');
    d.page.conn.on((m, p) => { if (m === 'Runtime.exceptionThrown') errors.push(JSON.stringify(p.exceptionDetails).slice(0, 300)); });
    const core = async (route, body) => (await require('../../src/harnessapp/routes').ROUTES[`POST ${route}`](d.app, body || {})).body;
    const chord = async (key, code, vk, { ctrl = true, shift = false, alt = false } = {}) => {
      const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
      await d.page.conn.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
      await d.page.conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
    };
    try {
      await d.until("!document.getElementById('app').hidden && !!LAIN.appearance.get()", 30000);

      // SIX ROOMS.
      const tabs = await d.js("Array.from(document.querySelectorAll('#tabs .gtab')).map((n) => n.dataset.tab).join('|')");
      assert.strictEqual(tabs, 'home|ide|chat|model|usage|mcp|settings');

      // CTRL + / CTRL 0: the whole window, remembered by Core.
      await d.js("document.body.focus(); true");
      await chord('=', 'Equal', 187);
      await d.until('LAIN.appearance.get().zoom === 110', 5000);
      assert.strictEqual((await core('/api/appearance')).ui.zoom, 110, 'Core keeps the interface scale');
      await chord('0', 'Digit0', 48);
      await d.until('LAIN.appearance.get().zoom === 100', 5000);

      // A PALETTE CARD, then Light — two independent choices.
      await d.js("LAIN.nav.go('settings', { section: 'appearance' })");
      await d.until("!!document.querySelector('.palc[data-palette=violet]')", 10000);
      await d.click('.palc[data-palette=violet]');
      await d.until("document.documentElement.dataset.palette === 'violet'", 5000);
      await d.click('[data-select=set-mode]');                                        // Theme: one control that opens a menu
      await d.until("!!document.querySelector('.u-menu')", 5000);
      await d.js("Array.from(document.querySelectorAll('.u-menu .opt')).find((b) => /Light/.test(b.textContent)).click()");
      await d.until("document.documentElement.dataset.mode === 'light' && document.documentElement.dataset.palette === 'violet'", 5000);
      const ui = (await core('/api/appearance')).ui;
      assert.deepStrictEqual([ui.palette, ui.mode], ['violet', 'light']);
      const bg = await d.js("getComputedStyle(document.body).backgroundImage");
      assert.strictEqual(bg, 'none', 'no gradient behind the workbench');

      // KEYMAP PRESET: JetBrains' Ctrl+Shift+A is the command palette; the page names the chords.
      await d.js("LAIN.appearance.set({ keymap: 'jetbrains' })");
      await d.until("LAIN.appearance.get().keymap === 'jetbrains'", 5000);
      await d.js("LAIN.nav.go('home'); document.activeElement && document.activeElement.blur(); true");
      await chord('A', 'KeyA', 65, { shift: true });
      await d.until("!document.getElementById('palette').hidden && document.getElementById('paletteQ').value === '>'", 5000);
      await d.press('Escape', '#paletteQ');
      await d.js("LAIN.nav.go('settings', { section: 'keymap' })");
      await d.until("!!document.querySelector('.kmtable tr[data-cmd=\"editor.rename\"]')", 5000);
      assert.strictEqual(await d.js("document.querySelector('.kmtable tr[data-cmd=\"editor.rename\"] kbd').textContent"), 'Shift+F6');
      assert.strictEqual((await core('/api/appearance')).ui.theme, 'lain', 'the theme preset did not move with the keymap');
      await d.js("LAIN.appearance.set({ keymap: 'lain' })");

      // NAVIGATION (2026-09-30, "one application navigation system"): the rail beside every surface but the IDE, in the
      // one width the person chose — Compact everywhere, or Expanded everywhere (and compact on its own when the window is
      // narrow). The IDE has its own activity bar and the small LAIN mark. Never a second tab row.
      const railW = () => d.js("(() => { const r = document.getElementById('rail'); return r.offsetParent !== null ? Math.round(r.getBoundingClientRect().width) : 0; })()");
      const menusShown = () => d.js("document.getElementById('menus').offsetParent !== null");
      await d.js("LAIN.appearance.set({ nav: 'compact' })");
      await d.until("document.documentElement.dataset.nav === 'compact'", 5000);
      for (const t of ['home', 'chat', 'model', 'usage', 'mcp', 'settings']) {
        await d.js(`LAIN.nav.go('${t}')`);
        const w = await railW();
        assert.ok(w > 0 && w <= 80, `${t}: the compact panel (${w}px) — a way out, never stranded`);
        assert.ok(!(await menusShown()), `${t}: no File / Edit / View / Help`);
        assert.ok(await d.js("document.getElementById('surfBtn').offsetParent === null"), `${t}: no second switcher beside the panel`);
      }
      await d.js("LAIN.nav.go('ide')");
      assert.strictEqual(await railW(), 0, 'the IDE: no app panel beside its activity bar');
      assert.ok(await menusShown(), 'the IDE has its menubar');
      assert.ok(await d.js("document.getElementById('surfBtn').offsetParent !== null"), 'the IDE: the small LAIN mark leads out');
      await d.js("LAIN.appearance.set({ nav: 'expanded' })");
      await d.until("document.documentElement.dataset.nav === 'expanded'", 5000);
      await d.js("LAIN.nav.go('chat')"); assert.ok((await railW()) >= 150, 'Expanded: names beside the icons on Chat');
      assert.strictEqual(await d.js("document.querySelectorAll('.gtab').length"), 7, 'one set of tabs — no second row');
      await d.js("LAIN.appearance.set({ nav: 'compact' })");
      await d.until("document.documentElement.dataset.nav === 'compact'", 5000);
      const back = await railW();
      assert.ok(back > 0 && back <= 80, 'Compact again');
      assert.strictEqual((await core('/api/appearance')).ui.nav, 'compact', 'Core keeps the choice');

      // AGENT INSTRUCTIONS: write and save; Reset shows its diff and a cancel changes nothing.
      await d.js("LAIN.nav.go('settings', { section: 'agents' })");
      await d.until("Array.from(document.querySelectorAll('.ag-bar button')).some((b) => b.textContent === 'Write one')", 10000);
      await d.js("Array.from(document.querySelectorAll('.ag-bar button')).find((b) => b.textContent === 'Write one').click()");
      await d.until("!!document.querySelector('.ag-body textarea')");
      await d.type('.ag-body textarea', '# Mine\n- keep diffs small\n');
      await d.js("Array.from(document.querySelectorAll('.ag-bar button')).find((b) => b.textContent === 'Save').click()");
      await d.until("/keep diffs small/.test((document.querySelector('.ag-body pre') || {}).textContent || '')", 10000);
      const saved = await core('/api/agents/read', { scope: 'global' });
      assert.ok(saved.file.exists && /keep diffs small/.test(saved.file.text));
      await d.js("Array.from(document.querySelectorAll('.ag-bar button')).find((b) => b.textContent === 'Reset to default').click()");
      await d.until("!!document.querySelector('.diffv .del')", 10000);
      assert.ok(/keep diffs small/.test(await d.js("document.querySelector('.diffv').innerText")), 'the diff names what would be replaced');
      await d.js("Array.from(document.querySelectorAll('.dlg-actions button')).find((b) => b.textContent === 'Cancel').click()");
      assert.ok(/keep diffs small/.test((await core('/api/agents/read', { scope: 'global' })).file.text), 'a cancelled reset writes nothing');

      // FEEDBACK: Submit waits for Review; nothing is attached until ticked.
      await d.js('LAIN.feedback.open()');
      await d.until("!!document.querySelector('.fbkdlg')");
      assert.ok(await d.js("Array.from(document.querySelectorAll('.fbkdlg .row button')).find((b) => b.textContent === 'Submit').disabled"), 'Submit before Review is not possible');
      assert.ok(await d.js("Array.from(document.querySelectorAll('.fbkdlg [data-attach]')).every((c) => !c.checked)"), 'every attachment starts unticked');
      await d.js("Array.from(document.querySelectorAll('.fbkdlg .row button')).find((b) => b.textContent === 'Cancel').click()");

      // USAGE OPENS ON THE OVERVIEW — overall first (spec §49), the provider windows a plane of it; Windows is one tab away.
      await d.js("LAIN.nav.go('usage')");
      await d.until("document.querySelector('#usageNav [data-usage=overview]').getAttribute('aria-selected') === 'true' && !!document.querySelector('.uplane.u-wins')", 10000);
      await d.js("document.querySelector('#usageNav [data-usage=windows]').click()");
      await d.until("document.querySelector('#usageNav [data-usage=windows]').getAttribute('aria-selected') === 'true'", 10000);

      // RESPONSIVE: no room bleeds past the window.
      await d.js("LAIN.appearance.set({ mode: 'dark', palette: 'lain' })");
      const sweep = async (w, h, dpr, zoom) => {
        await d.page.conn.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
        await d.js(`LAIN.appearance.set({ zoom: ${zoom} })`);
        for (const t of ['home', 'ide', 'chat', 'model', 'usage', 'mcp', 'settings']) {
          await d.js(`LAIN.nav.go('${t}')`);
          await new Promise((r) => setTimeout(r, 350));
          const bleed = await d.js('document.documentElement.scrollWidth - window.innerWidth');
          assert.ok(bleed <= 1, `${t} at ${w}x${h}@${dpr} scale ${zoom}% bleeds ${bleed}px`);
        }
      };
      for (const [w, h, dpr, z] of [[960, 640, 1, 100], [1280, 720, 1, 100], [1600, 900, 1, 100], [1280, 720, 1.5, 100], [1280, 720, 1, 80], [1280, 720, 1, 200]]) await sweep(w, h, dpr, z);
      await d.js('LAIN.appearance.set({ zoom: 100 })');
      assert.deepStrictEqual(errors, [], 'the page threw nothing');
    } finally {
      restore();
      await d.close();
    }
  });
};
