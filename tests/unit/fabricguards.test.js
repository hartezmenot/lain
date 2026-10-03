'use strict';

/**
 * PHASE 5 ARCHITECTURE GUARDS — the environment fabric's rules, checked.
 *
 *   model routing is not a tool          no tool schema routes, switches or picks accounts
 *   credentials never enter a context    (credentialguard.test.js, static + dynamic)
 *   one account instance owns one config  two instances cannot share a home
 *   usage is keyed by instance           a receipt's account is the instance id
 *   external sessions stay external      no module writes into a runtime's session store
 *   extension reuse shares no state      storage is LAIN's, per id, outside the package
 *   channel lifecycle is complete        connect and disconnect both exist and are routed
 *   eight Codex instances do not collapse (multicodex.test.js)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const SRC = path.join(__dirname, '..', '..', 'src');
const code = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

module.exports = async function () {
  await test('GUARD: model routing is not a tool — nothing the model is offered picks an account, a route or a router', () => {
    const tools = require('../../src/tools');
    const names = tools.schemas(null).map((s) => s.name);
    const bad = names.filter((n) => /route|router|account|switch_model|pick_model|provider/i.test(n));
    assert.deepStrictEqual(bad, [], bad.join(', '));
    for (const s of tools.schemas(null)) {
      const text = JSON.stringify(s.parameters || {});
      assert.ok(!/credential_ref|apiKey|api_key|accountinstance/i.test(text), `${s.name} exposes an account field`);
    }
    for (const f of ['providerdrivers.js', 'accountinstances.js', 'sessionintel.js', 'usage.js']) {
      assert.ok(!/require\('\.\/tools/.test(code(f)), `${f} registers nothing with the tool registry`);
    }
  });

  await test('GUARD: one account instance owns one config — a second instance on the same home is refused', () => {
    const ai = require('../../src/accountinstances');
    try { fs.unlinkSync(ai.file()); } catch { /* fresh */ }
    const home = tmpdir('onehome-');
    const app = { cfg: {}, connections: () => [] };
    const a = ai.add(app, { driver_id: 'codex', config: { home_mode: 'direct', codex_home: home } });
    assert.ok(a.ok, a.why);
    const b = ai.add(app, { driver_id: 'codex', config: { home_mode: 'direct', codex_home: home } });
    assert.strictEqual(b.ok, false);
    assert.ok(/own/.test(b.why));
    const c = ai.add(app, { driver_id: 'codex', config: { home_mode: 'overlay', shared_home: home } });
    assert.ok(c.ok, 'an overlay has a home of its own (its shadow) and shares only sessions');
    try { fs.unlinkSync(ai.file()); } catch { /* clean */ }
  });

  await test('GUARD: usage is keyed by account instance, never by email', () => {
    const u = code('usage.js');
    assert.ok(/account: rec\.account \|\| rec\.connection/.test(u), 'the receipt’s account is the account instance / connection id');
    assert.ok(!/email/.test(u), 'usage never reads an email');
    assert.ok(require('../../src/usage').DIMS.includes('account'));
  });

  await test('GUARD: external sessions stay external — no module writes into a runtime’s session store', () => {
    const e = code('externalsessions.js');
    assert.ok(!/writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync/.test(e), 'externalsessions.js only reads');
    assert.ok(!/turn\/start|thread\/delete|thread\/archive|thread\/metadata/.test(code('drivers/codex.js')), 'the Codex driver never writes a thread');
  });

  await test('GUARD: extension reuse shares no mutable state — storage is LAIN’s own, per id', () => {
    const m = code('exthost/manager.js');
    assert.ok(/extension-storage/.test(m), 'extension state lives under LAIN’s config');
    const ep = code('extpackages.js');
    assert.ok(!/fs\.(write|append|unlink|rm|rename)\w*\(\s*(row\.location|location)/.test(ep), 'nothing is written at an editor’s location');
  });

  await test('GUARD: the channel lifecycle is complete — connect and disconnect, both routed', () => {
    const bc = require('../../src/botconnect');
    for (const f of ['connectTelegram', 'disconnectTelegram', 'resume', 'sendTest', 'startService', 'stopService']) assert.strictEqual(typeof bc[f], 'function', f);
    const routes = require('../../src/harnessapp/botroutes').ROUTES;
    for (const r of ['POST /api/bot/telegram/connect', 'POST /api/bot/telegram/disconnect', 'POST /api/bot/telegram/test', 'POST /api/bot/service']) assert.ok(routes[r], r);
  });
};
