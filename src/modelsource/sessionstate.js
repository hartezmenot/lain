'use strict';

/** WHAT A SESSION REMEMBERS ABOUT ITS CHAT MODEL SOURCES. */

const binding = require('./binding');

/** Give a fresh session its defaults. Called from the Session constructor. */
function attach(session) {
  session.chatSource = null;
  session.sourceSelections = {};
  // ACCOUNT FIRST (Phase 8.2): the account each lane chose for THIS session (sessionintel.lane).
  session.accountSelections = {};
  // THE INTELLIGENCE FABRIC (Phase 8.3): per lane, the provider FAMILY and the EFFORT chosen, and an account decision waiting for the person…
  session.intel = intelDefaults();
  session.providerBindings = {};
  return session;
}

/** What goes into the session file. */
function toJSON(session) {
  return {
    chatSource: (session && session.chatSource) || null,
    sourceSelections: (session && session.sourceSelections) || {},
    accountSelections: (session && session.accountSelections) || {},
    intel: (session && session.intel) || intelDefaults(),
    providerBindings: binding.toJSON(session),
  };
}

/** Put it back on a resumed session. */
function restore(session, data = {}) {
  const d = data && typeof data === 'object' ? data : {};
  // A RETIRED WEBSITE SOURCE (Phase 8.1) answers from LAIN's own source again; the conversation is untouched.
  session.chatSource = d.chatSource && !['chatgpt-web', 'gemini-web'].includes(d.chatSource) ? d.chatSource : null;
  session.sourceSelections = (d.sourceSelections && typeof d.sourceSelections === 'object')
    ? { ...d.sourceSelections } : {};
  session.accountSelections = (d.accountSelections && typeof d.accountSelections === 'object') ? { ...d.accountSelections } : {};
  session.intel = intelFrom(d.intel);
  session.providerBindings = binding.from(d.providerBindings);
  return session;
}

function intelDefaults() { return { lanes: { chat: { family: null, effort: null }, coding: { family: null, effort: null } }, pending: null }; }
function intelFrom(d) {
  const out = intelDefaults();
  if (!d || typeof d !== 'object') return out;
  for (const k of ['chat', 'coding']) {
    const l = d.lanes && d.lanes[k];
    if (l && typeof l === 'object') out.lanes[k] = { family: typeof l.family === 'string' ? l.family : null, effort: typeof l.effort === 'string' ? l.effort : null };
  }
  out.pending = d.pending && typeof d.pending === 'object' ? d.pending : null;
  return out;
}

module.exports = { attach, toJSON, restore, intelDefaults };
