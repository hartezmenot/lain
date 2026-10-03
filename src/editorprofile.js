'use strict';

/** THE IDE EDITOR'S PROFILE — settings, keybindings and snippets, owned by Core. */

const fs = require('fs');
const path = require('path');

const MAX_SNIPPETS = 2000;
const MAX_KEYBINDINGS = 500;

// ---- the editor options LAIN applies, and what each accepts ----------------
const oneOf = (list) => (v) => (list.includes(v) ? v : undefined);
const int = (lo, hi) => (v) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
const num = (lo, hi) => (v) => (typeof v === 'number' && v >= lo && v <= hi ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const text = (n) => (v) => (typeof v === 'string' && v.length <= n ? v : undefined);

/** VS Code setting → Monaco option, with the values Monaco accepts. */
const SETTINGS = Object.freeze({
  'editor.fontSize': ['fontSize', num(6, 72)],
  'editor.fontFamily': ['fontFamily', text(300)],
  'editor.fontLigatures': ['fontLigatures', bool],
  'editor.lineHeight': ['lineHeight', num(0, 150)],
  'editor.tabSize': ['tabSize', int(1, 16)],
  'editor.insertSpaces': ['insertSpaces', bool],
  'editor.detectIndentation': ['detectIndentation', bool],
  'editor.wordWrap': ['wordWrap', oneOf(['off', 'on', 'wordWrapColumn', 'bounded'])],
  'editor.wordWrapColumn': ['wordWrapColumn', int(1, 1000)],
  'editor.lineNumbers': ['lineNumbers', oneOf(['on', 'off', 'relative', 'interval'])],
  'editor.renderWhitespace': ['renderWhitespace', oneOf(['none', 'boundary', 'selection', 'trailing', 'all'])],
  'editor.rulers': ['rulers', (v) => (Array.isArray(v) && v.length <= 10 && v.every((n) => Number.isInteger(n) && n > 0 && n < 1000) ? v : undefined)],
  'editor.cursorStyle': ['cursorStyle', oneOf(['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'])],
  'editor.cursorBlinking': ['cursorBlinking', oneOf(['blink', 'smooth', 'phase', 'expand', 'solid'])],
  'editor.minimap.enabled': ['minimap.enabled', bool],
  'editor.bracketPairColorization.enabled': ['bracketPairColorization.enabled', bool],
  'editor.guides.bracketPairs': ['guides.bracketPairs', (v) => (v === true || v === false || v === 'active' ? v : undefined)],
  'editor.smoothScrolling': ['smoothScrolling', bool],
  'editor.mouseWheelZoom': ['mouseWheelZoom', bool],
  'editor.renderLineHighlight': ['renderLineHighlight', oneOf(['none', 'gutter', 'line', 'all'])],
  'editor.scrollBeyondLastLine': ['scrollBeyondLastLine', bool],
  'editor.folding': ['folding', bool],
  'editor.stickyScroll.enabled': ['stickyScroll.enabled', bool],
  'editor.autoClosingBrackets': ['autoClosingBrackets', oneOf(['always', 'languageDefined', 'beforeWhitespace', 'never'])],
  'editor.formatOnPaste': ['formatOnPaste', bool],
  'editor.quickSuggestions': ['quickSuggestions', (v) => (typeof v === 'boolean' ? v : undefined)],
});

// VS Code commands that are LAIN's own actions in the IDE (pageeditor.js).
const COMMAND_MAP = Object.freeze({
  'editor.action.revealDefinition': 'lain.goToDefinition',
  'editor.action.goToDeclaration': 'lain.goToDefinition',
  'editor.action.goToReferences': 'lain.findReferences',
  'editor.action.referenceSearch.trigger': 'lain.findReferences',
  'references-view.findReferences': 'lain.findReferences',
  'editor.action.rename': 'lain.renameSymbol',
});

/** Monaco's own commands, as a VS Code keybinding names them. */
function commandFor(command) {
  const c = String(command || '');
  if (COMMAND_MAP[c]) return COMMAND_MAP[c];
  if (/^editor\.(action\.[A-Za-z0-9.]+|fold[A-Za-z]*|unfold[A-Za-z]*|toggleFold)$/.test(c)) return c;
  if (/^(cursor|deleteLeft|deleteRight|undo|redo|tab|outdent)[A-Za-z]*$/.test(c)) return c;
  return null;
}

// A single chord: modifiers then one key. Two-part chords ("ctrl+k ctrl+c") are
// reported, not guessed at.
const KEY_RE = /^((ctrl|shift|alt|meta|cmd|win)\+){0,4}([a-z0-9]|f[1-9]|f1[0-9]|enter|escape|tab|space|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|[`\-=[\];',./\\])$/;

function keybinding(kb) {
  if (!kb || typeof kb !== 'object') return { ok: false, why: 'not a keybinding' };
  const key = String(kb.key || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const command = String(kb.command || '');
  if (!key || !command) return { ok: false, why: 'no key or command' };
  if (command.startsWith('-')) return { ok: false, why: 'removes a default binding (not supported)' };
  // A TWO-PART CHORD ("ctrl+k ctrl+c") is bound as one (Monaco KeyMod.chord);
  // VS Code has nothing longer, and a longer one is refused rather than cut.
  const parts = key.split(' ');
  if (parts.length > 2) return { ok: false, why: 'a chord of more than two keys (not supported)' };
  for (const k of parts) if (!KEY_RE.test(k)) return { ok: false, why: `key "${k}" is not one LAIN can bind` };
  const target = commandFor(command);
  if (!target) return { ok: false, why: `${command} is not an editor command in LAIN` };
  return { ok: true, value: { key, command: target, from: command } };
}

/** A VS Code snippet definition → LAIN's shape, or null. */
function snippet(name, s) {
  if (!s || typeof s !== 'object') return null;
  const prefix = Array.isArray(s.prefix) ? s.prefix.map(String).filter(Boolean) : (s.prefix ? [String(s.prefix)] : []);
  const body = Array.isArray(s.body) ? s.body.map(String).join('\n') : (typeof s.body === 'string' ? s.body : null);
  if (!prefix.length || body == null || body.length > 20000) return null;
  return { name: String(name).slice(0, 120), prefix: prefix.slice(0, 5).map((p) => p.slice(0, 80)), body, description: s.description ? String(s.description).slice(0, 300) : '' };
}

// VS Code language ids that Monaco spells differently.
const LANG_ALIAS = Object.freeze({ javascriptreact: 'javascript', typescriptreact: 'typescript', jsonc: 'json', shellscript: 'shell', 'objective-c': 'objective-c' });
function language(id) { const l = String(id || '').toLowerCase().trim(); return LANG_ALIAS[l] || l; }

function file(configDir) { return path.join(configDir || require('./config').configDir(), 'editor.json'); }

function empty() { return { version: 1, settings: {}, keybindings: [], snippets: {}, importedFrom: null }; }

function read(configDir) {
  try {
    const p = JSON.parse(fs.readFileSync(file(configDir), 'utf8'));
    return { ...empty(), ...p, settings: p.settings || {}, keybindings: Array.isArray(p.keybindings) ? p.keybindings : [], snippets: p.snippets || {} };
  } catch { return empty(); }
}

function write(profile, configDir) {
  const p = file(configDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`);
  fs.renameSync(tmp, p);
  return profile;
}

function clear(configDir) { try { fs.unlinkSync(file(configDir)); } catch { /* nothing to clear */ } return empty(); }

module.exports = { SETTINGS, COMMAND_MAP, MAX_SNIPPETS, MAX_KEYBINDINGS, commandFor, keybinding, snippet, language, read, write, clear, empty, file };
