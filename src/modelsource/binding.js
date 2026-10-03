'use strict';

/** WHICH WEBSITE CONVERSATION BELONGS TO WHICH LAIN SESSION. */

/** A session cannot accumulate bindings forever; one per source is all there is. */
function store(session) {
  if (!session) return {};
  if (!session.providerBindings || typeof session.providerBindings !== 'object') {
    session.providerBindings = {};
  }
  return session.providerBindings;
}

/** REMEMBER a thread as this session's, for this source. */
function remember(session, sourceId, { threadId, model = null, url = null } = {}) {
  const id = String(threadId || '').trim();
  if (!session || !sourceId || !id) return null;
  const entry = {
    threadId: id,
    model: model == null ? null : String(model),
    url: url == null ? null : String(url),
    /** THE OWNER. `resolve` refuses to serve any other session. */
    sessionId: String(session.id || ''),
    at: Date.now(),
  };
  store(session)[String(sourceId)] = entry;
  return entry;
}

/** THE BINDING THIS SESSION MAY USE, or a stated reason there is not one. */
function resolve(session, sourceId) {
  if (!session) return { ok: false, binding: null, why: 'no session' };
  const entry = store(session)[String(sourceId)] || null;
  if (!entry || !entry.threadId) return { ok: false, binding: null, why: 'no thread has been bound to this session yet' };
  if (String(entry.sessionId || '') !== String(session.id || '')) {
    // A session file copied, renamed or merged. The recorded owner is the
    // authority, and a thread whose owner is somebody else is not ours to open.
    return { ok: false, binding: null, why: 'the recorded thread belongs to a different session' };
  }
  return { ok: true, binding: entry, why: '' };
}

/** IS THE PAGE SHOWING THE THREAD WE THINK IT IS? */
function matches(binding, observedThreadId) {
  const want = binding && binding.threadId ? String(binding.threadId) : '';
  const got = String(observedThreadId == null ? '' : observedThreadId);
  if (!want) return { ok: false, why: 'there is no bound thread to compare against' };
  if (!got) return { ok: false, why: 'the page did not report which conversation it is showing' };
  if (want !== got) return { ok: false, why: 'the page is showing a different conversation than the one bound to this session' };
  return { ok: true, why: '' };
}

/** Drop the binding for one source. Used when a thread is gone or auth changed. */
function forget(session, sourceId) {
  if (!session) return false;
  const s = store(session);
  const had = Object.prototype.hasOwnProperty.call(s, String(sourceId));
  delete s[String(sourceId)];
  return had;
}

/** WHAT SURVIVES THE SESSION FILE. */
function toJSON(session) {
  const out = {};
  for (const [k, v] of Object.entries(store(session))) {
    if (!v || !v.threadId) continue;
    out[k] = { threadId: String(v.threadId), model: v.model || null, url: v.url || null, sessionId: v.sessionId || '', at: Number(v.at) || 0 };
  }
  return out;
}

/** Rebuild from a saved session. Anything malformed is simply absent. */
function from(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const [k, v] of Object.entries(data)) {
    if (!v || typeof v !== 'object' || !v.threadId) continue;
    out[String(k)] = {
      threadId: String(v.threadId),
      model: v.model == null ? null : String(v.model),
      url: v.url == null ? null : String(v.url),
      sessionId: String(v.sessionId || ''),
      at: Number(v.at) || 0,
    };
  }
  return out;
}

module.exports = { remember, resolve, matches, forget, toJSON, from, store };
