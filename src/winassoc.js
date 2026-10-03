'use strict';

/** LAIN IN WINDOWS' "OPEN WITH" — an available handler, never a stolen default (2026-09-29; Noema-era names until 2026-10-02). */

const path = require('path');
const { spawnSync } = require('child_process');

// A NEW PROGID, not the obsolete LAIN.File: cleaning up the pre-cleanup LAIN must never remove the current entries.
const PROGID = 'LAIN.Harness.File';
const VERB = 'LAIN.Harness.Open';
/** Older registrations, removed whenever LAIN registers or unregisters. */
const LEGACY = Object.freeze([
  Object.freeze({ PROGID: 'LAIN.File', VERB: 'LAIN.Open', APPS: ['LAIN.exe'] }),                                    // obsolete pre-cleanup LAIN
  Object.freeze({ PROGID: 'Noema.File', VERB: 'Noema.Open', APPS: ['noemaw.exe', 'Noema Harness.exe', 'Noema.exe'] }), // the Noema era
]);
/** Every launcher name LAIN registers as an application (removed on unregister). */
const APPS = Object.freeze(['lainw.exe', 'LAIN Harness.exe']);
/** The development and text formats LAIN offers to open (§12). */
const EXTENSIONS = Object.freeze([
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'jsonc', 'md', 'txt', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'cs', 'java', 'kt', 'kts',
  'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'ps1', 'bat', 'cmd', 'sh', 'sql',
]);
const HIVE = 'HKCU\\Software\\Classes';

/** One `reg.exe` call. `exec` is the seam tests use (a scratch hive, or a recorder). */
function defaultExec(args) {
  const r = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { ok: r.status === 0, code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function commandFor(exe, arg = '%1') { return `"${exe}" "${arg}"`; }

/** Every write, as reg.exe arguments. Pure — so a test can read the plan without a registry. */
function plan(exe, { hive = HIVE, extensions = EXTENSIONS, files = true, folders = true } = {}) {
  const add = (key, name, data, type = 'REG_SZ') => ['add', `${hive}\\${key}`, ...(name == null ? ['/ve'] : ['/v', name]), '/t', type, '/d', data, '/f'];
  const icon = `"${exe}",0`;
  const APP = path.basename(String(exe));
  const out = [
    add(PROGID, null, 'LAIN file'),
    add(PROGID, 'FriendlyTypeName', 'LAIN file'),
    add(`${PROGID}\\DefaultIcon`, null, icon),
    add(`${PROGID}\\shell\\open`, null, 'Open with LAIN'),
    add(`${PROGID}\\shell\\open\\command`, null, commandFor(exe)),
    add(`Applications\\${APP}`, 'FriendlyAppName', 'LAIN'),
    add(`Applications\\${APP}\\DefaultIcon`, null, icon),
    add(`Applications\\${APP}\\shell\\open\\command`, null, commandFor(exe)),
  ];
  if (folders) {
    out.push(
      add(`Directory\\shell\\${VERB}`, null, 'Open folder in LAIN'),
      add(`Directory\\shell\\${VERB}`, 'Icon', icon),
      add(`Directory\\shell\\${VERB}\\command`, null, commandFor(exe)),
      add(`Directory\\Background\\shell\\${VERB}`, null, 'Open folder in LAIN'),
      add(`Directory\\Background\\shell\\${VERB}`, 'Icon', icon),
      add(`Directory\\Background\\shell\\${VERB}\\command`, null, commandFor(exe, '%V')),
    );
  }
  for (const e of files ? extensions : []) {
    out.push(add(`Applications\\${APP}\\SupportedTypes`, `.${e}`, ''));
    out.push(add(`.${e}\\OpenWithProgids`, PROGID, ''));
    out.push(add(`SystemFileAssociations\\.${e}\\shell\\${VERB}`, null, 'Open with LAIN'));
    out.push(add(`SystemFileAssociations\\.${e}\\shell\\${VERB}`, 'Icon', icon));
    out.push(add(`SystemFileAssociations\\.${e}\\shell\\${VERB}\\command`, null, commandFor(exe)));
  }
  return out;
}

/** Every removal: the program's own keys, and its value in each OpenWithProgids — never the extension key itself. */
function unplan({ hive = HIVE, extensions = EXTENSIONS, names = { PROGID, VERB }, apps = APPS } = {}) {
  const del = (key, value = null) => ['delete', `${hive}\\${key}`, ...(value ? ['/v', value] : []), '/f'];
  const out = [del(names.PROGID), ...apps.map((a) => del(`Applications\\${a}`)), del(`Directory\\shell\\${names.VERB}`), del(`Directory\\Background\\shell\\${names.VERB}`)];
  for (const e of extensions) { out.push(del(`.${e}\\OpenWithProgids`, names.PROGID)); out.push(del(`SystemFileAssociations\\.${e}\\shell\\${names.VERB}`)); }
  return out;
}
/** The older registrations — the same removal, under each older set of names. */
function unplanLegacy(o = {}) { return LEGACY.flatMap((l) => unplan({ ...o, names: l, apps: l.APPS })); }

/** Tell Explorer the associations changed (SHChangeNotify, through the window host — Node cannot call it). */
function notifyShell(exe) {
  try { spawnSync(exe, ['--assoc-changed'], { windowsHide: true, timeout: 10000 }); return true; } catch { return false; }
}

/** REGISTER. @param o.exe the launcher; o.exec / o.hive for tests; o.files / o.folders to offer only one kind. @returns {{ ok, written, failed: [{ args… */
function register({ exe, exec = defaultExec, hive = HIVE, extensions = EXTENSIONS, notify = true, files = true, folders = true } = {}) {
  if (process.platform !== 'win32' && exec === defaultExec) return { ok: false, why: 'Windows only' };
  if (!exe) return { ok: false, why: 'no launcher to register — run lain --desktop once' };
  for (const args of unplanLegacy({ hive, extensions })) exec(args);   // older entries first: one "Open with" entry
  const failed = [];
  let written = 0;
  for (const args of plan(exe, { hive, extensions, files, folders })) { const r = exec(args); if (r.ok) written += 1; else failed.push({ args, err: (r.err || '').trim().slice(0, 200) }); }
  if (notify && exec === defaultExec && hive === HIVE) notifyShell(exe);
  return { ok: failed.length === 0, written, failed };
}

function unregister({ exec = defaultExec, hive = HIVE, extensions = EXTENSIONS, exe = null, notify = true } = {}) {
  if (process.platform !== 'win32' && exec === defaultExec) return { ok: false, why: 'Windows only' };
  let removed = 0;
  for (const args of [...unplan({ hive, extensions }), ...unplanLegacy({ hive, extensions })]) { const r = exec(args); if (r.ok) removed += 1; }
  if (notify && exe && exec === defaultExec && hive === HIVE) notifyShell(exe);
  return { ok: true, removed };
}

/** Is LAIN offered in "Open with"? — the ProgID's command, read back. */
function status({ exec = defaultExec, hive = HIVE } = {}) {
  if (process.platform !== 'win32' && exec === defaultExec) return { registered: false, why: 'Windows only' };
  const r = exec(['query', `${hive}\\${PROGID}\\shell\\open\\command`, '/ve']);
  const m = /REG_SZ\s+"([^"]+)"/.exec(r.out || '');
  return { registered: Boolean(r.ok && m), exe: m ? m[1] : null, extensions: EXTENSIONS.length };
}

