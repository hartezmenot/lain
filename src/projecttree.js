'use strict';

/**
 * A PROJECT AS A TREE, AND WHETHER IT HAS A CAPABILITY (split from compare.js in S9, when /compare moved to tools/dev):
 * `scanDir` walks a folder into `{ files, read(rel) }`; `detect` answers from paths and, where a capability lives inside
 * a shared file, from content. Used by /health, the audit and troubleshooting.
 */

const fs = require('fs');
const path = require('path');

const MAX_FILES = 6000;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 2_000_000;
/** Content is only read for files that could plausibly carry a signal. */
const READABLE = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|json|md)$/i;
const SKIP_DIR = /^(?:node_modules|\.git|dist|build|out|target|vendor|__pycache__|\.venv|venv|coverage|\.next|\.cache|\.idea|\.vscode)$/i;

/** Walk a directory into `{ files: [rel], read(rel) }`. */
function scanDir(root) {
  const files = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && files.length < MAX_FILES) {
    const { dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP_DIR.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) stack.push({ dir: abs, depth: depth + 1 });
      else if (e.isFile()) files.push(path.relative(root, abs).replace(/\\/g, '/'));
      if (files.length >= MAX_FILES) break;
    }
  }
  const cache = new Map();
  return {
    kind: 'folder', label: root, files,
    read(rel) {
      if (cache.has(rel)) return cache.get(rel);
      let out = '';
      try {
        const abs = path.join(root, rel);
        if (fs.statSync(abs).size <= MAX_FILE_BYTES) out = fs.readFileSync(abs, 'utf8');
      } catch { out = ''; }
      cache.set(rel, out);
      return out;
    },
  };
}

/** Does this tree have this capability, and what is the evidence? */
async function detect(tree, cap) {
  const hits = cap.paths ? tree.files.filter((f) => cap.paths.some((re) => re.test(f))) : [];
  if (!hits.length) return { present: false, where: [] };
  if (!cap.content) return { present: true, where: hits.slice(0, 3) };
  const where = [];
  for (const f of hits.slice(0, 40)) {
    if (!READABLE.test(f)) continue;
    const body = await tree.read(f);
    if (!body) continue;
    if (cap.content.some((re) => re.test(body))) where.push(f);
    if (where.length >= 3) break;
  }
  return { present: where.length > 0, where };
}

module.exports = { scanDir, detect, MAX_FILES, MAX_DEPTH, MAX_FILE_BYTES, READABLE, SKIP_DIR };
