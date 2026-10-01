'use strict';

/**
 * THE PREVIEW, AS A PERSON USES IT — through the application window (2026-09-30: the live renderer).
 *
 * Evidence tier: REAL-UI VERIFIED. A real project with a real dev server behind Core's preview proxy, the page in
 * the Harness's own frame with LAIN's bridge injected, and the Harness driven through its DOM with real mouse events
 * (tests/harness/appdriver.js). The model is the mock provider; its READ and PATCH are real tool calls through
 * LAIN's transaction, against the real file.
 *
 *   "this button is too low and mobile layout breaks"
 *
 *   open Preview → the dev server's page, through the proxy → desktop / tablet / mobile change the REAL CSS viewport →
 *   select the button (the bridge's own selection) and hold-drag the heading (real input) → the inspector names the
 *   element and its owning source → "Ask to change this page…" → LAIN reads and patches checkout.css → the page
 *   reloads itself after the change landed → the button really moved up.
 *
 * (The screenshot-streaming Workshop — Before/After images, the Verify panel — was retired with it.)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-wsreal-'));
  const port = 4900 + Math.floor(Math.random() * 400);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'checkout', private: true, scripts: { dev: `node server.js --port ${port}` } }, null, 2));
  fs.writeFileSync(path.join(dir, 'server.js'), [
    'const http=require("http"),fs=require("fs"),path=require("path");',
    'const a=process.argv.indexOf("--port");const port=Number(process.env.PORT)||Number(a>0?process.argv[a+1]:0)||0;',
    'http.createServer((q,s)=>{const f=q.url==="/"?"index.html":q.url.replace(/^\\//,"").split("?")[0];',
    'const p=path.join(__dirname,f);if(!fs.existsSync(p)){s.writeHead(404);return s.end("no");}',
    's.writeHead(200,{"content-type":f.endsWith(".css")?"text/css":"text/html","cache-control":"no-store"});s.end(fs.readFileSync(p));',
    '}).listen(port,"127.0.0.1");',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout</title><link rel="stylesheet" href="checkout.css"></head><body><main class="page"><h1 id="title">Checkout</h1><div class="row"><button id="pay" class="pay">Pay now</button></div></main></body></html>\n');
  // THE TWO REPORTED DEFECTS: the button sits far too low, and a fixed page width overflows a phone.
  fs.writeFileSync(path.join(dir, 'checkout.css'), [
    'body{margin:0;font-family:system-ui;background:#fff;color:#111}',
    '.page{padding:24px;width:900px}',
    '.row{display:block;margin-top:420px}',
    '.pay{padding:10px 18px;background:#2b6cb0;color:#fff;border:0;border-radius:6px;font-size:16px}',
    '',
  ].join('\n'));
  return dir;
}

module.exports = async function () {
  await test('PREVIEW REAL UI: the dev server through the proxy, three real viewports, select + hold-drag, ask, patch, the page reloads itself', async () => {
    const drv = require('../harness/appdriver');
    const dir = project();
    const fixed = fs.readFileSync(path.join(dir, 'checkout.css'), 'utf8')
      .replace('.page{padding:24px;width:900px}', '.page{padding:24px;max-width:900px}')
      .replace('.row{display:block;margin-top:420px}', '.row{display:flex;justify-content:center;margin-top:20px}');
    const d = await drv.open({
      cwd: dir, width: 1600, height: 900,
      script: [
        { text: 'Reading the stylesheet the button comes from.', tool_calls: [{ name: 'read_file', input: { path: 'checkout.css' } }] },
        { text: 'The row has a 420px top margin and the page a fixed 900px width.', tool_calls: [{ name: 'write_file', input: { path: 'checkout.css', content: fixed } }] },
        { text: 'Fixed checkout.css: the button sits under the heading and the page no longer overflows a phone.' },
      ],
    });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-wsreal-shots-'));
    const frameState = () => d.js("(() => { const S = LAIN.state(); const f = S.workshop && S.workshop.frame; return f ? { url: f.url, vp: f.viewport, page: f.page } : null; })()");
    try {
      await d.until("!document.getElementById('app').hidden");

      // OPEN PREVIEW from the IDE: the project's dev server, behind Core's loopback proxy, in the Harness's frame.
      await d.js("LAIN.nav.go('ide')");
      await d.until("!document.getElementById('main').hidden", 15000);
      await d.click('#wsPill');
      await d.until("LAIN.workshop.isOpen() && document.getElementById('wsWait').hidden", 120000).catch(async (e) => {
        throw new Error(`${e.message}\nPREVIEW SAW: ${JSON.stringify(await frameState())} wait="${await d.js("document.getElementById('wsWaitText').textContent")}"`);
      });
      const st0 = await frameState();
      assert.match(String(st0.url), /^http:\/\/127\.0\.0\.1:\d+/, `the page comes through the loopback proxy: ${JSON.stringify(st0)}`);
      await d.shot(path.join(shots, '1-open.png'));

      // THREE VIEWPORTS: the frame IS that wide — a real CSS viewport, not a scaled desktop.
      for (const [vp, w] of [['mobile', 390], ['tablet', 768], ['desktop', 1440]]) {
        await d.js(`document.querySelector('#pvVps [data-seg=${vp}]').click(), true`);
        await d.until(`(() => { const dev = document.getElementById('pvDevice'); return parseFloat(dev.style.width) === ${w}; })()`, 10000);
        // CORE HOLDS IT TOO (the next snapshot after /api/preview/set).
        await d.until(`(() => { LAIN.poll(); const f = LAIN.state().workshop && LAIN.state().workshop.frame; return !!(f && f.viewport && f.viewport.w === ${w}); })()`, 10000).catch(async (e) => {
          throw new Error(`${e.message} — Core holds ${JSON.stringify(await frameState())} for ${vp}`);
        });
      }
      await d.shot(path.join(shots, '2-desktop.png'));

      // SELECT THE BUTTON — the bridge's own selection (the same path a hold-drag ends in).
      await d.js("LAIN.workshop.select('#pay')");
      await d.until("!document.getElementById('pvInsp').hidden && /Pay now|#pay|button/i.test(document.getElementById('pvInsp').innerText)", 20000);
      const vs = d.app.session._harness && d.app.session._harness.visualSelection;
      assert.ok(vs && /pay/.test(JSON.stringify(vs)), `Core's selection is the button: ${JSON.stringify(vs).slice(0, 300)}`);
      // AND ITS OWNING SOURCE, named from the project.
      await d.until("/checkout\\.css|index\\.html/.test(document.getElementById('pvInsp').innerText)", 20000);

      // HOLD-DRAG, REAL INPUT, on the heading (frame CSS px → window px through the frame's scale).
      const at = await d.js("(() => { const f = document.getElementById('wsFrame').getBoundingClientRect(); const dev = document.getElementById('pvDevice'); const k = f.width / parseFloat(dev.style.width); return { x: f.left + 60 * k, y: f.top + 44 * k }; })()");
      const M = (type, x, y, extra) => d.page.conn.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, extra || {}));
      await M('mouseMoved', at.x, at.y, { button: 'none', buttons: 0 });
      await M('mousePressed', at.x, at.y);
      await new Promise((r) => setTimeout(r, 450));
      await M('mouseMoved', at.x + 1, at.y + 1);
      await new Promise((r) => setTimeout(r, 150));
      await M('mouseReleased', at.x + 1, at.y + 1);
      await d.until("/Checkout|#title|h1/i.test(document.getElementById('pvInsp').innerText)", 15000);
      // BACK TO THE BUTTON for the change.
      await d.js("LAIN.workshop.select('#pay')");
      await d.until("/Pay now|#pay/i.test(document.getElementById('pvInsp').innerText)", 20000);

      // ASK TO CHANGE THIS PAGE — from the Preview's own box.
      await d.js("(() => { const i = document.getElementById('wsSayIn'); i.focus(); return true; })()");
      await d.type('#wsSayIn', 'this button is too low and mobile layout breaks');
      await d.click('#wsSayGo');
      // THE PROJECT HAS NO TRUST DECISION YET: LAIN asks in THIS window; answered the way a person would.
      let asked = 0;
      const end = Date.now() + 90000;
      while (Date.now() < end && !/margin-top:20px/.test(fs.readFileSync(path.join(dir, 'checkout.css'), 'utf8'))) {
        const card = await d.js("(() => { const c = document.getElementById('askCard'); return c && !c.hidden ? c.innerText : null; })()");
        if (card) {
          assert.match(card, /Allow (?:access to this path|this machine change)\?/, `an unexpected question: ${card}`);
          await d.js("document.querySelector('#askCard button.primary').click()");
          asked += 1;
          await new Promise((r) => setTimeout(r, 400));
        } else await new Promise((r) => setTimeout(r, 200));
      }
      assert.match(fs.readFileSync(path.join(dir, 'checkout.css'), 'utf8'), /margin-top:20px/, 'Noema really patched the source');
      const sent = await d.js("LAIN.state().conversation.filter((m) => m.role === 'user').pop().text");
      assert.match(sent, /this button is too low/);
      assert.match(sent, /the element I selected in the preview/i, 'the selection travelled with the request');
      assert.match(sent, /#pay/, 'naming the element');

      // THE PAGE RELOADS ITSELF once the change landed (double-buffered) — and the button really moved up.
      await d.until("LAIN.state().header.status.state !== 'RUNNING'", 60000);
      const before = vs && vs.rect ? vs.rect.y : null;
      await new Promise((r) => setTimeout(r, 2500));
      await d.js("LAIN.workshop.select('#pay')");
      await d.until(`(() => { const v = LAIN.workshop.state().element; return v && v.rect && v.rect.y < ${before == null ? 400 : before - 200}; })()`, 30000).catch(async (e) => {
        throw new Error(`${e.message} — before y=${before}, now ${JSON.stringify(await d.js('LAIN.workshop.state().element'))}`);
      });
      await d.shot(path.join(shots, '3-after.png'));
      process.stdout.write(`    (screenshots: ${shots}; permission asked ${asked}×)\n`);
    } finally {
      try { await d.js("LAIN.api('/api/preview/stop', {})"); } catch { /* closing anyway */ }
      await d.close();
      try { await require('../../src/harnesslink').shutdown(d.app); } catch { /* nothing held */ }
    }
  });
};
