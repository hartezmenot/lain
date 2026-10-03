'use strict';

/** WHY A TURN STOPPED, IN LAIN'S OWN WORDS — the failure vocabulary. */

const MAX_DETAIL = 110;

/** WHAT KIND OF FAILURE THIS WAS, in one word and one sentence —. */
const FAILURE = Object.freeze({
  UNAVAILABLE: { word: 'NETWORK', say: 'the provider could not be reached' },
  TIMEOUT: { word: 'NETWORK', say: 'the provider did not answer in time' },
  RATE_LIMITED: { word: 'RATE LIMITED', say: 'the provider is refusing for now' },
  AUTH: { word: 'NOT AUTHENTICATED', say: 'the credential was rejected' },
  QUOTA: { word: 'QUOTA', say: 'the account behind this route has no quota left' },
  MODEL_UNAVAILABLE: { word: 'MODEL UNAVAILABLE', say: 'this route does not serve the model' },
  CONTEXT_LIMIT: { word: 'CONTEXT FULL', say: 'the conversation is too long for this model' },
  BAD_REQUEST: { word: 'MODEL REFUSED', say: 'the provider rejected the request' },
  UNKNOWN: { word: 'ERROR', say: 'the provider did not answer' },
});

/** The failure as a word and a detail line. Accepts a string, for old callers. */
function failureRow(failed) {
  if (typeof failed === 'string') return { word: 'ERROR', detail: failed };
  // TOO MANY MESSAGES IS NOT A FULL WINDOW, and the fix is not the same.
  if (failed && failed.kind === 'CONTEXT_LIMIT' && failed.limitKind === 'MESSAGES') {
    const cap = failed.maxMessages ? `${failed.maxMessages}` : 'its';
    return {
      word: 'TOO MANY MESSAGES',
      detail: `the conversation is past this provider's ${cap}-message limit — `
        + '/compact folds the oldest into one summary and keeps what you asked for',
    };
  }
  // A STREAM THAT WENT SILENT MID-REPLY is not "could not be reached" and not a
  // refusal: it answered, then stopped. Said as what it was, with what LAIN did.
  if (failed && failed.kind === 'TIMEOUT' && /stream inactive/i.test(String(failed.message || ''))) {
    const secs = (String(failed.message).match(/(\d+)s/) || [])[1];
    const resumed = Number(failed.resumed) || 0;
    return {
      word: 'STREAM STALLED',
      detail: `the provider went silent mid-reply${secs ? ` for ${secs}s` : ''}`
        + (resumed ? ` · resumed ${resumed}× without recovering` : '') + ' · the work so far is kept — say continue to pick it up',
    };
  }
  // A LIMIT WITH A KNOWN RESET says WHICH model and WHEN, not the provider's body:
  //   RATE LIMITED · claude-sonnet-4.5 · reset in 42m · 18:04   /   WEEKLY LIMIT · … · Monday 08:00
  if (failed && failed.kind === 'RATE_LIMITED' && Number(failed.resumeAt) > Date.now()) {
    const rl = require('../ratelimit');
    const left = failed.resumeAt - Date.now();
    return { word: rl.windowWord(left), detail: `${failed.model ? `${failed.model} · ` : ''}reset in ${rl.human(left)} · ${rl.at(failed.resumeAt)}` };
  }
  const f = (failed && FAILURE[failed.kind]) || FAILURE.UNKNOWN;
  // THE STATUS CODE IS THE MOST USEFUL FACT ABOUT A NETWORK FAILURE, and it is the one thing the generic sentence never carried.
  const raw = String((failed && failed.message) || f.say);
  const why = require('../render').clipMessage(raw).slice(0, MAX_DETAIL);
  const code = failed && failed.status && !why.startsWith(String(failed.status)) ? `${failed.status} ` : '';
  return { word: f.word, detail: `${code}${why}` };
}

/** `THINKING` -> `Thinking`, `RUNNING MCP` -> `Running MCP`. */

module.exports = { failureRow, FAILURE, MAX_DETAIL };
