'use strict';

/** WHAT A CHAT MODEL SOURCE IS, AND WHAT IT IS NOT. */

/** RUNTIME reaches an API LAIN holds a credential for. WEB drives a logged-in site. */
const KIND = Object.freeze({ RUNTIME: 'RUNTIME', WEB: 'WEB' });

/** The canonical source ids. Stable strings — a frontend and a session file hold them. */
const SOURCE = Object.freeze({
  LAIN: 'lain',
  CHATGPT_WEB: 'chatgpt-web',
  GEMINI_WEB: 'gemini-web',
});

/** What a source is, for a person and for a picker. */
const LABEL = Object.freeze({
  [SOURCE.LAIN]: 'LAIN',
  // "ChatGPT Chat" (modelroles.CHATGPT_CHAT): the chatgpt.com website session,
  // CHAT ONLY. Never "Codex", never "OpenAI API", never a bare GPT model id.
  [SOURCE.CHATGPT_WEB]: 'ChatGPT Chat',
  [SOURCE.GEMINI_WEB]: 'Gemini.google.com',
});

/** HOW A SEND ENDED. Six outcomes, and none of them is a default. */
const STATUS = Object.freeze({
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAVAILABLE: 'UNAVAILABLE',
  FAILED: 'FAILED',
});

/** Whether a model in a discovered inventory can be used right now. */
const MODEL_STATE = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  /** The selector was read and this entry's state could not be established. */
  UNKNOWN: 'UNKNOWN',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
});

/** WHERE A SOURCE IS IN ITS LIFECYCLE. */
const CONNECTION = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  DISCOVERING: 'DISCOVERING',
  READY: 'READY',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAVAILABLE: 'UNAVAILABLE',
  FAILED: 'FAILED',
});

/** WHAT A SOURCE CAN ACTUALLY DO — proven, never advertised. */
function capabilities(over = {}) {
  return {
    text: true,
    imageInput: 'unknown',
    fileInput: 'unknown',
    streaming: false,
    cancel: true,
    /** Whether token counts from this source are a MEASUREMENT. Websites: no. */
    authoritativeUsage: false,
    ...over,
  };
}

/** How much of any one reply is carried into the LAIN conversation. */
const MAX_REPLY_CHARS = 60_000;

/** THE NORMALIZED RESULT. */
function result({
  source, model, status, text = '', error = null,
  conversationBinding = null, retryAfterMs = null, usage = null, at = Date.now(),
} = {}) {
  const body = String(text == null ? '' : text).trim().slice(0, MAX_REPLY_CHARS);
  let state = String(status || STATUS.FAILED);
  let why = error == null ? null : String(error);
  if (state === STATUS.COMPLETED && !body) {
    state = STATUS.FAILED;
    why = 'the source returned no text — nothing was captured';
  }
  return {
    source: String(source || ''),
    model: model == null ? null : String(model),
    status: state,
    text: state === STATUS.COMPLETED ? body : '',
    // NEVER INVENTED. A website publishes no authoritative token count, and a plausible estimate in this field would be indistinguishable from a…
    usage: usage || null,
    conversationBinding,
    // Only ever a number a source actually read off a page or a header.
    retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.floor(retryAfterMs) : null,
    error: why,
    /** WHO ANSWERED, recorded AT EXECUTION TIME. See `provenance`. */
    provenance: provenance(source, model, at),
  };
}

/** WHO ANSWERED THIS TURN — stamped when the request is made, never reconstructed. */
function provenance(source, model, at = Date.now()) {
  const id = String(source || '');
  const label = LABEL[id] || id || 'unknown';
  return {
    sourceId: id,
    sourceLabel: label,
    model: model == null ? null : String(model),
    label: model ? `${label} · ${model}` : label,
    at,
  };
}

/** A REPLY THAT CLAIMS TO HAVE ACTED HAS CLAIMED SOMETHING IT CANNOT DO. */
const OVERCLAIM = /\b(?:I (?:ran|executed|opened|read|edited|wrote|modified|installed|checked the file|inspected the file)|I have (?:run|read|edited|modified))\b/i;

function overclaims(text) {
  const m = OVERCLAIM.exec(String(text || ''));
  return m ? m[0] : null;
}

/** THE INTERFACE EVERY SOURCE ANSWERS TO. */
class ModelSource {
  constructor({ id, label = null, kind = KIND.RUNTIME } = {}) {
    this.id = String(id || '');
    this.label = label || LABEL[this.id] || this.id;
    this.kind = kind;
  }

  /** @returns {Promise<{state, why, models?, selected?}>} — never throws. */
  status() { throw new Error(`${this.id}: a source must report its status`); }

  /** Make the source usable. For a website this is a USER-DRIVEN login. */
  connect() { throw new Error(`${this.id}: a source must declare how it connects`); }

  /** Forget this source's live state. Never deletes a person's saved login. */
  disconnect() { throw new Error(`${this.id}: a source must declare how it disconnects`); }

  /** @returns {Promise<{ok, models:[{id,label,state}], why, cached, at}>} */
  discoverModels() { throw new Error(`${this.id}: a source must discover its models`); }

  /** @returns {Promise<{ok, modelId, why}>} */
  selectModel() { throw new Error(`${this.id}: a source must select a model`); }

  /** @returns {Promise<result>} — the normalized shape above, always. */
  send() { throw new Error(`${this.id}: a source must accept a prompt`); }

  /** Stop whatever is in flight. Idempotent by contract. */
  cancel() { throw new Error(`${this.id}: a source must be cancellable`); }

  /** What this source can prove it does. See `capabilities`. */
  capabilities() { return capabilities(); }
}

module.exports = {
  KIND, SOURCE, LABEL, STATUS, MODEL_STATE, CONNECTION,
  ModelSource, capabilities, result, provenance, overclaims,
  MAX_REPLY_CHARS,
};
