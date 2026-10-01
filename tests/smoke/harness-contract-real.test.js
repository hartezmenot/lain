'use strict';

/**
 * THE HARNESS CONTRACT, END TO END, IN THE REAL NATIVE WINDOW.
 *
 * Evidence tier: REAL-DESKTOP VERIFIED. The compiled host (native/host.cs), its
 * WebView2 renderer, the private pipe and a real Core `App`; the model is the
 * mock provider. Every action below is issued FROM INSIDE THE RENDERER through
 * `LAIN.contract` — renderer → host → pipe → routes → Core — so the transport a
 * person's clicks use is the one under test. Launching `LAIN.exe` itself (the
 * launcher with no CLI) is covered by desktop-real.test.js; a release host
 * opens no debugging port, which is why this one is started by the driver.
 *
 * The walk, from the product brief:
 *   engineering sessions render → status projection → open a session → Chat
 *   → choose the Chat model → create a plan → plan ready → Continue to Coding
 *   → accepted plan persists → Coding view with the implementation prompt
 *   prefilled → submit → Coding turn runs → rail RUNNING (and the renderer
 *   receives session.status) → switch session → original still RUNNING →
 *   Project Files shows the right project → panel closes → dev server starts
 *   in the project root → structured 500 evidence → Cowork/Bot → Bot →
 *   Telegram connection surface → Settings → quit cleanly.
 *
 * The visual layer is being redesigned in parallel, so DOM assertions are kept
 * to landmarks that are part of the product (the app shell and both lanes); the
 * rest is asserted on what the renderer received.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const PLAN = '## Plan: fix stalled downloads\n1. Add a stall timer to `DownloadQueue` in queue.js\n2. Retry the stalled item once\n3. Cover it with a test';

module.exports = async function () {
  await test('HARNESS CONTRACT REAL: Chat → plan → Coding → background status → Project Files → dev server → Bot → Settings → quit', async () => {
    if (process.platform !== 'win32') { process.stdout.write('    (skipped: Noema Desktop is Windows-only for now)\n'); return; }
    const proj = tmpdir('contract-proj-');
    fs.writeFileSync(path.join(proj, 'queue.js'), 'class DownloadQueue {}\nmodule.exports = DownloadQueue;\n');
    fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'contractfixture', private: true, scripts: { dev: 'node server.js' } }));
    fs.writeFileSync(path.join(proj, 'server.js'), [
      'const http = require("http"); require("fs").writeFileSync("cwd.txt", process.cwd());',
      'http.createServer((q, s) => { if (q.url.startsWith("/api")) { console.error("proxy error: ECONNREFUSED " + q.url); s.writeHead(500); return s.end("fail"); } s.writeHead(200); s.end("<h1>ok</h1>"); })',
      '  .listen(Number(process.env.PORT), "127.0.0.1");',
    ].join('\n'));

    const drv = require('../harness/appdriver');
    const d = await drv.open({
      cwd: proj,
      script: [
        { text: PLAN },
        { text: 'Implementing now.', delayMs: 4000 },
        { text: 'Done with the timer.' },
      ],
    });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const pid = d.pid;
    const t0 = Date.now();
    const trace = (what) => { if (process.env.LAIN_SMOKE_TRACE) process.stdout.write(`    [${Date.now() - t0}ms] ${what}\n`); };
    const c = (expr) => d.js(`(async () => { const C = window.LAIN.contract; ${expr} })()`);
    try {
      // ---- the shell, the workspace tabs, the sessions --------------------
      trace("the shell, the workspace tabs, the sessions");
      await d.until("!!document.getElementById('app') && !document.getElementById('app').hidden", 40000);
      const text = await d.js("document.getElementById('tabs').innerText");
      // PHASE 8: six top-level surfaces; BOT is Settings › Assistant, SESSION lives in Chat.
      for (const t of ['HOME', 'IDE', 'CHAT', 'MODEL', 'USAGE', 'MCP & SKILLS', 'SETTINGS']) assert.ok(text.toUpperCase().includes(t), `the ${t} tab: ${text}`);
      assert.ok(!/\bBOT\b|\bSESSION\b/.test(text.toUpperCase()), `BOT and SESSION are not top-level tabs: ${text}`);
      assert.ok(await d.js('!!(window.LAIN && window.LAIN.contract)'), 'the contract client is loaded in the renderer');
      await c("window.__events = []; C.on('session.status', function (e) { window.__events.push(e); }); return true;");

      // ---- status projection --------------------------------------------
      trace("status projection");
      let st = await c('return (await C.state()).state;');
      assert.ok(st.header && st.header.status && st.header.status.state, 'the header carries a status');
      assert.ok(st.sessions.engineering.length >= 1, 'engineering sessions render from Core');
      const first = st.header.sessionId;

      // ---- open a session: a new one on this project, Chat view ------------
      trace("open a session: a new one on this project, Chat view");
      const made = await c(`return await C.newSession({ lane: 'engineering', project: ${JSON.stringify(proj)} });`);
      assert.strictEqual(made.ok, true, JSON.stringify(made));
      const a = made.id;
      assert.strictEqual((await c(`return await C.selectView('chat');`)).view, 'chat');
      const pick = await c("return await C.selectModel('chat', 'lain', '');");
      assert.strictEqual(pick.ok, true, `Chat model/source chosen: ${JSON.stringify(pick)}`);

      // ---- create a plan in Chat -------------------------------------------
      trace("create a plan in Chat");
      const sent = await c("return await C.send('chat', 'Plan how to fix Toradb stalled downloads');");
      assert.strictEqual(sent.accepted, true, JSON.stringify(sent));
      await d.until('(async () => { const s = (await window.LAIN.contract.state()).state; return s.plans && s.plans.prompt ? s.plans.prompt.planId : null; })()', 60000);
      st = await c('return (await C.state()).state;');
      assert.strictEqual(st.views.active, 'chat');
      assert.ok(st.conversation.some((m) => m.thread === 'chat' && /Plan: fix stalled downloads/.test(m.text)));

      // ---- Continue to Coding ----------------------------------------------
      trace("Continue to Coding");
      const acc = await c(`return await C.acceptPlan(${JSON.stringify(st.plans.prompt.planId)});`);
      assert.strictEqual(acc.ok, true, JSON.stringify(acc));
      st = await c('return (await C.state()).state;');
      assert.strictEqual(st.views.active, 'coding', 'the Coding view opens');
      assert.strictEqual(st.plans.plans.find((p) => p.id === acc.plan.id).state, 'ACCEPTED', 'the accepted plan persists');
      const prefill = st.composer.coding.prefill;
      assert.ok(prefill && /Implement the accepted plan/.test(prefill.text), 'the implementation prompt is prefilled');
      assert.strictEqual(st.header.status.state === 'RUNNING', false, 'accepting executed nothing');
      const onDisk = JSON.parse(fs.readFileSync(path.join(require('../../src/config').sessionsDir(), `${a}.json`), 'utf8'));
      assert.strictEqual(onDisk.planDocs.find((p) => p.id === acc.plan.id).state, 'ACCEPTED', 'persisted to the session file');

      // ---- the person submits; the Coding turn runs ------------------------
      trace("the person submits; the Coding turn runs");
      // ONLY EVENTS FROM HERE ON COUNT — the Chat turn above already emitted its
      // own RUNNING and DONE, and matching those would prove nothing.
      await c('window.__mark = window.__events.length; return true;');
      const submittedAt = Date.now();
      const run = await c(`return await C.send('coding', ${JSON.stringify(prefill.text)});`);
      assert.strictEqual(run.accepted, true, JSON.stringify(run));
      await d.until(`(async () => { const s = (await window.LAIN.contract.state()).state; const r = s.sessions.engineering.find(function (x) { return x.id === ${JSON.stringify(a)}; }); return r && r.status === 'RUNNING'; })()`, 20000);
      assert.ok(await d.until(`window.__events.slice(window.__mark).some(function (e) { return e.session === ${JSON.stringify(a)} && e.status.state === 'RUNNING'; })`, 10000),
        'the renderer received session.status RUNNING for the Coding turn over the pipe');

      // ---- switch session: A stays RUNNING ---------------------------------
      trace("switch session: A stays RUNNING");
      const other = await c(`return await C.selectSession({ id: ${JSON.stringify(first)} });`);
      assert.strictEqual(other.ok, true);
      st = await c('return (await C.state()).state;');
      assert.strictEqual(st.header.sessionId, first, 'viewing the other session');
      const rowA = st.sessions.engineering.find((r) => r.id === a);
      assert.strictEqual(rowA.status, 'RUNNING', 'the original session is still RUNNING in the rail');
      assert.ok(rowA.state.elapsed >= 0 && rowA.state.startedAt, 'with its clock');
      assert.ok(await d.until(`window.__events.slice(window.__mark).some(function (e) { return e.session === ${JSON.stringify(a)} && e.status.state === 'DONE'; })`, 60000),
        'A finished in the background and the rail was told');
      assert.ok(Date.now() - submittedAt >= 3500, `the DONE is the Coding turn's (it takes ~4s), not an earlier one: ${Date.now() - submittedAt}ms`);
      st = await c('return (await C.state()).state;');
      assert.strictEqual(st.sessions.engineering.find((r) => r.id === a).status, 'DONE');
      await c(`return await C.selectSession({ id: ${JSON.stringify(a)} });`);

      // ---- Project Files: the right project, and it closes -----------------
      trace("Project Files: the right project, and it closes");
      const opened = await c("return await C.panel('toggle', 'PROJECT_FILES');");
      assert.strictEqual(opened.panel.open, 'PROJECT_FILES');
      const tree = await c("return await C.tree('');");
      assert.strictEqual(path.resolve(tree.root).toLowerCase(), path.resolve(proj).toLowerCase(), 'Project Files is the attached project');
      assert.ok(tree.entries.some((e) => e.name === 'queue.js'));
      const closed = await c("return await C.panel('close');");
      assert.strictEqual(closed.panel.open, 'NONE', 'closed with the panel close action');
      st = await c('return (await C.state()).state;');
      assert.strictEqual(st.workspace.openPanel, 'NONE');

      // ---- Workshop dev server: project root, structured 500 ---------------
      trace("Workshop dev server: project root, structured 500");
      const started = await c('return await C.devServer.start({});');
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      assert.strictEqual(started.devServer.status, 'RUNNING');
      assert.strictEqual(fs.realpathSync.native(started.devServer.cwd).toLowerCase(), fs.realpathSync.native(proj).toLowerCase());
      const cwdSeen = fs.readFileSync(path.join(proj, 'cwd.txt'), 'utf8');
      assert.strictEqual(fs.realpathSync.native(cwdSeen).toLowerCase(), fs.realpathSync.native(proj).toLowerCase(), 'the server process ran in the project root');
      const probed = await c("return await C.devServer.probe('/api/downloads');");
      assert.strictEqual(probed.preview.httpStatus, 500);
      assert.strictEqual(probed.preview.server.status, 'RUNNING');
      assert.match(probed.preview.logs, /ECONNREFUSED/);
      assert.strictEqual((await c('return await C.devServer.stop();')).devServer.status, 'STOPPED');

      // ---- Cowork/Bot → Bot → Telegram surface ------------------------------
      trace("Cowork/Bot → Bot → Telegram surface");
      const bot = await c('return await C.bot.connections(false);');
      assert.strictEqual(bot.ok, true, JSON.stringify(bot));
      const tg = bot.platforms.find((p) => p.platform === 'telegram');
      assert.strictEqual(tg.setup, 'harness');
      assert.ok(['NOT_CONNECTED', 'FAILED'].includes(tg.state), `a fresh home has no bot: ${tg.state} ${tg.summary}`);
      const refused = await c("return await C.bot.connectTelegram('not-a-token');");
      assert.strictEqual(refused.ok, false, 'a malformed token is refused before anything is contacted');
      const cowork = await c("return await C.newSession({ lane: 'cowork' });");
      assert.strictEqual(cowork.ok, true, 'a Cowork session is created without waiting on engineering work');

      // ---- Settings ------------------------------------------------------------
      trace("Settings");
      const settings = await c('return await C.settings.get();');
      assert.deepStrictEqual(settings.sections.map((s) => s.id), ['GENERAL', 'MODELS', 'PATHS', 'CONNECTIONS', 'NOTIFICATIONS', 'PRIVACY']);
      const upd = await c("return await C.settings.update('notifications.completion', false);");
      assert.strictEqual(upd.ok, true, JSON.stringify(upd));

      for (const id of [a, cowork.id]) { try { d.app.pool().release(id); require('../../src/sessionstore').forget(id); } catch { /* kept */ } }
    } finally {
      await d.close();
      try { await require('../../src/supervisor').shutdownIn(process.env.LAIN_HOME); } catch { /* none started */ }
      await require('../../src/harnesslink').shutdown(d.app).catch(() => {});
    }
    // ---- quit cleanly: the host process is gone ------------------------------
    let alive = true;
    const end = Date.now() + 15000;
    while (alive && Date.now() < end) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 200)); } catch { alive = false; }
    }
    assert.strictEqual(alive, false, 'the native host exited');
  });
};
