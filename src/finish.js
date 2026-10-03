'use strict';

/** WHY A GENERATION ENDED — and why that is not why a TASK ended. */

/** Normalized finish: 'stop' | 'length' | 'refused' | null (not stated). */
function normalize(raw) {
  const r = String(raw == null ? '' : raw).toLowerCase().trim();
  if (!r) return null;
  if (/^(length|max_tokens|max_output_tokens|model_length)$/.test(r)) return 'length';
  if (/content_filter|safety|refusal|recitation|blocked|prohibited/.test(r)) return 'refused';
  return 'stop';
}

/** Tool-call arguments as they arrived. */
function parseArgs(raw) {
  const t = String(raw == null ? '' : raw);
  if (!t.trim()) return { input: {}, malformed: null };
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? { input: v, malformed: null } : { input: {}, malformed: t.slice(0, 300) };
  } catch { return { input: {}, malformed: t.slice(0, 300) }; }
}

/** The tool result a malformed call gets instead of running. */
function malformedResult(call) {
  return {
    output: `MALFORMED_TOOL_CALL: the arguments for ${call.name} did not arrive as valid JSON (cut off at the output limit, or broken in translation by the provider/router). `
      + `Nothing was run. Received: ${String(call.malformed).slice(0, 200)}\nRe-issue the call with complete arguments.`,
    isError: true,
    malformed: true,
  };
}

/** How many times a reply cut at the output limit is continued before the turn ends CUT OFF. */
const MAX_CUT_RESUMES = 1;

const CONTINUE_NOTE = '# Runtime state\nYour previous reply was CUT OFF at the model\'s output-token limit — it is not finished. '
  + 'Continue exactly where it stopped, without repeating what was already said. If the remaining work needs tools, call them.';

/** How many times a reply that went silent mid-stream is resumed before the turn ends. */
const MAX_STALL_RESUMES = 2;

const STALL_NOTE = '# Runtime state\nThe stream of your previous reply STALLED (the provider went silent) after the text above — '
  + 'any tool call you were composing never arrived and nothing was run. Continue from there without repeating what was said; '
  + 'if you were writing a large file, issue the call again (smaller pieces are safer).';

/** A NETWORK FAILURE AFTER THE REPLY HAD STARTED is not the end of the turn. */
function resumable(failure, text, calls, record) {
  if (!failure || !failure.retriable || !String(text || '').trim() || (calls && calls.length)) return false;
  if (failure.kind !== 'TIMEOUT' && failure.kind !== 'UNAVAILABLE') return false;
  failure.resumed = record.stallResumes || 0;
  if (failure.resumed >= MAX_STALL_RESUMES) return false;
  record.stallResumes = failure.resumed + 1;
  return true;
}

/** The hidden note that resumes a cut ('length') or stalled reply. */
function continueNote(finish) { return finish === 'stalled' ? STALL_NOTE : CONTINUE_NOTE; }

/** A step ended with no tool calls. */
function onCut(record, finish) {
  if (finish === 'stalled') return 'continue';   // bounded by `resumable`
  if (finish === 'length') {
    if ((record.cutResumes || 0) < MAX_CUT_RESUMES) { record.cutResumes = (record.cutResumes || 0) + 1; return 'continue'; }
    return 'length';
  }
  if (finish === 'refused') return 'refused';
  return null;
}

module.exports = { normalize, parseArgs, malformedResult, onCut, resumable, continueNote, CONTINUE_NOTE, STALL_NOTE, MAX_CUT_RESUMES, MAX_STALL_RESUMES };
