'use strict';

/** A BROWSER LAIN OWNS — pinned, installed on purpose, and never updated behind a running verification. */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

/** THE PINNED BUILD. */
const PINNED = '141.0.7390.54';

/** Where Chrome for Testing publishes what it has. Read only when installing. */
const CATALOG = 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';
const DOWNLOAD_BASE = 'https://storage.googleapis.com/chrome-for-testing-public';

const INSTALL_HINT = '/env chromium install — downloads the pinned Harness browser (~160MB, once)';

/** WHAT THIS PLATFORM IS CALLED IN THE DISTRIBUTION, and where the executable sits inside the archive. */
const PLATFORMS = {
  'win32-x64': { id: 'win64', exe: 'chrome.exe' },
  'win32-ia32': { id: 'win32', exe: 'chrome.exe' },
  'darwin-x64': { id: 'mac-x64', exe: path.join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') },
  'darwin-arm64': { id: 'mac-arm64', exe: path.join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') },
  'linux-x64': { id: 'linux64', exe: 'chrome' },
};

function platform() {
  const key = `${process.platform}-${process.arch}`;
  return PLATFORMS[key] || null;
}

/** Every managed build lives under one parent, so the boundary is checkable. */
function root() {
  return path.join(require('../config').configDir(), 'chromium');
}

/** One version's directory. Hex-free but validated, because it names a path. */
function dirFor(version) {
  const v = String(version || '');
  if (!/^\d+(\.\d+){0,3}$/.test(v)) throw new Error(`not a version: ${JSON.stringify(v)}`);
  return path.join(root(), v);
}

/** Where the executable ends up for a given version on this platform. */
function exePath(version) {
  const p = platform();
  if (!p) return null;
  return path.join(dirFor(version), p.exe);
}

/** IS THE PINNED BUILD INSTALLED? */
function installed({ version = PINNED } = {}) {
  const tried = [];
  const p = platform();
  if (!p) return { ok: false, tried, why: `no managed browser is published for ${process.platform}/${process.arch}` };

  const candidates = [version];
  try {
    for (const e of fs.readdirSync(root(), { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== version && /^\d+(\.\d+){0,3}$/.test(e.name)) candidates.push(e.name);
    }
  } catch { /* nothing installed yet */ }

  for (const v of candidates) {
    let exe;
    try { exe = exePath(v); } catch { continue; }
    tried.push(exe);
    try {
      if (fs.statSync(exe).isFile()) return { ok: true, path: exe, version: v, pinned: v === version };
    } catch { /* not this one */ }
  }
  return { ok: false, tried, why: `the pinned Harness browser (${version}) is not installed` };
}

/** THE VERSION OF A BROWSER ON DISK, WITHOUT RUNNING IT. */
function versionAt(exe) {
  const p = String(exe || '');
  if (!p) return '';
  const m = p.replace(/\\/g, '/').match(/\/chromium\/(\d+(?:\.\d+){0,3})\//);
  if (m) return m[1];
  try {
    const dir = path.dirname(p);
    const versions = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(e.name))
      .map((e) => e.name)
      .sort();
    if (versions.length) return versions[versions.length - 1];
  } catch { /* unreadable, and a guess would be worse than nothing */ }
  return '';
}

/** One HTTPS GET into memory, with redirects and a hard ceiling. */
function get(url, { limit = 400 * 1024 * 1024, redirects = 5, onProgress = null } = {}) {
  return new Promise((resolve) => {
    if (redirects < 0) return resolve({ ok: false, why: 'too many redirects' });
    let req;
    try {
      req = https.get(url, { headers: { 'user-agent': 'lain-harness' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), { limit, redirects: redirects - 1, onProgress }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve({ ok: false, why: `${url} answered ${res.statusCode}` });
        }
        const total = Number(res.headers['content-length']) || 0;
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > limit) { req.destroy(); return resolve({ ok: false, why: `the download exceeded ${limit} bytes` }); }
          chunks.push(c);
          if (onProgress) onProgress(size, total);
        });
        res.on('end', () => resolve({ ok: true, body: Buffer.concat(chunks), bytes: size }));
        res.on('error', (e) => resolve({ ok: false, why: `the download failed: ${(e && e.message) || e}` }));
      });
    } catch (e) { return resolve({ ok: false, why: `could not request ${url}: ${(e && e.message) || e}` }); }
    req.on('error', (e) => resolve({ ok: false, why: `could not reach ${url}: ${(e && e.message) || e}` }));
    req.setTimeout(120_000, () => { req.destroy(); resolve({ ok: false, why: `${url} timed out` }); });
  });
}

