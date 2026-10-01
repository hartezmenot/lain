'use strict';

/**
 * READ A ZIP (a .vsix is one) — entries out of the central directory, stored
 * or deflated, nothing else. LAIN has no runtime dependencies, and a .vsix
 * needs exactly this much of the format.
 *
 * AN ARCHIVE IS UNTRUSTED INPUT, so every limit is checked before any byte is
 * written: an entry name that would land outside the target ("../", an
 * absolute path, a drive letter) is refused, as are more than MAX_ENTRIES
 * entries or more than MAX_TOTAL bytes once inflated (a zip bomb inflates to
 * gigabytes from kilobytes). Encrypted and zip64 archives are refused, not
 * guessed at.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_ENTRIES = 20000;
const MAX_TOTAL = 400 * 1024 * 1024;
const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

function fail(why) { const e = new Error(why); e.zip = true; throw e; }

/** The central directory: [{name, method, size, csize, offset, dir}]. */
function entries(buf) {
  const min = Math.max(0, buf.length - 65557);
  let e = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD) { e = i; break; }
  if (e < 0) fail('not a zip archive');
  const count = buf.readUInt16LE(e + 10);
  const cdOffset = buf.readUInt32LE(e + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) fail('zip64 archives are not supported');
  if (count > MAX_ENTRIES) fail(`more than ${MAX_ENTRIES} entries`);
  const out = [];
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) fail('the archive directory is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    if (flags & 1) fail('encrypted archives are not supported');
    out.push({ name, method, size, csize, offset, dir: name.endsWith('/') });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** One entry's bytes. */
function read(buf, ent) {
  const p = ent.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC) fail(`damaged entry ${ent.name}`);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const raw = buf.slice(start, start + ent.csize);
  if (ent.method === 0) return raw;
  if (ent.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, ent.size) + 1024 });
  return fail(`entry ${ent.name} uses compression method ${ent.method}, which is not supported`);
}

/** A safe relative path under the target, or null. */
function safe(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.includes('\0')) return null;
  const norm = path.posix.normalize(n);
  if (norm.startsWith('../') || norm === '..' || norm.includes('/../')) return null;
  return norm;
}

/**
 * Extract the entries under `prefix` (e.g. "extension/") into `dest`, prefix
 * removed. Returns the files written.
 */
function extract(file, dest, { prefix = '' } = {}) {
  const buf = fs.readFileSync(file);
  const list = entries(buf);
  let total = 0;
  for (const e of list) {
    total += e.size;
    if (total > MAX_TOTAL) fail(`the archive inflates past ${Math.round(MAX_TOTAL / 1048576)} MB`);
    if (!safe(e.name)) fail(`entry "${e.name}" would land outside the install folder`);
  }
  const written = [];
  for (const e of list) {
    if (e.dir || !e.name.startsWith(prefix)) continue;
    const rel = safe(e.name.slice(prefix.length));
    if (!rel) continue;
    const to = path.join(dest, ...rel.split('/'));
    if (!path.resolve(to).startsWith(path.resolve(dest) + path.sep)) fail(`entry "${e.name}" would land outside the install folder`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, read(buf, e));
    written.push(rel);
  }
  return written;
}

/** One file's text from the archive, or null. */
function text(file, name) {
  const buf = fs.readFileSync(file);
  const e = entries(buf).find((x) => x.name === name);
  return e ? read(buf, e).toString('utf8') : null;
}

module.exports = { entries, extract, text, safe, MAX_ENTRIES, MAX_TOTAL };
