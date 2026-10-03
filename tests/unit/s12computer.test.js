'use strict';

/**
 * S12b — COMPUTER CONTROL THE MODEL ACTUALLY USES. A double for the bridge (as computercontrol.test.js): these prove
 * LAIN's decisions — what is captured and how big, what is sent, what is refused and what is said. Delivery to real
 * windows is tests/acceptance/computer-real.js on a real desktop (NOT run here: no Windows desktop).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const cc = require('../../src/computercontrol');
const permissionsMod = require('../../src/permissions');
const mcp = require('../../src/mcp');
const pngscale = require('../../src/pngscale');

/** A synthetic 2560×1440 window capture (title bar, buttons, glyph rows) written as PNG. */
function bigCapture(dir) {
  const w = 2560; const h = 1440; const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; let v = 240;
    if (y < 40) v = 32; else if (((x >> 5) + (y >> 5)) % 7 === 0) v = 120; else if (y % 22 < 14 && x % 9 < 6 && ((x * 31 + y * 17) % 13) < 9) v = 20;
    rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = Math.min(255, v + 10); rgba[i + 3] = 255;
  }
  const f = path.join(dir, 'cap.png');
  fs.writeFileSync(f, pngscale.encode({ width: w, height: h, rgba }));
  return f;
}

function rig({ mode = 'AUTO', windows = null, onCall = null } = {}) {
  const perms = new permissionsMod.Permissions();
  const calls = [];
  const calc = { handle: 4242, pid: 900, title: 'Calculator', process: 'ApplicationFrameHost', rect: { x: 300, y: 200, width: 2560, height: 1440 } };
  const note = { handle: 5151, pid: 901, title: 'notes.txt - Notepad', process: 'notepad' };
  const term = { handle: 6161, pid: process.pid, title: 'LAIN · project · Z.ai › GLM', process: 'WindowsTerminal' };
  let list = windows || [calc, note, term];
  const dir = tmpdir('s12cu-');
  const session = { id: 's12', turns: [], cwd: dir, execMode: mode, _defaultMode: { cwd: dir, mode } };
  const app = { session, cfg: { trustedPaths: [{ path: dir, level: 'TRUSTED' }] }, desktop: () => ({ permissions: perms }), interaction: true, ui: { enabled: false }, render: { notice() {} } };
  const cm = require('../../src/computermcp').forApp(app);
  cm.bridge = {
    state: mcp.STATE.CONNECTED, capabilities: Object.keys(mcp.OPS),
    async call(op, params = {}) {
      calls.push({ op, params, label: cc.label(app) });
      if (onCall) { const r = await onCall(op, params, calls); if (r) return r; }
      if (op === 'control.arm') { const w = list.find((x) => Number(x.handle) === Number(params.handle)) || list.find((x) => x.title.includes(params.window || '\u0000')); return w ? { ok: true, result: { armed: w } } : { ok: false, error: 'no such window' }; }
      if (op === 'control.state') return { ok: true, result: { killed: false, personInputMsAgo: -1, foreground: calc, armed: calc } };
      if (op === 'window.list') return { ok: true, result: { windows: list } };
      if (op === 'window.focus') return { ok: true, result: { focused: true, handle: params.handle } };
      if (op === 'window.active') return { ok: true, result: { window: term } };
      if (op === 'window.capture') return { ok: true, result: { path: bigCapture(dir), region: { x: 300, y: 200, width: 2560, height: 1440 }, method: 'PrintWindow' } };
      if (op === 'screen.capture') return { ok: true, result: { path: bigCapture(dir), region: { x: 0, y: 0, width: 2560, height: 1440 } } };
      return { ok: true, result: { foreground: calc } };
    },
    close() {},
  };
  perms.grant(require('../../src/computermcp').CAPS, { scope: permissionsMod.SCOPE.COMPUTER });
  const setList = (l) => { list = l; };
  return { app, cm, calls, calc, note, term, setList, ctx: { app, session } };
}
const computer = () => require('../../src/tools/computerone').tools.computer;

