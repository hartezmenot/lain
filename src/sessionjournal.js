'use strict';

/**
 * WHAT A SESSION IS DOING, AS EVENTS — one stream, written by the process that holds the session (2026-10-02).
 *
 *   <sessions>/.journal/<id>.jsonl   { seq, at, turn, type, … }   append-only, bounded
 *
 * The SAME event goes two ways at once:
 *   · to the window over the desktop channel (harnessapp/ipc.js `emit`) — Chat streams from it as deltas, never by
 *     rebuilding the conversation;
 *   · to the file — so a surface in ANOTHER process (a Harness watching a session its CLI runs), the phone gateway and
 *     a crash investigation read the same account. This replaced the Rust Guardian's copy of turn state.
 *
 * WHAT IS RECORDED IS FACTUAL ACTIVITY: turn begin/end, phases, tool start/end (name, target, ok, duration, one line),
 * visible answer text, usage. Reasoning CONTENT is never recorded or sent — only that the model is thinking.
 *
 * The file is a journal, not the session: the session file stays the record of the conversation, and nothing here is
 * needed to resume one.
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;
const TEXT_FLUSH_MS = 400;
const SUMMARY_MAX = 200;

const seqs = new Map();      // session → last seq written by this process
const pending = new Map();   // session → [line, …] awaiting one append
const textBuf = new Map();   // session → { turn, text, at, timer } (visible text is coalesced in the file only)

// A HIDDEN SUBFOLDER, beside the session files and never mistaken for one.
function dir() { return path.join(require('./config').sessionsDir(), '.journal'); }
function fileOf(id) { return path.join(dir(), `${id}.jsonl`); }

function nextSeq(id) {
  let n = seqs.get(id);
  if (n == null) {
    n = 0;
    try {
      const st = fs.statSync(fileOf(id));
      if (st.size) {
        const fd = fs.openSync(fileOf(id), 'r');
        const len = Math.min(st.size, 4096);
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, st.size - len);
        fs.closeSync(fd);
        const lines = b.toString('utf8').trim().split('\n');
        try { n = Number(JSON.parse(lines[lines.length - 1]).seq) || 0; } catch { n = 0; }
      }
    } catch { n = 0; }
  }
  n += 1;
  seqs.set(id, n);
  return n;
}

function flushFile(id) {
  const lines = pending.get(id);
  if (!lines || !lines.length) return;
  pending.delete(id);
  const f = fileOf(id);
  try {
    fs.mkdirSync(dir(), { recursive: true });
    try { if (fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, `${f}.1`); } catch { /* new file */ }
    fs.appendFileSync(f, lines.join(''));
  } catch { /* a journal that could not be written is not a turn failure */ }
}

function write(id, ev) {
  let lines = pending.get(id);
  if (!lines) { lines = []; pending.set(id, lines); setImmediate(() => flushFile(id)); }
  lines.push(`${JSON.stringify(ev)}\n`);
}

function flushText(id) {
  const t = textBuf.get(id);
  if (!t) return;
  textBuf.delete(id);
  if (t.timer) clearTimeout(t.timer);
  if (t.text) write(id, { seq: nextSeq(id), at: t.at, turn: t.turn, type: 'text', text: t.text });
}

