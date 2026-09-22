'use strict';

/**
 * ECO = FEWER TOKENS, NOT FEWER TOOLS (schemacompact.js, 2026-09-23).
 *
 * Measured first: the same fixture cost the same under FAST/NORMAL/ECO (±0.5%),
 * because ~15k tokens of tool schemas rode every request. ECO now sends the
 * same tools — same names, same parameter shapes — with compact prose that
 * keeps every sentence stating a rule.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');
const compact = require('../../src/schemacompact');
const mock = require('../../src/mockprovider');

module.exports = async function () {
  await test('SCHEMA COMPACT: every tool kept, names and parameter keys identical, materially smaller', () => {
    const tools = require('../../src/tools').schemas(null);
    const k = compact.compact(tools);
    assert.deepStrictEqual(k.map((t) => t.name), tools.map((t) => t.name), 'nothing stripped, nothing renamed');
    tools.forEach((t, i) => {
      assert.deepStrictEqual(Object.keys((k[i].parameters || {}).properties || {}), Object.keys((t.parameters || {}).properties || {}), t.name);
      assert.deepStrictEqual((k[i].parameters || {}).required, (t.parameters || {}).required, `${t.name} required`);
    });
    assert.ok(JSON.stringify(k).length < JSON.stringify(tools).length * 0.8, 'at least 20% smaller');
  });

  await test('SCHEMA COMPACT: the RULES survive — refusals, ONE-call rules and "without it" constraints are kept', () => {
    const d = compact.description('Write a file. Overwrites if it exists. Some history about why it exists here. More background. An existing file this session has never read is refused until it is read. Trivia.');
    assert.match(d, /^Write a file\. Overwrites if it exists\./);
    assert.match(d, /is refused until it is read/);
    assert.ok(!/history|Trivia/.test(d));
    assert.match(compact.description('Wait for a job. Blocks. Blah blah. ONE call — it sleeps until the job ends.'), /ONE call/);
  });

  await test('SCHEMA COMPACT: an ECO turn sends the compact tools; NORMAL sends the full ones (measured on the wire audit)', async () => {
    const measure = async (prof) => {
      const dir = tmpdir('eco-schema-');
      const sf = path.join(dir, 'script.json');
      fs.writeFileSync(sf, JSON.stringify([{ text: 'ok' }]));
      process.env.LAIN_PROVIDER = 'mock'; process.env.LAIN_MOCK_SCRIPT = sf; mock._reset();
      try {
        const { App } = require('../../src/app');
        const a = new App({ interactive: false, cwd: dir });
        a.render.write = () => {}; a.render.notice = () => {}; a.render.turnSummary = () => {}; a.render.nl = () => {};
        a.session.save = () => {};
        require('../../src/profile').set(a.session, prof);
        await a.handle('say ok');
        return a.session.turns[0].audits[0].estTokens.toolSchemas;
      } finally { delete process.env.LAIN_PROVIDER; delete process.env.LAIN_MOCK_SCRIPT; mock._reset(); }
    };
    const normal = await measure('NORMAL');
    const eco = await measure('ECO');
    assert.ok(eco < normal * 0.85, `ECO schemas ${eco} vs NORMAL ${normal}`);
  });
};
