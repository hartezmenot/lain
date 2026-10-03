'use strict';

/** REMOVING A CONVERSATION — the only code in LAIN that can. */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const { Session } = require('./session');

/** Delete one session's transcript. */
function forget(id) {
  const want = String(id || '').trim();
  if (!want) return { ok: false, why: 'which session?' };
  if (!Session.list(10_000).includes(want)) return { ok: false, why: `no session "${want}"` };
  // A SESSION ANOTHER PROCESS IS RUNNING is not deleted under it (sessionlease.js).
  const lease = require('./sessionlease');
  const v = lease.view(want);
  if (v && v.pid && v.pid !== process.pid) return { ok: false, why: `it is running in ${v.writer === 'cli' ? 'a terminal' : v.writer || 'another surface'} (pid ${v.pid})` };
  try {
    fs.unlinkSync(path.join(config.sessionsDir(), `${want}.json`));
  } catch (e) {
    return { ok: false, why: `it could not be deleted: ${e.message}` };
  }
  // ITS LEASE RECORD AND ITS JOURNAL GO WITH IT.
  try { lease.forget(want); } catch { /* none */ }
  try { require('./sessionjournal').forget(want); } catch { /* none */ }
  return { ok: true, id: want };
}

module.exports = { forget };
