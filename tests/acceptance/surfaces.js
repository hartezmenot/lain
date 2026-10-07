// THE CLI'S WINDOWS AND THE HARNESS CHROME, for real (WebView2 host built from native/host.cs), isolated home.
//   dashboard mode (`lain model`)  ·  preview mode (`lain preview`) + a model action end to end  ·  Harness: the
//   Update button (a release is "available"), its dropdown, and Exit LAIN's confirmation. Screenshots in <out>.
const ROOT = require('path').join(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-surfaces-'));
process.env.LAIN_CONFIG_DIR = HOME; process.env.LAIN_CONFIG_DIR = HOME; process.env.LAIN_HOME = path.join(HOME, 'supervisor-home');
process.env.LAIN_ISOLATED = '1'; process.env.LAIN_NO_UPDATE_CHECK = '1'; process.env.LAIN_PROVIDER = 'mock';
process.chdir(ROOT);
const cdp = require(ROOT + '/src/harness/cdp');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail: String(detail || '') }); process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  — ${String(detail).slice(0, 400)}`}\n`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach(port) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const got = await cdp.endpoint(port).catch(() => ({ ok: false }));
    const t = got && got.ok ? (got.targets || []).find((x) => x.webSocketDebuggerUrl && /lain\.app/.test(x.url || '')) : null;
    if (t) { const c = new cdp.Connection(t.webSocketDebuggerUrl); const o = await c.connect(); if (o.ok) return c; }
    await wait(400);
  }
  return null;
}
const ev = async (c, expr) => { const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.value; };
const shot = async (c, name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(r.data, 'base64')); return path.join(out, name); };

