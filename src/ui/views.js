'use strict';

/** VIEWS — pure state → lines. */

const STATE = Object.freeze({
  READY: 'READY',
  WORKING: 'WORKING',
  THINKING: 'THINKING',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
  INTERRUPTING: 'INTERRUPTING',
  INTERRUPTED: 'INTERRUPTED',
  ERROR: 'ERROR',
  BLOCKED: 'BLOCKED',
  NEEDS_USER: 'NEEDS USER',
  NEEDS_AUTH: 'NEEDS AUTH',
  FAILED: 'FAILED',
  VERIFYING: 'VERIFYING',
  COMPLETE: 'COMPLETE',
  MAINTENANCE: 'MAINTENANCE',
});

const { P } = require('./paint');

/** Which colour a header state deserves. */
const STATUS_COLOUR = Object.freeze({
  READY: 'meta', WORKING: 'info', THINKING: 'info', RUNNING: 'info',
  WAITING: 'warn', INTERRUPTING: 'warn', INTERRUPTED: 'warn', VERIFYING: 'warn',
  'NEEDS USER': 'warn', 'NEEDS AUTH': 'warn', MAINTENANCE: 'warn',
  ERROR: 'bad', BLOCKED: 'bad', FAILED: 'bad',
  COMPLETE: 'ok',
});

function paintStatus(status, text) {
  const fn = P[STATUS_COLOUR[status] || 'plain'];
  return fn ? fn(text) : String(text);
}

/** Map the lifecycle + the LIVE EXECUTION PHASE onto one header state. */
function statusOf({ lifecycle, busy = false, awaitingUser = false, providerStatus = null, phase = null, interrupting = false, interrupted = false, failed = false, pendingCompletion = null } = {}) {
  if (interrupting) return STATE.INTERRUPTING;
  if (awaitingUser) return STATE.NEEDS_USER;
  // RESTING STATES, held until the user does something else.
  if (failed && !phase && !busy) return STATE.ERROR;
  if (interrupted && !phase && !busy) return STATE.INTERRUPTED;
  // THE PLAN IS FINISHED AND THE TASK IS NOT.
  if (pendingCompletion && !phase && !busy) return STATE.VERIFYING;
  if (providerStatus === 'MAINTENANCE' || providerStatus === 'DISABLED') return STATE.MAINTENANCE;
  if (phase) {
    switch (phase.phase) {
      case 'WAITING_MODEL': return STATE.THINKING;
      case 'RECEIVING': return STATE.WORKING;
      case 'RUNNING_TOOL': return STATE.RUNNING;
      case 'RETRYING': return STATE.WAITING;
      case 'ENDED': break;
      // ANY OTHER LIVE PHASE IS STILL WORK.
      default: return STATE.WORKING;
    }
  }
  if (busy) return STATE.WORKING;
  if (!lifecycle) return STATE.READY;
  switch (lifecycle.state) {
    case 'DONE': return STATE.COMPLETE;
    case 'BLOCKED': return STATE.BLOCKED;
    case 'NEEDS_USER': return STATE.NEEDS_USER;
    case 'NEEDS_AUTH': return STATE.NEEDS_AUTH;
    case 'FAILED': return STATE.FAILED;
    default: return STATE.READY;
  }
}

// THE LIVE ROW MOVED. It used to be built here (`liveLine`) and drawn at the top of the workspace, by either the pinned banner or the foot of the…

/** PROGRESS = COMPLETED work, never the current step number. */
/** HOW FAR ALONG THE WORK IS — moved to ui/progress.js when this file reached the architecture guard. */
const { livePlan, progressOf, bar, progressCompact } = require('./progress');

// THE TASK BANNER AND `objectiveLine` STOOD HERE, AND ARE GONE.

// The launch surfaces — splash, pipe banner, empty-state pane — live in launch.js: they describe the PROGRAM rather than the work, and keeping them…
const launch = require('./launch');

// WIDTH IS MEASURED VISIBLY, NOT BY `.length`.
const T = require('./text');
const clip = T.clip;
const pad = T.pad;

/** `dur(ms)` STOOD HERE — `1m04s` / `820ms` — and it is gone. */

// Path shortening and the project name are width maths too — one owner, in
// text.js, so the header, the launch screen and the title all agree.
const shortPath = T.shortPath;
const projectName = T.projectName;
const center = T.center;


