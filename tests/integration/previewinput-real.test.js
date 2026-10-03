'use strict';

/**
 * THE MODEL'S POINTER AND KEYBOARD IN A REAL BROWSER (packaging pass §L) — the bridge script, served in a page,
 * driven exactly as the Preview drives it (postMessage `act`), in headless Edge/Chrome.
 *
 *   works:    click, double click, type into a named field, Enter submits, Tab moves focus, drag, scroll
 *   refuses:  the system file picker, a credential field, a link to another site, a new window, a page's window.open
 *   yields:   the person's own (trusted) input makes the model wait
 * There is no OS input on this path at all: every event is a DOM event inside the page.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { test } = require('../helpers');
const browser = require('../../src/harness/browser');
const { Connection } = require('../../src/harness/cdp');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function page(bridge) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Preview input</title></head><body style="margin:0;font:14px sans-serif">
<button id="b" onclick="window.clicks=(window.clicks||0)+1" ondblclick="window.dbl=true">Add one</button>
<form id="f" onsubmit="event.preventDefault(); window.submitted=document.getElementById('q').value;"><input id="q" aria-label="Search"><input id="q2" aria-label="Second"></form>
<input type="password" id="pw" aria-label="Password">
<label>Upload <input type="file" id="up"></label>
<a id="ext" href="https://example.com/x">Elsewhere</a>
<a id="blank" href="/y" target="_blank">New window</a>
<button id="opener" onclick="window.open('https://example.com/pop')">Pop</button>
<div id="drag" style="position:absolute;left:20px;top:300px;width:40px;height:40px;background:#9b8afb"></div>
<div style="height:3000px"></div>
<script>
  var d = document.getElementById('drag'), st = null;
  d.addEventListener('pointerdown', function (e) { st = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('pointerup', function (e) { if (st) { window.dragged = { dx: Math.round(e.clientX - st.x), dy: Math.round(e.clientY - st.y) }; st = null; } });
</script>
<script>${bridge}</script>
</body></html>`;
}

/** THE WINDOW, as the Preview is: the project's page in an iframe (the bridge runs only there), driven by postMessage. */
const OUTER = `<!doctype html><html><body style="margin:0"><iframe id="pv" src="/inner" style="display:block;width:1000px;height:760px;border:0"></iframe>
<script>
  var W = function () { return document.getElementById('pv').contentWindow; };
  window.__act = function (cmd) {
    return new Promise(function (res) {
      var id = Math.random().toString(16).slice(2);
      var h = function (e) { if (e.source === W() && e.data && e.data.type === 'acted' && e.data.id === id) { removeEventListener('message', h); res(e.data); } };
      addEventListener('message', h);
      W().postMessage(Object.assign({ lain: 1, type: 'act', id: id }, cmd), location.origin);
    });
  };
</script></body></html>`;

