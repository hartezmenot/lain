'use strict';

/** COMPACTION (Simplify S8): when the conversation reaches the profile's share of the model's window (80%, earlier for ECO — profile.compactAt), a cheap… */

const KEEP_EXCHANGES = 2;
const RESULT_CAP = 1500;
const TRANSCRIPT_CAP = 240000;

const PROMPT = [
  'You compress a coding session so it can continue in a fresh context. Write ONLY this structure, in plain markdown:',
  '## Goal', 'What the person wants, in their terms.',
  '## Decisions', 'Choices made and why, constraints the person stated.',
  '## Files changed', 'Each file touched and what changed in it.',
  '## Open items', 'What is unfinished, failing or unverified.',
  '## Next step', 'The single next thing to do.',
  'Be concrete (paths, names, commands, numbers). Never invent anything not in the transcript.',
].join('\n');

/** Characters → an estimate of tokens. */
const tokensOf = (chars) => Math.ceil(chars / 4);

/** Where the kept tail starts: the user message that opens the last KEEP_EXCHANGES exchanges (never a tool result). */
function cutIndex(messages) {
  let seen = 0;
  for (let i = messages.length - 1; i > 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && !m.tool_call_id) { seen += 1; if (seen >= KEEP_EXCHANGES) return i; }
  }
  return 0;
}

function render(messages) {
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'tool') { out.push(`[tool result] ${String(m.content || '').slice(0, RESULT_CAP)}`); continue; }
    const calls = Array.isArray(m.tool_calls) && m.tool_calls.length ? ` [calls: ${m.tool_calls.map((c) => `${c.name}(${JSON.stringify(c.arguments || {}).slice(0, 200)})`).join(', ')}]` : '';
    out.push(`[${m.role}] ${String(m.content || '')}${calls}`);
  }
  const text = out.join('\n\n');
  return text.length > TRANSCRIPT_CAP ? `…\n${text.slice(-TRANSCRIPT_CAP)}` : text;
}

/** Should this request compact first? */
function due(session, pc, cfg) {
  const window = Number(pc && pc.ctx) || 128000;
  const at = require('./profile').compactAt(cfg && cfg.executionProfile);
  return tokensOf(session.contextChars()) >= window * at;
}

/** Compact now (force) or when due. */
async function maybe(session, cfg, { force = false, signal = null } = {}) {
  const provider = require('./provider');
  const pc = provider.resolve(cfg || {});
  if (!session || !Array.isArray(session.messages) || (!force && !due(session, pc, cfg))) return null;
  const cut = cutIndex(session.messages);
  if (cut < 2) return null;
  const head = session.messages.slice(0, cut);
  const cheap = { ...cfg, model: (cfg && cfg.compactModel) || cfg.model, effort: cfg && cfg.compactModel ? cfg.effort : 'low' };
  const cpc = provider.resolve(cheap);
  if (!cpc.protocol) return null;
  let summary = '';
  try {
    for await (const ev of provider.chat(cpc, [{ role: 'system', content: PROMPT }, { role: 'user', content: render(head) }], { tools: [], signal, trace: { turn: null, step: null, reason: 'compaction' } })) {
      if (ev && ev.type === 'text') summary += ev.chunk || '';
    }
  } catch { return null; }
  summary = summary.trim();
  if (!summary) return null;
  const before = session.contextChars();
  const tail = session.messages.slice(cut);
  const first = { ...tail[0], content: `<summary of the earlier conversation>\n${summary}\n</summary>\n\n${String(tail[0].content || '')}` };
  session.messages = [first, ...tail.slice(1)];
  const after = session.contextChars();
  (session.compactions = session.compactions || []).push({ at: new Date().toISOString(), before, after, model: cpc.model || null });
  try { session.save(); } catch { /* the next save takes it */ }
  return { before, after, model: cpc.model || null };
}

/** `Compacted · 142k → 18k` */
function line(r) {
  const k = (c) => `${Math.max(1, Math.round(tokensOf(c) / 1000))}k`;
  return `Compacted · ${k(r.before)} → ${k(r.after)}`;
}

module.exports = { maybe, due, line, cutIndex, render, PROMPT };
