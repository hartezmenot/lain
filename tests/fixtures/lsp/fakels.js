'use strict';

/**
 * A SMALL, REAL LANGUAGE SERVER for tests — LSP over stdio, Content-Length
 * framing, for "LAIN test" files (*.lt). The language: `let NAME = …`
 * declares, `fn NAME(…)` declares a function, `"…"` is a string, `#` starts
 * a comment. An identifier inside a string or a comment is NOT a reference —
 * which is exactly the semantic difference a rename must respect.
 */

const fs = require('fs');
const { fileURLToPath } = require('url');

const docs = new Map();
let buf = Buffer.alloc(0);

function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function textOf(uri) {
  if (docs.has(uri)) return docs.get(uri);
  try { return fs.readFileSync(fileURLToPath(uri), 'utf8'); } catch { return ''; }
}

/** Identifier tokens outside strings and comments: [{ name, line, start, end }]. */
function tokens(text) {
  const out = [];
  text.split(/\r?\n/).forEach((ln, line) => {
    let inStr = false;
    for (let i = 0; i < ln.length;) {
      const ch = ln[i];
      if (!inStr && ch === '#') break;
      if (ch === '"') { inStr = !inStr; i++; continue; }
      if (!inStr && /[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < ln.length && /\w/.test(ln[j])) j++;
        out.push({ name: ln.slice(i, j), line, start: i, end: j });
        i = j;
        continue;
      }
      i++;
    }
  });
  return out;
}
const KEYWORDS = new Set(['let', 'fn', 'return', 'print']);

function allUris(root) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (p.endsWith('.lt')) out.push(require('url').pathToFileURL(p).href); } };
  try { walk(root); } catch { /* none */ }
  for (const u of docs.keys()) if (!out.includes(u)) out.push(u);
  return out;
}
let rootPath = '.';

function at(uri, pos) { return tokens(textOf(uri)).find((t) => t.line === pos.line && pos.character >= t.start && pos.character <= t.end); }
function range(t) { return { start: { line: t.line, character: t.start }, end: { line: t.line, character: t.end } }; }
function refs(name) {
  const out = [];
  for (const u of allUris(rootPath)) for (const t of tokens(textOf(u))) if (t.name === name) out.push({ uri: u, range: range(t), t, text: textOf(u) });
  return out;
}
function isDecl(r) {
  const ln = r.text.split(/\r?\n/)[r.t.line] || '';
  return new RegExp(`^\\s*(let|fn)\\s+${r.t.name}\\b`).test(ln);
}
function diagnose(uri) {
  const diagnostics = [];
  textOf(uri).split(/\r?\n/).forEach((ln, i) => { const a = ln.indexOf('ERROR'); if (a >= 0) diagnostics.push({ range: { start: { line: i, character: a }, end: { line: i, character: a + 5 } }, severity: 1, message: 'ERROR marker found', source: 'fakels' }); });
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}

function handle(m) {
  const p = m.params || {};
  switch (m.method) {
    case 'initialize':
      rootPath = p.rootUri ? fileURLToPath(p.rootUri) : '.';
      return send({ id: m.id, result: { capabilities: { textDocumentSync: 1, definitionProvider: true, declarationProvider: true, referencesProvider: true, hoverProvider: true, renameProvider: { prepareProvider: true }, documentSymbolProvider: true, workspaceSymbolProvider: true, completionProvider: {} } } });
    case 'initialized': return undefined;
    case 'shutdown': return send({ id: m.id, result: null });
    case 'exit': return process.exit(0);
    case 'textDocument/didOpen': docs.set(p.textDocument.uri, p.textDocument.text); return diagnose(p.textDocument.uri);
    case 'textDocument/didChange': docs.set(p.textDocument.uri, p.contentChanges[p.contentChanges.length - 1].text); return diagnose(p.textDocument.uri);
    case 'textDocument/didSave': return diagnose(p.textDocument.uri);
    case 'textDocument/didClose': docs.delete(p.textDocument.uri); return undefined;
    case 'textDocument/definition':
    case 'textDocument/declaration': {
      const t = at(p.textDocument.uri, p.position);
      const d = t ? refs(t.name).filter(isDecl) : [];
      return send({ id: m.id, result: d.map((r) => ({ uri: r.uri, range: r.range })) });
    }
    case 'textDocument/references': {
      const t = at(p.textDocument.uri, p.position);
      const r = t ? refs(t.name).filter((x) => p.context.includeDeclaration || !isDecl(x)) : [];
      return send({ id: m.id, result: r.map((x) => ({ uri: x.uri, range: x.range })) });
    }
    case 'textDocument/hover': {
      const t = at(p.textDocument.uri, p.position);
      return send({ id: m.id, result: t ? { contents: { kind: 'markdown', value: `**${t.name}** — ${refs(t.name).length} reference(s)` } } : null });
    }
    case 'textDocument/prepareRename': {
      const t = at(p.textDocument.uri, p.position);
      return send({ id: m.id, result: t && !KEYWORDS.has(t.name) ? range(t) : null });
    }
    case 'textDocument/rename': {
      const t = at(p.textDocument.uri, p.position);
      const changes = {};
      if (t) for (const r of refs(t.name)) (changes[r.uri] = changes[r.uri] || []).push({ range: r.range, newText: p.newName });
      return send({ id: m.id, result: { changes } });
    }
    case 'textDocument/documentSymbol': {
      const out = [];
      textOf(p.textDocument.uri).split(/\r?\n/).forEach((ln, i) => { const mm = ln.match(/^\s*(let|fn)\s+(\w+)/); if (mm) { const c = ln.indexOf(mm[2]); out.push({ name: mm[2], kind: mm[1] === 'fn' ? 12 : 13, range: { start: { line: i, character: 0 }, end: { line: i, character: ln.length } }, selectionRange: { start: { line: i, character: c }, end: { line: i, character: c + mm[2].length } } }); } });
      return send({ id: m.id, result: out });
    }
    case 'workspace/symbol': {
      const out = [];
      for (const u of allUris(rootPath)) textOf(u).split(/\r?\n/).forEach((ln, i) => { const mm = ln.match(/^\s*(let|fn)\s+(\w+)/); if (mm && mm[2].includes(p.query || '')) { const c = ln.indexOf(mm[2]); out.push({ name: mm[2], kind: 12, location: { uri: u, range: { start: { line: i, character: c }, end: { line: i, character: c + mm[2].length } } } }); } });
      return send({ id: m.id, result: out });
    }
    case 'textDocument/completion': return send({ id: m.id, result: [...new Set(tokens(textOf(p.textDocument.uri)).map((t) => t.name))].map((label) => ({ label, kind: 6 })) });
    default:
      if (m.id != null) return send({ id: m.id, error: { code: -32601, message: `unhandled ${m.method}` } });
      return undefined;
  }
}

process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf('\r\n\r\n');
    if (h < 0) return;
    const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, h).toString('ascii'));
    const len = m ? Number(m[1]) : 0;
    if (buf.length < h + 4 + len) return;
    const body = buf.slice(h + 4, h + 4 + len).toString('utf8');
    buf = buf.slice(h + 4 + len);
    try { handle(JSON.parse(body)); } catch (e) { process.stderr.write(`fakels: ${e.stack}\n`); }
  }
});
