'use strict';

/** THE UPDATE MANIFEST — what a release says about itself, and how LAIN decides to believe it. */

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
  // ANTI-REPLAY (2026-10-07): every signed manifest carries a sequence (increasing per release) and a validity window.
  if (!Number.isInteger(m.sequence) || m.sequence < 1) return { ok: false, why: 'the release manifest has no sequence number' };
  for (const k of ['issued_at', 'expires_at']) if (!m[k] || !Number.isFinite(Date.parse(m[k]))) return { ok: false, why: `the release manifest has no valid ${k}` };
  if (Date.parse(m.expires_at) <= Date.parse(m.issued_at)) return { ok: false, why: 'the release manifest expires before it was issued' };
  return { ok: true, manifest: m };
}

/**
 * IS THIS SIGNED MANIFEST STILL ONE TO BELIEVE? A valid signature is not enough: an older signed manifest (a lower
 * sequence than one already accepted) is a replay; an expired one is stale; one issued in the future is a wrong clock.
 */
function fresh(m, { now = Date.now(), highest = 0 } = {}) {
  if (m.sequence < highest) return { ok: false, why: `an older release manifest (sequence ${m.sequence}, LAIN has accepted ${highest}) — refused as a replay` };
  if (Date.parse(m.expires_at) < now) return { ok: false, why: `the release manifest expired on ${m.expires_at} — refused` };
  if (Date.parse(m.issued_at) > now + 24 * 3600 * 1000) return { ok: false, why: `the release manifest is dated in the future (${m.issued_at}) — check this PC's clock` };
  return { ok: true };
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

module.exports = { CHANNELS, parseVersion, compare, verifySignature, parse, fresh, assetFor, sha256File };
