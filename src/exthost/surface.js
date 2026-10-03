'use strict';

/** THE VS CODE API LAIN'S EXTENSION HOST PROVIDES — one list, and the scan that compares an extension's code against it (2026-09-25). */

const fs = require('fs');
const path = require('path');

const SURFACE = Object.freeze({
  commands: ['registerCommand', 'executeCommand', 'getCommands'],
  window: ['showInformationMessage', 'showWarningMessage', 'showErrorMessage', 'createOutputChannel', 'activeTextEditor', 'onDidChangeActiveTextEditor', 'setStatusBarMessage'],
  workspace: ['workspaceFolders', 'rootPath', 'textDocuments', 'getConfiguration', 'onDidChangeConfiguration', 'onDidOpenTextDocument', 'onDidChangeTextDocument', 'onDidSaveTextDocument', 'onDidCloseTextDocument', 'openTextDocument', 'findFiles', 'applyEdit', 'fs'],
  languages: ['createDiagnosticCollection', 'registerCompletionItemProvider', 'registerHoverProvider', 'registerDefinitionProvider', 'registerDocumentFormattingEditProvider', 'getLanguages'],
  env: ['appName', 'appRoot', 'language', 'machineId', 'uriScheme', 'sessionId'],
  extensions: ['getExtension', 'all'],
});

/** Every vscode namespace an extension may reach for — provided or not. */
const NAMESPACES = Object.freeze(['commands', 'window', 'workspace', 'languages', 'env', 'extensions', 'debug', 'tasks', 'scm', 'notebooks', 'authentication', 'comments', 'tests', 'chat', 'lm', 'l10n']);

const MAX_BYTES = 4 * 1024 * 1024;
const cache = new Map();   // file -> { stamp, result }

function provides(ns, member) { return Boolean(SURFACE[ns] && SURFACE[ns].includes(member)); }

/** The vscode APIs this code references, and which LAIN does not provide. */
function scanCode(code) {
  const used = new Set();
  const re = new RegExp(`\\b(${NAMESPACES.join('|')})\\.([A-Za-z_$][\\w$]*)`, 'g');
  let m;
  while ((m = re.exec(code))) {
    // `window.` in a bundle is often the browser global; only its vscode members count.
    if (m[1] === 'window' && !/^(show|create|on|active|visible|set|with|register|tab|state|terminals)/.test(m[2])) continue;
    if (m[1] === 'env' && /^(NODE_|npm_|PATH|HOME)/.test(m[2])) continue;
    used.add(`${m[1]}.${m[2]}`);
  }
  const missing = [...used].filter((u) => { const [ns, member] = u.split('.'); return !provides(ns, member); }).sort();
  return { used: [...used].sort(), missing };
}

/** Scan an extension's entry file (package.json `main`), cached by mtime. */
function scanExtension(dir, pkg) {
  if (!dir || !pkg || !pkg.main) return null;
  let file = path.resolve(dir, pkg.main);
  if (!fs.existsSync(file) && fs.existsSync(`${file}.js`)) file = `${file}.js`;
  let st;
  try { st = fs.statSync(file); } catch { return { ok: false, why: `entry ${pkg.main} is missing`, used: [], missing: [] }; }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.result;
  let code = '';
  try { const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(Math.min(st.size, MAX_BYTES)); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd); code = buf.toString('utf8'); } catch { return { ok: false, why: 'the entry could not be read', used: [], missing: [] }; }
  const result = { ok: true, file: path.relative(dir, file).split(path.sep).join('/'), truncated: st.size > MAX_BYTES, ...scanCode(code) };
  cache.set(file, { stamp, result });
  return result;
}

module.exports = { SURFACE, NAMESPACES, provides, scanCode, scanExtension };
