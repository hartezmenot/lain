'use strict';
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

function activate(context) {
  const marker = vscode.workspace.getConfiguration('sample').get('marker', 'TODO');
  const diags = vscode.languages.createDiagnosticCollection('sample');
  const scan = (doc) => {
    const list = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const t = doc.lineAt(i).text;
      const at = t.indexOf(marker);
      if (at >= 0) list.push(new vscode.Diagnostic(new vscode.Range(i, at, i, at + marker.length), `${marker} left in code`, vscode.DiagnosticSeverity.Warning));
    }
    diags.set(doc.uri, list);
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(scan),
    vscode.workspace.onDidSaveTextDocument(scan),
    vscode.commands.registerCommand('sample.hello', (name) => { vscode.window.showInformationMessage(`Hello from the sample extension${name ? `, ${name}` : ''}`); return 'hello'; }),
    vscode.commands.registerCommand('sample.countTodos', async () => {
      const root = vscode.workspace.workspaceFolders[0].uri;
      const n = vscode.workspace.textDocuments.reduce((c, d) => c + d.getText().split(marker).length - 1, 0);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'todo-count.txt'), Buffer.from(String(n)));
      return n;
    }),
    vscode.commands.registerCommand('sample.readOutside', () => {
      try { fs.readFileSync(path.join(os.homedir(), '.gitconfig')); return 'READ'; } catch (e) { return e.code; }
    }),
    vscode.commands.registerCommand('sample.unsupported', () => vscode.window.createWebviewPanel('x', 'x', 1, {})),
    vscode.commands.registerCommand('sample.crash', () => { setTimeout(() => process.exit(3), 10); return 'crashing'; }),
    vscode.commands.registerCommand('sample.hang', () => { const end = Date.now() + 600000; while (Date.now() < end) { /* hang */ } }),
    vscode.languages.registerCompletionItemProvider('javascript', {
      provideCompletionItems() { const it = new vscode.CompletionItem('sampleCompletion', vscode.CompletionItemKind.Snippet); it.detail = 'from the sample extension'; it.insertText = 'sampleCompletion()'; return [it]; },
    }),
    vscode.languages.registerHoverProvider('javascript', { provideHover(doc, pos) { const r = doc.getWordRangeAtPosition(pos); return r ? new vscode.Hover(new vscode.MarkdownString(`sample hover: **${doc.getText(r)}**`)) : null; } }),
  );
}
function deactivate() {}
module.exports = { activate, deactivate };
