'use strict';

/**
 * CACHE CLEAN, REAL BINARY (the four-gate spec §109). A real session (task, plan, committed checkpoint) made by the
 * real binary with the scripted model; then everything the spec names is put beside it — preview temp, a stale core
 * lock, browser caches, an old build, model metadata, the usage index, an OAuth profile, settings — and the REAL
 * `lain cache inspect` / `lain cache clear` run against it. The temp root is a sandbox (LAIN_CACHE_TMP), never %TEMP%.
 *
 *   deleted    LAIN's temp leftovers older than a day, browser caches, an old build, stale process records (dead pids)
 *   preserved  the session, its task, plan and checkpoint, the OAuth profile, settings, cookies, model metadata,
 *              the project's files, a fresh temp folder, and anything in temp that is not LAIN's
 *   rebuilt    the usage index, removed by hand, is rebuilt by the next read with the same totals
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli } = require('../helpers');

module.exports = async function () {
  await test('CACHE CLEAN (§109): `lain cache clear` removes temp and caches; session, task, checkpoint, OAuth, settings and project files stay; the usage index rebuilds', async () => {
    const cwd = tmpdir('cachereal-');
    const configDir = path.join(cwd, '.config');
    const sysTmp = path.join(cwd, 'system-temp');
    fs.mkdirSync(sysTmp, { recursive: true });
    const env = { LAIN_CACHE_TMP: sysTmp };

    // 1) A REAL SESSION — task, plan, one committed step, a project file — by the real binary.
    const r0 = await runCli([], {
      cwd, configDir, env,
      stdin: 'add a greeting module in two steps\n/exit\n',
      script: [
        { text: 'Planning.', tool_calls: [{ name: 'plan_write', input: { steps: ['write greet.js', 'write its test'] } }] },
        { text: 'greet.js.', tool_calls: [{ name: 'write_file', input: { path: 'src/greet.js', content: 'module.exports = (n) => `hi ${n}`;\n' } }, { name: 'plan_step_done', input: { note: 'greet.js written' } }] },
        { text: 'The test is next.' },
      ],
      timeoutMs: 40000,
    });
    assert.strictEqual(r0.code, 0, r0.stdout.slice(-800));
    const sessions = path.join(configDir, 'sessions');
    const sessionFile = path.join(sessions, fs.readdirSync(sessions).find((f) => /^\d{8}-\d{6}-[a-z0-9]{4}\.json$/.test(f)));
    const before = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.ok(before.task && before.plan && before.checkpoint && before.checkpoint.done === 1, 'a task, a plan and a committed checkpoint');

    // 2) EVERYTHING ELSE THE SPEC NAMES, beside it.
    const aged = Date.now() - 3 * 86400000;
    const put = (p, body, mtime = null) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000); return p; };
    const s = {
      previewTemp: put(path.join(sysTmp, 'lain-preview-abc', 'frame.png'), 'x'.repeat(4096), aged),
      previewTempDir: path.join(sysTmp, 'lain-preview-abc'),
      freshTemp: put(path.join(sysTmp, 'lain-run-today', 'state.json'), '{}'),
      notOurs: put(path.join(sysTmp, 'someone-else', 'keep.txt'), 'not LAIN\'s', aged),
      previewCache: put(path.join(configDir, 'workshop', 'proj-1', 'Default', 'Cache', 'Cache_Data', 'data_0'), 'c'.repeat(8192)),
      previewCookies: put(path.join(configDir, 'workshop', 'proj-1', 'Default', 'Network', 'Cookies'), 'cookie-db'),
      windowCache: put(path.join(configDir, 'desktop', 'EBWebView', 'Default', 'Code Cache', 'js', 'index'), 'c'.repeat(2048)),
      oldBuild: put(path.join(configDir, 'desktop', 'lain-desktop-000000000001.exe'), 'old build', aged),
      newBuild: put(path.join(configDir, 'desktop', 'lain-desktop-000000000002.exe'), 'new build'),
      staleLock: put(path.join(configDir, 'core.json'), JSON.stringify({ pid: 999999, at: aged, pipe: 'lain-stale-test' })),
      staleInstance: put(path.join(configDir, 'instances', '999998.json'), JSON.stringify({ pid: 999998, port: 1, at: aged })),
      liveInstance: put(path.join(configDir, 'instances', `${process.pid}.json`), JSON.stringify({ pid: process.pid, port: 2, at: Date.now() })),
      catalog: put(path.join(configDir, 'catalog', 'openrouter.json'), '{"models":[]}'),
      oauth: put(path.join(configDir, 'accounts', 'codex', 'codex-fixture1', 'auth.json'), '{"fixture":true}'),
      settings: path.join(configDir, 'config.json'),
      project: path.join(cwd, 'src', 'greet.js'),
    };
    // A FOLDER IS AS OLD AS ITS NEWEST ENTRY — itself included: age the leftover's folder too.
    fs.utimesSync(s.previewTempDir, aged / 1000, aged / 1000);
    fs.utimesSync(path.dirname(s.notOurs), aged / 1000, aged / 1000);

    // 3) THE REAL BINARY: inspect, then clear (the safe set — advanced needs --yes and a name).
    const insp = await runCli(['cache', 'inspect'], { cwd, configDir, env, timeoutMs: 30000 });
    assert.strictEqual(insp.code, 0, insp.stderr);
    assert.match(insp.stdout, /Browser caches/);
    assert.match(insp.stdout, /Accounts, OAuth profiles and API keys/, 'what is never cleared is said');
    const clr = await runCli(['cache', 'clear'], { cwd, configDir, env, timeoutMs: 30000 });
    assert.strictEqual(clr.code, 0, `${clr.stdout}\n${clr.stderr}`);
    for (const k of ['previewTemp', 'previewCache', 'windowCache', 'oldBuild', 'staleLock', 'staleInstance']) assert.ok(!fs.existsSync(s[k]), `${k} was cleared`);
    for (const k of ['freshTemp', 'notOurs', 'previewCookies', 'newBuild', 'catalog', 'oauth', 'settings', 'project', 'liveInstance']) assert.ok(fs.existsSync(s[k]), `${k} was kept`);
    assert.match(clr.stdout, /Stale process records/, 'the report names what it swept');
    const after = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.strictEqual(after.task.id, before.task.id, 'the task survived');
    assert.deepStrictEqual(after.checkpoint, before.checkpoint, 'the checkpoint survived, unchanged');
    assert.deepStrictEqual(after.plan.steps.map((x) => [x.text, x.status]), before.plan.steps.map((x) => [x.text, x.status]), 'the plan survived');
    assert.match(fs.readFileSync(s.project, 'utf8'), /hi \$\{n\}/, 'the project file is untouched');
    const advanced = await runCli(['cache', 'clear', 'catalogs'], { cwd, configDir, env, timeoutMs: 30000 });
    assert.notStrictEqual(advanced.code, 0, 'an advanced category is refused without --yes');
    assert.ok(fs.existsSync(s.catalog));

    // 4) THE INDEX REBUILDS: the usage index (the Usage page's buckets) removed; the next read — the same aggregate
    //    the Usage page makes, in its own process — rebuilds it from the receipts, with the same totals.
    const usageDir = path.join(configDir, 'usage');
    const receipts = fs.existsSync(usageDir) ? fs.readdirSync(usageDir).filter((f) => /^receipts-.*\.jsonl$/.test(f)) : [];
    assert.ok(receipts.length, 'the real run left usage receipts');
    const aggregate = () => JSON.parse(require('child_process').execFileSync(process.execPath, ['-e',
      "const g = require(process.argv[1]).aggregate({ by: 'model' }).groups; process.stdout.write(JSON.stringify(g.map((x) => [x.key, x.requests, x.input, x.output])))",
      path.join(__dirname, '..', '..', 'src', 'usageindex.js')], { env: { ...process.env, LAIN_CONFIG_DIR: configDir, LAIN_ISOLATED: '1' }, encoding: 'utf8' }));
    const u1 = aggregate();
    assert.ok(u1.length && u1.every((g) => g[1] > 0), `the receipts aggregate: ${JSON.stringify(u1)}`);
    const indexes = fs.readdirSync(usageDir).filter((f) => /^index-v\d+\.json$/.test(f));
    assert.ok(indexes.length, 'the read persisted its index');
    for (const f of indexes) fs.unlinkSync(path.join(usageDir, f));
    const u2 = aggregate();
    assert.ok(fs.readdirSync(usageDir).some((f) => /^index-v\d+\.json$/.test(f)), 'the index was rebuilt by the next read');
    assert.deepStrictEqual(u2, u1, 'the same totals after the rebuild');
  });
};