function oneLine(s) {
  const line = String(s == null ? '' : s).split('\n').map((x) => x.trim()).find((x) => x && !/^\[via shell:/.test(x)) || '';
  let out = line.slice(0, SUMMARY_MAX);
  try { out = require('./redact').text(out); } catch { /* best effort */ }
  return out;
}

/**
 * RECORD ONE EVENT for this session: to the window now, to the journal on the next tick.
 * @param {object} app
 * @param {{type:string}} ev   turn.begin · phase · thinking · text · tool.start · tool.end · usage · turn.end · notice
 */
function note(app, ev) {
  const s = app && app.session;
  if (!s || !s.id || !ev || !ev.type) return null;
  const id = s.id;
  const out = { at: Date.now(), turn: app._turnId || null, ...ev };
  // TO THE WINDOW FIRST, unbuffered: a delta is only useful while it is fresh.
  try { require('./harnessapp/ipc').emit({ type: 'turn.event', session: id, ev: out }); } catch { /* no window */ }
  if (ev.type === 'text') {
    let t = textBuf.get(id);
    if (!t) { t = { turn: out.turn, text: '', at: out.at, timer: null }; textBuf.set(id, t); }
    t.text += String(ev.text || '');
    if (!t.timer) { t.timer = setTimeout(() => flushText(id), TEXT_FLUSH_MS); if (t.timer.unref) t.timer.unref(); }
    return out;
  }
  if (ev.type === 'thinking') return out;   // never persisted: a state, not a record (and never the content)
  flushText(id);
  out.seq = nextSeq(id);
  write(id, out);
  if (ev.type === 'turn.end') flushFile(id);
  return out;
}

/** Map a turn-loop event (turnevents.js) to a journal event, or null. */
function fromTurnEvent(ev, ctx = {}) {
  switch (ev && ev.type) {
    case 'text': return ev.chunk ? { type: 'text', text: ev.chunk } : null;
    case 'reasoning': return { type: 'thinking' };
    case 'tool_start': {
      let target = '';
      try { target = require('./turn').describeTarget(ev.name, ev.input) || ''; } catch { target = ''; }
      return { type: 'tool.start', id: ev.id || null, name: ev.name, target: target || targetOf(ev.input) };
    }
    case 'tool_result': return { type: 'tool.end', id: ev.id || null, name: ev.name, ok: !ev.isError, ms: ctx.startedAt && ev.id && ctx.startedAt[ev.id] ? Date.now() - ctx.startedAt[ev.id] : null, summary: oneLine(ev.output) };
    case 'usage_live': return null;
    case 'provider_failure': return { type: 'notice', level: 'error', text: oneLine(ev.message || ev.kind || 'the provider failed') };
    default: return null;
  }
}

function targetOf(input) {
  const i = input || {};
  return String(i.path || i.file || i.url || i.query || i.pattern || i.command || i.target || '').split('\n')[0].slice(0, 160);
}

/** Events after `seq` (both the current file and the rotated one), oldest first. */
function read(id, { after = 0, limit = 500 } = {}) {
  const rows = [];
  for (const f of [`${fileOf(id)}.1`, fileOf(id)]) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const e = JSON.parse(line); if ((e.seq || 0) > after) rows.push(e); } catch { /* a torn last line */ }
    }
  }
  rows.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return rows.slice(-limit);
}

/** The newest state of a session, from its journal: running?, the last phase, the current tool. */
function state(id) {
  const rows = read(id, { limit: 200 });
  let running = false; let phase = null; let tool = null; let turn = null; let endedAt = null; let stopReason = null;
  for (const e of rows) {
    if (e.type === 'turn.begin') { running = true; turn = e.turn; phase = null; tool = null; endedAt = null; stopReason = null; }
    else if (e.type === 'phase') phase = e.phase;
    else if (e.type === 'tool.start') tool = { name: e.name, target: e.target, at: e.at };
    else if (e.type === 'tool.end') tool = null;
    else if (e.type === 'turn.end') { running = false; endedAt = e.at; stopReason = e.stopReason || null; tool = null; }
  }
  return { running, phase, tool, turn, endedAt, stopReason, seq: rows.length ? rows[rows.length - 1].seq : 0 };
}

/** Write everything still buffered (process exit, tests). */
function flushAll() { for (const id of [...textBuf.keys()]) flushText(id); for (const id of [...pending.keys()]) flushFile(id); }

/** A deleted session takes its journal with it. */
function forget(id) { for (const f of [fileOf(id), `${fileOf(id)}.1`]) { try { fs.unlinkSync(f); } catch { /* none */ } } }

function _reset() { seqs.clear(); pending.clear(); for (const t of textBuf.values()) if (t.timer) clearTimeout(t.timer); textBuf.clear(); }

module.exports = { note, fromTurnEvent, read, state, flushAll, fileOf, forget, _reset };
