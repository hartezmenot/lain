'use strict';

/**
 * PHASES A + C IN THE REAL WINDOW (2026-10-02), with real input through the renderer's own pipeline.
 *
 *   MODEL › Accounts   the grip drags C above A — the rows make room, settle, and Core's order is C, A, B; a keyboard
 *                      ↑ on a grip moves an account too; ⋯ › Disable account dims it in place and routing skips it
 *   MODEL › Models     Refresh models after the provider listed a new model: NEW beside it, the default unchanged
 *   CHAT               a turn's live activity ("Reading project…"), its answer, Copy (the clipboard gets clean text),
 *                      Edit on the latest message → Save & resend → the new wording answered, the old kept as a branch
 *
 * Fakes only: fake Codex app-server, the mock model. No real account, no quota.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('../helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function () {
  await test('PHASE A: drag priority, keyboard priority, disable in place, Refresh models → NEW — real input', async () => {
    const drv = require('../harness/appdriver');
    const d = await drv.open({ width: 1440, height: 900, script: [] });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const R = require('../harness/realinput')(d);
    const C = d.page.conn;
    const root = d.app._sibling || d.app;
    const fx = require('../harness/fabricfixtures');
    const store = require('../../src/fabric/store');
    const ai = require('../../src/accountinstances');
    const row = (id, label) => ({ id, model: id, displayName: label, hidden: false, isDefault: id === 'model-a', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }] });
    try {
      await d.until("!document.getElementById('app').hidden", 30000);
      // A CATALOG FROM EARLIER TESTS IN THIS HOME would make A and B news too: this test starts from none.
      { const MC = require('../../src/modelcatalog'); try { fs.unlinkSync(MC.file()); } catch { /* none */ } MC._reset(); }
      const [A, B, Cc] = await fx.codexAccounts(root, [
        { name: 'Alpha', email: 'alpha@example.com', models: [row('model-a', 'Model A'), row('model-b', 'Model B')] },
        { name: 'Bravo', email: 'bravo@example.com', models: [row('model-a', 'Model A'), row('model-b', 'Model B')] },
        { name: 'Charlie', email: 'charlie@example.com', models: [row('model-a', 'Model A'), row('model-b', 'Model B')] },
      ]);
      require('../../src/appcatalog').invalidate(); root._acctMemo = null; root._catMemo = null; root._fabricMemo = null;
      await d.reload();
      await d.surface('model');
      await d.until("!!document.querySelector('[data-family-rows=codex]') && document.querySelectorAll('[data-family-rows=codex] .u-row').length === 3", 20000);
      const order = () => d.js("Array.from(document.querySelectorAll('[data-family-rows=codex] .u-row')).map((r) => r.getAttribute('data-account'))");
      assert.deepStrictEqual(await order(), [A.id, B.id, Cc.id]);

      // ---- DRAG C ABOVE A: press the grip, move in steps, release ---------------------------------------------
      const grip = await R.at(`document.querySelector('[data-grip="${Cc.id}"]')`);
      const top = await R.at(`document.querySelector('[data-account="${A.id}"]')`);
      assert.ok(grip && top);
      await R.hover(`document.querySelector('[data-account="${Cc.id}"]')`);
      await C.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y });
      await C.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', buttons: 1, clickCount: 1 });
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await C.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y + ((top.y - 12) - grip.y) * (i / steps), button: 'left', buttons: 1 });
        await sleep(16);
      }
      assert.strictEqual(await d.js("!!document.querySelector('[data-family-rows=codex] .u-row.lift')"), true, 'the row is lifted while it moves');
      const t0 = Date.now();
      await C.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x, y: top.y - 12, button: 'left', buttons: 0, clickCount: 1 });
      await d.until(`(() => { const o = Array.from(document.querySelectorAll('[data-family-rows=codex] .u-row')).map((r) => r.getAttribute('data-account')); return o[0] === ${JSON.stringify(Cc.id)}; })()`, 5000);
      const settleMs = Date.now() - t0;
      assert.deepStrictEqual(await order(), [Cc.id, A.id, B.id]);
      let core = [];
      for (let i = 0; i < 50; i++) { store.reset(); core = store.familyState('codex').order; if (core[0] === Cc.id) break; await sleep(40); }
      assert.deepStrictEqual(core, [Cc.id, A.id, B.id], 'the order is Core state');
      assert.ok(settleMs < 1500, `settled in ${settleMs} ms`);
      assert.strictEqual(await d.js("document.querySelectorAll('[data-family-rows=codex] .u-row[style*=transform]').length"), 0, 'no row is left displaced');

      // ---- KEYBOARD: ↑ on Bravo's grip moves it above Alpha -----------------------------------------------------
      await d.js(`document.querySelector('[data-grip="${B.id}"]').focus()`);
      await R.key('ArrowUp');
      await d.until(`(() => { const o = Array.from(document.querySelectorAll('[data-family-rows=codex] .u-row')).map((r) => r.getAttribute('data-account')); return o[1] === ${JSON.stringify(B.id)}; })()`, 5000);
      store.reset();
      assert.deepStrictEqual(store.familyState('codex').order, [Cc.id, B.id, A.id]);

      // ---- DISABLE C FROM ITS MENU: dimmed, still first; routing skips it -----------------------------------------
      await R.click(`document.querySelector('[data-account="${Cc.id}"] button.u-ib[aria-label^="More"]')`);
      await d.until("!!document.querySelector('.pop')", 5000);
      await R.click(R.byText('.pop button', /^Disable account/));
      await d.until(`document.querySelector('[data-account="${Cc.id}"]') && document.querySelector('[data-account="${Cc.id}"]').getAttribute('data-enabled') === 'false'`, 8000);
      assert.deepStrictEqual(await order(), [Cc.id, B.id, A.id], 'it keeps its place');
      assert.match(await d.js(`document.querySelector('[data-account="${Cc.id}"] .u-st').textContent`), /Disabled/);
      root._fabricMemo = null;
      const F = require('../../src/fabric/index');
      const mid = F.family(root, 'codex').models.find((m) => /model-a/.test(m.id)).id;
      assert.deepStrictEqual(F.eligible(root, 'codex', mid).map((x) => x.account.id), [B.id, A.id], 'routing skips the disabled account');

      // ---- REFRESH MODELS after the provider listed Model C: NEW, nothing selected ----------------------------------
      const defaultBefore = root.cfg.model;
      for (const x of [A, B, Cc]) fs.writeFileSync(path.join(ai.handle(root, x.id).layout.home, 'fake-models.json'), JSON.stringify([row('model-a', 'Model A'), row('model-b', 'Model B'), row('model-c', 'Model C')]));
      await R.click(`document.querySelector('[data-refresh-models="codex"]')`);
      await d.surface('model');
      await d.js("(window.LAIN.modelView && window.LAIN.modelView.go) ? window.LAIN.modelView.go('models') : window.LAIN.nav.go('model', { section: 'models' })");
      await d.until("Array.from(document.querySelectorAll('[data-models] [data-new=\"1\"]')).some((r) => /Model C/.test(r.innerText))", 20000);
      assert.deepStrictEqual(await d.js("Array.from(document.querySelectorAll('[data-models] [data-new=\"1\"]')).map((r) => r.innerText.split('\\n')[0])"), ['Model C'], 'only the new model is NEW');
      assert.strictEqual(root.cfg.model, defaultBefore, 'the default did not move');
    } finally { await d.close(); await fx.reset(); }
  });

  await test('PHASE C: Chat shows the work as it happens, streams the answer, Copy is clean, Edit & resend branches — real input', async () => {
    const drv = require('../harness/appdriver');
    const d = await drv.open({ width: 1440, height: 900, script: [
      { text: 'Let me look.', tool_calls: [{ name: 'list_dir', input: { path: '.' } }], delayMs: 300 },
      { text: 'Here is **the answer**.\n\n```js\nconst red = 1;\n```', delayMs: 400 },
      { text: 'Blue it is.', delayMs: 200 },
    ] });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const R = require('../harness/realinput')(d);
    const root = d.app._sibling || d.app;
    try {
      await d.until("!document.getElementById('app').hidden", 30000);
      await d.surface('chat');
      await d.until("!!document.getElementById('ask') && document.getElementById('ask').offsetParent !== null", 10000);
      // THE LIVE AREA appears and says something factual (never "job_wait", never stacked "Thinking").
      await d.js(`(() => { window.__seen = []; const t = setInterval(() => { const w = document.querySelector('[data-live=work]'); if (w) window.__seen.push(w.innerText.trim()); const x = document.querySelector('[data-live=text]'); if (x) window.__seen.push('TEXT:' + x.innerText.trim()); }, 30); window.__stopSeen = () => clearInterval(t); return true; })()`);
      await R.click("document.getElementById('ask')");
      await R.type('Change button to red');
      await R.key('Enter');
      // THE FOLDER IS NOT TRUSTED YET: the turn asks (askCard) and the live area keeps saying what it is doing.
      await d.until("!document.getElementById('askCard').hidden && /Allow just this one/.test(document.getElementById('askCard').innerText)", 20000);
      assert.match(await d.js("(document.querySelector('[data-live=work]') || {}).innerText || ''"), /Reading project|Thinking|Working/);
      await R.click(R.byText('#askCard button', /Allow just this one/));
      await d.until("Array.from(document.querySelectorAll('#stream .msg.assistant')).some((m) => /the answer/.test(m.innerText))", 30000);
      await d.js('window.__stopSeen()');
      const seen = await d.js('window.__seen');
      assert.ok(seen.some((s) => /Thinking|Reading project|Working/.test(s)), `a factual work line: ${JSON.stringify(seen.slice(0, 12))}`);
      assert.ok(!seen.some((s) => /job_wait/.test(s)), 'no tool machinery words');
      // THE ANSWER: prose and a real code block.
      assert.strictEqual(await d.js("!!document.querySelector('#stream .msg.assistant strong')"), true, 'bold is bold, not asterisks');
      assert.match(await d.js("document.querySelector('#stream .cb .lang').textContent"), /js/);
      // COPY: the clipboard gets clean text.
      let copied = null;
      const clip = require('../../src/harnessapp/routes').ROUTES['POST /api/clipboard/write'];
      if (clip) {
        const ROUTES = require('../../src/harnessapp/routes').ROUTES;
        ROUTES['POST /api/clipboard/write'] = async (app, body) => { copied = body.text; return { code: 200, body: { ok: true } }; };
        try {
          await R.hover("Array.from(document.querySelectorAll('#stream .msg.assistant')).pop()");
          await R.click("Array.from(document.querySelectorAll('#stream .msg.assistant')).pop().querySelector('[data-act=copy]')");
          await d.until("/Copied/.test(Array.from(document.querySelectorAll('#stream .msg.assistant')).pop().querySelector('[data-act=copy]').innerText)", 5000);
          assert.ok(copied && /the answer/.test(copied) && !/<strong>/.test(copied), `clean text: ${copied}`);
          await R.click("document.querySelector('#stream .cb [data-act=copy-code]')");
          await sleep(300);
          assert.strictEqual(copied, 'const red = 1;');
        } finally { ROUTES['POST /api/clipboard/write'] = clip; }
      }
      // EDIT the latest user message → Save & resend.
      await R.hover("Array.from(document.querySelectorAll('#stream .msg.user')).pop()");
      await R.click("Array.from(document.querySelectorAll('#stream .msg.user')).pop().querySelector('[data-act=edit]')");
      await d.until("!!document.querySelector('.medit textarea')", 5000);
      await d.js("(() => { const t = document.querySelector('.medit textarea'); t.value = 'Change button to blue'; return true; })()");
      await R.click("document.querySelector('[data-act=save-resend]')");
      await d.until("Array.from(document.querySelectorAll('#stream .msg.assistant')).some((m) => /Blue it is/.test(m.innerText))", 30000);
      const users = await d.js("Array.from(document.querySelectorAll('#stream .msg.user')).map((m) => m.querySelector('.body').innerText.trim())");
      assert.ok(users.includes('Change button to blue') && !users.includes('Change button to red'), JSON.stringify(users));
      const b = require('../../src/workbench').of(root.session).branches || [];
      assert.ok(b.some((x) => x.replaced === 'Change button to red'), 'the old wording is kept as a branch');
      assert.ok(!(root.session.turns || []).some((t) => t.userInput === 'Change button to red'), 'no live turn record claims the red request');
    } finally { await d.close(); }
  });
};
