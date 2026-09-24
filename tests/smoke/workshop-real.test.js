'use strict';

/**
 * THE FRONTEND WORKSHOP, AS A PERSON USES IT — through the application window.
 *
 * Evidence tier: REAL-UI VERIFIED. A real project with a real dev server, the
 * Workshop's project-bound Chromium, and the Harness page driven through its
 * DOM with real mouse events (tests/harness/appdriver.js). The model is the
 * mock provider; its READ and PATCH are real tool calls through LAIN's
 * transaction, against the real file.
 *
 *   "this button is too low and mobile layout breaks"
 *
 *   open the Workshop → before screenshot → verify shows mobile BROKEN →
 *   click the button ON THE PREVIEW IMAGE → selected element + its source →
 *   ask about the selection → LAIN reads and patches checkout.css → the
 *   preview hot-reloads on the change → after screenshot beside before →
 *   verify desktop, tablet and mobile all pass → console and network clean →
 *   the button really moved up.
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
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout</title><link rel="stylesheet" href="checkout.css"></head><body><main class="page"><h1>Checkout</h1><div class="row"><button id="pay" class="pay">Pay now</button></div></main></body></html>\n');
  // THE TWO REPORTED DEFECTS: the button sits far too low, and a fixed page
  // width overflows a phone.
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
  await test('WORKSHOP REAL UI: select on the preview, ask, patch, hot reload, three viewports, before/after', async () => {
    const drv = require('../harness/appdriver');
    const dir = project();
    const fixed = fs.readFileSync(path.join(dir, 'checkout.css'), 'utf8')
      .replace('.page{padding:24px;width:900px}', '.page{padding:24px;max-width:900px}')
      .replace('.row{display:block;margin-top:420px}', '.row{display:flex;justify-content:center;margin-top:20px}');
    const d = await drv.open({
      cwd: dir,
      script: [
        { text: 'Reading the stylesheet the button comes from.', tool_calls: [{ name: 'read_file', input: { path: 'checkout.css' } }] },
        { text: 'The row has a 420px top margin and the page a fixed 900px width.', tool_calls: [{ name: 'write_file', input: { path: 'checkout.css', content: fixed } }] },
        { text: 'Fixed checkout.css: the button sits under the heading and the page no longer overflows a phone.' },
      ],
    });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-wsreal-shots-'));
    try {
      await d.until("!document.getElementById('app').hidden && !document.getElementById('gate')");

      // OPEN THE WORKSHOP: dev server + project-bound preview. Its control is
      // the IDE's Preview button, one tab away from wherever the window opened.
      await d.js("LAIN.nav.go('ide')");
      await d.until("!document.getElementById('main').hidden", 15000);
      await d.click('#wsPill');
      try {
        await d.until("!document.getElementById('workshop').hidden && document.getElementById('wsShot') && document.getElementById('wsShot').naturalWidth > 0", 120000);
      } catch (e) {
        const seen = await d.js("JSON.stringify({ hidden: document.getElementById('workshop').hidden, url: (document.getElementById('wsUrl')||{}).textContent, body: (document.getElementById('wsBody')||{}).innerText, pill: (document.getElementById('wsPill')||{}).innerText, st: (function(){var s=LAIN.state();return s&&{lane:s.current&&s.current.lane, view:s.views&&s.views.active, panel:s.workspace&&s.workspace.openPanel, wsOpen:s.workshop&&s.workshop.open}})() })").catch((x) => String(x));
        throw new Error(`${e.message}\nWORKSHOP SAW: ${seen}`);
      }
      await d.shot(path.join(shots, '1-open.png'));

      // BEFORE, AND THE BREAKAGE OBSERVED.
      await d.click('#wsBefore');
      await d.until("/Before captured/.test(document.getElementById('wsBody').innerText)", 30000);
      await d.click('#wsVerify');
      await d.until("/verification evidence/i.test(document.getElementById('wsBody').innerText)", 120000);
      const broken = await d.js("document.getElementById('wsBody').innerText");
      assert.match(broken, /✗ mobile/, `mobile is observed broken before the fix:\n${broken}`);
      assert.match(broken, /✓ desktop/);

      // SELECT THE BUTTON BY CLICKING IT ON THE PREVIEW IMAGE (real mouse event).
      await d.js("document.querySelector('.vp[data-vp=desktop]').click()");
      await d.until("document.getElementById('wsShot') && /desktop/.test(document.getElementById('wsBody').innerText)", 30000);
      const target = await d.js("LAIN.api('/api/workshop/element', { selector: '#pay' })");
      assert.ok(target.ok, target.why);
      const at = await d.js(`(() => { const img = document.getElementById('wsShot'); const r = img.getBoundingClientRect();
        const e = ${JSON.stringify(target.element.rect)};
        return { x: r.left + (e.x + e.w / 2) * r.width / img.naturalWidth, y: r.top + (e.y + e.h / 2) * r.height / img.naturalHeight }; })()`);
      await d.page.conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await d.page.conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await d.until("/selected element/i.test(document.getElementById('wsBody').innerText) && /#pay/.test(document.getElementById('wsBody').innerText)", 30000);
      const selected = await d.js("document.getElementById('wsBody').innerText");
      assert.match(selected, /Pay now/, 'the selected element is the button');
      assert.match(selected, /source\s+(?:checkout\.css|index\.html)/, 'and its source is named from the project');
      assert.strictEqual(await d.js("document.getElementById('wsAttach').disabled"), false);

      // ASK ABOUT THE SELECTION, FROM THE COMPOSER.
      await d.type('#ask', 'this button is too low and mobile layout breaks');
      await d.click('#wsAttach');
      // THE PROJECT HAS NO TRUST DECISION YET, so LAIN asks before touching it —
      // in THIS window, because the window started the turn. Answered the way a
      // person would, each time the card appears.
      let asked = 0;
      const end = Date.now() + 90000;
      while (Date.now() < end && !(await d.js("document.getElementById('stream').innerText.includes('no longer overflows a phone')"))) {
        const card = await d.js("(() => { const c = document.getElementById('askCard'); return c && !c.hidden ? c.innerText : null; })()");
        if (card) {
          // A read asks for ACCESS, the patch asks for a MACHINE CHANGE — both are the gate.
          assert.match(card, /Allow (?:access to this path|this machine change)\?/, `an unexpected question: ${card}`);
          await d.js("document.querySelector('#askCard button.primary').click()");
          asked += 1;
          await new Promise((r) => setTimeout(r, 400));
        } else {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      assert.ok(asked >= 1, 'the permission question was asked in the window');
      await d.until("document.getElementById('stream').innerText.includes('no longer overflows a phone')", 5000);
      const sent = await d.js("LAIN.state().conversation.filter((m) => m.role === 'user').pop().text");
      assert.match(sent, /this button is too low/);
      assert.match(sent, /THE ELEMENT I SELECTED IN THE PREVIEW/, 'the selection travelled with the question');
      assert.match(fs.readFileSync(path.join(dir, 'checkout.css'), 'utf8'), /margin-top:20px/, 'LAIN really patched the source');

      // HOT RELOAD: the preview reloads because the file changed.
      await d.until("/reloaded after checkout\\.css changed/.test(document.getElementById('wsBody').innerText)", 60000);
      // AND THE SELECTION DESCRIBES THE NEW PAGE — the reload that follows the
      // written bytes re-reads it (the first can race the checkpoint).
      const oldBox = `at ${target.element.rect.x},${target.element.rect.y}`;
      await d.until(`!document.getElementById('wsBody').innerText.includes(${JSON.stringify(oldBox)}) && /#pay/.test(document.getElementById('wsBody').innerText)`, 30000);

      // AFTER, BESIDE BEFORE.
      await d.click('#wsAfter');
      await d.until("document.querySelectorAll('#wsBody .ba figure').length === 2", 30000);
      await d.shot(path.join(shots, '2-before-after.png'));

      // VERIFY EVERY VIEWPORT.
      // A NEW RUN, NOT THE OLD EVIDENCE: wait for the notice to come and go.
      await d.click('#wsVerify');
      await d.until("/Verifying/.test(document.getElementById('notice').innerText)", 10000).catch(() => null);
      await d.until("!/Verifying/.test(document.getElementById('notice').innerText) && (document.getElementById('wsBody').innerText.match(/[✓✗] (desktop|tablet|mobile)/g) || []).length === 3", 120000);
      const verified = await d.js("document.getElementById('wsBody').innerText");
      assert.ok(!/✗ /.test(verified), `every viewport passes after the fix:\n${verified}`);
      assert.match(verified, /console · clean/i);
      assert.match(verified, /network · clean/i);
      assert.match(verified, /Evidence only/, 'and the panel does not claim the task is done');

      const after = await d.js("LAIN.api('/api/workshop/element', { selector: '#pay' })");
      assert.ok(after.element.rect.y < target.element.rect.y - 200, `the button moved up: ${target.element.rect.y} → ${after.element.rect.y}`);
      await d.shot(path.join(shots, '3-verified.png'));
      process.stdout.write(`    (screenshots: ${shots})\n`);
    } finally {
      try { await d.js("LAIN.api('/api/workshop/close', {})"); } catch { /* closing anyway */ }
      await d.close();
      try { await require('../../src/harnesslink').shutdown(d.app); } catch { /* nothing held */ }
    }
  });
};
