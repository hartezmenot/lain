'use strict';

/**
 * A ROUTE WITHOUT A FAMILY (2026-10-01, found on a real machine). A connection the fabric does not group — a localhost
 * OpenAI-compatible router imported as "Codex · 9Router" — resolves a route for its model, but no source family claims
 * it. `sessionintel.lane()` drew the resolved route from `fam.id` and threw "Cannot read properties of null (reading
 * 'id')": `/model` failed with an internal error, and the Harness lost its model state on boot (its intel routes ask
 * for both lanes). The connection itself is the source then.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  await test('LANE: a resolved route with no fabric family is drawn from its connection, never a crash', () => {
    const home = tmpdir('lane-nofam-');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'cx/gpt-6-sol', connection: 'lain:localhost:cx' }));
    const saved = process.env.LAIN_CONFIG_DIR; process.env.LAIN_CONFIG_DIR = home;
    const A = require('../../src/accountcatalog');
    const F = require('../../src/fabric/index');
    const orig = { accountFor: A.accountFor, find: A.find, routeFor: A.routeFor, label: A.label, view: A.view, foa: F.familyOfAccount, off: F.familiesOffering };
    try {
      const acct = { id: 'lain:localhost:cx', name: 'Codex · 9Router' };
      A.find = (app, id) => (id === acct.id ? acct : null);
      A.accountFor = (app, id) => (id === acct.id ? acct : null);
      A.routeFor = () => ({ ok: true, connectionId: acct.id, model: 'cx/gpt-6-sol' });
      A.label = (a) => (a ? a.name : '');
      A.view = (a) => (a ? { id: a.id } : null);
      F.familyOfAccount = () => null;
      F.familiesOffering = () => [];
      const { App } = require('../../src/app');
      const app = new App({ out: { write() {}, on() {}, columns: 100, rows: 30, isTTY: false }, interactive: false, cwd: home });
      const l = require('../../src/sessionintel').lane(app, app.session, 'coding');
      assert.strictEqual(l.route, 'lain:localhost:cx', JSON.stringify({ why: l.why, needs: l.needs, account: l.account, model: l.model }));
      assert.strictEqual(l.display.resolved, true);
      assert.strictEqual(l.display.source, 'lain:localhost:cx');
      assert.match(l.display.text, /^Codex · 9Router · /);
    } finally {
      Object.assign(A, { accountFor: orig.accountFor, find: orig.find, routeFor: orig.routeFor, label: orig.label, view: orig.view });
      F.familyOfAccount = orig.foa; F.familiesOffering = orig.off;
      if (saved == null) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = saved;
    }
  });
};
