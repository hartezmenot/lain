'use strict';

/**
 * COMPUTER MCP, ON THE REAL COMPUTER.
 *
 * Evidence tier: REAL-DESKTOP VERIFIED. A compiled UI Automation bridge, the
 * real Windows shell, real applications, real keystrokes. Nothing here is a
 * fixture; the only thing that is doubled is the model, which is not involved.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE REFUSES TO DO, and why it is written the way it is.
 *
 * It runs on a DEVELOPER'S OWN MACHINE, with their windows open and their
 * unsaved work in them. So:
 *
 *   - Every application this suite drives is one THIS SUITE STARTED, aimed by
 *     PID or window handle. A title is not an identity.
 *   - The application it types into is ITS OWN: tests/fixtures/winapp.cs, built
 *     and launched by the test. This used to be Notepad, which meant the case
 *     had to skip itself whenever a person had one open — Windows 11 Notepad is
 *     single-instance, so a second launch becomes a TAB in the one already
 *     there, and typing into it is typing into somebody's unsaved document. A
 *     case that skips itself whenever the machine is in normal use is a case
 *     that mostly does not run.
 *   - Everything it opens, it closes.
 *   - It types into files under a temporary directory, never anywhere else.
 *
 * SKIPS, and says so, when the platform is not Windows or the bridge cannot be
 * compiled. A skip is reported; it is never silently a pass.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');
const winfixture = require('../harness/winfixture');

const ROOT = path.join(__dirname, '..', '..');

/** A port that answers the one authorization question the way a person would. */
function allowing(answers = {}) {
  const asked = [];
  return {
    asked,
    ask(q) {
      asked.push(q);
      const want = answers[q.title];
      if (want !== undefined) return Promise.resolve(want);
      const yes = (q.options || []).find((o) => /^allow/i.test(String(o)));
      return Promise.resolve(yes || (q.options || [])[0] || null);
    },
  };
}

/**
 * A connected, authorized desktop — or a stated reason there is not one.
 * The authorization goes through the REAL question, answered through the real
 * interaction seam, so the grant under test is the grant a person would make.
 */
async function desktop() {
  if (process.platform !== 'win32') return { skipped: 'the computer bridge is Windows-only' };
  const { App } = require(path.join(ROOT, 'src', 'app'));
  const cmcp = require(path.join(ROOT, 'src', 'computermcp'));
  const interaction = require(path.join(ROOT, 'src', 'interaction'));
  const built = cmcp.ensureBridge();
  if (!built.ok) return { skipped: `the bridge could not be built: ${built.why}` };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-cmcp-'));
  process.env.LAIN_PROVIDER = 'mock';
  const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd });
  const port = allowing();
  const c = cmcp.forApp(app);
  const r = await interaction.run(app, port, () => c.connect());
  if (!r.ok) return { skipped: `the bridge did not connect: ${r.why}` };
  assert.strictEqual(r.authorized, true, 'the session is authorized');
  assert.strictEqual(port.asked.length, 1, 'exactly one question was asked');
  return { app, c, cwd, port, run: (fn) => interaction.run(app, port, fn) };
}

const note = (why) => process.stdout.write(`    (skipped: ${why})\n`);

/** Windows already open that belong to somebody else. */
async function titled(c, re) {
  const w = await c.windows();
  return ((w.ok && w.result && w.result.windows) || []).filter((x) => re.test(String(x.title || '')));
}

