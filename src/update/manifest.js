'use strict';

/**
 * THE UPDATE MANIFEST — what a release says about itself, and how LAIN decides to believe it.
 *
 *   manifest-<channel>.json        the release, as bytes
 *   manifest-<channel>.json.sig    an Ed25519 signature over exactly those bytes (base64)
 *
 * The manifest is believed only when the signature verifies against a key LAIN was BUILT with (trust.js); every
 * asset it names is then believed only when its SHA-256 matches. HTTPS, a mirror or a filesystem path is transport,
 * never trust. A manifest carries no secret and names no local path.
 *
 * {
 *   "schema": 1, "product": "lain", "channel": "stable",          (the Noema-era "noema" is accepted too)
 *   "version": "0.2.0", "released": "2026-10-01T00:00:00Z",
 *   "minimumCompatible": "0.1.0",               // the oldest installed version that may update to this directly
 *   "protocol": 1, "minimumCli": "0.1.0", "minimumHarness": "0.1.0",
 *   "mandatory": false, "security": false,
 *   "notes": "https://…/releases/tag/v0.2.0", "summary": ["…"],
 *   "assets": [{ "arch": "x64", "kind": "app", "name": "lain-0.2.0-win-x64.zip", "url": "…", "size": 123, "sha256": "…" }]
 * }
 */

const crypto = require('crypto');

const CHANNELS = Object.freeze(['stable', 'preview']);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseVersion(v) {
  const m = SEMVER.exec(String(v || '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null } : null;
}
/** -1, 0, 1 — semver order; a pre-release sorts before its release. */
function compare(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const pa = x.pre.split('.'); const pb = y.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]); const nb = /^\d+$/.test(pb[i]);
    if (na && nb && +pa[i] !== +pb[i]) return +pa[i] < +pb[i] ? -1 : 1;
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Verify `bytes` (Buffer) against a base64 Ed25519 signature with the trusted public keys (PEM, SPKI). */
function verifySignature(bytes, signatureB64, publicKeys) {
  const sig = Buffer.from(String(signatureB64 || '').trim(), 'base64');
  if (sig.length !== 64) return { ok: false, why: 'the release signature is missing or malformed' };
  for (const pem of publicKeys) {
    try { if (crypto.verify(null, bytes, crypto.createPublicKey(pem), sig)) return { ok: true }; } catch { /* next key */ }
  }
  return { ok: false, why: 'the release signature does not verify against LAIN\'s release key' };
}

/** Parse and validate; returns { ok, manifest } or { ok: false, why }. Nothing here trusts the content yet. */
function parse(bytes) {
  let m;
  try { m = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)); } catch { return { ok: false, why: 'the release manifest is not JSON' }; }
  if (!m || m.schema !== 1 || !['lain', 'noema'].includes(m.product)) return { ok: false, why: 'not a LAIN release manifest (schema 1)' };
  if (!CHANNELS.includes(m.channel)) return { ok: false, why: `unknown channel "${m.channel}"` };
  if (!parseVersion(m.version)) return { ok: false, why: `"${m.version}" is not a version` };
  if (m.minimumCompatible && !parseVersion(m.minimumCompatible)) return { ok: false, why: 'minimumCompatible is not a version' };
  if (!Array.isArray(m.assets) || !m.assets.length) return { ok: false, why: 'the release names no assets' };
  for (const a of m.assets) {
    if (!a || typeof a.url !== 'string' || !/^[0-9a-f]{64}$/i.test(String(a.sha256 || ''))) return { ok: false, why: 'an asset has no URL or SHA-256' };
    if (!/^(https:|http:\/\/127\.0\.0\.1[:/]|http:\/\/localhost[:/]|file:)/i.test(a.url) && !/^[\w.-]+$/.test(a.url)) return { ok: false, why: 'an asset URL is neither HTTPS, loopback, a file, nor relative' };
  }
  return { ok: true, manifest: m };
}

/** The asset for this machine: the app package for this architecture. */
function assetFor(m, arch = process.arch === 'arm64' ? 'arm64' : 'x64') {
  return (m.assets || []).find((a) => (a.kind || 'app') === 'app' && (a.arch || 'x64') === arch) || null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    require('fs').createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

module.exports = { CHANNELS, parseVersion, compare, verifySignature, parse, assetFor, sha256File };
