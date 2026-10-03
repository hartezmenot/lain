'use strict';

/** WHAT PROVES WORK IN *THIS* PROJECT — a contract derived from what the project itself declares. */

const fs = require('fs');
const path = require('path');
const testing = require('../testing');

/** Read a JSON manifest, or null. A corrupt manifest is an absent one. */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/** SCRIPTS THAT MEAN SOMETHING, and the requirement each one establishes. */
const SCRIPTS = [
  { names: ['typecheck', 'type-check', 'tsc'], description: 'the project typechecks', required: true, kind: 'build' },
  { names: ['build', 'compile'], description: 'the project builds', required: true, kind: 'build' },
  { names: ['lint'], description: 'the project lints clean', required: false, kind: 'command' },
];

/** DERIVE THE CONTRACT. */
function forProject(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const requirements = [];
  const found = [];

  const pkg = readJson(path.join(root, 'package.json'));
  const scripts = (pkg && pkg.scripts) || {};
  for (const entry of SCRIPTS) {
    const name = entry.names.find((n) => typeof scripts[n] === 'string' && scripts[n].trim());
    if (!name) continue;
    found.push(`npm run ${name}`);
    requirements.push({
      description: entry.description,
      required: entry.required,
      checks: [{ kind: entry.kind, label: name, command: `npm run ${name}` }],
    });
  }

  // TOOLCHAINS WHOSE MANIFEST IS THEIR DECLARATION
  if (exists(path.join(root, 'Cargo.toml'))) {
    found.push('cargo build');
    requirements.push({
      description: 'the crate compiles',
      required: true,
      checks: [{ kind: 'build', label: 'cargo build', command: 'cargo build' }],
    });
  }
  if (exists(path.join(root, 'go.mod'))) {
    found.push('go build ./...');
    requirements.push({
      description: 'the module compiles',
      required: true,
      checks: [{ kind: 'build', label: 'go build', command: 'go build ./...' }],
    });
  }

  // AND THE TESTS, WHOEVER OWNS THEM
  const report = testing.discover(root);
  const suite = testing.primary(report);
  if (suite) {
    found.push(suite.command);
    requirements.push({
      description: 'the test suite passes',
      required: true,
      checks: [{ kind: 'tests', label: 'tests', command: suite.command }],
    });
  }

  return {
    name: 'the project is sound',
    requirements,
    found,
    // NOTHING DETECTED IS A FACT, NOT AN ERROR — and it is why an empty contract must never read as a pass.
    empty: requirements.length === 0,
  };
}

module.exports = { forProject, SCRIPTS };
