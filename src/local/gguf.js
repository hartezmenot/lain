'use strict';

/**
 * GGUF METADATA — the header of a .gguf file, read without loading the model.
 *
 *     magic "GGUF" · version · tensor count · kv count · kv pairs · tensors…
 *
 * Only the key/value header is read, sequentially, in small chunks. Large
 * arrays (the tokenizer's vocabulary is ~150,000 strings) are SKIPPED — their
 * element lengths are read to step over them and nothing is kept but the count.
 * Reading stops at the end of the header; a 30 GB model costs a few megabytes
 * of reads and no RAM to speak of. Nothing here writes, copies or maps a file.
 *
 * WHAT IS REPORTED is what the header states. `quantization` comes from
 * `general.file_type` when present; otherwise from the file name, and then it
 * says so (`quantSource: 'file name'`). An absent key is absent — never a guess.
 */

const fs = require('fs');

const T = Object.freeze({ U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12 });
const SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/** llama.cpp's LLAMA_FTYPE values — what general.file_type means. */
const FTYPE = Object.freeze({
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1', 10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M',
  13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS',
  21: 'Q2_K_S', 22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M', 28: 'IQ2_S',
  29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16', 36: 'TQ1_0', 37: 'TQ2_0', 38: 'MXFP4',
});

const QUANT_IN_NAME = /(?:^|[-_.])((?:I?Q\d(?:_[0-9A-Z]+)*)|F16|F32|BF16|MXFP4)(?=$|[-_.])/i;

const MAX_HEADER_BYTES = 128 * 1024 * 1024;
const CHUNK = 1 << 20;

class Reader {
  constructor(fd) { this.fd = fd; this.buf = Buffer.alloc(0); this.pos = 0; this.filePos = 0; this.total = 0; }
  need(n) {
    while (this.buf.length - this.pos < n) {
      const chunk = Buffer.alloc(Math.max(CHUNK, n));
      const got = fs.readSync(this.fd, chunk, 0, chunk.length, this.filePos);
      if (got <= 0) throw new Error('unexpected end of file in the GGUF header');
      this.filePos += got;
      this.total += got;
      if (this.total > MAX_HEADER_BYTES) throw new Error('GGUF header larger than Noema reads');
      this.buf = Buffer.concat([this.buf.subarray(this.pos), chunk.subarray(0, got)]);
      this.pos = 0;
    }
  }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  u64() { this.need(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return Number(v); }
  skip(n) { this.need(n); this.pos += n; }
  str() { const n = this.u64(); if (n > 64 * 1024 * 1024) throw new Error('GGUF string too long'); this.need(n); const s = this.buf.toString('utf8', this.pos, this.pos + n); this.pos += n; return s; }
  scalar(t) {
    this.need(SIZE[t]);
    const b = this.buf; const p = this.pos; this.pos += SIZE[t];
    switch (t) {
      case T.U8: return b.readUInt8(p); case T.I8: return b.readInt8(p);
      case T.U16: return b.readUInt16LE(p); case T.I16: return b.readInt16LE(p);
      case T.U32: return b.readUInt32LE(p); case T.I32: return b.readInt32LE(p);
      case T.F32: return b.readFloatLE(p); case T.BOOL: return b.readUInt8(p) !== 0;
      case T.U64: return Number(b.readBigUInt64LE(p)); case T.I64: return Number(b.readBigInt64LE(p));
      case T.F64: return b.readDoubleLE(p);
      default: throw new Error(`unknown GGUF type ${t}`);
    }
  }
}

/** Keys whose values are kept even when they are arrays (short ones only). */
const KEEP_ARRAY_MAX = 16;

/**
 * READ THE HEADER. Returns { ok, version, tensors, kv: {key: value}, arrays: {key: count} }
 * or { ok: false, why }. Arrays longer than KEEP_ARRAY_MAX keep only their count.
 */
function readHeader(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return { ok: false, why: e.message }; }
  try {
    const r = new Reader(fd);
    r.need(4);
    const magic = r.buf.toString('latin1', 0, 4); r.pos = 4;
    if (magic !== 'GGUF') return { ok: false, why: 'not a GGUF file' };
    const version = r.u32();
    if (version < 2 || version > 3) return { ok: false, why: `GGUF version ${version} is not one Noema reads` };
    const tensors = r.u64();
    const kvCount = r.u64();
    if (kvCount > 100000) return { ok: false, why: 'implausible GGUF key count' };
    const kv = {}; const arrays = {};
    for (let i = 0; i < kvCount; i++) {
      const key = r.str();
      const type = r.u32();
      if (type === T.STRING) { const s = r.str(); kv[key] = s.length > 4096 ? { chars: s.length, head: s.slice(0, 200) } : s; continue; }
      if (type === T.ARRAY) {
        const et = r.u32(); const n = r.u64();
        arrays[key] = n;
        const keep = n <= KEEP_ARRAY_MAX ? [] : null;
        for (let j = 0; j < n; j++) {
          if (et === T.STRING) { const s = r.str(); if (keep) keep.push(s); } else if (SIZE[et]) { if (keep) keep.push(r.scalar(et)); else r.skip(SIZE[et]); } else throw new Error(`nested GGUF array type ${et}`);
        }
        if (keep) kv[key] = keep;
        continue;
      }
      if (!SIZE[type]) throw new Error(`unknown GGUF value type ${type}`);
      kv[key] = r.scalar(type);
    }
    return { ok: true, version, tensors, kv, arrays, headerBytes: r.filePos - (r.buf.length - r.pos) };
  } catch (e) {
    return { ok: false, why: e.message };
  } finally { try { fs.closeSync(fd); } catch { /* closed */ } }
}

