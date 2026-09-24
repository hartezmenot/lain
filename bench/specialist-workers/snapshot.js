'use strict';

/**
 * FREEZE THE CODE UNDER TEST. An A/B run lasts an hour; editing src/ in the
 * meantime would hand different arms different LAIN builds. This copies the
 * runnable tree (source, tests helpers, bench, workers, the built supervisor)
 * to <dest>, and the A/B is launched from there.
 *
 *   node bench/specialist-workers/snapshot.js <dest>
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const dest = path.resolve(process.argv[2]);
if (fs.existsSync(dest)) throw new Error(`${dest} exists`);
const skip = (rel) => /^(\.git|dist|v1-backup|rust[\\/].*[\\/]target[\\/](debug|bot-certification)|rust[\\/].*[\\/]target[\\/]release[\\/](deps|build|incremental|\.fingerprint)|bench[\\/]out|bench[\\/]specialist-workers[\\/]out[\\/]runs)([\\/]|$)/.test(rel);
fs.cpSync(ROOT, dest, { recursive: true, filter: (src) => !skip(path.relative(ROOT, src)) });
console.log(JSON.stringify({ dest, at: new Date().toISOString() }));
