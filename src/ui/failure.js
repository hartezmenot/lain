'use strict';

/**
 * WHY A TURN STOPPED, IN LAIN'S OWN WORDS — the failure vocabulary.
 *
 * Split out of ui/status.js when that file reached the god-object guard, on a seam
 * that was already real: everything left there DRAWS the live row, and this
 * decides what a failure is CALLED. They change for different reasons — a new
 * provider error adds a row here and touches no drawing; a change to the row's
 * hierarchy does the reverse.
 *
 * IT IS LAIN SPEAKING, NOT THE PROVIDER. The provider's own sentence is shown
 * separately (src/render.js `providerFailure`); this is the classification, in one
 * word and one line, so that `429` and a dropped socket and a refused credential
 * read as three different problems rather than as "something went wrong".
 */

const MAX_DETAIL = 110;

/**
 * WHAT KIND OF FAILURE THIS WAS, in one word and one sentence —.
 *
 * A 502 from a gateway, a refused credential and a model that would not
 * answer are three different problems with three different fixes, and they
 * all used to be drawn as `ERROR — the provider did not answer`. That is the
 * right sentence for one of them and a misdiagnosis for the other two: it
 * sends somebody to check their API key when the network is down.
 *
 * NETWORK is separated deliberately from everything else. It is the failure
 * that is NOT about LAIN, the model, the task or the tools, and the one the
 * user can most often simply wait out.
 */
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
  // TOO MANY MESSAGES IS NOT A FULL WINDOW, and the fix is not the same. The
  // generic sentence — "the conversation is too long for this model" — sends
  // somebody to shorten their prompt when what the provider refused was the
  // NUMBER of messages, which no amount of shortening changes. Naming the cap
  // and the command that acts on it is the difference between a dead session
  // and one keystroke.
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
  // THE STATUS CODE IS THE MOST USEFUL FACT ABOUT A NETWORK FAILURE, and it
  // is the one thing the generic sentence never carried.
  // ONE LINE, NOT A JSON BODY. A provider that answers with a whole error
  // object put four wrapped lines of braces into a row that has one, and the
  // useful sentence was buried in the middle of it — so the provider's own
  // sentence is lifted out of the object (render.clipMessage), and the status
  // is not printed twice when the message already opens with it.
  const raw = String((failed && failed.message) || f.say);
  const why = require('../render').clipMessage(raw).slice(0, MAX_DETAIL);
  const code = failed && failed.status && !why.startsWith(String(failed.status)) ? `${failed.status} ` : '';
  return { word: f.word, detail: `${code}${why}` };
}

/**
 * `THINKING` -> `Thinking`, `RUNNING MCP` -> `Running MCP`.
 *
 * Only the first word is lowered past its initial: an acronym the vocabulary
 * chose deliberately — MCP, the provider's own `429` — is not a shouted word and
 * must not be quietly reworded into one that reads as prose.
 */

module.exports = { failureRow, FAILURE, MAX_DETAIL };
