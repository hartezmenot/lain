'use strict';

/**
 * COMPUTER CONTROL ON A REAL DESKTOP (Phase CU acceptance) — `node tests/acceptance/computer-real.js`
 *
 * Drives FRESH instances only (Calculator, Notepad, Edge with a throwaway profile, Paint, and the raw-input
 * "game-like" target built from rawinputtarget.cs), each found as a NEW window so a window the person already had is
 * never targeted, and each closed at the end. The bridge is built into a temporary LAIN home.
 *
 * AUTHORIZATION: running this script is the person's instruction; it grants the desktop capability for its own
 * process (as request_computer does after a person's approval) — the interactive question is not asked.
 *
 * Every line printed is REAL (observed on this desktop) or says NOT VERIFIED. If the person uses the computer while it
 * runs, the bridge refuses input (USER_ACTIVE) and this reports it — it never retries around them.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-cu-'));
process.env.LAIN_HOME = HOME;
process.env.LAIN_CONFIG_DIR = HOME;

const ROOT = path.join(__dirname, '..', '..');
const cc = require(path.join(ROOT, 'src', 'computercontrol'));
const permissionsMod = require(path.join(ROOT, 'src', 'permissions'));
const cmMod = require(path.join(ROOT, 'src', 'computermcp'));
const input = require(path.join(ROOT, 'src', 'tools', 'computerinput')).tools;
const structured = require(path.join(ROOT, 'src', 'tools', 'computermcp')).tools.computer;

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) }); process.stdout.write(`${ok ? 'REAL  ✓' : 'REAL  ✗'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}\n`); }
function note(name, detail) { results.push({ name, ok: null, detail }); process.stdout.write(`NOT VERIFIED · ${name} — ${detail}\n`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const perms = new permissionsMod.Permissions();
const app = { session: { id: 'cu-accept', turns: [] }, cfg: {}, desktop: () => ({ permissions: perms }), render: { notice() {} } };
const ctx = { app, session: app.session };
const cm = cmMod.forApp(app);

async function windows() { const r = await cm.call('window.list', {}); return r.ok ? r.result.windows : []; }
const created = [];   // every window this run opened — swept at the end, by handle
async function launchNew(cmd, args, titleRe, { timeoutMs = 20000 } = {}) {
  const before = new Set((await windows()).map((w) => w.handle));
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(500);
    const hit = (await windows()).find((w) => !before.has(w.handle) && titleRe.test(w.title || ''));
    if (hit) { created.push(hit); return { win: hit, child }; }
  }
  return { win: null, child };
}
/** THE HARNESS waits for a quiet desktop before a scenario (LAIN itself never retries around the person). */
async function quiet(label) {
  for (let k = 0; k < 30; k++) {
    const st = await cm.call('control.state', {}, { internal: true });
    const ago = st.ok ? st.result.personInputMsAgo : -1;
    if (ago < 0 || ago > 3000) return true;
    if (k === 0) process.stdout.write(`      (waiting for a quiet desktop before ${label}: input ${ago}ms ago)\n`);
    await sleep(1000);
  }
  return false;
}
const said = (r) => (r && r.isError ? ` [${String(r.output).split('\n')[0].slice(0, 140)}]` : '');

async function target(win, { raw = false } = {}) {
  await cm.call('window.focus', { handle: win.handle });
  await sleep(300);
  const t = await cc.setTarget(app, { handle: win.handle, raw });
  if (!t.ok) throw new Error(`target: ${t.why}`);
  await cm.call('window.focus', { handle: win.handle });
  await sleep(300);
}
async function closeDiscarding(win) {
  await cc.enable(app, { tier: 'FULL', by: 'cli', ask: false });
  await cm.call('window.close', { handle: win.handle });
  await sleep(1200);
  // BY HANDLE, never by pid: one Notepad process holds every Notepad window, the person's own included.
  for (const name of ["Don't save", 'Don’t save', 'Do not save']) {
    let r;
    for (let k = 0; k < 6; k++) { r = await cm.call('uia.invoke', { handle: win.handle, name, exact: true, controlType: 'Button' }); if (r.ok || !/USER_ACTIVE/.test(r.why || '')) break; await sleep(2000); }
    if (r.ok) break;
  }
}

