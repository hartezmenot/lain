'use strict';

/**
 * PROPORTIONAL VERIFICATION — which evidence a change actually needs (2026-10-01).
 *
 * The smoke tiers grew to ~100 files and ~40 minutes, and every change paid for all of them. A test is worth running
 * when its failure could change whether THIS change is complete. This file names the capabilities the smoke files
 * prove, the source each capability depends on, and the verification LEVEL a set of changed files calls for:
 *
 *   TARGETED   the unit tests of the touched modules                                  (a local change)
 *   IMPACT     + the integration tests and capability smokes whose scope was touched   (a change other surfaces read)
 *   SUBSYSTEM  + every smoke file of the touched capabilities                         (a shared seam)
 *   PROJECT    every tier, every capability                                           (Core's turn path, the runner)
 *   RELEASE    PROJECT + distribution + updater, never from cache                     (packaging)
 *
 * SCOPES ARE CONSERVATIVE: each capability lists what CANNOT affect it (`unaffectedBy`), and everything else does. A
 * wrong guess therefore runs too much, never too little. CORE files (the turn path every surface uses) invalidate
 * every capability.
 *
 * THE PASS CACHE (`--cache`) reuses a file's last PASS only while its fingerprint is identical: the test file, every
 * source file in its capability's scope (content hash), the Node version and the platform. Any relevant edit changes
 * the fingerprint and the file runs again. RELEASE never reads the cache.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const HARNESS_ROOT = path.join(ROOT, 'harness');

/** Touching any of these touches every surface. */
const CORE = [/^src\/(app|turn|provider|session|config|boot|cli|prompt|promptparts|contextfit|turnclose|turnevents|toolstep|jobrunner|submitclose|identify)\.js$/, /^src\/tools\//, /^src\/discipline\//, /^tests\/(run|helpers)\.js$/, /^bin\//, /^package\.json$/];

const CAPS = Object.freeze({
  core: { label: 'the turn loop through the real binary', tiers: ['workflow'], files: () => true,
    unaffectedBy: [/^src\/harnessapp\//, /^src\/workshop\//, /^src\/bot\//, /^distribution\//, /^harness:/] },
  cli: { label: 'the terminal UI', tiers: ['cli'], files: (f) => !/^(preview|ratelimit|provider-health|connection|catalog|research)/.test(f),
    unaffectedBy: [/^src\/harnessapp\//, /^src\/workshop\//, /^src\/bot\//, /^distribution\//, /^harness:/, /^src\/update\//] },
  harness: { label: 'the Harness window (WebView2) and its routes', tiers: ['harness'], files: (f) => !/^preview/.test(f),
    unaffectedBy: [/^src\/ui\//, /^src\/repl\.js$/, /^src\/bot\//, /^distribution\//] },
  preview: { label: 'the Preview and the model\'s pointer/keyboard', tiers: ['harness', 'integration'], files: (f) => /preview/.test(f),
    unaffectedBy: [/^src\/ui\//, /^src\/repl\.js$/, /^src\/bot\//, /^distribution\//, /^src\/fabric\//] },
  provider: { label: 'routes, accounts, quota, rate limits', tiers: ['cli', 'integration'], files: (f) => /^(ratelimit|provider-health|connection|catalog|accounts84-real|modelaccept-real|apiflow-fixture)/.test(f),
    unaffectedBy: [/^src\/ui\//, /^src\/workshop\//, /^distribution\//, /^harness:/] },
  global: { label: 'cross-surface: Bot, dashboard, remote, hygiene', tiers: ['global'], files: () => true,
    unaffectedBy: [/^src\/workshop\//, /^distribution\//] },
  installer: { label: 'setup, PATH, Start Menu, uninstall', tiers: ['distribution'], files: () => true,
    unaffectedBy: [/^src\/(?!boot|home|update\/)/, /^harness:page\//] },
  updater: { label: 'signed feed, stage, apply, rollback', tiers: ['unit'], files: (f) => /lainupdate|lainlifecycle|updater/.test(f),
    unaffectedBy: [/^src\/(?!update\/|boot|home)/, /^harness:page\//] },
});

const LEVEL = Object.freeze(['TARGETED', 'IMPACT', 'SUBSYSTEM', 'PROJECT', 'RELEASE']);

function rel(abs) {
  const a = path.resolve(abs);
  if (a.toLowerCase().startsWith(HARNESS_ROOT.toLowerCase() + path.sep)) return `harness:${path.relative(HARNESS_ROOT, a).replace(/\\/g, '/')}`;
  return path.relative(ROOT, a).replace(/\\/g, '/');
}

/** Files changed in the working trees (git status: modified, added, untracked), as repo-relative names. */
function changedFiles({ since = null } = {}) {
  const { spawnSync } = require('child_process');
  const out = new Set();
  for (const [dir, prefix] of [[ROOT, ''], [HARNESS_ROOT, 'harness:']]) {
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const args = since ? ['diff', '--name-only', since] : ['status', '--porcelain', '--untracked-files=all'];
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const name = since ? line.trim() : line.slice(3).trim().replace(/^.* -> /, '');
      if (name) out.add(prefix + name.replace(/\\/g, '/').replace(/^"|"$/g, ''));
    }
  }
  return [...out];
}

function isCore(f) { return CORE.some((re) => re.test(f)); }
function affects(cap, f) { return isCore(f) || !CAPS[cap].unaffectedBy.some((re) => re.test(f)); }

/** Unit tests named after a touched module: src/fabric/quotaread.js → tests/unit/*quotaread*. */
function unitTargets(changed) {
  const names = fs.readdirSync(path.join(ROOT, 'tests', 'unit')).filter((f) => f.endsWith('.test.js'));
  const hit = new Set();
  for (const f of changed) {
    const m = /(?:^|\/)([A-Za-z0-9_-]+)\.(?:js|cs|rs)$/.exec(f);
    if (!m) continue;
    const stem = m[1].toLowerCase();
    for (const n of names) if (n.toLowerCase().startsWith(stem) || n.toLowerCase().includes(stem)) hit.add(n);
    if (/^tests\/unit\//.test(f)) hit.add(path.basename(f));
  }
  return [...hit].sort();
}

/**
 * THE PLAN for a set of changed files: the level, and which tiers / capabilities / files it calls for.
 * `release: true` forces RELEASE (packaging).
 */
function plan(changed, { release = false } = {}) {
  const src = changed.filter((f) => !/^(docs\/|bench\/|README|.*\.md$)/.test(f));
  const caps = Object.keys(CAPS).filter((c) => src.some((f) => affects(c, f)));
  const core = src.some(isCore);
  let level = 'TARGETED';
  if (release) level = 'RELEASE';
  else if (core) level = 'PROJECT';
  else if (caps.length >= 3) level = 'SUBSYSTEM';
  else if (caps.length) level = 'IMPACT';
  return { level, changed: src, core, capabilities: caps, units: unitTargets(src),
    docsOnly: !src.length && changed.length > 0,
    why: release ? 'packaging: every tier, no cache' : core ? `the turn path every surface uses changed (${src.filter(isCore).slice(0, 3).join(', ')})`
      : caps.length ? `touches ${caps.join(', ')}` : 'local to the modules changed' };
}

// ---- THE PASS CACHE --------------------------------------------------------------------------------------------------

function cacheFile() { return path.join(ROOT, '.lain-test-cache.json'); }
function readCache() { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return { v: 1, files: {} }; } }
function writeCache(c) { try { fs.writeFileSync(cacheFile(), JSON.stringify(c, null, 1)); } catch { /* a cache */ } }

let treeMemo = null;
function treeHashes() {
  if (treeMemo) return treeMemo;
  const out = new Map();
  const walk = (dir, prefix) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'target' || e.name === 'out' || e.name.startsWith('.lain')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, prefix);
      else if (/\.(js|cs|rs|json|html|css)$/.test(e.name)) { try { out.set(prefix + path.relative(prefix ? HARNESS_ROOT : ROOT, p).replace(/\\/g, '/'), crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')); } catch { /* vanished */ } }
    }
  };
  for (const d of ['src', 'bin', 'native', 'distribution', 'tests']) walk(path.join(ROOT, d), '');
  for (const d of ['page', 'native']) walk(path.join(HARNESS_ROOT, d), 'harness:');
  treeMemo = out;
  return out;
}

/** A test file's fingerprint: itself + every file in its capability's scope + runtime identity. */
function fingerprint(tier, file, dir) {
  const caps = Object.keys(CAPS).filter((c) => CAPS[c].tiers.includes(tier) && CAPS[c].files(file));
  const h = crypto.createHash('sha1');
  h.update(`${process.version}|${process.platform}|${tier}|${file}`);
  try { h.update(fs.readFileSync(path.join(dir, file))); } catch { /* none */ }
  for (const [f, sum] of treeHashes()) {
    if (!caps.length || caps.some((c) => affects(c, f))) h.update(`${f}:${sum}\n`);
  }
  return h.digest('hex');
}

module.exports = { CAPS, CORE, LEVEL, plan, changedFiles, unitTargets, affects, isCore, fingerprint, readCache, writeCache, rel };

if (require.main === module) {
  const args = process.argv.slice(2);
  const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : null;
  const p = plan(changedFiles({ since }), { release: args.includes('--release') });
  process.stdout.write(`VERIFICATION LEVEL: ${p.level} — ${p.why}\n`);
  process.stdout.write(`changed: ${p.changed.length} file(s)${p.docsOnly ? ' (documentation only: nothing to run)' : ''}\n`);
  if (p.units.length) process.stdout.write(`targeted unit files: ${p.units.join(', ')}\n`);
  if (p.capabilities.length) process.stdout.write(`capabilities: ${p.capabilities.map((c) => `${c} (${CAPS[c].label})`).join('; ')}\n`);
  const cmds = [];
  if (p.level === 'TARGETED' && p.units.length) cmds.push(`node tests/run.js unit "${p.units.map((u) => u.replace(/\.test\.js$/, '')).join('|')}"`);
  if (p.level === 'IMPACT' || p.level === 'SUBSYSTEM') { cmds.push('node tests/run.js unit', 'node tests/run.js integration'); for (const c of p.capabilities) cmds.push(`node tests/run.js smoke-${c} --cache`); }
  if (p.level === 'PROJECT') cmds.push('node tests/run.js --cache');
  if (p.level === 'RELEASE') cmds.push('node tests/run.js', 'node tests/run.js distribution');
  process.stdout.write(`run:\n${cmds.map((c) => `  ${c}`).join('\n') || '  (nothing)'}\n`);
}
