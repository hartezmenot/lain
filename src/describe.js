'use strict';

const fs = require('fs');

/** A newline, as a value. */
const NL = String.fromCharCode(10);

/** NAMING A TOOL CALL FOR A PERSON. */

/** The one-line human subject of a tool call — "src/auth/login.js:41-83", "npm test", "src". */
function describeTarget(name, input) {
  const i = input || {};
  // A background shell is named by its job id: `waited for shell · #3`.
  if (i.id && /^job_(wait|status|stop)$/.test(name)) return `#${String(i.id).replace(/^#/, '')}`;
  // A DISPATCHED CALL IS ABOUT ITS OPERATION.
  if (name === 'Agent') return `${i.type || 'general'} · ${String(i.description || i.prompt || '').replace(/\s+/g, ' ').slice(0, 50)}`;
  if (i.action && (name === 'computer' || name === 'preview')) {   // the one-tool surfaces (S5.1, S9) name their action
    const t = i.target || {};
    const what = t.text || t.name || t.selector || i.key || i.keys || i.title || (i.text ? `"${String(i.text).slice(0, 20)}"` : '') || (t.x != null ? `${t.x},${t.y}` : i.x != null ? `${i.x},${i.y}` : '');
    return what ? `${i.action} → ${String(what).slice(0, 30)}` : String(i.action);
  }
  if (i.op && name === 'computer') {
    const op = String(i.op).slice(0, 40);
    return i.target ? `${op} → ${String(i.target).slice(0, 30)}` : op;
  }
  // A SEARCH IS ABOUT WHAT IT LOOKED FOR.
  if (i.pattern && (name === 'grep' || name === 'glob')) {
    const pat = `/${String(i.pattern).slice(0, 40)}/`;
    const scope = i.path && String(i.path) !== '.' ? ` in ${String(i.path).replace(/\\/g, '/')}` : '';
    return pat + scope;
  }
  if (i.path) {
    const p = String(i.path).replace(/\\/g, '/');
    const from = i.start_line || i.offset;
    const to = i.end_line || (from && i.limit ? Number(from) + Number(i.limit) - 1 : null);
    return from ? `${p}:${from}${to ? '-' + to : '+'}` : p;
  }
  if (i.command) return String(i.command).replace(/\s+/g, ' ').slice(0, 60);
  // A PROGRAM RUN DIRECTLY IS ABOUT THE PROGRAM.
  if (i.program) {
    const args = Array.isArray(i.args) ? i.args.join(' ') : '';
    return `${String(i.program)}${args ? ` ${args}` : ''}`.replace(/\s+/g, ' ').slice(0, 60);
  }
  // LOOKING SOMETHING UP IS ABOUT WHAT WAS LOOKED UP
  if (i.url && name === 'web_fetch') {
    try {
      const u = new URL(String(i.url));
      const tail = u.pathname === '/' ? '' : u.pathname;
      return `${u.hostname.replace(/^www\./, '')}${tail}`.slice(0, 60);
    } catch { return String(i.url).slice(0, 60); }
  }
  if (i.pattern) return `/${String(i.pattern).slice(0, 40)}/`;
  if (i.question) return String(i.question).replace(/\s+/g, ' ').slice(0, 60);
  // THE HARNESS TOOLS NAME THEIR SUBJECT TOO
  if (name === 'verify_task') {
    const reqs = Array.isArray(i.requirements) ? i.requirements : [];
    const first = reqs.find((r) => r && (r.what || r.name));
    const what = first ? String(first.what || first.name).replace(/\s+/g, ' ').slice(0, 44) : '';
    const more = reqs.length > 1 ? ` +${reqs.length - 1}` : '';
    return what ? what + more : (i.name ? String(i.name).slice(0, 60) : '');
  }
  if (name === 'service_check') return i.name ? String(i.name).slice(0, 60) : 'all services';
  if (i.goal) {
    const goal = String(i.goal).replace(/\s+/g, ' ').slice(0, 40);
    // The URL is what makes two observations of the same KIND distinguishable.
    if (i.url) {
      try {
        const u = new URL(String(i.url));
        return `${goal} → ${u.host}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 60);
      } catch { /* an unparseable url is not worth losing the goal over */ }
    }
    return i.selector ? `${goal} → ${String(i.selector).slice(0, 20)}`.slice(0, 60) : goal;
  }
  return '';
}

/** The first meaningful line of a tool result, bounded for display. */
function firstLine(output) {
  const s = String(output == null ? '' : output);
  // THE `[via ...]` STAMP IS ADDRESSED TO THE MODEL, NOT TO A PERSON
  const lines = s.split('\n').map((x) => x.trim()).filter(Boolean);
  const line = lines.find((x) => !/^\[via /.test(x)) || '';
  return line.slice(0, 100);
}

/** WHAT A COMPLETELY SILENT TURN IS TOLD TO THE USER. */
const EMPTY_ANSWER = 'the model returned no text and called no tools — the request '
  + 'succeeded and the answer was empty. Some models stream their prose as `reasoning`; '
  + 'if this route does that, its output is arriving in a field this provider protocol '
  + 'does not read.';

/** Results at or under this length are messages to the user, not data. */
const BRIEF_RESULT = 160;

/** HOW MANY LINES THIS CALL ADDED AND REMOVED, from its own checkpoint. */
function editSize(checkpoints, checkpoint) {
  if (!checkpoints || !checkpoint) return {};
  const id = checkpoint.id || checkpoint;
  const entry = ((checkpoints.entries || []).find((e) => e.id === id)) || null;
  if (!entry || !entry.files || !entry.files.length) return {};
  const { countChanges, linesOf } = require('./ui/panes');
  let added = 0;
  let removed = 0;
  for (const f of entry.files) {
    const before = f.bytes ? f.bytes.toString('utf8') : null;
    let after = null;
    try { after = fs.readFileSync(f.path, 'utf8'); } catch { after = null; }
    if (before === after) continue;
    // ONE COUNT OF LINES FOR EVERY SURFACE (ui/panes.js `linesOf`): the row and
    // `/diff` must not disagree about a trailing newline.
    const n = countChanges(before == null ? [] : linesOf(before),
      after == null ? [] : linesOf(after));
    added += n.added;
    removed += n.removed;
  }
  return (added || removed) ? { added, removed } : {};
}

/** ONE FINISHED CALL, as the ACTIVITY view needs it. */
const SHELLISH = /^(?:run_(?:bash|powershell|cmd)|python_run|process_run)$/;
const TAIL_LINES = 4;

/** The last few output lines of a command, minus LAIN's own bracket markers. */
function outputTail(out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, ''))
    // The `[via …]` stamp is for the model (see firstLine); LAIN's bracket markers are not output.
    .filter((l) => l.trim() && !/^\[via /.test(l.trim()) && !/^\[(?:exit -?\d+|no output|no match|stderr|stdout)\]:?$/i.test(l.trim()));
  return { tail: lines.slice(-TAIL_LINES).map((l) => l.slice(0, 200)), lines: lines.length };
}

function actionRecord(call, result, { step = 0, ms = 0, reused = false, added = 0, removed = 0 } = {}) {
  const out = String(result && result.output == null ? '' : result.output);
  return {
    name: call.name,
    target: describeTarget(call.name, call.input),
    ok: !(result && result.isError),
    // REFUSED BEFORE IT RAN — a PLAN/MANUAL/permission denial is not a failed check.
    ...(result && result.denied ? { denied: true } : {}),
    // PRODUCED AN ARTIFACT (a Cowork workbook, document…) — a change, though not a project file.
    ...(result && result.artifact && !result.isError ? { artifact: true } : {}),
    step,                      // which model step this call belonged to
    ms,
    exitCode: result && result.exitCode != null ? result.exitCode : null,   // a shell row says it (ui/feed.js)
    reused: Boolean(reused),
    // In TTY mode raw tool output no longer streams to stdout (the Screen owns it), so without this a person could see THAT a tool ran but never what it…
    note: firstLine(result && result.output),
    // A COMMAND'S LAST WORDS: the tail of its output and how many lines came before it, so the row can show what the command said at the end…
    ...(SHELLISH.test(call.name) ? outputTail(out) : {}),
    // A SHORT result is a message to the user ("The user chose: Beta", "no such file"); a long one is data for the model (a file's contents).
    brief: out.length <= BRIEF_RESULT,
    // A call that names a FILE already says what it acted on; its output is that file's data, which belongs in the model's context and not in the activity…
    file: Boolean(call.input && call.input.path),
    // AND WHICH FILE, because `file` is only whether
    path: (call.input && call.input.path) || null,
    ...(result && result.meta && result.meta.job ? { job: String(result.meta.job) } : {}),   // started a background job
    // HOW BIG THE CHANGE WAS — see `editSize`. Zero for everything that did not
    // change a file, which is what the drawing already treats as absent.
    added: Number(added) || 0,
    removed: Number(removed) || 0,
  };
}

/** The live row's label for a call: a shell's own description, or a job's (`tests · #3`); null for the tool's own words. */
function liveLabel(name, input, app) {
  const i = input || {};
  if (typeof i.description === 'string' && i.description.trim()) return i.description.trim();
  const id = i.id != null ? String(i.id).replace(/^#/, '') : '';
  const j = id && /^job_/.test(name) && app && app._jobs ? app._jobs.get(id) : null;
  return j && j.label ? `${j.label} · #${j.id}` : null;
}

module.exports = { liveLabel, outputTail, describeTarget, firstLine, actionRecord, editSize, EMPTY_ANSWER, BRIEF_RESULT };