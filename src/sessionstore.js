'use strict';

/**
 * REMOVING A CONVERSATION — the only code in LAIN that can.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT A METHOD ON `Session`.
 *
 * It was, for about ten minutes, and a guard caught it: `session.js` is on the
 * COMPACTION PATH, and an architecture test asserts that nothing on that path
 * can reach `unlinkSync`/`rmSync`/`rmdirSync` (tests/unit/compactionrule.test.js).
 * Compaction is an in-memory transformation of one array; the moment the file
 * that does it also contains the ability to delete a transcript, "compact the
 * context" is one typo away from "destroy the record".
 *
 * That guard is right, so deletion lives in its own file where the only thing
 * that reaches it is a person who asked for it by name.
 *
 * ------------------------------------------------------------------------
 * WHAT MAY CALL THIS, AND WHAT MAY NOT.
 *
 *   MAY   an explicit delete action, asked for by the user
 *   MAY NOT  closing a window, closing a view, evicting an idle App, ending a
 *            process, switching session, running out of room in a list
 *
 * Closing and deleting are different verbs and the whole of §11 of the
 * lifecycle correction is that one must never be spelled with the other's
 * button. See src/sessionpool.js `release`, which is the closing one.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const { Session } = require('./session');

/**
 * Delete one session's transcript.
 *
 * A FULL ID ONLY. `Session.match` resolves a short token by scanning what
 * exists, so a token that is unique today is ambiguous tomorrow — tolerable for
 * "open the wrong session", not tolerable for this.
 *
 * WHAT IT DOES NOT TOUCH: checkpoints. A session's snapshots are the bytes
 * `/undo` restores; they live in their own directory keyed by session id, and
 * dropping the transcript must not silently remove the ability to reverse what
 * that session did to the working tree. See src/checkpoint.js.
 *
 * @returns {{ok: boolean, id?: string, why?: string}}
 */
function forget(id) {
  const want = String(id || '').trim();
  if (!want) return { ok: false, why: 'which session?' };
  if (!Session.list(10_000).includes(want)) return { ok: false, why: `no session "${want}"` };
  try {
    fs.unlinkSync(path.join(config.sessionsDir(), `${want}.json`));
  } catch (e) {
    return { ok: false, why: `it could not be deleted: ${e.message}` };
  }
  return { ok: true, id: want };
}

module.exports = { forget };
