'use strict';

/**
 * SAFE DELETE (2026-10-06) — the one recursive delete for anything in LAIN's data: account homes (which hold junctions
 * into other programs' folders), the home's own folders, caches. The same rules as distribution/safedelete.cs:
 *   * a LINK (symlink, junction, any reparse point — Node reports them all as symbolic links) is removed AS A LINK and
 *     never entered: what it points at is never read, changed or deleted;
 *   * every real folder entered is proven (realpath) to be inside the root; anything unproven is left and reported;
 *   * the root is refused when it is a drive, the profile, an ancestor of it, or a system folder; with `within`, the root
 *     itself must be inside that folder.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const low = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
function real(p) { try { return fs.realpathSync.native(p); } catch { return null; } }
function under(child, root) { const c = low(child); const r = low(root).replace(/[\\/]+$/, ''); return c.startsWith(r + path.sep); }

/** Why `target` may not be removed, or null. */
function refusal(target, { within = null } = {}) {
  if (!target) return 'no folder was named';
  const abs = path.resolve(String(target));
  let st; try { st = fs.lstatSync(abs); } catch { return null; }      // nothing there
  if (st.isSymbolicLink()) return null;                                // a link: only the link goes
  const r = real(abs);
  if (!r) return `the real location of ${abs} could not be proven`;
  if (low(path.parse(r).root.replace(/[\\/]+$/, '')) === low(r.replace(/[\\/]+$/, ''))) return `${r} is a drive`;
  const special = [os.homedir(), process.env.APPDATA, process.env.LOCALAPPDATA, process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  for (const s of special) { const rs = real(s) || path.resolve(s); if (low(rs) === low(r) || under(rs, r)) return `${r} is (or contains) ${rs}`; }
  if (within) {
    const rw = real(within);
    if (!rw || !(low(r) === low(rw) || under(r, rw))) return `${r} is not inside ${within}`;
  }
  return null;
}

/**
 * Remove `target` and everything under it, never entering a link. Returns { ok, files, dirs, links, failed, errors, why }.
 * Refuses (and removes nothing) when the root is unproven.
 */
function removeTree(target, opts = {}) {
  const out = { ok: false, files: 0, dirs: 0, links: 0, failed: 0, errors: [], why: null };
  const why = refusal(target, opts);
  if (why) { out.why = `refused: ${why}`; return out; }
  const abs = path.resolve(String(target));
  let st; try { st = fs.lstatSync(abs); } catch { out.ok = true; return out; }
  const unlink = (p) => { try { fs.unlinkSync(p); out.links++; } catch { try { fs.rmdirSync(p); out.links++; } catch (e) { out.failed++; out.errors.push(`${p}: ${e.code || e.message}`); } } };
  if (st.isSymbolicLink()) { unlink(abs); out.ok = !out.failed; return out; }
  if (!st.isDirectory()) {                                             // one file
    try { fs.unlinkSync(abs); out.files++; } catch { try { fs.chmodSync(abs, 0o666); fs.unlinkSync(abs); out.files++; } catch (e) { out.failed++; out.errors.push(`${abs}: ${e.code || e.message}`); } }
    out.ok = !out.failed; if (!out.ok) out.why = out.errors[0]; return out;
  }
  const root = real(abs);
  const walk = (dir, depth) => {
    if (depth > 256) { out.failed++; out.errors.push(`too deep: ${dir}`); return; }
    let names; try { names = fs.readdirSync(dir); } catch (e) { out.failed++; out.errors.push(`${dir}: ${e.code}`); return; }
    for (const n of names) {
      const p = path.join(dir, n);
      let s; try { s = fs.lstatSync(p); } catch { continue; }
      if (s.isSymbolicLink()) { unlink(p); continue; }                 // never entered
      if (s.isDirectory()) {
        const rp = real(p);
        if (!rp || !under(rp, root)) { out.failed++; out.errors.push(`containment not proven, left alone: ${p}`); continue; }
        walk(p, depth + 1);
        continue;
      }
      try { fs.unlinkSync(p); out.files++; } catch { try { fs.chmodSync(p, 0o666); fs.unlinkSync(p); out.files++; } catch (e) { out.failed++; out.errors.push(`${p}: ${e.code || e.message}`); } }
    }
    try { fs.rmdirSync(dir); out.dirs++; } catch (e) { out.failed++; out.errors.push(`${dir}: ${e.code || e.message}`); }
  };
  walk(abs, 0);
  out.ok = out.failed === 0 && !fs.existsSync(abs);
  if (!out.ok && !out.why) out.why = `${out.failed} item(s) could not be removed${out.errors[0] ? ` (${out.errors[0]})` : ''}`;
  return out;
}

module.exports = { removeTree, refusal };
