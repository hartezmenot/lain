'use strict';

/** ONE PRODUCT, ONE VERSION (2026-10-07): LAIN's version is package.json's; the Harness and Design carry the same one. */

const assert = require('assert');
const path = require('path');
const { test } = require('../helpers');

module.exports = async function () {
  await test('ONE VERSION: the CLI, the Harness and Design report the same LAIN version', () => {
    const ROOT = path.join(__dirname, '..', '..');
    const v = require(path.join(ROOT, 'package.json')).version;
    assert.strictEqual(require(path.join(ROOT, 'harness', 'package.json')).version, v, 'harness/package.json');
    assert.strictEqual(require(path.join(ROOT, 'packages', 'design-core', 'package.json')).version, v, 'packages/design-core/package.json');
    assert.strictEqual(require('../../src/harnesslocation').root(), path.join(ROOT, 'harness'), 'the Harness is this repository\'s harness/');
  });
};
