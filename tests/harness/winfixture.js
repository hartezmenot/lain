'use strict';

/**
 * THE NATIVE APPLICATION THE COMPUTER-MCP SUITE DRIVES.
 *
 * Builds `tests/fixtures/winapp.cs` with the `csc.exe` that is part of Windows
 * and starts it, so the suite has a real window, a real UI Automation tree and
 * a real OS file dialog that belong to NOBODY BUT THE TEST.
 *
 * It exists because the suite used to drive Notepad and had to skip itself
 * whenever a person had one open — see the header of winapp.cs. Nothing here
 * is simulated: the only thing the fixture removes is the risk of typing into
 * somebody's unsaved document.
 *
 * TEST-ONLY. It is under tests/ and nothing in src/ requires it; LAIN does not
 * ship it and gains no dependency from it.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SOURCE = path.join(__dirname, '..', 'fixtures', 'winapp.cs');

function compiler() {
  const root = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64');
  let best = null;
  try {
    for (const name of fs.readdirSync(root)) {
      if (!/^v4\./.test(name)) continue;
      const exe = path.join(root, name, 'csc.exe');
      if (fs.existsSync(exe)) best = exe;
    }
  } catch { /* the caller reports it */ }
  return best;
}

/** Build once, cached by the hash of the source — an edit rebuilds it. */
function build() {
  if (process.platform !== 'win32') return { ok: false, why: 'the fixture is a Windows application' };
  let src;
  try { src = fs.readFileSync(SOURCE); } catch (e) { return { ok: false, why: `the fixture source is missing: ${e.message}` }; }
  const stamp = crypto.createHash('sha256').update(src).digest('hex').slice(0, 12);
  const dir = path.join(os.tmpdir(), 'lain-fixtures');
  const exe = path.join(dir, `lain-fixture-${stamp}.exe`);
  if (fs.existsSync(exe)) return { ok: true, exe, built: false };
  const csc = compiler();
  if (!csc) return { ok: false, why: 'no C# compiler was found (Microsoft.NET\\Framework64\\v4.*\\csc.exe)' };
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the build will say */ }
  try {
    execFileSync(csc, [
      '-nologo', '-optimize+', '-target:winexe', `-out:${exe}`,
      '-r:System.dll', '-r:System.Drawing.dll', '-r:System.Windows.Forms.dll',
      SOURCE,
    ], { stdio: 'pipe', timeout: 120_000, windowsHide: true });
  } catch (e) {
    const said = String((e && (e.stdout || e.stderr)) || (e && e.message) || '').trim().split('\n').slice(0, 6).join('\n');
    return { ok: false, why: `the fixture did not build: ${said || 'the compiler failed'}` };
  }
  if (!fs.existsSync(exe)) return { ok: false, why: 'the compiler reported success and produced no program' };
  return { ok: true, exe, built: true };
}

/**
 * START ONE, with a title nothing else on the machine can be wearing.
 *
 * The caller gets the PID it spawned AND the window the bridge found for that
 * PID — because a title is not an identity, and every action the suite takes
 * is aimed at one of those two.
 */
async function start(c, { titleHint = 'LAIN Fixture' } = {}) {
  const built = build();
  if (!built.ok) return { ok: false, why: built.why };
  const title = `${titleHint} ${crypto.randomBytes(3).toString('hex')}`;
  // THE FIXTURE SAYS WHAT IT DID. A failure here is otherwise a silent window
  // that simply did not do the thing, with nothing to read.
  const log = path.join(os.tmpdir(), 'lain-fixtures', `run-${crypto.randomBytes(4).toString('hex')}.log`);
  try { fs.mkdirSync(path.dirname(log), { recursive: true }); } catch { /* the log is a courtesy */ }
  // A FAILED RUN'S LOG IS KEPT — it is the only account of what the application
  // did — but not forever. Yesterday's is nobody's evidence.
  try {
    const dir = path.dirname(log);
    const old = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^run-[0-9a-f]+\.log$/.test(name)) continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).mtimeMs < old) fs.unlinkSync(p);
    }
  } catch { /* tidiness is not a test result */ }
  const child = spawn(built.exe, ['--title', title, '--log', log], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  const pid = child.pid;
  const said = () => { try { return fs.readFileSync(log, 'utf8'); } catch { return ''; } };

  // WAIT FOR THE WINDOW, don't sleep at it. A fresh WinForms process shows its
  // form in a few hundred milliseconds; a machine under a full test tier can
  // take longer, and a fixed sleep would be wrong on both.
  const deadline = Date.now() + 30000;
  for (;;) {
    const w = await c.windows().catch(() => null);
    const list = (w && w.ok && w.result && w.result.windows) || [];
    const mine = list.find((x) => Number(x.pid) === Number(pid) && String(x.title || '').includes(titleHint));
    if (mine) return { ok: true, pid, title, window: mine, exe: built.exe, log, said, stop: () => stop(pid) };
    if (Date.now() > deadline) { stop(pid); return { ok: false, why: `the fixture started (pid ${pid}) but showed no window within 30s: ${said() || 'it logged nothing'}` }; }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Ours, so it goes by PID. */
function stop(pid) {
  if (!pid) return;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
}

module.exports = { build, start, stop, SOURCE };
