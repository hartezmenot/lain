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
  await test('HARNESS REAL UI: tabs, sessions, source picker, questions, file-work objects and reload', async () => {
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

      // HOME IS WHERE LAIN OPENS; CHAT IS ONE TAB AWAY, NOT THROUGH HOME.
      await d.until("LAIN.nav.tab() === 'home' && !document.getElementById('vHome').hidden");
      assert.strictEqual(await d.surface('chat'), 'rail', 'from Home, the rail');
      await d.until("LAIN.nav.tab() === 'chat' && LAIN.ui().mode === 'chat'");
      // THE RAIL (2026-09-30): on Chat it is on screen — the way out of Chat — and File/Edit/View/Help are the IDE's only.
      assert.ok(await d.js("(() => { const r = document.getElementById('rail'); const w = r.getBoundingClientRect().width; return r.offsetParent !== null && w > 0 && document.getElementById('menus').offsetParent === null; })()"), 'Chat: the rail, no IDE menubar');
      await d.type('#ask', 'explain what a.js does');
      await d.click('#send');
      await d.until("document.getElementById('stream').innerText.includes('dispatches by path prefix')", 30000);

      // THE ROUTE PILL OPENS THE PROVIDER PICKER (2026-09-30 composer): LAIN's own sources only.
      // (Phase 8.1: the website sources were retired — no ChatGPT.com / gemini.google.com page is ever offered.)
      await d.js("document.querySelector('#composerCells [data-route-pill]').click()");
      await d.until("document.getElementById('pop') && /provider/i.test(document.getElementById('pop').innerText)", 8000);
      assert.ok(!(await d.js("/ChatGPT Chat|Gemini\\.google\\.com/.test(document.getElementById('pop').innerText)")), 'no website source is offered');
      await d.js('LAIN.closePop()');
      // THE IDE, straight from Chat: the attached project's tree and the BOT beside it.
      // THE APP PANEL IS ON CHAT (Phase 8.2): leaving Chat is one click on it.
      assert.strictEqual(await d.surface('ide'), 'rail');
      assert.ok(await d.js("document.getElementById('menus').offsetParent !== null"), 'the IDE has its File / Edit / View / Help');
      await d.until("!document.getElementById('main').hidden && document.getElementById('srcTree').innerText.includes('a.js')", 10000);
      await d.until("document.getElementById('ideBotHost').contains(document.getElementById('ask'))", 5000);
      await d.surface('chat');
      await d.until("document.getElementById('chatHost').contains(document.getElementById('ask'))", 5000);

      // A QUESTION THE WINDOW-STARTED TURN ASKS IS ANSWERED IN THE WINDOW.
      await d.type('#ask', 'change the export style');
      await d.click('#send');
      await d.until("!document.getElementById('askCard').hidden && document.getElementById('askCard').innerText.includes('Which export style?')", 30000);
      await d.js("Array.from(document.querySelectorAll('#askCard button')).find((b) => b.textContent === 'CommonJS').click()");
      await d.until("document.getElementById('stream').innerText.includes('Keeping CommonJS as you chose')", 30000);
      assert.ok(await d.js("document.getElementById('askCard').hidden"), 'the card goes when answered');

      // FILE WORK: a new chat → Attach binds it to Cowork → attachment → a real artifact.
      await d.click('#newChat');
      await d.until("LAIN.state().current.lane === 'engineering' && !LAIN.state().conversation.length && !document.getElementById('attachPill').hidden", 10000);
      const bound = await d.js("LAIN.api('/api/cowork/bind', {})");
      assert.ok(bound.ok, bound.why);
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
      assert.ok(await d.js("document.getElementById('sessions').innerText.includes('clean this spreadsheet')"), 'the file-work conversation is listed with the others');
      await d.shot(path.join(os.tmpdir(), 'lain-realui-cowork.png'));

      // BACK TO THE FIRST CONVERSATION, FROM THE RAIL.
      await d.until("document.querySelectorAll('#sessions .sess').length >= 2", 8000);
      // The row is titled by the work in hand: the Coding Agent took up "change
      // the export style" as its own task (journey.js / identify.js), so the
      // first conversation may be listed under either.
      await d.js("Array.from(document.querySelectorAll('#sessions .sess')).find((b) => /explain what a\.js does|change the export style/.test(b.innerText)).click()");
      await d.until("LAIN.state().current.lane === 'engineering' && document.getElementById('stream').innerText.includes('Keeping CommonJS')", 10000);

      // RELOAD KEEPS THE SESSION AND THE CONVERSATION.
      await d.reload();
      await d.until("!document.getElementById('app').hidden && LAIN.state()", 30000);
      await d.js("LAIN.nav.go('chat')");
      await d.until("document.getElementById('stream').innerText.includes('Keeping CommonJS')", 30000);
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
      await again.until("!document.getElementById('app').hidden && LAIN.state()", 30000);
      await again.js("LAIN.nav.go('chat')");
      await again.until("document.getElementById('stream').innerText.includes('Keeping CommonJS')", 30000);
      assert.ok(await again.js("/explain what a\.js does|change the export style/.test(document.getElementById('sessions').innerText)"), 'the session list survives the restart');
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
      await d.until("!document.getElementById('app').hidden && LAIN.state()", 30000);
      await d.js("LAIN.nav.go('chat')");

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
          sessionTab: (function(){ var r=document.getElementById('chatMore').getBoundingClientRect();
                       return r.width > 0 && r.right <= window.innerWidth + 2; })(),
          railShown: (function(){ var e=document.getElementById('sessions');
                      if (!e || e.offsetParent === null) return false; var r=e.getBoundingClientRect(); return r.width > 0 && r.left < window.innerWidth; })()
        })`));
      };

      for (const [w, h, scale] of [[1920, 1080, 1], [1280, 820, 1], [1024, 700, 1.5], [820, 700, 1], [520, 700, 1], [420, 700, 2]]) {
        const v = await at(w, h, scale);
        assert.ok(v.bleed <= 1, `${w}x${h} @${scale}x bleeds ${v.bleed}px past the window`);
        assert.ok(v.ask, `${w}x${h} @${scale}x: the box you type in is off the window`);
        assert.ok(v.send, `${w}x${h} @${scale}x: Send is off the window`);
      }

      // WIDE (2026-09-30): the conversations are the rail's room, a column beside the chat.
      const wide = await at(1280, 820, 1);
      assert.ok(wide.railShown, 'the conversation list is a column at a normal width');

      // NARROW: the rail steps aside for the conversation, AND every session is
      // still one click away — the Session tab is in the tab bar at every width.
      // A narrow window that simply dropped the list would be one you cannot
      // leave the session you are in.
      const narrow = await at(520, 700, 1);
      assert.ok(!narrow.railShown, 'at 520px the rail is compact and not taking the window');
      assert.ok(narrow.sessionTab, 'but the conversation menu is on screen');
      await d.click('#chatMore');
      await d.until("!!document.querySelector('.pop') && /All sessions/.test(document.querySelector('.pop').innerText)", 5000);
      await d.js("Array.from(document.querySelectorAll('.pop button, .pop .opt, .pop [role=menuitem]')).find((x) => /^All sessions/.test((x.innerText || '').trim())).click()");
      await d.until("document.querySelectorAll('#sessList .srow').length >= 1 && document.querySelector('#sessList .srow').getBoundingClientRect().width > 0", 8000);
    } finally {
      await d.close();
    }
  });
};