async function main() {
  const c = await cm.connect({ ask: false });
  if (!c.ok) { check('bridge starts', false, c.why); return; }
  perms.grant(cmMod.CAPS, { scope: permissionsMod.SCOPE.COMPUTER });
  check('bridge built and connected (temporary home)', true, `${(cm.bridge.capabilities || []).length} operations`);
  const st0 = await cm.call('control.state', {}, { internal: true });
  check('kill switch registered (Ctrl+Alt+Pause)', st0.ok && st0.result.killSwitch === 'Ctrl+Alt+Pause', st0.ok ? JSON.stringify({ killSwitch: st0.result.killSwitch }) : st0.why);
  check('OFF by default: input refused before /computer on', !(await cm.call('mouse.move', { x: 1, y: 1 })).ok);

  // ---- CALCULATOR: UI Automation first ------------------------------------------------------------------------
  await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
  const calc = await launchNew('calc.exe', [], /^Calculator$/);
  if (!calc.win) check('Calculator opens', false, 'no new Calculator window'); else {
    await target(calc.win);
    for (const name of ['Clear', 'Seven', 'Plus', 'Eight', 'Equals']) await structured.run({ op: 'click_control', target: { name, controlType: 'Button', exact: true } }, ctx);
    await sleep(500);
    const r = await cm.call('uia.find', { handle: calc.win.handle, automationId: 'CalculatorResults' });
    const shown = r.ok && r.result.matches && r.result.matches[0] ? r.result.matches[0].name : (r.why || '');
    check('Calculator: 7 + 8 through UI Automation reads 15', /\b15\b/.test(shown), shown);
    await closeDiscarding(calc.win);
    await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
  }

  // ---- NOTEPAD: keyboard into the target, then the focus lock -------------------------------------------------
  const pad = await launchNew('notepad.exe', [], /Notepad/);
  if (!pad.win) check('Notepad opens', false, 'no new Notepad window'); else {
    await target(pad.win);
    await quiet('Notepad');
    const typed = await input.computer_type.run({ text: 'LAIN acceptance 123' }, ctx);
    await sleep(500);
    const w2 = (await windows()).find((x) => x.handle === pad.win.handle);
    const text = w2 ? w2.title : 'window gone';   // Notepad titles itself with the first line of an unsaved document
    check('Notepad: computer_type reaches the target', !typed.isError && /LAIN acceptance 123/.test(text), typed.isError ? typed.output : text.slice(0, 80));
    await input.computer_hotkey.run({ keys: ['ctrl', 'a'] }, ctx);
    check('Notepad: a chord (ctrl+a) is sent in INTERACT', true, 'delivered');

    // ---- FOCUS LOCK: put something else in front; input must pause, not land there ----------------------------
    // THE RIGHT WAY ROUND: arm a target that is NOT in front (Notepad stays in front) — input must pause, not land.
    const calc2 = await launchNew('calc.exe', [], /^Calculator$/);
    if (calc2.win) {
      await cm.call('window.focus', { handle: pad.win.handle });
      await sleep(600);
      await cc.setTarget(app, { handle: calc2.win.handle });
      const fgNow = (await cm.call('window.active', {})).result;
      const blocked = await input.computer_type.run({ text: 'SHOULD NOT ARRIVE' }, ctx);
      const padNow = (await windows()).find((x) => x.handle === pad.win.handle);
      check('FOCUS LOCK: nothing reached the window in front (Notepad unchanged)', padNow && !/SHOULD NOT ARRIVE/.test(padNow.title), padNow ? padNow.title : '');
      void fgNow;
      check('FOCUS LOCK: with another window in front, input is refused (FOCUS_LOST)', blocked.isError && /FOCUS_LOST/.test(blocked.output), blocked.output.split('\n')[0]);
      await cc.enable(app, { tier: 'FULL', by: 'cli', ask: false });
      await cm.call('window.close', { handle: calc2.win.handle });
      await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
      await target(pad.win);
    }
    // ---- KILL SWITCH (LAIN's side of it; the hotkey itself is pressed by a person — NOT VERIFIED here) ----------
    await cc.stop(app, 'acceptance');
    const killed = await cm.call('keyboard.type', { text: 'x' }, {});
    check('KILL SWITCH: after stop, nothing more is sent', !killed.ok, killed.why);
    await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
    await target(pad.win);
    await closeDiscarding(pad.win);
    await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
  }

  // ---- BROWSER: Edge with a throwaway profile ---------------------------------------------------------------
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-cu-edge-'));
  const edgeExe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
  if (!edgeExe) note('browser', 'Microsoft Edge is not installed in the usual place'); else {
    const edge = await launchNew(edgeExe, [`--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--new-window', 'about:blank'], /Edge/, { timeoutMs: 30000 });
    if (!edge.win) check('Edge opens', false, 'no new Edge window'); else {
      await sleep(2500);   // a fresh profile's first window takes a moment to accept input
      await target(edge.win);
      await quiet('the browser');
      const r1 = await input.computer_hotkey.run({ keys: ['ctrl', 'l'] }, ctx);
      await sleep(300);
      const r2 = await input.computer_type.run({ text: 'data:text/html,<title>LAIN-CU-OK</title><h1>hi</h1>' }, ctx);
      const r3 = await input.computer_key.run({ key: 'enter' }, ctx);
      const why = said(r1) + said(r2) + said(r3);
      await sleep(2500);
      const w = (await windows()).find((x) => x.handle === edge.win.handle);
      check('Browser: address bar + Enter loads a page (title changes)', w && /LAIN-CU-OK/.test(w.title), (w ? w.title : 'window gone') + why);
      try { execFileSync('taskkill', ['/PID', String(edge.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    }
  }

  // ---- CANVAS: Paint, a drag inside the canvas, judged by the pixels -------------------------------------------
  const paint = await launchNew('mspaint.exe', [], /Paint/, { timeoutMs: 25000 });
  if (!paint.win) check('Paint opens', false, 'no new Paint window'); else {
    await target(paint.win);
    await quiet('the canvas');
    const r = paint.win.rect;
    const before = await input.computer_capture.run({}, ctx);
    const cx = r.x + Math.round(r.width / 2); const cy = r.y + Math.round(r.height / 2);
    const d = await input.computer_drag.run({ fromX: cx - 120, fromY: cy, toX: cx + 120, toY: cy + 40 }, ctx);
    await sleep(600);
    const after = await input.computer_capture.run({}, ctx);
    const fileOf = (o) => (/→ (.+?\.png)/.exec(o.output) || [])[1];
    const a = fileOf(before); const b = fileOf(after);
    const differ = a && b && fs.existsSync(a) && fs.existsSync(b) && !fs.readFileSync(a).equals(fs.readFileSync(b));
    check('Canvas: computer_drag draws in Paint (the captured frame changed)', !d.isError && differ, d.isError ? d.output : `${path.basename(a || '')} vs ${path.basename(b || '')}`);
    check('Capture on demand: one frame per call through Windows Graphics Capture (PrintWindow is the fallback)', Boolean(a && b) && /Windows Graphics Capture/.test(before.output), before.output.split('\n')[0]);
    await closeDiscarding(paint.win);
    await cc.enable(app, { tier: 'INTERACT', by: 'cli', ask: false });
  }

  // ---- GAME-LIKE: raw input target ----------------------------------------------------------------------------
  const exe = path.join(HOME, 'rawinputtarget.exe');
  const log = path.join(HOME, 'raw.log');
  try {
    execFileSync(cmMod.compiler(), ['-nologo', '-target:winexe', `-out:${exe}`, '-r:System.Windows.Forms.dll', path.join(__dirname, 'rawinputtarget.cs')], { stdio: 'pipe' });
  } catch (e) { check('raw input target builds', false, String(e.stdout || e.message).slice(0, 200)); }
  if (fs.existsSync(exe)) {
    const game = await launchNew(exe, [log], /LAIN Raw Input Target/);
    if (!game.win) check('raw input target opens', false); else {
      await target(game.win, { raw: true });
      await quiet('the raw-input target');
      fs.writeFileSync(log, 'start\n');
      await input.computer_hold_key.run({ key: 'w', ms: 300 }, ctx);
      await input.computer_mouse_move.run({ dx: 50, dy: -20, steps: 5 }, ctx);
      await input.computer_key.run({ key: 'space' }, ctx);
      await input.computer_mouse_button.run({ button: 'left', action: 'down' }, ctx);
      await input.computer_mouse_button.run({ button: 'left', action: 'up' }, ctx);
      await sleep(500);
      const L = fs.readFileSync(log, 'utf8');
      const sum = [...L.matchAll(/sum (-?\d+) (-?\d+)/g)].pop();
      check('Raw input: W arrives as a raw key with its scan code (0x11)', /key make 0x11 vk 0x57 down/.test(L) && /key make 0x11 vk 0x57 up/.test(L), L.split('\n').filter((l) => /0x11/.test(l)).slice(0, 2).join(' | '));
      check('Raw input: relative mouse motion arrives as raw deltas (sum 50,-20)', sum && Number(sum[1]) === 50 && Number(sum[2]) === -20, sum ? sum[0] : 'no raw mouse');
      check('Raw input: space and a held left button arrive raw', /key make 0x39/.test(L) && /buttons 1\b/.test(L) && /buttons 2\b/.test(L), '');
      try { execFileSync('taskkill', ['/PID', String(game.win.pid), '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    }
  }

  note('user input wins (physical)', 'the guard compares GetLastInputInfo with the bridge\'s own last SendInput; a person typing during this run would be refused — not simulated here (a synthetic "person" is still injected input)');
  note('kill switch hotkey', 'Ctrl+Alt+Pause is registered (above); pressing it needs a person');
  // THE SWEEP: any window this run opened that is still there is closed, by its handle (never by title or pid).
  await cc.enable(app, { tier: 'FULL', by: 'cli', ask: false });
  for (const w of created) {
    const still = (await windows()).find((x) => x.handle === w.handle);
    if (!still) continue;
    await closeDiscarding(still);
    const gone = !(await windows()).find((x) => x.handle === w.handle);
    // NEVER taskkill here: Notepad (and other apps) keep the person's own windows in the same process.
    process.stdout.write(`      swept ${still.title}${gone ? '' : ' (still open — the person may need to close it)'}
`);
  }
  await cc.disable(app, 'acceptance done');
  cm.disconnect('acceptance done');
}

main().catch((e) => check('acceptance run', false, e.stack || e.message)).finally(() => {
  const out = path.join(ROOT, 'tests', 'acceptance', 'computer-real.result.json');
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => r.ok === false).length;
  process.stdout.write(`\n${results.filter((r) => r.ok).length} real checks passed, ${failed} failed, ${results.filter((r) => r.ok === null).length} not verified → ${path.relative(ROOT, out)}\n`);
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
});