// ------------------------------------------------------------------ header --

/** THE HEADER — one row, four facts, low prominence. */
function header({ cwd, model, account = '', effort = null, provider, connection, output = null, width = 80, run = null }) {
  const w = Math.max(20, width);

  // THE MODEL, WITHOUT ITS ROUTE.
  const id = require('./phrasing').routeOf(model, provider, connection);
  const name = projectName(cwd);
  const usage = outputLabel(output);

  // Assembled as PARTS with a drop order, the same way the live row sheds detail: at 60 columns something has to go, and which something is a decision…
  const who = account ? `${account} › ` : '';
  const what = `${who}${id.model || 'no model'}${effort ? ` (${effort})` : ''}`;
  const left = [P.head('LAIN'), P.plain(name), P.info(what)];
  const plainLeft = ['LAIN', name, what];
  const SEP = ' · ';
  let leftText = plainLeft.join(SEP);
  let leftPaint = left.join(P.meta(SEP));
  // THE RUN STATE (§4, §13): mode, RUNNING, elapsed, real step progress — see
  // ui/headerstate.js. It sheds before the model name does.
  const runParts = run && Array.isArray(run.parts) ? run.parts : [];
  let runText = runParts.join(SEP);
  const room = () => w - T.width(leftText) - (usage ? usage.length + 3 : 0) - (runText ? T.width(runText) + 3 : 0);
  if (room() < 1 && runText) runText = runParts.slice(0, 2).join(SEP);
  if (room() < 1) {
    // The project name goes before the model does: you can be in the wrong directory and recover, but sending a paragraph to the wrong model costs money…
    leftText = [plainLeft[0], plainLeft[2]].join(SEP);
    leftPaint = [left[0], left[2]].join(P.meta(SEP));
  }
  if (room() < 1) runText = '';
  const paintRun = runText ? ((run.tone === 'warn' ? P.warn : run.tone === 'info' ? P.info : P.meta) || P.meta)(runText) : '';
  const rightText = [runText, usage].filter(Boolean).join('   ');
  const rightPaint = [paintRun, usage ? P.meta(usage) : ''].filter(Boolean).join('   ');
  const gap = Math.max(1, w - T.width(leftText) - T.width(rightText));
  return [clip(leftPaint + ' '.repeat(gap) + rightPaint, w)];
}

/** `624` — THE OUTPUT TOKENS OF THE RESPONSE IN FRONT OF YOU. */
/** THE HORIZONTAL FRAME lives in ui/frame.js — see its header for why it is its own module. */
const { contentBounds, proseWidth, GUTTER_MAX, PROSE_SOFT } = require('./frame');

function outputLabel(output) {
  if (!output) return '0';
  const n = Math.max(0, Math.round(Number(output.tokens) || 0));
  // THREE SIGNIFICANT FIGURES — `847`, `1.0K`, `12.4K`, `999K`, `1.0M` — through the one formatter (ui/telemetry.js `tok`).
  const shown = require('./telemetry').tok(n);
  return output.measured ? shown : `~${shown}`;
}

// --------------------------------------------------------------- workspace --


/** ACTIVITY — a readable transcript of what LAIN did, and is doing now. */
/** THE TASK VIEW — what LAIN is doing, as an account rather than a log. */
// THE CONVERSATION lives in ui/conversation.js — the story of the task, replayed.
// This file keeps the chrome around it. Re-exported so callers keep one import.
const { activity, sameText } = require('./conversation');
/** How many completed rows PLAN shows before folding the older ones. */
const PLAN_DONE_ROWS = 8;


