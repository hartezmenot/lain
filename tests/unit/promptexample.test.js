'use strict';

/**
 * THE SYSTEM PROMPT NAMES NO CONCRETE RUN COMMAND AS ITS EXAMPLE.
 *
 * Live, 2026-09-18 (kr/claude-sonnet-4.5, fixture with scripts test+smoke and
 * no start): the final report said "How to run: npm start" — the literal
 * example from prompt.js's report-shape paragraph. A project with no start
 * script was handed a command that does not exist, drawn in a highlighted box.
 * The example is now a placeholder, with the no-command case spelled out.
 */

const assert = require('assert');
const { test } = require('../helpers');
const { BASE } = require('../../src/prompt');

module.exports = async function () {
  await test('PROMPT: the How-to-run example is a placeholder, not a copyable command', () => {
    const text = String(BASE);
    assert.doesNotMatch(text, /How to run: npm start/, 'a concrete example is copied verbatim by models');
    assert.match(text, /How to run: <command>/);
    assert.match(text, /none \(library\)/, 'and the no-command case has a form to use');
  });
};
