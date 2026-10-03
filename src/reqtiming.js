'use strict';

/** WHERE ONE REQUEST'S TIME WENT (Simplify S5.1 F6), for the request trace: the effort actually put on the wire (the protocol writes it into `wireOut`)… */

function start() {
  return { wireOut: { effort: null }, t0: Date.now(), first: 0, rStart: 0, rEnd: 0, tStart: 0, tEnd: 0 };
}

/** One streamed event. */
function see(t, ev) {
  if (!ev) return;
  const now = Date.now();
  if (!t.first && ev.type !== 'usage_live') t.first = now;
  if (ev.type === 'reasoning') { t.rStart = t.rStart || now; t.rEnd = now; }
  if (ev.type === 'text' || ev.type === 'tool_calls') { t.tStart = t.tStart || now; t.tEnd = now; }
}

/** Onto the trace record, before it closes. */
function stamp(t, rec, receipt) {
  if (!rec) return;
  // An HTTP body's effort as written; a runtime (Claude Code, Codex) gets its effort as a flag, already on the record.
  if (t.wireOut.effort != null || rec.protocol !== 'runtime') rec.effort = t.wireOut.effort;
  rec.firstByteMs = t.first ? t.first - t.t0 : null;
  rec.reasoningMs = t.rStart ? t.rEnd - t.rStart : 0;
  rec.textMs = t.tStart ? t.tEnd - t.tStart : 0;
  rec.reasoningTokens = receipt && receipt.reasoningTokens != null ? Number(receipt.reasoningTokens) : null;
}

module.exports = { start, see, stamp };
