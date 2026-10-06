'use strict';

/**
 * HOME CLEAN (2026-10-06) — a controlled legacy machine, cleaned the way the person's was:
 *   ~/.lain real, ~/.noema and ~/.lain-v2 junctions, an old desktop runtime (Noema Harness.exe, hashed hosts, launch.json,
 *   a copied page), old sessions and task history, a listed account and two unlisted ones (one with links into the
 *   runtime's own ~/.codex, one a test's fake sign-in), old config copies, an unknown folder.
 * Expected: one home; accounts, credentials and settings kept (and backed up first); sessions gone; old homes gone;
 * the runtime's own folder behind the links untouched; the unknown folder kept; a dry run changes nothing.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, tmpdir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');

function envFor(profile) {
  const env = { ...process.env, USERPROFILE: profile, HOME: profile, LAIN_NO_UPDATE_CHECK: '1', LAIN_NO_DESKTOP: '1' };
  for (const k of ['NOEMA_CONFIG_DIR', 'NOEMA_HOME', 'LAIN_CONFIG_DIR', 'LAIN_HOME', 'LAIN_VIA', 'NOEMA_VIA']) delete env[k];
  return env;
}
const lain = (profile, args) => spawnSync(process.execPath, ['bin/lain.js', ...args], { cwd: ROOT, env: envFor(profile), encoding: 'utf8', timeout: 90000, windowsHide: true });
const put = (p, text = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

function legacyMachine() {
  const profile = tmpdir('lain-legacy-');
  const h = path.join(profile, '.lain');
  put(path.join(h, 'config.json'), JSON.stringify({ model: 'glm-5.3', mouse: false }));
  put(path.join(h, 'config.json.bak-20260820-150552'), '{"old":true}');
  put(path.join(h, 'accounts.json'), JSON.stringify({ version: 1, instances: { 'codex-aaa111': { id: 'codex-aaa111' } }, foreground: {} }));
  put(path.join(h, 'credentials.json'), JSON.stringify({ version: 1, refs: { 'cred:lain-zai-1:api_key': {} } }));
  put(path.join(h, 'secrets', 'cred.lain-zai-1.api_key.dpapi'), 'SEALED');
  put(path.join(h, 'skills', 'index.json'), '{}');
  put(path.join(h, 'migrations', 'home-from-noema.json'), '{}');
  put(path.join(h, 'migrations', '20260917072002.-etob.json'), '{"migration":{}}');
  // the runtime's own folder, which account homes link into
  const codex = path.join(profile, '.codex');
  put(path.join(codex, 'sessions', 'real-codex-session.jsonl'), 'REAL');
  put(path.join(codex, 'config.toml'), 'REAL');
  put(path.join(h, 'accounts', 'codex', 'codex-aaa111', 'shadow', 'auth.json'), '{"listed":true}');
  put(path.join(h, 'accounts', 'codex', 'codex-old999', 'shadow', 'auth.json'), '{"removed":true}');
  fs.symlinkSync(path.join(codex, 'sessions'), path.join(h, 'accounts', 'codex', 'codex-old999', 'shadow', 'sessions'), 'junction');
  put(path.join(h, 'accounts', 'antigravity', 'antigravity-t1', 'fake-login.json'), '{}');
  // sessions and history
  put(path.join(h, 'sessions', 's1.json'), '{"id":"s1"}');
  put(path.join(h, 'sessions', '.journal', 'j.jsonl'), '{}');
  put(path.join(h, 'checkpoints', '20260816-101126-352a', 'c.json'), '{}');
  put(path.join(h, 'supervisor', 'guardian', 'g.json'), '{}');
  put(path.join(h, 'decisions', 'd1.json'), '{}');
  put(path.join(h, 'decisions', '.key'), 'KEY');
  // the old desktop runtime in the home
  for (const f of ['Noema Harness.exe', 'noema-harness-21963ebcfc46.exe', 'lain-harness-5b2fd7b52ebe.exe', 'WebView2Loader.dll', 'launch.json', path.join('assets', 'index.html')]) put(path.join(h, 'desktop', f));
  put(path.join(h, 'desktop', 'EBWebView', 'Local State'), '{}');
  put(path.join(h, 'harnessapp', 'Default', 'Preferences'), '{}');
  put(path.join(h, 'some-folder-lain-does-not-know', 'note.txt'), 'mine');
  fs.symlinkSync(h, path.join(profile, '.noema'), 'junction');
  fs.symlinkSync(h, path.join(profile, '.lain-v2'), 'junction');
  return { profile, h, codex };
}

module.exports = async function () {
  await test('HOME CLEAN dry run: lists every row with a class and a reason — and changes nothing', () => {
    const { profile, h } = legacyMachine();
    const r = lain(profile, ['home', 'clean', 'sessions']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /Nothing was removed/);
    assert.match(r.stdout, /remove\s+SESSION.*sessions/);
    assert.match(r.stdout, /keep\s+AUTH.*codex-aaa111/);
    assert.match(r.stdout, /keep\s+UNKNOWN.*some-folder-lain-does-not-know/);
    assert.ok(fs.existsSync(path.join(h, 'sessions', 's1.json')) && fs.existsSync(path.join(h, 'desktop', 'Noema Harness.exe')), 'a dry run removes nothing');
  });

  await test('HOME CLEAN migration: one ~/.lain; accounts and settings kept and backed up; sessions, old runtime and old homes gone; links never followed', () => {
    const { profile, h, codex } = legacyMachine();
    const r = lain(profile, ['home', 'clean', 'sessions', '--yes']);
    assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
    // ONE HOME
    for (const old of ['.noema', '.lain-v2']) assert.ok(!fs.existsSync(path.join(profile, old)), `${old} is gone`);
    // KEPT
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h, 'config.json'), 'utf8')).model, 'glm-5.3');
    for (const f of ['accounts.json', 'credentials.json', path.join('secrets', 'cred.lain-zai-1.api_key.dpapi'), path.join('skills', 'index.json'),
      path.join('accounts', 'codex', 'codex-aaa111', 'shadow', 'auth.json'), path.join('desktop', 'EBWebView', 'Local State'), path.join('migrations', 'home-from-noema.json'),
      path.join('decisions', '.key'), path.join('some-folder-lain-does-not-know', 'note.txt')]) assert.ok(fs.existsSync(path.join(h, f)), `${f} kept`);
    // REMOVED
    for (const f of ['sessions', 'checkpoints', path.join('supervisor', 'guardian'), path.join('decisions', 'd1.json'), path.join('migrations', '20260917072002.-etob.json'),
      'config.json.bak-20260820-150552', path.join('accounts', 'codex', 'codex-old999'), path.join('accounts', 'antigravity', 'antigravity-t1'),
      path.join('desktop', 'Noema Harness.exe'), path.join('desktop', 'noema-harness-21963ebcfc46.exe'), path.join('desktop', 'lain-harness-5b2fd7b52ebe.exe'),
      path.join('desktop', 'WebView2Loader.dll'), path.join('desktop', 'launch.json'), path.join('desktop', 'assets'), 'harnessapp']) assert.ok(!fs.existsSync(path.join(h, f)), `${f} removed`);
    // THE RUNTIME'S OWN FOLDER behind the removed account's junction is untouched
    assert.strictEqual(fs.readFileSync(path.join(codex, 'sessions', 'real-codex-session.jsonl'), 'utf8'), 'REAL');
    // ONE BACKUP, of settings and identities only
    const backups = fs.readdirSync(path.join(h, 'backups')).filter((f) => /^pre-clean-.*\.tar$/.test(f));
    assert.strictEqual(backups.length, 1, 'one archive');
    const list = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-tf', path.join(h, 'backups', backups[0])], { encoding: 'utf8' }).stdout;
    for (const want of ['config.json', 'accounts.json', 'credentials.json', 'secrets/cred.lain-zai-1.api_key.dpapi', 'codex-aaa111/shadow/auth.json']) assert.ok(list.replace(/\\/g, '/').includes(want), `backup has ${want}`);
    assert.ok(!/sessions\/s1\.json|checkpoints/.test(list), 'the history being removed is not archived');
    // A LATER START recreates neither old home nor sessions history
    const again = lain(profile, ['home']);
    assert.strictEqual(again.status, 0, again.stderr);
    assert.ok(!fs.existsSync(path.join(profile, '.lain-v2')) && !fs.existsSync(path.join(profile, '.noema')));
    assert.ok(!fs.existsSync(path.join(h, 'sessions', 's1.json')));
  });
};
