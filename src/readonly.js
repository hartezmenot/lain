'use strict';

/**
 * A DECLARED READ-ONLY TASK — THE CAPABILITY MASK.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES (Toralink, 2026-09-24).
 *
 * "READ-ONLY PROJECT INSPECTION. Do not modify any file…" was, to LAIN, a
 * paragraph of advisory prompt text and nothing else. Nothing in the runtime
 * knew the task was read-only: the write tools were offered, the hidden
 * wake-up told the model "the request asks for a change… make the change",
 * and the model — caught between the person's words and LAIN's — REFUSED the
 * investigation it had been asked for. Read-only was a sentence to argue with,
 * not a fact about what the task could do.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS.
 *
 *     WRITE DENIED  !=  TASK DENIED.
 *
 * A mask on CAPABILITIES, never on the task. Every read, search, symbol
 * lookup, index/architecture/wiring READ, git inspection, browser or desktop
 * observation and process observation stays available; what changes files,
 * installs, formats, commits or records project intelligence is refused at the
 * one door every tool call goes through (tools/index.js `execute`), and the
 * pure file writers are not even offered. A refusal names what is still
 * possible, so the model continues the investigation instead of stopping.
 *
 * ------------------------------------------------------------------------
 * WHEN IT IS ON.
 *
 * ONLY when the person DECLARED it (mode.declaresReadOnly) — never from a
 * keyword guess. mode.js is advisory by design: "compare these approaches"
 * reads as AUDIT, and a hard mask hung on that guess would block a task
 * somebody actually wanted done. A declaration is not a guess.
 *
 * TASK-SCOPED: a new task starts with the mask its own words set; "continue"
 * and a paste that joins the task keep it; a typed instruction that asks for a
 * change ("now fix it") lifts it, because the person has now said so.
 *
 * `.lain/` IS PART OF THE PROJECT. While the mask is on, the project's `.lain/`
 * is HELD (lainstore.hold): no task record, no index cache, no scratch file,
 * no architecture/wiring/vocabulary document is written — intelligence derived
 * during the inspection stays in memory, OBSERVED, and is not persisted.
 */

const KIND = 'READ_ONLY';

/** Writers the model is not even offered while the mask is on. */
const HIDDEN = new Set([
  'write_file', 'edit_file', 'apply_patch', 'append_file', 'insert_at', 'delete_range', 'move_file', 'delete_file',
  'replace_symbol', 'insert_near_symbol', 'remove_symbol', 'rename_symbol',
  'migration_activate', 'integrate_candidate', 'download_file',
]);

/**
 * OPERATIONS THAT RECORD PROJECT INTELLIGENCE. These tools are not `mutates`
 * (their reads are ordinary reads), so the mask works per operation.
 */
const WRITE_OPS = {
  concept: new Set(['define', 'forget']),
  architecture: new Set(['declare', 'verify', 'seed']),
  wiring: new Set(['connect', 'disconnect']),
  scratch: new Set(['promote']),
};

/** Mutating tools that stay usable for OBSERVATION, gated per call below. */
const SHELLS = new Set(['run_bash', 'run_powershell', 'run_cmd']);

/**
 * A SHELL COMMAND THAT ONLY LOOKS. Deliberately a small allowlist: every
 * segment of a pipeline must start with one of these, no redirection into a
 * file, no command substitution. Anything else is refused with the reason —
 * the model can still read, search and inspect with the dedicated tools.
 */
const LOOK = new RegExp('^(?:'
  + 'git\\s+(?:status|log|diff|show|blame|ls-files|ls-tree|rev-parse|describe|shortlog|cat-file|grep|branch(?:\\s+(?:-a|-r|--list|-v|-vv|--show-current))*\\s*$|remote(?:\\s+-v)?\\s*$|tag(?:\\s+(?:-l|--list))?\\s*$|config\\s+(?:--get|--list|-l)\\b)'
  + '|ls|dir|pwd|cat|type|head|tail|wc|tree|file|stat|du|df|which|where|whoami|hostname|uname|echo'
  + '|rg|grep|findstr|find(?![^|]*\\s-(?:delete|exec|execdir|ok|okdir|fprint\\w*|fls)\\b)'
  + '|node\\s+(?:--version|-v)\\s*$|npm\\s+(?:ls|list|view|--version|-v)\\b|python3?\\s+(?:--version|-V)\\s*$|pip\\s+(?:list|show|--version)\\b'
  + '|tasklist|netstat|ps|Get-Process|Get-ChildItem|gci|Get-Content|gc|Get-Item|Select-String|sls|Get-NetTCPConnection|Test-Path|Resolve-Path|Get-Location'
  + '|Select-Object|Where-Object|Sort-Object|Measure-Object|Format-Table|Format-List|Out-String|ForEach-Object'
  + ')(?:\\s|$)', 'i');

