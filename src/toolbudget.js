'use strict';

/**
 * BOUNDED TOOL RESULTS — the one place large new evidence enters a request
 * (2026-09-24).
 *
 * A tool result is appended to the conversation once and then rides every
 * later request of the turn. The first time it is sent it is UNCACHED, whole —
 * so a 40 KB listing is 10k uncached tokens on the next request, and the
 * largest single cause of warm uncached input. Bounding it HERE, as it enters,
 * is the only point that does not rewrite history (a later rewrite would break
 * the prefix of every request after it).
 *
 * WHAT IS KEPT, per tool:
 *   read_file      an EXPLICIT range (offset/limit) is kept whole up to a hard
 *                  cap — the model asked for exactly that; a whole-file read
 *                  over the ceiling keeps its head and says how to page on
 *   grep / glob /  the first matches, the count held back, and how to narrow
 *   search / list
 *   shell / tests  head AND tail (failures and summaries live at the end)
 *   anything else  head and tail
 *
 * RAW EVIDENCE STAYS RECOVERABLE. The full output is kept under a receipt in
 * LAIN's home (never the project) and the note names it; an error result is
 * never cut, because a truncated failure is a different failure.
 * Ceilings are configurable (`cfg.contextBudget.toolResultChars`); the default
 * (24,000 chars ≈ 6k tokens) sits above what ordinary reads measure and below
 * the size that alone breaks the 8 % warm ceiling on a ~75k-token request.
 */

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
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CHARS;
}

/**
 * THE TEXT THAT ENTERS THE CONVERSATION for one tool result. Returns the
 * output unchanged when it is within the ceiling, an error, or an explicitly
 * requested range under the hard cap.
 */
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
