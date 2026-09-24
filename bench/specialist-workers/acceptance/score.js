'use strict';

/**
 * SCORE A WORKING COPY against the hidden acceptance suite.
 *
 *   node bench/specialist-workers/acceptance/score.js <dir> [--json]
 *
 * Runs (1) the copy's own tests (`node --test tests/`), (2) the hidden unit
 * acceptance (backend + client defects), (3) the browser acceptance + final
 * smoke (Edge, real layout). Each check is pass/fail; nothing is weighted.
 */

const path = require('path');
const { spawnSync } = require('child_process');

function tap(out) {
  const rows = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/^(not ok|ok) \d+ - (.+?)(?:\s+#.*)?$/);
    if (m && !/^\s/.test(line)) rows.push({ id: m[2].trim(), ok: m[1] === 'ok' });
  }
  return rows;
}

function score(dir) {
  const env = { ...process.env, FIXTURE_DIR: dir };
  delete env.LOG_LEVEL;
  const own = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: dir, env, encoding: 'utf8', timeout: 120000 });
  const unit = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(__dirname, 'unit.test.mjs')], { cwd: dir, env, encoding: 'utf8', timeout: 120000 });
  const br = spawnSync(process.execPath, [path.join(__dirname, 'browser.mjs'), '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 180000 });
  let browser = { pass: 0, total: 0, smoke: false, checks: [] };
  try { browser = JSON.parse(String(br.stdout).trim().split(/\r?\n/).pop()); } catch { browser.error = String(br.stderr || br.stdout).slice(0, 500); }
  const ownRows = tap(own.stdout);
  const unitRows = tap(unit.stdout);
  const checks = [
    ...unitRows.map((r) => ({ ...r, suite: 'unit' })),
    ...browser.checks.map((c) => ({ id: c.id, ok: c.ok, detail: c.detail, suite: 'browser' })),
  ];
  return {
    ownTests: { pass: own.status === 0, count: ownRows.length, failed: ownRows.filter((r) => !r.ok).map((r) => r.id) },
    acceptance: { pass: checks.filter((c) => c.ok).length, total: checks.length },
    finalSmoke: Boolean(browser.smoke),
    checks,
  };
}

module.exports = { score };

if (require.main === module) {
  const r = score(path.resolve(process.argv[2]));
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const c of r.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} [${c.suite}] ${c.id}${c.detail ? ' · ' + c.detail : ''}`);
    console.log(`own tests ${r.ownTests.pass ? 'PASS' : 'FAIL'} (${r.ownTests.count}) · acceptance ${r.acceptance.pass}/${r.acceptance.total} · final smoke ${r.finalSmoke ? 'PASS' : 'FAIL'}`);
  }
}
