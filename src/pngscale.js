'use strict';

/**
 * A CAPTURE IS DOWNSCALED TO WHAT THE MODEL NEEDS (S12b): long side ≤ 1280 by default. A desktop capture is read by a
 * model as an image; a 2560×1440 frame costs four times the bytes (and image tokens) of a 1280×720 one and shows it
 * nothing a model acts on. Pure Node (zlib), no dependency: 8-bit PNG, non-interlaced — what PrintWindow and Windows
 * Graphics Capture write. Anything else is left as it was and said so.
 */

const fs = require('fs');
const zlib = require('zlib');

const DEFAULT_MAX_SIDE = 1280;
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

let CRC = null;
function crc32(buf) {
  if (!CRC) { CRC = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; } }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function paeth(a, b, c) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }

/** PNG bytes → { width, height, rgba } (8-bit RGBA), or null when the form is not one this reads. */
function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) return null;
  let off = 8; let w = 0; let h = 0; let depth = 0; let type = 0; let interlace = 0; let plte = null; let trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off); const name = buf.toString('latin1', off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len);
    if (name === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (name === 'PLTE') plte = data;
    else if (name === 'tRNS') trns = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    off += 12 + len;
  }
  const ch = CHANNELS[type];
  if (!w || !h || depth !== 8 || !ch || interlace !== 0 || (type === 3 && !plte)) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = w * ch;
  if (raw.length < h * (stride + 1)) return null;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const src = y * (stride + 1) + 1; const dst = y * stride; const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0; const b = y ? px[up + x] : 0; const c = y && x >= ch ? px[up + x - ch] : 0;
      const v = raw[src + x];
      px[dst + x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : f === 4 ? v + paeth(a, b, c) : v) & 0xff;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const s = i * ch;
    if (type === 6) { rgba[j] = px[s]; rgba[j + 1] = px[s + 1]; rgba[j + 2] = px[s + 2]; rgba[j + 3] = px[s + 3]; }
    else if (type === 2) { rgba[j] = px[s]; rgba[j + 1] = px[s + 1]; rgba[j + 2] = px[s + 2]; rgba[j + 3] = 255; }
    else if (type === 0) { rgba[j] = rgba[j + 1] = rgba[j + 2] = px[s]; rgba[j + 3] = 255; }
    else if (type === 4) { rgba[j] = rgba[j + 1] = rgba[j + 2] = px[s]; rgba[j + 3] = px[s + 1]; }
    else { const k = px[s]; rgba[j] = plte[k * 3]; rgba[j + 1] = plte[k * 3 + 1]; rgba[j + 2] = plte[k * 3 + 2]; rgba[j + 3] = trns && k < trns.length ? trns[k] : 255; }
  }
  return { width: w, height: h, rgba };
}

/** Area-average downscale of RGBA to (W, H). */
function resize({ width: w, height: h, rgba }, W, H) {
  const out = Buffer.alloc(W * H * 4);
  for (let Y = 0; Y < H; Y++) {
    const y0 = Math.floor((Y * h) / H); const y1 = Math.max(y0 + 1, Math.floor(((Y + 1) * h) / H));
    for (let X = 0; X < W; X++) {
      const x0 = Math.floor((X * w) / W); const x1 = Math.max(x0 + 1, Math.floor(((X + 1) * w) / W));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0, i = (y * w + x0) * 4; x < x1; x++, i += 4) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]; n += 1; }
      const o = (Y * W + X) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return { width: W, height: H, rgba: out };
}

function chunk(name, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(name, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA → PNG bytes: RGB when fully opaque; per-row the filter with the smallest sum (the usual heuristic). */
function encode({ width: w, height: h, rgba }) {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const ch = opaque ? 3 : 4; const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  for (let i = 0, j = 0; i < w * h; i++) { px[j++] = rgba[i * 4]; px[j++] = rgba[i * 4 + 1]; px[j++] = rgba[i * 4 + 2]; if (!opaque) px[j++] = rgba[i * 4 + 3]; }
  const raw = Buffer.alloc(h * (stride + 1)); const row = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const cur = y * stride; const up = cur - stride;
    let best = 0; let bestSum = Infinity;
    for (let f = 0; f <= 4; f++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? px[cur + x - ch] : 0; const b = y ? px[up + x] : 0; const c = y && x >= ch ? px[up + x - ch] : 0;
        const v = (px[cur + x] - (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? ((a + b) >> 1) : paeth(a, b, c))) & 0xff;
        row[x] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * (stride + 1)] = best;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[cur + x - ch] : 0; const b = y ? px[up + x] : 0; const c = y && x >= ch ? px[up + x - ch] : 0;
      raw[y * (stride + 1) + 1 + x] = (px[cur + x] - (best === 0 ? 0 : best === 1 ? a : best === 2 ? b : best === 3 ? ((a + b) >> 1) : paeth(a, b, c))) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Downscale the PNG at `file` in place when its long side is over `maxSide`. Returns what happened:
 * { width, height, outWidth, outHeight, scale, before, after, scaled, note? } — `scale` maps image to screen: screen = origin + px / scale.
 */
function fit(file, { maxSide = DEFAULT_MAX_SIDE } = {}) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return { scaled: false, note: `could not read the capture (${e.code || e.message})` }; }
  const img = decode(buf);
  if (!img) return { scaled: false, before: buf.length, after: buf.length, scale: 1, note: 'not an 8-bit PNG this can scale — kept as captured' };
  const long = Math.max(img.width, img.height);
  if (long <= maxSide) return { scaled: false, width: img.width, height: img.height, outWidth: img.width, outHeight: img.height, scale: 1, before: buf.length, after: buf.length };
  const scale = maxSide / long;
  const W = Math.max(1, Math.round(img.width * scale)); const H = Math.max(1, Math.round(img.height * scale));
  const out = encode(resize(img, W, H));
  try { fs.writeFileSync(file, out); } catch (e) { return { scaled: false, before: buf.length, after: buf.length, scale: 1, note: `could not write the scaled capture (${e.code || e.message})` }; }
  return { scaled: true, width: img.width, height: img.height, outWidth: W, outHeight: H, scale: +(W / img.width).toFixed(4), before: buf.length, after: out.length };
}

module.exports = { fit, decode, encode, resize, DEFAULT_MAX_SIDE };
