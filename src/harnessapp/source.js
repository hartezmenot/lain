'use strict';

/**
 * THE SOURCE WORKSPACE'S BACK HALF — the tree, the file, the save.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT A SECOND FILESYSTEM AUTHORITY, AND THAT IS THE WHOLE DESIGN.
 *
 * The blueprint says it in as many words: the Source UI owns PRESENTATION AND
 * EDIT INTENT; Core/Harness owns the actual read, write and trust. So this
 * module resolves paths through `tools/fs.js` (the one resolver), refuses
 * anything outside the workspace, and applies the SAME truncation guard a model
 * write goes through — because a person dragging a selection over a 30KB file
 * and hitting save is the identical accident, and the guard does not care who
 * caused it.
 *
 * What it adds is the things an EDITOR needs and a tool call does not: a tree
 * to navigate, the modification time so a stale buffer can be noticed, and the
 * knowledge that a file is one this session has already changed.
 *
 * ------------------------------------------------------------------------
 * A SAVE IS CONDITIONAL ON WHAT WAS READ.
 *
 * Every open carries the file's `mtime` and size, and every save sends them
 * back. If the file on disk has moved on — LAIN edited it, a build wrote it,
 * git checked something out — the save is REFUSED and the caller is told, with
 * the current bytes, so a person can look before deciding.
 *
 * This is the one interaction where a Harness editor could destroy work that a
 * model just did, and the ordinary last-write-wins would do it silently and
 * often: the entire point of the product is that LAIN is editing these files at
 * the same time as the person is looking at them.
 *
 * ------------------------------------------------------------------------
 * BOUNDED, because it is served over HTTP to a page. A file bigger than
 * MAX_FILE_BYTES is reported as too large rather than streamed into a browser
 * that will hang trying to syntax-highlight it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fstools = require('../tools/fs');

/**
 * THE IDENTITY OF A FILE'S CONTENTS — the save token.
 *
 * ---- WHY NOT `mtimeMs`, WHICH IS WHAT THIS USED TO BE -----------------
 *
 * Two writes inside the same millisecond produce the IDENTICAL mtime. Measured
 * on this machine:
 *
 *     write .a{opacity:0.2}  -> mtimeMs 1789025279604.5515
 *     write .a{opacity:0.9}  -> mtimeMs 1789025279604.5515   (unchanged)
 *
 * So the conditional save FAILED OPEN exactly where it mattered: LAIN edits a
 * file, the person hits save a moment later, the mtimes match, the guard is
 * satisfied and the model's work is overwritten silently. Not a rare race —
 * LAIN writes fast, and saving straight afterwards is the normal thing to do.
 *
 * A hash of the bytes has no resolution to run out of. It costs a few
 * microseconds on files this editor will open at all (2MB ceiling), and it
 * answers the actual question — "is this still the file I read?" — rather than
 * a proxy for it.
 */
function digest(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 32);
}

/** What an editor can usefully hold. Past this it is a data file, not source. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Images the editor previews rather than edits, by extension. */
const IMAGE_MIME = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
});
/** An image larger than this is described, not sent. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** How many entries one directory listing returns. A tree, not an index. */
const MAX_ENTRIES = 800;

/**
 * DIRECTORIES A SOURCE TREE SHOULD NOT OFFER TO OPEN.
 *
 * Not a security boundary — `inside()` is that. This is about usefulness: a
 * tree whose first expansion is 40,000 files of `node_modules` is a tree
 * nobody can navigate, and the person is looking for their own code.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'coverage', '.cache',
  '.lain', '.noema', '.lain-probe', 'vendor', '.gradle', '.idea',
]);

/**
 * EXTENSIONS KNOWN TO BE TEXT — kept for callers that ask cheaply by name
 * (the Workshop's source correlation). It is NO LONGER THE GATE for opening a
 * file: that allowlist was the root cause of "several files cannot be opened"
 * — a Dockerfile, a Makefile, a .log, a .xml, a .cc was refused before its
 * bytes were ever looked at. Opening now decides from the CONTENT (`classify`).
 */
const TEXT_EXT = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.json', '.jsonc', '.md', '.markdown', '.mdx',
  '.py', '.rs', '.go', '.rb', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.sql', '.graphql', '.vue', '.svelte', '.txt', '.gitignore', '.editorconfig',
]);

