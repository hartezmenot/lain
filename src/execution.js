'use strict';

/** THE EXECUTION LAYER — which shell, which directory, and what actually failed. */

const fs = require('fs');
const path = require('path');

/** ONE WORD FOR ONE FACT. */
const { STATE: JOB_STATE } = require('./jobs');

// --------------------------------------------------------- shell identity ---

/** WHICH `bash` ON WINDOWS. */
let _bashPath;

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

function isWslShim(p) {
  // The launcher lives in System32 (or its 32-bit redirect). A genuine bash
  // never does.
  return /[\\/]system32[\\/]bash\.exe$/i.test(p) || /[\\/]syswow64[\\/]bash\.exe$/i.test(p);
}

function findBash() {
  if (_bashPath !== undefined) return _bashPath;
  if (process.platform !== 'win32') { _bashPath = '/bin/sh'; return _bashPath; }

  const candidates = [
    process.env.LAIN_BASH,                                    // an explicit override wins outright
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    'C:\\msys64\\usr\\bin\\bash.exe',
    'C:\\cygwin64\\bin\\bash.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    if (exists(c)) { _bashPath = c; return _bashPath; }
  }

  // Nothing known found. Walk PATH ourselves so the WSL shim can be SKIPPED
  // rather than silently accepted, which is the whole failure.
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'bash.exe');
    if (isWslShim(p)) continue;
    if (exists(p)) { _bashPath = p; return _bashPath; }
  }

  // Genuinely no POSIX shell on this machine. Fall back to the plain name so
  // the error the model sees comes from the OS, not from a guess of ours.
  _bashPath = 'bash.exe';
  return _bashPath;
}

/** WHICH `powershell` — AND IT IS THE DIFFERENCE BETWEEN TWO LANGUAGES. */
let _pwshPath;

/** IS THERE AN EXECUTABLE HERE — asked in the one way that works for `pwsh`. */
function executable(p) {
  if (!p) return false;
  try { if (fs.existsSync(p)) return true; } catch { /* fall through */ }
  try {
    fs.lstatSync(p);
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function findPowerShell() {
  if (_pwshPath !== undefined) return _pwshPath;
  const explicit = process.env.LAIN_POWERSHELL;
  if (explicit) { _pwshPath = explicit; return _pwshPath; }
  if (process.platform !== 'win32') { _pwshPath = 'pwsh'; return _pwshPath; }

  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (executable(c)) { _pwshPath = c; return _pwshPath; }

  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'pwsh.exe');
    if (executable(p)) { _pwshPath = p; return _pwshPath; }
  }

  // No PowerShell 7 on this machine.
  _pwshPath = 'powershell.exe';
  return _pwshPath;
}

/** Is the resolved PowerShell one that understands `&&`? Read by annotate. */
function powerShellIsLegacy() {
  // Bare name or full path — `powershell.exe` is 5.1 either way, and `pwsh` is never 5.1.
  return /^powershell\.exe$/i.test(path.basename(String(findPowerShell())));
}

/** WHICH PROGRAM RUNS A COMMAND, and the arguments that precede it. */
/** A FALSE `PASSED` IN A HANDOVER: LOOKED FOR, NOT FOUND */
function shellPrefix(shell) {
  if (shell === 'powershell') {
    return [findPowerShell(), ['-NoProfile', '-NonInteractive', '-Command']];
  }
  if (shell === 'cmd') return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c']];
  if (shell === 'fish') return ['fish', ['-c']];
  return [findBash(), ['-c']];
}

/** The shells this layer can name, and the one word each is known by. */
const SHELLS = ['powershell', 'cmd', 'bash', 'fish'];

// --------------------------------------------------------- classification ---

/** WHAT KIND OF FAILURE THIS WAS. */
const CLASS = {
  OK: 'OK',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  NO_SUCH_PATH: 'NO_SUCH_PATH',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SHELL_SYNTAX: 'SHELL_SYNTAX',
  SHELL_MISSING: 'SHELL_MISSING',
  TIMED_OUT: JOB_STATE.TIMED_OUT,
  INTERRUPTED: 'INTERRUPTED',
  /** THE PROGRAM'S OWN SOURCE IS WRONG — a syntax, parse or compile error reported by the interpreter or compiler about a FILE, not about the command line. */
  SOURCE_ERROR: 'SOURCE_ERROR',
  /** SOMETHING THE PROGRAM IMPORTS IS NOT INSTALLED. */
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',
  APPLICATION_ERROR: 'APPLICATION_ERROR',
};

