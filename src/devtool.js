'use strict';

/**
 * DEVELOPER TOOLS live in tools/dev/ (S9) — compare, survey, deadcode, tokenaudit, the benches — outside the npm
 * package. A command that uses one loads it from a development checkout, and says so plainly where it is absent.
 */

const path = require('path');

function load(name) {
  try { return require(path.join(__dirname, '..', 'tools', 'dev', name)); } catch { return null; }
}

function missing(name) { return `${name} is a developer tool (tools/dev/${name}.js) and is not part of this installation`; }

module.exports = { load, missing };
