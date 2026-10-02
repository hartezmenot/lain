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
  // CORE (2026-10-02): what nearly every coding turn uses — read, search, edit, run, ask, finish.
  read: ['read_file', 'list_dir', 'grep', 'glob'],
  edit: ['edit_file', 'apply_patch', 'write_file'],
  shell: ['run_bash', 'run_powershell', 'run_cmd'],
  verify: ['run_tests'],
  ask: ['ask_user'],
  contract: ['request_completion'],
  fileops: ['insert_at', 'delete_range', 'append_file', 'move_file', 'delete_file'],
  // CAPABILITY PACKS — loaded when the task needs them, never on every request.
  intel: ['file_info', 'symbols', 'locate', 'understand', 'dependents', 'read_symbol', 'check_symbols', 'recall_evidence'],
  semantic: ['rename_symbol', 'replace_symbol', 'insert_near_symbol', 'remove_symbol', 'find_residue', 'review_changes'],
  jobs: ['python_run', 'process_run', 'run_background', 'job_wait', 'job_status', 'job_stop'],
  plan: ['plan_write', 'plan_findings', 'plan_step_done', 'verify_task', 'task_contract', 'report_finding', 'discover_tests'],
  knowledge: ['concept', 'architecture', 'wiring', 'scratch', 'engineering_brief'],
  services: ['service_start', 'service_check', 'observe', 'observe_start', 'observe_stop'],
  reach: ['request_browser', 'request_computer'],
  delegation: ['delegate', 'integrate_candidate', 'ab_compare'],
  web: ['web_fetch', 'download_file'],
  lain: ['lain_workspace'],
  // MCP (2026-10-02): mcp_call and every natively described `mcp__<server>__<tool>` (familyOf). In CORE and Chat; a
  // read-only role (SCOUT, RESEARCHER, VERIFIER) is never handed another program's tools.
  mcp: ['mcp_call'],
});

/** Task shape → families. `null` = the whole registry. */
const CORE = ['read', 'edit', 'shell', 'verify', 'ask', 'contract', 'mcp'];
const SHAPES = Object.freeze({
  explain: ['read', 'intel', 'ask', 'contract', 'knowledge', 'lain'],
  rename: [...CORE, 'intel', 'semantic', 'plan'],
  geometry: [...CORE, 'intel', 'semantic', 'services', 'plan'],
  'symbol-edit': [...CORE, 'intel', 'semantic', 'plan'],
  // THE CHANGE CLASSES (changeclass.js) — every profile, not only FAST/ECO (measured 2026-10-02: NORMAL described all
  // 63 schemas / 60 KB on every request, 85 % of them non-core, while a label edit used four).
  core: CORE,
  direct: CORE,
  narrow: [...CORE, 'intel', 'semantic', 'fileops'],
  agent: [...CORE, 'intel', 'plan', 'fileops'],
  // CHAT: conversation and research; it reads, it never edits (sessionviews / tools/index.js enforce that).
  chat: ['read', 'ask', 'web', 'lain', 'contract', 'mcp'],
});

/**
 * PACKS A REQUEST'S OWN WORDS ASK FOR — plain signals, never a model call. Added on top of the class's set.
 */
const SIGNALS = [
  [/\bhttps?:\/\/|\b(docs?|documentation|changelog|release notes|latest version|on the web|search (?:the )?(?:web|online|internet)|look (?:it )?up online|npm page|github issue)\b/i, ['web']],
  [/\b(release|publish|package|installer|ship it|distribut\w+|version bump)\b/i, ['jobs', 'plan', 'web']],
  [/\b(dev server|start (?:the )?server|run (?:the )?app|localhost|port \d{2,5}|service)\b/i, ['services', 'jobs']],
  [/\b(in parallel|subagents?|delegate|agents?\b|scouts?|several (?:independent )?(?:questions|investigations))\b/i, ['delegation']],
  [/\b(architecture|wiring|how (?:does|do) .{1,40} (?:fit|connect|work) together|concept|module map)\b/i, ['knowledge', 'intel']],
  [/\b(rename .{1,40} (?:everywhere|across|in all)|references?|callers?|who uses|dependents?|symbol)\b/i, ['intel', 'semantic']],
  [/\b(background|long[- ]running|takes? (?:a )?(?:long|while|minutes)|watch (?:the )?(?:build|tests))\b/i, ['jobs']],
  [/\b(computer|desktop|window|click on|type into|screen(?:shot)?)\b/i, ['reach']],
];