/** WHAT THE PROGRAM SAID ABOUT ITSELF, checked BEFORE the shell's own words. */
const SOURCE_SIGNS = [
  // A missing import/module, in the words each ecosystem uses for it.
  [/ModuleNotFoundError|ImportError: cannot import name|No module named/i, CLASS.DEPENDENCY_MISSING,
    'A module the program imports is not installed in the environment it ran in. Installing it, or activating the right environment, is the fix — the source is not wrong.'],
  [/Cannot find module|ERR_MODULE_NOT_FOUND|Module not found: Error: Can't resolve/i, CLASS.DEPENDENCY_MISSING,
    'A module this file requires cannot be resolved. Either it is not installed, or the specifier does not match a real path.'],
  [/\bno matching distribution found|could not find a version that satisfies/i, CLASS.DEPENDENCY_MISSING, null],
  // The program's own parse/compile failure, naming a file or a line.
  [/^\s*File "[^"]+", line \d+/m, CLASS.SOURCE_ERROR,
    'The interpreter rejected the FILE it was given, at the line it names. The command ran; the source is what is wrong.'],
  [/\b(?:SyntaxError|IndentationError|TabError)\b/, CLASS.SOURCE_ERROR,
    'The interpreter rejected the FILE it was given. The command line parsed fine — this is the program\'s own syntax, not the shell\'s.'],
  [/\berror\[E\d+\]|\berror TS\d+\b|\berror CS\d+\b/, CLASS.SOURCE_ERROR,
    'The compiler rejected the source. The diagnostic names the file and position.'],
  [/\b(?:cannot find symbol|expected ';'|unexpected end of input|parse error before)\b/i, CLASS.SOURCE_ERROR, null],
];

/** THE SHELL'S OWN WORDS, per shell. */
const SIGNS = {
  powershell: [
    // BOTH WORDINGS, BECAUSE THERE ARE TWO POWERSHELLS
    [/is not recognized as (?:(?:the|a) name of )?a cmdlet|CommandNotFoundException/i, CLASS.COMMAND_NOT_FOUND,
      'PowerShell resolves a bare name against cmdlets, functions, aliases and PATH. A name it cannot find is not on any of them.'],
    [/The token '&&' is not a valid statement separator|token '\|\|' is not a valid/i, CLASS.SHELL_SYNTAX,
      'Windows PowerShell 5.1 has no && or || operator; they were added in PowerShell 7 (pwsh). In 5.1, `;` runs the next statement unconditionally, and there is no built-in "only if the last one succeeded" separator — $LASTEXITCODE or $? carries that.'],
    [/ParserError|Missing (?:closing|expression|argument)|Unexpected token|Unrecognized token/i, CLASS.SHELL_SYNTAX,
      'PowerShell parsed the line and rejected it before running anything, so nothing in the command executed.'],
    [/ItemNotFoundException|Cannot find path|because it does not exist/i, CLASS.NO_SUCH_PATH,
      'The path was resolved against the CWD reported above.'],
    [/UnauthorizedAccessException|Access to the path .* is denied|Access is denied/i, CLASS.PERMISSION_DENIED, null],
    [/A positional parameter cannot be found|Cannot bind parameter|Missing an argument for parameter/i, CLASS.SHELL_SYNTAX,
      'PowerShell binds arguments to named parameters. A POSIX-style flag such as -rf or /s is read as a parameter name, not as text passed to a program.'],
  ],
  cmd: [
    [/is not recognized as an internal or external command/i, CLASS.COMMAND_NOT_FOUND, null],
    [/The system cannot find the (?:path|file) specified/i, CLASS.NO_SUCH_PATH,
      'The path was resolved against the CWD reported above.'],
    [/Access is denied/i, CLASS.PERMISSION_DENIED, null],
    [/was unexpected at this time|The syntax of the command is incorrect/i, CLASS.SHELL_SYNTAX,
      'cmd.exe rejected the line. Its quoting rules are not PowerShell\'s and not bash\'s: single quotes are literal characters, and % has meaning.'],
  ],
  bash: [
    [/: command not found/i, CLASS.COMMAND_NOT_FOUND, null],
    // `bash: ./deploy.sh: No such file or directory` is the SHELL failing to find the thing it was asked to run — a missing command.
    [/^(?:\S*[\\/])?(?:bash|sh|fish|dash)(?:\.exe)?(?:: line \d+)?: [^\n]*: No such file or directory/im,
      CLASS.COMMAND_NOT_FOUND, null],
    [/syntax error near unexpected token|unexpected EOF while looking for matching|syntax error: unexpected end of file/i, CLASS.SHELL_SYNTAX,
      'bash parsed the line and rejected it before running anything.'],
    [/No such file or directory/i, CLASS.NO_SUCH_PATH,
      'The path was resolved against the CWD reported above.'],
    [/Permission denied/i, CLASS.PERMISSION_DENIED, null],
  ],
  fish: [
    [/Unknown command|command not found/i, CLASS.COMMAND_NOT_FOUND, null],
    [/Missing end to balance|Unexpected end of string/i, CLASS.SHELL_SYNTAX, null],
    [/No such file or directory/i, CLASS.NO_SUCH_PATH, null],
    [/Permission denied/i, CLASS.PERMISSION_DENIED, null],
  ],
};

