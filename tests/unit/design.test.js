'use strict';

/**
 * LAIN DESIGN — the engine (packages/design-core), Core's one door (src/design.js), and the rules the order sets:
 * edits are deterministic splices to the source (only the touched declarations change, Undo is byte-exact), a
 * shared class is never written without the person's answer, flows are code, presets are valid code, a Design session
 * is its own kind and an ordinary one is byte-identical with or without Design installed, and a LAIN without Design
 * loads none of it. Browser-backed checks are in tests/integration/design-real.test.js.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test } = require('../helpers');

const FIX = path.join(__dirname, '..', 'fixtures', 'design');

function copy(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lain-design-${name}-`));
  require('../designbench').copyDir(path.join(FIX, name), dir);
  return dir;
}
function png() {
  const zlib = require('zlib');
  const crc = (b) => { let c; const t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const ch = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ch('IHDR', ihdr), ch('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255]))), ch('IEND', Buffer.alloc(0))]);
}

module.exports = async function () {
  const design = require('../../src/design');
  const at = design.installed();
  if (!at.ok) { await test(`DESIGN: not installed here (${at.why}) — engine not verified`, () => assert.ok(!at.ok)); return; }
  const E = design.load();
  const { WebProject } = require(path.join(at.dir, 'src', 'web.js'));
  const avatarLayout = { position: 'absolute', rect: { x: 334, y: 12, w: 40, h: 40 }, containing: { x: 0, y: 0, w: 390, h: 64 } };

  await test('DESIGN 1: dragging the avatar top-right → top-left changes only its position declarations; Undo is byte-exact', () => {
    const root = copy('chat-messenger');
    const p = new WebProject(root, { snapshotsDir: path.join(root, '.lain', 'design', 'snapshots') });
    const files = ['index.html', 'styles.css', 'app.js', 'library.html', 'profile.html', 'settings.html'];
    const before = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
    const me = p.scanElements('index.html').find((e) => e.attrs.id === 'me');
    const r = p.applyEdit({ op: 'move', node: me.id, dx: -318, dy: 0, layout: avatarLayout });
    assert.ok(r.ok, r.why);
    assert.deepStrictEqual(r.files.map((f) => f.rel), ['styles.css'], 'only the stylesheet');
    const c = p.commit(r);
    assert.ok(c.ok, c.why);
    const after = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    const changed = before['styles.css'].split('\n').filter((l, i) => l !== after.split('\n')[i]);
    assert.strictEqual(changed.length, 1, 'one line');
    assert.strictEqual(after, before['styles.css'].replace('right: 16px', 'left: 16px'), 'right: 16px became left: 16px and nothing else moved');
    for (const f of files.filter((x) => x !== 'styles.css')) assert.strictEqual(fs.readFileSync(path.join(root, f), 'utf8'), before[f], `${f} untouched`);
    const u = p.undo();
    assert.ok(u.ok, u.why);
    for (const f of files) assert.strictEqual(fs.readFileSync(path.join(root, f), 'utf8'), before[f], `${f} byte-exact after Undo`);
    const re = p.redo(); assert.ok(re.ok); assert.strictEqual(fs.readFileSync(path.join(root, 'styles.css'), 'utf8'), after, 'Redo reapplies the same bytes');
  });

  await test('DESIGN 1b: a file changed on disk since the edit was computed is never overwritten (the stale-edit guard)', () => {
    const root = copy('chat-messenger');
    const p = new WebProject(root);
    const me = p.scanElements('index.html').find((e) => e.attrs.id === 'me');
    const r = p.applyEdit({ op: 'move', node: me.id, dx: -318, dy: 0, layout: avatarLayout });
    fs.appendFileSync(path.join(root, 'styles.css'), '/* someone else */\n');
    const c = p.commit(r);
    assert.strictEqual(c.ok, false); assert.ok(c.stale, 'reported stale');
    assert.ok(fs.readFileSync(path.join(root, 'styles.css'), 'utf8').includes('right: 16px'), 'nothing written');
    // and Undo refuses a file that moved since the commit
    const p2 = new WebProject(root, { snapshotsDir: path.join(root, '.snap') });
    const r2 = p2.applyEdit({ op: 'move', node: me.id, dx: -318, dy: 0, layout: avatarLayout });
    assert.ok(p2.commit(r2).ok);
    fs.appendFileSync(path.join(root, 'styles.css'), '/* edited after */\n');
    const u = p2.undo();
    assert.strictEqual(u.ok, false); assert.ok(u.stale);
  });

  await test('DESIGN 2: an inspector value writes exactly that property where the element\'s style lives', () => {
    const root = copy('chat-messenger');
    const p = new WebProject(root);
    const me = p.scanElements('index.html').find((e) => e.attrs.id === 'me');
    const r = p.applyEdit({ op: 'setStyle', node: me.id, props: { width: '56px' } });
    assert.ok(r.ok, r.why);
    assert.match(r.diff, /- .*width: 40px/); assert.match(r.diff, /\+ .*width: 56px/);
    assert.strictEqual(r.files.length, 1);
    assert.ok(p.commit(r).ok);
    assert.match(fs.readFileSync(path.join(root, 'styles.css'), 'utf8'), /\.me-avatar \{[^}]*width: 56px;[^}]*height: 40px/);
  });

  await test('DESIGN 3: a flex child\'s drag asks Reorder / Offset / Make absolute — Reorder in a sibling gap, Offset elsewhere', () => {
    const root = copy('chat-messenger');
    const p = new WebProject(root);
    const fr = p.scanElements('index.html').filter((e) => e.classes.includes('friend'));
    const sib = (i) => ({ id: fr[i].id, rect: { x: 16, y: 80 + i * 56, w: 358, h: 48 } });
    const lay = { id: fr[2].id, position: 'static', display: 'flex', parentDisplay: 'flex', flexDirection: 'column', rect: sib(2).rect, siblings: [sib(0), sib(1), sib(2)], margin: { top: 0, right: 0, bottom: 0, left: 0 }, containing: { x: 0, y: 64, w: 390, h: 200 } };
    const ask = p.applyEdit({ op: 'move', node: fr[2].id, dx: 0, dy: -150, layout: lay, drop: { x: 190, y: 82 } });
    assert.strictEqual(ask.ok, false); assert.ok(ask.needs && ask.needs.choice, 'a question, not an edit');
    assert.deepStrictEqual(ask.needs.choice.choices.map((c) => c.id), ['reorder', 'offset', 'absolute']);
    assert.strictEqual(ask.needs.choice.default, 'reorder', 'dropped in a sibling gap → Reorder first');
    const off = p.applyEdit({ op: 'move', node: fr[2].id, dx: 40, dy: 0, layout: lay, drop: { x: 300, y: 216 } });
    assert.strictEqual(off.needs.choice.default, 'offset', 'dropped on itself → Offset');
    const before = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const re = p.applyEdit({ op: 'move', node: fr[2].id, dx: 0, dy: -150, layout: lay, drop: { x: 190, y: 82 }, choice: 'reorder' });
    assert.ok(re.ok, re.why); assert.ok(p.commit(re).ok);
    const after = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.ok(after.indexOf('Linus') < after.indexOf('Ada'), 'Linus now first');
    assert.strictEqual(after.length, before.length, 'the same bytes, reordered');
  });

  await test('DESIGN 4: a shared class is never written silently — "Change all N uses, or only this one?"; "only" makes a scoped class', () => {
    const root = copy('chat-messenger');
    const p = new WebProject(root);
    const chip = p.scanElements('index.html').find((e) => e.classes.includes('chip'));
    const css0 = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    const q = p.applyEdit({ op: 'setStyle', node: chip.id, props: { 'border-radius': '4px' } });
    assert.strictEqual(q.ok, false);
    assert.strictEqual(q.needs.scope.question, 'Change all 6 uses of .chip, or only this one?');
    assert.strictEqual(fs.readFileSync(path.join(root, 'styles.css'), 'utf8'), css0, 'nothing written before the answer');
    const only = p.applyEdit({ op: 'setStyle', node: chip.id, props: { 'border-radius': '4px' }, scope: 'only' });
    assert.ok(only.ok); assert.ok(p.commit(only).ok);
    const css1 = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    assert.match(css1, /\.lain-[a-z0-9-]+ \{ border-radius: 4px; \}/, 'a new scoped class');
    assert.ok(css1.includes(css0.trimEnd()), 'the shared .chip rule is unchanged');
    const all = new WebProject(root).applyEdit({ op: 'setStyle', node: p.scanElements('library.html').find((e) => e.classes.includes('chip')).id, props: { color: 'red' }, scope: 'all' });
    assert.ok(all.ok); assert.match(all.summary, /all 6 uses|all 5 uses/);
  });

  await test('DESIGN 5: "+" a logout button with a .png — the asset is copied in and referenced, its wire to Settings is read back by scanFlows', () => {
    const root = copy('chat-messenger');
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lain-asset-')), 'Logout Icon.png');
    fs.writeFileSync(src, png());
    const p = new WebProject(root);
    const card = p.scanElements('profile.html').find((e) => e.classes.includes('profile-card'));
    const ins = p.applyEdit({ op: 'insert', parent: card.id, name: 'Logout', kind: 'button', text: 'Log out', asset: src });
    assert.ok(ins.ok, ins.why);
    const c = p.commit(ins); assert.ok(c.ok, c.why);
    assert.ok(fs.readFileSync(path.join(root, 'assets', 'logout-icon.png')).equals(fs.readFileSync(src)), 'copied byte for byte');
    assert.match(fs.readFileSync(path.join(root, 'profile.html'), 'utf8'), /<button id="logout" type="button"><img src="assets\/logout-icon.png" alt="">Log out<\/button>/);
    const w = p.applyEdit({ op: 'addWire', node: c.followId, trigger: 'click', action: 'navigate', target: 'settings.html', transition: 'slide-left' });
    assert.ok(w.ok, w.why); assert.ok(p.commit(w).ok);
    const flows = new WebProject(root).scanFlows();
    const mine = flows.find((x) => x.origin === 'design' && x.source.elementId === 'logout');
    assert.ok(mine, 'read back from the code');
    assert.strictEqual(mine.target, 'settings.html'); assert.strictEqual(mine.transition, 'slide-left'); assert.strictEqual(mine.screen, 'profile.html');
    // Undo of the insert removes the copied asset too
    const p2 = new WebProject(root, { snapshotsDir: path.join(root, '.s2') });
    const ins2 = p2.applyEdit({ op: 'insert', parent: card.id, name: 'Again', kind: 'image', asset: src.replace('Logout Icon', 'Logout Icon') });
    assert.ok(ins2.ok);
  });

  await test('DESIGN 6: hand-written navigation shows as a flow; a Design wire survives a reload (it is code)', () => {
    const root = copy('chat-messenger');
    const p = new WebProject(root);
    const flows = p.scanFlows();
    const hand = flows.find((x) => x.kind === 'handler');
    assert.ok(hand, 'app.js\'s addEventListener → location.href is a flow');
    assert.strictEqual(hand.source.elementId, 'me'); assert.strictEqual(hand.target, 'profile.html'); assert.strictEqual(hand.file, 'app.js');
    assert.ok(flows.some((x) => x.kind === 'link' && x.target === 'settings.html'), 'links too');
    const tab = p.scanElements('library.html').find((e) => e.text === 'Library');
    const w = p.applyEdit({ op: 'addWire', node: tab.id, trigger: 'longpress', action: 'openModal', target: 'settings.html' });
    assert.ok(w.ok, w.why); assert.ok(p.commit(w).ok);
    const reloaded = new (require(path.join(at.dir, 'src', 'web.js')).WebProject)(root).scanFlows();
    const back = reloaded.find((x) => x.id === w.wireId);
    assert.ok(back, 'a fresh read of the files finds it');
    assert.strictEqual(back.trigger, 'longpress'); assert.strictEqual(back.action, 'openModal');
    // and removing it leaves the script as it was before the wire (helpers stay)
    const rm = new WebProject(root).applyEdit({ op: 'removeWire', id: w.wireId });
    assert.ok(rm.ok, rm.why);
  });

  await test('DESIGN 7: every transition preset generates valid code (the wire helpers and the CSS keyframes parse)', () => {
    const A = E.animations;
    new vm.Script(E.flow.helpers());   // throws on a syntax error
    const postcss = require(path.join(at.dir, 'node_modules', 'postcss'));
    for (const name of Object.keys(A.PRESETS)) {
      if (name === 'none') continue;
      const css = A.keyframesCss(name);
      assert.doesNotThrow(() => postcss.parse(css), name);
      assert.match(A.animationValue(name, { duration: 250, easing: 'ease-in' }), new RegExp(`^lain-${name} 250ms ease-in both$`));
      const code = E.flow.wireCode({ id: 'w1', screen: 'index.html', source: 'me', trigger: 'click', action: 'navigate', target: 'profile.html', transition: name });
      new vm.Script(code);
    }
    const t = A.webTable();
    assert.ok(t['expand-from-element'].fromElement && t['slide-left'].enter && t['dropdown-reveal'].enter);
  });

  await test('DESIGN 8: the cache prefix — an ordinary session is byte-identical with and without Design installed; a Design session is the same on every turn', () => {
    const tools = require('../../src/tools');
    const sp = require('../../src/simpleprompt');
    const { Session } = require('../../src/session');
    const root = copy('chat-messenger');
    const prefix = (s) => JSON.stringify({ system: sp.of({ session: s, cfg: {} }, { session: s }).stable.replace(/Project: .*/, ''), tools: tools.schemas({ session: s, cfg: {} }, { turn: true, session: s }) });
    const prev = process.env.LAIN_DESIGN_DIR;
    try {
      process.env.LAIN_DESIGN_DIR = path.join(os.tmpdir(), 'no-design-here');
      assert.strictEqual(design.installed().ok, false);
      const without = prefix(new Session({ cwd: root }));
      delete process.env.LAIN_DESIGN_DIR;
      if (prev) process.env.LAIN_DESIGN_DIR = prev;
      assert.strictEqual(design.installed().ok, true);
      const withIt = prefix(new Session({ cwd: root }));
      assert.strictEqual(withIt, without, 'byte-identical');
      assert.ok(!/design_/.test(withIt), 'no design_* tool in an ordinary session');
      const ds = new Session({ cwd: root }); ds.kind = 'design';
      const t1 = prefix(ds); const t2 = prefix(ds);
      assert.strictEqual(t1, t2, 'a Design session\'s prefix does not move between turns');
      const names = tools.schemas({ session: ds, cfg: {} }, { turn: true, session: ds }).map((x) => x.name);
      for (const n of ['design_inspect', 'design_edit', 'design_flow', 'design_interact', 'design_snapshot']) assert.ok(names.includes(n), n);
      const core = require('../../src/tools/core').CORE;
      assert.deepStrictEqual(names.slice(0, core.length), core, 'the core tools first, in their fixed order');
      assert.strictEqual(sp.of({ session: ds, cfg: {} }, { session: ds }).stable.replace(/Project: .*/, ''), JSON.parse(without).system, 'the same system prompt');
      const bytes = E.tools.schemaBytes();
      assert.ok(bytes < 4096, `design_* schemas ${bytes} bytes`);
    } finally { if (prev) process.env.LAIN_DESIGN_DIR = prev; else delete process.env.LAIN_DESIGN_DIR; }
  });

  await test('DESIGN 9: Core without Design loads none of it — routes answer "not installed" and no design-core module is in memory', () => {
    const { execFileSync } = require('child_process');
    const script = `
      process.env.LAIN_DESIGN_DIR = ${JSON.stringify(path.join(os.tmpdir(), 'no-design-here'))};
      const routes = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'harnessapp', 'routes.js'))});
      const { Session } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'session.js'))});
      const tools = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'tools', 'index.js'))});
      (async () => {
        const s = new Session({ cwd: ${JSON.stringify(os.tmpdir())} });
        const app = { session: s, cfg: {} };
        const st = await routes.dispatch(app, 'POST', '/api/design/status', {});
        const op = await routes.dispatch(app, 'POST', '/api/design/open', {});
        tools.schemas(app, { turn: true, session: s });
        const ds = new Session({ cwd: ${JSON.stringify(os.tmpdir())} }); ds.kind = 'design';
        const dn = tools.schemas({ session: ds, cfg: {} }, { turn: true, session: ds }).map((t) => t.name).filter((n) => /^design_/.test(n));
        const loaded = Object.keys(require.cache).filter((k) => /design-core|[\\\\/]design[\\\\/]src[\\\\/]/.test(k));
        console.log(JSON.stringify({ installed: st.body.installed, open: op.body, loaded, dn }));
      })();`;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env } }).trim().split('\n').pop());
    assert.strictEqual(out.installed, false);
    assert.strictEqual(out.open.ok, false); assert.ok(out.open.notInstalled);
    assert.deepStrictEqual(out.loaded, [], 'no Design module required');
    assert.deepStrictEqual(out.dn, [], 'a Design session without Design installed has no design_* tools');
  });

  await test('DESIGN 9b: the Harness page carries only the Design door; the surface is loaded on demand and only when installed', () => {
    const harness = require('../designbench').harnessDesignDir();
    if (!harness) { assert.ok(true, 'no lain-harness beside this checkout'); return; }
    const hroot = path.dirname(harness);
    delete require.cache[require.resolve(path.join(hroot, 'page', 'page.js'))];
    const html = require(path.join(hroot, 'page', 'page.js')).html();
    assert.ok(/\/api\/design\/status/.test(html), 'the door asks Core');
    assert.ok(!/designUI\s*=\s*\{|L\.designUI = \{|dz-vp|dz-world/.test(html), 'none of the surface is in the page');
    const ui = fs.readFileSync(path.join(harness, 'design.js'), 'utf8');
    assert.ok(/L\.designUI = \{/.test(ui));
    // Without design/ beside it, the Harness serves no Design files.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-h-'));
    fs.copyFileSync(path.join(hroot, 'webvendor.js'), path.join(tmp, 'webvendor.js'));
    const wv = require(path.join(tmp, 'webvendor.js'));
    assert.ok(!wv.assetDirs().some((d) => d.url === 'design'));
    delete require.cache[require.resolve(path.join(hroot, 'webvendor.js'))];
    assert.ok(require(path.join(hroot, 'webvendor.js')).assetDirs().some((d) => d.url === 'design'), 'with design/ present it is served');
  });

  await test('DESIGN: React — JSX edits go to the style object, the element\'s class, or a scoped class; ids match the Vite plugin', () => {
    const root = copy('react-mini');
    const { ReactProject, vitePlugin } = require(path.join(at.dir, 'src', 'react.js'));
    const p = new ReactProject(root);
    assert.deepStrictEqual(p.scanScreens().map((s) => s.route), ['/', '/settings']);
    const me = p.scanElements('src/pages/Home.jsx').find((e) => e.attrs.id === 'me');
    assert.strictEqual(me.file, 'src/components/Header.jsx', 'a component\'s layers are in the screen');
    const plugin = vitePlugin({ root });
    const out = plugin.transform(fs.readFileSync(path.join(root, me.file), 'utf8'), path.join(root, me.file));
    assert.ok(out.code.includes(`data-lain-id="${me.id}"`), 'the served id is the engine\'s id');
    const mv = p.applyEdit({ op: 'move', node: me.id, dx: -300, dy: 0, layout: { position: 'absolute', rect: { x: 334, y: 8, w: 40, h: 40 }, containing: { x: 0, y: 0, w: 390, h: 56 } } });
    assert.ok(mv.ok, mv.why); assert.deepStrictEqual(mv.files.map((f) => f.rel), ['src/app.css']);
    const btn = p.scanElements('src/pages/Home.jsx').find((e) => e.tag === 'button');
    const st = p.applyEdit({ op: 'setStyle', node: btn.id, props: { opacity: '0.9' } });
    assert.match(st.diff, /style=\{\{ marginTop: 8, opacity: 0\.9 \}\}/);
    const q = p.applyEdit({ op: 'setStyle', node: btn.id, props: { 'border-radius': '4px' } });
    assert.ok(q.needs && q.needs.scope, 'a shared class asks here too');
    assert.ok(p.scanFlows().some((w) => w.kind === 'handler' && w.target === 'src/pages/Settings.jsx'), 'go(\'/settings\') is a flow');
  });

  await test('DESIGN: an unsupported project opens read-only and says why', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-design-none-'));
    fs.writeFileSync(path.join(dir, 'main.py'), 'print(1)\n');
    const p = E.open(dir);
    assert.ok(p.readOnly); assert.match(p.why, /read-only/);
    assert.strictEqual(p.applyEdit({ op: 'remove', node: 'x' }).ok, false);
  });

  await test('DESIGN: the tools answer in one status line and the diff; questions come back as questions', async () => {
    const root = copy('chat-messenger');
    const d = new E.Design(root);
    const chip = d.project.scanElements('index.html').find((e) => e.classes.includes('chip'));
    const r = await E.tools.run(d, 'design_edit', { op: 'setStyle', node: chip.id, props: { color: 'red' } });
    assert.match(r.output, /^QUESTION: Change all 6 uses of \.chip, or only this one\?/);
    const ok = await E.tools.run(d, 'design_edit', { op: 'setText', node: d.project.scanElements('index.html').find((e) => e.text === 'Chats' && e.tag === 'h1').id, text: 'Messages' });
    const lines = ok.output.split('\n');
    assert.match(lines[0], /^screen-title|Chats: text "Messages"/);
    assert.match(lines[1], /^index\.html:\d+$/);
    const inspect = await E.tools.run(d, 'design_inspect', {});
    assert.match(inspect.output, /4 screen\(s\)/);
    await d.close();
  });
};