(async () => {
  const { App } = require(ROOT + '/src/app');
  const win = require(ROOT + '/src/desktopwindow');
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lain-surf-proj-')));
  fs.writeFileSync(path.join(proj, 'index.html'), '<!doctype html><title>Counter</title><h1>Counter</h1><p id="count">Count: 0</p><button onclick="var p=document.getElementById(\'count\');p.textContent=\'Count: \'+(+p.textContent.split(\': \')[1]+1)">Add one</button>');
  fs.mkdirSync(path.join(proj, '.lain')); fs.writeFileSync(path.join(proj, '.lain', 'preview.json'), JSON.stringify({ static: '.' }));
  const cfgFile = path.join(HOME, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ trustedPaths: [{ path: proj, level: 'TRUSTED', at: new Date().toISOString() }], dashAutostart: false }, null, 2));
  const app = new App({ cwd: proj, interactive: false });
  await app.prepare();

  // ---- 1. DASHBOARD MODE ------------------------------------------------------------------------------------------
  let port = 9600 + Math.floor(Math.random() * 300);
  let o = await win.open(app, { dev: true, debugPort: port, mode: 'dashboard', section: 'models' });
  check('dashboard: the window opens', o.ok || o.already, o.why);
  let c = await attach(port);
  if (c) {
    await c.send('Page.enable', {});
    await wait(3500);
    const st = await ev(c, `({ title: document.title, mode: document.body.classList.contains('dashboard-mode'), rail: getComputedStyle(document.getElementById('rail')).display, tab: document.getElementById('app').getAttribute('data-tab'), model: !document.getElementById('vModel').hidden, secret: /sk-[A-Za-z0-9]{12}|Bearer\\s/.test(document.body.innerText), url: location.href })`);
    check('dashboard: Model room only — no rail, no other rooms', st && st.mode && st.rail === 'none' && st.model && st.tab === 'model', JSON.stringify(st));
    check('dashboard: no secret in the page or its URL', st && !st.secret && !/key|token|secret/i.test(st.url.split('#')[1] || ''), st && st.url);
    const tabs = await ev(c, `Array.from(document.querySelectorAll('#vModel [role=tab]')).map(function(t){return t.textContent.trim()})`);
    check('dashboard: tabs Accounts, Models, API, Local, Defaults — opened on the asked section (Models)', ['Accounts', 'Models', 'API', 'Local', 'Defaults'].every((t) => (tabs || []).some((x) => x.startsWith(t))), JSON.stringify(tabs));
    const active = await ev(c, "(document.querySelector('#vModel [role=tab][aria-selected=true]') || {}).textContent");
    check('dashboard: `lain model` opens on Models', /Models/.test(active || ''), active);
    await shot(c, 'dashboard-models.png');
    c.close();
  } else check('dashboard: attach to the renderer', false, 'no debug port');
  await win.close ? win.close(app) : null;
  await wait(2500);

  // ---- 2. PREVIEW MODE + a model action end to end (Core queue → this window → the page's bridge) -------------------
  const f = await require(ROOT + '/src/workshop').forApp(app).frameOpen(proj, {});
  check('preview: the project page is served', f.ok, f.why);
  port = 9600 + Math.floor(Math.random() * 300);
  o = await win.open(app, { dev: true, debugPort: port, mode: 'preview' });
  c = await attach(port);
  if (c) {
    await c.send('Page.enable', {});
    await wait(5000);
    const st = await ev(c, `({ detached: document.body.classList.contains('detached-preview'), app: getComputedStyle(document.getElementById('app')).display })`);
    check('preview: the Preview alone (the same Workshop surface the Harness detaches)', st && st.detached && st.app === 'none', JSON.stringify(st));
    const pi = require(ROOT + '/src/workshop/previewinput');
    const read0 = await pi.run(app, { action: 'read' });
    const click = await pi.run(app, { action: 'click', target: { text: 'Add one' } });
    const read1 = await pi.run(app, { action: 'read' });
    check('preview: a model action travels Core → window → page and back (read, click, read)', read0.ok && click.ok && read1.ok && /Count: 0/.test(read0.page.text) && /Count: 1/.test(read1.page.text), JSON.stringify({ r0: read0.ok && read0.page.text, click: click.ok || click.why, r1: read1.ok && read1.page.text }).slice(0, 300));
    await shot(c, 'preview-mode.png');
    c.close();
  } else check('preview: attach to the renderer', false, 'no debug port');
  await win.close ? win.close(app) : null;
  await wait(2500);

  // ---- 3. THE HARNESS: Update button (a release is available), dropdown, Exit LAIN ---------------------------------
  // THE NEXT RELEASE, from the one product version — a hardcoded number stops being "newer" at the next bump.
  const NEXT = require('../../package.json').version.replace(/(\d+)$/, (n) => String(Number(n) + 1));
  fs.mkdirSync(path.join(HOME, 'update'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'update', 'state.json'), JSON.stringify({ channel: 'stable', checkedAt: Date.now(), available: { version: NEXT, summary: ['Model Dashboard in the CLI', 'Preview input for models'], notes: null, reachable: true, asset: { name: 'x.zip', url: 'x.zip', sha256: '0'.repeat(64) } } }));
  port = 9600 + Math.floor(Math.random() * 300);
  o = await win.open(app, { dev: true, debugPort: port });
  c = await attach(port);
  if (c) {
    await c.send('Page.enable', {});
    await wait(4500);
    const st = await ev(c, `({ upd: !document.getElementById('updateBtn').hidden, updText: document.getElementById('updateBtn').innerText.trim(), exit: !!document.getElementById('railExit'), exitTip: document.getElementById('railExit').getAttribute('data-tip'), brand: document.querySelector('.rail-brand').innerText.trim(), mark: !!document.querySelector('.rail-brand .rb-mark svg') })`);
    check('Harness: the Update button appears beside Usage only when a release is available', st && st.upd && /Update/.test(st.updText), JSON.stringify(st));
    check('Harness: Exit LAIN (power icon, tooltip "Exit LAIN") and the LAIN mark + wordmark', st && st.exit && st.exitTip === 'Exit LAIN' && st.mark && /LAIN/.test(st.brand), JSON.stringify(st));
    await shot(c, 'harness-update-button.png');
    await ev(c, `document.getElementById('updateBtn').click()`);
    await wait(700);
    const pop = await ev(c, `(function(){ var p=document.querySelector('.updpop'); return p ? { text: p.innerText, buttons: Array.from(p.querySelectorAll('button')).map(function(b){return b.textContent}) } : null })()`);
    check('Harness: the dropdown says what is new; a checkout offers Later and says Download is for installed builds — never a silent restart', pop && pop.text.includes(`LAIN ${NEXT}`) && /What/.test(pop.text) && pop.buttons.includes('Later') && /install the update with the LAIN installer/.test(pop.text), JSON.stringify(pop).slice(0, 300));
    await shot(c, 'harness-update-dropdown.png');
    await ev(c, `document.body.click(); document.getElementById('railExit').click()`);
    await wait(700);
    const dlg = await ev(c, `(function(){ var d=document.querySelector('.dlg'); return d ? d.innerText : null })()`);
    check('Harness: Exit LAIN asks first when idle (Close window keeps LAIN running)', dlg && /Exit LAIN\?/.test(dlg) && /Closing the window instead keeps LAIN running/.test(dlg), dlg);
    await shot(c, 'harness-exit-confirm.png');
    await ev(c, `(function(){ var b=Array.from(document.querySelectorAll('.dlg button')).find(function(x){return /Cancel/.test(x.textContent)}); if (b) b.click(); })()`);
    c.close();
  } else check('Harness: attach to the renderer', false, 'no debug port');

  try { await require(ROOT + '/src/teardown').shutdown(app, { why: 'surfaces acceptance done' }); } catch { /* exiting */ }
  fs.writeFileSync(path.join(out, 'surfaces.json'), JSON.stringify(results, null, 2));
  process.stdout.write(`\n${results.filter((x) => x.ok).length}/${results.length} passed · screenshots in ${out}\n`);
  setTimeout(() => process.exit(0), 1500).unref();
})().catch((e) => { process.stderr.write(`ERR ${e && e.stack}\n`); process.exit(1); });
