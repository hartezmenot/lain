'use strict';

/**
 * THE EDITOR'S VENDORED CODE — Monaco, the editor VS Code is built on.
 *
 * ------------------------------------------------------------------------
 * WHY MONACO AND NOT A HOME-MADE EDITOR.
 *
 * A professional editor is find/replace, multi-cursor, folding, bracket
 * matching, undo that understands words, a hundred keybindings people already
 * have in their hands, language grammars, diagnostics markers and definition
 * providers. Monaco is all of that, MIT-licensed, and it is the exact editor a
 * VS Code or Cursor user already knows. Rebuilding it would be reinventing the
 * one part of this product that is already solved.
 *
 * ------------------------------------------------------------------------
 * FETCHED ONCE, PINNED, VERIFIED — the same shape as native/vendor.js.
 *
 * The npm tarball of a pinned version is downloaded, its sha512 checked against
 * the integrity the registry published for that version, and only `min/vs`
 * (the browser build) is extracted into `vendor/monaco/vs`. Nothing is
 * committed; nothing is fetched at runtime by the page; the page loads it from
 * the application's own origin.
 *
 * WITHOUT IT THE IDE STILL WORKS. `ensureMonaco()` failing — offline, blocked,
 * a checksum mismatch — leaves the built-in editor in charge, and the IDE says
 * which editor is running.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const VENDOR = path.join(__dirname, 'vendor');
const MONACO = path.join(VENDOR, 'monaco');

const PKG = Object.freeze({
  name: 'monaco-editor',
  version: '0.56.0',
  url: 'https://registry.npmjs.org/monaco-editor/-/monaco-editor-0.56.0.tgz',
  integrity: 'sha512-sXboRm3BeBeLm938eaiyLMe0OxzfXIlZvbv4ir/jVgQy1zDhWjgmny0WoN45fuDKhCCQsYMbBJrv/A6jd8aCUg==',
  license: 'MIT',
});

/**
 * THE TERMINAL EMULATOR — xterm.js, the one VS Code's terminal is, and its fit
 * addon. Same rules: pinned, verified, only the browser build extracted.
 */
const XTERM = Object.freeze([
  {
    name: '@xterm/xterm', version: '5.5.0', dir: 'xterm',
    url: 'https://registry.npmjs.org/@xterm/xterm/-/xterm-5.5.0.tgz',
    integrity: 'sha512-hqJHYaQb5OptNunnyAnkHyM8aCjZ1MEIDTQu1iIbbTD/xops91NB5yq1ZK/dC2JDbVWtF23zUtl9JE2NqwT87A==',
    keep: [/^package\/lib\/xterm\.js$/, /^package\/css\/xterm\.css$/],
  },
  {
    name: '@xterm/addon-fit', version: '0.10.0', dir: 'xterm',
    url: 'https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.10.0.tgz',
    integrity: 'sha512-UFYkDm4HUahf2lnEyHvio51TNGiLK66mqP2JoATy7hRZeXaGMRDr00JiSF7m63vR5WKATF605yEggJKsw0JpMQ==',
    keep: [/^package\/lib\/addon-fit\.js$/],
  },
]);
const XTERM_DIR = path.join(VENDOR, 'xterm');

function xtermDir() {
  try { return fs.existsSync(path.join(XTERM_DIR, 'xterm.js')) && fs.existsSync(path.join(XTERM_DIR, 'addon-fit.js')) ? XTERM_DIR : null; } catch { return null; }
}

/** Fetch, verify and extract the kept files of one tarball into `into`. */
async function fetchInto(pkg, into) {
  const tgz = await download(pkg.url);
  const got = crypto.createHash('sha512').update(tgz).digest('base64');
  if (got !== pkg.integrity.slice('sha512-'.length)) throw new Error(`${pkg.name}@${pkg.version} failed its integrity check`);
  const tar = zlib.gunzipSync(tgz);
  let n = 0;
  for (const e of tarEntries(tar)) {
    if (e.type !== '0' && e.type !== '\0') continue;
    if (!pkg.keep.some((re) => re.test(e.name))) continue;
    fs.mkdirSync(into, { recursive: true });
    fs.writeFileSync(path.join(into, path.posix.basename(e.name)), e.data);
    n += 1;
  }
  if (!n) throw new Error(`${pkg.name} had none of the expected files`);
  return n;
}

