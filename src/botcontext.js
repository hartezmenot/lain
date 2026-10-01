'use strict';

/**
 * THE BOT'S CONTEXT PROFILE — how much of LAIN a BOT turn carries.
 *
 *   BOT_SIMPLE          a question that needs nothing but the conversation:
 *                       "2 + 2", "translate this", "what is a mutex". A short
 *                       system prompt (identity, style, the BOT profile), no tool
 *                       schemas, no workspace/focus/project context. ~300 tokens
 *                       instead of the ~19k a full BOT request carries — the
 *                       difference between seconds and many minutes on a small
 *                       local model.
 *   BOT_FULL            everything the BOT has today: the stable prompt, the
 *                       live workspace tail, every tool. Anything that mentions
 *                       the project, files, code, the web, images, running
 *                       something — or any conversation that has already used a
 *                       tool — stays here. (A narrower BOT_PROJECT profile is not
 *                       separate yet: project questions take BOT_FULL.)
 *   BOT_ASSISTANT_TASK  a scheduled/recurring assistant task (assistant/actions.js
 *                       builds its own minimal context; recorded here by name).
 *
 * CONSERVATIVE BY CONSTRUCTION. A wrong BOT_FULL costs tokens; a wrong
 * BOT_SIMPLE costs an answer that could not look anything up. So SIMPLE is
 * chosen only when every signal agrees, and the Coding Agent is never touched.
 * `cfg.bot.contextProfile: 'full'` turns the whole thing off.
 */

const PROFILE = Object.freeze({ SIMPLE: 'BOT_SIMPLE', PROJECT: 'BOT_PROJECT', FULL: 'BOT_FULL', ASSISTANT_TASK: 'BOT_ASSISTANT_TASK' });

// Words that mean the answer may need LAIN's tools or the person's workspace.
const NEEDS = /\b(agent|plan|phase|finding|findings|steer|checkpoint|landed|remaining|file|files|folder|directory|project|repo|repository|code|codebase|function|class|module|test|tests|build|compile|error|bug|fix|debug|stack ?trace|implement|refactor|edit|change|write (?:a |the )?(?:file|script)|run|execute|install|open|search|find|look ?up|google|browse|web|website|url|link|http|download|image|picture|photo|screenshot|screen|ocr|pdf|document|attach|attachment|remind|schedule|every day|tomorrow|telegram|usage|quota|limit|runtime|model|provider|commit|git|branch|diff|terminal|shell|command|npm|node|python|server|deploy|this|that|it|above|previous|earlier|my)\b/i;
const CODEY = /```|`[^`]+`|[\\/][\w.-]+[\\/]|\b\w+\.(js|ts|py|json|md|cs|go|rs|java|html|css|txt|yml|yaml|toml)\b|[{};<>]|=>/;

function enabled(cfg) { return !((cfg && cfg.bot && String(cfg.bot.contextProfile || '').toLowerCase() === 'full') || String(process.env.LAIN_BOT_CONTEXT || '').toLowerCase() === 'full'); }

/** Has this conversation already used tools? Then its history needs them declared. */
function usedTools(session) {
  const msgs = (session && session.messages) || [];
  return msgs.some((m) => m && (m.role === 'tool' || (Array.isArray(m.tool_calls) && m.tool_calls.length) || (Array.isArray(m.content) && m.content.some((b) => b && (b.type === 'tool_use' || b.type === 'tool_result')))));
}

/** Which profile this BOT turn gets. Returns { profile, why }. */
function classify(session, text, cfg = {}) {
  if (!session || session.thread !== 'chat') return { profile: null, why: 'not a BOT turn' };
  if (!enabled(cfg)) return { profile: PROFILE.FULL, why: 'the full BOT context is configured' };
  const t = String(text || '').trim();
  if (!t) return { profile: PROFILE.FULL, why: 'empty' };
  if (t.length > 280) return { profile: PROFILE.FULL, why: 'a long request' };
  if (t.includes('\n')) return { profile: PROFILE.FULL, why: 'a multi-line request' };
  if (CODEY.test(t)) return { profile: PROFILE.FULL, why: 'mentions code or a path' };
  if (NEEDS.test(t)) return { profile: PROFILE.FULL, why: 'may need the workspace or a tool' };
  if (usedTools(session)) return { profile: PROFILE.FULL, why: 'this conversation already uses tools' };
  if (session.task && session.task.plan && (session.task.plan.steps || []).length) return { profile: PROFILE.FULL, why: 'a plan is in progress' };
  return { profile: PROFILE.SIMPLE, why: 'answerable from the conversation alone' };
}

/** The BOT_SIMPLE system prompt: identity, style, the person's BOT profile. Stable, so it caches. */
function simplePrompt(cfg = {}) {
  const lines = [
    'You are Noema, the person’s assistant, answering in a chat.',
    'Answer directly and concisely. Plain text; short lists or a small code block only when they help.',
    'In this reply you have no tools and no view of the person’s files or projects. If the question turns out to need them, say so in one sentence; the next message will have them.',
  ];
  let out = lines.join('\n');
  try { const pb = require('./botprofile').promptBlock(cfg); if (pb) out += `\n\n${pb}`; } catch { /* a preference never costs the prompt */ }
  return out;
}

/**
 * APPLY to a turn's options (jobrunner.turnOptions). BOT_SIMPLE replaces the
 * system prompt, drops the live tail and the tools; BOT_FULL leaves them.
 */
function apply(opts, session, text) {
  const c = classify(session, text, opts.cfg || {});
  if (session && c.profile) session.contextProfile = { profile: c.profile, why: c.why, at: Date.now() };
  if (c.profile !== PROFILE.SIMPLE) return opts;
  return { ...opts, systemPrompt: simplePrompt(opts.cfg || {}), live: '', liveContinuing: '', sideContext: async () => '', tools: false, requiresExecution: false, contextProfile: c.profile };
}

module.exports = { PROFILE, classify, simplePrompt, apply, usedTools };