module.exports = async function () {
  // ---------------------------------------------------------------------
  // THE MACHINE ANSWERS. Monitors, windows, the cursor, a frame of the screen.
  await test('the computer answers: displays, windows, cursor, a frame', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    try {
      const disp = await d.c.displays();
      assert.ok(disp.ok, `displays: ${disp.why}`);
      assert.ok(disp.result.displays.length >= 1, 'at least one monitor');
      assert.ok(disp.result.displays[0].bounds.width > 0, 'the monitor has a width');

      const wins = await d.c.windows();
      assert.ok(wins.ok && wins.result.windows.length >= 1, 'windows are listed');
      assert.ok(wins.result.windows.every((w) => Number.isFinite(w.pid) && Number.isFinite(w.handle)),
        'every window carries the identity later actions are aimed by');

      const cur = await d.c.call('cursor.get');
      assert.ok(cur.ok && Number.isFinite(cur.result.x), 'the cursor has a position');

      const shot = await d.c.capture({});
      assert.ok(shot.ok, `capture: ${shot.why}`);
      assert.ok(fs.statSync(shot.result.path).size > 1000, 'a real frame was written');
      fs.unlinkSync(shot.result.path);
    } finally { d.c && d.c.disconnect('test over'); }
  });

  // ---------------------------------------------------------------------
  // A DETERMINISTIC NATIVE APP, DRIVEN SEMANTICALLY. No coordinates: the
  // buttons are found in the UI Automation tree by their automation ids, and
  // the ANSWER is read back out of the display, not off a screenshot.
  await test('Calculator: semantic interaction, structural verification', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    let open = null;
    try {
      open = await d.c.openApp('calc.exe', { name: 'Calculator', waitTitle: 'Calculator' });
      if (!open.ok || !open.window) return note(`Calculator did not open a window of its own: ${open.why}`);
      // AIMED BY HANDLE, NOT BY PID. Calculator is a store app, so its process
      // is ApplicationFrameHost — shared with every other store app on the
      // machine. Targeting `{ pid }` alone was correctly REFUSED by the bridge
      // ("pid N matches 2 windows: Calculator, Settings"), which is the safety
      // property working; the fix is to name the window, not to loosen it.
      const at = { handle: open.window.handle };

      // 7 + 0 = 7 — one digit, then the operator, then equals. The '+' has
      // nothing to check on its own and is expected to be INCONCLUSIVE; it is
      // allowed to continue because the '=' step is what carries the verdict.
      const r = await d.c.batch([
        { action: 'click_control', target: { ...at, automationId: 'num7Button' }, expect: { value: { ...at, automationId: 'CalculatorResults', contains: '7' } } },
        { action: 'click_control', target: { ...at, automationId: 'plusButton' } },
        { action: 'click_control', target: { ...at, automationId: 'num0Button' }, expect: { value: { ...at, automationId: 'CalculatorResults', contains: '0' } } },
        { action: 'click_control', target: { ...at, automationId: 'equalButton' }, expect: { value: { ...at, automationId: 'CalculatorResults', contains: '7' } } },
      ], { continueUnverified: true });

      assert.strictEqual(r.verdict, 'PASSED', `the calculation was observed: ${r.why}`);
      assert.strictEqual(r.steps[1].verdict, 'INCONCLUSIVE', 'a step with nothing to check is never claimed as passed');

      // THE DISPLAY ITSELF, read structurally.
      const shown = await d.c.value({ ...at, automationId: 'CalculatorResults' });
      assert.ok(shown.ok && /7/.test(String(shown.result.value)), `the display reads ${JSON.stringify(shown.result && shown.result.value)}`);
    } finally {
      if (open && open.window) await d.c.call('window.close', { handle: open.window.handle }).catch(() => {});
      d.c && d.c.disconnect('test over');
    }
  });

  // ---------------------------------------------------------------------
  // AN APPLICATION, A NATIVE SAVE DIALOG, AND A FILE ON DISK.
  // The evidence is the file: what is on disk is what was typed.
  await test('an application we own, a native Save As, and a file on disk', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    let f = null;
    try {
      f = await winfixture.start(d.c);
      assert.ok(f.ok, `the fixture application started and showed a window: ${f.why}`);

      const file = path.join(d.cwd, 'lain-wrote-this.txt');
      const text = 'LAIN typed this through UI Automation.';
      // BY HANDLE, because in a moment this process will own two windows and
      // "the window of this pid" will stop being an answer.
      const at = { handle: f.window.handle };

      // TYPE INTO THE BOX, located structurally — not "click near the top left".
      const typed = await d.c.act({
        action: 'type_into', target: { ...at, name: 'inputBox' }, text,
        expect: { value: { ...at, name: 'inputBox', contains: 'UI Automation' } },
      });
      assert.strictEqual(typed.verdict, 'PASSED', `the text went into the box: ${typed.why}`);

      // THE BUTTON RAISES THE NATIVE DIALOG — waited for, not slept past.
      const clicked = await d.c.act({
        action: 'click_control', target: { ...at, name: 'saveButton', controlType: 'Button' },
        expect: { window: { title: 'Save As', pid: f.pid } }, timeoutMs: 15000,
      });
      assert.strictEqual(clicked.verdict, 'PASSED', `the Save As dialog appeared: ${clicked.why}`);
      const seen = await d.c.observe({ window: { title: 'Save As', pid: f.pid } }, { timeoutMs: 15000 });
      assert.ok(seen.ok, seen.why);
      const dlg = seen.observed.window;

      // IT IS AN OWNED WINDOW, which is the thing a bridge like this is for and
      // the thing it could not see until the file dialog above was measured.
      assert.strictEqual(Number(dlg.owner), Number(f.window.handle),
        'the dialog belongs to the application that raised it');

      // ---- AND IT REFUSES TO GUESS WHICH CONTROL --------------------------
      //
      // `controlType: 'Edit'` matches FORTY-ONE controls in this dialog: every
      // cell of the file list is an Edit, and the file name box is near the
      // end. This used to resolve to the first one and then report success,
      // because setting a value on the wrong control succeeds. The refusal
      // names the candidates, the way an ambiguous window has always been
      // refused.
      const vague = await d.c.call('uia.getValue', { handle: dlg.handle, controlType: 'Edit' });
      assert.strictEqual(vague.ok, false, 'an ambiguous control is refused, not resolved by position');
      assert.match(vague.why, /matches \d+ controls/, vague.why);

      // NAMED PRECISELY, IT ANSWERS. The other side of the same rule.
      const one = await d.c.value({ handle: dlg.handle, name: 'File name:', controlType: 'Edit' });
      assert.strictEqual(one.ok, true, `naming it precisely resolves it: ${one.why}`);
      const named = await d.c.act({
        action: 'type_into', target: { handle: dlg.handle, name: 'File name:', controlType: 'Edit' }, text: file,
        expect: { value: { handle: dlg.handle, name: 'File name:', controlType: 'Edit', contains: 'lain-wrote-this' } },
      });
      assert.strictEqual(named.verdict, 'PASSED', `the filename went in: ${named.why}`);

      const saved = await d.c.act({
        action: 'click_control', target: { handle: dlg.handle, name: 'Save', controlType: 'Button' },
        expect: { gone: { handle: dlg.handle } }, timeoutMs: 15000,
      });
      assert.strictEqual(saved.verdict, 'PASSED', `the dialog closed: ${saved.why}`);

      // THE FILESYSTEM IS THE WITNESS.
      for (let i = 0; i < 40 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 250));
      assert.ok(fs.existsSync(file), 'the file LAIN named exists on disk');
      assert.ok(fs.readFileSync(file, 'utf8').includes(text), 'the file holds what was typed');

      // AND THE APPLICATION AGREES, read out of its tree rather than off a
      // screenshot: a value in the tree is a fact, a picture of one is an
      // impression.
      const said = await d.c.observe({ value: { ...at, name: 'statusBox', contains: 'lain-wrote-this.txt' } }, { timeoutMs: 8000 });
      assert.ok(said.ok, `the application reported the save: ${said.why}`);
    } finally {
      if (f && f.ok) f.stop();
      d.c && d.c.disconnect('test over');
    }
  });

  // ---------------------------------------------------------------------
  // THE OS FILE PICKER, DRIVEN TO COMPLETION — WITHOUT ASKING A BROWSER.
  //
  // The case below this one is about a browser reaching the OS boundary, and it
  // cannot make a browser raise a picker under automation (measured; see its
  // note). That is the BROWSER'S half. This is the OTHER half, and it is the
  // half that is LAIN's: a real Windows "Open" dialog — the same shell common
  // item dialog a browser raises, the same #32770 window, the same "File name:"
  // edit and "Open" button — chosen through, with the APPLICATION reporting
  // what it received.
  await test('a native Open picker is driven to completion', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    let f = null;
    try {
      f = await winfixture.start(d.c);
      assert.ok(f.ok, `the fixture application started: ${f.why}`);
      const at = { handle: f.window.handle };

      const upload = path.join(d.cwd, 'quarterly-report.txt');
      fs.writeFileSync(upload, 'the file a person would have chosen by hand\n');

      const clicked = await d.c.act({
        action: 'click_control', target: { ...at, name: 'openButton', controlType: 'Button' },
        expect: { window: { title: 'Open', pid: f.pid } }, timeoutMs: 15000,
      });
      assert.strictEqual(clicked.verdict, 'PASSED', `the Open dialog appeared: ${clicked.why}`);
      const seen = await d.c.observe({ window: { title: 'Open', pid: f.pid } }, { timeoutMs: 15000 });
      assert.ok(seen.ok, seen.why);
      const handle = seen.observed.window.handle;

      const named = await d.c.act({
        action: 'type_into', target: { handle, name: 'File name:', controlType: 'Edit' }, text: upload,
        expect: { value: { handle, name: 'File name:', controlType: 'Edit', contains: 'quarterly-report' } },
      });
      assert.strictEqual(named.verdict, 'PASSED', `the path went into the picker: ${named.why}`);

      const chosen = await d.c.act({
        action: 'click_control', target: { handle, name: 'Open', controlType: 'Button' },
        expect: { gone: { handle } }, timeoutMs: 15000,
      });
      assert.strictEqual(chosen.verdict, 'PASSED', `the picker closed: ${chosen.why}`);

      // THE APPLICATION RECEIVED THE FILE, by name and by size — the same
      // sentence a browser's change handler writes on the other side of this
      // boundary, so the claim is the same claim.
      const got = await d.c.observe({ value: { ...at, name: 'statusBox', contains: 'chosen: quarterly-report.txt' } }, { timeoutMs: 10000 });
      assert.ok(got.ok, `the application received what was chosen: ${got.why}`);
      assert.match(String(got.observed.value), /\(\d+ bytes\)/, 'and it is a real file with a real size');
    } finally {
      if (f && f.ok) f.stop();
      d.c && d.c.disconnect('test over');
    }
  });

  // ---------------------------------------------------------------------
  // EVERY REQUEST GETS ITS OWN THREAD, AND EVERY THREAD IS STILL STA.
  //
  // The bridge now runs each request on a fresh background thread, so that a
  // provider that never returns costs one request rather than the session (see
  // the note on Bounded in bridge.cs — a shell dialog really does this). That
  // moved EVERY operation onto a new apartment, and the apartment-sensitive
  // ones would fail outright in an MTA: `Clipboard.GetText()` throws "Current
  // thread must be set to single thread apartment (STA) mode".
  //
  // READ ONLY. This never writes the clipboard and never asserts on what is in
  // it — it is somebody's, and the property under test is that the call works.
  await test('each request runs on its own thread, and the apartment survives it', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    try {
      // THREE TIMES, because a single call could get its apartment by luck.
      for (let i = 0; i < 3; i++) {
        const got = await d.c.call('clipboard.read', {});
        assert.strictEqual(got.ok, true, `clipboard.read #${i} on a fresh thread: ${got.why}`);
        assert.strictEqual(typeof got.result.text, 'string');
      }
      // GDI+ IS THE OTHER ONE that cares which thread it is on.
      const shot = await d.c.capture({ path: path.join(d.cwd, 'apartment.png') });
      assert.strictEqual(shot.ok, true, `screen.capture on a fresh thread: ${shot.why}`);
      assert.ok(fs.existsSync(path.join(d.cwd, 'apartment.png')), 'and it really wrote a frame');

      // AND A REQUEST THAT CANNOT BE ANSWERED IS NAMED, not silence. The
      // failure this replaced was every later call returning "no answer within
      // 15 s" for the life of the process.
      const nonsense = await d.c.call('uia.getValue', { handle: 1 });
      assert.strictEqual(nonsense.ok, false);
      assert.ok(String(nonsense.why || '').length > 0, 'it says what went wrong');
      const after = await d.c.displays();
      assert.strictEqual(after.ok, true, 'and the bridge is still answering afterwards');
    } finally { d.c && d.c.disconnect('test over'); }
  });

  // ---------------------------------------------------------------------
  // THE BROWSER STOPS AT THE OS BOUNDARY, AND THE COMPUTER CARRIES ON.
  //
  // A real page, a real <input type=file>, a real click, and — when the browser
  // raises one — the real Windows picker, which is not part of any page and is
  // therefore Computer MCP's to handle. The PAGE is what proves the upload.
  //
  // ---- THE PLATFORM BOUNDARY, STATED EXACTLY -----------------------------
  //
  // THIS BROWSER RAISES NO PICKER UNDER AUTOMATION. Measured on Chrome 153
  // driven over CDP: the click arrives at the input and is trusted
  // (`isTrusted === true`), no `Page.fileChooserOpened` is emitted, and no
  // dialog window is created — with the CDP session attached AND after
  // detaching it and clicking with a real OS mouse click. RE-MEASURED after the
  // bridge was taught to see owned windows (it could not see ANY modal dialog
  // before that, which would have looked exactly like this): still no picker.
  // So it is the browser's behaviour, not a blindness in LAIN.
  //
  // This case therefore does NOT skip. It asserts the half it can prove — that
  // nothing reaches the page without a chooser, and that the page cannot see or
  // drive an OS dialog — and drives the picker to completion if one does
  // appear. The other half, the OS picker itself, is proven independently and
  // deterministically by 'a native Open picker is driven to completion' above,
  // against the same shell dialog a browser would raise.
  await test('a browser file picker is handled at the OS boundary', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    const browserMod = require(path.join(ROOT, 'src', 'harness', 'browser'));
    if (!browserMod.findBrowser().ok) { d.c.disconnect('no browser'); return note('no Chromium-family browser on this machine'); }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-picker-'));
    const upload = path.join(dir, 'quarterly-report.txt');
    fs.writeFileSync(upload, 'the file a person would have chosen by hand\n');
    fs.writeFileSync(path.join(dir, 'index.html'), [
      '<!doctype html><meta charset="utf-8"><title>Upload</title>',
      '<h1>Upload</h1><input id="f" type="file"><p id="out">nothing chosen</p>',
      '<script>document.getElementById("f").addEventListener("change",function(e){',
      'var f=e.target.files[0];document.getElementById("out").textContent=f?("chosen: "+f.name+" ("+f.size+" bytes)"):"nothing chosen";});</script>',
    ].join('\n'));

    const http = require('http');
    const server = http.createServer((q, s) => {
      // A QUERY STRING IS NOT A PATH, and an empty path is the index. Getting
      // this wrong resolved "/?p=1" to the DIRECTORY and threw EISDIR out of a
      // request handler, which took the whole test run down with it — so the
      // handler also refuses to be the thing that ends the process.
      try {
        const f = (q.url || '/').split('?')[0].split('#')[0].replace(/^\/+/, '') || 'index.html';
        const p = path.join(dir, f);
        if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { s.writeHead(404); return s.end('no'); }
        s.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        return s.end(fs.readFileSync(p));
      } catch (e) {
        s.writeHead(500);
        return s.end(String((e && e.message) || e));
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/`;

    // A HEADED browser: a headless one has no OS to raise a dialog on. It is a
    // throwaway profile of the Harness's own, never the person's browser.
    const { Harness } = require(path.join(ROOT, 'src', 'harness'));
    const instrument = new Harness({ workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'lain-picker-h-')), persist: false });
    const bh = instrument.browser;
    bh.headless = false;   // a dialog needs a desktop to appear on
    const s = await bh.session({});
    if (!s.ok) { server.close(); d.c.disconnect('no browser'); return note(`no headed browser: ${s.why}`); }
    const page = s.session;
    try {
      // ---- A TITLE IS NOT A SUBSTRING ---------------------------------
      //
      // A real browser window really called something-"OpenAI"-something, and
      // the wait for a dialog called "Open" must not land on it. This is the
      // exact shape that once typed a file path into a person's address bar.
      const decoy = await page.navigate(`${url}?p=1#openai`, 30000);
      assert.ok(decoy.ok, decoy.why);
      await page.evaluate('document.title = "Welcome back - OpenAI"');
      for (let i = 0; i < 20 && !(await titled(d.c, /OpenAI/)).length; i++) await new Promise((r) => setTimeout(r, 250));
      assert.ok((await titled(d.c, /OpenAI/)).length, 'the decoy window is on the desktop');
      const wrong = await d.c.observe({ window: 'Open' }, { timeoutMs: 1200 });
      assert.strictEqual(wrong.ok, false, `"Open" must not match "OpenAI": ${wrong.why}`);

      const nav = await page.navigate(url, 30000);
      assert.ok(nav.ok, `the page loaded: ${nav.why}`);
      const el = async (sel) => ((await page.element(sel)).value || {});
      assert.match((await el('#out')).text || '', /nothing chosen/);

      // THE CLICK THAT LEAVES THE WEB. It is not awaited: a modal OS dialog
      // holds the browser, and waiting on the click would be waiting on the
      // dialog this test exists to answer.
      // WHOSE BROWSER THIS IS. The picker will belong to this process, and
      // every action below is aimed inside it — never at a window that merely
      // has the word "Open" in its title. (A real desktop taught this: see the
      // bridge's MatchTitle.)
      const mine = (await titled(d.c, /^Upload\b/))[0];
      assert.ok(mine, 'the test browser window is on the desktop');
      const owner = mine.pid;

      const input = await el('#f');
      assert.ok(input.exists && input.rect.w > 0, 'the file input is on the page');
      const x = input.rect.x + 8;
      const y = input.rect.y + input.rect.h / 2;
      page.conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }).catch(() => {});
      page.conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }).catch(() => {});

      // THE OS BOUNDARY, OBSERVED. The picker is a window of the machine, not
      // an element of the page — which is exactly why the Browser Harness
      // cannot go on and Computer MCP can.
      const dialog = await d.c.observe({ window: { title: 'Open', pid: owner } }, { timeoutMs: 20000 });
      if (!dialog.ok) {
        // The boundary is still proven in the direction that matters: the page
        // did NOT get a file by itself, and nothing in the DOM is the dialog.
        //
        // ---- A FAILED READ IS NOT A FAILED CLAIM -------------------------
        //
        // This asserted straight on `(await el('#out')).text || ''`, which turns
        // "the page could not be read" into the empty string and reports it as
        // "a file arrived without one being chosen" — an alarming sentence about
        // the exact property this test exists to protect, produced by a browser
        // that was merely slow. It failed exactly once, in a FULL tier run under
        // load, and passed alone every time.
        //
        // So the read is checked before it is believed — and RETRIED, because
        // "slow" is the thing that produced the one failure. A read that never
        // succeeds is this suite's problem to report as a failure, not a reason
        // to stop asserting.
        let out = null;
        const until = Date.now() + 20000;
        for (;;) {
          out = await el('#out');
          if (out.exists && typeof out.text === 'string') break;
          if (Date.now() > until) break;
          await new Promise((r) => setTimeout(r, 400));
        }
        assert.ok(out && out.exists && typeof out.text === 'string',
          'the page could still be read after the click');
        assert.match(out.text, /nothing chosen/, 'no file arrived without one being chosen');

        // AND THE PAGE CANNOT REACH THE OTHER SIDE EITHER. This is the boundary
        // stated as a fact rather than as an absence: whatever the browser does
        // with the click, the DOM has no picker in it, and no amount of script
        // makes one.
        const inDom = await page.evaluate('document.body.innerHTML.indexOf("File name") >= 0');
        assert.notStrictEqual(inDom.value, true, 'the OS dialog is not part of the document');

        // THE PLATFORM FACT, REPORTED — not as a skip. The OS half of this flow
        // is proven by the native picker case above.
        process.stdout.write(`    (this browser raises no native picker for a scripted click — ${dialog.why}; the OS picker itself is proven by 'a native Open picker is driven to completion')\n`);
        return;
      }
      const handle = dialog.observed.window.handle;

      const named = await d.c.act({
        action: 'type_into', target: { handle, controlType: 'Edit' }, text: upload,
        expect: { value: { handle, controlType: 'Edit', contains: 'quarterly-report' } },
      });
      assert.strictEqual(named.verdict, 'PASSED', `the path went into the picker: ${named.why}`);

      const chosen = await d.c.act({
        action: 'click_control', target: { handle, name: 'Open', controlType: 'Button' },
        expect: { gone: { handle } }, timeoutMs: 15000,
      });
      assert.strictEqual(chosen.verdict, 'PASSED', `the picker closed: ${chosen.why}`);

      // BACK IN THE BROWSER: the page received the file the OS handed it.
      const deadline = Date.now() + 15000;
      let out = '';
      for (;;) {
        out = (await el('#out')).text || '';
        if (/chosen:/.test(out) || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      assert.match(out, /chosen: quarterly-report\.txt \(\d+ bytes\)/, `the upload reached the page: ${out}`);
    } finally {
      // THE WHOLE INSTRUMENT, not just its browser. Closing the browser leaves
      // the Harness — its ProcessManager, its guardian and its exit hooks —
      // alive in this process, and a later test that launches its own browser
      // then found its disposable profile still on disk. Owning something means
      // taking it down.
      try { await instrument.shutdown(); } catch { /* it is going away regardless */ }
      server.close();
      d.c.disconnect('test over');
    }
  });

  // ---------------------------------------------------------------------
  // THE HARNESS SHOWS WHAT THE COMPUTER IS DOING, and offers the two things a
  // person wants while it is doing it: SEE it, and STOP it. Driven through the
  // real page's DOM, against a real bridge — the frame in [View computer] is an
  // actual screenshot of this machine.
  await test('the Harness Computer card shows the work and stops it', async () => {
    if (process.platform !== 'win32') return note('the computer bridge is Windows-only');
    const cmcp = require(path.join(ROOT, 'src', 'computermcp'));
    if (!cmcp.ensureBridge().ok) return note('the bridge could not be built');
    const drv = require('../harness/appdriver');
    const d = await drv.open({ script: [{ text: 'Nothing to do.' }] });
    if (d.skipped) return note(d.skipped);
    try {
      await d.until("!document.getElementById('app').hidden && !document.getElementById('gate')");
      assert.strictEqual(await d.js("document.getElementById('computerCard').hidden"), true,
        'no card before anything is connected — polling the window connects nothing');

      const c = cmcp.forApp(d.app);
      const r = await require(path.join(ROOT, 'src', 'interaction')).run(d.app, allowing(), () => c.connect());
      assert.ok(r.ok && r.authorized, `the desktop authorized: ${r.why || ''}`);
      try {
        await d.until("!document.getElementById('computerCard').hidden", 20000);
        const card = await d.js("document.getElementById('computerCard').innerText");
        assert.match(card, /Computer/i, 'the card names what it is');
        assert.match(card, /connected/i, 'and shows what has happened so far');
        assert.match(card, /View computer/i);
        assert.match(card, /Stop/i);
        assert.doesNotMatch(card, /verdict|INCONCLUSIVE|uia\.|bridge/i,
          'no internals and no reasoning text — what it is doing, not how');

        // SEE IT: a real frame of this machine, fetched by the page.
        await d.click('#computerCard button');
        await d.until("document.querySelector('#computerCard img') && document.querySelector('#computerCard img').naturalWidth > 0", 30000);
        assert.ok(await d.js("document.querySelector('#computerCard img').src.startsWith('data:image/png')"),
          'the frame is an image, not a promise of one');

        // STOP IT: one button, and the authorization is gone for good.
        const buttons = "Array.from(document.querySelectorAll('#computerCard button'))";
        await d.js(`${buttons}.find(b => /^Stop$/.test(b.textContent)).click()`);
        await d.until("document.getElementById('computerCard').hidden", 20000);
        assert.strictEqual(c.authorized, false, 'the grant is gone');
        assert.strictEqual(c.connected, false, 'and so is the bridge');
        const after = await c.windows();
        assert.strictEqual(after.ok, false, 'control after Stop is refused');
      } finally { c.disconnect('test over'); }
    } finally { await d.close(); }
  });

  // ---------------------------------------------------------------------
  // DISCONNECT IS REAL. The grant goes with the bridge, and control after it
  // is REFUSED rather than quietly attempted.
  await test('disconnect revokes: later control fails', async () => {
    const d = await desktop();
    if (d.skipped) return note(d.skipped);
    const before = await d.c.windows();
    assert.ok(before.ok, 'control works while connected');

    const gone = d.c.disconnect('the test ended it');
    assert.strictEqual(gone.wasAuthorized, true, 'it had been authorized');
    assert.strictEqual(d.c.authorized, false, 'the grant is gone');
    assert.strictEqual(d.c.connected, false, 'the bridge is gone');

    const after = await d.c.windows();
    assert.strictEqual(after.ok, false, 'control after a disconnect is refused');
    assert.ok(/not connected|not authorized/i.test(after.why), `it says why: ${after.why}`);

    // AND A DIRECT BRIDGE CALL IS REFUSED TOO — not merely the convenience wrapper.
    const raw = await d.c.call('mouse.move', { x: 10, y: 10 });
    assert.strictEqual(raw.ok, false, 'the mouse cannot be moved after a disconnect');
  });
};