/** PLAN — the session-owned plan, with the active step obvious and completed steps kept visible as evidence. */
function planView({ plan, expanded = new Set(), width = 80, cursor = -1, evidence = null, detail = false }) {
  if (!plan || !plan.steps.length) {
    return [
      '',
      '  No plan yet.',
      '',
      '  Plans are optional — LAIN never requires one.',
      '  /plan step <text>   add a step',
      '  /plan done <note>   finish the open step',
    ];
  }
  const lines = [];
  const p = progressOf(plan);
  // THE COUNT RIDES ON THE HEADING
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const total = plan.steps.filter((s) => s.status !== 'dropped').length;
  lines.push(P.head('PLAN') + P.meta(`  ${done}/${total} done`));
  lines.push('');

  const visible = plan.steps.filter((s) => s.status !== 'dropped');
  const shownDone = visible.filter((s) => s.status === 'done').slice(-PLAN_DONE_ROWS);
  const shown = new Set(shownDone.map((s) => s.n));
  const olderDone = visible.filter((s) => s.status === 'done').length - shownDone.length;
  if (olderDone > 0) {
    lines.push(`  ✓ ${olderDone} earlier completed step(s)`);
    lines.push('');
  }
  for (const s of visible) {
    if (s.status === 'done' && !shown.has(s.n)) continue;
    if (s.status === 'dropped') continue;
    // WHAT `detail` IS FOR, AND WHY `/plan` PASSES IT
    const open = expanded.has(s.n)
      || (detail && (Boolean(s.note) || (Array.isArray(s.files) && s.files.length)));
    const sel = s.n === cursor ? '❯' : ' ';
    // Just the mark and the text.
    const paintMark = s.status === 'done' ? P.ok : s.status === 'active' ? P.info : P.meta;
    const text = s.status === 'active' ? P.key(clip(s.text, width - 6)) : clip(s.text, width - 6);
    lines.push(`${sel} ${paintMark(MARK[s.status] || MARK.todo)} ${text}`);

    if (open) {
      lines.push('');
      if (s.note) {
        lines.push('      Why');
        for (const l of wrap(s.note, width - 10)) lines.push(`        ${l}`);
        lines.push('');
      }
      const files = [];
      if (Array.isArray(s.files)) for (const f of s.files) files.push(f);
      if (evidence && typeof evidence.forStep === 'function') {
        for (const e of evidence.forStep(s.n).slice(0, 8)) files.push(e);
      }
      if (files.length) {
        lines.push('      Files');
        for (const f of files.slice(0, 8)) lines.push(`        ${clip(f, width - 10)}`);
        lines.push('');
      }
      lines.push('      Status');
      lines.push(`        ${s.status === 'done' ? 'complete' : s.status === 'active' ? 'working' : 'not started'}`);
      lines.push('');
    }
  }
  // HOW FAR ALONG, under the list it describes.
  if (p.known) {
    lines.push('');
    lines.push(`  ${P.meta(`STEP ${p.current}/${p.total}`)}`);
    lines.push(`  ${bar(p.percent, Math.max(8, Math.min(28, width - 12)))}  ${P.meta(`${p.percent}%`)}`);
  }
  if (plan.decisions && plan.decisions.length) {
    lines.push('');
    lines.push('  Decisions');
    for (const d of plan.decisions.slice(-5)) lines.push(`    · ${clip(d.text, width - 6)}`);
  }
  return lines;
}

// The feed (MODEL vs ACTIONS) and the input viewport are their own concerns,
// in their own modules. Re-exported below so callers keep one import.
const { MARK, phrase, verbOf } = require('./phrasing');
const {
  pushAction, pushModel, pushUser, pushExternal, pushMcp, pushNote, renderFeed, compactRuns, spokenCount,
} = require('./feed');
const { inputViewport, lineCount, wrapInput, caretRow } = require('./viewport');

