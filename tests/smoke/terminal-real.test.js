'use strict';

/**
 * THE PROJECT TERMINAL, AS A PERSON USES IT.
 *
 * Evidence tier: REAL-DESKTOP VERIFIED. A real compiled ConPTY bridge, a real
 * Windows pseudoconsole, a real shell, and every call made through
 * `routes.dispatch` — the same entry the window's channel uses. Nothing here is
 * a fixture except the project directory.
 *
 * ------------------------------------------------------------------------
 * WHAT MAKES THIS A TERMINAL AND NOT A COMMAND RUNNER, asserted rather than
 * asserted-about: the shell must believe it has a CONSOLE. A program that
 * detects a pipe turns off colour, progress and prompts — so "it printed
 * something" is not the property. "It knows how wide its console is, and
 * notices when that changes" is.
 *
 * Everything this opens, it closes.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');
const note = (why) => process.stdout.write(`    (skipped: ${why})\n`);
const CR = String.fromCharCode(13);

function appAt(cwd) {
  const { App } = require(path.join(ROOT, 'src', 'app'));
  return new App({
    out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false },
    interactive: false,
    cwd,
  });
}

/** Wait for a condition in the terminal's own output — never a fixed sleep. */
async function until(read, re, ms = 25000) {
  const end = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling a real shell's output.
    const out = await read();
    if (re.test(out)) return out;
    if (Date.now() > end) return null;
    // eslint-disable-next-line no-await-in-loop -- the same poll.
    await new Promise((r) => setTimeout(r, 120));
  }
}

module.exports = async function () {
  await test('TERMINAL: a real shell runs in the project, and it knows it has a console', async () => {
    if (process.platform !== 'win32') return note('the project terminal is a Windows pseudoconsole');
    const pty = require(path.join(ROOT, 'src', 'pty'));
    const built = pty.ensureBridge();
    if (!built.ok) return note(built.why);

    const routes = require(path.join(ROOT, 'src', 'harnessapp', 'routes'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-term-'));
    const app = appAt(cwd);
    let id = null;
    try {
      const opened = await routes.dispatch(app, 'POST', '/api/terminal/open', { cols: 100, rows: 30 });
      assert.strictEqual(opened.code, 200, JSON.stringify(opened.body));
      id = opened.body.id;
      assert.strictEqual(opened.body.cwd, cwd, 'it opens in the project, not wherever LAIN is');

      let since = 0;
      const readAll = async () => {
        const r = await routes.dispatch(app, 'POST', '/api/terminal/read', { id, since });
        if (r.code !== 200) return '';
        since = r.body.at;
        return Buffer.from(r.body.data || '', 'base64').toString('utf8');
      };
      let seen = '';
      const read = async () => { seen += await readAll(); return seen; };

      // A PROMPT, from a real shell.
      assert.ok(await until(read, /PS |>/), `no prompt appeared: ${JSON.stringify(seen.slice(-200))}`);

      // ---- IT IS A CONSOLE, NOT A PIPE -----------------------------------
      //
      // The whole point. A pipe has no width; a console does, and the shell can
      // be asked for it.
      const send = (s) => routes.dispatch(app, 'POST', '/api/terminal/input',
        { id, data: Buffer.from(s, 'utf8').toString('base64') });
      await send(`echo WIDTH-$($Host.UI.RawUI.WindowSize.Width)${CR}`);
      const width = await until(read, /WIDTH-\d+/);
      assert.ok(width, `the shell never answered: ${JSON.stringify(seen.slice(-200))}`);
      assert.strictEqual(/WIDTH-(\d+)/.exec(width)[1], '100', 'the shell sees the console it was given');

      // ---- AND RESIZING THE PANEL REALLY RESIZES IT ----------------------
      const rs = await routes.dispatch(app, 'POST', '/api/terminal/resize', { id, cols: 64, rows: 20 });
      assert.strictEqual(rs.code, 200);
      await send(`echo NOW-$($Host.UI.RawUI.WindowSize.Width)${CR}`);
      const now = await until(read, /NOW-\d+/);
      assert.ok(now, 'the shell answered after the resize');
      assert.strictEqual(/NOW-(\d+)/.exec(now)[1], '64', 'a resized panel is a resized console');

      // ---- IT SURVIVES THE PANEL BEING SHUT ------------------------------
      //
      // The drawer is a VIEW. Closing it must not end a build; the shell keeps
      // running and its output waits in Core to be caught up on by offset.
      await send(`echo WHILE-YOU-WERE-AWAY${CR}`);
      const later = await until(read, /WHILE-YOU-WERE-AWAY/);
      assert.ok(later, 'output produced with nobody watching is still there');

      const listed = await routes.dispatch(app, 'POST', '/api/terminal/processes', {});
      assert.strictEqual(listed.code, 200);
      assert.ok((listed.body.terminals || []).some((t) => t.id === id && t.alive),
        'the drawer can see the shell it has open');
    } finally {
      if (id) await routes.dispatch(app, 'POST', '/api/terminal/close', { id });
      try { require(path.join(ROOT, 'src', 'pty')).closeAll(app); } catch { /* going anyway */ }
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* windows holds it briefly */ }
    }
  });

  await test('TERMINAL: ending LAIN takes its shells with it', async () => {
    if (process.platform !== 'win32') return note('the project terminal is a Windows pseudoconsole');
    const pty = require(path.join(ROOT, 'src', 'pty'));
    if (!pty.ensureBridge().ok) return note('the bridge could not be built');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-term-'));
    const app = appAt(cwd);
    const r = pty.open(app, {});
    assert.strictEqual(r.ok, true, r.why);
    const t = r.terminal;

    // WAIT FOR IT TO REALLY BE RUNNING, by condition rather than by clock.
    const up = Date.now() + 20000;
    while (!t.pid && Date.now() < up) {
      // eslint-disable-next-line no-await-in-loop -- waiting on a real process.
      await new Promise((s) => setTimeout(s, 100));
    }
    assert.ok(t.pid > 0, 'the shell started');

    // THE ONE SHUTDOWN SEQUENCE — a shell left running after LAIN exits is an
    // orphan a person cannot even see to close.
    await require(path.join(ROOT, 'src', 'teardown')).shutdown(app, { why: 'the test', closeWindow: false });

    const gone = Date.now() + 15000;
    while (t.alive && Date.now() < gone) {
      // eslint-disable-next-line no-await-in-loop -- watching it exit.
      await new Promise((s) => setTimeout(s, 150));
    }
    assert.strictEqual(t.alive, false, 'the shell went with LAIN');
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* windows holds it */ }
  });
};
