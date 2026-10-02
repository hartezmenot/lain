'use strict';

/**
 * IDE ACCEPTANCE (Phase 8.2) — the real window, real mouse and keyboard, and NO
 * AGENT (an empty model script; the test ends by proving no turn ran). A person
 * must be able to:
 *
 *    1 browse project files      6 inspect diagnostics     11 create a commit
 *    2 open a file               7 open the terminal       12 run a supported configuration
 *    3 edit it                   8 run a command           13 split the editor
 *    4 save it                   9 inspect Source Control  14 use the command palette
 *    5 search the project       10 view a diff             15 open Preview
 *
 * "If these are not all possible and discoverable, the IDE is not done." Each
 * step goes through the control a person would use — a tree row, a key, a
 * button — never an internal call standing in for it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { test } = require('../helpers');

function project(dir) {
  const w = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  w('package.json', `${JSON.stringify({ name: 'shopfront', private: true, version: '1.0.0', scripts: { dev: 'node server.js', test: 'node test/run.js' } }, null, 2)}\n`);
  w('server.js', [
    "const http = require('http'), fs = require('fs'), path = require('path');",
    'const port = Number(process.env.PORT) || 5400;',
    "http.createServer((q, s) => { let f = q.url.split('?')[0]; if (f === '/') f = '/index.html'; const p = path.join(__dirname, 'public', f);",
    "  if (!fs.existsSync(p)) { s.writeHead(404); return s.end('not found'); }",
    "  s.writeHead(200, { 'content-type': p.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-store' }); s.end(fs.readFileSync(p));",
    "}).listen(port, '127.0.0.1', () => console.log('shopfront on http://127.0.0.1:' + port));",
    '',
  ].join('\n'));
  w('public/index.html', '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body><h1>Welcome back</h1><a href="/settings.html">Settings</a></body></html>\n');
  w('public/settings.html', '<!doctype html><html><head><meta charset="utf-8"><title>Settings</title></head><body><h1>Settings</h1></body></html>\n');
  w('src/cart.js', "'use strict';\n\nclass Cart {\n  constructor() { this.items = []; }\n  add(item, qty = 1) { this.items.push({ item, qty }); return this; }\n  total() { return this.items.reduce((n, x) => n + x.item.price * x.qty, 0); }\n}\n\nmodule.exports = { Cart };\n");
  w('src/pricing.js', "'use strict';\n\nfunction discount(total, code) {\n  if (code === 'TEN') return total * 0.9;\n  return total;\n}\n\nmodule.exports = { discount };\n");
  w('test/run.js', "const assert = require('assert');\nconst { Cart } = require('../src/cart');\nassert.strictEqual(new Cart().add({ price: 5 }, 2).total(), 10);\nconsole.log('1 passed');\n");
  w('README.md', '# Shopfront\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  git('add', '-A'); git('commit', '-q', '-m', 'initial');
  return git;
}

module.exports = async function () {
  await test('IDE ACCEPTANCE: browse, open, edit, save, search, diagnostics, terminal, command, Source Control, diff, commit, run, split, palette, Preview — with real input, without the Agent', async () => {
    const drv = require('../harness/appdriver');
    const dir = drv.tmp('ideaccept-');
    const git = project(dir);
    const d = await drv.open({ cwd: dir, width: 1600, height: 900, script: [] });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const R = require('../harness/realinput')(d);
    const row = (name) => `Array.from(document.querySelectorAll('#srcTree .srcRow')).find((r) => r.querySelector('.nm') && r.querySelector('.nm').textContent === ${JSON.stringify(name)})`;
    const tabs = () => d.js("Array.from(document.querySelectorAll('#srcTabs .srcTab')).filter((t) => t.offsetParent !== null).map((t) => ({ name: (t.querySelector('.nm') || t).textContent.trim(), dirty: !!t.querySelector('.dot'), on: t.classList.contains('on') || t.classList.contains('active') }))");
    const panel = () => d.js("({ hidden: document.getElementById('bpanel').hidden, id: document.getElementById('drawer').dataset.panel })");
    const disk = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
    try {
      await d.until("!document.getElementById('app').hidden");
      await d.surface('ide');
      await d.until("!document.getElementById('main').hidden && document.querySelectorAll('#srcTree .srcRow').length > 0", 30000);

      // 1 BROWSE — the IDE opens on its Explorer (not Source Control); folders expand.
      assert.strictEqual(await d.js("document.getElementById('sideTitle').textContent"), 'Explorer');
      await R.click(row('src'));
      await d.until(`!!(${row('cart.js')})`, 10000);

      // 2 OPEN — a double-click keeps the file in ONE tab.
      await R.click(row('cart.js'), { count: 2 });
      await d.until("document.getElementById('srcTabs').innerText.includes('cart.js')", 10000);
      await R.pause(500);
      assert.deepStrictEqual((await tabs()).map((t) => t.name), ['cart.js'], 'one tab for one file');
      assert.match(await d.js("document.getElementById('srcCrumbs').innerText.replace(/[\\s]+/g, ' ')"), /src › cart\.js/);

      // 3 EDIT — click at the end of line 1 and type.
      const end1 = await d.js("(() => { const ed = LAIN.editor.editor(); const r = ed.getDomNode().getBoundingClientRect(); const col = ed.getModel().getLineMaxColumn(1); const v = ed.getScrolledVisiblePosition({ lineNumber: 1, column: col }); return { x: r.left + v.left + 1, y: r.top + v.top + v.height / 2 }; })()");
      await R.clickAt(end1);
      await R.pause(250);
      await R.text(' // edited in the IDE');
      await d.until("!!document.querySelector('#srcTabs .srcTab .dot')", 5000);

      // 4 SAVE — Ctrl+S writes it; the tab is clean again.
      await R.key('s', { ctrl: true });
      await d.until("!document.querySelector('#srcTabs .srcTab .dot')", 10000);
      assert.match(disk('src/cart.js'), /^'use strict'; \/\/ edited in the IDE\n/);

      // 5 SEARCH — Ctrl+Shift+F, a query, a hit opens where it was found.
      await R.key('f', { ctrl: true, shift: true });
      await d.until("document.getElementById('sideTitle').textContent === 'Search'", 5000);
      await R.click("document.getElementById('paneSearchQ')");
      await R.text('discount');
      await R.key('Enter');
      await d.until("/2 results in 1 file/.test(document.getElementById('srchSum').textContent)", 15000);
      await R.click(R.byText('#srchList *', /discount/));
      await d.until("(LAIN.editor.editor().getModel() || { uri: '' }).uri.toString().endsWith('src/pricing.js')", 10000);

      // 6 DIAGNOSTICS — a file with an error, made outside the IDE: Refresh shows it; Problems names it; a click goes there.
      fs.writeFileSync(path.join(dir, 'src', 'broken.js'), "'use strict';\nconst total = ;\nmodule.exports = { total };\n");
      await R.key('e', { ctrl: true, shift: true });
      await d.until("document.getElementById('sideTitle').textContent === 'Explorer'", 5000);
      await R.click("document.getElementById('sideRefresh')");
      await d.until(`!!(${row('broken.js')})`, 10000);
      await R.click(row('broken.js'), { count: 2 });
      await d.until("/✕\\s*1/.test(document.getElementById('sbProblems').textContent)", 20000);
      await R.click("document.getElementById('sbProblems')");
      await d.until("!document.getElementById('bpanel').hidden && document.getElementById('drawer').dataset.panel === 'PROBLEMS' && !!document.querySelector('#drawer .prob')", 10000);
      assert.match(await d.js("document.querySelector('#drawer .prob').innerText"), /Expression expected[\s\S]*src\/broken\.js:2/);
      await R.click("document.querySelector('#drawer .prob')");
      await d.until("LAIN.editor.editor().getPosition().lineNumber === 2 && LAIN.editor.editor().getModel().uri.toString().endsWith('src/broken.js')", 10000);

      // 7 TERMINAL — Ctrl+` opens it; Ctrl+J hides and shows the panel.
      await R.key('`', { ctrl: true });
      await d.until("!document.getElementById('bpanel').hidden && document.getElementById('drawer').dataset.panel === 'TERMINAL' && !!document.querySelector('.xterm')", 20000);
      await R.key('j', { ctrl: true });
      await d.until("document.getElementById('bpanel').hidden", 5000);
      await R.key('j', { ctrl: true });
      await d.until("!document.getElementById('bpanel').hidden", 5000);
      assert.strictEqual((await panel()).id, 'TERMINAL');

      // 8 RUN A COMMAND in it.
      await d.until("/[>$]\\s*$/.test((LAIN.xterm.text() || '').trim())", 20000);
      // THE VISIBLE TERMINAL (a toggled panel can leave a hidden one behind), and — as a person
      // does — the command is seen on the line before Enter.
      const term = "Array.from(document.querySelectorAll('.xterm')).find((x) => x.offsetParent !== null && x.getBoundingClientRect().height > 40)";
      for (let attempt = 0; attempt < 2; attempt++) {
        await R.click(term);
        await R.text('node test/run.js');
        // A LONG PROMPT WRAPS THE LINE (the terminal soft-wraps; its text has a line break mid-command): compared unwrapped.
        const echoed = await d.until("(LAIN.xterm.text() || '').replace(/\\r?\\n/g, '').includes('node test/run.js')", 8000).then(() => true, () => false);
        if (echoed) break;
      }
      await R.key('Enter');
      await d.until("(LAIN.xterm.text() || '').includes('1 passed')", 30000).catch(async (e) => {
        throw new Error(`${e.message} — terminal: ${JSON.stringify(await d.js("(() => { const t = LAIN.xterm.text() || ''; const i = t.lastIndexOf('node '); return t.slice(Math.max(0, i - 60), i + 260); })()"))}, active: ${await d.js('document.activeElement && (document.activeElement.id || document.activeElement.className)')}`);
      });

      // 9 SOURCE CONTROL — Ctrl+Shift+G: what changed, and nothing LAIN wrote for itself.
      await R.key('g', { ctrl: true, shift: true });
      await d.until("document.getElementById('sideTitle').textContent === 'Source Control' && /cart\\.js/.test(document.getElementById('paneScm').innerText)", 15000);
      const scm = await d.js("document.getElementById('paneScm').innerText");
      assert.ok(!/\.lain/.test(scm), `LAIN's own files are not the person's changes: ${scm}`);

      // 10 DIFF — a changed file opens against HEAD.
      await R.click(R.byText('#paneScm button.f', /src\/cart\.js/));
      await d.until("!!document.querySelector('.monaco-diff-editor') && /working tree vs HEAD/.test((document.getElementById('diffBar') || {}).innerText || '')", 15000);

      // 11 COMMIT — Stage all, a message, Commit.
      await R.click(R.byText('#paneScm button', 'Stage all'));
      // THE BUTTON A PERSON WAITS FOR: enabled once staging lands ("Commit (2)").
      await d.until("(() => { const b = Array.from(document.querySelectorAll('#paneScm button.primary')).find((x) => /^Commit [(][0-9]+[)]$/.test(x.textContent.trim())); return Boolean(b && !b.disabled); })()", 15000);
      await R.click("document.querySelector('#paneScm textarea')");
      await R.text('Count the cart');
      await R.click(R.byText('#paneScm button.primary', /^Commit \(\d+\)$/));
      const end = Date.now() + 20000;
      while (Date.now() < end && git('log', '-1', '--format=%s').trim() !== 'Count the cart') await R.pause(300);
      const why = git('log', '-1', '--format=%s').trim() === 'Count the cart' ? '' : JSON.stringify(await d.js("({ scm: document.getElementById('paneScm').innerText.slice(0, 400), msg: (document.querySelector('#paneScm textarea') || {}).value, toast: Array.from(document.querySelectorAll('.toast, #toast')).map((t) => t.innerText).join(' | '), dialog: (document.querySelector('#dlg:not([hidden]), .dialog') || {}).innerText || null })"));
      if (why) await d.shot(path.join(require('os').tmpdir(), 'ideaccept-commit.png'));
      assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'Count the cart', `the commit landed — ${why} · status: ${git('status', '--porcelain')}`);
      assert.strictEqual(git('status', '--porcelain').trim(), '', 'everything staged was committed');

      // 12 RUN A SUPPORTED CONFIGURATION — Run and Debug lists the project's scripts; one runs. The
      // debugger says which adapters this machine has, and why a missing one is missing.
      await R.key('d', { ctrl: true, shift: true });
      await d.until("document.getElementById('sideTitle').textContent.startsWith('Run') && !!document.querySelector('#paneRun button.run-row')", 15000);
      assert.match(await d.js("document.getElementById('paneRun').innerText"), /Adapter/);
      const before = await d.js("((LAIN.xterm.text() || '').match(/1 passed/g) || []).length");
      await R.click(R.byText('#paneRun button.run-row', /npm run test/));
      await d.until(`((LAIN.xterm.text() || '').match(/1 passed/g) || []).length > ${before}`, 30000);

      // 13 SPLIT — the editor splits right.
      await R.key('e', { ctrl: true, shift: true });
      await R.click(row('cart.js'), { count: 2 });
      await R.click("document.getElementById('splitRightBtn')");
      await d.until("Array.from(document.querySelectorAll('.srcPane')).filter((p) => p.offsetParent !== null && p.getBoundingClientRect().width > 200).length === 2", 10000);

      // 14 COMMAND PALETTE — Ctrl+Shift+P finds a command; Escape closes it.
      await R.key('p', { ctrl: true, shift: true });
      await d.until("!document.getElementById('palette').hidden && document.getElementById('paletteQ').value.startsWith('>')", 5000);
      await R.text('Toggle Panel');
      await d.until("/View: Toggle Panel/.test(document.getElementById('presults').innerText)", 5000);
      await R.key('Escape');
      await d.until("document.getElementById('palette').hidden", 5000);

      // 15 PREVIEW — from the palette, directly: no Agent, no chat.
      await R.key('p', { ctrl: true, shift: true });
      await d.until("!document.getElementById('palette').hidden", 5000);
      await R.text('Open Preview');
      await d.until("/Open Preview/.test(document.getElementById('presults').innerText)", 5000);
      await R.key('Enter');
      // THE LIVE PAGE (2026-09-30 renderer): the project's dev server, through Core's proxy, in the Harness's frame.
      await d.until("LAIN.workshop.isOpen() && document.getElementById('wsWait').hidden", 120000);
      const pf = await require('../harness/previewframe')(d);
      await pf.settled();
      assert.strictEqual(await pf.eval("document.querySelector('h1').textContent"), 'Welcome back', 'the project\'s own page is on screen');
      assert.match(await d.js("document.getElementById('wsSayIn').placeholder"), /change this page/i, 'nothing selected: a request targets the page');

      // WITHOUT THE AGENT: not one turn ran.
      assert.strictEqual(d.app.session.turns.length, 0, 'the Agent was never asked');
    } finally {
      try { await d.js("LAIN.api('/api/preview/stop', {})"); } catch { /* closing anyway */ }
      await d.close();
      try { await require('../../src/harnesslink').shutdown(d.app); } catch { /* nothing held */ }
    }
  });
};