/**
 * EXTENSIONS THAT ARE CERTAINLY NOT TEXT. Used only to label a tree row before
 * anything is read; `open` still decides from the bytes.
 */
const BINARY_EXT = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a', '.lib', '.pdb', '.class', '.jar', '.war',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.iso', '.dmg', '.msi', '.cab',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.mp3', '.mp4', '.wav', '.flac', '.ogg', '.mov', '.avi', '.mkv', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.psd', '.sqlite', '.db', '.pyc', '.node', '.wasm', '.blend',
]);

/**
 * THE EDITOR MODE — the language id the IDE's editor (Monaco) understands,
 * by extension and by well-known file name. Unknown is `plaintext`, never a
 * refusal: an unknown extension is an unknown grammar, not an unreadable file.
 */
const MODE_BY_EXT = Object.freeze({
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.json': 'json', '.jsonc': 'json', '.json5': 'json', '.webmanifest': 'json',
  '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'less',
  '.html': 'html', '.htm': 'html', '.xhtml': 'html', '.vue': 'html', '.svelte': 'html', '.hbs': 'handlebars',
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
  '.py': 'python', '.pyw': 'python', '.pyi': 'python',
  '.rs': 'rust', '.go': 'go', '.rb': 'ruby', '.php': 'php', '.lua': 'lua', '.pl': 'perl', '.pm': 'perl', '.r': 'r',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.groovy': 'java', '.gradle': 'java', '.dart': 'dart', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hh': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.ino': 'cpp',
  '.m': 'objective-c', '.mm': 'objective-c',
  '.cs': 'csharp', '.csx': 'csharp', '.fs': 'fsharp', '.fsx': 'fsharp', '.vb': 'vb', '.csproj': 'xml', '.sln': 'plaintext',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell', '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell',
  '.bat': 'bat', '.cmd': 'bat',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.properties': 'ini', '.env': 'ini',
  '.xml': 'xml', '.xsd': 'xml', '.xsl': 'xml', '.svg': 'xml', '.plist': 'xml', '.config': 'xml', '.resx': 'xml', '.props': 'xml', '.targets': 'xml',
  '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql', '.proto': 'protobuf', '.tf': 'hcl', '.hcl': 'hcl', '.sol': 'sol',
  '.dockerfile': 'dockerfile', '.jl': 'julia', '.ex': 'elixir', '.exs': 'elixir', '.clj': 'clojure', '.coffee': 'coffeescript',
  '.log': 'plaintext', '.txt': 'plaintext', '.csv': 'plaintext', '.tsv': 'plaintext',
});
const MODE_BY_NAME = Object.freeze({
  dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'plaintext', gnumakefile: 'plaintext',
  '.gitignore': 'plaintext', '.gitattributes': 'plaintext', '.editorconfig': 'ini', '.npmrc': 'ini',
  '.env': 'ini', '.prettierrc': 'json', '.eslintrc': 'json', '.babelrc': 'json', 'cmakelists.txt': 'plaintext',
  gemfile: 'ruby', rakefile: 'ruby', jenkinsfile: 'java', 'go.mod': 'go', 'go.sum': 'plaintext',
});
function mode(rel) {
  const base = path.basename(String(rel || '')).toLowerCase();
  if (MODE_BY_NAME[base]) return MODE_BY_NAME[base];
  if (base.startsWith('.env')) return 'ini';
  if (base.startsWith('dockerfile')) return 'dockerfile';
  return MODE_BY_EXT[path.extname(base)] || 'plaintext';
}

/**
 * WHAT THESE BYTES ARE, AND HOW TO TURN THEM INTO TEXT AND BACK.
 *
 * The byte-order mark decides first (UTF-8, UTF-16 LE/BE — a UTF-16 file is
 * full of NUL bytes and was refused as "binary" before); then a NUL in the
 * first block means binary; then strict UTF-8 is tried, and a file that is
 * not valid UTF-8 is read as Latin-1 rather than mangled with replacement
 * characters that a save would write back.
 *
 * @returns {{binary:true} | {binary:false, text:string, encoding:string, eol:'CRLF'|'LF'}}
 */
