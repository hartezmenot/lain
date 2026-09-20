'use strict';

/**
 * THE HARNESS APPLICATION, DRIVEN THROUGH ITS OWN WINDOW.
 *
 * Evidence tier: REAL-UI VERIFIED for the application shell — a real `App`, the
 * real Harness server, and a Harness-owned Chromium driven through the DOM
 * (tests/harness/appdriver.js). The model is the mock provider; website model
 * sources are not contacted. SKIPS, and says so, without a Chromium.
 *
 * What it walks, in one process, without a restart:
 *   the application shell is showing and there is no login gate in the
 *   DOM flag — the defect this found) → a chat turn → the model-source picker
 *   → the Source workspace pill (distinct from the model pill) → a question the
 *   window-started turn asks, answered in the window → the Cowork lane empty
 *   state → a new Cowork session → an attachment → a Cowork turn producing a
 *   real owned artifact, shown as a result object → switching back to the
 *   engineering session from the list → a reload that keeps everything.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

module.exports = async function () {
  await test('HARNESS REAL UI: lanes, sessions, source picker, questions, Cowork objects and reload', async () => {
    const drv = require('../harness/appdriver');
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-realui-'));
    fs.writeFileSync(path.join(proj, 'a.js'), 'module.exports = 1;\n');
    const d = await drv.open({
      cwd: proj,
      script: [
        { text: 'The router dispatches by path prefix; a.js exports 1.' },
        { text: 'One question first.', tool_calls: [{ name: 'ask_user', input: { question: 'Which export style?', options: ['CommonJS', 'ESM'], input: 'choice' } }] },
        { text: 'Keeping CommonJS as you chose.' },
        { text: 'Building the cleaned workbook.', tool_calls: [{ name: 'cowork_spreadsheet_create', input: { name: 'clean.xlsx', sheets: [{ name: 'Sales', rows: [['region', 'amount'], ['north', 10], ['south', 5]] }] } }] },
        { text: 'Done: clean.xlsx has the deduplicated rows.' },
      ],
    });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const errors = [];
    await d.page.conn.send('Runtime.enable');
    d.page.conn.on((m, p) => { if (m === 'Runtime.exceptionThrown') errors.push(JSON.stringify(p.exceptionDetails).slice(0, 300)); });
    try {
      // CONNECTED, AND THE GATE IS NOT PAINTED OVER THE APP.
      await d.until("!document.getElementById('app').hidden && !document.getElementById('gate')");
      assert.ok(!(await d.js("document.body.innerText.includes('password')")), 'no password prompt anywhere');

      // CHAT.
      await d.type('#ask', 'explain what a.js does');
      await d.click('#send');
      await d.until("document.getElementById('stream').innerText.includes('dispatches by path prefix')", 30000);

      // THE MODEL-SOURCE PICKER AND THE SOURCE WORKSPACE ARE DIFFERENT CONTROLS.
      await d.click('#srcPill');
      await d.until("document.getElementById('pop') && /ChatGPT\\.com/.test(document.getElementById('pop').innerText) && /Gemini\\.google\\.com/.test(document.getElementById('pop').innerText)", 8000);
      await d.js("document.getElementById('pop').remove()");
      await d.click('#codePill');
      await d.until("!document.getElementById('srcPanel').hidden", 8000);
      await d.click('#codePill');

      // A QUESTION THE WINDOW-STARTED TURN ASKS IS ANSWERED IN THE WINDOW.
      await d.type('#ask', 'change the export style');
      await d.click('#send');
      await d.until("!document.getElementById('askCard').hidden && document.getElementById('askCard').innerText.includes('Which export style?')", 30000);
      await d.js("Array.from(document.querySelectorAll('#askCard button')).find((b) => b.textContent === 'CommonJS').click()");
      await d.until("document.getElementById('stream').innerText.includes('Keeping CommonJS as you chose')", 30000);
      assert.ok(await d.js("document.getElementById('askCard').hidden"), 'the card goes when answered');

      // COWORK: empty lane → new session → attachment → a real artifact.
      await d.click('#laneCo');
      await d.until("!document.getElementById('laneEmpty').hidden && getComputedStyle(document.querySelector('.composer')).display === 'none'", 8000);
      await d.click('#laneEmptyGo');
      await d.until("LAIN.state().current.lane === 'cowork' && !document.getElementById('attachPill').hidden", 10000);
      const csv = Buffer.from('region,amount\nnorth,10\nnorth,10\nsouth,5\n').toString('base64');
      const staged = await d.js(`LAIN.api('/api/cowork/attachment', { name: 'sales.csv', mime: 'text/csv', data: '${csv}' })`);
      assert.ok(staged.ok, staged.why);
      await d.until("document.getElementById('coworkObjects').innerText.includes('sales.csv')", 8000);
      await d.type('#ask', 'clean this spreadsheet');
      await d.click('#send');
      await d.until("document.getElementById('stream').offsetHeight > 60 && document.getElementById('stream').innerText.includes('clean.xlsx has the deduplicated rows')", 60000);
      // The backend names the owned artifact (clean-created.xlsx); the page shows its name.
      await d.until("/result\\s*clean[\\w-]*\\.xlsx/i.test(document.getElementById('coworkObjects').innerText)", 15000);
      assert.ok(await d.js("document.getElementById('coworkObjects').innerText.includes('Save')"), 'a result object can be saved');
      // THE ATTACHMENT WAS HANDED TO THE TURN, so it is no longer waiting as an input
      // (it stayed staged forever before: prepareInput ran only for a static port).
      const sent = await d.js("LAIN.state().conversation.filter((m) => m.role === 'user').map((m) => m.text).join('\\n')");
      assert.match(sent, /sales\.csv/, 'the staged file reached the model with the request');
      assert.ok(!(await d.js("/input\\s*sales\\.csv/i.test(document.getElementById('coworkObjects').innerText)")), 'and is not still staged');
      assert.ok(await d.js("document.getElementById('sessions').innerText.includes('clean this spreadsheet')"), 'the Cowork session is listed in its own lane');
      await d.shot(path.join(os.tmpdir(), 'lain-realui-cowork.png'));

      // BACK TO THE ENGINEERING SESSION, FROM THE LIST.
      await d.click('#laneEng');
      await d.until("document.querySelectorAll('#sessions .sess').length >= 1", 8000);
      await d.js("document.querySelector('#sessions .sess').click()");
      await d.until("LAIN.state().current.lane === 'engineering' && document.getElementById('stream').innerText.includes('Keeping CommonJS')", 10000);

      // RELOAD KEEPS THE SESSION AND THE CONVERSATION.
      await d.reload();
      await d.until("!document.getElementById('app').hidden && document.getElementById('stream').innerText.includes('Keeping CommonJS')", 30000);
      assert.deepStrictEqual(errors, [], 'the page threw nothing');
    } finally {
      await d.close();
    }

    // ---- LAIN RESTARTS: a new process resumes the session, a new window shows it.
    const sessionId = d.app.session.id;
    d.app.session.save();
    const again = await drv.open({ cwd: proj, resume: sessionId, script: [{ text: 'After the restart.' }] });
    if (again.skipped) return;
    try {
      await again.until("!document.getElementById('app').hidden && document.getElementById('stream').innerText.includes('Keeping CommonJS')", 30000);
      assert.ok(await again.js("document.getElementById('sessions').innerText.includes('explain what a.js does')"), 'the session list survives the restart');
      await again.type('#ask', 'and after a restart?');
      await again.click('#send');
      await again.until("document.getElementById('stream').innerText.includes('After the restart.')", 30000);
    } finally {
      await again.close();
    }
  });

  // ---------------------------------------------------------------------
  // A WINDOW THAT IS NOT FULL SCREEN.
  //
  // Half a screen beside an editor is a normal way to keep LAIN open, and it
  // was broken: measured at 520px, the grid was 813px wide and the composer sat
  // 293px off the right edge — a LAIN you could read and could not type into.
  // Two causes, both of them a track refusing to be narrower than its contents:
  // `1fr` instead of `minmax(0,1fr)`, and a composer pill row that would not
  // wrap.
  //
  // THE ASSERTION IS THE ONE THAT MATTERS: at every width, you can type, and
  // you can reach the sessions. Not "it looks right" — nothing here reads a
  // pixel of the screen.
  await test('HARNESS REAL UI: narrow, wide and high-DPI — the composer is always reachable', async () => {
    const drv = require('../harness/appdriver');
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-width-'));
    const d = await drv.open({ cwd: proj, script: [{ text: 'ok.' }] });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    try {
      await d.until("!document.getElementById('app').hidden", 30000);

      const at = async (w, h, scale) => {
        await d.page.conn.send('Emulation.setDeviceMetricsOverride',
          { width: w, height: h, deviceScaleFactor: scale, mobile: false });
        await new Promise((r) => setTimeout(r, 350));
        return JSON.parse(await d.js(`JSON.stringify({
          bleed: document.documentElement.scrollWidth - window.innerWidth,
          ask: (function(){ var e=document.getElementById('ask'); var r=e.getBoundingClientRect();
                return r.width > 40 && r.right <= window.innerWidth + 2; })(),
          send: (function(){ var e=document.getElementById('send'); var r=e.getBoundingClientRect();
                 return r.width > 0 && r.right <= window.innerWidth + 2; })(),
          railBtn: (function(){ var e=document.getElementById('railBtn'); var r=e.getBoundingClientRect();
                    return r.width > 0; })(),
          railShown: (function(){ var e=document.querySelector('#sessions .sess') || document.querySelector('#sessions .empty');
                      return !!e && e.getBoundingClientRect().width > 0; })()
        })`));
      };

      for (const [w, h, scale] of [[1920, 1080, 1], [1280, 820, 1], [1024, 700, 1.5], [820, 700, 1], [520, 700, 1], [420, 700, 2]]) {
        const v = await at(w, h, scale);
        assert.ok(v.bleed <= 1, `${w}x${h} @${scale}x bleeds ${v.bleed}px past the window`);
        assert.ok(v.ask, `${w}x${h} @${scale}x: the box you type in is off the window`);
        assert.ok(v.send, `${w}x${h} @${scale}x: Send is off the window`);
      }

      // WIDE: the rail is a column and the button is not there to be pressed.
      const wide = await at(1280, 820, 1);
      assert.ok(wide.railShown, 'the session rail is a column at a normal width');
      assert.ok(!wide.railBtn, 'and the narrow-width Sessions button is not taking header space');

      // NARROW: the rail is out of the way, AND still reachable. A narrow window
      // that simply dropped the session list would be one you cannot leave the
      // session you are in — the defect the session pool exists to prevent.
      const narrow = await at(520, 700, 1);
      assert.ok(!narrow.railShown, 'at 520px the rail is not taking half the window');
      assert.ok(narrow.railBtn, 'but there is a Sessions button');
      const opened = await d.js(`(function(){
        document.getElementById('railBtn').click();
        var e = document.querySelector('#sessions .sess') || document.querySelector('#sessions .empty');
        return !!e && e.getBoundingClientRect().width > 0;
      })()`);
      assert.strictEqual(opened, true, 'and pressing it brings the sessions back');
    } finally {
      await d.close();
    }
  });
};