/** Soft-wrap a sentence to a width, for the few places prose is shown. */
function wrap(text, width) {
  const raw = String(text || '');
  if (raw && !/\n/.test(raw) && require('./text').width(raw) <= width) return [raw];   // a line that fits keeps every space (D1)
  const words = raw.split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

// The change-oriented views (diff, files, output) live in panes.js — same rule, same signature, separate module because they read checkpoint bytes…
const panes = require('./panes');
const { wrap: wrapText } = require('./doc');

/** A ROW WHOSE VALUE IS CONTENT, WRAPPED INSTEAD OF CUT. */
function wrapUnder(lead, value, width) {
  const parts = wrapText(String(value == null ? '' : value), Math.max(12, width - lead.length - 2));
  return [lead + parts[0], ...parts.slice(1).map((p) => ' '.repeat(lead.length) + '  ' + p)];
}

// ------------------------------------------------------------- completion --

/** Derived entirely from task/evidence/checkpoint state — never narration. */
function completion({ session, checkpoints, cwd, verification = [], width = 80 }) {
  const lines = ['✓ TASK COMPLETE', ''];
  const obj = session && session.task ? session.task.objective.replace(/\s+/g, ' ') : '';
  if (obj) { lines.push(clip(obj, width)); lines.push(''); }
  // The SAME change facts the diff and files views read — one source, so the
  // completion screen can never claim a different set of files than the diff.
  const files = panes.changedFiles({ checkpoints, cwd });
  if (files.length) {
    lines.push('Changed');
    for (const f of files) lines.push(`  ${pad(f.kind, 9)} ${pad(clip(f.rel, width - 24), width - 22)}+${f.added} -${f.removed}`);
    lines.push('');
  }
  if (verification.length) {
    lines.push('Verification');
    for (const v of verification) {
      for (const r of wrapUnder(`  ${v.ok ? '✓' : '✗'} `, v.label, width)) lines.push(r);
    }
    lines.push('');
  }
  // HOW TO RUN IT, AND HOW TO TEST IT
  try {
    const cmds = require('./briefview').runCommands(cwd || process.cwd(), null);
    const tests = cmds.filter((c) => /^(test|check)/i.test(c.label));
    const runs = cmds.filter((c) => !tests.includes(c)).slice(0, 3);
    const howto = (label, list) => {
      lines.push(label);
      for (const c of list) for (const r of wrapUnder(`  ${pad(c.label, 9)} `, c.cmd, width)) lines.push(r);
      lines.push('');
    };
    if (runs.length) howto('How to run', runs);
    if (tests.length) howto('How to test', tests.slice(0, 2));
  } catch { /* the summary is still worth showing without it */ }
  const l = session && session.lifecycle;
  if (l) {
    lines.push(`  ${l.evidence ? l.evidence.toolCalls || 0 : 0} tool calls · ${l.evidence ? (l.evidence.filesChanged || []).length || l.evidence.filesChanged.size || 0 : 0} files changed`);
    lines.push('');
  }
  // ONE WAY OUT, BECAUSE THERE IS ONE SURFACE
  lines.push('');
  lines.push(P.meta('/changes — what changed · /verify — prove it · Esc — carry on'));
  return lines;
}

// `tabsLine` STOOD HERE — the numbered strip `[1 activity] 2 context 3 plan…`.

/** Which of the three viewport states is true. */
function viewportState({ stickToBottom, spoken = 0, anchorSpoken = 0 }) {
  if (stickToBottom) return 'FOLLOW_LIVE';
  return spoken > anchorSpoken ? 'NEW_ACTIVITY_PENDING' : 'MANUAL_SCROLL';
}

/** The right-hand hint on the tab strip. */
function scrollHint(lines, bodyRows, { stickToBottom, scroll, anchorSpoken }) {
  const total = Array.isArray(lines) ? lines.length : Number(lines) || 0;
  const spoken = (Array.isArray(lines) && Number(lines.spoken)) || 0;
  if (viewportState({ stickToBottom, spoken, anchorSpoken }) === 'NEW_ACTIVITY_PENDING') {
    return `↓ ${spoken - anchorSpoken} new · End`;
  }
  if (total <= bodyRows) return '';
  // THE KEY IS NAMED, BECAUSE THE WHEEL MAY NOT BE THERE
  if (scroll <= 0) return '↓ more · PgDn';
  if (scroll >= total - bodyRows) return '↑ more · PgUp';
  return '↕ more · PgUp/PgDn';
}

module.exports = {
  viewportState, scrollHint,
  MARK, phrase, verbOf,
  STATE, statusOf, progressOf, livePlan, bar, progressCompact, clip, pad, shortPath, projectName,
  contentBounds, proseWidth, GUTTER_MAX, PROSE_SOFT,
  header, activity, planView, completion, phrase, center, paintStatus,
  inputViewport, lineCount, wrapInput, caretRow, renderFeed, wrap, MARK,
  // owned by launch.js — the surfaces shown before any work exists
  welcome: launch.welcome,
  splashLines: launch.splashLines,
  bannerLines: launch.bannerLines,
  // owned by panes.js, re-exported so the screen has one place to look
  diffView: panes.diffView,
  filesView: panes.filesView,
  outputView: panes.outputView,
  changedFiles: panes.changedFiles,
  scanTree: panes.scanTree,
  unifiedish: panes.unified,
};
