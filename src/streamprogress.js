'use strict';

/**
 * IS THE MODEL DOING ANYTHING? — measured per request, from the wire.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT (reported 2026-09-23). The clock moved and nothing said whether
 * the model was alive. The activity box said THINKING for every moment a
 * request was open — before the first byte, while hidden reasoning streamed,
 * while a 10 KB `edit_file` argument arrived — and the only thing that could
 * tell those apart, the stream itself, was parsed and thrown away: tool-call
 * argument deltas were accumulated silently and surfaced only as one
 * `tool_calls` event at the very end.
 *
 * ------------------------------------------------------------------------
 * ONE MUTABLE RECORD PER REQUEST, NOT AN EVENT PER CHUNK. provider.js writes
 * the byte-level facts (bytes, data events, tool-argument bytes, hidden
 * thinking deltas); turn.js writes the text/reasoning facts; the screen READS
 * the record on the frames it already draws (the work clock ticks every
 * second). No redraw storm, no new event type through the turn loop, and a
 * frame always sees the current numbers.
 *
 * ------------------------------------------------------------------------
 * THE WORDS, and what each one may claim:
 *
 *   WAITING         request sent, no data yet — nothing is known
 *   THINKING        reasoning is arriving (shown as a size, never quoted)
 *   STREAMING       the visible answer is arriving
 *   PREPARING TOOL  a tool call's arguments are arriving — `edit_file · 9.6 KB`
 *   STALLED         no data for the stall threshold; the connection may still
 *                   be open (keepalives are bytes, not progress)
 *
 * Slow reasoning with bytes arriving is not a stall. A large argument
 * streaming is not a stall. Nothing here aborts anything — provider.js owns
 * the real inactivity cut-off (180 s); this only says what is true.
 */

/** No data for this long after data began: STALLED. */
const STALL_MS = 45_000;
/** No data at all for this long after the request was sent: STALLED. */
const FIRST_STALL_MS = 120_000;
/** Commentary is a glimpse, not a transcript. */
const COMMENTARY_MAX = 220;

function begin(now = Date.now()) {
  return {
    startedAt: now,
    bytes: 0, lastByteAt: 0,           // any byte, keepalives included
    events: 0, lastDataAt: 0,          // a parsed data frame — progress
    textChars: 0, lastTextAt: 0,
    reasoningChars: 0, lastReasoningAt: 0,
    tool: null, lastToolAt: 0,         // { name, bytes, index, calls }
    commentary: '',
  };
}

/** provider.js: a chunk of bytes arrived on the socket. */
function bytes(live, n, now = Date.now()) {
  if (!live) return;
  live.bytes += n || 0;
  live.lastByteAt = now;
}

/** provider.js: one parsed data frame. */
function data(live, now = Date.now()) {
  if (!live) return;
  live.events += 1;
  live.lastDataAt = now;
}

/** provider.js: a tool call's arguments grew (name may arrive before any bytes). */
function toolDelta(live, { name = '', bytes: size = 0, index = 0, calls = 1 } = {}, now = Date.now()) {
  if (!live) return;
  live.tool = { name: String(name || (live.tool && live.tool.name) || ''), bytes: size, index, calls };
  live.lastToolAt = now;
  live.lastDataAt = now;
}

/** provider.js / turn.js: hidden or visible reasoning is arriving. */
function reasoning(live, chars = 0, now = Date.now()) {
  if (!live) return;
  live.reasoningChars += chars;
  live.lastReasoningAt = now;
  live.lastDataAt = now;
}

/**
 * turn.js: visible answer text. The commentary is the model's own words from
 * the paragraph in progress — what it is saying NOW — clipped. Never reasoning.
 */
