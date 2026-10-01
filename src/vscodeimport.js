'use strict';

/**
 * IMPORT FROM VS CODE OR CURSOR — read theirs, keep what LAIN can honour, and
 * say plainly what it cannot.
 *
 *   detect()          which editors are on this machine, and what each has
 *   preview(product)  exactly what an import would bring, item by item
 *   apply(product)    write LAIN's editor profile (editorprofile.js)
 *
 * READ ONLY, ALWAYS. The person's editor files are opened for reading and
 * nothing under %APPDATA%\Code, %APPDATA%\Cursor, ~/.vscode or ~/.cursor is
 * ever written, renamed or touched.
 *
 * NO COMPATIBILITY CLAIMED THAT IS NOT REAL:
 *   settings      only the editor options Monaco applies (editorprofile SETTINGS)
 *   keybindings   single chords bound to editor commands Monaco or LAIN has
 *   snippets      user snippets (per-language and global .code-snippets)
 *   themes        LAIN keeps its palette — the theme is named, not applied
 *   extensions    LAIN does not run the VS Code extension host, so an extension
 *                 with code does not run; each is listed with what it needs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const profile = require('./editorprofile');

const PRODUCTS = Object.freeze({
  vscode: { label: 'VS Code', user: ['Code', 'User'], ext: '.vscode' },
  cursor: { label: 'Cursor', user: ['Cursor', 'User'], ext: '.cursor' },
});

function readJsonc(p) {
  try { return require('./harnessapp/ideroutes').readJsonc(p); } catch { return null; }
}

function dirs(product, env = process.env) {
  const P = PRODUCTS[product];
  if (!P) return null;
  const appdata = env.APPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Roaming');
  const home = env.USERPROFILE || os.homedir();
  return { user: path.join(appdata, ...P.user), extensions: path.join(home, P.ext, 'extensions') };
}

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

/** Which editors are here, and counts of what each holds. Reads names only. */
function detect(env = process.env) {
  return Object.keys(PRODUCTS).map((id) => {
    const d = dirs(id, env);
    const snippetsDir = path.join(d.user, 'snippets');
    let snippetFiles = 0;
    try { snippetFiles = fs.readdirSync(snippetsDir).filter((f) => /\.(json|code-snippets)$/.test(f)).length; } catch { snippetFiles = 0; }
    let extensions = 0;
    try { extensions = fs.readdirSync(d.extensions, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).length; } catch { extensions = 0; }
    return {
      id,
      label: PRODUCTS[id].label,
      present: exists(d.user) || exists(d.extensions),
      settings: exists(path.join(d.user, 'settings.json')),
      keybindings: exists(path.join(d.user, 'keybindings.json')),
      snippetFiles,
      extensions,
    };
  });
}

function settingsOf(user) {
  const raw = readJsonc(path.join(user, 'settings.json'));
  const out = { apply: {}, applied: [], unsupported: [], theme: null, unreadable: Boolean(raw && raw.unreadable) };
  if (!raw || raw.unreadable || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'workbench.colorTheme' || k === 'workbench.iconTheme' || k === 'workbench.productIconTheme') {
      if (k === 'workbench.colorTheme') out.theme = String(v);
      out.unsupported.push({ key: k, why: 'Noema keeps its own palette' });
      continue;
    }
    const map = profile.SETTINGS[k];
    if (!map) { out.unsupported.push({ key: k, why: 'no Noema equivalent' }); continue; }
    const value = map[1](v);
    if (value === undefined) { out.unsupported.push({ key: k, why: `value ${JSON.stringify(v).slice(0, 40)} is not one Noema accepts` }); continue; }
    out.apply[map[0]] = value;
    out.applied.push({ key: k, option: map[0], value });
  }
  return out;
}

function keybindingsOf(user) {
  const raw = readJsonc(path.join(user, 'keybindings.json'));
  const out = { apply: [], unsupported: [] };
  if (!Array.isArray(raw)) return out;
  for (const kb of raw.slice(0, profile.MAX_KEYBINDINGS)) {
    const r = profile.keybinding(kb);
    if (r.ok) out.apply.push(r.value);
    else out.unsupported.push({ key: String((kb && kb.key) || ''), command: String((kb && kb.command) || ''), why: r.why });
  }
  return out;
}

