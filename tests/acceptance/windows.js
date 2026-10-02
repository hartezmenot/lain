// WINDOWS ACCEPTANCE (packaging pass §U) — one REAL registered per-user install at the default location:
// Installed apps entry, Start Menu, PATH, Open With / Open folder, icons, version + publisher metadata; then a real
// uninstall. LAIN's own "Open with" keys (which LAIN replaces by design) are exported first and imported back after,
// and the machine is compared with how it started. The data home is a temp folder (LAIN_CONFIG_DIR).
// node winaccept.js <LAIN-Setup.exe>
const ROOT = require('path').join(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const setupExe = process.argv[2];
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-winaccept-'));
const HOME = path.join(work, 'data');
fs.mkdirSync(HOME, { recursive: true });
const env = { ...process.env, LAIN_CONFIG_DIR: HOME, LAIN_NO_UPDATE_CHECK: '1' };
for (const k of ['LAIN_CONFIG_DIR', 'LAIN_HOME', 'LAIN_HOME', 'LAIN_INSTALL_ROOT']) delete env[k];
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail: String(detail || '') }); process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${String(detail).slice(0, 800).split('\n').join('\n      ')}`}\n`); };
const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
const exists = (key) => reg(['query', key]).status === 0;
const ps = (cmd) => spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', windowsHide: true, env }).stdout.split(String.fromCharCode(13)).join('').trim();
const HIVE = 'HKCU\\Software\\Classes';
const EXT = require(ROOT + '/src/winassoc').EXTENSIONS;