/** The quantization the header states, else the one the file name states (and says so). */
function quantization(kv, fileName) {
  if (kv && Number.isInteger(kv['general.file_type']) && FTYPE[kv['general.file_type']]) return { value: FTYPE[kv['general.file_type']], source: 'metadata' };
  const m = QUANT_IN_NAME.exec(String(fileName || '').replace(/\.gguf$/i, ''));
  return m ? { value: m[1].toUpperCase(), source: 'file name' } : { value: null, source: null };
}

/** Architectures whose name says they read images once a projector is attached. */
const VISION_ARCH = /(?:vl|llava|gemma3|mllama|pixtral|minicpmv|idefics|smolvlm|internvl|glm4v|kimivl|mistral3)/i;

/**
 * SUMMARISE for a person and for pairing. Every field is from the header or is
 * null; `kind` is 'text' (llama.cpp can serve it), 'projector' (an mmproj) or
 * 'other' (a GGUF that is not a text model — e.g. a diffusion model).
 */
function summarize(file, header, stat = null) {
  const path = require('path');
  const name = path.basename(file);
  if (!header || !header.ok) return { file, name, ok: false, why: header ? header.why : 'unreadable', sizeBytes: stat ? stat.size : null };
  const kv = header.kv;
  const arch = typeof kv['general.architecture'] === 'string' ? kv['general.architecture'] : null;
  const a = (k) => (arch && kv[`${arch}.${k}`] !== undefined ? kv[`${arch}.${k}`] : null);
  const isProjector = kv['general.type'] === 'mmproj' || arch === 'clip';
  const hasTokenizer = typeof kv['tokenizer.ggml.model'] === 'string';
  const kind = isProjector ? 'projector' : hasTokenizer ? 'text' : 'other';
  const q = quantization(kv, name);
  const tmpl = kv['tokenizer.chat_template'];
  const out = {
    file, name, ok: true, kind,
    sizeBytes: stat ? stat.size : null,
    modifiedAt: stat ? stat.mtimeMs : null,
    ggufVersion: header.version,
    tensors: header.tensors,
    modelName: typeof kv['general.name'] === 'string' ? kv['general.name'] : null,
    basename: typeof kv['general.basename'] === 'string' ? kv['general.basename'] : null,
    architecture: arch,
    sizeLabel: typeof kv['general.size_label'] === 'string' ? kv['general.size_label'] : null,
    finetune: typeof kv['general.finetune'] === 'string' ? kv['general.finetune'] : null,
    quantization: q.value, quantSource: q.source,
    contextLength: kind === 'text' ? a('context_length') : null,
    embeddingLength: kind === 'text' ? a('embedding_length') : null,
    blockCount: kind === 'text' ? a('block_count') : null,
    headCountKv: kind === 'text' ? a('attention.head_count_kv') : null,
    keyLength: kind === 'text' ? a('attention.key_length') : null,
    valueLength: kind === 'text' ? a('attention.value_length') : null,
    tokenizer: hasTokenizer ? kv['tokenizer.ggml.model'] : null,
    vocabSize: header.arrays['tokenizer.ggml.tokens'] || null,
    chatTemplate: tmpl ? { present: true, chars: typeof tmpl === 'string' ? tmpl.length : tmpl.chars } : { present: false },
    visionArch: kind === 'text' && Boolean(arch && VISION_ARCH.test(arch)),
  };
  if (isProjector) {
    out.projector = {
      type: kv['clip.projector_type'] || null,
      hasVision: kv['clip.has_vision_encoder'] === true || kv['clip.has_vision_encoder'] === undefined ? Boolean(kv['clip.has_vision_encoder'] !== false) : false,
      hasAudio: kv['clip.has_audio_encoder'] === true,
      projectionDim: kv['clip.vision.projection_dim'] || kv['clip.audio.projection_dim'] || null,
    };
  }
  return out;
}

function inspect(file) {
  let stat = null;
  try { stat = fs.statSync(file); } catch (e) { return { file, ok: false, why: e.message }; }
  return summarize(file, readHeader(file), stat);
}

module.exports = { readHeader, summarize, inspect, quantization, FTYPE, T };