function classify(buf) {
  let encoding = 'utf8';
  let text;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    encoding = 'utf8bom'; text = buf.subarray(3).toString('utf8');
  } else if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    encoding = 'utf16le'; text = buf.subarray(2).toString('utf16le');
  } else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    encoding = 'utf16be';
    const swapped = Buffer.from(buf.subarray(2));
    if (swapped.length % 2) swapped.writeUInt8(0, swapped.length - 1);
    swapped.swap16();
    text = swapped.toString('utf16le');
  } else {
    const n = Math.min(buf.length, 8192);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return { binary: true };
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { encoding = 'latin1'; text = buf.toString('latin1'); }
  }
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return { binary: false, text, encoding, eol: crlf > lf ? 'CRLF' : 'LF' };
}

/** Text back to the bytes it came from, in the encoding it was read in. */
function encode(text, encoding) {
  const t = String(text);
  if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(t, 'utf8')]);
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(t, 'utf16le')]);
  if (encoding === 'utf16be') { const b = Buffer.from(t, 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xFE, 0xFF]), b]); }
  if (encoding === 'latin1') return Buffer.from(t, 'latin1');
  return Buffer.from(t, 'utf8');
}

/** The text of a file, decoded the way `open` decodes it ('' when unreadable). */
function readText(abs) {
  try { const c = classify(fs.readFileSync(abs)); return c.binary ? '' : c.text; } catch { return ''; }
}

/** What a highlighter should treat this as. One name, decided once, server-side. */
function language(rel) {
  const e = path.extname(String(rel || '')).toLowerCase();
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(e)) return 'js';
  if (['.ts', '.tsx'].includes(e)) return 'ts';
  if (['.css', '.scss', '.sass', '.less'].includes(e)) return 'css';
  if (['.html', '.htm', '.vue', '.svelte'].includes(e)) return 'html';
  if (['.json', '.jsonc'].includes(e)) return 'json';
  if (['.md', '.markdown', '.mdx'].includes(e)) return 'md';
  if (e === '.py') return 'py';
  if (e === '.rs') return 'rs';
  if (['.yml', '.yaml'].includes(e)) return 'yaml';
  if (['.sh', '.bash', '.zsh'].includes(e)) return 'sh';
  return 'text';
}

function isText(name) {
  const e = path.extname(name).toLowerCase();
  return TEXT_EXT.has(e) || TEXT_EXT.has(name.toLowerCase());
}

/**
 * HOW A TREE ROW SHOULD OPEN, from the name alone: an image previews, a known
 * binary format says so, and EVERYTHING ELSE is offered to the editor, which
 * reads the bytes before deciding.
 */
function kindOf(name) {
  const e = path.extname(name).toLowerCase();
  if (IMAGE_MIME[e]) return 'image';
  if (BINARY_EXT.has(e)) return 'binary';
  return 'text';
}

/** Names a tree never shows: version-control internals and LAIN's own index. */
const HIDDEN = new Set(['.git', '.hg', '.svn', '.lain', '.noema', '.lain-probe', '.ds_store', 'thumbs.db']);

/**
 * IS THIS PATH INSIDE THE WORKSPACE? The security boundary, checked on every
 * call rather than once at the edge.
 *
 * `path.relative` rather than a `startsWith` on strings: `/proj` and
 * `/project-two` share a prefix and are not the same tree, and that is exactly
 * the mistake a string comparison makes.
 */
function inside(cwd, abs) {
  const r = path.relative(path.resolve(cwd), path.resolve(abs));
  // AN EMPTY RESULT IS THE ROOT ITSELF, AND THE ROOT IS INSIDE. Requiring a
  // non-empty relative path refused the project directory — so the tree could
  // not list the one directory it exists to list.
  if (r === '') return true;
  return !r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r);
}

/** Resolve a caller-supplied relative path, or say why not. */
function locate(app, rel) {
  const cwd = app.session.cwd || process.cwd();
  const abs = fstools.resolve(cwd, String(rel || ''));
  if (!abs) return { ok: false, why: 'no path given' };
  if (!inside(cwd, abs)) return { ok: false, why: `outside the project: ${rel}` };
  // `fstools.rel` hands back the ABSOLUTE path when the relative one is empty —
  // i.e. for the project root itself, which is exactly what a tree asks for
  // first. Left alone, every path in the first listing came back absolute.
  const r = path.relative(path.resolve(cwd), path.resolve(abs)).replace(/\\/g, '/');
  return { ok: true, abs, cwd, rel: r === '' ? '.' : r };
}

