'use strict';

/**
 * LAIN DESIGN · ANDROID (D7) — the adapter against a fixture project and RECORDED adb output. Nothing here ran on a
 * device or an emulator: adb is simulated from tests/fixtures/design/android-chat/recorded (hand-assembled in adb's
 * output shapes). What a device would do differently is unverified.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const FIX = path.join(__dirname, '..', 'fixtures', 'design', 'android-chat');

module.exports = async function () {
  const design = require('../../src/design');
  const at = design.installed();
  if (!at.ok) { await test(`DESIGN ANDROID: Design not installed here (${at.why}) — not verified`, () => assert.ok(!at.ok)); return; }
  const A = require(path.join(at.dir, 'src', 'android.js'));
  const xml = require(path.join(at.dir, 'src', 'xml.js'));
  const copy = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-and-')); require('../designbench').copyDir(FIX, d); return d; };
  const MAIN = 'app/src/main/res/layout/activity_main.xml';

  await test('ANDROID: detected; screens are the layouts Activities show (the LAUNCHER first); layers are views named by android:id; hand-written startActivity is a flow', () => {
    const root = copy();
    assert.strictEqual(design.load().open(root).kind, 'android');
    const p = new A.AndroidProject(root);
    assert.deepStrictEqual(p.scanScreens().map((s) => [s.name, s.home]), [['Main', true], ['Profile', false], ['Settings', false]]);
    assert.deepStrictEqual(p.scanElements(MAIN).map((e) => e.attrs.id).filter(Boolean), ['title', 'me', 'friends', 'ada', 'grace', 'linus', 'settings_button']);
    const f = p.scanFlows();
    assert.ok(f.some((w) => w.origin === 'code' && w.source.elementId === 'me' && w.target.endsWith('activity_profile.xml')));
    assert.ok(f.some((w) => w.source.elementId === 'settings_button' && w.target.endsWith('activity_settings.xml')));
  });

  await test('ANDROID: dragging the avatar from top-end to top-start rewrites only its anchor and margin attributes; Undo is byte-exact', () => {
    const root = copy();
    const p = new A.AndroidProject(root, { snapshotsDir: path.join(root, '.lain', 'snap') });
    const before = fs.readFileSync(path.join(root, MAIN), 'utf8');
    const me = p.scanElements(MAIN).find((e) => e.attrs.id === 'me');
    const r = p.applyEdit({ op: 'move', node: me.id, dx: -321, dy: 0, layout: { position: 'absolute', rect: { x: 337, y: 12, w: 40, h: 40 }, containing: { x: 0, y: 0, w: 393, h: 873 } } });
    assert.ok(r.ok, r.why);
    assert.ok(p.commit(r).ok);
    const after = fs.readFileSync(path.join(root, MAIN), 'utf8');
    const meBlock = (s) => s.slice(s.indexOf('<ImageView'), s.indexOf('/>', s.indexOf('<ImageView')) + 2);
    assert.ok(!/layout_marginEnd|constraintEnd_toEndOf/.test(meBlock(after)), 'the end anchor is gone');
    assert.match(meBlock(after), /app:layout_constraintStart_toStartOf="parent"/); assert.match(meBlock(after), /android:layout_marginStart="16dp"/);
    assert.strictEqual(after.replace(meBlock(after), ''), before.replace(meBlock(before), ''), 'nothing outside the avatar changed');
    assert.doesNotThrow(() => xml.parse(after, MAIN), 'still well-formed');
    assert.ok(p.undo().ok);
    assert.strictEqual(fs.readFileSync(path.join(root, MAIN), 'utf8'), before);
  });

  await test('ANDROID: inspector values become view attributes (dp/sp); text that is a @string is changed in strings.xml; a LinearLayout child asks Reorder / Offset', () => {
    const root = copy();
    const p = new A.AndroidProject(root);
    const els = p.scanElements(MAIN);
    const me = els.find((e) => e.attrs.id === 'me');
    const st = p.applyEdit({ op: 'setStyle', node: me.id, props: { width: '56px', opacity: '0.8', 'font-size': '18px' } });
    assert.ok(st.ok, st.why);
    assert.match(st.diff, /android:layout_width="56dp"/); assert.match(st.diff, /android:alpha="0\.8"/); assert.match(st.diff, /android:textSize="18sp"/);
    const t = p.applyEdit({ op: 'setText', node: els.find((e) => e.attrs.id === 'title').id, text: 'Messages' });
    assert.deepStrictEqual(t.files.map((f) => f.rel), ['app/src/main/res/values/strings.xml']);
    assert.match(t.diff, /<string name="title_chats">Messages<\/string>/);
    const ids = ['ada', 'grace', 'linus'].map((n) => els.find((e) => e.attrs.id === n).id);
    const q = p.applyEdit({ op: 'move', node: ids[2], dx: 0, dy: -130, layout: { id: ids[2], position: 'static', rect: { x: 0, y: 168, w: 393, h: 48 }, parentDisplay: 'flex', flexDirection: 'column', siblings: ids.map((id, i) => ({ id, rect: { x: 0, y: 72 + i * 48, w: 393, h: 48 } })), containing: { x: 0, y: 72, w: 393, h: 144 } }, drop: { x: 100, y: 74 } });
    assert.deepStrictEqual(q.needs.choice.choices.map((c) => c.id), ['reorder', 'offset']);
    assert.strictEqual(p.applyEdit({ op: 'setStyle', node: me.id, props: { 'border-radius': '8px' } }).ok, false, 'a corner radius is a drawable, said so');
  });

  await test('ANDROID: "+" a logout Button with a .png (copied to res/drawable) and a wire to Settings — a marked Kotlin block plus the preset\'s res/anim pair, read back as a flow', () => {
    const root = copy();
    const png = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lain-png-')), 'Logout.png');
    fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
    const p = new A.AndroidProject(root);
    const friends = p.scanElements(MAIN).find((e) => e.attrs.id === 'friends');
    const ins = p.applyEdit({ op: 'insert', parent: friends.id, name: 'logout', kind: 'button', text: 'Log out', asset: png });
    assert.ok(ins.ok, ins.why);
    const c = p.commit(ins); assert.ok(c.ok, c.why);
    assert.ok(fs.existsSync(path.join(root, 'app/src/main/res/drawable/logout.png')));
    assert.match(fs.readFileSync(path.join(root, MAIN), 'utf8'), /<Button android:id="@\+id\/logout" [^>]*android:drawableStart="@drawable\/logout" android:text="Log out" \/>/);
    const w = p.applyEdit({ op: 'addWire', node: c.followId, action: 'navigate', target: 'app/src/main/res/layout/activity_settings.xml', transition: 'slide-left', duration: 250, easing: 'ease-in-out' });
    assert.ok(w.ok, w.why); assert.ok(p.commit(w).ok);
    const kt = fs.readFileSync(path.join(root, 'app/src/main/java/com/example/chat/MainActivity.kt'), 'utf8');
    assert.match(kt, /findViewById<View>\(R\.id\.logout\)\.setOnClickListener \{ startActivity\(Intent\(this, SettingsActivity::class\.java\)\); overridePendingTransition\(R\.anim\.lain_slide_left_enter, R\.anim\.lain_slide_left_exit\) \}/);
    for (const f of ['enter', 'exit']) {
      const a = fs.readFileSync(path.join(root, `app/src/main/res/anim/lain_slide_left_${f}.xml`), 'utf8');
      assert.doesNotThrow(() => xml.parse(a, 'anim.xml')); assert.match(a, /android:duration="250"/); assert.match(a, /accelerate_decelerate_interpolator/);
    }
    const flows = new A.AndroidProject(root).scanFlows();
    const mine = flows.find((x) => x.origin === 'design');
    assert.ok(mine && mine.source.elementId === 'logout' && mine.transition === 'slide-left');
    assert.strictEqual(flows.filter((x) => x.origin === 'code').length, 2, 'the hand-written ones are still read, and the marked block is not read twice');
    const svg = png.replace('.png', '.svg'); fs.writeFileSync(svg, '<svg/>');
    const r = p.applyEdit({ op: 'insert', parent: friends.id, name: 'x', kind: 'image', asset: svg });
    assert.strictEqual(r.ok, false); assert.match(r.why, /Vector Asset/);
  });

  await test('ANDROID: a project with no XML layouts (Jetpack Compose) opens read-only and says why', () => {
    const root = copy();
    fs.rmSync(path.join(root, 'app/src/main/res/layout'), { recursive: true, force: true });
    const p = design.load().open(root);
    assert.ok(p.readOnly); assert.match(p.why, /Jetpack Compose/);
  });

  await test('ANDROID ADB (recorded output, no device): a tap goes to the view\'s centre in device pixels; the step reports the new activity, view changes and a screenshot; layout comes back in dp', async () => {
    const root = copy();
    const rec = (f) => fs.readFileSync(path.join(FIX, 'recorded', f), 'utf8');
    let screen = 'main'; const calls = [];
    const exec = (bin, argv) => { let args = argv;
      calls.push(args.join(' '));
      if (args[0] === '-s') args = args.slice(2);
      const a = args.join(' ');
      if (a === 'shell wm density') return rec('density.txt');
      if (a.startsWith('exec-out uiautomator dump')) return rec(screen === 'main' ? 'dump-main.xml' : 'dump-profile.xml');
      if (a === 'shell dumpsys activity activities') return rec(screen === 'main' ? 'activity-main.txt' : 'activity-profile.txt');
      if (a.startsWith('logcat')) return '';
      if (a.startsWith('shell input tap')) { const [x, y] = args.slice(3).map(Number); if (x >= 926 && x <= 1036 && y >= 33 && y <= 143) screen = 'profile'; return ''; }
      if (a === 'exec-out screencap -p') return Buffer.from('89504e47', 'hex');
      throw new Error(`unexpected adb ${a}`);
    };
    const adb = new A.Adb({ adb: 'adb', serial: 'emulator-5554', exec });
    const p = new A.AndroidProject(root);
    const me = p.scanElements(MAIN).find((e) => e.attrs.id === 'me');
    const lay = A.measure(adb, p, p.locate(me.id));
    assert.deepStrictEqual(Object.values(lay.rect).map((v) => Math.round(v)), [337, 12, 40, 40], 'dp at 440 dpi');
    assert.strictEqual(lay.position, 'absolute');
    const steps = await A.runSteps(adb, p, [{ action: 'click', target: me.id, settleMs: 1 }]);
    assert.ok(calls.includes('-s emulator-5554 shell input tap 981 88'), calls.join('\n'));
    assert.ok(calls.every((c) => c.startsWith('-s emulator-5554 ')), 'every command names the device');
    const s = steps[0];
    assert.ok(s.ok); assert.strictEqual(s.url, 'com.example.chat/.ProfileActivity'); assert.ok(s.navigated);
    assert.ok(s.changes.added > 0 && s.changes.removed > 0); assert.deepStrictEqual(s.errors, []);
    assert.ok(Buffer.isBuffer(s.screenshot));
    const miss = await A.runSteps(adb, p, [{ action: 'click', target: { text: 'Nope' }, settleMs: 1 }]);
    assert.strictEqual(miss[0].ok, false);
  });
};