/** WHAT AN INSTALL WOULD DO, WITHOUT DOING IT. */
function plan({ version = PINNED } = {}) {
  const p = platform();
  if (!p) {
    return { ok: false, why: `no managed browser is published for ${process.platform}/${process.arch}` };
  }
  return {
    ok: true,
    version,
    platform: p.id,
    url: `${DOWNLOAD_BASE}/${version}/${p.id}/chrome-${p.id}.zip`,
    dest: dirFor(version),
    exe: exePath(version),
    catalog: CATALOG,
  };
}

/** INSTALL THE PINNED BUILD. */
async function install({ version = PINNED, onProgress = null, force = false } = {}) {
  const p = plan({ version });
  if (!p.ok) return p;

  const have = installed({ version });
  if (have.ok && have.version === version && !force) {
    return { ok: true, already: true, path: have.path, version };
  }

  const got = await get(p.url, { onProgress });
  if (!got.ok) return { ok: false, why: `could not download the Harness browser: ${got.why}`, url: p.url };

  let tmp;
  try {
    fs.mkdirSync(root(), { recursive: true });
    tmp = fs.mkdtempSync(path.join(root(), '.installing-'));
  } catch (e) {
    return { ok: false, why: `could not prepare ${root()}: ${(e && e.message) || e}` };
  }

  const zip = path.join(tmp, 'chrome.zip');
  try { fs.writeFileSync(zip, got.body); } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, why: `could not write the archive: ${(e && e.message) || e}` };
  }

  // STRIP ONE LEVEL: the archive wraps everything in `chrome-win64/`, which
  // nobody wants repeated inside a directory already named for the version.
  const out = await Promise.resolve(require('./unzip').extract(zip, path.join(tmp, 'x'), { strip: 1 }));
  try { fs.rmSync(zip, { force: true }); } catch { /* best effort */ }
  if (!out.ok) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, why: out.why };
  }

  const staged = path.join(tmp, 'x', platform().exe);
  try {
    if (!fs.statSync(staged).isFile()) throw new Error('not a file');
  } catch {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, why: `the archive did not contain ${platform().exe} — the distribution layout has changed` };
  }

  const dest = dirFor(version);
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(path.join(tmp, 'x'), dest);
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, why: `could not place the browser at ${dest}: ${(e && e.message) || e}` };
  }

  const now = installed({ version });
  if (!now.ok) return { ok: false, why: `the install completed but ${exePath(version)} is not there` };
  return { ok: true, already: false, path: now.path, version, bytes: got.bytes, files: out.written };
}

/** Remove one managed build. Only reached when somebody asks. */
function remove({ version = PINNED } = {}) {
  let dir;
  try { dir = dirFor(version); } catch (e) { return { ok: false, why: (e && e.message) || String(e) }; }
  const parent = path.resolve(root());
  if (!path.resolve(dir).startsWith(parent + path.sep)) return { ok: false, why: `refusing to remove ${dir}` };
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    return { ok: true, removed: dir };
  } catch (e) {
    return { ok: false, why: `could not remove ${dir}: ${(e && e.message) || e}` };
  }
}

/** What is on disk, for `/env`. Stats only — no network, no launch. */
function describe() {
  const p = platform();
  const have = installed();
  let builds = [];
  try {
    builds = fs.readdirSync(root(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+(\.\d+){0,3}$/.test(e.name))
      .map((e) => e.name).sort();
  } catch { builds = []; }
  return {
    pinned: PINNED,
    platform: p ? p.id : `${process.platform}/${process.arch} (unsupported)`,
    root: root(),
    installed: have.ok,
    version: have.ok ? have.version : null,
    path: have.ok ? have.path : null,
    builds,
    hint: have.ok ? '' : INSTALL_HINT,
    tmpdir: os.tmpdir(),
  };
}

module.exports = {
  PINNED, CATALOG, DOWNLOAD_BASE, INSTALL_HINT, PLATFORMS,
  platform, root, dirFor, exePath, installed, versionAt, plan, install, remove, describe,
};
