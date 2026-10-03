'use strict';

/** CLI ↔ HARNESS COMPATIBILITY. */

const PROTOCOL = 1;

/** May a surface at `theirs` ({ version, protocol }) attach to a Core at `ours`? */
function attach(ours, theirs) {
  const M = require('./manifest');
  if (!theirs || theirs.protocol == null) return { ok: true, note: null };
  if (theirs.protocol !== ours.protocol) {
    const older = theirs.protocol < ours.protocol ? theirs : ours;
    return { ok: false, why: `LAIN ${older.version} speaks Core protocol ${older.protocol}; LAIN ${older === theirs ? ours.version : theirs.version} speaks ${older === theirs ? ours.protocol : theirs.protocol}. Restart the older one (LAIN ${older.version}) to update it before connecting.` };
  }
  const cmp = M.compare(theirs.version, ours.version);
  return { ok: true, note: cmp < 0 ? `this surface runs LAIN ${theirs.version}; LAIN ${ours.version} is installed — restart it to update` : cmp > 0 ? `LAIN ${theirs.version} is installed; this Core still runs ${ours.version} — restart it to update` : null };
}

module.exports = { PROTOCOL, attach };
