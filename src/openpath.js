'use strict';

/** OPEN A FILE OR A FOLDER IN LAIN — what Windows' "Open with LAIN" and "Open folder in LAIN" do (2026-09-29). */

const fs = require('fs');
const path = require('path');

const MARKERS = Object.freeze(['.git', '.noema', '.lain', 'package.json', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'CMakeLists.txt', 'deno.json', '.hg', '.svn']);
const SOLUTION = /\.(sln|slnx|csproj|fsproj|vcxproj)$/i;
const MAX_UP = 40;

function has(dir, name) { try { return fs.existsSync(path.join(dir, name)); } catch { return false; } }

/** Folders never proposed as a project: the home folder (a dotfiles `.git` there is not "your project") and drive roots. */
function tooBroad(dir) {
  // LONG NAMES ON BOTH SIDES: TEMP and friends often carry the 8.3 form (C:\Users\HARTEZ~1) of the same home.
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const d = real(dir).toLowerCase();
  const home = real(require('os').homedir()).toLowerCase();
  return d === home || path.parse(d).root === d || d === path.dirname(home);
}

/** The project a file belongs to: the nearest ancestor that looks like one — below the home folder — else the file's own folder. */
function projectRootOf(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < MAX_UP && !tooBroad(dir); i++) {
    if (MARKERS.some((m) => has(dir, m))) return dir;
    try { if (fs.readdirSync(dir).some((n) => SOLUTION.test(n))) return dir; } catch { /* unreadable: keep climbing */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.dirname(file);
}

/** What was asked for, resolved: { dir: true, root } for a folder; { root, rel } for a file. */
function resolveTarget(p) {
  const raw = String(p || '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) return { ok: false, why: 'nothing to open' };
  const abs = path.resolve(raw);
  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, why: `${abs} does not exist` }; }
  if (st.isDirectory()) return { ok: true, dir: true, root: abs, rel: null, abs };
  if (!st.isFile()) return { ok: false, why: `${abs} is not a file or a folder` };
  const root = projectRootOf(abs);
  return { ok: true, dir: false, root, rel: path.relative(root, abs).split(path.sep).join('/'), abs };
}

/** OPEN IT. Returns { ok, root, file, session } — the window is told through `_uiNavigate` (applied once, even by a window that is only now starting). */
async function open(app, target) {
  const t = resolveTarget(target);
  if (!t.ok) return t;
  const r = await require('./harnessapp/workspaceroutes').openProject(app, t.root);
  const b = (r && r.body) || {};
  if (!b.ok) return { ok: false, why: b.why || `LAIN could not open ${t.root} as a project` };
  const root = (app && app._sibling) || app;
  const prev = root._uiNavigate;
  root._uiNavigate = { seq: (prev && prev.seq ? prev.seq : 0) + 1, surface: 'ide', section: null, args: { openFile: t.rel, project: t.root, focus: 'editor' }, at: Date.now() };
  return { ok: true, root: t.root, file: t.rel, session: b.id || null };
}

module.exports = { open, resolveTarget, projectRootOf, MARKERS };