module.exports = async function () {
  const savedInteraction = require('../../src/interaction').available;
  require('../../src/interaction').available = () => true;   // the person is present: Auto is in force
  try {
    await test('S12b CAPTURE: INTERACT captures only the target window — never the screen, never another window; FULL may, and the header says "full screen" while it does', async () => {
      const { app, cm, calls, ctx } = rig();
      await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
      assert.match((await cm.call('screen.capture', {})).why, /only at FULL/);
      assert.match((await cm.call('window.capture', { window: 'Notepad' })).why, /needs a target window first/);
      assert.ok((await cc.setTarget(app, { handle: 4242 })).ok);
      assert.match((await cm.call('window.capture', { handle: 5151 })).why, /captures only the target "Calculator"/);
      assert.ok((await cm.call('window.capture', {})).ok, 'the target itself');
      assert.strictEqual(calls.filter((c) => c.op === 'window.capture').pop().params.handle, 4242, 'scoped to the target by handle');
      const shot = await computer().run({ action: 'screenshot', window: 'screen' }, ctx);
      assert.ok(shot.isError && /only at FULL/.test(shot.output), shot.output);
      await cc.enable(app, { tier: 'FULL', by: 'cli', ask: false });
      const full = await computer().run({ action: 'screenshot', window: 'screen' }, ctx);
      assert.ok(!full.isError, full.output);
      assert.strictEqual(calls.filter((c) => c.op === 'screen.capture').pop().label, '● Computer · full screen', 'said while capturing');
      assert.notStrictEqual(cc.label(app), '● Computer · full screen', 'and not after');
    });

    await test('S12b DOWNSCALE: a 2560×1440 capture is written at 1280×720; the bytes and the image → screen mapping are in the result', async () => {
      const { app, ctx } = rig();
      await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
      await cc.setTarget(app, { handle: 4242 });
      const r = await computer().run({ action: 'screenshot' }, ctx);
      assert.ok(!r.isError, r.output);
      assert.match(r.output, /2560×1440 → 1280×720/);
      assert.match(r.output, /\d+ KB → \d+ KB/);
      assert.match(r.output, /screen x = 300 \+ image x ÷ 0\.5, screen y = 200 \+ image y ÷ 0\.5/);
      const img = pngscale.decode(fs.readFileSync(r.meta.image));
      assert.deepStrictEqual([img.width, img.height], [1280, 720], 'the file itself is the scaled one');
      const c = r.meta.capture;
      assert.ok(c.bytesAfter < c.bytesBefore, `${c.bytesBefore} → ${c.bytesAfter}`);
      process.stdout.write(`      synthetic 2560×1440 capture: ${c.bytesBefore} B → ${c.bytesAfter} B (1280×720)\n`);
    });

    await test('S12b FOCUS: arming a target brings it to the front; FOCUS_LOST to LAIN\'s own terminal refocuses once and sends; to the person\'s window it stands', async () => {
      let refuse = true;
      const { app, cm, calls } = rig({ onCall: (op) => (op === 'mouse.click' && refuse ? { ok: false, error: "FOCUS_LOST: 'LAIN · project' is in front, not the target 'Calculator' — paused, nothing was sent" } : null) });
      await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
      await cc.setTarget(app, { handle: 4242 });
      const armAt = calls.findIndex((c) => c.op === 'control.arm');
      assert.ok(calls.slice(armAt).some((c) => c.op === 'window.focus' && c.params.handle === 4242), 'the target is put in front when armed');
      const t = require('../../src/tools/computerinput').tools;
      const ctx = { app, session: app.session };
      let n = 0;
      const was = cm.bridge.call.bind(cm.bridge);
      cm.bridge.call = async (op, p) => { if (op === 'mouse.click') { n += 1; if (n > 1) refuse = false; } return was(op, p); };
      const r = await t.computer_click.run({ x: 400, y: 300 }, ctx);
      assert.ok(!r.isError, r.output);
      assert.strictEqual(n, 2, 'sent once more after the refocus');
      // The person's own window in front: no refocus, the refusal stands.
      refuse = true; n = 0;
      cm.bridge.call = async (op, p) => { if (op === 'window.active') return { ok: true, result: { window: { handle: 5151, title: 'notes.txt - Notepad', process: 'notepad', pid: 901 } } }; if (op === 'mouse.click') n += 1; return was(op, p); };
      const r2 = await t.computer_click.run({ x: 400, y: 300 }, ctx);
      assert.ok(r2.isError && /FOCUS_LOST/.test(r2.output) && n === 1, 'not retried against the person\'s window');
    });

    await test('S12b TARGET: in Auto the model targets by title or handle — exact, unique or listed; LAIN\'s own window refused; elsewhere it is the person\'s choice', async () => {
      const { app, ctx, calls } = rig();
      await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });   // what the Auto gate does before the first computer call (execmode)
      const r1 = await computer().run({ action: 'target', window: 'calculator' }, ctx);
      assert.ok(!r1.isError, r1.output);
      assert.match(r1.output, /Computer target → "Calculator" .* in front, input is locked to it/);
      assert.strictEqual(cc.view(app).target.handle, 4242);
      assert.ok(calls.some((c) => c.op === 'window.focus' && c.params.handle === 4242));
      const r2 = await computer().run({ action: 'target', window: 'Paint' }, ctx);
      assert.ok(r2.isError && /no window matches "Paint". Windows now:\n4242  "Calculator"/.test(r2.output), r2.output);
      assert.ok(!/LAIN ·/.test(r2.output), 'LAIN\'s own window is not offered');
      const r3 = await computer().run({ action: 'target', window: '6161' }, ctx);
      assert.ok(r3.isError && /LAIN's own window/.test(r3.output), r3.output);
      const ask = rig({ mode: 'ASK' });
      await cc.enable(ask.app, { tier: 'INTERACT', by: 'cli', ask: false });
      const r4 = await computer().run({ action: 'target', window: 'Calculator' }, ask.ctx);
      assert.ok(r4.isError && /the person picks the target window/.test(r4.output), r4.output);
    });

    await test('S12b TARGET GONE: one line and the windows there are now — the target is released, not refused again', async () => {
      const { app, ctx, setList, note } = rig({ onCall: (op) => (op === 'mouse.click' ? { ok: false, error: 'no such window' } : null) });
      await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
      await computer().run({ action: 'target', window: 'Calculator' }, ctx);
      setList([note]);
      const r = await computer().run({ action: 'click', x: 400, y: 300 }, ctx);
      assert.ok(r.isError);
      assert.match(r.output, /^TARGET GONE: "Calculator" \(handle 4242\) is no longer open\. Windows now:\n5151  "notes\.txt - Notepad"/);
      assert.strictEqual(cc.view(app).target, null, 'released');
    });

    await test('S12b LAUNCH: Auto only; one app name or path, never a command line; Windows-only here', async () => {
      const { ctx } = rig();
      const r = await computer().run({ action: 'launch', app: 'calc & del x' }, ctx);
      assert.ok(r.isError && /no command line/.test(r.output), r.output);
      if (process.platform !== 'win32') assert.match((await computer().run({ action: 'launch', app: 'calc' }, ctx)).output, /Windows-only/);
      const ask = rig({ mode: 'ASK' });
      assert.match((await computer().run({ action: 'launch', app: 'calc' }, ask.ctx)).output, /NOT LAUNCHED: in this permission mode the person picks the target/);
    });

    await test('S12b WORDS: the system prompt says to use `computer` for desktop input; no tool result names a tool the model does not have', () => {
      assert.match(require('../../src/simpleprompt').base({ shell: 'PowerShell' }), /For desktop input use the `computer` tool, not shell scripts\./);
      const src = ['tools/computerinput.js', 'tools/computerone.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8')).join('\n');
      for (const gone of ['computer_capture or computer read', 'click_control', 'type_into', 'look (computer_capture)']) assert.ok(!src.includes(gone), gone);
      assert.deepStrictEqual(require('../../src/tools/computerone').ACTIONS.slice(0, 3), ['windows', 'target', 'launch']);
    });
  } finally { require('../../src/interaction').available = savedInteraction; }
};