/** `lain assoc register --exe <launcher> [--no-files] [--no-folders]` · `lain assoc remove` — what the installer runs. */
function cli(args = [], { out = process.stdout } = {}) {
  const verb = args[0];
  const at = args.indexOf('--exe');
  const exe = at >= 0 ? args[at + 1] : null;
  const host = () => { try { const d = require('./desktop'); return typeof d.hostExe === 'function' ? d.hostExe() : null; } catch { return null; } };
  if (verb === 'remove' || verb === 'unregister') {
    const r = unregister({ exe: host() });
    out.write(`Removed LAIN (and older LAIN/Noema entries) from "Open with" (${r.removed || 0} entries).\n`);
    return 0;
  }
  if (verb === 'register' && exe) {
    const files = !args.includes('--no-files'); const folders = !args.includes('--no-folders');
    const r = register({ exe, files, folders, notify: false });
    const h = host(); if (h) notifyShell(h);
    if (!r.ok) { out.write(`Open with: ${r.why || `${r.failed.length} registry write(s) failed`}\n`); return 1; }
    out.write(`LAIN is offered in "Open with"${files ? ` for ${EXTENSIONS.length} file types` : ''}${folders ? `${files ? ', and' : ''} "Open folder in LAIN" on folders` : ''}. No default program was changed.\n`);
    return 0;
  }
  out.write('usage: lain assoc register --exe <launcher> [--no-files] [--no-folders] | lain assoc remove\n');
  return 2;
}

module.exports = { register, unregister, status, plan, unplan, unplanLegacy, cli, EXTENSIONS, PROGID, VERB, LEGACY, APPS, HIVE };
