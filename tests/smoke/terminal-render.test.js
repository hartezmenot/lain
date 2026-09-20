'use strict';

/**
 * WHAT THE DRAWER DRAWS, AGAINST A REAL SHELL.
 *
 * Evidence tier: REAL-UI VERIFIED — a real pseudoconsole (src/pty.js), a real
 * PowerShell writing real control sequences, and the panel's own renderer
 * reading them in the real window.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS PINS SHUT.
 *
 * The panel stripped every control sequence and turned CARRIAGE RETURN into a
 * NEWLINE. Every progress bar, download meter and spinner on Windows redraws
 * one line by returning to its start — so one line that ends at "100%" was
 * drawn as fifty lines ending "2%", "5%", "9%"…
 *
 * That is the exact failure the "it is not a terminal emulator" rule exists to
 * prevent: a build log that is subtly not what the build said. Stripping was
 * not the safe choice here; it was the lie.
 *
 * Cursor addressing, scroll regions and the alternate screen are still absent,
 * deliberately, and a sequence the panel does not implement leaves no trace.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

module.exports = async function () {
  await test('TERMINAL DRAW: carriage return overwrites the line, and colour survives', async () => {
    const drv = require('../harness/appdriver');
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-termdraw-'));
    const d = await drv.open({ cwd: proj, script: [{ text: 'ok.' }] });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    try {
      await d.until("!document.getElementById('app').hidden", 30000);

      // ---- THE RENDERER, FED THE BYTES A SHELL REALLY SENDS -------------
      //
      // Driven directly so the assertion is about the DRAWING rather than
      // about how fast a shell gets to a prompt; the real shell follows.
      const drawn = JSON.parse(await d.js(`(function () {
        var T = LAIN.terminal;
        var ESC = String.fromCharCode(27), CR = String.fromCharCode(13), NL = String.fromCharCode(10);
        T.reset();
        // A progress meter: one line, rewritten three times.
        T.feed('downloading   2%' + CR + 'downloading  57%' + CR + 'downloading 100%' + NL);
        // A red word and a green word, the way a test runner writes them.
        T.feed(ESC + '[31mFAILED' + ESC + '[0m and ' + ESC + '[32mpassed' + ESC + '[0m' + NL);
        // A backspace correction, and an erase-to-end-of-line.
        T.feed('teh' + String.fromCharCode(8) + String.fromCharCode(8) + 'he typo' + NL);
        T.feed('keep' + ESC + '[K' + NL);
        // A sequence the panel does not implement must leave NO trace.
        T.feed(ESC + '[2;5H' + ESC + ']0;a window title' + String.fromCharCode(7) + 'after' + NL);
        var pre = document.createElement('pre');
        T.draw(pre);
        var reds = [], greens = [];
        pre.querySelectorAll('span').forEach(function (s) {
          var st = s.getAttribute('style') || '';
          if (/color:#e86a6a/.test(st)) reds.push(s.textContent);
          if (/color:#4ec98a/.test(st)) greens.push(s.textContent);
        });
        return JSON.stringify({ text: T.asText(), html: pre.innerHTML, reds: reds, greens: greens });
      })()`));

      const lines = drawn.text.split('\n');
      assert.strictEqual(lines[0], 'downloading 100%',
        `the meter is ONE line showing its final state, not three: ${JSON.stringify(lines.slice(0, 4))}`);
      assert.ok(!/downloading   2%/.test(drawn.text), 'the overwritten states are gone');

      assert.deepStrictEqual(drawn.reds, ['FAILED'], 'red is carried, and only over the word that was red');
      assert.deepStrictEqual(drawn.greens, ['passed']);
      assert.match(lines[1], /^FAILED and passed$/, 'and the text itself is unchanged by the colour');

      assert.strictEqual(lines[2], 'the typo', 'backspace deletes rather than printing');
      assert.strictEqual(lines[3], 'keep', 'erase-to-end-of-line clears');

      // NOTHING UNIMPLEMENTED LEAKS THROUGH.
      assert.strictEqual(lines[4], 'after', `an unhandled sequence leaves no trace: ${JSON.stringify(lines[4])}`);
      const ESC = String.fromCharCode(27);
      assert.ok(drawn.text.indexOf(ESC) < 0, 'no escape reaches the screen');
      assert.ok(!/window title|2;5H/.test(drawn.text), 'and no title or cursor-move text does either');
      assert.ok(!/<script|onerror/i.test(drawn.html), 'and what is drawn is nodes, never markup from the shell');

      // ---- A SEQUENCE THAT ARRIVES IN TWO PIECES ------------------------
      //
      // Reads are byte ranges, not message boundaries, so a chunk can end
      // halfway through an escape. Dropping the half that arrived leaves the
      // rest to be parsed as text, and a colour change split across two polls
      // prints "1mRED" into the log.
      const split = JSON.parse(await d.js(`(function () {
        var T = LAIN.terminal, ESC = String.fromCharCode(27);
        T.reset();
        T.feed('before ' + ESC + '[3');      // the poll ends mid-sequence
        T.feed('1mRED' + ESC + '[0m after'); // and the rest arrives next time
        var pre = document.createElement('pre');
        T.draw(pre);
        var reds = [];
        pre.querySelectorAll('span').forEach(function (s) {
          if (/color:#e86a6a/.test(s.getAttribute('style') || '')) reds.push(s.textContent);
        });
        return JSON.stringify({ text: T.asText(), reds: reds });
      })()`));
      assert.strictEqual(split.text, 'before RED after',
        `a split escape must not print its own bytes: ${JSON.stringify(split.text)}`);
      assert.deepStrictEqual(split.reds, ['RED'], 'and it still takes effect once it is complete');

      // ---- AND THE SAME THING FROM A REAL SHELL -------------------------
      const routes = require('../../src/harnessapp/routes');
      const opened = await routes.dispatch(d.app, 'POST', '/api/terminal/open', { cols: 100, rows: 30 });
      if (opened.code !== 200) { process.stdout.write(`    (no shell: ${opened.body && opened.body.why})\n`); return; }
      const id = opened.body.id;
      try {
        let since = 0; let raw = '';
        const pull = async () => {
          const r = await routes.dispatch(d.app, 'POST', '/api/terminal/read', { id, since });
          if (r.code === 200) { since = r.body.at; raw += Buffer.from(r.body.data || '', 'base64').toString('utf8'); }
          return raw;
        };
        const waitFor = async (re, ms) => {
          const end = Date.now() + ms;
          for (;;) { if (re.test(await pull())) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 120)); }
        };
        const type = (s) => routes.dispatch(d.app, 'POST', '/api/terminal/input',
          { id, data: Buffer.from(s + String.fromCharCode(13), 'utf8').toString('base64') });

        assert.ok(await waitFor(/PS .*>/, 25000), 'the shell reached a prompt');
        // A REAL meter written by a real shell, with real carriage returns.
        await type('1..3 | ForEach-Object { Write-Host -NoNewline ("step " + $_ + "/3" + [char]13); Start-Sleep -Milliseconds 120 }; Write-Host ""');
        assert.ok(await waitFor(/step 3\/3/, 25000), 'the shell wrote its meter');

        const real = JSON.parse(await d.js(`(function () {
          var T = LAIN.terminal;
          T.reset();
          T.feed(${JSON.stringify(raw)});
          var t = T.asText();
          return JSON.stringify({ steps: (t.match(/step \\d\\/3/g) || []), hasEsc: /\\u001b/.test(t) });
        })()`));
        // ALL THREE WERE WRITTEN TO THE SAME LINE, so only the last survives.
        assert.deepStrictEqual(real.steps, ['step 3/3'],
          `a meter redrawn in place is one line: ${JSON.stringify(real.steps)}`);
        assert.strictEqual(real.hasEsc, false, 'and no escape reaches the screen');
      } finally {
        await routes.dispatch(d.app, 'POST', '/api/terminal/close', { id });
      }
    } finally {
      await d.close();
    }
  });
};
