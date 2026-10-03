'use strict';

/** WHAT THE PERSON IS LOOKING AT IN THE IDE — so "what does this function do?" and "fix these errors" need nothing pasted. */

const MAX_SELECTION = 6000;
const MAX_DIAGNOSTICS = 40;
const MAX_TABS = 20;
const MAX_TERMINAL = 4000;
/** A report older than this describes a screen the person has left. */
const FRESH_MS = 30 * 60 * 1000;

function clip(s, n) { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n)}\n[… ${t.length - n} more characters]` : t; }

/** Record the editor's report, bounded and shaped. Never trusted as a path. */
function record(session, body = {}) {
  if (!session) return null;
  const sel = body.selection && typeof body.selection === 'object' ? body.selection : null;
  const diags = Array.isArray(body.diagnostics) ? body.diagnostics.slice(0, MAX_DIAGNOSTICS).map((d) => ({
    path: String(d.path || '').slice(0, 300),
    line: Number(d.line) || 0,
    col: Number(d.col) || 0,
    severity: ['error', 'warning', 'info', 'hint'].includes(d.severity) ? d.severity : 'info',
    message: String(d.message || '').slice(0, 400),
    source: String(d.source || '').slice(0, 40),
  })) : [];
  session._ide = {
    at: Date.now(),
    file: body.file ? String(body.file).slice(0, 300) : null,
    language: body.language ? String(body.language).slice(0, 40) : null,
    cursor: body.cursor ? { line: Number(body.cursor.line) || 0, col: Number(body.cursor.col) || 0 } : null,
    selection: sel && sel.text ? { text: String(sel.text).slice(0, MAX_SELECTION), startLine: Number(sel.startLine) || 0, endLine: Number(sel.endLine) || 0, startCol: Number(sel.startCol) || null, endCol: Number(sel.endCol) || null } : null,
    tabs: Array.isArray(body.tabs) ? body.tabs.slice(0, MAX_TABS).map((t) => String(t).slice(0, 300)) : [],
    diagnostics: diags,
    terminal: body.terminal ? String(body.terminal).slice(0, 80) : null,
  };
  return session._ide;
}

/** The last output of this project's shell, from Core's own pty store. */
function terminalTail(app, id = null) {
  try {
    const pty = require('./pty');
    const list = pty.list(app) || [];
    // list() is a summary without the buffer; the terminal itself comes from get().
    const last = list[list.length - 1];
    const t = (id && pty.get(app, id)) || (last && pty.get(app, last.id));
    if (!t || !t.buffer || !t.buffer.length) return null;
    // AS THE SCREEN SHOWS IT, not the bytes that painted it: the pseudoconsole redraws with cursor moves, and stripped escapes would leave every repaint in…
    const text = require('./vtscreen').render(t.buffer.slice(-MAX_TERMINAL * 6).toString('utf8'), { cols: t.cols, rows: t.rows });
    return { alive: Boolean(t.alive), text: text.slice(-MAX_TERMINAL) };
  } catch { return null; }
}

/** The prompt section, or '' — see the header for when it is silent. */
function section(app, session) {
  const s = session || (app && app.session);
  const c = s && s._ide;
  if (!s || !s._ideTurn || !c || Date.now() - c.at > FRESH_MS) return '';
  const out = ['# In the IDE right now', 'What the person has in front of them. Use it; do not ask them to paste it.'];
  // PARTS THE PERSON REMOVED from this turn's context (a chip they closed).
  const no = s._ideExclude || {};
  if (c.file && !no.file) out.push(`Current file: ${c.file}${c.language ? ` (${c.language})` : ''}${c.cursor ? ` — cursor at line ${c.cursor.line}, column ${c.cursor.col}` : ''}`);
  if (c.tabs.length && !no.file) out.push(`Open tabs: ${c.tabs.join(', ')}`);
  // THE SELECTION IS NOT RENDERED HERE: it is the canonical Selection's (harnesscontext.selection), rendered once in the Harness context packet.
  if (c.diagnostics.length && !no.problems) {
    const errs = c.diagnostics.filter((d) => d.severity === 'error').length;
    out.push(`\nProblems (${errs} error${errs === 1 ? '' : 's'}, ${c.diagnostics.length - errs} other):`);
    for (const d of c.diagnostics) out.push(`  ${d.severity.toUpperCase()} ${d.path}:${d.line}:${d.col} ${d.message}${d.source ? ` [${d.source}]` : ''}`);
  }
  const term = no.terminal ? null : terminalTail(app, c.terminal);
  if (term && term.text.trim()) out.push(`\nTerminal output (last ${term.text.length} characters${term.alive ? '' : ', shell exited'}):\n\`\`\`\n${term.text}\n\`\`\``);
  return out.length > 2 ? out.join('\n') : '';
}

module.exports = { record, section, terminalTail, FRESH_MS };
