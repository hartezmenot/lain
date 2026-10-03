'use strict';

/** `/copy` — TAKE WHAT IS ON THE SCREEN SOMEWHERE ELSE. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const T = require('./ui/text');

/** How much of any one section is worth carrying. Bounded, like everything. */
const MAX_CHARS = 200_000;

// ------------------------------------------------------------ sanitising ---

/** WHAT MAY REACH THE CLIPBOARD: only what the user can actually see. */
/** OSC — `ESC ] … BEL` or `ESC ] … ESC \`. The terminal title lives here. */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** DCS/PM/APC — `ESC P|^|_ … ESC \`. */
const DCS = /\x1b[P^_][^\x1b]*\x1b\\/g;
/** CSI — `ESC [ … final`. Covers SGR, erase, cursor motion and paste marks. */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** A bare two-character escape, once the structured forms are gone. */
const ESC1 = /\x1b[@-Z\\-_]/g;
/** Invisible, and a parse error each. Also the bidi overrides. */
const ZERO_WIDTH = /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;
/** Spaces that are not the space character. Replaced, never removed. */
const ODD_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
/** Control characters, keeping the two that are content: tab and newline. */
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Strip everything invisible from text on its way to the clipboard. */
function sanitize(s) {
  // A CREDENTIAL IS NOT COPIED, EITHER.
  let t = require('./redact').text(String(s == null ? '' : s));
  // ORDER MATTERS. The structured escapes go first: `\x1b[200~` is a CSI, and
  // removing the bare `\x1b` ahead of it would leave `[200~` as literal text.
  t = t.replace(OSC, '').replace(DCS, '').replace(CSI, '').replace(ESC1, '');
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(ZERO_WIDTH, '').replace(ODD_SPACE, ' ');
  return t.replace(CTRL, '');
}

// ------------------------------------------------------------- clipboard ---

/** Put text on the system clipboard. */
function toClipboard(raw) {
  // THE BOUNDARY. Every path out of LAIN calls this one, so it is the only
  // place that can promise the clipboard holds nothing invisible. See sanitize.
  const text = sanitize(raw);
  const attempts = process.platform === 'win32'
    ? [{ cmd: 'clip', args: [], encode: (t) => Buffer.from(t, 'ucs2') }]
    : process.platform === 'darwin'
      ? [{ cmd: 'pbcopy', args: [] }]
      : [
        { cmd: 'wl-copy', args: [] },
        { cmd: 'xclip', args: ['-selection', 'clipboard'] },
        { cmd: 'xsel', args: ['--clipboard', '--input'] },
      ];
  let lastError = 'no clipboard tool on this system';
  for (const a of attempts) {
    try {
      const r = spawnSync(a.cmd, a.args, {
        input: a.encode ? a.encode(text) : text,
        windowsHide: true,
        timeout: 5000,
      });
      if (r.error) { lastError = r.error.message; continue; }
      if (r.status === 0) return { ok: true, how: a.cmd };
      lastError = `${a.cmd} exited ${r.status}`;
    } catch (e) { lastError = e.message; }
  }
  return { ok: false, error: lastError };
}

/** READ the system clipboard. */
function fromClipboard() {
  const attempts = process.platform === 'win32'
    // AND THE OUTPUT ENCODING, WHICH IS NOT THE DEFAULT
    ? [{
      cmd: 'powershell',
      args: ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'],
    }]
    : process.platform === 'darwin'
      ? [{ cmd: 'pbpaste', args: [] }]
      : [
        { cmd: 'wl-paste', args: ['--no-newline'] },
        { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] },
        { cmd: 'xsel', args: ['--clipboard', '--output'] },
      ];
  let lastError = 'no clipboard tool on this system';
  for (const a of attempts) {
    try {
      const r = spawnSync(a.cmd, a.args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      if (r.error) { lastError = r.error.message; continue; }
      if (r.status === 0) {
        // PowerShell adds a trailing newline of its own; a paste should not silently gain one.
        const CR = String.fromCharCode(13);
        const LF = String.fromCharCode(10);
        let text = String(r.stdout || '').split(CR + LF).join(LF);
        if (text.endsWith(LF)) text = text.slice(0, -1);
        return { ok: true, text: text.slice(0, MAX_CHARS) };
      }
      lastError = `${a.cmd} exited ${r.status}`;
    } catch (e) { lastError = e.message; }
  }
  return { ok: false, error: lastError };
}

// --------------------------------------------------------------- sections ---

const plain = (lines) => lines.map((l) => T.strip(l)).join('\n');

/** WHAT EACH NAME MEANS. */
const SECTIONS = {
  /** THE QUESTION LAIN IS ASKING RIGHT NOW, as plain text. */
  question(app) {
    const panel = app.ui && app.ui.panel;
    if (!panel || !panel.visible || !panel.acceptsTyped) return null;
    const A = require('./ui/answer');
    const frame = panel.frame || {};
    const options = frame.options || [];
    const out = [String(frame.question || '').trim()];
    const marks = A.labels(options);
    options.forEach((o, i) => out.push(`  ${marks[i]}. ${A.optionText(o)}`));
    out.push('', A.hint(options, panel.takes));
    return out.join('\n');
  },

  task(app) {
    const s = app.session;
    if (!s.task) return null;
    const out = [`TASK  ${s.task.objective}`];
    const life = s.lifecycle && s.lifecycle.summary ? s.lifecycle.summary() : null;
    if (life) {
      out.push(`state ${life.state}${life.reason ? ` — ${life.reason}` : ''}`);
      out.push(`${life.turns} turns · ${life.toolCalls} tool calls · ${life.filesChanged} files changed`);
    }
    if (s.plan && s.plan.steps.length) {
      out.push('', 'PLAN');
      for (const st of s.plan.steps) out.push(`  [${st.status}] ${st.text}`);
    }
    if (s.task.steers && s.task.steers.length) {
      out.push('', 'STEERS');
      for (const st of s.task.steers) out.push(`  ⚑ ${st.text}`);
    }
    return out.join('\n');
  },

  activity(app) {
    const views = require('./ui/views');
    return plain(views.activity({
      session: app.session,
      transcript: app.render.transcript,
      liveActions: app.ui.liveActions || [],
      liveNarration: app.ui.liveNarration || [],
      width: 100,
    }));
  },

  output(app) {
    const outs = (app.ui && app.ui.outputs) || [];
    if (!outs.length) return null;
    return outs.map((o) => `$ ${o.command}\n${o.output}\n(exit ${o.exitCode == null ? '?' : o.exitCode})`).join('\n\n');
  },

  diff(app) {
    const panes = require('./ui/panes');
    const files = panes.changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd });
    if (!files.length) return null;
    const g = panes.groupChanges(files);
    const out = [];
    const list = (label, rows) => { if (rows.length) out.push(label, ...rows, ''); };
    list('ADDED', g.added.map((f) => `  ${f.rel}  +${f.added}`));
    list('MODIFIED', g.modified.map((f) => `  ${f.rel}  +${f.added} -${f.removed}`));
    list('REMOVED', g.removed.map((f) => `  ${f.rel}  -${f.removed}`));
    list('RENAMED', g.renamed.map((r) => `  ${r.from} → ${r.to}`));
    for (const f of files) {
      out.push(`--- ${f.rel} (${f.kind})`);
      for (const l of panes.unified(f.before, f.after, 2000)) out.push(l);
      out.push('');
    }
    return out.join('\n');
  },

  async audit(app) {
    const a = await require('./audit').audit(app.session.cwd);
    return plain(require('./audit').auditLines(a, 100, require('./audit').workState(app)));
  },

  async health(app) {
    const ph = require('./projecthealth');
    return plain(ph.projectHealthLines(await ph.assess(app.session.cwd, app), 100));
  },

  async rc(app) {
    const a = await require('./health').assess(app);
    const out = [`LAIN RC READINESS — ${a.summary.ready}/${a.summary.total} areas ready`];
    for (const g of a.groups) {
      out.push('', g.title.toUpperCase());
      for (const r of g.rows) out.push(`  ${r.state.sym} ${r.area.padEnd(24)} ${r.state.word}  ${r.note || ''}`);
    }
    return out.join('\n');
  },

  troubleshoot(app) {
    const t = require('./troubleshoot').lastReport(app);
    return t ? plain(require('./troubleshoot').reportLines(t, 100)) : null;
  },

  /** WHERE EVERYTHING STANDS RIGHT NOW — the thing you paste into a message when you are asking someone else about it. */
  status(app) {
    const rows = require('./diagnose').statusRows(app, { dim: (x) => x });
    const out = rows.map(([k, v]) => `${String(k).padEnd(14)} ${v}`);
    const views = require('./ui/views');
    const p = views.progressOf(views.livePlan(app.session));
    if (p.known) out.push(`${'progress'.padEnd(14)} step ${p.current}/${p.total} · ${p.percent}%`);
    if (app.pendingCompletion) out.push(`${'outstanding'.padEnd(14)} ${app.pendingCompletion}`);
    const life = app.session.lifecycle;
    if (life) out.push(`${'lifecycle'.padEnd(14)} ${life.state}${life.reason ? ' — ' + life.reason : ''}`);
    return ['STATUS', ...out].join('\n');
  },

  last(app) {
    const turns = app.session.turns || [];
    const last = turns[turns.length - 1];
    return last && last.text ? last.text : null;
  },

  /** THE DIAGNOSTIC EXPORT — what you paste when you go and ask somebody else. */
  context(app) {
    return require('./copysummary').context(app);
  },

  /** The whole session rather than the current task. `/copy context all`. */
  'context all': (app) => require('./copysummary').context(app, { all: true }),

  /** THE TASK SUMMARY — what bare `/copy` now means. */
  summary(app) {
    return require('./copysummary').summary(app);
  },

  /** The raw provider wire format, for when that IS the question. */
  messages(app) {
    const msgs = app.session.messages || [];
    if (!msgs.length) return null;
    return msgs.map((m) => {
      const head = m.role.toUpperCase() + (m.tool_call_id ? ` (${m.tool_call_id})` : '');
      return `--- ${head}\n${String(m.content || '')}`;
    }).join('\n\n');
  },
};

/** WITH NO ARGUMENT: THE TASK SUMMARY. */
const DEFAULT_ORDER = ['question', 'summary', 'last'];

async function collect(app, name) {
  const fn = SECTIONS[name];
  if (!fn) return { error: `nothing called "${name}" — try: ${Object.keys(SECTIONS).join(', ')}` };
  let text = null;
  try { text = await fn(app); } catch (e) { return { error: e.message }; }
  if (!text || !String(text).trim()) return { empty: true };
  // SANITISED HERE TOO, not only in `toClipboard`: when no clipboard tool answers, `runCommand` writes this text to a FILE instead, and a file full of…
  return { text: sanitize(text).slice(0, MAX_CHARS) };
}

// ----------------------------------------------------------------- command ---

async function runCommand(app, ctx = {}, { C } = {}) {
  const col = C || { dim: (s) => s, green: (s) => s, yellow: (s) => s };
  const want = String(ctx.rest || '').trim().toLowerCase();
  const w = (s) => app.render.write(s);

  let name = want;
  let got = null;
  // A KEYBOARD GETS THE COPY SHELF (ui/shelf.js)
  if (!name && app.ui && app.ui.enabled && app.input && app.input.isTTY) {
    const offer = [['question', 'Open question'], ['summary', 'Summary'], ['last', 'Last answer'], ['context', 'Context'], ['diff', 'Diff']];
    const ready = [];
    for (const [key, label] of offer) {
      const r = await collect(app, key);
      if (r && r.text) ready.push({ label, value: key, got: r });
    }
    if (ready.length > 1) {
      const picked = await app.ui.ask(require('./ui/shelf').shelf({ title: 'Copy', actions: ready.map(({ label, value }) => ({ label, value })) }));
      if (!picked) return;
      const hit = ready.find((x) => x.value === picked.action);
      name = hit.value;
      got = hit.got;
    }
  }
  if (!name) {
    // Pick the first thing that HAS something in it, and say which was chosen — silently copying "the task" when the user meant the answer is worse than…
    for (const candidate of DEFAULT_ORDER) {
      const r = await collect(app, candidate);
      if (r.text) { name = candidate; got = r; break; }
    }
    if (!got) { w(col.dim('  Nothing to copy yet.\n')); return; }
  } else {
    got = await collect(app, name);
  }

  if (got.error) { w(col.yellow(`  ${got.error}\n`)); return; }
  if (got.empty) { w(col.dim(`  ${name}: nothing to copy yet.\n`)); return; }

  const text = got.text;
  const lines = text.split('\n').length;
  const r = toClipboard(text);
  if (r.ok) {
    w(col.green(`  copied ${name}`) + col.dim(` — ${lines} line(s), ${text.length} characters\n`));
    return { name, chars: text.length, copied: true };
  }
  // THE FALLBACK IS A FILE, not an apology. The text still reaches the user.
  const file = path.join(os.tmpdir(), `lain-copy-${name}-${Date.now()}.txt`);
  try {
    fs.writeFileSync(file, text, 'utf8');
    w(col.yellow(`  clipboard unavailable (${r.error})`) + col.dim(` — wrote ${lines} line(s) to\n    ${file}\n`));
    return { name, chars: text.length, copied: false, file };
  } catch (e) {
    w(col.yellow(`  could not copy or save: ${r.error} / ${e.message}\n`));
    return { name, copied: false, error: e.message };
  }
}

module.exports = { runCommand, collect, toClipboard, fromClipboard, sanitize, SECTIONS, DEFAULT_ORDER };
