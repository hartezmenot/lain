'use strict';

/**
 * A GGUF WRITER FOR TESTS — just enough to produce real GGUF headers (v3) with
 * the keys LAIN reads, a long tokenizer array to skip, and a few bytes of
 * "tensor data" after. Nothing here is a model; it is a header on a small file.
 */

const fs = require('fs');

const T = { U32: 4, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10 };

function str(s) { const b = Buffer.from(String(s), 'utf8'); const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(b.length)); return Buffer.concat([n, b]); }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
function u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }

function value(v) {
  if (typeof v === 'string') return Buffer.concat([u32(T.STRING), str(v)]);
  if (typeof v === 'boolean') return Buffer.concat([u32(T.BOOL), Buffer.from([v ? 1 : 0])]);
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'string')) return Buffer.concat([u32(T.ARRAY), u32(T.STRING), u64(v.length), ...v.map(str)]);
    return Buffer.concat([u32(T.ARRAY), u32(T.U32), u64(v.length), ...v.map(u32)]);
  }
  if (Number.isInteger(v)) return Buffer.concat([u32(T.U32), u32(v)]);
  const b = Buffer.alloc(4); b.writeFloatLE(v); return Buffer.concat([u32(T.F32), b]);
}

/** Write a GGUF file with `kv` (and optionally `padBytes` of body). */
function write(file, kv, { tensors = 1, padBytes = 64 } = {}) {
  const entries = Object.entries(kv);
  const parts = [Buffer.from('GGUF', 'latin1'), u32(3), u64(tensors), u64(entries.length)];
  for (const [k, v] of entries) { parts.push(str(k)); parts.push(value(v)); }
  parts.push(Buffer.alloc(padBytes));
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

/** A text model's header, with a vocabulary large enough to be skipped rather than kept. */
function textModel(file, { arch = 'qwen3vl', name = 'Test Model', basename = null, ftype = 15, ctx = 32768, width = 2560, blocks = 36, vocab = 2000, template = true } = {}) {
  const kv = {
    'general.architecture': arch, 'general.type': 'model', 'general.name': name, 'general.size_label': '4B',
    [`${arch}.context_length`]: ctx, [`${arch}.embedding_length`]: width, [`${arch}.block_count`]: blocks,
    'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.tokens': Array.from({ length: vocab }, (_, i) => `tok${i}`),
    'general.file_type': ftype,
  };
  if (basename) kv['general.basename'] = basename;
  if (template) kv['tokenizer.chat_template'] = '{% for m in messages %}{{ m.content }}{% endfor %}';
  return write(file, kv);
}

function projector(file, { basename = 'qwen3vl', width = 2560 } = {}) {
  return write(file, { 'general.architecture': 'clip', 'general.type': 'mmproj', 'general.basename': basename, 'clip.has_vision_encoder': true, 'clip.vision.projection_dim': width, 'clip.projector_type': 'qwen3vl_merger', 'general.file_type': 7 });
}

/** A GGUF that is not a text model (no tokenizer) — e.g. a diffusion model. */
function other(file) { return write(file, { 'general.alignment': 32 }); }

module.exports = { write, textModel, projector, other };