/** Exit codes that name a cause on their own, when the text did not. */
const BY_CODE = {
  127: [CLASS.COMMAND_NOT_FOUND, null],                 // POSIX: not found
  126: [CLASS.PERMISSION_DENIED, 'The file was found but is not executable.'],
  9009: [CLASS.COMMAND_NOT_FOUND, null],                // cmd.exe: not found
};

/** A COMMAND WRITTEN FOR A DIFFERENT SHELL — checked only once it has FAILED. */
const MISMATCH = [
  // CONDITIONAL, BECAUSE THE ANSWER DEPENDS ON THE MACHINE
  ['powershell', /(?:^|[\s;|(])&&(?:\s|$)/,
    (r, verdict) => {
      // TWO WAYS FOR THIS TO BE TRUE, and it must be true to be printed.
      if (!powerShellIsLegacy() && verdict !== CLASS.SHELL_SYNTAX) return null;
      return '`&&` in a PowerShell command. Windows PowerShell 5.1 does not have it; pwsh 7+ does'
        + (powerShellIsLegacy()
          ? ', and 5.1 is what is installed here — use `;`, or run this with run_cmd, where `&&` works.'
          : '.');
    }],
  ['powershell', /2>\s*\/dev\/null|>\s*\/dev\/null/,
    '`/dev/null` in a PowerShell command. On Windows the equivalent sink is `$null`, and `/dev/null` is read as a path.'],
  ['powershell', /\brm\s+-[rf]|\bls\s+-[la]|\bgrep\b|\bcat\b\s+[^|]*\|/,
    'A POSIX command in a PowerShell command line. PowerShell has aliases for some of them (ls, cat, rm) but NOT their flags — `rm -rf` binds `-rf` as a parameter name and fails.'],
  // NOTHING FOR `&&` UNDER cmd, deliberately: cmd.exe HAS it.
  ['cmd', /'[^']*'/,
    "Single quotes in a cmd.exe command line. cmd does not treat ' as a quote character — it is passed through literally."],
  ['cmd', /2>\s*\/dev\/null/,
    '`/dev/null` in a cmd command. The equivalent sink is `NUL`.'],
  // ONE OR TWO LETTERS, not three.
  ['bash', /(?:^|\s)\/[a-zA-Z]{1,2}(?:\s|$)/,
    'A `/x` style flag in a bash command. bash reads a leading `/` as an absolute path, not as a switch — Windows programs take `/s`, POSIX ones take `-s`.'],
  ['bash', /\$env:|Get-\w+|Write-Host|\$null\b/,
    'PowerShell syntax in a bash command line.'],
];

