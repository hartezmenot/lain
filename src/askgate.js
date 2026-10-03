'use strict';

/** ask_user IS A BOUNDARY, NOT A TOOL THAT HAPPENS TO PAUSE. */

/** The one call that ends a step early. */
const ASK = 'ask_user';

/** Split a step's calls at the question. */
function cut(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const at = list.findIndex((c) => c && c.name === ASK);
  if (at < 0 || at === list.length - 1) return { run: list, deferred: [] };
  return { run: list.slice(0, at + 1), deferred: list.slice(at + 1) };
}

/** What a deferred call is told. */
function deferredResult(call) {
  const name = (call && call.name) || 'this call';
  return `NOT RUN — \`${name}\` was requested in the same step as your question, so it was `
    + 'decided before the answer existed and cannot be a response to it. '
    + 'The answer is above. Decide again with it in hand, and call whatever it actually implies.';
}

/** Answer every deferred call, so the conversation has no dangling half. */
function answerDeferred(session, deferred) {
  const list = Array.isArray(deferred) ? deferred : [];
  for (const c of list) {
    session.messages.push({
      role: 'tool',
      tool_call_id: c.id,
      content: deferredResult(c),
      isError: false,
      ts: new Date().toISOString(),
    });
  }
  return list.length;
}

module.exports = { cut, deferredResult, answerDeferred, ASK };
