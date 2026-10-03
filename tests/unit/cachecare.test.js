'use strict';

/**
 * CLEAR CACHE & TEMPORARY FILES (cachecare.js, Gate 3 §77–80) — in a SANDBOX: a throwaway LAIN home and a
 * throwaway temp folder (LAIN_CACHE_TMP). Nothing outside them is measured or removed.
 *
 *   SAFE      browser caches (never cookies / storage), superseded builds, day-old lain-* temp leftovers, old
 *             screenshots and traces — taken by "Clear safe cache"
 *   ADVANCED  catalogs, old undo history, usage history — only when named AND confirmed
 *   NEVER     sessions, evidence, backups, accounts, secrets, settings, sign-ins, the workspace root, another
 *             application's temp files, a fresh leftover, the newest build
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir } = require('../helpers');

module.exports = async function () {
  const care = require('../../src/cachecare');
  const DAY = 864e5;

  function put(p, text = 'x', ageDays = 0) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    if (ageDays) { const t = new Date(Date.now() - ageDays * DAY); fs.utimesSync(p, t, t); }
  }
  function age(dir, days) {
    const t = new Date(Date.now() - days * DAY);
    const walk = (d) => { for (const e of fs.readdirSync(d)) { const p = path.join(d, e); if (fs.statSync(p).isDirectory()) walk(p); fs.utimesSync(p, t, t); } };
    walk(dir); fs.utimesSync(dir, t, t);
  }

  async function sandbox(fn) {
    const home = tmpdir('cc-home-');
    const tmp = tmpdir('cc-tmp-');
    const was = { home: process.env.LAIN_CONFIG_DIR, tmp: process.env.LAIN_CACHE_TMP };
    process.env.LAIN_CONFIG_DIR = home;
    process.env.LAIN_CACHE_TMP = tmp;
    const H = (...p) => path.join(home, ...p);
    // DURABLE — must survive every clear.
    for (const p of ['sessions/s1.json', 'evidence/e1/x.json', 'backups/b1/file.txt', 'accounts/codex-1/auth.json', 'secrets/k.bin', 'config.json', 'supervisor/events.jsonl', 'webmodels/chatgpt-web/Default/Cookies', 'browser/profile/Default/Login Data']) put(H(p), 'keep', 60);
    // BROWSER PROFILES: caches go, storage and sign-ins stay.
    put(H('desktop/EBWebView/Default/Cache/Cache_Data/f1'), 'c'.repeat(1000));
    put(H('desktop/EBWebView/Default/Local Storage/leveldb/000.ldb'), 'keep');
    put(H('desktop/EBWebView/GrShaderCache/data_0'), 'g'.repeat(500));
    put(H('workshop/abc123/Default/Code Cache/js/x'), 'j'.repeat(700));
    put(H('webmodels/chatgpt-web/Default/Cache/Cache_Data/y'), 'w'.repeat(300));
    // BUILDS: the newest stays.
    put(H('desktop/lain-desktop-aaaaaaaaaaaa.exe'), 'old', 5);
    put(H('desktop/lain-desktop-bbbbbbbbbbbb.exe'), 'new');
    put(H('pty/lain-pty-cccccccccccc.exe'), 'only');
    // SCREENSHOTS / TRACES by age.
    put(H('browser/screenshots/old.png'), 'o', 8); put(H('browser/screenshots/new.png'), 'n');
    put(H('reqtrace/20260901-old.jsonl'), '{}', 20); put(H('reqtrace/20260929-new.jsonl'), '{}');
    // ADVANCED.
    put(H('catalog/lain_x.json'), '{}');
    fs.mkdirSync(H('checkpoints/old-session'), { recursive: true }); put(H('checkpoints/old-session/f'), 'u'.repeat(200)); age(H('checkpoints/old-session'), 40);
    put(H('checkpoints/current-session/f'), 'keep'); age(H('checkpoints/current-session'), 40);
    put(H('usage/receipts-2026-09.jsonl'), '{}');
    // TEMP: only day-old lain-* leftovers; never another app's, never a fresh one, never the workspace root.
    fs.mkdirSync(path.join(tmp, 'lain-run-old')); put(path.join(tmp, 'lain-run-old', 'a.txt'), 'r'.repeat(400)); age(path.join(tmp, 'lain-run-old'), 2);
    fs.mkdirSync(path.join(tmp, 'lain-run-new')); put(path.join(tmp, 'lain-run-new', 'a.txt'), 'fresh');
    fs.mkdirSync(path.join(tmp, 'other-app-old')); put(path.join(tmp, 'other-app-old', 'a.txt'), 'theirs'); age(path.join(tmp, 'other-app-old'), 9);
    fs.mkdirSync(path.join(tmp, 'lain-workspaces', 'ws1'), { recursive: true }); put(path.join(tmp, 'lain-workspaces', 'ws1', 'f'), 'ws'); age(path.join(tmp, 'lain-workspaces'), 9);
    try { await fn({ home, tmp, H, app: { session: { id: 'current-session' } } }); } finally {
      if (was.home == null) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = was.home;
      if (was.tmp == null) delete process.env.LAIN_CACHE_TMP; else process.env.LAIN_CACHE_TMP = was.tmp;
    }
  }
  const byId = (r) => Object.fromEntries(r.categories.map((c) => [c.id, c]));

  // IN A CHILD PROCESS: an earlier test's late async write (a usage receipt, a catalog) lands in whatever home is set
  // when it finishes — this sandbox, mid-test — and made the exact counts below flaky (S5.2). A fresh process has none.
  const inspectIsolated = (home, tmp) => {
    const script = `require(${JSON.stringify(require.resolve('../../src/cachecare'))}).inspect({ session: { id: 'current-session' } }).then((r) => process.stdout.write(JSON.stringify(r)))`;
    const r = require('child_process').spawnSync(process.execPath, ['-e', script], { env: { ...process.env, LAIN_CONFIG_DIR: home, LAIN_CACHE_TMP: tmp }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return JSON.parse(r.stdout);
  };

  await test('CACHE: inspect finds exactly the disposable things, by category, with sizes', () => sandbox(async ({ home, tmp }) => {
    const r = byId(inspectIsolated(home, tmp));
    assert.strictEqual(r['browser-cache'].items, 4, 'Cache, GrShaderCache, Code Cache, a web model\'s Cache — nothing else of a profile');
    assert.strictEqual(r['browser-cache'].bytes, 1000 + 500 + 700 + 300);
    assert.strictEqual(r['old-builds'].items, 1, 'the superseded host only; the newest host and the only pty stay');
    assert.strictEqual(r.temp.items, 1, 'only the day-old lain-* leftover');
    assert.strictEqual(r.screenshots.items, 1);
    assert.strictEqual(r.traces.items, 1);
    assert.strictEqual(r.catalogs.items, 1);
    assert.strictEqual(r['undo-history'].items, 1, 'the current session\'s undo history is never offered');
    assert.strictEqual(r['usage-history'].items, 1);
    assert.deepStrictEqual(care.SAFE.sort(), ['browser-cache', 'old-builds', 'screenshots', 'stale-records', 'temp', 'traces', 'workspaces']);
  }));

  await test('CACHE: "Clear safe cache" takes the safe categories and nothing durable', () => sandbox(async ({ tmp, H, app }) => {
    const r = await care.clear(app);
    assert.strictEqual(r.ok, true);
    assert.ok(r.freed >= 1000 + 500 + 700 + 300 + 400, `freed ${r.freed}`);
    for (const gone of ['desktop/EBWebView/Default/Cache', 'desktop/EBWebView/GrShaderCache', 'workshop/abc123/Default/Code Cache', 'webmodels/chatgpt-web/Default/Cache', 'desktop/lain-desktop-aaaaaaaaaaaa.exe', 'browser/screenshots/old.png', 'reqtrace/20260901-old.jsonl']) {
      assert.ok(!fs.existsSync(H(gone)), `${gone} is cleared`);
    }
    assert.ok(!fs.existsSync(path.join(tmp, 'lain-run-old')));
    for (const kept of ['sessions/s1.json', 'evidence/e1/x.json', 'backups/b1/file.txt', 'accounts/codex-1/auth.json', 'secrets/k.bin', 'config.json', 'supervisor/events.jsonl',
      'webmodels/chatgpt-web/Default/Cookies', 'browser/profile/Default/Login Data', 'desktop/EBWebView/Default/Local Storage/leveldb/000.ldb',
      'desktop/lain-desktop-bbbbbbbbbbbb.exe', 'pty/lain-pty-cccccccccccc.exe', 'browser/screenshots/new.png', 'reqtrace/20260929-new.jsonl',
      'catalog/lain_x.json', 'checkpoints/old-session/f', 'usage/receipts-2026-09.jsonl']) {
      assert.ok(fs.existsSync(H(kept)), `${kept} is kept`);
    }
    for (const kept of ['lain-run-new', 'other-app-old', 'lain-workspaces/ws1/f']) assert.ok(fs.existsSync(path.join(tmp, kept)), `${kept} is kept`);
  }));

  await test('CACHE: advanced categories need to be named AND confirmed; the current session\'s undo stays', () => sandbox(async ({ H, app }) => {
    const refused = await care.clear(app, { ids: ['catalogs', 'undo-history'] });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.needsConfirm, true);
    assert.ok(fs.existsSync(H('catalog/lain_x.json')), 'nothing happened without a yes');
    const r = await care.clear(app, { ids: ['catalogs', 'undo-history'], confirmAdvanced: true });
    assert.strictEqual(r.ok, true);
    assert.ok(!fs.existsSync(H('catalog/lain_x.json')));
    assert.ok(!fs.existsSync(H('checkpoints/old-session')));
    assert.ok(fs.existsSync(H('checkpoints/current-session/f')), 'the session in hand keeps its undo');
    assert.ok(fs.existsSync(H('usage/receipts-2026-09.jsonl')), 'usage history only when named');
  }));

  await test('CACHE: the guards refuse the LAIN home, its durable parts, the user\'s home and the temp root itself', () => sandbox(async ({ home, tmp, H }) => {
    const roots = [home, tmp];
    for (const p of [home, H('sessions'), H('sessions/s1.json'), H('accounts/codex-1'), H('secrets'), tmp, path.join(tmp, 'lain-workspaces'), require('os').homedir()]) {
      assert.strictEqual(care.safeTarget(p, roots), false, `${p} is never a target`);
    }
    assert.strictEqual(care.safeTarget(H('desktop/EBWebView/Default/Cache'), roots), true);
    assert.strictEqual(care.safeTarget(path.join(tmp, 'lain-run-old'), roots), true);
  }));

  await test('CACHE: the CLI door — inspect prints a table; an advanced clear without --yes changes nothing', () => sandbox(async ({ H, app }) => {
    let text = '';
    const out = { write: (s) => { text += s; } };
    assert.strictEqual(await care.cli(['inspect'], { out, app }), 0);
    assert.match(text, /Browser caches\s+2\.4 KB\s+4 items\s+browser-cache/);
    assert.match(text, /Never cleared: Sessions and conversations/);
    text = '';
    assert.strictEqual(await care.cli(['clear', 'usage-history'], { out, app }), 3);
    assert.ok(fs.existsSync(H('usage/receipts-2026-09.jsonl')));
    assert.strictEqual(await care.cli(['clear', 'nope'], { out, app }), 2);
  }));
};
