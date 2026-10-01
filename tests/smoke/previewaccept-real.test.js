'use strict';

/**
 * PREVIEW ACCEPTANCE (Phase 8.2; the 2026-09-30 live renderer) — without talking to Chat or the Agent first, in the
 * real window, with real mouse and keyboard:
 *
 *    1 open the project in the IDE        9 the page gets no mouse button, no drag, no copy
 *    2 click Preview                     10 type "make this wider"
 *    3 the preview starts                11 the Coding Agent's narrow change runs (policy asks, a person allows)
 *    4 interact normally (type in it)    12 Escape leaves Pick
 *    5 navigate Home → Settings          13 normal interaction returns
 *    6 click Pick element                14 detach the Preview
 *    7 hover highlights                  15 select and change again, in the detached window
 *    8 click selects
 *
 * The page's own side is read too (tests/harness/previewframe.js — its out-of-process frame): what was typed, where
 * it navigated, that Pick gave it no mouse button and no drag, and that the highlight is drawn on it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-prevacc-'));
  const port = 5700 + Math.floor(Math.random() * 300);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop', private: true, scripts: { dev: `node server.js --port ${port}` } }, null, 2));
  fs.writeFileSync(path.join(dir, 'server.js'), [
    'const http=require("http"),fs=require("fs"),path=require("path");',
    'const a=process.argv.indexOf("--port");const port=Number(process.env.PORT)||Number(a>0?process.argv[a+1]:0)||0;',
    'http.createServer((q,s)=>{const f=q.url==="/"?"index.html":q.url.replace(/^\\//,"").split("?")[0];',
    'const p=path.join(__dirname,f);if(!fs.existsSync(p)){s.writeHead(404);return s.end("no");}',
    's.writeHead(200,{"content-type":f.endsWith(".css")?"text/css":"text/html","cache-control":"no-store"});s.end(fs.readFileSync(p));',
    '}).listen(port,"127.0.0.1");',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Home</title><link rel="stylesheet" href="home.css"></head><body><h1>Home</h1><p><label>Search <input id="q"></label></p><div class="row"><button id="pay" class="pay">Pay now</button></div><p><a id="toSettings" href="/settings.html">Settings</a></p></body></html>\n');
  fs.writeFileSync(path.join(dir, 'settings.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Settings</title><link rel="stylesheet" href="settings.css"></head><body><h1 class="title" id="title">Settings</h1><p>Some text a drag would select.</p><p><a id="toHome" href="/index.html">Home</a></p></body></html>\n');
  fs.writeFileSync(path.join(dir, 'home.css'), 'body{margin:0;font-family:system-ui}\n.row{margin-top:20px}\n.pay{padding:10px 18px;width:120px}\n');
  fs.writeFileSync(path.join(dir, 'settings.css'), 'body{margin:0;font-family:system-ui}\n.title{font-size:28px;width:200px}\n');
  return dir;
}

module.exports = async function () {
  await test('PREVIEW ACCEPTANCE: open, interact, navigate, Pick (hover, select, no drag), say, the change, Escape, interact again, detach and repeat — real input', async () => {
    const drv = require('../harness/appdriver');
    const dir = project();
    const d = await drv.open({
      cwd: dir, width: 1600, height: 900,
      script: [
        { text: 'Reading what owns the Settings heading.', tool_calls: [{ name: 'read_file', input: { path: 'settings.css' } }] },
        { text: 'Widening the heading.', tool_calls: [{ name: 'write_file', input: { path: 'settings.css', content: 'body{margin:0;font-family:system-ui}\n.title{font-size:28px;width:360px}\n' } }] },
        { text: 'The Settings heading is wider.' },
        { text: 'Reading what owns the Pay button.', tool_calls: [{ name: 'read_file', input: { path: 'home.css' } }] },
        { text: 'Widening the Pay button.', tool_calls: [{ name: 'write_file', input: { path: 'home.css', content: 'body{margin:0;font-family:system-ui}\n.row{margin-top:20px}\n.pay{padding:10px 18px;width:200px}\n' } }] },
        { text: 'The Pay button is wider.' },
        { text: 'Done.' }, { text: 'Done.' }, { text: 'Done.' },
      ],
    });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const R = require('../harness/realinput')(d);
    const answerAsks = async (until, ms = 90000) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !(await d.js(until))) {
        const card = await d.js("(() => { const c = document.getElementById('askCard'); return c && !c.hidden ? c.innerText : null; })()");
        if (card) { await R.click("document.querySelector('#askCard button.primary')"); } else await R.pause(200);
      }
      return d.js(until);
    };
    let second = null;
    try {
      // 1 THE PROJECT IN THE IDE.
      await d.until("!document.getElementById('app').hidden");
      await d.surface('ide');
      await d.until("!document.getElementById('main').hidden && document.querySelectorAll('#srcTree .srcRow').length > 0", 30000);
      const sessionId = await d.js('LAIN.state().current.id');

      // 2 CLICK PREVIEW (the editor toolbar's Preview action — no Agent involved) → 3 IT STARTS, LIVE.
      await d.until("!!document.getElementById('previewBtn') && !document.getElementById('previewBtn').disabled", 20000);
      await R.click("document.getElementById('previewBtn')");
      await d.until("LAIN.workshop.isOpen() && document.getElementById('wsWait').hidden", 120000);
      assert.strictEqual(d.app.session.turns.length, 0, 'the Agent was not needed to open it');
      const pf = await require('../harness/previewframe')(d);
      await pf.settled();

      // 4 INTERACT NORMALLY: click into the page's search field and type — the page itself receives it.
      await pf.eval("window.__ev = []; ['pointerdown', 'focusin', 'focusout', 'keydown'].forEach((t) => window.addEventListener(t, (e) => window.__ev.push(t + '@' + Math.round(performance.now()) + ':' + ((e.target && e.target.id) || (e.target && e.target.tagName)) + (e.key ? ':' + e.key : '')), true)); true");
      const qAt = await pf.point('#q');
      await R.clickAt(qAt);
      await R.pause(400);
      await R.type('shoes', { gap: 40 });
      const end4 = Date.now() + 10000;
      while (Date.now() < end4 && (await pf.eval("document.getElementById('q') && document.getElementById('q').value")) !== 'shoes') await R.pause(200);
      const typed = await pf.eval("document.getElementById('q').value");
      if (typed !== 'shoes') {
        const why = { at: qAt, top: await d.js(`(() => { const e = document.elementFromPoint(${qAt.x}, ${qAt.y}); const c = e && e.closest && e.closest('[id]'); return c ? c.id : e && e.tagName; })()`), page: await pf.eval('window.__ev'), state: await d.js('LAIN.workshop.state()'), active: await d.js('document.activeElement && (document.activeElement.id || document.activeElement.tagName)') };
        assert.fail(`typed into the page itself: got ${JSON.stringify(typed)} — ${JSON.stringify(why)}`);
      }

      // 5 NAVIGATE Home → Settings by clicking the page's own link.
      await R.clickAt(await pf.point('#toSettings'));
      const end5 = Date.now() + 20000;
      while (Date.now() < end5 && String(await pf.eval('location.pathname').catch(() => '')) !== '/settings.html') await R.pause(200);
      assert.strictEqual(await pf.eval('location.pathname'), '/settings.html', 'the page navigated');
      await d.until("/settings\\.html/.test(document.getElementById('wsUrl').value)", 10000);

      // 6 PICK ELEMENT → 7 HOVER HIGHLIGHTS (the bridge's outline, drawn on the page).
      assert.strictEqual(await pf.eval("(() => { window.__acc = { down: 0, drag: 0 }; document.addEventListener('mousedown', () => { window.__acc.down++; }, true); document.addEventListener('dragstart', () => { window.__acc.drag++; }, true); return true; })()"), true);
      await d.js("window.__hacc = { drag: 0 }; document.addEventListener('dragstart', () => { window.__hacc.drag++; }, true); window.__pk = []; ['mousedown', 'click'].forEach((t) => document.addEventListener(t, (e) => window.__pk.push(t + ':' + ((e.target && e.target.closest && e.target.closest('[id]') && e.target.closest('[id]').id) || (e.target && e.target.tagName))), true)); true");
      await R.click("document.getElementById('wsPick')");
      await d.until("document.getElementById('wsPick').getAttribute('aria-pressed') === 'true'", 10000).catch(async (e) => {
        throw new Error(`${e.message} — ${JSON.stringify(await d.js("(() => { const b = document.getElementById('wsPick').getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const t = document.elementFromPoint(x, y); const c = t && t.closest && t.closest('[id]'); return { at: [x, y], top: c ? c.id : t && t.tagName, events: window.__pk, pressed: document.getElementById('wsPick').getAttribute('aria-pressed'), open: LAIN.workshop.isOpen() }; })()"))}`);
      });
      const tp = await pf.point('#title');
      await d.page.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tp.x - 3, y: tp.y });
      await d.page.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tp.x, y: tp.y });
      const endH = Date.now() + 10000;
      let hov = null;
      while (Date.now() < endH && !(hov = await pf.eval("(() => { const b = window.__lainPickerBox; const h = b && b.querySelector('div'); if (!b) return null; const shown = Array.from(b.children).filter((c) => getComputedStyle(c).display !== 'none'); return shown.length ? shown.map((c) => { const r = c.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, text: c.textContent }; }) : null; })()"))) await R.pause(150);
      assert.ok(hov && hov.length, 'the hover outline is drawn on the page');
      const th = await pf.rect('#title');
      assert.ok(hov.some((o) => o.l <= th.x + 2 && o.r >= th.x + th.w - 2 && o.t <= th.y + 2 && o.b >= th.y + th.h - 2), `the outline is on the heading: ${JSON.stringify({ th, hov })}`);

      // 9 NO BUTTON, NO DRAG, NO COPY IN THE PAGE: press on the heading, drag across the text, release.
      const para = await pf.point('p', 0.9, 0.5);
      await d.page.conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tp.x, y: tp.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 6; i++) await d.page.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tp.x + (para.x - tp.x) * i / 6, y: tp.y + (para.y - tp.y) * i / 6, button: 'left', buttons: 1 });
      await d.page.conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: para.x, y: para.y, button: 'left', clickCount: 1 });
      await R.pause(600);
      assert.strictEqual(await d.js('String(window.getSelection())'), '', 'nothing selected in Noema');
      assert.strictEqual(await d.js('window.__hacc.drag'), 0, 'no drag started in Noema');
      assert.deepStrictEqual(await pf.eval('window.__acc'), { down: 0, drag: 0 }, 'Pick is read-only: the page got no mouse button and no drag');
      assert.strictEqual(await pf.eval('String(window.getSelection())'), '', 'nothing selected in the page');

      // THE DRAG'S RELEASE CHOSE THE REGION'S OWNER (Pick is one-shot) — waited for, not raced: the bridge says so by message.
      await d.until("/^Selected: /.test(document.getElementById('wsScope').textContent) && document.getElementById('wsPick').getAttribute('aria-pressed') !== 'true'", 10000);
      // 8 CLICK SELECTS — Pick again, and a click on the heading chooses it.
      await d.js("window.__pk = []; true");
      await R.click("document.getElementById('wsPick')");
      await d.until("document.getElementById('wsPick').getAttribute('aria-pressed') === 'true'", 5000).catch(async (e) => {
        throw new Error(`${e.message} (re-arm) — ${JSON.stringify(await d.js("(() => { const b = document.getElementById('wsPick').getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const t = document.elementFromPoint(x, y); const c = t && t.closest && t.closest('[id]'); return { at: [x, y], top: c ? c.id : t && t.tagName, events: window.__pk, active: document.activeElement && document.activeElement.id }; })()"))}`);
      });
      await R.clickAt(await pf.point('#title'));
      await d.until("/^Selected: /.test(document.getElementById('wsScope').textContent) && document.getElementById('wsPick').getAttribute('aria-pressed') !== 'true'", 20000);
      assert.match(await d.js("document.getElementById('wsScope').textContent"), /h1|title|Settings/i);
      assert.ok(await d.js("!document.getElementById('pvInsp').hidden"), 'the inspector shows the selection');

      // 10 TYPE "make this wider" (the preview's own input has the focus) → 11 THE NARROW CHANGE.
      await d.until("document.activeElement === document.getElementById('wsSayIn')", 5000);
      await R.text('make this wider');
      await R.key('Enter');
      assert.ok(await answerAsks("document.getElementById('stream') && LAIN.state().conversation.some((m) => m.role !== 'user' && /The Settings heading is wider/.test(m.text))"), 'the Coding Agent answered');
      assert.match(fs.readFileSync(path.join(dir, 'settings.css'), 'utf8'), /\.title\{font-size:28px;width:360px\}/, 'the selected element\'s owner changed');
      assert.match(fs.readFileSync(path.join(dir, 'home.css'), 'utf8'), /width:120px/, 'nothing else did');
      const sent = await d.js("LAIN.state().conversation.filter((m) => m.role === 'user').pop().text");
      assert.match(sent, /VISUAL CHANGE REQUEST/); assert.match(sent, /settings\.css/);

      // 12 ESCAPE LEAVES PICK.
      await R.click("document.getElementById('wsPick')");
      await d.until("document.getElementById('wsPick').getAttribute('aria-pressed') === 'true'", 5000);
      await d.page.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tp.x, y: tp.y });
      await R.key('Escape');
      await d.until("document.getElementById('wsPick').getAttribute('aria-pressed') !== 'true'", 5000);

      // 13 NORMAL INTERACTION RETURNS: the page's own Home link works.
      await pf.settled();   // the page reloaded itself after the change landed
      await R.clickAt(await pf.point('#toHome'));
      const end13 = Date.now() + 20000;
      while (Date.now() < end13 && !/index\.html|^\/$/.test(String(await pf.eval('location.pathname').catch(() => '')))) await R.pause(200);
      assert.match(String(await pf.eval('location.pathname')), /index\.html|^\/$/, 'the click navigated the page');

      // 14 DETACH (the Preview's own button).
      await R.click("document.getElementById('wsDetach')");
      const cdp = require('../../src/harness/cdp');
      let t2 = null;
      for (let i = 0; i < 60 && !t2; i++) {
        const got = await cdp.endpoint(d.port).catch(() => ({ ok: false }));
        t2 = got && got.ok ? (got.targets || []).find((t) => /#detached-preview/.test(t.url)) : null;
        if (!t2) await R.pause(300);
      }
      assert.ok(t2, 'the detached preview window exists');
      second = new cdp.Connection(t2.webSocketDebuggerUrl);
      await second.connect();
      const ev = async (expr) => { const x = await second.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (x && x.exceptionDetails) throw new Error(JSON.stringify(x.exceptionDetails).slice(0, 300)); return x && x.result ? x.result.value : undefined; };
      const d2 = { page: { conn: second }, js: ev };
      const R2 = require('../harness/realinput')(d2);
      let shown = false;
      for (let i = 0; i < 100 && !shown; i++) { shown = await ev("document.body.classList.contains('detached-preview') && !!window.LAIN && !!LAIN.state() && LAIN.workshop.isOpen() && document.getElementById('wsWait').hidden").catch(() => false); if (!shown) await R.pause(200); }
      assert.ok(shown, 'the detached window shows the preview');
      assert.strictEqual(await ev('LAIN.state().current.id'), sessionId, 'the same session');

      // 15 SELECT AND CHANGE AGAIN, IN THE DETACHED WINDOW (the bridge's selection; the change from its own box).
      await ev("LAIN.workshop.select('#pay')");
      for (let i = 0; i < 100 && !/^Selected: /.test(String(await ev("document.getElementById('wsScope').textContent"))); i++) await R.pause(200);
      assert.match(String(await ev("document.getElementById('wsScope').textContent")), /^Selected: /);
      await R2.click("document.getElementById('wsSayIn')");
      await R2.text('make this wider');
      await R2.click("document.getElementById('wsSayGo')");
      assert.ok(await answerAsks("LAIN.state().conversation.some((m) => m.role !== 'user' && /The Pay button is wider/.test(m.text))", 90000), 'the change from the detached window ran in the same session');
      assert.match(fs.readFileSync(path.join(dir, 'home.css'), 'utf8'), /\.pay\{padding:10px 18px;width:200px\}/);
      await ev("LAIN.hostCall('close', {})").catch(() => null);
    } finally {
      try { if (second) second.close(); } catch { /* gone */ }
      try { await d.js("LAIN.api('/api/preview/stop', {})"); } catch { /* closing anyway */ }
      await d.close();
      try { await require('../../src/harnesslink').shutdown(d.app); } catch { /* nothing held */ }
    }
  });
};
