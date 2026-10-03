'use strict';

/** DID THAT EDIT LEAVE THE FILE PARSEABLE? */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** Extensions this can say anything about at all. */
const JS = /\.(?:js|cjs|mjs)$/i;
const TSX = /\.(?:jsx|tsx|ts|mts|cts)$/i;
const JSON_RE = /\.(?:json)$/i;
const PY = /\.py$/i;

/** The parse errors that mean "this is module syntax", NOT "this is broken". */
const MODULE_SYNTAX = /Cannot use import statement outside a module|Unexpected token 'export'|await is only valid in async|may appear only with 'sourceType: module'/i;

/** Pull the line number out of a compile failure. */
function lineOf(err, filename) {
  const stack = String((err && err.stack) || '');
  const esc = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}:(\\d+)`).exec(stack);
  return m ? Number(m[1]) : null;
}

/** Compile JavaScript without running a byte of it. */
function checkJs(source, filename) {
  try {
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename });
    return { ok: true };
  } catch (e) {
    if (!(e instanceof SyntaxError)) return { ok: true, inconclusive: true };
    if (MODULE_SYNTAX.test(String(e.message))) return { ok: true, inconclusive: true, module: true };
    return { ok: false, message: e.message, line: lineOf(e, filename) };
  }
}

/** `node --check`, for the files `vm.Script` cannot judge. */
function checkWithNode(abs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = require('child_process').spawn(process.execPath, ['--check', abs], { windowsHide: true });
    } catch { resolve({ ok: true, inconclusive: true }); return; }
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', () => resolve({ ok: true, inconclusive: true }));
    child.on('close', (code) => {
      if (code === 0) { resolve({ ok: true }); return; }
      // `\r?\n` — node prints `<path>:<line>` on its own line, and on Windows that line ends CRLF.
      const m = /:(\d+)\r?\n/.exec(err);
      const msg = /SyntaxError: (.+)/.exec(err);
      resolve({ ok: false, message: msg ? msg[1].trim() : 'syntax error', line: m ? Number(m[1]) : null });
    });
  });
}

/** JSON, where a trailing comma is a real and very common defect. */
function checkJson(source) {
  try {
    JSON.parse(source);
    return { ok: true };
  } catch (e) {
    const msg = String(e.message);
    const at = /position (\d+)/.exec(msg);
    const line = at ? source.slice(0, Number(at[1])).split('\n').length : null;
    return { ok: false, message: msg.replace(/\s+in JSON at position \d+.*$/, ''), line };
  }
}

/** Python, through the interpreter's own parser. */
function checkPython(abs) {
  return new Promise((resolve) => {
    let py;
    try { py = require('./tools/exec').findPython(); } catch { py = { ok: false }; }
    if (!py || !py.ok) { resolve({ ok: true, inconclusive: true }); return; }
    const code = 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read(),sys.argv[1])';
    let child;
    try {
      child = require('child_process').spawn(py.exe, ['-c', code, abs], { windowsHide: true });
    } catch { resolve({ ok: true, inconclusive: true }); return; }
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', () => resolve({ ok: true, inconclusive: true }));
    child.on('close', (exit) => {
      if (exit === 0) { resolve({ ok: true }); return; }
      const line = /line (\d+)/.exec(err);
      const msg = /(SyntaxError|IndentationError|TabError): (.+)/.exec(err);
      resolve({
        ok: false,
        message: msg ? `${msg[1]}: ${msg[2].trim()}` : 'does not parse',
        line: line ? Number(line[1]) : null,
      });
    });
  });
}

/** Check one file on disk. */
/** JSX / TypeScript through the PROJECT'S OWN compiler — a syntax-only parse (no type check, no emit, nothing run). */
const tsCache = new Map();
function projectTypeScript(abs) {
  const dir = path.dirname(abs);
  if (tsCache.has(dir)) return tsCache.get(dir);
  let ts = null;
  try { ts = require(require.resolve('typescript', { paths: [dir] })); } catch { ts = null; }
  tsCache.set(dir, ts);
  return ts;
}
function checkTsx(source, abs) {
  const ts = projectTypeScript(abs);
  if (!ts || typeof ts.transpileModule !== 'function') return { ok: true, inconclusive: true };
  try {
    const r = ts.transpileModule(source, { fileName: abs, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit ? ts.JsxEmit.Preserve : 1, allowJs: true, isolatedModules: true } });
    const errs = (r.diagnostics || []).filter((d) => d.category === (ts.DiagnosticCategory ? ts.DiagnosticCategory.Error : 1));
    if (!errs.length) return { ok: true };
    const d = errs[0];
    const line = d.file && typeof d.start === 'number' ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null;
    return { ok: false, message: ts.flattenDiagnosticMessageText(d.messageText, ' '), line };
  } catch { return { ok: true, inconclusive: true }; }
}

async function checkFile(abs) {
  const name = path.basename(abs);
  let source;
  if (PY.test(name)) return checkPython(abs);
  try { source = fs.readFileSync(abs, 'utf8'); } catch { return { ok: true, inconclusive: true }; }
  if (JSON_RE.test(name)) return checkJson(source);
  if (TSX.test(name)) return checkTsx(source, abs);
  if (!JS.test(name)) return { ok: true, inconclusive: true };
  const quick = checkJs(source, abs);
  if (!quick.inconclusive) return quick;
  if (quick.module) return checkWithNode(abs);
  return quick;
}

/** Check everything one tool call wrote, and phrase it for the model. */
async function reportFor(paths, cwd, { onResult = null } = {}) {
  if (!Array.isArray(paths) || !paths.length) return '';
  const bad = [];
  const unresolved = [];
  for (const abs of paths) {
    let r;
    try { r = await checkFile(abs); } catch { r = { ok: true }; }
    // EVIDENCE, NOT A GATE: a conclusive parse (either way) is recorded by the caller as a static check.
    if (onResult && r && !r.inconclusive) { try { onResult(abs, r); } catch { /* recording is best effort */ } }
    const where = cwd ? path.relative(cwd, abs) || abs : abs;
    if (r && r.ok === false) {
      bad.push(`${where}${r.line ? `:${r.line}` : ''} — ${r.message}`);
      continue;
    }
    // THE SECOND RUNG, and only reached when the file PARSES
    try {
      const model = require('./codemodel').scanFile(abs);
      if (model.supported) {
        for (const f of require('./typos').unresolved(model)) unresolved.push({ ...f, where });
      }
    } catch { /* a checker that fails must never fail the edit it was checking */ }
  }
  let out = '';
  if (bad.length) out += `\n\nSYNTAX ERROR — the file was written but does not parse:\n${bad.join('\n')}`;
  if (unresolved.length) {
    const rows = unresolved.map((f) => `  ${f.where}:${f.line}  ${f.name}${f.calls ? '()' : ''} `
      + `is not defined here — ${f.suggestion} is (${f.why})`);
    out += `\n\nUNRESOLVED NAME${unresolved.length > 1 ? 'S' : ''} — the file parses, but `
      + `${unresolved.length > 1 ? 'these names resolve' : 'this name resolves'} to nothing:\n${rows.join('\n')}`;
  }
  return out;
}

module.exports = { checkFile, reportFor, checkJs, checkJson, checkPython, checkWithNode };