function snippetsOf(user) {
  const out = { apply: {}, count: 0, skipped: 0, files: [] };
  const dir = path.join(user, 'snippets');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /\.(json|code-snippets)$/.test(f)); } catch { return out; }
  const add = (lang, s) => {
    if (out.count >= profile.MAX_SNIPPETS) { out.skipped += 1; return; }
    (out.apply[lang] = out.apply[lang] || []).push(s);
    out.count += 1;
  };
  for (const f of names) {
    const raw = readJsonc(path.join(dir, f));
    if (!raw || raw.unreadable || typeof raw !== 'object') { out.skipped += 1; continue; }
    out.files.push(f);
    const global = f.endsWith('.code-snippets');
    const fileLang = global ? null : profile.language(f.replace(/\.json$/, ''));
    for (const [name, def] of Object.entries(raw)) {
      const s = profile.snippet(name, def);
      if (!s) { out.skipped += 1; continue; }
      if (fileLang) { add(fileLang, s); continue; }
      const scopes = def && def.scope ? String(def.scope).split(',').map((x) => profile.language(x)).filter(Boolean) : ['*'];
      for (const lang of [...new Set(scopes)]) add(lang, s);
    }
  }
  return out;
}

/** An installed extension, and what it would need to work in LAIN. */
function extensionVerdict(pkg) {
  const c = (pkg && pkg.contributes) || {};
  const code = Boolean(pkg && (pkg.main || pkg.browser));
  const parts = Object.keys(c);
  if (code) return { usable: false, why: 'runs code in the VS Code extension host, which Noema does not run' };
  if (c.snippets) return { usable: false, why: 'declarative snippets — installable as a Noema extension (Extensions › Install)', installable: true };
  if (c.themes) return { usable: false, why: 'a colour theme — Noema keeps its own palette' };
  if (c.grammars || c.languages) return { usable: false, why: 'language grammar — Noema’s editor highlights with its own grammars; TextMate grammars are not loaded' };
  return { usable: false, why: parts.length ? `contributes ${parts.slice(0, 4).join(', ')} — not supported` : 'no contributions Noema can read' };
}

function extensionsOf(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')); } catch { return out; }
  for (const e of entries.slice(0, 400)) {
    const pkg = readJsonc(path.join(dir, e.name, 'package.json'));
    if (!pkg || pkg.unreadable) { out.push({ id: e.name, version: '', name: e.name, usable: false, why: 'its package.json could not be read' }); continue; }
    const id = `${pkg.publisher || 'unknown'}.${pkg.name || e.name}`;
    out.push({ id, version: String(pkg.version || ''), name: String(pkg.displayName || pkg.name || e.name).slice(0, 120), ...extensionVerdict(pkg) });
  }
  const seen = new Map();
  for (const x of out) seen.set(x.id, x);            // newest folder of a duplicated id wins
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Exactly what an import would bring — nothing is written. */
function preview(product, env = process.env) {
  const d = dirs(product, env);
  if (!d) return { ok: false, why: `unknown editor "${product}"` };
  if (!exists(d.user) && !exists(d.extensions)) return { ok: false, why: `${PRODUCTS[product].label} was not found on this machine` };
  const settings = settingsOf(d.user);
  const keybindings = keybindingsOf(d.user);
  const snippets = snippetsOf(d.user);
  const extensions = extensionsOf(d.extensions);
  return {
    ok: true,
    product,
    label: PRODUCTS[product].label,
    settings: { applied: settings.applied, unsupported: settings.unsupported, theme: settings.theme, unreadable: settings.unreadable },
    keybindings: { applied: keybindings.apply, unsupported: keybindings.unsupported },
    snippets: { count: snippets.count, languages: Object.keys(snippets.apply), files: snippets.files, skipped: snippets.skipped },
    extensions,
    _apply: { settings: settings.apply, keybindings: keybindings.apply, snippets: snippets.apply },
  };
}

/** Write LAIN's editor profile from the chosen parts. Their files stay as they were. */
function apply(product, { settings = true, keybindings = true, snippets = true } = {}, { env = process.env, configDir = null } = {}) {
  const p = preview(product, env);
  if (!p.ok) return p;
  const cur = profile.read(configDir);
  const next = { ...cur };
  if (settings) next.settings = { ...cur.settings, ...p._apply.settings };
  if (keybindings) next.keybindings = p._apply.keybindings;
  if (snippets) next.snippets = p._apply.snippets;
  next.importedFrom = {
    product, label: p.label, at: Date.now(),
    settings: settings ? p.settings.applied.length : 0,
    keybindings: keybindings ? p.keybindings.applied.length : 0,
    snippets: snippets ? p.snippets.count : 0,
    notImported: { settings: p.settings.unsupported.length, keybindings: p.keybindings.unsupported.length, extensions: p.extensions.length },
    theme: p.settings.theme,
  };
  profile.write(next, configDir);
  const { _apply, ...report } = p;
  return { ok: true, imported: next.importedFrom, report };
}

module.exports = { detect, preview, apply, dirs, extensionVerdict, PRODUCTS };