async function ensureXterm() {
  if (xtermDir()) return { ok: true, dir: XTERM_DIR, fetched: false };
  const staging = `${XTERM_DIR}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const pkg of XTERM) await fetchInto(pkg, staging);
    fs.writeFileSync(path.join(staging, 'VERSION'), XTERM.map((p) => `${p.name}@${p.version} (MIT)`).join('\n') + '\n');
    fs.rmSync(XTERM_DIR, { recursive: true, force: true });
    fs.renameSync(staging, XTERM_DIR);
    return { ok: true, dir: XTERM_DIR, fetched: true };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, why: e.message };
  }
}

/** Everything the page vendors, fetched once. Never throws. */
async function ensureAll() {
  const a = await ensureMonaco().catch((e) => ({ ok: false, why: e.message }));
  const b = await ensureXterm().catch((e) => ({ ok: false, why: e.message }));
  return { ok: a.ok && b.ok, monaco: a, xterm: b, why: [a.why, b.why].filter(Boolean).join('; ') };
}

/** The directory to serve as `vendor/monaco`, or null when not vendored. */
function monacoDir() {
  try { return fs.existsSync(path.join(MONACO, 'vs', 'loader.js')) ? MONACO : null; } catch { return null; }
}

function download(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * A MINIMAL TAR READER — ustar, GNU long names and pax path records, which is
 * everything an npm tarball uses. Yields { name, type, data }.
 */
function* tarEntries(buf) {
  let off = 0;
  let longName = null;
  let paxPath = null;
  const str = (a, b) => buf.toString('utf8', a, b).replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(off + 345, off + 500);
    let name = str(off, off + 100);
    if (prefix) name = `${prefix}/${name}`;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (longName) { name = longName; longName = null; }
    if (paxPath) { name = paxPath; paxPath = null; }
    yield { name, type, data };
  }
}

/**
 * FETCH AND EXTRACT MONACO if it is not already here. Idempotent.
 * @returns {Promise<{ok:boolean, dir?:string, why?:string, fetched?:boolean}>}
 */
async function ensureMonaco() {
  if (monacoDir()) return { ok: true, dir: MONACO, fetched: false };
  let tgz;
  try { tgz = await download(PKG.url); } catch (e) { return { ok: false, why: `could not download ${PKG.name}@${PKG.version}: ${e.message}` }; }
  const want = PKG.integrity.slice('sha512-'.length);
  const got = crypto.createHash('sha512').update(tgz).digest('base64');
  if (got !== want) return { ok: false, why: `${PKG.name}@${PKG.version} failed its integrity check — not installed` };
  let tar;
  try { tar = zlib.gunzipSync(tgz); } catch (e) { return { ok: false, why: `could not unpack ${PKG.name}: ${e.message}` }; }
  const staging = `${MONACO}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  let files = 0;
  for (const e of tarEntries(tar)) {
    if (e.type !== '0' && e.type !== '\0') continue;
    const m = /^package\/min\/(vs\/.+)$/.exec(e.name);
    if (!m) continue;
    const rel = m[1];
    if (rel.split('/').some((p) => p === '..' || p === '')) continue;
    const out = path.join(staging, ...rel.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, e.data);
    files += 1;
  }
  if (!files || !fs.existsSync(path.join(staging, 'vs', 'loader.js'))) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, why: `${PKG.name} tarball had no min/vs build` };
  }
  fs.writeFileSync(path.join(staging, 'VERSION'), `${PKG.name}@${PKG.version} (${PKG.license})\n`);
  fs.rmSync(MONACO, { recursive: true, force: true });
  fs.renameSync(staging, MONACO);
  return { ok: true, dir: MONACO, fetched: true, files };
}

/** The directories the application serves beside index.html, by URL path. */
function assetDirs() {
  const out = [];
  const m = monacoDir();
  if (m) out.push({ url: 'vendor/monaco', dir: m });
  const x = xtermDir();
  if (x) out.push({ url: 'vendor/xterm', dir: x });
  // LAIN DESIGN'S SURFACE (design/), when that component is installed: served beside the page, loaded only when the
  // Design room opens (page/shell/designentry.js).
  const d = path.join(__dirname, 'design');
  if (fs.existsSync(path.join(d, 'design.js'))) out.push({ url: 'design', dir: d });
  return out;
}

module.exports = { ensureMonaco, ensureXterm, ensureAll, monacoDir, xtermDir, assetDirs, PKG, XTERM, tarEntries };
