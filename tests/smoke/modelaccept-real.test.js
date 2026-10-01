'use strict';

/**
 * MODEL ACCEPTANCE (Phase 8.4 layout) — the Model Dashboard, in the real window, with real input (CDP Input.*,
 * never a DOM .click()), fixture accounts only:
 *
 *   · MODEL has Accounts · Models · API · Local · Defaults (Accounts first)
 *   · Codex appears ONCE as a provider section — its accounts are rows in it — and no router is named
 *   · the provider's policy is one control in its header (a menu), written to the ONE Core fabric
 *   · provider details: fallback priority reordered, an account renamed
 *   · Models: search the index; choose "Codex › GPT-6 Sol" for Chat
 *   · the composer: Provider · Model · Execution — one Execution dropdown
 *   · API apart: a key added in its own tab (secret store), then its credential removed
 *   · Import: a router's unadopted Antigravity pool is found, brought in as Needs sign-in, and waits for
 *     LAIN's own sign-in — nothing is borrowed, the router is only read
 *   · the tray: Core's quota summary reaches the real host and the window stays alive
 *
 * Two local fakes stand in for the outside world: a router (models by provider prefix) and an OpenAI-compatible
 * endpoint that answers a model listing for the key check. No real account, no quota.
 */

const assert = require('assert');
const http = require('http');
const { test } = require('../helpers');

