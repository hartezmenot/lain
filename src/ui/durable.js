'use strict';

/** WHICH OPERATIONS EARN A PERMANENT ROW, AND WHICH ARE LIVE STATE. */

const V = () => require('./phrasing');

/** Verbs whose effect is a change to the project rather than a look at it. */
const CHANGED = new Set(['Wrote', 'Edited', 'Patched', 'Appended', 'Inserted', 'Deleted', 'Moved']);

/** Calls that are durable for a reason the verb cannot express. */
const DURABLE_TOOLS = new Set(['run_tests', 'verify_task', 'ask_user', 'service_start']);

function durable(a) {
  if (!a) return false;
  // A FAILURE IS ALWAYS DURABLE - see the header. This is first so that a
  // failed read is kept while a successful one is not.
  if (a.ok === false) return true;
  if (DURABLE_TOOLS.has(String(a.name || ''))) return true;
  if (CHANGED.has(V().verbOf(a.name))) return true;
  // THE SYMBOL EDITS HAVE NO VERB (replace_symbol, rename_symbol…), so a live edit through them left no row — and no [Diff] — until the turn settled…
  if (require('./turnsections').EDIT.has(String(a.name || ''))) return true;
  // WHOEVER PRODUCED THE ACTION MAY SAY SO.
  return Boolean(a.durable);
}

/** WHICH OF A TURN'S CALLS ARE KEPT, as a set of the very objects to keep. */
function keepers(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const keep = new Set();
  let verdict = null;
  for (const a of list) {
    if (durable(a)) keep.add(a);
    else if (a && a.ok !== false && /^run_/.test(String(a.name || ''))) verdict = a;
  }
  if (verdict) keep.add(verdict);
  return keep;
}

module.exports = { durable, keepers, CHANGED, DURABLE_TOOLS };
