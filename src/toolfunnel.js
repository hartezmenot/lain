'use strict';

/**
 * THE PER-TURN TOOL FUNNEL — the turn is SHOWN the capabilities its task needs
 * (2026-09-25).
 *
 * The registry (tools/index.js) stays the one source of what exists and what a
 * call may do. What changes is what a request DESCRIBES: 59 schemas, ~55 KB,
 * were sent on every request of every turn, whether the question was "what does
 * this function do?" or "rename this and update callers". A model told about
 * `download_file`, `delegate` and `service_start` while explaining one function
 * pays for them on every step and is invited to wander.
 *
 * So Core builds the set from the TASK'S STRUCTURE, which it already resolved:
 *
 *   explain      a question about the Selection     read · symbols · evidence · ask
 *   rename       "rename this to X"                 read · semantic edit · diagnostics · tests · plan
 *   geometry     "move this down" on a picked       read · edit · verify · plan
 *                element
 *   symbol-edit  a change to the selected symbol    read · edit · tests · plan
 *
 * and anything without such a structure gets the whole registry, as before.
 *
 * IT IS EXPOSURE, NOT PERMISSION. A registered tool the funnel did not show still
 * runs if the model calls it (tools/index.js `execute` reads the full active
 * set); the call is counted as a MISS. A funnel that is too narrow shows up in
 * the metrics as misses — it never shows up as a refused action.
 *
 * CACHE-STABLE (2026-09-26, prompt audit F3). The tool list is part of the
 * prompt prefix a provider caches; changing it re-bills everything after it.
 *   · NO MID-TURN WIDENING: a miss is counted, and its family joins from the
 *     NEXT turn — never between two steps of one turn.
 *   · STICKY PER SESSION: a session's funnel only grows (the union of every
 *     shape it used, plus its misses), and a turn that needed the whole
 *     registry keeps the whole registry. Narrowing again would change the
 *     prefix just as widening does. So the list converges and then stays put.
 *   · ORDER is the registry's (filter keeps it), whatever order families join.
 */

const FAMILIES = Object.freeze({
  read: ['read_file', 'list_dir', 'file_info', 'grep', 'glob', 'symbols', 'locate', 'understand', 'dependents', 'read_symbol', 'check_symbols', 'recall_evidence'],
  semantic: ['rename_symbol', 'replace_symbol', 'insert_near_symbol', 'remove_symbol', 'find_residue', 'review_changes'],
  edit: ['edit_file', 'apply_patch', 'write_file', 'insert_at', 'delete_range', 'append_file', 'move_file', 'delete_file'],
  shell: ['run_bash', 'run_powershell', 'run_cmd', 'python_run', 'process_run', 'run_background', 'job_wait', 'job_status', 'job_stop'],
  verify: ['discover_tests', 'run_tests', 'verify_task'],
  plan: ['plan_write', 'plan_findings', 'plan_step_done'],
  ask: ['ask_user'],
  knowledge: ['concept', 'architecture', 'wiring', 'scratch', 'engineering_brief'],
  services: ['service_start', 'service_check', 'observe', 'observe_start', 'observe_stop'],
  reach: ['request_browser', 'request_computer'],
  delegation: ['delegate', 'integrate_candidate', 'ab_compare'],
  web: ['web_fetch', 'download_file'],
  lain: ['lain_workspace'],
});

/** Task shape → families. `null` = the whole registry. */
const SHAPES = Object.freeze({
  explain: ['read', 'ask', 'knowledge', 'lain'],
  rename: ['read', 'semantic', 'edit', 'verify', 'plan', 'ask'],
  geometry: ['read', 'edit', 'semantic', 'verify', 'services', 'plan', 'ask'],
  'symbol-edit': ['read', 'semantic', 'edit', 'verify', 'plan', 'ask'],
  // FAST and ECO (profile.js): the working set of an ordinary coding task. Everything else still RUNS if called
  // (a miss — its family joins from the next turn); it is simply not described on every request. Measured: the full
  // registry is ~74 schemas / ~45 KB of every request, before a single word of the task.
  core: ['read', 'edit', 'shell', 'verify', 'plan', 'ask'],
});

function familyOf(name) {
  for (const [f, list] of Object.entries(FAMILIES)) if (list.includes(name)) return f;
  return null;
}

/**
 * SET THE FUNNEL FOR THIS TURN. `shape` is one of SHAPES or null. Tools the
 * registry gates on its own (migration, the BOT's handoff, computer, Chrome,
 * cowork) are left to that gating and always pass the funnel when active.
 */
function open(session, shape, { why = '' } = {}) {
  if (!session) return null;
  const fams = shape && SHAPES[shape] ? SHAPES[shape] : null;
  const sticky = session._funnelSticky;
  if (!fams || sticky === 'all') {
    // THE WHOLE REGISTRY, and from now on for this session.
    session._funnelSticky = 'all';
    session._toolFunnel = null;
    return null;
  }
  const families = [...new Set([...(Array.isArray(sticky) ? sticky : []), ...fams, ...(session._funnelNext || [])])];
  session._funnelSticky = families.slice();
  session._funnelNext = [];
  session._toolFunnel = { shape, families, why: String(why || '').slice(0, 200), misses: [], at: Date.now() };
  return session._toolFunnel;
}

/**
 * Between turns. The funnel's families stay (sticky); only the per-turn record
 * ends. With no funnel open, tools/index.js shows the whole registry — which is
 * what a session that never had a focused turn has always had.
 */
function close(session) { if (session) session._toolFunnel = null; }

/** What a turn with no focused shape shows: the sticky set, if the session has one. */
function reopen(session) {
  if (!session || session._toolFunnel || !Array.isArray(session._funnelSticky)) return session && session._toolFunnel;
  session._toolFunnel = { shape: 'sticky', families: session._funnelSticky.slice(), why: 'the set this session has used', misses: [], at: Date.now() };
  return session._toolFunnel;
}

/** Is this tool shown to the current turn? Tools of no family (gated elsewhere) always are. */
function shows(session, name) {
  const f = session && session._toolFunnel;
  if (!f) return true;
  const fam = familyOf(name);
  return !fam || f.families.includes(fam);
}

/** A call to a tool the funnel did not show: counted; its family joins from the NEXT turn. */
function miss(session, name) {
  const f = session && session._toolFunnel;
  if (!f || shows(session, name)) return false;
  const fam = familyOf(name);
  f.misses.push({ tool: name, family: fam, at: Date.now() });
  if (fam) session._funnelNext = [...new Set([...(session._funnelNext || []), fam])];
  return true;
}

/** Filter a list of tool names by the turn's funnel. */
function filter(session, names) { return names.filter((n) => shows(session, n)); }

/** For metrics: the shape, how many tools were shown, and the misses. */
function view(session, allNames = null) {
  const f = session && session._toolFunnel;
  if (!f) return { shape: null, shown: allNames ? allNames.length : null, of: allNames ? allNames.length : null, misses: [] };
  return { shape: f.shape, families: f.families.slice(), shown: allNames ? filter(session, allNames).length : null, of: allNames ? allNames.length : null, misses: f.misses.slice(), why: f.why };
}

module.exports = { FAMILIES, SHAPES, familyOf, open, close, reopen, shows, miss, filter, view };