function fake(models) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    req.resume();
    if (req.method === 'GET' && /\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: models })); }
    res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}/v1` })));
}
const SOL = (levels) => [{ id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6 Sol', hidden: false, isDefault: true, supportedReasoningEfforts: levels.map((e) => ({ reasoningEffort: e, description: '' })) }];

module.exports = async function () {
  await test('MODEL DASHBOARD ACCEPTANCE: providers once, policy/priority/name, Models index, composer, API apart, Import — real input', async () => {
    const drv = require('../harness/appdriver');
    const fx = require('../harness/fabricfixtures');
    const models = [{ id: 'ag/gemini-3.8-flash', owned_by: 'ag' }];
    const router = await fake(models);
    const keyed = await fake([{ id: 'deepseek-v4', object: 'model' }]);
    const d = await drv.open({ width: 1600, height: 900, script: [] });
    if (d.skipped) { router.srv.close(); keyed.srv.close(); process.stdout.write(`    (skipped: ${d.skipped})\n`); return; }
    const R = require('../harness/realinput')(d);
    const root = d.app._sibling || d.app;
    const store = require('../../src/fabric/store');
    const F = require('../../src/fabric/index');
    const tab = (label) => R.byText('#modelTabs button', label);
    try {
      // THE FIXTURE: two real Codex accounts (each in its own home, run by the fake Codex) and an Antigravity pool nobody imported.
      const win = fx.win;
      const accts = await fx.codexAccounts(root, [
        { name: 'Alpha', email: 'alpha@example.com', models: SOL(['high', 'xhigh']), limits: { primary: win(74, 300, 130), secondary: win(52, 10080, 4000) } },
        { name: 'Bravo', email: 'bravo@example.com', models: SOL(['high', 'xhigh']), limits: { primary: win(91, 300, 40) } },
      ]);
      root.cfg.connections = { ...(root.cfg.connections || {}), 'lain:ra': { baseUrl: router.url, provider: '9router', apiKey: 'k-a', models } };
      require('../../src/appcatalog').invalidate();
      root._catMemo = null; root._acctMemo = null;

      await d.until("!document.getElementById('app').hidden");
      await d.reload();
      await d.surface('model');

      // THE TABS, Accounts first.
      await d.until("document.querySelectorAll('#modelTabs button').length === 5", 10000);
      assert.deepStrictEqual(await d.js("Array.from(document.querySelectorAll('#modelTabs button')).map((b) => b.textContent.trim())"), ['Accounts', 'Models', 'API', 'Local', 'Defaults']);
      assert.strictEqual(await d.js("Array.from(document.querySelectorAll('#modelTabs button')).find((b) => b.getAttribute('aria-selected') === 'true').textContent.trim()"), 'Accounts');

      // CODEX ONCE — a section, its accounts as rows; no router named on the surface.
      await d.until("!!document.querySelector('[data-family=codex]')", 20000);
      assert.strictEqual(await d.js("document.querySelectorAll('[data-family=codex]').length"), 1);
      assert.match(await d.js("document.querySelector('[data-family=codex]').innerText"), /Codex[\s\S]*2 accounts/i);
      assert.strictEqual(await d.js("document.querySelectorAll('[data-family=codex] [data-account]').length"), 2);
      assert.ok(!(await d.js("/9Router|OmniRoute/i.test(document.getElementById('vModel').innerText)")), 'no router branding on MODEL');

      // THE POLICY: one control in the provider header — a menu, written to Core.
      await R.click("document.querySelector('[data-select=policy-codex]')");
      await d.until("!!document.querySelector('.u-menu')", 5000);
      await R.click(R.byText('.u-menu .opt', /Ask before switching/));
      await d.until("Array.from(document.querySelectorAll('[data-select=policy-codex]')).some((b) => /Ask on limit/.test(b.innerText))", 10000);
      assert.strictEqual(F.family(root, 'codex').policy, 'ask', 'written to Core');
      assert.ok(!(await d.js("Array.from(document.querySelectorAll('[data-account]')).some((r) => /Ask|Automatic/.test(r.innerText))")), 'the policy is never repeated on an account');

      // PROVIDER DETAILS: priority and a name.
      await R.click("document.querySelector('[data-family=codex] h3')");
      await d.until("!!document.querySelector('[data-sheet=\"provider-codex\"]')", 10000);
      const firstBefore = await d.js("document.querySelector('[data-sheet=\"provider-codex\"] [data-account]').getAttribute('data-account')");
      await R.click("document.querySelectorAll('[data-sheet=\"provider-codex\"] [data-account]')[1].querySelector('[data-move=up]')");   // ↑ on the second account
      await d.until(`!!document.querySelector('[data-sheet="provider-codex"] [data-account]') && document.querySelector('[data-sheet="provider-codex"] [data-account]').getAttribute('data-account') !== ${JSON.stringify(firstBefore)}`, 10000);
      assert.notStrictEqual(store.familyState('codex').order[0], firstBefore, 'the fallback order changed in Core');
      await R.click("document.querySelector('[data-sheet=\"provider-codex\"] [data-account]')");                 // open the first account
      await d.until("!!document.querySelector('[data-sheet^=\"account-\"]')", 10000);
      await R.click(R.byText('[data-sheet^="account-"] .u-acts-col button', 'Rename…'));
      await d.until("!!document.querySelector('.dlg input')", 5000);
      await R.click("document.querySelector('.dlg input')");
      await R.key('a', { ctrl: true });
      await R.text('Work');
      await R.key('Enter');
      await d.until("Array.from(document.querySelectorAll('[data-family=codex] [data-account] .u-nm span')).some((x) => x.textContent === 'Work')", 10000);
      assert.ok(Object.values(store.read().aliases).includes('Work'), 'the name is in the ONE registry');

      // MODELS: the index, searched; choose Codex › GPT-6 Sol for Chat.
      await R.click(tab('Models'));
      await d.until("!!document.querySelector('[data-dshq]')", 10000);
      await R.click("document.querySelector('[data-dshq]')");
      await R.text('gpt-6');
      await d.until("!!document.querySelector('[data-model=\"codex|gpt-6-sol\"]')", 10000);
      assert.match(await d.js("document.querySelector('[data-model=\"codex|gpt-6-sol\"]').innerText"), /GPT-6 Sol[\s\S]*High · XHigh/);
      await R.click("document.querySelector('[data-model=\"codex|gpt-6-sol\"] .u-ib')");
      await d.until("!!document.querySelector('.u-menu')", 5000);
      await R.click(R.byText('.u-menu .opt', 'Use for Chat'));
      await d.until("LAIN.api('/api/intel/lanes', {}).then((r) => r.lanes.chat.family === 'codex' && r.lanes.chat.model === 'gpt-6-sol')", 10000);

      // THE COMPOSER: Provider · Model · Effort · one Execution dropdown.
      await d.surface('chat');
      await d.until("!!document.querySelector('#composerCells .cell.exec')", 15000);
      const labels = await d.js("Array.from(document.querySelectorAll('#composerCells .cell .cl')).map((x) => x.textContent)");
      assert.deepStrictEqual(labels.slice(0, 2), ['Provider', 'Model'], JSON.stringify(labels));
      assert.strictEqual(await d.js("document.querySelectorAll('#composerCells .cell.exec').length"), 1, 'one Execution control');
      assert.strictEqual(await d.js("document.querySelectorAll('#composerCells .cell.exec button').length"), 0, 'not a row of three buttons');
      await R.click("document.querySelector('#composerCells .cell.exec')");
      await d.until("!!document.querySelector('.modepop') && /Execution/i.test(document.querySelector('.modepop').innerText)", 5000);
      await R.click("document.querySelector('.modepop [data-seg=FAST]')");
      await d.until("!!document.querySelector('#composerCells .cell.exec[data-exec=FAST]')", 10000);
      assert.strictEqual(require('../../src/profile').of(root.session, root.cfg), 'FAST');

      // API, APART: a key added in its own tab, into the secret store; then its credential removed.
      await d.surface('model');
      await R.click(tab('API'));
      await d.until("!!document.querySelector('[data-act=add-api]')", 10000);
      await R.click("document.querySelector('[data-act=add-api]')");
      await d.until("!!document.querySelector('.keydlg select')", 10000);
      await d.js("(() => { const s = document.querySelector('.keydlg select'); s.value = 'deepseek'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
      await d.until("document.querySelectorAll('.keydlg input')[1].closest('label').hidden === false", 5000);
      await R.click("document.querySelectorAll('.keydlg input')[0]");
      await R.text('sk-fixture-0123456789');
      await R.click("document.querySelectorAll('.keydlg input')[1]");
      await R.text(keyed.url);
      await R.click(R.byText('.keydlg button', 'Add key'));
      await d.until("!document.querySelector('.keydlg')", 30000);
      const apiId = Object.keys(root.cfg.connections).find((k) => /deepseek/.test(k));
      assert.ok(apiId && root.cfg.connections[apiId].credentialRef, `the key went to the secret store: ${apiId}`);
      assert.ok(!JSON.stringify(root.cfg).includes('sk-fixture-0123456789'), 'the config holds a reference, never the key');
      await d.until(`!!document.querySelector('[data-api="api:${apiId}"]')`, 15000);
      await R.click(tab('Accounts'));
      await d.until("!!document.querySelector('[data-family=codex]')", 10000);
      assert.ok(!(await d.js("!!document.querySelector('[data-family^=\"api:\"]')")), 'an API source is not an account');
      await R.click(tab('API'));
      await d.until(`!!document.querySelector('[data-api="api:${apiId}"]')`, 10000);
      await R.click(`document.querySelector('[data-api="api:${apiId}"] .u-ib')`);
      await d.until("!!document.querySelector('.u-menu')", 5000);
      await R.click(R.byText('.u-menu .opt', 'Remove credential'));
      await d.until("!!document.querySelector('.dlg') && /Delete the key Noema keeps/.test(document.querySelector('.dlg').innerText)", 5000);
      await R.click(R.byText('.dlg button', 'Remove credential'));
      const end = Date.now() + 15000;
      while (Date.now() < end && root.cfg.connections[apiId].credentialRef) await R.pause(200);
      assert.ok(root.cfg.connections[apiId] && !root.cfg.connections[apiId].credentialRef, 'the key is gone; the endpoint stays');

      // IMPORT: the router's Antigravity pool is found and brought in as "Needs sign-in" — nothing borrowed.
      await R.click(tab('Accounts'));
      // Import is one item of the toolbar's ⋯ — not a standing button.
      await d.until("!!document.querySelector('[data-act=accounts-more]')", 10000);
      assert.strictEqual(await d.js("document.querySelectorAll('[data-act=import]').length"), 0, 'no standing Import button');
      await R.click("document.querySelector('[data-act=accounts-more]')");
      await d.until("!!document.querySelector('.u-menu')", 5000);
      await R.click(R.byText('.u-menu .opt', 'Import accounts'));
      await d.until("!!document.querySelector('[data-import-find]')", 10000);
      await R.click("document.querySelector('[data-import-find]')");
      await d.until("Array.from(document.querySelectorAll('[data-import]')).some((r) => /antigravity/i.test(r.innerText))", 10000);
      assert.match(await d.js("Array.from(document.querySelectorAll('[data-import]')).find((r) => /antigravity/i.test(r.innerText)).getAttribute('data-status')"), /Needs sign-in/);
      await R.click("document.querySelector('[data-import-apply]')");
      await d.until("!!document.querySelector('[data-result=reauth-required]')", 15000);
      assert.ok(Object.values(store.placeholders()).some((p) => p.family === 'antigravity' && p.state === 'REAUTH_REQUIRED'), 'Antigravity waits for Noema\'s own sign-in; nothing borrowed');
      const writes = router.seen.filter((r) => r.method !== 'GET');
      assert.deepStrictEqual(writes, [], 'the router was only read');
      await R.click(R.byText('button', 'Open Accounts'));
      // NOTHING IS CONNECTED, so there is no Antigravity section — the waiting entry is "1 account needs setup", and opens its own surface.
      await d.until("!!document.querySelector('[data-notice=setup]')", 10000);
      assert.strictEqual(await d.js("document.querySelectorAll('[data-family=antigravity]').length"), 0, 'the imported account is not an active account, and does not make a provider section');
      await R.click("document.querySelector('[data-notice=setup]')");
      await d.until("!!document.querySelector('[data-setup-family=antigravity] [data-setup]')", 10000);

      // THE TRAY: Core pushes its quota summary to the real host over the real pipe; the host draws it and stays alive.
      const pushed = require('../../src/fabric/tray').changed(root, { force: true });
      assert.ok(pushed.sent, 'the summary reached the host');
      assert.ok(pushed.summary.lines.some((l) => /5h 26% left · Weekly 48% left/.test(l)), pushed.summary.lines.join(' | '));
      await R.pause(500);
      assert.strictEqual(await d.js('1 + 1'), 2, 'the window is alive after the tray update');
      assert.ok(accts.length === 2);
    } finally {
      await d.close();
      try { await require('../../src/harnesslink').shutdown(d.app); } catch { /* nothing held */ }
      await fx.reset();
      try { require('fs').unlinkSync(store.file()); } catch { /* none */ }
      store.reset();
      router.srv.close(); keyed.srv.close();
    }
  });
};
