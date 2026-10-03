'use strict';

/**
 * PREVIEW — "ASK TO CHANGE THIS PAGE…" AND DETACH PREVIEW, IN THE REAL WINDOW (Phase 8.1; the 2026-09-30 live renderer).
 *
 * A two-page frontend project (Home, Settings) with a real dev server behind Core's proxy, the mock model:
 *
 *   1. pick the Pay button on the preview (real mouse) → "move this down slightly and make it wider" → the request
 *      carries the element and its owning stylesheet, and the Coding Agent changes that stylesheet only
 *   2. clear the selection, follow the page's own link to Settings → "make the heading larger" → the request targets
 *      /settings.html, not Home
 *   3. Detach Preview → a second native window shows only the preview; a change sent from it reaches the SAME session
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-prevreal-'));
  const port = 5300 + Math.floor(Math.random() * 400);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop', private: true, scripts: { dev: `node server.js --port ${port}` } }, null, 2));
  fs.writeFileSync(path.join(dir, 'server.js'), [
    'const http=require("http"),fs=require("fs"),path=require("path");',
    'const a=process.argv.indexOf("--port");const port=Number(process.env.PORT)||Number(a>0?process.argv[a+1]:0)||0;',
    'http.createServer((q,s)=>{const f=q.url==="/"?"index.html":q.url.replace(/^\\//,"").split("?")[0];',
    'const p=path.join(__dirname,f);if(!fs.existsSync(p)){s.writeHead(404);return s.end("no");}',
    's.writeHead(200,{"content-type":f.endsWith(".css")?"text/css":"text/html","cache-control":"no-store"});s.end(fs.readFileSync(p));',
    '}).listen(port,"127.0.0.1");',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Home</title><link rel="stylesheet" href="home.css"></head><body><h1>Home</h1><div class="row"><button id="pay" class="pay">Pay now</button></div><a id="toSettings" href="/settings.html">Settings</a></body></html>\n');
  fs.writeFileSync(path.join(dir, 'settings.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Settings</title><link rel="stylesheet" href="settings.css"></head><body><h1 class="title">Settings</h1></body></html>\n');
  fs.writeFileSync(path.join(dir, 'home.css'), 'body{margin:0;font-family:system-ui}\n.row{margin-top:20px}\n.pay{padding:10px 18px;width:120px}\n');
  fs.writeFileSync(path.join(dir, 'settings.css'), 'body{margin:0;font-family:system-ui}\n.title{font-size:20px}\n');
  return dir;
}

module.exports = async function () {
  await test('PREVIEW REAL UI: Ask to change — the selected element\'s owner, then the page on screen; Detach Preview shares the session', async () => {
    const drv = require('../harness/appdriver');
    const dir = project();
    const d = await drv.open({
      cwd: dir,
      width: 1500, height: 900,
      script: [
        { text: 'Reading the owner of the Pay button.', tool_calls: [{ name: 'read_file', input: { path: 'home.css' } }] },
        { text: 'Adjusting the Pay button.', tool_calls: [{ name: 'write_file', input: { path: 'home.css', content: 'body{margin:0;font-family:system-ui}\n.row{margin-top:32px}\n.pay{padding:10px 18px;width:180px}\n' } }] },
        { text: 'Moved the Pay button down and widened it.' },
        { text: 'Reading the Settings page styles.', tool_calls: [{ name: 'read_file', input: { path: 'settings.css' } }] },
        { text: 'Enlarging the Settings heading.', tool_calls: [{ name: 'write_file', input: { path: 'settings.css', content: 'body{margin:0;font-family:system-ui}\n.title{font-size:32px}\n' } }] },
        { text: 'The Settings heading is larger.' },
        { text: 'Noted from the detached preview.' },
        { text: 'Done.' }, { text: 'Done.' }, { text: 'Done.' },
      ],
    });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const R = require('../harness/realinput')(d);
    const answerAsks = async (until, ms = 90000) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !(await d.js(until))) {
        const card = await d.js("(() => { const c = document.getElementById('askCard'); return c && !c.hidden ? c.innerText : null; })()");
        if (card) { await d.js("document.querySelector('#askCard button.primary').click()"); await new Promise((r) => setTimeout(r, 400)); } else await new Promise((r) => setTimeout(r, 200));
      }
      return d.js(until);
    };
    const said = () => d.js("LAIN.state().conversation.filter((m) => m.role === 'user').pop().text");
    let second = null;
    try {
      await d.until("!document.getElementById('app').hidden");
      await d.js("LAIN.nav.go('ide')");
      await d.until("!document.getElementById('main').hidden", 15000);
      await d.click('#wsPill');
      await d.until("LAIN.workshop.isOpen() && document.getElementById('wsWait').hidden", 120000);
      const pf = await require('../harness/previewframe')(d);
      await pf.settled();
      assert.match(await d.js("document.getElementById('wsSayIn').placeholder"), /change this page/i, 'the preview has its own input');
      assert.ok(await d.js("document.getElementById('wsScope').hidden"), 'nothing selected: the request is about the page');
      const sessionId = await d.js('LAIN.state().current.id');

      // 1) PICK THE BUTTON (real mouse on the page), THEN SAY THE CHANGE.
      await R.click("document.getElementById('wsPick')");
      await d.until("document.getElementById('wsPick').getAttribute('aria-pressed') === 'true'", 10000);
      await R.clickAt(await pf.point('#pay'));
      await d.until("/^Selected: /.test(document.getElementById('wsScope').textContent)", 30000);
      await d.type('#wsSayIn', 'move this down slightly and make it wider');
      await d.click('#wsSayGo');
      assert.ok(await answerAsks("LAIN.state().conversation.some((m) => m.role !== 'user' && /Moved the Pay button down/.test(m.text))"), 'the Agent answered');
      const sent1 = await said();
      assert.match(sent1, /VISUAL CHANGE REQUEST/);
      assert.match(sent1, /selector {3}#pay/, 'the selected element');
      assert.match(sent1, /home\.css/, 'its owning stylesheet');
      assert.match(sent1, /change only what owns this element/);
      assert.match(fs.readFileSync(path.join(dir, 'home.css'), 'utf8'), /width:180px/, 'the owner changed');
      assert.match(fs.readFileSync(path.join(dir, 'settings.css'), 'utf8'), /font-size:20px/, 'another page\'s style did not');

      // 2) CLEAR THE SELECTION, GO TO SETTINGS (the page's own link), SAY A PAGE CHANGE.
      await d.click('#wsScope');
      await d.until("document.getElementById('wsScope').hidden", 10000);
      await pf.settled();   // the page reloaded itself after the change landed
      await R.clickAt(await pf.point('#toSettings'));
      const end2 = Date.now() + 20000;
      while (Date.now() < end2 && String(await pf.eval('location.pathname').catch(() => '')) !== '/settings.html') await R.pause(200);
      await d.until("(() => { LAIN.poll(); const f = LAIN.state().workshop && LAIN.state().workshop.frame; return !!(f && /settings\\.html/.test(String(f.page && (f.page.path || f.page) || ''))); })()", 10000).catch(() => null);
      await d.type('#wsSayIn', 'make the heading larger');
      await d.click('#wsSayGo');
      assert.ok(await answerAsks("LAIN.state().conversation.some((m) => m.role !== 'user' && /The Settings heading is larger/.test(m.text))"), 'the Agent answered');
      const sent2 = await said();
      assert.match(sent2, /page currently shown in the preview: \/settings\.html/, `the page on screen — sent: ${(sent2.match(/TARGET.*/) || [sent2.slice(0, 300)])[0]}`);
      assert.ok(!/selector {3}#pay/.test(sent2), 'no stale element');
      assert.match(fs.readFileSync(path.join(dir, 'settings.css'), 'utf8'), /font-size:32px/);
      assert.strictEqual(await d.js('LAIN.state().current.id'), sessionId, 'the same session throughout');

      // 3) DETACH PREVIEW: a second native window, the same Core and session.
      const r = await d.js("LAIN.hostCall('detach', { mode: 'preview' })");
      assert.ok(r && r.ok, JSON.stringify(r));
      const cdp = require('../../src/harness/cdp');
      let t2 = null;
      for (let i = 0; i < 60 && !t2; i++) {
        const got = await cdp.endpoint(d.port).catch(() => ({ ok: false }));
        t2 = got && got.ok ? (got.targets || []).find((t) => /#detached-preview/.test(t.url)) : null;
        if (!t2) await new Promise((x) => setTimeout(x, 300));
      }
      assert.ok(t2, 'the detached preview window exists');
      second = new cdp.Connection(t2.webSocketDebuggerUrl);
      await second.connect();
      const ev = async (expr) => { const x = await second.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return x && x.result ? x.result.value : null; };
      let shown = false;
      for (let i = 0; i < 100 && !shown; i++) { shown = await ev("document.body.classList.contains('detached-preview') && !!window.LAIN && !!LAIN.state() && LAIN.workshop.isOpen() && document.getElementById('wsWait').hidden"); if (!shown) await new Promise((x) => setTimeout(x, 300)); }
      assert.ok(shown, 'the detached window shows only the preview, drawn');
      assert.strictEqual(await ev("LAIN.state().current.id"), sessionId, 'the same session');
      assert.strictEqual(await ev("getComputedStyle(document.getElementById('app')).display"), 'none', 'none of the rest of LAIN');
      await ev("(() => { const i = document.getElementById('wsSayIn'); i.value = 'note: keep the heading bold'; document.getElementById('wsSayGo').click(); return true; })()");
      assert.ok(await answerAsks("LAIN.state().conversation.filter((m) => m.role === 'user').some((m) => /keep the heading bold/.test(m.text))", 60000), 'a change from the detached window reached the same session');
      await ev("LAIN.hostCall('close', {})").catch(() => null);
    } finally {
      try { if (second) second.close(); } catch { /* gone */ }
      try { await d.js("LAIN.api('/api/preview/stop', {})"); } catch { /* closing anyway */ }
      await d.close();
      try { await require('../../src/harnesslink').shutdown(d.app); } catch { /* nothing held */ }
    }
  });
};
