'use strict';

/**
 * ACCOUNTS (Phase 8.4) IN THE REAL WINDOW, with real input — and THE REGRESSION that motivated the hotfix.
 *
 *   §35  THE PRIMARY SCREEN   Codex: A · B · C connected, Claude, each provider its own plane; the ONE thing waiting (an imported
 *                             pool) is "1 account needs setup" in the toolbar — never a row — and opens its own surface;
 *                             Import lives in the toolbar ⋯
 *   §36  DETACH EACH          every account has a ⋯ menu with Detach; detaching Bravo removes only Bravo (real input, confirm)
 *   BUSY                      an account working for the Coding Agent says so, offers View task / Stop task…, and cannot be detached
 *   §22  THE HOTFIX SCENARIO  a Claude request is RUNNING through account A; "+ Add account" is clicked; B is
 *                             connected. A's process is alive, its credentials are the same bytes, B has its own
 *                             directory, no logout ran, and A's request finishes as A.
 *   §13  one Connect verb     every provider is "Connect account" with its mechanism named — no "Open ZCode",
 *                             no "Not available yet"
 *   §18  three different acts Detach · Sign out · Remove LAIN-owned profile; an external profile only detaches
 *
 * Fixtures only: fake Codex and fake `claude` in their own directories. No real account, no real quota.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const { shim } = require('../fixtures/runtimes/shim');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(40); } return false; }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

module.exports = async function () {
  await test('ACCOUNTS 8.4: the provider hierarchy, and a running Claude request survives "+ Add account" — real input', async () => {
    const drv = require('../harness/appdriver');
    const d = await drv.open({ width: 1440, height: 900, script: [] });
    if (d.skipped) { process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const R = require('../harness/realinput')(d);
    const root = d.app._sibling || d.app;
    const fx = require('../harness/fabricfixtures');
    const A = require('../../src/authsession');
    const ai = require('../../src/accountinstances');
    const ca = require('../../src/drivers/claudeaccount');
    const cc = require('../../src/drivers/claudecode');
    const work = require('../../src/accountwork');
    const store = require('../../src/fabric/store');
    const dir = tmpdir('acc84-');
    const DEFAULT_HOME = path.join(dir, 'default-claude'); fs.mkdirSync(DEFAULT_HOME, { recursive: true });
    fs.writeFileSync(path.join(DEFAULT_HOME, '.credentials.json'), JSON.stringify({ fake: true, email: 'default@example.com' }));
    const LOG = path.join(dir, 'claude-invocations.jsonl');
    const saved = { H: process.env.FAKE_CLAUDE_HOME, L: process.env.FAKE_CLAUDE_LOG };
    process.env.FAKE_CLAUDE_HOME = DEFAULT_HOME; process.env.FAKE_CLAUDE_LOG = LOG;
    const log = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const text = (sel) => d.js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);
    const count = (sel) => d.js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    try {
      await d.until("!document.getElementById('app').hidden", 30000);
      root.cfg.runtimes = { 'claude-code': { binary: shim(path.join(dir, 'bin'), 'claude', require('../harness/fabricfixtures').FAKE_CLAUDE) } };
      // §48: CODEX — three connected accounts and one imported pool.
      const win = fx.win;
      await fx.codexAccounts(root, [
        { name: 'Alpha', email: 'alpha@example.com', limits: { primary: win(74, 300, 130), secondary: win(52, 10080, 4000) } },
        { name: 'Bravo', email: 'bravo@example.com', limits: { primary: win(91, 300, 40), secondary: win(67, 10080, 2500) } },
        { name: 'Charlie', email: 'charlie@example.com', limits: { secondary: win(84, 10080, 3000) } },
      ]);
      root.cfg.connections = { ...(root.cfg.connections || {}), 'lain:pool': { baseUrl: 'http://127.0.0.1:9/v1', provider: '9router', apiKey: 'k', models: [{ id: 'cx/gpt-6-sol', owned_by: 'cx' }] } };
      root.cfg.ninerouter = { adopted: { cx: { at: 'x' } } };
      // CLAUDE — account A (LAIN-owned), connected through an AuthSession.
      const start = await A.start(root, 'claude', { name: 'Personal' });
      assert.ok(start.ok, start.why);
      const sa = A.get(start.session.id);
      await until(() => sa.profile && fs.existsSync(sa.profile), 4000);
      fs.writeFileSync(path.join(sa.profile, 'fake-login.json'), JSON.stringify({ email: 'a@example.com', subscriptionType: 'max' }));
      assert.strictEqual((await A.settled(sa.id, 15000)).state, 'CONNECTED');
      const aId = sa.target; const aDir = sa.profile;
      // ANTIGRAVITY, signed in but not yet shown to answer: it says so, and offers the test message.
      await fx.antigravityAccounts(root, [{ name: 'Studio', email: 'ella@example.com' }], { verify: false });
      require('../../src/appcatalog').invalidate(); root._acctMemo = null; root._catMemo = null;
      await d.reload();
      await d.surface('model');
      await d.until("!!document.querySelector('[data-family=codex]')", 20000);

      // ---- §35: THE PRIMARY SCREEN ----------------------------------------------------------------------------------------------
      const codexRows = await d.js("Array.from(document.querySelectorAll('[data-family=codex] > .u-rows > [data-account]')).map((r) => r.querySelector('.u-nm span').textContent)");
      assert.deepStrictEqual(codexRows, ['Alpha', 'Bravo', 'Charlie'], 'the three connected accounts, in order');
      assert.strictEqual(await count('#vModel [data-setup]'), 0, 'an imported pool is NEVER a row of the main screen');
      assert.match(await text('[data-notice=setup]'), /1 account needs setup/, 'it is one line above the list');
      assert.match(await text('[data-family=codex]'), /3 connected/);
      assert.ok(!(await d.js("/Imported pool|Imported Codex|9Router|OmniRoute|Finish setup/i.test(document.getElementById('vModel').innerText)")), 'no router branding, no migration vocabulary on the main screen');
      assert.ok(await count('[data-family=claude] [data-account]') >= 1, 'Claude has its own section');
      // EACH PROVIDER IS ITS OWN PLANE: a flat surface off the page's, separated from the next by clear space — no card grid.
      const planes = await d.js("Array.from(document.querySelectorAll('.dsh-prov')).map((p) => { const r = p.getBoundingClientRect(); const c = getComputedStyle(p); return { top: r.top, bottom: r.bottom, bg: c.backgroundColor, page: getComputedStyle(document.body).backgroundColor, grad: /gradient/.test(c.backgroundImage), shadow: c.boxShadow }; })");
      assert.ok(planes.length >= 2, 'a plane per provider');
      assert.ok(planes.every((p) => p.bg !== p.page && !p.grad && p.shadow === 'none'), 'flat: a plane off the page colour, no gradient, no glow');
      assert.ok(planes.slice(1).every((p, i) => p.top - planes[i].bottom >= 8), 'a clear divider between providers: ' + JSON.stringify(planes.map((p) => [Math.round(p.top), Math.round(p.bottom)])));
      assert.strictEqual(await count('#vModel .fcard, #vModel .dsh-grid'), 0, 'no provider-card grid');
      // A ROW: friendly name, masked identity, status, quota, and ONE control — the ⋯ menu. No internal id anywhere.
      assert.ok(await d.js("Array.from(document.querySelectorAll('[data-family=codex] [data-account]')).every((r) => r.querySelectorAll('button').length === 1)"), 'each account row has exactly one control (⋯)');
      assert.ok(!(await d.js("/codex-[0-9a-f]{6}|claude-[0-9a-f]{6}|priority|profile dir|migration/i.test(document.getElementById('vModel').innerText)")), 'no internal id, priority or profile path in the daily list');
      // QUOTA SAYS WHAT REMAINS (§40): Alpha 74% used → 26% remaining; Bravo 91% used → 9% remaining (amber/red is for LOW remaining).
      const q = await d.js("Array.from(document.querySelectorAll('[data-family=codex] [data-account]:nth-child(1) [data-window]')).map((w) => [w.getAttribute('data-window'), w.getAttribute('data-remaining'), w.getAttribute('data-tone'), w.querySelector('.v').firstChild.textContent])");
      assert.deepStrictEqual(q, [['5-hour', '26', 'ok', '26% remaining'], ['Weekly', '48', 'ok', '48% remaining']], 'Alpha: what remains, in words');
      assert.strictEqual(await d.js("document.querySelector('[data-family=codex] [data-account]:nth-child(2) [data-window]').getAttribute('data-tone')"), 'warn', 'Bravo: 9% remaining is amber');
      // Charlie reports a weekly window only — no invented 5-hour.
      assert.ok(await d.js("(function(){var r=document.querySelector('[data-family=codex] [data-account]:nth-child(3)');return r.querySelectorAll('[data-window]').length===1 && r.querySelector('[data-window]').getAttribute('data-window')==='Weekly';})()"), 'Charlie shows Weekly only');
      await d.shot(path.join(process.env.LAIN_SHOTS_DIR || dir, 'accounts.png'));

      // NOT VERIFIED → a test message → verified (Chat and Assistant are advertised only after a real answer)
      const studio = '[data-family=antigravity] [data-account]';
      assert.match(await text(studio), /Not verified/, 'a sign-in alone is not "Ready"');
      await R.click(`document.querySelector('${studio} .u-ib')`);
      await d.until("!!document.querySelector('.u-menu')", 5000);
      await R.click(R.byText('.u-menu .opt', 'Run a test message'));
      await d.until(`!/Not verified/.test(document.querySelector('${studio}').innerText)`, 40000);
      assert.match(await text(studio), /Ready|Active/, 'it answered');

      // THE TOOLBAR: Refresh · Connect account · ⋯ — Import is one item in the ⋯, not a permanent button.
      assert.strictEqual(await count('[data-act=import]'), 0, 'no standing Import button');
      assert.ok(await count('[data-act=refresh]') === 1 && await count('[data-act=connect]') === 1 && await count('[data-act=accounts-more]') === 1);
      await R.click("document.querySelector('[data-act=accounts-more]')");
      await d.until("!!document.querySelector('.u-menu')", 5000);
      const more = await d.js("Array.from(document.querySelectorAll('.u-menu .opt')).map((b) => (b.querySelector('span > span') || b).textContent.trim())");
      assert.deepStrictEqual(more, ['Discovered accounts', 'Finish setup (1)', 'Import accounts'], 'the ⋯ holds the setup surfaces');
      await d.js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
      // FINISH SETUP is its own surface, reached from the line above the list
      await R.click("document.querySelector('[data-notice=setup]')");
      await d.until("!!document.querySelector('[data-setup]')", 8000);
      assert.strictEqual(await count('[data-setup-family=codex] [data-setup]'), 1, 'the pending pool, under its provider');
      assert.strictEqual(await count('[data-account]'), 0, 'connected accounts are not on this surface');
      await d.shot(path.join(process.env.LAIN_SHOTS_DIR || dir, 'finish-setup.png'));
      await R.click("document.querySelector('.dsh-back')");
      await d.until("!!document.querySelector('[data-family=codex] [data-account]')", 8000);
      // THE MENUS: an account's ⋯ and a provider's ⋯
      await R.click("document.querySelector('[data-family=codex] [data-account]:nth-child(2) .u-ib')");
      await d.until("!!document.querySelector('.u-menu')", 5000);
      const menu = await d.js("Array.from(document.querySelectorAll('.u-menu .opt')).map((b) => b.textContent.trim())");
      assert.deepStrictEqual(menu, ['Details', 'Rename…', 'Use only this account', 'Move priority earlier', 'Move priority later', 'Refresh quota', 'Detach from Noema', 'Sign out'], 'every applicable act, on every account');
      await d.js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
      await R.click("document.querySelector('[data-family=codex] .u-sech-a .u-ib:last-child')");
      await d.until("!!document.querySelector('.u-menu')", 5000);
      const pmenu = await d.js("Array.from(document.querySelectorAll('.u-menu .opt')).map((b) => b.textContent.trim())");
      assert.deepStrictEqual(pmenu, ['Manage accounts', 'Refresh all', 'Change account policy', 'Detach all from Noema', 'Sign out all LAIN-owned accounts']);
      await d.js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");

      // ---- §22: THE HOTFIX SCENARIO ----------------------------------------------------------------------------------------------
      try { fs.unlinkSync(path.join(aDir, 'release')); } catch { /* none */ }
      const events = [];
      const run = (async () => { for await (const ev of cc.runStream(root, { prompt: 'HOLD the long task', mode: 'agent', instanceId: aId, cwd: dir })) events.push(ev.type); return 'finished'; })();
      run.catch(() => {});
      assert.ok(await until(() => fs.existsSync(path.join(aDir, 'runs.jsonl')) && work.busy('claude-code', aId).length === 1));
      const pid = JSON.parse(fs.readFileSync(path.join(aDir, 'runs.jsonl'), 'utf8').trim().split('\n')[0]).pid;
      assert.ok(alive(pid));
      const credsA = fs.readFileSync(path.join(aDir, '.credentials.json'));
      const credsDefault = fs.readFileSync(path.join(DEFAULT_HOME, '.credentials.json'));
      const logBefore = log().length;
      const claudeBefore = await count('[data-family=claude] [data-account]');
      // ---- BUSY: A is working for the Coding Agent — the window says so, and offers the way out, not Detach ----------------------------
      await d.js('LAIN.dash.load(true)');
      await d.until(`!!document.querySelector('[data-account="${aId}"][data-inuse]')`, 10000);
      assert.match(await text(`[data-account="${aId}"]`), /In use by Coding Agent/);
      await R.click(`document.querySelector('[data-account="${aId}"] .u-ib')`);
      await d.until("!!document.querySelector('.u-menu')", 5000);
      const busyMenu = await d.js("Array.from(document.querySelectorAll('.u-menu .opt')).map((b) => [b.textContent.trim(), b.disabled])");
      assert.deepStrictEqual(busyMenu.slice(0, 2), [['View task', false], ['Stop task…', false]]);
      assert.deepStrictEqual(busyMenu.filter((m) => /^(Detach from Noema|Sign out)$/.test(m[0])), [['Detach from Noema', true], ['Sign out', true]], 'destructive acts are disabled while it works');
      await d.js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
      await d.js("(window.LAIN.openExternal = function () { window.__opened = (window.__opened || []).concat([String(arguments[0])]); }, true)");

      await R.click("document.querySelector('[data-add=claude]')");                         // "+ Add account" inside Claude
      // CLAUDE CONNECTS TWO WAYS (spec §58): the subscription's own sign-in, or an Anthropic API key — asked first.
      await d.until("!!document.querySelector('.methoddlg [data-method=oauth]')", 8000);
      await R.click("document.querySelector('.methoddlg [data-method=oauth]')");
      await d.until("!!document.querySelector('.dlg-field input')", 8000);
      await R.click("document.querySelector('.dlg-field input')");
      await R.type('Work');
      await R.click(R.byText('.dlg-actions button', 'Continue'));
      await d.until("!!document.querySelector('[data-auth]')", 15000);
      assert.match(await text('[data-auth]'), /Connecting Claude account[\s\S]*Existing Claude sessions will not be changed/);
      assert.ok(await count('[data-auth-cancel]') === 1, 'a Cancel that stops only this sign-in');
      // the person finishes in their browser: B's OWN directory
      const sb = A.list().find((x) => x.active && x.family === 'claude');
      const sB = A.get(sb.id);
      await until(() => sB.profile && fs.existsSync(sB.profile), 4000);
      assert.notStrictEqual(path.resolve(sB.profile).toLowerCase(), path.resolve(aDir).toLowerCase());
      fs.writeFileSync(path.join(sB.profile, 'fake-login.json'), JSON.stringify({ email: 'b@example.com', subscriptionType: 'pro' }));
      await d.until(`document.querySelectorAll('[data-family=claude] [data-account]').length === ${claudeBefore + 1}`, 30000);

      assert.ok(alive(pid), 'A\'s process was never stopped');
      assert.strictEqual(work.busy('claude-code', aId).length, 1, 'A is still working');
      assert.ok(fs.readFileSync(path.join(aDir, '.credentials.json')).equals(credsA), 'A\'s credentials are the same bytes');
      assert.ok(fs.readFileSync(path.join(DEFAULT_HOME, '.credentials.json')).equals(credsDefault), 'the default profile is untouched');
      const during = log().slice(logBefore);
      assert.ok(!during.some((i) => i.argv[1] === 'logout'), 'no logout');
      assert.ok(during.filter((i) => i.argv[1] === 'login').every((i) => path.resolve(i.cfg).toLowerCase() === path.resolve(sB.profile).toLowerCase()), 'login ran only in B\'s directory');
      assert.ok(!during.some((i) => i.cfg && path.resolve(i.cfg).toLowerCase() === path.resolve(aDir).toLowerCase()), 'nothing touched A\'s directory');
      fs.writeFileSync(path.join(aDir, 'release'), '1');
      assert.strictEqual(await run, 'finished'); assert.ok(events.includes('finish'), 'A\'s request completed as A');

      // ---- §13: ONE CONNECT VERB --------------------------------------------------------------------------------------------------
      await R.click("document.querySelector('[data-act=connect]')");
      await d.until("!!document.querySelector('[data-connect=zai]')", 10000);
      const rows = await d.js("Array.from(document.querySelectorAll('[data-connect]')).map((r) => [r.getAttribute('data-connect'), r.querySelector('button').textContent.trim(), r.querySelector('.u-who').textContent.trim()])");
      // ONE VERB (spec §58: "+ Add account"); how it connects is inside the flow, per provider.
      assert.deepStrictEqual(rows.map((r) => r[1]), ['Add account', 'Add account', 'Add account', 'Add account', 'Add account'], 'one verb for every provider');
      // WHAT EACH OFFERS (spec §58–§63): subscription or API key; Antigravity is Google's coding account; Z.ai is an API in LAIN.
      assert.deepStrictEqual(rows.filter((r) => r[0] !== 'opencode').map((r) => r[2]), ['ChatGPT subscription or an OpenAI API key', 'Claude subscription or an Anthropic API key', 'Google sign-in through Antigravity', 'Noema integrates Z.ai through its API']);
      assert.ok(!(await d.js("/Open ZCode|Not available yet|Sign in with ChatGPT|Connect with Claude/.test(document.getElementById('vModel').innerText)")), 'no per-provider verbs');
      await d.shot(path.join(process.env.LAIN_SHOTS_DIR || dir, 'connect.png'));

      // ---- §18: THREE DIFFERENT ACTS ------------------------------------------------------------------------------------------------
      await R.click("document.querySelector('.dsh-back')");
      await d.until("!!document.querySelector('[data-family=claude]')", 10000);
      await R.click(`document.querySelector('[data-account="${sB.target}"]')`);
      await d.until("!!document.querySelector('[data-sheet]')", 10000);
      const acts = await d.js("Array.from(document.querySelectorAll('[data-sheet] .u-acts-col button')).map((b) => b.textContent.trim())");
      for (const want of ['Detach from Noema', 'Sign out', 'Remove LAIN-owned profile']) assert.ok(acts.includes(want), `${want} is offered for a LAIN-owned account: ${acts.join(' | ')}`);
      await d.shot(path.join(process.env.LAIN_SHOTS_DIR || dir, 'account-sheet.png'));
      await R.click("document.querySelector('[data-sheet] [data-close]')");
      assert.ok(fs.existsSync(path.join(aDir, '.credentials.json')) && ai.records().some((r) => r.id === aId), 'A is still connected');

      // ---- §36: DETACH EACH — Bravo goes, and only Bravo ---------------------------------------------------------------------------
      const bravoHome = fx.homeOf(root, codexRows.length ? await d.js("document.querySelector('[data-family=codex] [data-account]:nth-child(2)').getAttribute('data-account')") : '');
      const bravoAuth = fs.readFileSync(path.join(bravoHome, 'auth.json'));
      await R.click("document.querySelector('[data-family=codex] [data-account]:nth-child(2) .u-ib')");
      await d.until("!!document.querySelector('.u-menu')", 5000);
      await R.click(R.byText('.u-menu .opt', 'Detach from Noema'));
      await d.until("!!document.querySelector('.dlg')", 5000);
      assert.match(await text('.dlg'), /Detach Bravo from Noema\? Noema forgets it — nothing is signed out/);
      await R.click(R.byText('.dlg-actions button', 'Detach'));
      await d.until("document.querySelectorAll('[data-family=codex] [data-account]').length === 2", 10000);
      assert.deepStrictEqual(await d.js("Array.from(document.querySelectorAll('[data-family=codex] > .u-rows > [data-account]')).map((r) => r.querySelector('.u-nm span').textContent)"), ['Alpha', 'Charlie']);
      assert.ok(await count('[data-family=claude] [data-account]') >= 2, 'Claude is unaffected');
      assert.ok(fs.readFileSync(path.join(bravoHome, 'auth.json')).equals(bravoAuth), 'detached is not signed out: its sign-in is the same bytes');
      process.stdout.write(`    screenshots: ${dir}\n`);
    } finally {
      for (const [k, v] of Object.entries({ FAKE_CLAUDE_HOME: saved.H, FAKE_CLAUDE_LOG: saved.L })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      A._reset();
      await d.close();
      try { await require('../../src/harnesslink').shutdown(d.app); } catch { /* nothing held */ }
      await fx.reset();
      try { fs.unlinkSync(store.file()); } catch { /* none */ } store.reset();
    }
  });
};