/**
 * THE FAMILIES FOR ONE TURN — the class's pack plus what the request's words ask for. `null` = the whole registry
 * (a PHASED task: a migration, a new architecture, a long project).
 *   cls       DIRECT | NARROW | AGENT | PHASED (changeclass.js) — null when unclassified (the Coding Agent default)
 *   thread    'chat' for the Chat view
 *   effort    LAIN execution effort for a model with no native effort: low narrows, max widens
 */
function packsFor({ cls = null, thread = null, text = '', effort = null } = {}) {
  if (thread === 'chat') return [...SHAPES.chat];
  if (cls === 'PHASED' || effort === 'max') return null;
  const base = cls === 'DIRECT' ? SHAPES.direct : cls === 'NARROW' ? SHAPES.narrow : SHAPES.agent;
  const fams = new Set(effort === 'low' && !cls ? SHAPES.narrow : base);
  for (const [re, add] of SIGNALS) if (re.test(String(text || ''))) for (const f of add) fams.add(f);
  return [...fams];
}

/**
 * OPEN THE FUNNEL FOR A NEW TURN — once per classified request, never between two steps of one turn. Sticky: the set
 * a session has used only grows (cache-stable prefix), and a PHASED turn keeps the whole registry from then on.
 */
function openForTurn(session, { cls = null, thread = null, text = '', effort = null, key = null } = {}) {
  if (!session) return null;
  if (key && session._funnelKey === key && session._toolFunnel) return session._toolFunnel;
  session._funnelKey = key;
  const fams = packsFor({ cls, thread, text, effort });
  if (!fams) return open(session, null, { why: `${cls || 'max effort'} — the whole registry` });
  const name = `turn-${(cls || (thread === 'chat' ? 'chat' : 'agent')).toLowerCase()}`;
  return openFamilies(session, name, fams, { why: `${cls || thread || 'unclassified'} — core + packs` });
}

/**
 * A SUBAGENT'S TOOLS ARE ITS ROLE'S (2026-10-02). Measured: every SCOUT was described the parent's whole registry
 * (~74 KB per request) — read-only scouts carrying write, delegation and desktop tools they can never use.
 */
const ROLE_PACKS = Object.freeze({
  SCOUT: ['read', 'intel'],
  RESEARCHER: ['read', 'intel', 'web'],
  VERIFIER: ['read', 'intel', 'shell', 'verify'],
  FOUNDATION: [...CORE, 'intel', 'semantic', 'fileops'],
  IMPLEMENTER: [...CORE, 'intel', 'semantic', 'fileops'],
});
function openForRole(session, role) {
  if (!session) return null;
  const fams = ROLE_PACKS[String(role || '').toUpperCase()];
  if (!fams) return null;
  const shape = `role-${role}`;
  if (session._toolFunnel && session._toolFunnel.shape === shape) return session._toolFunnel;
  session._funnelSticky = null;
  return openFamilies(session, shape, fams, { why: `${role} subagent — role tools only` });
}

function openFamilies(session, shape, fams, { why = '' } = {}) {
  if (session._funnelSticky === 'all') { session._toolFunnel = null; return null; }
  const families = [...new Set([...(Array.isArray(session._funnelSticky) ? session._funnelSticky : []), ...fams, ...(session._funnelNext || [])])];
  session._funnelSticky = families.slice();
  session._funnelNext = [];
  session._toolFunnel = { shape, families, why: String(why || '').slice(0, 200), misses: [], at: Date.now() };
  return session._toolFunnel;
}

function familyOf(name) {
  if (/^mcp__/.test(String(name))) return 'mcp';
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

module.exports = { FAMILIES, SHAPES, SIGNALS, ROLE_PACKS, familyOf, open, openForTurn, openForRole, packsFor, close, reopen, shows, miss, filter, view };
