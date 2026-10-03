'use strict';

/** WHICH ROLE MAY USE WHICH SOURCE — the one capability policy every model picker, setter and resolver asks before a choice is accepted. */

const ROLE = Object.freeze({
  CHAT: 'CHAT', BOT: 'BOT', AGENT: 'AGENT', AUX: 'AUX', LAYA: 'LAYA',
  RESEARCH: 'RESEARCH', ORCHESTRATION: 'ORCHESTRATION', FALLBACK: 'FALLBACK', FOCUS: 'FOCUS',
});
const ROLES = Object.freeze(Object.values(ROLE));

/** THE CHATGPT CHAT SOURCE, as a person reads it. */
const CHATGPT_CHAT = Object.freeze({
  source: 'chatgpt-web',
  label: 'ChatGPT Chat',
  alias: 'luna-chat-xhigh',
  origin: 'chatgpt.com',
  capability: 'CHAT ONLY',
  roles: Object.freeze([ROLE.CHAT]),
});

/** Every website session is a conversation surface, and only that. */
const WEB_SOURCES = Object.freeze(['chatgpt-web', 'gemini-web']);

function isWebSource(source) { return WEB_SOURCES.includes(String(source || '')); }

/** Is this model id the ChatGPT Chat alias (in any spelling a person types)? */
function isChatAlias(modelId) {
  const m = String(modelId || '').trim().toLowerCase();
  return m === CHATGPT_CHAT.alias || m === 'chatgpt chat' || m === 'chatgpt-chat';
}

/** Is this row / selection the ChatGPT Chat source or its alias? */
function isChatOnly({ source = null, modelId = null } = {}) {
  return isWebSource(source) || isChatAlias(modelId);
}

/** MAY `role` USE this row? */
function allowed(row, role) {
  const r = String(role || '').toUpperCase();
  if (!ROLES.includes(r)) return false;
  if (!row) return false;
  if (isChatOnly(row)) return r === ROLE.CHAT;
  if (Array.isArray(row.roles)) return row.roles.includes(r);
  return true;
}

/** The refusal a setter returns, worded for a person. */
function check(row, role) {
  if (allowed(row, role)) return { ok: true };
  if (isChatOnly(row)) {
    return { ok: false, code: 'chat-only', why: `${CHATGPT_CHAT.label} is CHAT ONLY — it can answer in the CHAT view, and cannot be the ${roleWord(role)}` };
  }
  return { ok: false, code: 'role', why: `this model is not verified for the ${roleWord(role)} role` };
}

function roleWord(role) {
  return ({ BOT: 'BOT model', AGENT: 'Coding Agent', AUX: 'auxiliary worker', LAYA: 'Laya worker', RESEARCH: 'research worker',
    ORCHESTRATION: 'orchestration worker', FALLBACK: 'fallback model', FOCUS: '/focus Agent', CHAT: 'CHAT model' })[String(role).toUpperCase()] || String(role);
}

/** The label a list shows for a web row — never a bare model id. */
function labelFor(source, fallback) {
  if (source === CHATGPT_CHAT.source) return CHATGPT_CHAT.label;
  return fallback;
}

/** Filter any list of rows down to what `role` may choose. */
function filter(rows, role) { return (rows || []).filter((r) => allowed(r, role)); }

module.exports = { ROLE, ROLES, CHATGPT_CHAT, WEB_SOURCES, isWebSource, isChatAlias, isChatOnly, allowed, check, roleWord, labelFor, filter };
