// UPDATE ACCEPTANCE against the REAL installed build and the REAL signed feed (release key), isolated folders.
// node updateaccept.js <setup-0.1.0.exe> <feedDir>
const ROOT = require('path').join(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { prepareCli } = require(ROOT + '/tests/helpers');

const [setup0, feed] = process.argv.slice(2);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noema-upd-'));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail: String(detail || '') }); process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${String(detail).slice(0, 1500).split('\n').join('\n      ')}`}\n`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ISO = ['--no-path', '--no-open-with', '--no-open-folder', '--no-start-menu', '--no-register'];

function world(name, script, firstMs = 1500) {
  const proj = path.join(base, name, 'project'); fs.mkdirSync(proj, { recursive: true });
  const w = prepareCli({ script, cwd: proj });
  w.env.NOEMA_CONFIG_DIR = w.configDir;          // the installed build's home = the isolated config dir
  w.env.NOEMA_UPDATE_FEED = feed;
  w.env.NOEMA_UPDATE_FIRST_CHECK_MS = String(firstMs);
  w.env.NOEMA_UPDATE_IDLE_MS = '3000';
  delete w.env.NOEMA_NO_UPDATE_CHECK;
  return w;
}
function install(name, w) {
  const dir = path.join(base, name, 'install');
  const r = spawnSync(setup0, ['--silent', '--dir', dir, '--cli-only', ...ISO, '--log', path.join(base, name, 'setup.log')], { env: w.env, encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) throw new Error(`setup failed (${r.status}): ${fs.readFileSync(path.join(base, name, 'setup.log'), 'utf8')}`);
  return dir;
}
const ptr = (dir, n) => { try { return fs.readFileSync(path.join(dir, n), 'utf8').trim(); } catch { return null; } };

/** An interactive CLI over pipes (forced TUI); resolves when `until(out)` or the time is up. */
function session(dir, w, { input = [], until, timeoutMs = 180000, args = [] }) {
  return new Promise((resolve) => {
    const env = { ...w.env, LAIN_FORCE_TUI: '1', COLUMNS: '120', LINES: '40' };
    const p = spawn(path.join(dir, 'noema.exe'), args, { cwd: w.cwd, env, windowsHide: true });
    let out = '';
    const onData = (d) => { out += d.toString('utf8'); if (until && until(out)) finish('matched'); };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    const timers = input.map(([ms, text]) => setTimeout(() => { try { p.stdin.write(text); } catch { /* gone */ } }, ms));
    const t = setTimeout(() => finish('timeout'), timeoutMs);
    let done = false;
    function finish(why) {
      if (done) return; done = true;
      clearTimeout(t); timers.forEach(clearTimeout);
      setTimeout(() => {
        try { p.stdin.write('/exit\r'); } catch { /* gone */ }
        setTimeout(() => { try { spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } resolve({ why, out: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') }); }, 4000);
      }, 500);
    }
  });
}

(async () => {
  // ONE SECTION ONLY: NOEMA_ACCEPT_ONLY=startup (the others are slow and cost nothing new to rerun).
  const only = process.env.NOEMA_ACCEPT_ONLY || '';
  if (!only || only === 'update') {
  // 1. IDLE: the CLI checks, downloads, verifies, stages, restarts into 0.1.1 by itself; the session continues.
  {
    const w = world('idle', [{ text: 'hello' }]);
    const dir = install('idle', w);
    const s = await session(dir, w, { until: (o) => /Updated to Noema 0\.1\.1/.test(o), timeoutMs: 180000 });
    check('update idle: the CLI announces the restart itself', /Noema 0\.1\.1 is ready — restarting now; this session continues/.test(s.out), s.out.slice(-1500));
    check('update idle: the launcher restarts into 0.1.1 and says so (from 0.1.0)', /Updated to Noema 0\.1\.1 \(from 0\.1\.0\)/.test(s.out), s.out.slice(-1500));
    await wait(1500);
    check('update idle: pointers — current 0.1.1, previous 0.1.0, pending cleared (healthy)', ptr(dir, 'current') === '0.1.1' && ptr(dir, 'previous') === '0.1.0' && ptr(dir, 'pending') === null && fs.existsSync(path.join(dir, 'health-0.1.1')), `${ptr(dir, 'current')} / ${ptr(dir, 'previous')} / pending ${ptr(dir, 'pending')}`);
    const st = JSON.parse(fs.readFileSync(path.join(w.configDir, 'update', 'state.json'), 'utf8'));
    check('update idle: the restarted process resumed the same session (--resume … --after-update)', st.applied && st.applied.from === '0.1.0', JSON.stringify(st.applied));
  }

  // 2. ACTIVE TASK: a turn is running when the update is ready — it is staged, announced, and applied only after the task.
  {
    const w = world('active', [{ text: 'still working on it', delayMs: 25000 }], 6000);
    const dir = install('active', w);
    const t0 = Date.now();
    const s = await session(dir, w, { input: [[2500, 'explain this project\r']], until: (o) => /Updated to Noema 0\.1\.1/.test(o), timeoutMs: 240000 });
    fs.writeFileSync(path.join(base, 'active.out.txt'), s.out);
    const readyAt = s.out.indexOf('Noema 0.1.1 installed and ready. Restart to update');
    const doneAt = s.out.indexOf('still working on it');
    const updatedAt = s.out.indexOf('Updated to Noema 0.1.1');
    check('update active: "Noema 0.1.1 installed and ready. Restart to update" while the task runs', readyAt >= 0, s.out.slice(-2000));
    check('update active: never interrupted — the task finished before the restart', doneAt >= 0 && updatedAt > doneAt && readyAt < doneAt, `ready@${readyAt} done@${doneAt} updated@${updatedAt} (${Math.round((Date.now() - t0) / 1000)} s)`);
    check('update active: after the task, the restart happened and 0.1.1 is current', ptr(dir, 'current') === '0.1.1', ptr(dir, 'current'));
  }

  // 3. ONE-SHOT `noema update`, a TAMPERED PACKAGE, a TAMPERED MANIFEST, and a BROKEN VERSION ROLLED BACK.
  {
    const w = world('oneshot', []);
    const dir = install('oneshot', w);
    const run = (args, env = {}) => { const r = spawnSync(path.join(dir, 'noema.exe'), args, { cwd: w.cwd, env: { ...w.env, ...env }, encoding: 'utf8', timeout: 300000 }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }; };

    const bad = path.join(base, 'feed-badzip'); fs.mkdirSync(bad);
    for (const f of fs.readdirSync(feed)) if (!/\.exe$/.test(f)) fs.copyFileSync(path.join(feed, f), path.join(bad, f));
    const zip = fs.readdirSync(bad).find((f) => f.endsWith('.zip'));
    fs.appendFileSync(path.join(bad, zip), Buffer.from('tampered'));
    let r = run(['update'], { NOEMA_UPDATE_FEED: bad });
    check('invalid package: a zip that does not match the signed SHA-256 is rejected', r.code !== 0 && /did not match the signed manifest \(SHA-256\)/.test(r.out) && ptr(dir, 'current') === '0.1.0' && !fs.existsSync(path.join(dir, 'versions', '0.1.1')), r.out);

    const badm = path.join(base, 'feed-badmanifest'); fs.mkdirSync(badm);
    for (const f of fs.readdirSync(feed)) if (!/\.exe$/.test(f)) fs.copyFileSync(path.join(feed, f), path.join(badm, f));
    const m = path.join(badm, 'manifest-stable.json'); fs.writeFileSync(m, fs.readFileSync(m, 'utf8').replace('"0.1.1"', '"0.1.9"'));
    fs.rmSync(path.join(w.configDir, 'update'), { recursive: true, force: true });
    r = run(['update', 'check'], { NOEMA_UPDATE_FEED: badm });
    check('invalid manifest: an edited manifest fails the Ed25519 signature and nothing is offered', r.code !== 0 && /signature/.test(r.out), r.out);

    fs.rmSync(path.join(w.configDir, 'update'), { recursive: true, force: true });
    r = run(['update']);
    check('one-shot: `noema update` installs the verified 0.1.1 beside 0.1.0', r.code === 0 && /Noema 0\.1\.1 installed \(from 0\.1\.0\)/.test(r.out), r.out);
    r = run(['--version']);
    check('one-shot: the next start is 0.1.1', /^Noema CLI 0\.1\.1/.test(r.out), r.out);

    // A BROKEN 0.1.2: it exits before reporting healthy → the launcher rolls back to 0.1.1.
    const v2 = path.join(dir, 'versions', '0.1.2');
    fs.cpSync(path.join(dir, 'versions', '0.1.1'), v2, { recursive: true });
    fs.writeFileSync(path.join(v2, 'app', 'bin', 'noema.js'), "process.stderr.write('broken build\\n'); process.exit(3);\n");
    fs.writeFileSync(path.join(dir, 'previous'), '0.1.1'); fs.writeFileSync(path.join(dir, 'current'), '0.1.2'); fs.writeFileSync(path.join(dir, 'pending'), '0.1.2');
    r = run(['--version']);
    check('rollback: a version that fails to start is rolled back to the previous one, automatically', /Noema 0\.1\.2 did not start; rolled back to 0\.1\.1/.test(r.out) && /Noema CLI 0\.1\.1/.test(r.out) && ptr(dir, 'current') === '0.1.1' && ptr(dir, 'pending') === null && fs.existsSync(path.join(dir, 'rolled-back')), `${r.out}\ncurrent ${ptr(dir, 'current')} pending ${ptr(dir, 'pending')}`);
  }

  }
  if (!only || only === 'startup') {
  // 4. START AT SIGN-IN + A STAGED UPDATE (consolidation §53–§56) — a temporary APPDATA holds the Startup folder.
  //   A  the setting writes ONE per-user entry: the version-independent launcher with --startup
  //   B  an update staged while Noema ran (then Windows shut down) waits as `staged`; nothing was replaced
  //   C  the sign-in launch applies it BEFORE anything starts — one launch of 0.1.1, previous kept, healthy
  //   D  the entry survives the update unchanged, still consistent with the setting
  {
    const w = world('startup', []);
    w.env.APPDATA = path.join(base, 'startup', 'appdata'); fs.mkdirSync(w.env.APPDATA, { recursive: true });
    const dir = path.join(base, 'startup', 'install');
    const s0 = spawnSync(setup0, ['--silent', '--dir', dir, '--harness', ...ISO, '--log', path.join(base, 'startup', 'setup.log')], { env: w.env, encoding: 'utf8', timeout: 600000 });
    if (s0.status !== 0) throw new Error(`setup failed: ${fs.readFileSync(path.join(base, 'startup', 'setup.log'), 'utf8')}`);
    const run = (args) => { const r = spawnSync(path.join(dir, 'noema.exe'), args, { cwd: w.cwd, env: w.env, encoding: 'utf8', timeout: 300000 }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }; };
    const link = path.join(w.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Noema Harness.lnk');
    const target = () => String(spawnSync('powershell.exe', ['-NoProfile', '-Command', '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:L); $s.TargetPath + "|" + $s.Arguments'], { env: { ...process.env, L: link }, encoding: 'utf8' }).stdout || '').trim();
    const want = `${fs.realpathSync.native(path.join(dir, 'Noema Harness.exe'))}|--startup`.toLowerCase();

    check('startup A: off after install — nothing registered until the person asks', !fs.existsSync(link), link);
    let r = run(['settings', 'startup', 'harness', 'on']);
    check('startup A: `noema settings startup harness on` registers the version-independent launcher with --startup', r.code === 0 && target().toLowerCase() === want, `${r.out}\n${target()}`);

    // B. STAGE 0.1.1 the way a running session does (updater.stage), then "shut down": nothing else runs.
    const node = path.join(dir, 'versions', '0.1.0', 'runtime', 'node.exe');
    const updater = path.join(dir, 'versions', '0.1.0', 'app', 'src', 'update', 'updater.js');
    const st = spawnSync(node, ['-e', `const u = require(${JSON.stringify(updater)}); u.check({ force: true }).then(() => u.stage({})).then((r) => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); })`], { env: { ...w.env, NOEMA_INSTALL_ROOT: dir }, encoding: 'utf8', timeout: 300000 });
    check('startup B: an update staged at shutdown waits — staged 0.1.1, current still 0.1.0', st.status === 0 && ptr(dir, 'staged') === '0.1.1' && ptr(dir, 'current') === '0.1.0', `${st.stdout}${st.stderr} staged=${ptr(dir, 'staged')} current=${ptr(dir, 'current')}`);

    // C. SIGN-IN: the same launcher code the Startup entry runs (noema.exe and Noema Harness.exe are one source,
    // distribution/launcher.cs), asked only for its version so no window opens.
    r = run(['--startup', '--version']);
    await wait(1500);
    check('startup C: the sign-in launch starts 0.1.1 directly — applied before anything ran', /^Noema CLI 0\.1\.1/.test(r.out) && !/0\.1\.0/.test(r.out.split('\n')[0]), r.out);
    // PENDING STAYS until a SESSION reports healthy (a --version launch is not one; the idle case above proves the clearing).
    check('startup C: pointers — current 0.1.1, previous 0.1.0 (rollback target), staged gone, 0.1.1 pending its first healthy session, nothing rolled back', ptr(dir, 'current') === '0.1.1' && ptr(dir, 'previous') === '0.1.0' && ptr(dir, 'staged') === null && ptr(dir, 'pending') === '0.1.1' && !fs.existsSync(path.join(dir, 'rolled-back')), `current ${ptr(dir, 'current')} previous ${ptr(dir, 'previous')} staged ${ptr(dir, 'staged')} pending ${ptr(dir, 'pending')}`);

    r = run(['settings', 'startup', 'status']);
    check('startup D: the Startup entry survived the update unchanged and is consistent', target().toLowerCase() === want && /with Windows: ON/.test(r.out) && !/out of step/.test(r.out), `${r.out}\n${target()}`);
  }

  }
  fs.writeFileSync(path.join(base, 'update-acceptance.json'), JSON.stringify(results, null, 2));
  process.stdout.write(`\n${results.filter((x) => x.ok).length}/${results.length} passed · ${base}\n`);
})().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
