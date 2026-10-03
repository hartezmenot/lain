'use strict';

/** A CONVERSATION, HANDED TO A RUNTIME AS ONE PROMPT. */

const MAX_PROMPT = 60000;

function text(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  return c == null ? '' : JSON.stringify(c);
}

/** { system, prompt } from LAIN's message array. */
function flatten(messages, { max = MAX_PROMPT } = {}) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const lines = [];
  for (const m of rest) {
    if (m.role === 'tool') { lines.push(`[tool result] ${text(m.content).slice(0, 400)}`); continue; }
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) && m.tool_calls.length ? ` [called: ${m.tool_calls.map((c) => c.name).join(', ')}]` : '';
      lines.push(`Assistant: ${text(m.content)}${calls}`);
      continue;
    }
    lines.push(`User: ${text(m.content)}`);
  }
  const last = rest.length && rest[rest.length - 1].role === 'user' ? text(rest[rest.length - 1].content) : '';
  if (rest.length <= 1) return { system: sys, prompt: last || lines.join('\n') };
  let body = lines.slice(0, -1).join('\n\n');
  const head = 'Conversation so far (oldest first):\n\n';
  const tail = `\n\nThe person now says:\n\n${last}`;
  const room = Math.max(1000, max - head.length - tail.length);
  if (body.length > room) body = `[earlier turns omitted]\n${body.slice(body.length - room)}`;
  return { system: sys, prompt: `${head}${body}${tail}` };
}

module.exports = { flatten, text, MAX_PROMPT };
