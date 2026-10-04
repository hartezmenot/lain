'use strict';

/**
 * LAIN DESIGN, REAL — the Design surface (lain-harness design/) in a headless Chromium against Core's real
 * /api/design routes (tests/designbench.js), the headless preview driver, and one Design-session turn against the mock
 * provider. Every pointer and key event here is CDP input into a headless page; nothing touches this machine's mouse,
 * keyboard or windows.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, tmpdir, writeScript } = require('../helpers');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function () {
  const design = require('../../src/design');
  const at = design.installed();
  if (!at.ok) { await test(`DESIGN REAL: Design is not installed here (${at.why}) — not verified`, () => assert.ok(!at.ok)); return; }
  const { findBrowser } = require(path.join(at.dir, 'src', 'headless.js'));
  if (!findBrowser()) { await test('DESIGN REAL: no Chromium on this machine — not verified here', () => assert.ok(true)); return; }
  const benchMod = require('../designbench');
  const haveUI = Boolean(benchMod.harnessDesignDir());

  /** A bench at zoom 1, the Chats frame at a known place, every frame loaded. */
  async function bench() {
    const b = await benchMod.start();
    await b.until('LAIN.designUI._state.frames.size === 4 && [...LAIN.designUI._state.frames.values()].every(f => f.ready)', 25000);
    await b.eval('(() => { const s = LAIN.designUI._state; s.zoom = 1; s.pan = { x: 30, y: 40 }; document.getElementById("dzWorld").style.transform = "translate(30px,40px) scale(1)"; })()');
    await wait(200);
    return b;
  }
  /** Select by clicking the canvas (the element must be visible there and hit itself). */
  async function selectIn(b, screen, pick) {
    const fb = await b.frameBox(screen);
    const nodes = await b.inFrame(screen);
    const n = nodes.find(pick);
    assert.ok(n, 'the element is on the canvas');
    await b.click(fb.x + n.rect.x + Math.min(10, n.rect.w / 2), fb.y + n.rect.y + n.rect.h / 2);
    await b.until(`LAIN.designUI._state.sel && LAIN.designUI._state.sel.node === ${JSON.stringify(n.id)} && LAIN.designUI._state.sel.info && LAIN.designUI._state.sel.layout`);
    return { fb, n };
  }
  /** Select through the Screens panel: open the screen's layers, click the layer's row. The canvas follows. */
  async function selectLayer(b, screen, pick) {
    const nodes = await b.inFrame(screen);
    const n = nodes.find(pick);
    assert.ok(n, 'the element is in the screen');
    const rowAt = (sel) => b.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
    if (!(await rowAt(`.dz-layer[data-node="${n.id}"]`))) {
      const scr = await b.eval(`(() => { const rows = [...document.querySelectorAll('.dz-scr-row')]; const e = rows.find(r => r.querySelector('small').textContent === ${JSON.stringify(screen)}); const r = e.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
      await b.click(scr.x, scr.y);
      await b.until(`document.querySelector('.dz-layer[data-node="${n.id}"]')`);
    }
    const p = await rowAt(`.dz-layer[data-node="${n.id}"]`);
    await b.click(p.x, p.y);
    await b.until(`LAIN.designUI._state.sel && LAIN.designUI._state.sel.node === ${JSON.stringify(n.id)} && LAIN.designUI._state.sel.info && LAIN.designUI._state.sel.layout`);
    // bring its frame into view, as the screen row does
    await b.eval(`(() => { const s = LAIN.designUI._state; const f = s.frames.get(${JSON.stringify(screen)}); s.pan = { x: 30 - f.pos.x, y: 40 }; document.getElementById('dzWorld').style.transform = 'translate(' + s.pan.x + 'px,40px) scale(1)'; })()`);
    await wait(150);
    return { fb: await b.frameBox(screen), n };
  }
  const statusText = (b) => b.eval('document.querySelector("#dzStatus").textContent');

  if (haveUI) {
    await test('DESIGN UI 1: drag the profile avatar from top-right to top-left — only its position changes in the source; Ctrl+Z is byte-exact', async () => {
      const b = await bench();
      try {
        const css0 = fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8');
        const html0 = fs.readFileSync(path.join(b.root, 'index.html'), 'utf8');
        const { fb, n } = await selectIn(b, 'index.html', (x) => x.tag === 'img' && x.rect.w === 40 && x.rect.y < 30);
        const x0 = fb.x + n.rect.x + 20; const y0 = fb.y + n.rect.y + 20;
        await b.drag(x0, y0, x0 - 316, y0, 16);
        await b.until('/left 16px/.test(document.querySelector("#dzStatus").textContent)', 10000);
        const css1 = fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8');
        assert.strictEqual(css1, css0.replace('right: 16px', 'left: 16px'), 'one declaration renamed and nothing else');
        assert.strictEqual(fs.readFileSync(path.join(b.root, 'index.html'), 'utf8'), html0, 'the page untouched');
        // the preview reloaded and the avatar is where it was dropped
        await b.until('LAIN.designUI._state.sel && LAIN.designUI._state.sel.layout && LAIN.designUI._state.sel.layout.rect.x < 30', 10000);
        await b.h.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
        await b.h.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2 });
        await b.until('document.querySelector("#dzStatus").textContent.startsWith("Undid")', 10000);
        assert.strictEqual(fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8'), css0, 'byte-exact');
      } finally { await b.close(); }
    });

    await test('DESIGN UI 2: the W slider writes width to the element\'s own rule, and the preview\'s rectangle matches it', async () => {
      const b = await bench();
      try {
        await selectIn(b, 'index.html', (x) => x.tag === 'img' && x.rect.w === 40 && x.rect.y < 30);
        await b.eval('(() => { const r = document.querySelector(\'#dzRight input[type=range][data-prop="width"]\'); const num = r.parentNode.querySelector("input[type=number]"); num.value = "56"; num.dispatchEvent(new Event("input")); num.dispatchEvent(new Event("change")); })()');
        await b.until('/width: 56px/.test(document.querySelector("#dzStatus").textContent)', 10000);
        assert.match(fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8'), /\.me-avatar \{[^}]*width: 56px/);
        await b.until('LAIN.designUI._state.sel && LAIN.designUI._state.sel.layout && LAIN.designUI._state.sel.layout.rect.w === 56', 10000);
      } finally { await b.close(); }
    });

    await test('DESIGN UI 3: dragging a flex child offers Reorder / Offset / Make absolute; Reorder moves it in the markup', async () => {
      const b = await bench();
      try {
        const { fb, n } = await selectLayer(b, 'index.html', (x) => x.tag === 'li' && x.rect.y > 180 && x.rect.y < 260);
        const nodes = await b.inFrame('index.html');
        const first = nodes.filter((x) => x.tag === 'li').sort((p, q) => p.rect.y - q.rect.y)[0];
        const x0 = fb.x + n.rect.x + 6; const y0 = fb.y + n.rect.y + n.rect.h / 2;
        await b.drag(x0, y0, x0, fb.y + first.rect.y + 4, 14);
        await b.until('document.getElementById("dzChoice")', 8000);
        const labels = await b.eval('[...document.querySelectorAll("#dzChoice button")].map(x => x.textContent + (x.classList.contains("primary") ? "*" : ""))');
        assert.ok(labels[0].startsWith('Reorder') && labels[0].endsWith('*'), `Reorder is the default: ${labels}`);
        assert.ok(labels.some((l) => l.startsWith('Offset')) && labels.some((l) => l.startsWith('Make absolute')));
        await b.eval('document.querySelector("#dzChoice button.primary").click()');
        await b.until('/moved to position 1/.test(document.querySelector("#dzStatus").textContent)', 10000);
        const html = fs.readFileSync(path.join(b.root, 'index.html'), 'utf8');
        assert.ok(html.indexOf('Linus') < html.indexOf('Ada'));
      } finally { await b.close(); }
    });

    await test('DESIGN UI 4: a change to a shared class asks "Change all N uses, or only this one?" before anything is written', async () => {
      const b = await bench();
      try {
        const css0 = fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8');
        await selectLayer(b, 'index.html', (x) => x.tag === 'a' && x.rect.y > 700);
        await b.eval('(() => { const r = document.querySelector(\'#dzRight input[type=range][data-prop="border-radius"]\'); const num = r.parentNode.querySelector("input[type=number]"); num.value = "4"; num.dispatchEvent(new Event("change")); })()');
        await b.until('document.querySelector(".dz-modal h4")', 8000);
        assert.strictEqual(await b.eval('document.querySelector(".dz-modal h4").textContent'), 'Change all 6 uses of .chip, or only this one?');
        assert.strictEqual(fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8'), css0, 'nothing written while asking');
        await b.eval('[...document.querySelectorAll(".dz-modal button")].find(x => x.textContent === "Only this one").click()');
        await b.until('/new class \\.lain-/.test(document.querySelector("#dzStatus").textContent)', 10000);
        const css1 = fs.readFileSync(path.join(b.root, 'styles.css'), 'utf8');
        assert.ok(css1.startsWith(css0), 'the shared rule is untouched; a scoped rule is appended');
      } finally { await b.close(); }
    });

    await test('DESIGN UI 5: "+" adds a logout button with a .png, copied in and referenced, wired to Settings — and Flow reads the wire', async () => {
      const b = await bench();
      try {
        const png = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lain-png-')), 'logout.png');
        fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c20000000049454e44ae426082', 'hex'));
        await selectLayer(b, 'profile.html', (x) => x.tag === 'section');
        await b.eval('document.getElementById("dzAdd").click()');
        await b.until('document.getElementById("dzAddBox")');
        await b.eval(`(() => { const s = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); }; s('dzAddName', 'Logout'); s('dzAddText', 'Log out'); s('dzAddAsset', ${JSON.stringify(png)}); document.getElementById('dzAddKind').value = 'button'; document.getElementById('dzAddWire').value = 'settings.html'; document.getElementById('dzAddOk').click(); })()`);
        await b.until('/wire logout click → navigate settings\\.html/.test(document.querySelector("#dzStatus").textContent)', 15000);
        assert.ok(fs.existsSync(path.join(b.root, 'assets', 'logout.png')), 'the asset is in the project');
        assert.match(fs.readFileSync(path.join(b.root, 'profile.html'), 'utf8'), /<button id="logout" type="button"><img src="assets\/logout.png" alt="">Log out<\/button>/);
        const flows = design.load().open(b.root).scanFlows();
        assert.ok(flows.some((w) => w.origin === 'design' && w.source.elementId === 'logout' && w.target === 'settings.html'));
        await b.eval('document.getElementById("dzModeFlow").click()');
        await b.until('document.querySelectorAll("#dzFlows path.design").length >= 1', 10000);
      } finally { await b.close(); }
    });

    await test('DESIGN UI 7: with the Design window open, design_interact runs on its canvas (the person watches) and reports back', async () => {
      const b = await bench();
      try {
        const d = design.forProject(b.app, b.root);
        await b.until('true'); await wait(1500);   // the window has polled the relay at least once
        assert.ok(d.relay.attached(), 'the window is attached');
        const T = design.load().tools;
        const r = await T.run(d, 'design_interact', { screen: 'index.html', steps: [{ action: 'hover', target: { text: 'Ada' } }, { action: 'click', target: { selector: '#me' } }] });
        assert.ok(!r.isError, r.output);
        const lines = r.output.split('\n');
        assert.match(lines[0], /^1\. hover .*: ok · \/index\.html/);
        assert.match(lines[1], /^2\. click .*: ok · \/profile\.html \(navigated\)/);
        assert.match(await b.eval('document.querySelector("#dzStatus").textContent'), /Canvas test passed/);
      } finally { await b.close(); }
    });

    await test('DESIGN UI 6: Flow shows the hand-written avatar → Profile navigation; a wire made in Design is still there after the surface reloads', async () => {
      const b = await bench();
      try {
        await b.eval('document.getElementById("dzModeFlow").click()');
        await b.until('document.querySelectorAll("#dzFlows path.code").length >= 4', 10000);
        const labels = await b.eval('[...document.querySelectorAll("#dzFlows text")].map(t => t.textContent)');
        assert.ok(labels.length >= 4);
        const d = design.forProject(b.app, b.root);
        const tab = d.project.scanElements('library.html').find((e) => e.text === 'Settings');
        const r = await b.eval(`api('/api/design/edit', { op: { op: 'addWire', node: ${JSON.stringify(tab.id)}, trigger: 'click', action: 'navigate', target: 'settings.html', transition: 'fade' } })`);   // the window's own (authenticated) call
        assert.ok(r.applied, JSON.stringify(r));
        await b.h.goto(b.url);
        await b.until('LAIN.designUI._state.frames.size === 4 && [...LAIN.designUI._state.frames.values()].every(f => f.ready)', 25000);
        await b.eval('document.getElementById("dzModeFlow").click()');
        await b.until('document.querySelectorAll("#dzFlows path.design").length >= 1', 10000);
        assert.ok((await b.eval('[...document.querySelectorAll("#dzFlows text")].map(t => t.textContent)')).some((t) => /fade/.test(t)));
      } finally { await b.close(); }
    });
  }

  if (haveUI) {
    await test('DESIGN DOOR: installed → a Design room, "Open in Design" on the Preview, and the chip after two UI-change requests; not installed → nothing, and no Design file is fetched', async () => {
      const { Headless } = require(path.join(at.dir, 'src', 'headless.js'));
      const entry = require(path.join(path.dirname(benchMod.harnessDesignDir()), 'page', 'shell', 'designentry.js'));
      const http = require('http');
      const fetched = [];
      const page = (installed) => `<!doctype html><html><body><nav id="tabs"><button id="tabChat">Chat</button></nav><main></main><div><button id="wsPick">pick</button></div>
<script>
  window.LAIN = { boots: [], sentFns: [], $: (id) => document.getElementById(id), el: (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; },
    icon: () => document.createElement('i'), api: async (p) => (p === '/api/design/status' ? { ok: true, installed: ${installed}, enabled: true } : { ok: false }),
    onBoot(fn) { this.boots.push(fn); }, onSent(fn) { this.sentFns.push(fn); }, hostCall: async () => null,
    nav: { t: 'chat', go(t) { this.t = t; }, tab() { return this.t; }, onShow() {}, register(t) { window.__registered = t; } } };
</script><script>${entry.js()}</script>
<script>LAIN.boots.forEach((f) => f({}));</script></body></html>`;
      const server = http.createServer((req, res) => { fetched.push(req.url); res.setHeader('content-type', 'text/html'); res.end(req.url.startsWith('/yes') ? page(true) : req.url.startsWith('/no') ? page(false) : ''); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${server.address().port}`;
      const h = await new Headless().launch({ width: 900, height: 600, dpr: 1, mobile: false });
      try {
        await h.goto(`${base}/yes`); await wait(300);
        assert.ok(await h.page.eval('!!document.getElementById("tabDesign") && !!document.getElementById("vDesign") && window.__registered === "design"'), 'the room');
        assert.ok(await h.page.eval('!!document.getElementById("wsDesign")'), 'Open in Design on the Preview');
        await h.page.eval('LAIN.sentFns.forEach((f) => f("make the avatar bigger"))');
        assert.ok(!(await h.page.eval('!!document.getElementById("dzChip")')), 'not after one');
        await h.page.eval('LAIN.sentFns.forEach((f) => f("and move the button to the left"))');
        assert.ok(await h.page.eval('!!document.getElementById("dzChip")'), 'after two UI-change requests in a row');
        await h.page.eval('document.querySelector("#dzChip .dz-x").click()');
        await h.page.eval('LAIN.sentFns.forEach((f) => { f("center the header"); f("bigger font"); })');
        assert.ok(!(await h.page.eval('!!document.getElementById("dzChip")')), 'dismissed stays dismissed');
        assert.ok(!fetched.some((u) => /design[/]/.test(u)), 'the surface is not fetched until the room opens');
        fetched.length = 0;
        await h.goto(`${base}/no`); await wait(300);
        assert.ok(await h.page.eval('!document.getElementById("tabDesign") && !document.getElementById("wsDesign") && !document.getElementById("vDesign")'), 'nothing added');
        await h.page.eval('LAIN.sentFns.forEach((f) => { f("move it left"); f("make it bigger"); })');
        assert.ok(await h.page.eval('!document.getElementById("dzChip") && ![...document.scripts].some((s) => /design[/]/.test(s.src)) && !window.LAIN.designUI'), 'no chip, no Design script');
        assert.deepStrictEqual(fetched.filter((u) => u !== '/no' && u !== '/favicon.ico'), [], 'no Design file requested');
      } finally { h.close(); await new Promise((r) => server.close(r)); }
    });
  }

  await test('DESIGN 7: expand-from-element (avatar → Profile), slide-left and the dropdown reveal run in a real page with no console errors', async () => {
    const root = benchMod.project('chat-messenger');
    const d = new (design.load().Design)(root);
    try {
      const T = design.load().tools;
      const p = d.project;
      const friend = p.scanElements('index.html').find((e) => e.text === 'Ada' && e.tag === 'span');
      const li = p.scanElements('index.html').find((e) => e.id === friend.parent);
      let r = p.applyEdit({ op: 'addWire', node: li.id, trigger: 'click', action: 'navigate', target: 'profile.html', transition: 'expand-from-element', duration: 280 });
      assert.ok(r.ok, r.why); assert.ok(d.commit(r).ok);
      const lib = p.scanElements('index.html').find((e) => e.text === 'Library' && e.tag === 'a');
      r = p.applyEdit({ op: 'addWire', node: lib.id, trigger: 'click', action: 'navigate', target: 'library.html', transition: 'slide-left' });
      assert.ok(r.ok, r.why); assert.ok(d.commit(r).ok);
      const out = await T.run(d, 'design_interact', { screen: 'index.html', steps: [{ action: 'click', target: { text: 'Ada' } }, { action: 'wait', ms: 200 }, { action: 'goto', url: '/index.html' }, { action: 'click', target: { text: 'Library' } }], screenshots: 'none' });
      assert.ok(!out.isError, out.output);
      const lines = out.output.split('\n');
      assert.match(lines[0], /click .*: ok · \/profile\.html \(navigated\)/);
      assert.match(lines[3], /: ok · \/library\.html \(navigated\)/);
      assert.ok(lines.every((l) => /no console errors/.test(l)), out.output);
      // the dropdown reveal: the avatar opens a menu instead
      const me = p.scanElements('index.html').find((e) => e.attrs.id === 'me');
      r = p.applyEdit({ op: 'addWire', node: me.id, trigger: 'click', action: 'toggleDropdown', items: [{ label: 'Profile', target: 'profile.html' }, { label: 'Settings', target: 'settings.html' }] });
      assert.ok(r.ok, r.why); assert.ok(d.commit(r).ok);
      fs.writeFileSync(path.join(root, 'app.js'), fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace("location.href = 'profile.html';", '/* now a menu */'));
      const dd = await T.run(d, 'design_interact', { screen: 'index.html', steps: [{ action: 'goto', url: '/index.html' }, { action: 'click', target: { selector: '#me' } }], screenshots: 'none' });
      assert.match(dd.output.split('\n')[1], /ok · \/index\.html · DOM \d+\+ \d+- [1-9]\d* attr · no console errors/, dd.output);
      const shown = await d.headless.page.eval('!document.getElementById("me-menu").hasAttribute("hidden")');
      assert.ok(shown, 'the menu is open');
    } finally { await d.close(); }
  });

  await test('DESIGN 10: a Design-session turn (mock provider) — "show a dropdown instead of navigating": edit, reload, virtual click, observation', async () => {
    const home = tmpdir('lain-design-turn-');
    const root = benchMod.project('chat-messenger');
    process.env.LAIN_PROVIDER = 'mock';
    const me = design.load().open(root).scanElements('index.html').find((e) => e.attrs.id === 'me');
    process.env.LAIN_MOCK_SCRIPT = writeScript(home, [
      { text: 'Looking.', tool_calls: [{ name: 'design_inspect', input: { node: me.id } }] },
      { text: 'Removing the hand-written navigation.', tool_calls: [{ name: 'edit_file', input: { path: 'app.js', old: "    location.href = 'profile.html';\n", new: '' } }] },
      { text: 'Adding the dropdown.', tool_calls: [{ name: 'design_flow', input: { action: 'add', node: me.id, trigger: 'click', do: 'toggleDropdown', items: [{ label: 'Profile', target: 'profile.html' }, { label: 'Settings', target: 'settings.html' }] } }] },
      { text: 'Trying it.', tool_calls: [{ name: 'design_interact', input: { screen: 'index.html', steps: [{ action: 'click', target: { selector: '#me' } }] } }] },
      { text: 'Done: the avatar opens a menu (Profile, Settings) instead of navigating.' },
    ]);
    for (const m of ['../../src/mockprovider', '../../src/provider', '../../src/turn']) delete require.cache[require.resolve(m)];
    const mock = require('../../src/mockprovider'); if (mock._reset) mock._reset();
    const { Session } = require('../../src/session');
    const { runTurn } = require('../../src/turn');
    const s = new Session({ cwd: root }); s.kind = 'design';
    const app = { session: s, cfg: { model: 'mock-model', permissionMode: 'AUTO' }, cwd: root };
    const text = design.load().context.pack(design.forProject(app, root), { prompt: 'show a dropdown instead of navigating', node: me.id, screen: 'index.html' });
    let record = null;
    try {
      for await (const ev of runTurn(s, text, { cfg: app.cfg })) if (ev.type === 'done') record = ev.record;
      assert.ok(record, 'the turn finished');
      assert.deepStrictEqual(record.toolNames.filter((n) => /^design_|edit_file/.test(n)).sort(), ['design_flow', 'design_inspect', 'design_interact', 'edit_file']);
      assert.ok(!/location\.href = 'profile\.html'/.test(fs.readFileSync(path.join(root, 'app.js'), 'utf8')), 'the navigation is gone');
      const flows = design.load().open(root).scanFlows();
      assert.ok(flows.some((w) => w.origin === 'design' && w.action === 'toggleDropdown' && w.source.elementId === 'me'));
      const ids = new Set(s.messages.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls).filter((c) => c.name === 'design_interact').map((c) => c.id));
      const msgs = s.messages.filter((m) => m.role === 'tool' && ids.has(m.tool_call_id));
      assert.ok(msgs.length, 'the observation reached the conversation');
      assert.match(String(msgs[0].content), /click .*: ok · \/index\.html · DOM .* · no console errors/);
      assert.match(String(msgs[0].content), /screenshot .*\.png/);
      const prompt = s.messages.find((m) => m.role === 'user');
      assert.match(String(prompt.content), /\[Design selection\]/);
      const pool = { ids: () => [s.id], live: (id) => (id === s.id ? { session: s, abort: null } : null) };
      const act = await require('../../src/harnessapp/routes').dispatch({ session: s, cfg: {}, pool: () => pool }, 'POST', '/api/design/activity', { session: s.id });
      assert.deepStrictEqual(act.body.calls.map((c) => c.name), ['design_inspect', 'design_flow', 'design_interact'], 'the prompt bar sees what the Agent did');
      assert.match(act.body.calls[1].text, /^wire me click → toggleDropdown/);
    } finally {
      await design.closeAll();
      delete process.env.LAIN_MOCK_SCRIPT;
    }
  });
};
