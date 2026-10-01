'use strict';

/**
 * THE EXECUTION CLASS (changeclass.js): DIRECT · NARROW · AGENT · PHASED — deterministic, Jev optional and
 * escalation-only, a safety floor nothing crosses, and what a finished quick change leaves for the IDE panel.
 */

const assert = require('assert');
const { test } = require('../helpers');

module.exports = async function () {
  const c = require('../../src/changeclass');

  await test('CHANGE CLASS: trivial edits stay trivial, big work is planned — from the words alone', () => {
    const cases = [
      ['move this 8px down', { selection: true }, 'DIRECT'],
      ['change the header color to teal', {}, 'DIRECT'],
      ['make this button bigger', { fromPreview: true }, 'DIRECT'],
      ['rename the Save button text to Store', {}, 'DIRECT'],
      ['increase the padding of the card', {}, 'DIRECT'],
      // SPEC §102 — the five: the first four are immediate, the fifth is structural.
      ['move this down', { fromPreview: true }, 'DIRECT'],
      ['make this wider', { fromPreview: true }, 'DIRECT'],
      ['change this color', { selection: true }, 'DIRECT'],
      ['add Settings button', { fromPreview: true }, 'DIRECT'],
      ['move config to JSON', {}, 'NARROW'],
      ['add a divider under the header', {}, 'DIRECT'],
      ['add Settings button', {}, 'NARROW'],
      ['add a button that exports the report to PDF', { fromPreview: true }, 'AGENT'],
      ['move this config to JSON', {}, 'NARROW'],
      ['extract this component into its own file', {}, 'NARROW'],
      ['rename getUser to fetchUser across the project', {}, 'NARROW'],
      ['implement OAuth login for the settings page', {}, 'AGENT'],
      ['why does the build fail on Windows?', {}, 'AGENT'],
      ['tidy up the code', {}, 'AGENT'],
      ['migrate the whole app from Webpack to Vite', {}, 'PHASED'],
    ];
    for (const [text, ctx, want] of cases) assert.strictEqual(c.classify(text, ctx).class, want, `${text} → ${want}`);
  });

  await test('CHANGE CLASS: the safety floor — deletion, history and credentials are never a quick edit', () => {
    for (const text of ['delete all the files in the dist folder', 'remove the dist folder', 'git push --force the branch', 'change the API key in the config']) {
      const r = c.classify(text, { selection: true });
      assert.strictEqual(r.floor, 'AGENT', `${text} has the floor`);
      assert.ok(c.ORDER.indexOf(r.class) >= c.ORDER.indexOf('AGENT'), `${text} is at least AGENT (got ${r.class})`);
    }
  });

  await test('CHANGE CLASS: Jev is optional, asked only when recruited and uncertain, and can only escalate', async () => {
    require('../../src/workers')._resetCache();
    const app = { cfg: {}, session: {} };
    // NO JEV: the deterministic class, said as such.
    const none = await c.decide(app, 'tidy up the code', {}, { infer: async () => 'DIRECT' });
    assert.strictEqual(none.class, 'AGENT');
    assert.strictEqual(none.jev, 'absent', 'without a recruited model Jev is never asked');
    // A RECRUITED JEV that says DIRECT for an uncertain AGENT: ignored — it may not lower the class.
    const recruited = { cfg: { workers: { change_class: { model: 'jev-small', gate: { pass: true } } } }, session: {} };
    const lower = await c.decide(recruited, 'tidy up the code', {}, { infer: async () => 'DIRECT' });
    assert.strictEqual(lower.class, 'AGENT', 'a lower label never wins');
    // …and one that says PHASED: taken — an escalation.
    require('../../src/workers')._resetCache();
    const up = await c.decide(recruited, 'tidy up the code', {}, { infer: async () => 'PHASED' });
    assert.strictEqual(up.class, 'PHASED', 'escalation is taken');
    // A CERTAIN deterministic answer is not put to Jev at all.
    let asked = false;
    const sure = await c.decide(recruited, 'move this config to JSON', {}, { infer: async () => { asked = true; return 'PHASED'; } });
    assert.strictEqual(sure.class, 'NARROW');
    assert.strictEqual(asked, false, 'a high-confidence class is not asked about');
  });

  await test('CHANGE CLASS: DIRECT and NARROW turns are told to stay small; the result is left for the IDE panel', () => {
    const app = { cfg: {}, session: { mutationReceipts: [{ verdict: 'KEEP', targets: ['old.js'] }] } };
    const r = c.begin(app, 'move this 8px down', { fromPreview: true });
    assert.strictEqual(r.class, 'DIRECT');
    app.session._role = 'agent';
    assert.match(c.section(app.session), /Execution: DIRECT change/);
    assert.match(c.section(app.session), /geometry/, 'a preview change verifies the element');
    app.session.mutationReceipts.push({ verdict: 'KEEP', targets: ['src/Hero.css'] });
    const row = c.end(app);
    assert.deepStrictEqual(row.files, ['src/Hero.css'], 'only this turn\'s changes');
    assert.strictEqual(row.ok, true);
    assert.strictEqual(app.session._changeClass, null, 'the class ends with the turn');
    assert.strictEqual(app.session.quickChanges.length, 1);
    // AN AGENT TURN leaves no quick-change row and no section.
    c.begin(app, 'implement OAuth login for the settings page');
    assert.strictEqual(c.section(app.session), '');
    assert.strictEqual(c.end(app), null);
  });
};