function text(live, chunk = '', now = Date.now()) {
  if (!live) return;
  const s = String(chunk || '');
  live.textChars += s.length;
  live.lastTextAt = now;
  live.lastDataAt = now;
  let c = live.commentary + s;
  const para = c.lastIndexOf('\n\n');
  // A finished paragraph gives way to the next one as soon as it starts.
  if (para >= 0 && c.slice(para).trim()) c = c.slice(para + 2);
  if (c.length > COMMENTARY_MAX * 2) c = c.slice(-COMMENTARY_MAX * 2);
  live.commentary = c;
}

/** Human size: 812 B · 9.6 KB · 1.2 MB. */
function size(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The commentary as one tidy line (last sentence-ish, whitespace folded). */
function commentaryLine(live, max = COMMENTARY_MAX) {
  const c = String((live && live.commentary) || '').replace(/\s+/g, ' ').trim();
  if (!c) return '';
  if (c.length <= max) return c;
  const tail = c.slice(-max);
  const cut = tail.search(/[.!?:]\s+\S/);
  return '…' + (cut >= 0 && cut < max / 2 ? tail.slice(cut + 2) : tail.slice(1));
}

/**
 * WHAT IS TRUE RIGHT NOW. Pure: `now` in, words out.
 * @returns {{word:string, detail:string, quietMs:number, elapsed:string, stalled:boolean}}
 */
function state(live, now = Date.now()) {
  if (!live) return null;
  const elapsed = clock(now - live.startedAt);
  const quietMs = live.lastDataAt ? now - live.lastDataAt : now - live.startedAt;
  const threshold = live.lastDataAt ? STALL_MS : FIRST_STALL_MS;
  if (quietMs >= threshold) {
    const alive = live.lastByteAt && now - live.lastByteAt < STALL_MS ? ' · connection alive' : '';
    return { word: 'STALLED', detail: `no model data for ${clock(quietMs)}${alive}`, quietMs, elapsed, stalled: true };
  }
  // A ROUTER MAY HOLD A WHOLE TOOL CALL until it is complete (measured through
  // 9router, 2026-09-23: 6.6 KB of arguments arrived in 4 frames after ~10 s),
  // so a long silence before the first frame is said as what it may be.
  if (!live.lastDataAt) {
    // THE HEARTBEAT (2026-10-01): a wait says how long it has been once it is long enough to wonder about — never a
    // fake progress figure, and never "first response" on step 4.
    const secs = Math.floor(quietMs / 1000);
    const detail = quietMs >= 30_000 ? `provider response pending · ${secs}s · the route may be holding a tool call until it is complete`
      : quietMs >= 8_000 ? `provider response pending · ${secs}s`
        : quietMs >= 2_500 ? `waiting for model · ${secs}s` : 'waiting for model';
    return { word: 'WAITING', detail, quietMs, elapsed, stalled: false };
  }
  // The most recent kind of data decides the word.
  const latest = Math.max(live.lastToolAt, live.lastTextAt, live.lastReasoningAt);
  if (live.tool && latest === live.lastToolAt) {
    const n = live.tool.calls > 1 ? ` · call ${live.tool.index + 1}/${live.tool.calls}` : '';
    return { word: 'PREPARING TOOL', detail: `${live.tool.name || 'tool call'} · ${size(live.tool.bytes)}${n}`, quietMs, elapsed, stalled: false };
  }
  if (live.lastTextAt && latest === live.lastTextAt) return { word: 'WRITING', detail: '', quietMs, elapsed, stalled: false };
  // HOW MUCH reasoning arrived, as an ESTIMATED token figure (marked `~`) — the provider's exact count lands with the
  // receipt (ui/activityline.receipt). Never the reasoning itself.
  if (live.lastReasoningAt) return { word: 'THINKING', detail: require('./ui/activityline').estTokens(live.reasoningChars) || '', quietMs, elapsed, stalled: false };
  return { word: 'WAITING', detail: 'waiting for model', quietMs, elapsed, stalled: false };
}

module.exports = { STALL_MS, FIRST_STALL_MS, begin, bytes, data, toolDelta, reasoning, text, state, size, clock, commentaryLine };
