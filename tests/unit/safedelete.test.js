'use strict';

/**
 * SAFE DELETE (2026-10-06) — the uninstaller's "remove LAIN data" once followed junctions out of the data folder and
 * deleted the person's ~/.codex. distribution/safedelete.cs is now the only recursive delete in setup; this proves it on
 * REAL Windows junctions, directory and file symlinks, a junction cycle and read-only files: the tree goes, every link
 * is removed as a link, and everything the links point at is byte-for-byte untouched. System folders are refused.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { test, tmpdir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');

function csc() {
  const base = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64');
  for (const v of fs.readdirSync(base).filter((n) => /^v4\./.test(n)).sort().reverse()) { const p = path.join(base, v, 'csc.exe'); if (fs.existsSync(p)) return p; }
  return null;
}
/** Every file under dir (not following links) → sha256, for a byte-for-byte comparison. */
function digest(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) { out[r] = `link->${fs.readlinkSync(p)}`; continue; }
      if (st.isDirectory()) { out[`${r}/`] = 'dir'; walk(p, r); continue; }
      out[r] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

module.exports = async function () {
  if (process.platform !== 'win32') { await test('SAFE DELETE: Windows-only (junctions, reparse points) — skipped here', () => {}); return; }
  const compiler = csc();
  if (!compiler) { await test('SAFE DELETE: no csc.exe on this machine — not verified', () => assert.ok(true)); return; }
  const work = tmpdir('lain-safedel-');
  const exe = path.join(work, 'probe.exe');
  execFileSync(compiler, ['-nologo', '-target:exe', `-out:${exe}`, path.join(ROOT, 'distribution', 'safedelete.cs'), path.join(ROOT, 'tests', 'fixtures', 'safedelete', 'probe.cs')], { stdio: 'pipe' });
  const probe = (...args) => { const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true }); return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '') }; };

  /** temp\.lain with links out to an external, protected folder. */
  function fixture() {
    const base = fs.mkdtempSync(path.join(work, 'case-'));
    const ext = path.join(base, 'external');
    fs.mkdirSync(path.join(ext, 'codex', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(ext, 'codex', 'sessions', 'real.jsonl'), 'REAL SESSION');
    fs.writeFileSync(path.join(ext, 'codex', 'config.toml'), 'model = "x"\n');
    fs.writeFileSync(path.join(ext, 'codex', 'readonly.txt'), 'ro'); fs.chmodSync(path.join(ext, 'codex', 'readonly.txt'), 0o444);
    fs.mkdirSync(path.join(ext, 'other'), { recursive: true }); fs.writeFileSync(path.join(ext, 'other', 'keep.bin'), crypto.randomBytes(4096));
    const home = path.join(base, '.lain');
    fs.mkdirSync(path.join(home, 'accounts', 'codex-a', 'shadow'), { recursive: true });
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), '{}');
    fs.writeFileSync(path.join(home, 'sessions', 's1.json'), '{}');
    fs.writeFileSync(path.join(home, 'locked.txt'), 'ro'); fs.chmodSync(path.join(home, 'locked.txt'), 0o444);
    fs.symlinkSync(path.join(ext, 'codex'), path.join(home, 'accounts', 'codex'), 'junction');                       // the order's fixture
    fs.symlinkSync(path.join(ext, 'codex', 'sessions'), path.join(home, 'accounts', 'codex-a', 'shadow', 'sessions'), 'junction');
    fs.symlinkSync(path.join(ext, 'codex', 'config.toml'), path.join(home, 'accounts', 'codex-a', 'shadow', 'config.toml'), 'file');
    fs.symlinkSync(path.join(ext, 'other'), path.join(home, 'dirlink'), 'dir');
    fs.symlinkSync(home, path.join(home, 'accounts', 'loop'), 'junction');                                          // a cycle back to the root
    return { base, ext, home };
  }

  await test('SAFE DELETE: temp\\.lain with a junction to external\\codex — .lain removed, every link removed, external byte-for-byte untouched', () => {
    const { ext, home } = fixture();
    const before = digest(ext);
    const r = probe('tree', home);
    assert.strictEqual(r.code, 0, `${r.out} ${r.err}`);
    assert.ok(!fs.existsSync(home), 'the data folder is gone');
    const [, files, , links] = r.out.split('|');
    assert.ok(Number(files) >= 3 && Number(links) === 5, r.out);
    assert.deepStrictEqual(digest(ext), before, 'the external folder is untouched, byte for byte');
  });

  await test('SAFE DELETE: a root that is itself a junction — only the link goes', () => {
    const { base, ext } = fixture();
    const before = digest(ext);
    const link = path.join(base, 'linked-home');
    fs.symlinkSync(path.join(ext, 'codex'), link, 'junction');
    const r = probe('tree', link);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(!fs.existsSync(link));
    assert.deepStrictEqual(digest(ext), before);
  });

  await test('SAFE DELETE: drive roots, the profile, its ancestors and Windows folders are refused (asked, never deleted)', () => {
    for (const p of ['C:\\', os.homedir(), path.dirname(os.homedir()), process.env.LOCALAPPDATA, process.env.APPDATA, process.env.SystemRoot]) {
      const r = probe('refusal', p);
      assert.notStrictEqual(r.out, '(allowed)', `${p} must be refused`);
    }
    assert.strictEqual(probe('refusal', path.join(work, 'nothing-here')).out, '(allowed)', 'a missing path is nothing to refuse');
  });

  await test('SAFE DELETE (Core, src/safedelete.js): the same fixture — .lain removed, links removed, external untouched; refusals hold', () => {
    const sd = require('../../src/safedelete');
    const { base, ext, home } = fixture();
    const before = digest(ext);
    const r = sd.removeTree(home);
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(!fs.existsSync(home));
    assert.strictEqual(r.links, 5, JSON.stringify(r));
    assert.deepStrictEqual(digest(ext), before, 'external untouched, byte for byte');
    for (const p of ['C:\\', os.homedir(), path.dirname(os.homedir()), process.env.LOCALAPPDATA]) assert.ok(sd.refusal(p), `${p} refused`);
    const outside = fs.mkdtempSync(path.join(base, 'not-accounts-'));
    assert.match(sd.removeTree(outside, { within: path.join(base, 'accounts-root') }).why || '', /refused/, '`within` is enforced');
    assert.ok(fs.existsSync(outside));
  });

  await test('SAFE DELETE: account homes, home clean and cache clear delete only through src/safedelete.js', () => {
    for (const f of ['drivers/codexhome.js', 'drivers/claudeaccount.js', 'drivers/antigravity.js', 'homeclean.js', 'cachecare.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
      assert.ok(src.includes("safedelete').removeTree("), `${f} uses safedelete`);
    }
    for (const f of ['drivers/claudeaccount.js', 'homeclean.js', 'cachecare.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
      assert.ok(!/\brm(?:Sync)?\([^)]*recursive: true/.test(src), `${f} has no raw recursive rm`);
    }
  });

  await test('SAFE DELETE: the installer and uninstaller have no other recursive delete', () => {
    for (const f of ['setup.cs', 'setupsystem.cs', 'setupui.cs', 'launcher.cs']) {
      const src = fs.readFileSync(path.join(ROOT, 'distribution', f), 'utf8');
      assert.ok(!/Directory\.Delete\s*\([^)]*,\s*true\s*\)/.test(src), `${f} calls Directory.Delete(…, true)`);
    }
    const setup = fs.readFileSync(path.join(ROOT, 'distribution', 'setupsystem.cs'), 'utf8');
    assert.match(setup, /Setup\.RemovableData\(out why\)/, 'data removal goes through the one rule');
  });
};