function looksOnly(command) {
  const c = String(command || '').trim();
  if (!c) return false;
  // Substitution runs a second command the allowlist never saw.
  if (/`|\$\(|<\(|>\(/.test(c)) return false;
  // Redirection INTO a file writes one; stderr to null or merged into stdout does not.
  const noSafe = c.replace(/\b2>\s*(?:&1|\/dev\/null|\$null|nul)\b/gi, ' ');
  if (/>/.test(noSafe)) return false;
  return noSafe.split(/\|\|?|&&|;|\r?\n/).map((s) => s.trim()).filter(Boolean).every((seg) => LOOK.test(seg));
}

// ---- the session's mask ----------------------------------------------------------

function of(session) { return (session && session.capabilityMask) || null; }
function active(session) { const m = of(session); return Boolean(m && m.kind === KIND); }

/**
 * Settle the mask for the input that just arrived (identify.js, once per input).
 * @param {object} verdict      task.js verdict (sameTask, kind) with `.mode`
 * @param {object} modeVerdict  mode.js verdict (declaredReadOnly)
 */
function apply(app, verdict, modeVerdict, text) {
  const s = app && app.session;
  if (!s) return null;
  const declared = Boolean(modeVerdict && modeVerdict.declaredReadOnly);
  let next = of(s);
  if (!verdict.sameTask) next = declared ? { kind: KIND, why: 'the person declared this task read-only', at: new Date().toISOString() } : null;
  else if (declared) next = { kind: KIND, why: 'the person declared this task read-only', at: new Date().toISOString() };
  // A TYPED instruction in the same task that asks for a change lifts it: the
  // person has now said so. A paste is content and never lifts it.
  else if (next && verdict.kind === require('./task').KIND.STEER && require('./wakeup').asksForChange(text)) next = null;
  s.capabilityMask = next;
  hold(s, Boolean(next));
  return next;
}

/** Keep the project's `.lain/` held exactly while the mask is on. */
function hold(session, on) {
  try { require('./lainstore').hold(session.cwd, session.id, on); } catch { /* bookkeeping */ }
}

/** Restore after a resume: a persisted mask re-holds its project. */
function restore(session) { if (active(session)) hold(session, true); }

// ---- the gate --------------------------------------------------------------------

/**
 * May this call run under the session's mask? Returns null when it may, or
 * the refusal to hand back as the tool result.
 */
function denies(name, input, session, isMutating) {
  if (!active(session)) return null;
  const op = String((input && input.op) || '');
  const ops = WRITE_OPS[name];
  let why = null;
  if (ops && ops.has(op)) why = `${name} ${op} records project intelligence in .lain/`;
  else if (SHELLS.has(name)) {
    const cmd = (input && (input.command || input.cmd || input.script)) || '';
    if (!looksOnly(cmd)) why = `that command is not a read-only inspection (allowed: git status/log/diff/show/blame, listings, file reads, searches, process lists)`;
  } else if (name === 'delegate') why = 'a delegated worker would not inherit this mask';
  else if (isMutating) why = `${name} changes things`;
  if (!why) return null;
  return `DENIED READ_ONLY_TASK: ${why}, and the person declared this task read-only. `
    + 'This refuses the WRITE, not the task: reading, listing, searching, symbols, the project index, '
    + 'architecture/wiring/concept reads, git inspection and observation all remain available. '
    + 'Continue the investigation and report what you find; if something genuinely cannot be established without a change, say exactly what.';
}

/** The tool vocabulary offered to the model under the mask. */
function offered(names, session) {
  if (!active(session)) return names;
  return names.filter((n) => !HIDDEN.has(n));
}

/** One line for the prompt's grounding block. */
function statusLine(session) {
  if (!active(session)) return '';
  return 'Capability mask: READ-ONLY (declared by the person). File writers are not offered and every change is refused — '
    + 'including running tests, installs, formatters, commits and recording architecture/wiring/vocabulary; '
    + 'reading, searching, symbols, the project index, git inspection and observation are available. '
    + 'The task itself is NOT refused — investigate and report. Nothing derived here is recorded to .lain/.';
}

function toJSON(session) { return { capabilityMask: of(session) }; }
function fromJSON(session, data) { session.capabilityMask = (data && data.capabilityMask) || null; }

module.exports = { KIND, HIDDEN, WRITE_OPS, looksOnly, of, active, apply, restore, denies, offered, statusLine, toJSON, fromJSON };
