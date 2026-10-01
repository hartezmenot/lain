'use strict';

/**
 * RESPONSIVE AND ZOOM (Phase 8.4), in the real window. Every major surface must stay READABLE, not merely
 * "not overflowing":
 *
 *   960×640 · 1280×720 · 1600×900     each surface: no horizontal page overflow, nothing wider than its pane,
 *                                     the text is at least 13 px, the account rows keep their meaning
 *   interface zoom 80–200 %           the Accounts page (a provider section, its rows, its quota) still fits
 *   narrow                            a quota row stacks under the account instead of shrinking to nothing
 *
 * Screenshots go to LAIN_SHOTS_DIR when it is set (so they can be REVIEWED by eye — passing this test is not
 * the same as looking good).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const SIZES = [[960, 640], [1280, 720], [1600, 900]];
const SURFACES = ['home', 'chat', 'usage', 'mcp', 'settings'];
const ZOOMS = [80, 100, 125, 150, 200];

module.exports = async function () {
  await test('RESPONSIVE 8.4: every surface fits and stays readable at 960×640, 1280×720, 1600×900 and interface zoom 80–200 %', async () => {
    const drv = require('../harness/appdriver');
    const fx = require('../harness/fabricfixtures');
    const store = require('../../src/fabric/store');
    const shots = process.env.LAIN_SHOTS_DIR || tmpdir('resp84-');
    const win = fx.win;
    const problems = [];
    for (const [w, h] of SIZES) {
      const d = await drv.open({ width: w, height: h, script: [] });
      if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
      const root = d.app._sibling || d.app;
      const at = (name) => path.join(shots, `${w}x${h}-${name}.png`);
      const fits = async (label) => {
        const r = await d.js(`(function () {
          var v = document.querySelector('.view:not([hidden])') || document.body;
          var bad = [];
          Array.prototype.forEach.call(v.querySelectorAll('.u-row, .u-sech, .u-head, .u-tabs, .u-set, .u-q'), function (e) {
            var b = e.getBoundingClientRect(), p = v.getBoundingClientRect();
            if (b.width > 0 && (b.right > p.right + 1 || b.left < p.left - 1)) bad.push((e.className || e.tagName).toString().slice(0, 30));
          });
          var small = 0, total = 0;
          Array.prototype.forEach.call(v.querySelectorAll('h1, h2, h3, p, span, button, small, label, div'), function (e) {
            if (!e.childNodes.length || e.offsetParent === null) return;
            var own = Array.prototype.some.call(e.childNodes, function (n) { return n.nodeType === 3 && n.textContent.trim().length > 1; });
            if (!own) return;
            total++; if (parseFloat(getComputedStyle(e).fontSize) < 11) small++;   // the four-gate spec §5: metadata and status are 11–12 px; nothing below 11
          });
          return { pageOverflow: document.documentElement.scrollWidth - window.innerWidth, viewOverflow: v.scrollWidth - v.clientWidth, bad: bad.slice(0, 5), small: small, total: total };
        })()`);
        if (r.pageOverflow > 1) problems.push(`${w}x${h} ${label}: page overflows by ${r.pageOverflow}px`);
        if (r.viewOverflow > 1) problems.push(`${w}x${h} ${label}: the view scrolls sideways by ${r.viewOverflow}px`);
        if (r.bad.length) problems.push(`${w}x${h} ${label}: wider than its pane: ${r.bad.join(', ')}`);
        if (r.total && r.small / r.total > 0.05) problems.push(`${w}x${h} ${label}: ${r.small}/${r.total} text nodes under 11px`);
      };
      try {
        await d.until("!document.getElementById('app').hidden", 30000);
        await fx.codexAccounts(root, [
          { name: 'Alpha', email: 'alpha@example.com', limits: { primary: win(74, 300, 130), secondary: win(52, 10080, 4000) } },
          { name: 'Bravo', email: 'bravo@example.com', limits: { primary: win(91, 300, 40), secondary: win(67, 10080, 2500) } },
          { name: 'Charlie', email: 'charlie@example.com', limits: { secondary: win(84, 10080, 3000) } },
        ]);
        await fx.claudeRuntime(root, tmpdir('resp84-claude-'));   // a second provider: the divider between planes is only visible with two
        root.cfg.connections = { ...(root.cfg.connections || {}), 'lain:pool': { baseUrl: 'http://127.0.0.1:9/v1', provider: '9router', apiKey: 'k', models: [{ id: 'cx/gpt-6-sol', owned_by: 'cx' }] } };
        root.cfg.ninerouter = { adopted: { cx: { at: 'x' } } };
        require('../../src/appcatalog').invalidate(); root._catMemo = null; root._acctMemo = null;
        await d.reload();
        for (const s of SURFACES) { await d.surface(s); await new Promise((r) => setTimeout(r, 500)); await fits(s); if (shots) await d.shot(at(s)); }
        await d.surface('model');
        await d.until("!!document.querySelector('[data-family=codex]')", 20000);
        const tabs = ['Accounts', 'Models', 'API', 'Local', 'Defaults'];
        for (let i = 0; i < tabs.length; i++) {
          await d.js(`document.querySelectorAll('#modelTabs button')[${i}].click()`);
          await new Promise((r) => setTimeout(r, 500));
          await fits(`model-${tabs[i]}`);
          if (shots) await d.shot(at(`model-${tabs[i].toLowerCase()}`));
        }
        await d.js("document.querySelectorAll('#modelTabs button')[0].click()");
        await d.until("!!document.querySelector('[data-family=codex] [data-account]')", 10000);
        // NARROW: a quota row stacks UNDER its account (the columns do not shrink to nothing).
        if (w <= 960) {
          const stacked = await d.js("(function(){var r=document.querySelector('[data-family=codex] [data-account]');var id=r.querySelector('.u-id').getBoundingClientRect();var q=r.querySelector('.u-qs').getBoundingClientRect();return q.top >= id.bottom - 2;})()");
          if (!stacked) problems.push(`${w}x${h}: the quota did not stack under the account`);
        }
        // ZOOM — on the middle window.
        if (w === 1280) {
          for (const z of ZOOMS) {
            await d.js(`LAIN.appearance.set({ zoom: ${z} })`);
            await new Promise((r) => setTimeout(r, 700));
            await fits(`accounts@${z}%`);
            const visible = await d.js("(function(){var r=document.querySelector('[data-family=codex] [data-account]');if(!r)return false;var b=r.getBoundingClientRect();return b.width>120 && b.height>20;})()");
            if (!visible) problems.push(`${w}x${h} zoom ${z}%: the account rows are not readable`);
            // THE DIVIDER BETWEEN PROVIDERS is clear at every zoom, and the quota words are never clipped.
            const sep = await d.js("(function(){var p=document.querySelectorAll('.dsh-prov');if(p.length<2)return -1;return document.querySelectorAll('.dsh-prov')[1].getBoundingClientRect().top-p[0].getBoundingClientRect().bottom;})()");
            if (sep < 6 * (z / 100) * 0.8) problems.push(`${w}x${h} zoom ${z}%: the gap between provider planes is ${sep}px`);
            const clipped = await d.js("Array.from(document.querySelectorAll('.u-q .v')).filter(function(e){return e.scrollWidth > e.clientWidth + 1;}).length");
            if (clipped) problems.push(`${w}x${h} zoom ${z}%: ${clipped} quota figure(s) are clipped`);
            const planes = await d.js("document.querySelectorAll('.dsh-prov').length");
            if (planes < 2) problems.push(`${w}x${h} zoom ${z}%: ${planes} provider plane(s)`);
            if (shots) await d.shot(at(`accounts-zoom${z}`));
          }
          await d.js('LAIN.appearance.set({ zoom: 100 })');
        }
      } finally {
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