module.exports = async function () {
  const found = browser.findBrowser();
  if (!found.ok) { await test('PREVIEW INPUT: no Chromium browser on this machine — not verified here', () => assert.ok(!found.ok)); return; }
  const bridge = require('../../src/workshop/bridge').script();
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url.startsWith('/inner') ? page(bridge) : OUTER); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-pvin-'));
  const br = spawn(found.path, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--window-size=1000,800', url], { stdio: 'ignore', windowsHide: true });
  let c = null;
  const act = async (cmd) => {
    const r = await c.send('Runtime.evaluate', { expression: `window.__act(${JSON.stringify(cmd)})`, awaitPromise: true, returnByValue: true });
    return r.result.value;
  };
  // A READ OF THE PROJECT'S PAGE (same origin as the window, so the window may look inside it).
  const val = async (expr) => (await c.send('Runtime.evaluate', { expression: `W().eval(${JSON.stringify(expr)})`, returnByValue: true })).result.value;
  try {
    let port = null;
    for (let i = 0; i < 100 && !port; i++) { try { port = fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]; } catch { await wait(150); } }
    assert.ok(port, 'the browser started');
    let target = null;
    for (let i = 0; i < 50 && !target; i++) { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = list.find((x) => x.type === 'page' && x.url.startsWith(url)); if (!target) await wait(150); }
    c = new Connection(target.webSocketDebuggerUrl); await c.connect();
    for (let i = 0; i < 50 && (await c.send('Runtime.evaluate', { expression: 'Boolean(window.W && W() && W().__lainBridge)', returnByValue: true })).result.value !== true; i++) await wait(100);
    await c.send('Runtime.evaluate', { expression: "W().postMessage({ lain: 1, type: 'hello' }, location.origin)" });

    await test('PREVIEW INPUT: click and double click by visible text act on the page — the model\'s events, inside the page', async () => {
      const r = await act({ action: 'click', target: { text: 'Add one' } });
      assert.ok(r.ok, r.why);
      assert.strictEqual(r.target.tag, 'button');
      assert.strictEqual(await val('window.clicks'), 1);
      const d = await act({ action: 'double_click', target: { selector: '#b' } });
      assert.ok(d.ok, d.why);
      assert.strictEqual(await val('window.dbl'), true);
      assert.strictEqual(await val('window.clicks'), 3, 'a double click is two clicks and a dblclick');
    });

    await test('PREVIEW INPUT: type into a field named by its label; Enter submits; Tab moves focus', async () => {
      const t = await act({ action: 'type_text', target: { role: 'textbox', name: 'Search' }, text: 'lain' });
      assert.ok(t.ok, t.why);
      assert.strictEqual(t.value, 'lain');
      const k = await act({ action: 'key', key: 'Enter' });
      assert.ok(k.ok, k.why);
      assert.strictEqual(await val('window.submitted'), 'lain');
      await act({ action: 'key', key: 'Tab' });
      assert.strictEqual(await val('document.activeElement.id'), 'q2');
      const chord = await act({ action: 'key_chord', keys: 'Ctrl+A' });
      assert.ok(chord.ok, chord.why);
    });

    await test('PREVIEW INPUT: drag and scroll', async () => {
      const g = await act({ action: 'drag', target: { selector: '#drag' }, to: { dx: 120, dy: 40 } });
      assert.ok(g.ok, g.why);
      assert.deepStrictEqual(await val('window.dragged'), { dx: 120, dy: 40 });
      const s = await act({ action: 'scroll', dy: 600 });
      assert.ok(s.ok, s.why);
      assert.ok(s.scrolled.to.y > s.scrolled.from.y, JSON.stringify(s.scrolled));
    });

    await test('PREVIEW INPUT: what would leave the Preview is refused — file picker, credentials, other sites, new windows', async () => {
      const file = await act({ action: 'click', target: { selector: '#up' } });
      assert.ok(!file.ok && file.refused, JSON.stringify(file));
      assert.match(file.why, /file picker/);
      const label = await act({ action: 'click', target: { text: 'Upload' } });
      assert.ok(!label.ok && label.refused, 'a label that opens the picker is the picker');
      const pw = await act({ action: 'type_text', target: { selector: '#pw' }, text: 'secret' });
      assert.ok(!pw.ok && pw.refused);
      assert.match(pw.why, /credential/);
      assert.strictEqual(await val("document.getElementById('pw').value"), '', 'nothing was typed');
      const ext = await act({ action: 'click', target: { selector: '#ext' } });
      assert.ok(!ext.ok && ext.refused);
      assert.match(ext.why, /leaves the project/);
      const blank = await act({ action: 'click', target: { selector: '#blank' } });
      assert.ok(!blank.ok && blank.refused);
      assert.match(blank.why, /new window/);
      assert.strictEqual(await val('location.href'), `${url}inner`, 'the page did not navigate');
      const pop = await act({ action: 'click', target: { text: 'Pop' } });
      assert.ok(pop.ok, 'the button itself may be clicked');
      assert.ok(pop.dialogs.some((x) => x.kind === 'window.open'), 'but the window it tried to open was blocked and reported');
      await act({ action: 'key', key: 'Tab', target: { selector: '#ext' } });
      const enter = await act({ action: 'key', key: 'Enter', target: { selector: '#ext' } });
      assert.ok(!enter.ok && enter.refused, 'Enter on an external link is following it');
    });

    await test('PREVIEW INPUT: preview_read gives a model without vision the page as text — never a password value', async () => {
      await val("document.getElementById('pw').value = 'hunter2-secret'");
      const r = await act({ action: 'read' });
      assert.ok(r.ok, r.why);
      assert.match(r.page.text, /Add one/);
      assert.ok(r.page.elements.some((e) => e.role === 'button' && e.name === 'Add one'), JSON.stringify(r.page.elements.slice(0, 6)));
      assert.ok(r.page.elements.some((e) => e.role === 'textbox' && e.name === 'Search' && e.value === 'lain'), 'a field and its value');
      const pw = r.page.elements.find((e) => e.role === 'password');
      assert.ok(pw && pw.value === undefined && pw.name === 'Password', JSON.stringify(pw));
      assert.ok(!JSON.stringify(r).includes('hunter2-secret'), 'a credential never leaves the page');
      const out = require('../../src/tools/preview').describe(r);
      assert.match(out, /interactive elements/);
      assert.ok(!out.includes('hunter2-secret'));
    });

    await test('PREVIEW INPUT: the person\'s own input comes first — the model waits while they interact', async () => {
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 200, button: 'left', clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 600, y: 200, button: 'left', clickCount: 1 });
      const t0 = Date.now();
      const r = await act({ action: 'click', target: { selector: '#b' } });
      assert.ok(r.ok, r.why);
      assert.ok(Date.now() - t0 >= 700, `the model waited for the person (${Date.now() - t0} ms)`);
    });
  } finally {
    try { if (c) c.close(); } catch { /* closed */ }
    try { execFileSync('taskkill', ['/PID', String(br.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    await new Promise((r) => server.close(r));
    await wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* the cache cleaner takes it */ }
  }
};