/**
 * ONE DIRECTORY, not the whole tree.
 *
 * LAZY BY DIRECTORY, because a recursive walk of an unknown project is
 * unbounded and the person only ever looks at one branch. Directories first,
 * then files, each alphabetical — the order every file tree has used for
 * thirty years, and the one a hand goes to without looking.
 */
function tree(app, rel = '') {
  const at = locate(app, rel || '.');
  if (!at.ok) return at;
  let entries;
  try {
    entries = fs.readdirSync(at.abs, { withFileTypes: true });
  } catch (e) {
    return { ok: false, why: `cannot read ${at.rel}: ${(e && e.message) || e}` };
  }
  const changed = new Set(changedPaths(app));
  const dirs = [];
  const files = [];
  for (const e of entries) {
    // DOTFILES ARE PROJECT FILES. `.env`, `.vscode/`, `.github/`, `.eslintrc`
    // are exactly what a person opens; only VCS internals stay out.
    if (HIDDEN.has(e.name.toLowerCase())) continue;
    const childRel = at.rel === '.' ? e.name : `${at.rel}/${e.name}`;
    // A LINK IS WHAT IT POINTS AT. A symlinked or junctioned file was not
    // `isFile()` and silently vanished from the tree.
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try { const t = fs.statSync(path.join(at.abs, e.name)); isDir = t.isDirectory(); isFile = t.isFile(); } catch { isDir = false; isFile = false; }
    }
    if (isDir) {
      // HEAVY DIRECTORIES ARE LISTED, COLLAPSED AND MARKED, like every editor
      // does — hiding node_modules made a person's own package unreachable.
      dirs.push({ name: e.name, path: childRel, dir: true, dim: SKIP_DIRS.has(e.name) || undefined });
    } else if (isFile) {
      let size = 0;
      try { size = fs.statSync(path.join(at.abs, e.name)).size; } catch { size = 0; }
      const kind = kindOf(e.name);
      files.push({
        name: e.name,
        path: childRel,
        dir: false,
        text: kind === 'text',
        kind,
        size,
        // CHANGED BY THIS SESSION, from the checkpoint ledger — the same source
        // the CLI's Changes pane reads, never a second idea of what is dirty.
        changed: changed.has(childRel),
      });
    }
    if (dirs.length + files.length >= MAX_ENTRIES) break;
  }
  const by = (a, b) => a.name.localeCompare(b.name);
  return { ok: true, path: at.rel, entries: [...dirs.sort(by), ...files.sort(by)] };
}

/** Files this session has changed, as project-relative paths. */
function changedPaths(app) {
  try {
    return require('../ui/panes')
      .changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd })
      .map((f) => f.rel);
  } catch { return []; }
}

/**
 * OPEN A FILE.
 *
 * `mtimeMs` and `size` come back with the body and are the SAVE TOKEN — see
 * the header. They are the file's identity at the moment it was read, and a
 * save that cannot present them is a save from a buffer that may be stale.
 */
