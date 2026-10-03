'use strict';

/** BOUNDED TOOL RESULTS — the one place large new evidence enters a request (2026-09-24). */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CHARS = 24000;
const HARD_CAP = 80000;
const LISTING = /^(?:grep|glob|search|list_dir|find_residue|symbols|dependents|discover_tests)$/;
const SHELL = /^(?:shell|bash|Bash|run_bash|run_cmd|run_powershell|run_tests|process_run|python_run|run_background)$/;

function dir() { return path.join(require('./config').configDir(), 'evidence', 'toolresults'); }

function keepRaw(text) {
  try {
    const id = `tr_${crypto.createHash('sha1').update(text).digest('hex').slice(0, 10)}`;
    fs.mkdirSync(dir(), { recursive: true });
    const p = path.join(dir(), `${id}.txt`);
    if (!fs.existsSync(p)) fs.writeFileSync(p, text, 'utf8');
    return { id, path: p };
  } catch { return null; }
}

function limitOf(cfg) {
  const v = Number(cfg && cfg.contextBudget && cfg.contextBudget.toolResultChars);
  if (Number.isFinite(v) && v > 0) return v;
  return Math.round(DEFAULT_CHARS * require('./profile').outputScale(cfg && cfg.executionProfile, cfg && cfg.lainEffort));   // ECO, LAIN effort Low: tighter; Max: looser
}

/** THE TEXT THAT ENTERS THE CONVERSATION for one tool result. */
function bound(name, input, result, { cfg = {}, session = null } = {}) {
  const text = String(result && result.output == null ? '' : result.output);
  const limit = limitOf(cfg);
  if (!text || text.length <= limit || (result && result.isError)) return text;
  const explicitRange = name === 'read_file' && input && (input.limit != null || input.offset != null);
  if (explicitRange && text.length <= HARD_CAP) return text;
  const raw = keepRaw(text);
  const ref = raw ? `output saved at ${raw.path}` : 'the full output could not be saved';
  let kept;
  let how;
  if (name === 'read_file') {
    kept = text.slice(0, limit);
    const lines = kept.split('\n').length;
    kept = kept.slice(0, kept.lastIndexOf('\n') > 0 ? kept.lastIndexOf('\n') : kept.length);
    how = `read_file with offset:${lines} and limit for the next part`;
  } else if (LISTING.test(name)) {
    kept = text.slice(0, limit);
    kept = kept.slice(0, kept.lastIndexOf('\n') > 0 ? kept.lastIndexOf('\n') : kept.length);
    const total = text.split('\n').length; const shown = kept.split('\n').length;
    how = `${total - shown} more line(s) held back — narrow the pattern or path`;
  } else {
    const head = Math.floor(limit * (SHELL.test(name) ? 0.3 : 0.5));
    const tail = limit - head;
    const omitted = text.slice(head, text.length - tail).split('\n').length;
    kept = `${text.slice(0, head)}\n[… ${omitted} lines omitted …]\n${text.slice(-tail)}`;
    how = `${omitted} lines omitted`;
  }
  const note = `\n[${how} · ${ref}]`;
  if (session) {
    const l = session._toolBudget = session._toolBudget || [];
    l.push({ at: Date.now(), tool: name, chars: text.length, kept: kept.length, receipt: raw && raw.id });
    if (l.length > 100) l.shift();
  }
  return kept + note;
}

module.exports = { bound, keepRaw, DEFAULT_CHARS, HARD_CAP, dir };