// ---- 0. BEFORE: back up LAIN's keys, and snapshot what matters -------------------------------------------------
const keys = new Set([`${HIVE}\\LAIN.File`, `${HIVE}\\Applications\\LAIN.exe`, `${HIVE}\\Directory\\shell\\LAIN.Open`, `${HIVE}\\Directory\\Background\\shell\\LAIN.Open`]);
for (const e of EXT) { keys.add(`${HIVE}\\.${e}\\OpenWithProgids`); keys.add(`${HIVE}\\SystemFileAssociations\\.${e}\\shell\\LAIN.Open`); }
const backups = [];
for (const k of keys) { if (!exists(k)) continue; const f = path.join(work, `bak-${backups.length}.reg`); if (reg(['export', k, f, '/y']).status === 0) backups.push(f); }
const defaults = () => EXT.map((e) => { const r = reg(['query', `${HIVE}\\.${e}`, '/ve']); return `${e}=${(/REG_SZ\s+(.*)/.exec(r.stdout || '') || [])[1] || '-'}`; }).join(';');
const userChoice = () => EXT.map((e) => exists(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.${e}\\UserChoice`) ? e : '').filter(Boolean).join(',');
const lainAssoc = () => [...keys].filter((k) => /LAIN/.test(k) && exists(k)).length + EXT.filter((e) => /LAIN\.File/.test(reg(['query', `${HIVE}\\.${e}\\OpenWithProgids`]).stdout || '')).length;
const snap0 = { defaults: defaults(), userChoice: userChoice(), lain: lainAssoc(), path: ps("[Environment]::GetEnvironmentVariable('PATH','User')") };
process.stdout.write(`backed up ${backups.length} LAIN-related keys · ${snap0.lain} LAIN entries present\n`);

let installDir = null;
try {
  // ---- 1. INSTALL (defaults: per-user, PATH, Open With, Open folder, Start Menu, Installed apps) ------------------
  const log = path.join(work, 'install.log');
  const r = spawnSync(setupExe, ['--silent', '--harness', '--log', log], { env, encoding: 'utf8', timeout: 600000 });
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  check('install (defaults, with Harness): exits 0', r.status === 0, text);
  installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'LAIN');
  check('installed per-user at %LOCALAPPDATA%\\Programs\\LAIN (no administrator)', fs.existsSync(path.join(installDir, 'lain.exe')), installDir);

  // ---- 2. INSTALLED APPS entry -----------------------------------------------------------------------------------
  const u = reg(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LAIN']).stdout || '';
  const val = (n) => (new RegExp(`\\s${n}\\s+REG_\\w+\\s+(.*)`).exec(u) || [])[1] || '';
  check('Installed apps: DisplayName, DisplayVersion, Publisher', val('DisplayName') === 'LAIN (CLI + Harness)' && val('DisplayVersion') === '0.1.0' && val('Publisher').length > 0, `${val('DisplayName')} · ${val('DisplayVersion')} · ${val('Publisher')}`);
  check('Installed apps: icon, location, uninstall/modify commands', /lain\.exe,0$/.test(val('DisplayIcon')) && val('InstallLocation').toLowerCase() === installDir.toLowerCase() && /Uninstall LAIN\.exe" --uninstall$/.test(val('UninstallString')) && /--uninstall --silent$/.test(val('QuietUninstallString')) && /Uninstall LAIN\.exe"$/.test(val('ModifyPath')), `${val('DisplayIcon')} | ${val('UninstallString')}`);
  check('Installed apps: no secret in the registry entry', !/token|secret|password|api[_-]?key|sk-/i.test(u), '');

  // ---- 3. START MENU -------------------------------------------------------------------------------------------------
  const menu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'LAIN');
  const lnks = fs.existsSync(menu) ? fs.readdirSync(menu).sort() : [];
  check('Start Menu: LAIN › LAIN CLI, LAIN Harness, LAIN Model Dashboard, Uninstall LAIN', ['LAIN CLI.lnk', 'LAIN Harness.lnk', 'LAIN Model Dashboard.lnk', 'Uninstall LAIN.lnk'].every((n) => lnks.includes(n)), lnks.join(', '));
  const lnkInfo = ps(`$s=New-Object -ComObject WScript.Shell; Get-ChildItem '${menu}' -Filter *.lnk | ForEach-Object { $l=$s.CreateShortcut($_.FullName); '{0}|{1}|{2}|{3}' -f $_.Name,$l.TargetPath,$l.Arguments,$l.IconLocation }`);
  check('Start Menu: each shortcut targets the installed launcher and carries its icon', lnkInfo.split('\n').every((l) => { const [, t, , ic] = l.split('|'); return t && t.toLowerCase().startsWith(installDir.toLowerCase()) && /,0$/.test(ic); }), lnkInfo);

  // ---- 4. PATH ---------------------------------------------------------------------------------------------------------
  const p1 = ps("[Environment]::GetEnvironmentVariable('PATH','User')");
  check('PATH: the user PATH gains exactly the install folder (machine PATH untouched)', p1.split(';').some((x) => x.toLowerCase() === installDir.toLowerCase()) && p1.split(';').filter(Boolean).length === snap0.path.split(';').filter(Boolean).length + 1, `${snap0.path.split(';').length} → ${p1.split(';').length}`);
  const where = spawnSync('cmd.exe', ['/c', 'where lain'], { encoding: 'utf8', env: { ...env, PATH: `${p1};${ps("[Environment]::GetEnvironmentVariable('PATH','Machine')")}` } });
  check('PATH: a NEW terminal finds `lain`', /Programs\\LAIN\\lain\.exe/i.test(where.stdout || ''), (where.stdout || where.stderr || '').trim());

  // ---- 5. OPEN WITH / OPEN FOLDER (offered, never a default) -----------------------------------------------------------
  const cmdOf = (k) => (/REG_SZ\s+(.*)/.exec(reg(['query', `${HIVE}\\${k}`, '/ve']).stdout || '') || [])[1] || '';
  const opener = path.join(installDir, 'LAIN Harness.exe');
  check('Open With: .py/.js/.md offer LAIN.Harness.File, whose command is the Harness launcher', ['py', 'js', 'md'].every((e) => /LAIN\.File/.test(reg(['query', `${HIVE}\\.${e}\\OpenWithProgids`]).stdout || '')) && cmdOf('LAIN.Harness.File\\shell\\open\\command').toLowerCase() === `"${opener}" "%1"`.toLowerCase(), cmdOf('LAIN.Harness.File\\shell\\open\\command'));
  check('Open folder: Directory and Directory\\Background verbs "Open folder in LAIN"', cmdOf('Directory\\shell\\LAIN.Harness.Open') === 'Open folder in LAIN' && /"%V"$/.test(cmdOf('Directory\\Background\\shell\\LAIN.Harness.Open\\command')), cmdOf('Directory\\Background\\shell\\LAIN.Harness.Open\\command'));
  check('Open With: no default program changed (every extension\'s (Default) and UserChoice as before)', defaults() === snap0.defaults && userChoice() === snap0.userChoice, '');
  check('Open With: LAIN\'s old entries were replaced (one "Open with" entry, not two)', lainAssoc() === 0, `${lainAssoc()} LAIN entries still present`);

  // ---- 6. VERSION + PUBLISHER METADATA, AND ICONS ----------------------------------------------------------------------
  const meta = ps(`Get-ChildItem '${installDir}' -Filter *.exe | ForEach-Object { $v=$_.VersionInfo; '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.Name,$v.ProductName,$v.FileDescription,$v.FileVersion,$v.CompanyName,$v.ProductVersion }`);
  check('Version resources: every executable says LAIN, its role, 0.1.0 and the publisher', meta.split('\n').every((l) => { const [, prod, , fv, co] = l.split('|'); return prod === 'LAIN' && /^0\.1\.0/.test(fv) && co === 'LAIN'; }), meta);
  const icons = ps(`Add-Type -AssemblyName System.Drawing; Get-ChildItem '${installDir}' -Filter *.exe | ForEach-Object { $i=[System.Drawing.Icon]::ExtractAssociatedIcon($_.FullName); '{0}|{1}x{2}' -f $_.Name,$i.Width,$i.Height }`);
  const sig = ps(`Get-ChildItem '${installDir}' -Filter *.exe | ForEach-Object { '{0}|{1}' -f $_.Name,(Get-AuthenticodeSignature $_.FullName).Status }`);
  check('Icons: every executable carries the LAIN icon', icons.split('\n').length >= 4 && fs.existsSync(path.join(installDir, 'lain.ico')), icons);
  check('Code signing: the executables are UNSIGNED (reported, not hidden)', sig.split('\n').every((l) => /NotSigned$/.test(l)), sig);
  const cli = spawnSync(path.join(installDir, 'lain.exe'), ['--version'], { encoding: 'utf8', env });
  check('lain --version: "LAIN CLI 0.1.0 (stable, <revision>)"', /^LAIN CLI 0\.1\.0 \(stable, [0-9a-f]{12}\)/.test(cli.stdout || ''), cli.stdout);
} finally {
  // ---- 7. UNINSTALL, then put LAIN's keys back ----------------------------------------------------------------------
  if (installDir && fs.existsSync(path.join(installDir, 'Uninstall LAIN.exe'))) {
    const log = path.join(work, 'uninstall.log');
    const r = spawnSync(path.join(installDir, 'Uninstall LAIN.exe'), ['--uninstall', '--silent', '--log', log], { env, encoding: 'utf8', timeout: 300000 });
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
    check('uninstall: exits 0', r.status === 0, fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
    check('uninstall: program, Start Menu, PATH entry, Installed apps entry and LAIN\'s Open With all gone', !fs.existsSync(path.join(installDir, 'lain.exe')) && !fs.existsSync(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'LAIN')) && !exists('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LAIN') && !exists(`${HIVE}\\LAIN.Harness.File`) && ps("[Environment]::GetEnvironmentVariable('PATH','User')") === snap0.path, fs.existsSync(installDir) ? fs.readdirSync(installDir).join(', ') : '(folder removed)');
  }
  for (const f of backups) reg(['import', f]);
  const after = { defaults: defaults(), userChoice: userChoice(), lain: lainAssoc(), path: ps("[Environment]::GetEnvironmentVariable('PATH','User')") };
  check('restored: LAIN\'s "Open with" entries are back, defaults/UserChoice/PATH exactly as before', JSON.stringify(after) === JSON.stringify(snap0), JSON.stringify({ lain: [snap0.lain, after.lain], path: [snap0.path.length, after.path.length] }));
  fs.writeFileSync(path.join(work, 'windows-acceptance.json'), JSON.stringify(results, null, 2));
  process.stdout.write(`\n${results.filter((x) => x.ok).length}/${results.length} passed · ${work}\n`);
}