function open(app, rel) {
  const at = locate(app, rel);
  if (!at.ok) return at;
  let st;
  try { st = fs.statSync(at.abs); } catch (e) {
    return { ok: false, why: `cannot open ${at.rel}: ${(e && e.message) || e}` };
  }
  if (!st.isFile()) return { ok: false, why: `${at.rel} is not a file` };
  const img = IMAGE_MIME[path.extname(at.rel).toLowerCase()];
  if (img) {
    // AN IMAGE IS PREVIEWED, not decoded as text.
    return { ok: true, path: at.rel, kind: 'image', mime: img, size: st.size, mtimeMs: st.mtimeMs, tooLarge: st.size > MAX_IMAGE_BYTES };
  }
  if (st.size > MAX_FILE_BYTES) {
    return { ok: false, kind: 'large', why: `${at.rel} is ${(st.size / 1048576).toFixed(1)}MB — larger than the ${MAX_FILE_BYTES / 1048576}MB the editor opens`, size: st.size };
  }
  let buf;
  try { buf = fs.readFileSync(at.abs); } catch (e) {
    const code = e && e.code;
    const why = code === 'EACCES' || code === 'EPERM' ? 'permission denied' : code === 'EBUSY' ? 'the file is locked by another program' : ((e && e.message) || String(e));
    return { ok: false, why: `cannot read ${at.rel}: ${why}` };
  }
  // BINARY IS DECIDED FROM THE BYTES, whatever the extension said. Rendering it
  // into an editor produces garbage the person may then save back.
  const c = classify(buf);
  if (c.binary) return { ok: false, kind: 'binary', why: `${at.rel} is a binary file — Noema does not edit binary files`, size: st.size };
  const body = c.text;

  return {
    ok: true,
    kind: 'text',
    path: at.rel,
    body,
    encoding: c.encoding,
    eol: c.eol,
    mode: mode(at.rel),
    language: language(at.rel),
    // THE SAVE TOKEN. `mtimeMs` is still carried for display and for cheap
    // change detection, but the DECISION is made on `hash` — see `digest`.
    hash: digest(body),
    mtimeMs: st.mtimeMs,
    size: st.size,
    lines: body.split('\n').length,
    changed: changedPaths(app).includes(at.rel),
  };
}

/**
 * SAVE, IF THE FILE IS STILL THE ONE THAT WAS OPENED.
 *
 * THREE REFUSALS, and each is a way a person loses work that they would not
 * find out about until much later:
 *
 *   STALE       the bytes on disk changed since the open. Almost always LAIN,
 *               because that is the product working as intended. Refused with
 *               the current body so the caller can show both.
 *   TRUNCATION  the same guard a model write goes through (tools/fs.js). A
 *               save that keeps under half of a file over 2KB is a collapse
 *               far more often than it is an edit.
 *   OUTSIDE     not this project's business at all.
 */
async function save(app, rel, body, { hash = null, mtimeMs = null, force = false, encoding = null, origin = 'USER' } = {}) {
  const at = locate(app, rel);
  if (!at.ok) return at;
  const text = String(body == null ? '' : body);

  let st = null;
  try { st = fs.statSync(at.abs); } catch { st = null; }
  // THE ENCODING IT WAS READ IN is the encoding it is written back in; a new
  // file is UTF-8. A caller that does not say keeps what is on disk.
  let enc = encoding;
  if (!enc && st) { try { const c = classify(fs.readFileSync(at.abs)); enc = c.binary ? 'utf8' : c.encoding; } catch { enc = 'utf8'; } }
  enc = ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'latin1'].includes(enc) ? enc : 'utf8';

  if (st && hash && !force) {
    const current = readText(at.abs);
    if (digest(current) !== String(hash)) {
      return {
        ok: false,
        stale: true,
        why: `${at.rel} changed on disk since you opened it`,
        current,
        hash: digest(current),
        mtimeMs: st.mtimeMs,
      };
    }
  }

  if (st && !force) {
    // THE SAME FUNCTION A MODEL WRITE GOES THROUGH, called the way it is
    // actually shaped: `(abs, content)` in, `{was, now}` or null out. It does
    // its own `statSync`, so a new file and a small file are already handled
    // there rather than re-decided here.
    const risk = fstools.truncationRisk(at.abs, text);
    if (risk) {
      return {
        ok: false,
        truncation: true,
        why: `this save keeps ${Math.round((risk.now / risk.was) * 100)}% of ${at.rel} — save again to confirm`,
        was: risk.was,
        now: risk.now,
      };
    }
  }

  // THE PERSON'S SAVE IS A MUTATION LIKE ANY OTHER (mutation.js `change`,
  // actor USER): provenance — EXTERNAL first if the file moved under LAIN —
  // the one project generation, the GUG, freshness and PROJECT_DELTA all
  // follow from the transaction. Nothing here writes around it.
  return require('../mutation').change(app, {
    name: 'editor.save', targets: [at.abs], origin: origin === 'FORMATTER' ? 'FORMATTER' : null,
    what: origin === 'FORMATTER' ? `formatted ${at.rel}` : '',
    write: () => {
      try {
        fs.mkdirSync(path.dirname(at.abs), { recursive: true });
        fs.writeFileSync(at.abs, encode(text, enc));
      } catch (e) {
        return { ok: false, why: `cannot write ${at.rel}: ${(e && e.message) || e}` };
      }
      const after = fs.statSync(at.abs);
      return { ok: true, path: at.rel, hash: digest(text), mtimeMs: after.mtimeMs, size: after.size, bytes: after.size, encoding: enc };
    },
  });
}

