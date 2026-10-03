'use strict';

/** THE OBSOLETE PRE-CLEANUP LAIN'S LEFTOVERS ON THIS MACHINE — found, carried over where they were the person's choice, then removed */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function regExistsReal(key) { return process.platform === 'win32' && spawnSync('reg.exe', ['query', key], { windowsHide: true }).status === 0; }

/** What is here, without changing anything. `registry: false` looks at files only (tests; never the real HKCU). */
function plan({ registry = true } = {}) {
  const regExists = registry ? regExistsReal : () => false;
  const home = require('./home').resolve();
  const desk = path.join(home, 'desktop');
  const startMenu = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  // CASE MATTERS NOWHERE ON WINDOWS, so the patterns name only what the current LAIN never writes there.
  const builds = exists(desk) ? fs.readdirSync(desk).filter((f) => /^lain-desktop-[0-9a-f]+\.exe$|^LAIN\.exe$|^noema-harness-[0-9a-f]+\.exe$|^Noema Harness\.exe$/i.test(f)).map((f) => path.join(desk, f)) : [];
  const machine = ['C:\\Program Files\\LAIN', 'C:\\Program Files (x86)\\LAIN'].filter((p) => exists(path.join(p, 'LAIN.exe')));
  return {
    startupLink: exists(require('./startup').legacyLinkPath()) ? require('./startup').legacyLinkPath() : null,
    openWith: regExists('HKCU\\Software\\Classes\\LAIN.File'),
    executables: builds,
    // launch.json is the OLD launcher's only beside LAIN.exe with no current launcher (the current one writes it too).
    oldLaunchJson: exists(path.join(desk, 'launch.json')) && exists(path.join(desk, 'LAIN.exe')) && !exists(path.join(desk, 'LAIN Harness.exe')) ? path.join(desk, 'launch.json') : null,
    startMenuLink: exists(path.join(startMenu, 'LAIN.lnk')) ? path.join(startMenu, 'LAIN.lnk') : null,
    uninstallEntry: regExists('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LAIN'),
    machineInstalls: machine,
  };
}

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

/** CARRY OVER AND REMOVE. */
function cleanup({ launcherExe = null, cfg = null, save = null, registry = true, openWith = true } = {}) {
  const p = plan({ registry });
  const done = [];
  const kept = [];
  const config = require('./config');
  const c = cfg || config.load();
  const persist = save || (() => config.save(c));
  let exe = launcherExe;
  // A REPLACEMENT FRONT DOOR FIRST, so nothing the person relied on stops working in between.
  if (!exe && (p.startupLink || p.openWith || p.executables.length)) {
    try {
      const d = require('./desktop');
      const inst = d.installLauncher(d.build({ quiet: true }), { cfg: c });
      if (inst.ok) { exe = inst.launcher; done.push(`installed ${path.basename(exe)} (replaces the obsolete LAIN.exe)`); }
      else kept.push(`no LAIN Harness launcher could be built (${inst.why}) — the obsolete entries were left in place`);
    } catch (e) { kept.push(`no LAIN Harness launcher could be built (${e.message})`); }
  }
  if (p.startupLink && exe) {
    const r = require('./startup').sync(c, { save: persist });   // carries the choice over, removes LAIN.lnk
    done.push(r.ok ? `start at sign-in carried over to LAIN Harness${r.registered ? '' : ' (setting saved)'}` : `startup: ${r.why}`);
  }
  // An install chosen WITHOUT Open With does not gain one here; the obsolete entries are then left for `assoc remove`.
  if (p.openWith && exe && openWith) {
    const r = require('./winassoc').register({ exe });           // removes the older entries, offers LAIN
    done.push(r.ok ? '"Open with" now offers LAIN (the obsolete LAIN.File entries removed)' : `"Open with": ${r.why || `${(r.failed || []).length} write(s) failed`}`);
  }
  if (exe) {
    for (const f of p.executables) {
      try { fs.unlinkSync(f); done.push(`removed ${path.basename(f)}`); } catch (e) { kept.push(`${path.basename(f)} is in use (${e.code || e.message}) — it is removed next time`); }
    }
  }
  if (p.startMenuLink) { try { fs.unlinkSync(p.startMenuLink); done.push('removed Start Menu\\LAIN.lnk'); } catch { kept.push('Start Menu\\LAIN.lnk could not be removed'); } }
  if (p.uninstallEntry) { spawnSync('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LAIN', '/f'], { windowsHide: true }); done.push('removed the obsolete LAIN entry from Installed apps'); }
  for (const m of p.machineInstalls) kept.push(`an obsolete machine-wide LAIN install remains at ${m} (it needs an administrator: run "${path.join(m, 'Uninstall LAIN.exe')}"). Its \`lain\` command is not this LAIN.`);
  return { ok: true, done, kept, plan: p };
}

/** `lain legacy status | cleanup [--exe <LAIN Harness launcher>]` */
function cli(args = [], { out = process.stdout } = {}) {
  if (args[0] === 'cleanup') {
    const at = args.indexOf('--exe');
    const r = cleanup({ launcherExe: at >= 0 ? args[at + 1] : null, openWith: !args.includes('--no-open-with') });
    for (const l of r.done) out.write(`✓ ${l}\n`);
    for (const l of r.kept) out.write(`! ${l}\n`);
    if (!r.done.length && !r.kept.length) out.write('Nothing of the obsolete LAIN is left on this machine.\n');
    return 0;
  }
  const p = plan();
  const rows = [
    p.startupLink && `Startup shortcut: ${p.startupLink}`,
    p.openWith && '"Open with": the obsolete LAIN.File is registered',
    ...p.executables.map((f) => `executable: ${f}`),
    p.startMenuLink && `Start Menu: ${p.startMenuLink}`,
    p.uninstallEntry && 'Installed apps: the obsolete LAIN entry',
    ...p.machineInstalls.map((m) => `machine-wide install: ${m} (administrator needed)`),
  ].filter(Boolean);
  const fixable = rows.length > p.machineInstalls.length;
  out.write(rows.length ? `Obsolete LAIN leftovers:\n${rows.map((r) => `  ${r}`).join('\n')}\n${fixable ? 'Run: lain legacy cleanup\n' : ''}` : 'Nothing of the obsolete LAIN is left on this machine.\n');
  return 0;
}

module.exports = { plan, cleanup, cli };