/** Classify one finished execution. */
function classify(r = {}) {
  if (r.interrupted) return { class: CLASS.INTERRUPTED, fact: null, mismatch: null };
  if (r.timedOut) {
    // A TIMEOUT USED TO SAY NOTHING, and that is why it cost a turn
    return {
      class: CLASS.TIMED_OUT,
      fact: 'The command was still running when its time ran out and was killed, so this says nothing '
        + 'about whether it would have succeeded. If it is genuinely long-running, start it with '
        + 'run_background and follow it with job_status — a foreground command holds the whole turn. '
        + 'Raise `timeout_ms` instead only when you expect it to finish shortly after the limit.',
      mismatch: null,
    };
  }
  if (r.startFailed) {
    return {
      class: CLASS.SHELL_MISSING,
      fact: r.shell === 'bash' && process.platform === 'win32'
        ? 'This is Windows and no POSIX bash was resolvable. powershell and cmd are present on every Windows host.'
        : 'The interpreter itself could not be started, so the command never ran.',
      mismatch: null,
    };
  }
  const code = r.exitCode;
  if (code === 0) return { class: CLASS.OK, fact: null, mismatch: null };
  // A SEARCH'S EXIT 1 IS ITS ANSWER.
  if (r.noMatch || r.noneSearched) return { class: CLASS.OK, fact: null, mismatch: null };

  const shell = SHELLS.includes(r.shell) ? r.shell : (r.shell === 'sh' ? 'bash' : null);
  // stderr first, always.
  const text = String(r.stderr || '').trim() || String(r.stdout || '').trim();

  let verdict = null;
  let fact = null;
  // THE PROGRAM IS ASKED FIRST.
  if (text) {
    for (const [re, klass, why] of SOURCE_SIGNS) {
      if (!re.test(text)) continue;
      verdict = klass;
      fact = why;
      break;
    }
  }
  if (!verdict && shell && text) {
    for (const [re, klass, why] of SIGNS[shell]) {
      if (!re.test(text)) continue;
      verdict = klass;
      fact = why;
      break;
    }
  }
  if (!verdict && BY_CODE[code]) [verdict, fact] = BY_CODE[code];
  if (!verdict) verdict = CLASS.APPLICATION_ERROR;

  // The mismatch note is attached to any failure, whatever the classification — a bash command carrying `/s` can fail as NO_SUCH_PATH, and the reason it…
  let mismatch = null;
  if (shell && r.command) {
    for (const [which, re, note] of MISMATCH) {
      if (which !== shell || !note || !re.test(String(r.command))) continue;
      // A note may be a sentence or a question about this machine. See the
      // PowerShell `&&` entry for why the second kind had to exist.
      const said = typeof note === 'function' ? note(r, verdict) : note;
      if (!said) continue;
      mismatch = said;
      break;
    }
  }
  return { class: verdict, fact, mismatch };
}

// -------------------------------------------------------------- reporting ---

/** WHERE AND HOW THIS RAN — the two facts a model was previously left to remember across a turn, and the two it most often got wrong. */
function contextLine({ shell = '', cwd = '', executable = '', note = '' } = {}) {
  const bits = [];
  if (shell) bits.push(shell);
  else if (executable) bits.push(executable);
  if (note) bits.push(note);
  if (cwd) bits.push(`cwd=${cwd}`);
  return bits.join(' · ');
}

/** THE FAILURE BLOCK. Appended to a failing result and to nothing else. */
function failureBlock(verdict, { exitCode = null } = {}) {
  if (!verdict || verdict.class === CLASS.OK) return '';
  const lines = [`CLASSIFICATION: ${verdict.class}${exitCode != null ? ` (exit ${exitCode})` : ''}`];
  if (verdict.fact) lines.push(verdict.fact);
  if (verdict.mismatch) lines.push(`SHELL MISMATCH: ${verdict.mismatch}`);
  return `\n[${lines.join('\n ')}]`;
}

/** The whole annotation for one finished execution: the failure block, plus whatever the attempt ledger already knows about this exact command. */
function annotate(r, { attempts = null } = {}) {
  const verdict = classify(r);
  let out = failureBlock(verdict, { exitCode: r.exitCode });
  const entry = {
    command: r.command,
    shell: r.shell,
    cwd: r.cwd,
    classification: verdict.class,
    exitCode: r.exitCode,
  };
  if (attempts && verdict.class !== CLASS.OK) {
    // Asked BEFORE recording, so the numbered history is history — but with
    // this attempt handed over, so the conclusions cover what just happened.
    const prior = attempts.note({ command: r.command, shell: r.shell, cwd: r.cwd, current: entry });
    if (prior) out += `\n${prior}`;
  }
  if (attempts) attempts.record(entry);
  return { text: out, verdict };
}

/** PUT THE ANNOTATION WHERE IT WILL ACTUALLY BE READ — directly under the provenance line, ahead of whatever the command printed. */
function leadWith(output, block) {
  if (!block) return output;
  const text = String(output == null ? '' : output);
  const nl = text.indexOf('\n');
  if (nl < 0) return `${text}${block}`;
  return `${text.slice(0, nl)}${block}${text.slice(nl)}`;
}

module.exports = {
  CLASS, SHELLS, SIGNS, MISMATCH, BY_CODE,
  classify, annotate, failureBlock, contextLine, leadWith,
  shellPrefix, findBash, isWslShim, findPowerShell, powerShellIsLegacy,
};