/**
 * HAS ANYTHING THE EDITOR HOLDS MOVED UNDER IT?
 *
 * Polled with the rest of the state. Cheap — one `stat` per open tab — and it
 * is what turns "LAIN edited this file" into a thing the editor NOTICES rather
 * than something the person discovers when their save is refused.
 */
function freshness(app, open = []) {
  const out = [];
  for (const t of Array.isArray(open) ? open.slice(0, 24) : []) {
    const at = locate(app, t && t.path);
    if (!at.ok) { out.push({ path: t.path, gone: true }); continue; }
    try {
      const st = fs.statSync(at.abs);
      // SAME REASON AS `save`: a timestamp cannot tell two writes in one
      // millisecond apart, and "LAIN just edited this" is precisely that case.
      const text = readText(at.abs);
      const h = digest(text);
      const changed = String(t.hash || '') !== h;
      // MOVED UNDER THE EDITOR: if LAIN did not write it, it is EXTERNAL — and
      // the project changed, so the ONE project generation advances with it.
      if (changed && require('../editledger').observe(app.session.cwd, at.abs, text, { sessionId: app.session.id })) {
        try { require('../harnesscontext').noteSourceEdit(app, app.session, { file: at.abs, by: 'external' }); } catch { /* context only */ }
      }
      out.push({ path: at.rel, hash: h, mtimeMs: st.mtimeMs, size: st.size, changed });
    } catch {
      out.push({ path: at.rel, gone: true });
    }
  }
  return out;
}

/**
 * QUICK OPEN — a bounded search by filename, not a full-text index.
 *
 * Deliberately NOT a second search implementation: for CONTENT there is
 * tools/search.js and the model uses it. This answers only "where is the file
 * called something like this", which is what a quick-open box is for.
 */
function find(app, query, { limit = 40 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { ok: true, matches: [] };
  const cwd = app.session.cwd || process.cwd();
  const matches = [];
  const walk = (dir, rel, depth) => {
    if (matches.length >= limit || depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (matches.length >= limit) return;
      if (HIDDEN.has(e.name.toLowerCase())) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), childRel, depth + 1);
      } else if (e.isFile() && kindOf(e.name) !== 'binary' && childRel.toLowerCase().includes(q)) {
        matches.push({ path: childRel, name: e.name });
      }
    }
  };
  walk(cwd, '', 0);
  // A NAME MATCH BEATS A DIRECTORY MATCH. Typing "state" should offer
  // `state.js` before `src/state/helpers.js`, which is what a person means.
  matches.sort((a, b) => {
    const an = a.name.toLowerCase().includes(q) ? 0 : 1;
    const bn = b.name.toLowerCase().includes(q) ? 0 : 1;
    return an - bn || a.path.length - b.path.length;
  });
  return { ok: true, matches: matches.slice(0, limit) };
}

/** An image's bytes, for the editor's preview. Bounded; never text. */
function raw(app, rel) {
  const at = locate(app, rel);
  if (!at.ok) return at;
  const mime = IMAGE_MIME[path.extname(at.rel).toLowerCase()];
  if (!mime) return { ok: false, why: `${at.rel} is not an image Noema previews` };
  let st;
  try { st = fs.statSync(at.abs); } catch (e) { return { ok: false, why: `cannot open ${at.rel}: ${(e && e.message) || e}` }; }
  if (st.size > MAX_IMAGE_BYTES) return { ok: false, why: `${at.rel} is too large to preview` };
  return { ok: true, path: at.rel, mime, data: fs.readFileSync(at.abs).toString('base64'), size: st.size };
}

module.exports = {
  tree, open, save, find, freshness, raw, digest, language, mode, classify, encode, readText, kindOf, isText, inside, locate, changedPaths,
  MAX_FILE_BYTES, MAX_ENTRIES, SKIP_DIRS, TEXT_EXT, BINARY_EXT, IMAGE_MIME, HIDDEN,
};
