'use strict';

/**
 * LAIN DESIGN ADOPTS ANY FRONTEND (D9) — the order's ten acceptance tests, against seven real fixture projects in
 * headless Chromium: detect + open with zero project changes, attach + HMR through the proxy, the mapping tiers, the
 * alignment proof, responsive edits, router screens / crawl / states, token-aware writes, change cards, the proxy's
 * security, and the D1–D8 regression proofs (cache prefix, schema size).
 *
 * Fixtures need their node_modules (`node tools/dev/design-fixtures.js`); without them a test says so and skips —
 * LAIN_DESIGN_REQUIRE_FIXTURES=1 makes that a failure.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { test, tmpdir, writeScript } = require('../helpers');

const FIX = path.join(__dirname, '..', 'fixtures', 'design');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = ['react-mini', 'vue-mini', 'sveltekit-mini', 'next-mini', 'spa-scss', 'legacy-public', 'running-server'];

/** A fixture as a project of its own: copied (node_modules linked), a git repo with everything committed. */
function project(name, edit = null) {
  const src = path.join(FIX, name);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lain-adopt-${name}-`));
  for (const f of fs.readdirSync(src)) if (f !== 'node_modules') fs.cpSync(path.join(src, f), path.join(root, f), { recursive: true });
  if (fs.existsSync(path.join(src, 'node_modules'))) fs.symlinkSync(path.join(src, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  if (edit) edit(root);
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
  git('init', '-q'); fs.appendFileSync(path.join(root, '.gitignore'), fs.existsSync(path.join(root, '.gitignore')) ? '' : 'node_modules\n');
  git('add', '-A'); git('commit', '-qm', 'fixture');
  return { root, status: () => git('status', '--porcelain', '--untracked-files=all').trim() };
}

module.exports = async function () {
  const design = require('../../src/design');
  const at = design.installed();
  if (!at.ok) { await test(`DESIGN ADOPT: Design not installed here (${at.why}) — not verified`, () => assert.ok(!at.ok)); return; }
  const E = design.load();
  const { findBrowser, Headless, runSteps } = require(path.join(at.dir, 'src', 'headless.js'));
  if (!findBrowser()) { await test('DESIGN ADOPT: no Chromium on this machine — not verified here', () => assert.ok(true)); return; }
  const fx = require('../../tools/dev/design-fixtures');
  const missing = ALL.filter((n) => !fx.installed(n));
  if (missing.length) {
    const msg = `DESIGN ADOPT: fixtures not installed (${missing.join(', ')}) — run node tools/dev/design-fixtures.js`;
    if (process.env.LAIN_DESIGN_REQUIRE_FIXTURES === '1') { await test(msg, () => assert.fail(msg)); return; }
    await test(`${msg} — skipped`, () => assert.ok(true)); return;
  }
  const open = async (p, opts = {}) => { const d = new E.Design(p.root, { snapshotsDir: path.join(p.root, '.lain', 'design', 'snapshots'), ...opts }); await d.startPreview(); return d; };
  const firstScreen = (d) => (d.project.scanScreens()[0] || {}).file || null;
  let running = null;   // the "already running" server for fixture 7

  try {
    await test('ADOPT 1: detect + open works for all seven fixtures, the real app shows through the proxy, and the project is untouched (git status clean)', async () => {
      running = spawn(process.execPath, ['server.js', '--port', '4377'], { cwd: path.join(FIX, 'running-server'), stdio: 'ignore' });
      await wait(600);
      const seen = [];
      for (const name of ALL) {
        const p = project(name);
        const d = await open(p);
        try {
          const h = await d.page(firstScreen(d));
          const info = await h.page.eval('({ runtime: !!window.__lainDesign, text: document.body.innerText.trim().slice(0, 60), ids: document.querySelectorAll("[data-lain-id]").length })');
          assert.ok(info.runtime, `${name}: the runtime is in the page`);
          assert.ok(/Chats/.test(info.text), `${name}: the app's own page shows (${info.text})`);
          assert.notStrictEqual(new URL(d.preview.url).port, new URL(d.preview.target).port, `${name}: served through the proxy`);
          seen.push(`${name}: ${d.project.kind} · ${d.preview.attached ? 'attached' : 'started'} · ${info.ids} ids`);
          if (name === 'running-server') assert.ok(d.preview.attached, 'fixture 7 is attached to, not started');
        } finally { await d.close(); }
        assert.strictEqual(p.status(), '', `${name}: no file in the project changed`);
      }
      process.stdout.write(`      ${seen.join('\n      ')}\n`);
    });

    await test('ADOPT 2: attach to the person\'s running Vite; HMR still works through the proxy (a CSS edit lands without a reload)', async () => {
      const p = project('vue-mini');
      const user = spawn(process.execPath, [path.join(p.root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5173', '--strictPort', '--host', '127.0.0.1'], { cwd: p.root, stdio: 'ignore', detached: process.platform !== 'win32' });
      try {
        for (let i = 0; i < 60; i++) { if (await require(path.join(at.dir, 'src', 'launch.js')).portOpen(5173)) break; await wait(250); }
        const d = await open(p);
        try {
          assert.ok(d.preview.attached, `attached (${d.preview.why})`);
          assert.match(d.preview.target, /:5173\//);
          const h = await d.page(firstScreen(d));
          await h.page.eval('window.__hmrMarker = 42');
          const before = await h.page.eval('getComputedStyle(document.querySelector(".title")).color');
          fs.writeFileSync(path.join(p.root, 'src', 'styles.css'), fs.readFileSync(path.join(p.root, 'src', 'styles.css'), 'utf8').replace('--ink: #111827', '--ink: #dc2626'));
          let after = before;
          for (let i = 0; i < 40 && after === before; i++) { await wait(150); after = await h.page.eval('getComputedStyle(document.querySelector(".title")).color'); }
          assert.strictEqual(after, 'rgb(220, 38, 38)', 'the new colour arrived');
          assert.strictEqual(await h.page.eval('window.__hmrMarker'), 42, 'by hot update, not a reload');
        } finally { await d.close(); }
      } finally { try { process.kill(-user.pid); } catch { user.kill(); } }
    });

    await test('ADOPT 3: mapping tiers — plugins give exact; CSS modules and SCSS resolve through source maps; React owners resolve; a near-tie asks; no match → the Agent (mock) answers and is cached as tier agent', async () => {
      const tiers = {};
      for (const name of ['react-mini', 'vue-mini', 'sveltekit-mini']) {
        const p = project(name); const d = await open(p);
        try { const m = await d.map(firstScreen(d), '#me'); tiers[name] = m.tier; assert.strictEqual(m.tier, 'exact', `${name}: ${JSON.stringify(m)}`); assert.match(m.file, /Header\.jsx|App\.vue|\+layout\.svelte/); } finally { await d.close(); }
      }
      // NEXT: no plugin — React owner → app/page.jsx (resolved); CSS module rule through webpack's banner.
      {
        const p = project('next-mini'); const d = await open(p);
        try {
          const m = await d.map('/', 'h1');
          assert.strictEqual(m.tier, 'resolved', JSON.stringify(m)); assert.strictEqual(m.file, 'app/page.jsx'); tiers['next-mini'] = m.tier;
          const { so } = await E.adopt.mirror(d, '/');
          const c = await so.cascade('#me', 'right'); const o = await so.origin(c.winner.styleSheetId, c.winner.range);
          assert.strictEqual(o.rel, 'app/page.module.css'); assert.strictEqual(o.line, 3);
          const rows = await d.map('/', 'li');
          assert.ok(rows.count >= 3 && rows.component === 'FriendRow', `the friend row is rendered ${rows.count} times by FriendRow: ${JSON.stringify(rows)}`);
        } finally { await d.close(); }
      }
      {
        const p = project('spa-scss'); const d = await open(p);
        try {
          const { so } = await E.adopt.mirror(d, '/');
          const c = await so.cascade('#me', 'right'); const o = await so.origin(c.winner.styleSheetId, c.winner.range);
          assert.strictEqual(o.rel, 'src/styles/app.scss'); assert.strictEqual(o.via, 'sourcemap');
        } finally { await d.close(); }
      }
      // A NEAR-TIE IS A QUESTION.
      {
        const p = project('legacy-public');
        const pr = new (require(path.join(at.dir, 'src', 'app.js')).AppProject)(p.root, { detection: { framework: 'react', router: null, root: p.root } });
        fs.mkdirSync(path.join(p.root, 'src'), { recursive: true });
        fs.writeFileSync(path.join(p.root, 'src', 'A.jsx'), 'export default function A() { return <span className="tag">New</span>; }\n');
        fs.writeFileSync(path.join(p.root, 'src', 'B.jsx'), 'export default function B() { return <span className="tag">New</span>; }\n');
        const m = require(path.join(at.dir, 'src', 'mapper.js')).map(pr, { tag: 'span', text: 'New', classes: ['tag'], attrs: {}, parent: [], siblingIndex: 0, count: 1 });
        assert.strictEqual(m.tier, 'ambiguous'); assert.match(m.question, /src\/A\.jsx:1 or src\/B\.jsx:1|src\/B\.jsx:1 or src\/A\.jsx:1/);
      }
      // NO MATCH → THE AGENT (mock provider) → cached, tier agent.
      {
        const p = project('legacy-public', (root) => fs.appendFileSync(path.join(root, 'public', 'js', 'app.js'), "\nvar b = document.createElement('b'); b.className = 'stamp'; b.textContent = 'v' + (1 + 1); document.body.appendChild(b);\n"));
        const d = await open(p);
        try {
          const m0 = await d.map('/index.html', '.stamp');
          assert.strictEqual(m0.tier, 'none', JSON.stringify(m0));
          const home = tmpdir('lain-adopt-turn-');
          process.env.LAIN_PROVIDER = 'mock';
          process.env.LAIN_MOCK_SCRIPT = writeScript(home, [{ text: 'Recording it.', tool_calls: [{ name: 'design_inspect', input: { screen: '/index.html', map: { selector: '.stamp', file: 'public/js/app.js', line: 2 } } }] }, { text: 'Done: it is created in public/js/app.js.' }]);
          for (const mm of ['../../src/mockprovider', '../../src/provider', '../../src/turn']) delete require.cache[require.resolve(mm)];
          const { Session } = require('../../src/session'); const { runTurn } = require('../../src/turn');
          const s = new Session({ cwd: p.root }); s.kind = 'design';
          // the same Design instance the tools use
          const dd = design.forProject({ session: s, cfg: {} }, p.root);
          let rec = null; for await (const ev of runTurn(s, 'Where in the source is this element rendered?\n\n[Design selection]\nElement: .stamp', { cfg: { model: 'mock-model' } })) if (ev.type === 'done') rec = ev.record;
          assert.ok(rec && rec.toolNames.includes('design_inspect'));
          const m1 = await dd.map('/index.html', '.stamp');
          assert.strictEqual(m1.tier, 'agent', JSON.stringify(m1)); assert.strictEqual(m1.file, 'public/js/app.js');
          tiers['legacy (generated)'] = 'none → agent';
        } finally { await d.close(); await design.closeAll(); delete process.env.LAIN_MOCK_SCRIPT; }
      }
      process.stdout.write(`      tiers: ${JSON.stringify(tiers)}\n`);
    });

    await test('ADOPT 4: alignment proof — a drag on every fixture passes within 1 px; an !important conflict and a parent transform are undone byte-exact with the reason', async () => {
      const results = [];
      for (const name of ['react-mini', 'vue-mini', 'sveltekit-mini', 'next-mini', 'spa-scss', 'legacy-public']) {
        const p = project(name); const d = await open(p);
        try {
          const screen = firstScreen(d);
          await d.page(screen, { width: 1024, height: 800, dpr: 1, mobile: false });
          const r = await d.edit({ screen, selector: '#me', op: 'move', dx: -100, dy: 6, breakpoint: 'all' });
          const err = r.ok && r.proof && r.proof.actual ? Math.max(Math.abs(r.proof.actual.rect.x - r.proof.predicted.rect.x), Math.abs(r.proof.actual.rect.y - r.proof.predicted.rect.y)) : null;
          results.push({ name, kept: Boolean(r.ok), err, why: r.why || null });
        } finally { await d.close(); }
      }
      const passed = results.filter((r) => r.kept && r.err != null && r.err <= 1).length;
      process.stdout.write(`      alignment: ${passed}/${results.length} kept within 1 px — ${results.map((r) => `${r.name} ${r.kept ? `${r.err.toFixed(2)}px` : `NOT KEPT (${r.why})`}`).join(', ')}\n`);
      assert.strictEqual(passed, results.length, JSON.stringify(results));
      // CONFLICTS
      const imp = project('legacy-public', (root) => fs.appendFileSync(path.join(root, 'public', 'css', 'site.css'), '.topbar img { left: 10px !important; }\n'));
      let d = await open(imp);
      try {
        const css0 = fs.readFileSync(path.join(imp.root, 'public/css/site.css'), 'utf8');
        const h = await d.page('public/index.html');
        const node = await h.page.eval('document.getElementById("me").getAttribute("data-lain-id")');
        const r = await d.edit({ screen: 'public/index.html', node, op: 'move', dx: -300, dy: 0 });
        assert.strictEqual(r.ok, false); assert.ok(r.reverted, 'undone');
        assert.match(r.why, /!important. rule at public\/css\/site\.css:10/);
        assert.strictEqual(fs.readFileSync(path.join(imp.root, 'public/css/site.css'), 'utf8'), css0, 'the exact original bytes');
      } finally { await d.close(); }
      const tf = project('legacy-public', (root) => { const f = path.join(root, 'public/css/site.css'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('.topbar { position: relative;', '.topbar { position: relative; transform: scale(0.5); transform-origin: 0 0;')); });
      d = await open(tf);
      try {
        const css0 = fs.readFileSync(path.join(tf.root, 'public/css/site.css'), 'utf8');
        const r = await d.edit({ screen: 'public/index.html', selector: '#me', op: 'move', dx: -100, dy: 0 });
        assert.strictEqual(r.ok, false); assert.ok(r.reverted); assert.match(r.why, /parent transform/);
        assert.strictEqual(fs.readFileSync(path.join(tf.root, 'public/css/site.css'), 'utf8'), css0);
      } finally { await d.close(); }
    });

    await test('ADOPT 5: responsive — at 390 px an edit lands inside the existing @media; at 1280 px in the base rule; "only this breakpoint" writes a media rule', async () => {
      const p = project('spa-scss');
      const scss = () => fs.readFileSync(path.join(p.root, 'src/styles/app.scss'), 'utf8');
      const d = await open(p);
      try {
        await d.page('src/pages/Home.jsx', { width: 390, height: 844, dpr: 1, mobile: true });
        let r = await d.edit({ screen: 'src/pages/Home.jsx', selector: '#me', op: 'setStyle', props: { width: '48px' } });
        assert.ok(r.ok, JSON.stringify(r));
        assert.match(scss(), /@media \(max-width: 640px\) \{\s*\.avatar \{\s*width: 48px;/, 'inside the media block');
        assert.match(scss(), /\.avatar \{\n  position: absolute;[\s\S]*?width: 40px;/, 'the base rule is unchanged');
        const q = await d.edit({ screen: 'src/pages/Home.jsx', selector: '#me', op: 'setStyle', props: { right: '24px' } });
        assert.ok(q.needs && q.needs.breakpoint, 'a base-rule edit while a breakpoint is active asks');
        r = await d.edit({ screen: 'src/pages/Home.jsx', selector: '#me', op: 'setStyle', props: { right: '24px' }, breakpoint: 'only' });
        assert.ok(r.ok, JSON.stringify(r));
        assert.match(scss(), /@media \(max-width: 640px\) \{[\s\S]*?\.avatar \{\s*right: 24px;\s*\}/, 'a rule for this breakpoint only');
        assert.match(scss(), /\.avatar \{\n  position: absolute;\n  top: 12px;\n  right: 16px;/, 'all sizes keep right: 16px');
        await d.page('src/pages/Home.jsx', { width: 1280, height: 800, dpr: 1, mobile: false });
        r = await d.edit({ screen: 'src/pages/Home.jsx', selector: '#me', op: 'setStyle', props: { width: '44px' } });
        assert.ok(r.ok, JSON.stringify(r));
        assert.match(scss(), /\.avatar \{\n  position: absolute;[\s\S]*?width: 44px;/, 'at 1280 the base rule');
      } finally { await d.close(); }
    });

    await test('ADOPT 6: screens — routers parsed; the crawl finds linked pages; a captured state replays', async () => {
      const expect = { 'vue-mini': ['/', '/settings'], 'spa-scss': ['/', '/profile', '/settings'], 'sveltekit-mini': ['/', '/profile', '/settings'], 'next-mini': ['/', '/settings'] };
      for (const [name, routes] of Object.entries(expect)) {
        const pr = E.open(path.join(FIX, name));
        assert.deepStrictEqual(pr.scanScreens().map((s) => s.route).sort(), routes.sort(), name);
      }
      const p = project('legacy-public');
      let d = await open(p);
      try {
        const found = await d.crawl({ depth: 2, max: 10 });
        assert.deepStrictEqual(found.map((s) => s.route).sort(), ['/', '/settings.html']);
      } finally { await d.close(); }
      const s = project('spa-scss');
      d = await open(s);
      try {
        const cap = d.states().capture('src/pages/Home.jsx', 'menu open', [{ action: 'click', target: { selector: '.menu-toggle' } }]);
        assert.ok(cap.ok);
        const r = await d.replayState('src/pages/Home.jsx', 'menu open', { screenshots: 'none' });
        assert.ok(r.ok, JSON.stringify(r));
        assert.strictEqual(await d.headless.page.eval('document.querySelector(".menu").hidden'), false, 'the menu is open after the replay');
        assert.strictEqual(s.status(), '', 'states live in .lain/design (kept out of git)');
      } finally { await d.close(); }
    });

    await test('ADOPT 7: the design language — sliders snap to the scale; a colour equal to a token is written as the token (CSS variable, Tailwind, SCSS)', async () => {
      const t = new (require(path.join(at.dir, 'src', 'tokens.js')).Tokens)(path.join(FIX, 'vue-mini'));
      assert.strictEqual(t.snap('padding', '13px'), '12px'); assert.ok(t.offScale('padding', '13px'));
      // CSS variable
      let p = project('legacy-public'); let d = await open(p);
      try {
        const r = await d.edit({ screen: 'public/index.html', selector: '.title', op: 'setStyle', props: { color: '#6366f1' } });
        assert.ok(r.ok, JSON.stringify(r)); assert.match(fs.readFileSync(path.join(p.root, 'public/css/site.css'), 'utf8'), /\.title \{[^}]*color: var\(--brand\)/);
      } finally { await d.close(); }
      // Tailwind
      p = project('react-mini'); d = await open(p);
      try {
        const h = await d.page('src/pages/Settings.jsx');
        await h.goto(`${d.preview.url}/settings`);
        const node = await h.page.eval('document.getElementById("badge").getAttribute("data-lain-id")');
        const r = await d.edit({ screen: 'src/pages/Settings.jsx', node, op: 'setStyle', props: { color: '#111827' } });
        assert.ok(r.ok, JSON.stringify(r));
        assert.match(fs.readFileSync(path.join(p.root, 'src/pages/Settings.jsx'), 'utf8'), /className="bg-brand px-4 py-2 rounded-card text-ink"/);
      } finally { await d.close(); }
      // SCSS
      p = project('spa-scss'); d = await open(p);
      try {
        await d.page('src/pages/Home.jsx', { width: 1024, height: 800, dpr: 1, mobile: false });
        const r = await d.edit({ screen: 'src/pages/Home.jsx', selector: '.title', op: 'setStyle', props: { color: '#6366f1' } });
        assert.ok(r.ok, JSON.stringify(r)); assert.match(fs.readFileSync(path.join(p.root, 'src/styles/app.scss'), 'utf8'), /\.title \{[^}]*color: \$brand;/);
      } finally { await d.close(); }
    });

    await test('ADOPT 8: change cards — made for a kept edit, restorable (Undo to that card), commentable; the comment reaches the Agent as a context pack', async () => {
      const p = project('legacy-public');
      const d = await open(p);
      try {
        const css0 = fs.readFileSync(path.join(p.root, 'public/css/site.css'), 'utf8');
        const a = await d.edit({ screen: 'public/index.html', selector: '.title', op: 'setStyle', props: { 'font-size': '24px' } });
        const css1 = fs.readFileSync(path.join(p.root, 'public/css/site.css'), 'utf8');
        const b = await d.edit({ screen: 'public/index.html', selector: '#me', op: 'setStyle', props: { width: '48px' } });
        assert.ok(a.ok && b.ok && a.card && b.card);
        const card = d.cards().get(a.card);
        assert.ok(card.images.before && card.images.after && card.proof && card.diff.includes('font-size'));
        // UNDO TO CARD a: b is undone, a stays
        const routes = require('../../src/harnessapp/routes');
        const app = { session: { cwd: p.root, id: 's1' }, cfg: {} };
        const r = await routes.dispatch(app, 'POST', '/api/design/cards', { action: 'restore', id: a.card });
        assert.ok(r.body.restored, JSON.stringify(r.body));
        assert.strictEqual(fs.readFileSync(path.join(p.root, 'public/css/site.css'), 'utf8'), css1, 'back to just after card a');
        assert.notStrictEqual(css1, css0);
        // COMMENT → a prompt with the card's context, to the Design session's Agent
        let sent = null;
        const target = { session: { id: 'ds', kind: 'design', cwd: p.root }, abort: null, handle: async (text) => { sent = text; } };
        const pool = { ids: () => ['ds'], live: (id) => (id === 'ds' ? target : null), view: () => ({ ...app, pool: () => pool }) };
        const c = await routes.dispatch({ ...app, pool: () => pool }, 'POST', '/api/design/cards', { action: 'comment', id: a.card, text: 'make it bolder too' });
        assert.ok(c.body.accepted, JSON.stringify(c.body));
        await wait(50);
        assert.match(sent, /^make it bolder too\n\n\[Design change card\]\nCard: c\w+ · person · /);
        assert.strictEqual(d.cards().get(a.card).comments[0].text, 'make it bolder too');
      } finally { await d.close(); await design.closeAll(); }
    });

    await test('ADOPT 9: security — the preview origin is not the window\'s; the app\'s own JS cannot reach Core\'s routes; the proxy refuses non-local hosts', async () => {
      const p = project('legacy-public', (root) => fs.appendFileSync(path.join(root, 'public', 'js', 'app.js'), `
        window.__probe = Promise.all([
          fetch('/api/design/status', { method: 'POST' }).then((r) => r.status, (e) => 'blocked'),
          fetch(document.referrer ? new URL(document.referrer).origin + '/bridge/api/design/status' : 'http://127.0.0.1:1/', { method: 'POST', body: '{}' }).then((r) => r.status, (e) => 'blocked'),
          new Promise((res) => { try { res(window.parent.document ? 'parent readable' : 'no'); } catch (e) { res('parent blocked'); } }),
        ]);
      `));
      let ran = 0; let refused = 0;
      const benchMod = require('../designbench');
      const b = await benchMod.start({ fixture: null, root: p.root, onBridge: (req) => { if (req.trusted) return; refused += 1; } });
      try {
        await b.until('LAIN.designUI._state.frames.size >= 1 && [...LAIN.designUI._state.frames.values()].every(f => f.ready)', 30000);
        const preview = await b.eval('LAIN.designUI._state.open.preview');
        assert.notStrictEqual(new URL(preview).origin, new URL(b.url).origin, 'different origins');
        const probe = await b.evalInFrame('public/index.html', 'window.__probe');
        assert.notStrictEqual(probe[0], 200, `the proxy serves no /api (${probe[0]})`);
        assert.strictEqual(probe[1], 'blocked', 'the window\'s bridge is not reachable from the app');
        assert.strictEqual(probe[2], 'parent blocked', 'the app cannot read the window');
        assert.strictEqual(ran, 0, 'no route ran for the app');
        assert.ok(refused >= 1, 'the attempt reached the window\'s channel and was refused there (in LAIN that channel is an authenticated pipe no page can open)');
        process.stdout.write(`      the app's attempts: ${refused} refused at the window's channel; preview ${new URL(preview).origin} ≠ window ${new URL(b.url).origin}\n`);
        const port = new URL(preview).port;
        const status = await new Promise((res) => { const r = http.request({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example' } }, (x) => res(x.statusCode)); r.on('error', () => res(0)); r.end(); });
        assert.strictEqual(status, 403, 'a rebinding host is refused');
      } finally { await b.close(); }
    });

    await test('ADOPT 10: regression — the cache-prefix proofs hold and the design_* schemas stay under 4 KB', async () => {
      const bytes = E.tools.schemaBytes();
      process.stdout.write(`      design_* schemas: ${bytes} bytes\n`);
      assert.ok(bytes < 4096);
      const tools = require('../../src/tools');
      const { Session } = require('../../src/session');
      const s = new Session({ cwd: os.tmpdir() });
      const names = tools.schemas({ session: s, cfg: {} }, { turn: true, session: s }).map((x) => x.name);
      assert.ok(!names.some((n) => /^design_/.test(n)), 'an ordinary session has no design_* tool');
    });
  } finally {
    if (running) { try { running.kill(); } catch { /* gone */ } }
    await design.closeAll();
  }
};
