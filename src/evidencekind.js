'use strict';

/** WHAT ONE OBSERVATION ACTUALLY PROVES. */

const KIND = Object.freeze({
  COMMAND_EXECUTED: 'COMMAND_EXECUTED',
  COMMAND_EXIT_STATUS: 'COMMAND_EXIT_STATUS',
  SEARCH_MATCH_FOUND: 'SEARCH_MATCH_FOUND',
  SEARCH_NO_MATCH: 'SEARCH_NO_MATCH',
  TEST_PASSED: 'TEST_PASSED',
  TEST_FAILED: 'TEST_FAILED',
  REQUIREMENT_VERIFIED: 'REQUIREMENT_VERIFIED',
  REQUIREMENT_FAILED: 'REQUIREMENT_FAILED',
  INCONCLUSIVE: 'INCONCLUSIVE',
});

/** A trailing segment that always succeeds and carries no check of its own. */
const TRAILING_PRINT_RE = /^(?:echo|write-output|write-host|print|type\s)/i;

/** Split on UNCONDITIONAL separators only — bare `&` (cmd.exe) and bare `;` (POSIX) — never `&&`/`||`, whose own status already depends on what ran… */
function segments(command) {
  const text = String(command || '');
  return text
    .split(/(?<!&)&(?!&)|(?<!;);(?!;)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when the chain's reported exit code cannot be attributed to its meaningful check: two or more segments, joined unconditionally, ending in a bare… */
function masksEarlierFailure(command) {
  const parts = segments(command);
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1];
  if (!TRAILING_PRINT_RE.test(last)) return false;
  return parts.slice(0, -1).some((p) => !TRAILING_PRINT_RE.test(p));
}

/** Classify what one shell result proves. */
function classifyCommand({ command, exitCode = null, isError = false, noMatch = false, searchLike = false }) {
  if (masksEarlierFailure(command)) {
    const parts = segments(command);
    return {
      kind: KIND.INCONCLUSIVE,
      ok: null,
      masked: true,
      note: `the reported exit code belongs to the trailing "${parts[parts.length - 1]}", not to the earlier `
        + 'command in this chain — it does not verify anything that ran before it',
    };
  }
  if (noMatch) {
    return { kind: KIND.SEARCH_NO_MATCH, ok: null, masked: false, note: 'the search ran and found nothing — that is an answer, not a pass or a fail' };
  }
  if (searchLike && exitCode === 0) {
    return { kind: KIND.SEARCH_MATCH_FOUND, ok: true, masked: false };
  }
  return { kind: KIND.COMMAND_EXIT_STATUS, ok: !isError, masked: false };
}

module.exports = { KIND, segments, masksEarlierFailure, classifyCommand };
