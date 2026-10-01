'use strict';

/**
 * A COMMAND WRITTEN FOR ONE SHELL, SENT TO ANOTHER — noticed before it runs.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT (2026-09-29, a live Coding Agent transcript): PowerShell sent
 * through run_bash. `Get-ChildItem … | Select-Object …` fails in bash with
 * "command not found", the failure ended the turn, and the task sat paused
 * on a syntax slip the machine could have caught before running anything.
 *
 * THIS IS NOT A COMMAND CLASSIFIER, and it does not touch the command string
 * (shell.js: "If the model wants a shell, it gets a shell"). It answers one
 * narrow question — is this text UNAMBIGUOUSLY another shell's syntax? — from
 * markers that exist in only one of them:
 *
 *   PowerShell   a cmdlet in command position (Verb-Noun: Get-ChildItem,
 *                Select-Object, Write-Host …) or `$env:NAME`
 *   bash         `export NAME=`, `2>/dev/null` / `> /dev/null`, `[[ … ]]`,
 *                or grep / sed / awk / head / tail in a pipeline
 *
 * When it is, the command runs UNCHANGED in the shell it was written for and
 * the result says so ("ran with PowerShell: Get-ChildItem is a PowerShell
 * cmdlet"), which is the retry the model would have made — without executing
 * half a pipeline in the wrong interpreter first. Anything ambiguous runs
 * where it was sent, exactly as before.
 */

const VERBS = 'Get|Set|New|Remove|Select|Where|ForEach|Write|Test|Invoke|Start|Stop|Out|Format|Measure|Sort|Group|Import|Export|ConvertTo|ConvertFrom|Copy|Move|Rename|Add|Clear|Join|Split|Resolve|Push|Pop|Wait|Restart|Expand|Compress';
const CMDLET = new RegExp(`(?:^|[;|({]\\s*|&&\\s*)(?:${VERBS})-[A-Z][A-Za-z]+\\b`);
const PS_ENV = /\$env:[A-Za-z_]/;
const BASH_ONLY = /(?:^|;\s*|&&\s*)export\s+[A-Za-z_][A-Za-z0-9_]*=|[12]?>\s*\/dev\/null|\[\[\s|\|\s*(?:grep|sed|awk|head|tail|xargs)\b/;
const BASH_BLOCK = /\b(?:then|fi|done|esac)\b/;

/** The cmdlet or marker that decided, for the sentence on the result. */
function markerOf(re, command) { const m = re.exec(command); return m ? m[0].replace(/^[;|({&\s]+/, '').trim() : ''; }

/**
 * @param {'bash'|'powershell'|'cmd'} shell   the shell the call asked for
 * @param {string} command
 * @returns {null | { run: 'bash'|'powershell', why: string }}
 */
function mismatch(shell, command) {
  const c = String(command || '');
  if (!c.trim()) return null;
  if (shell === 'bash') {
    const ps = CMDLET.test(c) || PS_ENV.test(c);
    if (ps && !BASH_ONLY.test(c) && !BASH_BLOCK.test(c)) {
      const m = markerOf(CMDLET, c) || '$env:';
      return { run: 'powershell', why: `${m} is PowerShell syntax` };
    }
    return null;
  }
  if (shell === 'powershell') {
    if (BASH_ONLY.test(c) && !CMDLET.test(c) && !PS_ENV.test(c)) return { run: 'bash', why: `${markerOf(BASH_ONLY, c)} is bash syntax` };
    return null;
  }
  return null;
}

module.exports = { mismatch };
