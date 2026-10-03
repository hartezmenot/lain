'use strict';

/** The tool registry. ONE vocabulary — there is no second list of names, no parallel schema set, and no "advertised but not dispatchable" gap */

const shell = require('./shell');
const fsTools = require('./fs');
const editTools = require('./edit');
const search = require('./search');
// PROJECT INTELLIGENCE - `understand` and `locate`.
const intel = require('./intel');
const ask = require('./ask');
const jobTools = require('./jobs');
const execTools = require('./exec');
// SEMANTIC EDITS are always offered, like search and unlike `computer`: they need no bridge, no runtime and no configuration, and the alternative…
const semanticTools = require('./semantic');
// `observe_*` IS ALWAYS OFFERED TOO, for the same reason and a stronger one.
const observeTools = require('./observe');
// TESTS ARE ALWAYS OFFERED, for the sharpest version of the reason semantic edits are.
const testTools = require('./tests');
// THE DURABLE LAYER — `concept`, `architecture`, `wiring`, `scratch` — is always offered, for the same reason and for the one the compaction design…
const conceptTools = require('./concept');
// THE HARNESS TOOLS — `verify_task`, `service_start`, `service_check`, `observe` — are always offered, for the sharpest version of the reason the test…
const harnessTools = require('./harness');

const TOOLS = {
  ...fsTools.tools, ...editTools.tools, ...search.tools, ...intel.tools, ...shell.tools,
  ...ask.tools, ...jobTools.tools,
  ...execTools.tools, ...observeTools.tools, ...semanticTools.tools,
  ...testTools.tools, ...conceptTools.tools,
  ...harnessTools.tools,
  // DOWNLOAD_FILE is its own permission class; see tools/download.js.
  ...require('./download').tools,
  // LAIN describing itself — models, usage, MCP, where a setting lives — from
  // the same projection the window reads. Read-only; see tools/lainself.js.
  ...require('./lainself').tools,
  // Addressable evidence: an earlier deterministic result, by id (evidencerefs.js).
  ...require('./recall').tools,
};

/** THE ACTIVE VOCABULARY — still ONE list, computed in one place. */
/** THE TOOLS A SESSION HAS: the fixed set (tools/core.js), plus Computer Control, the Preview and Laya when present. */
function active(ctxApp) {
  const app = typeof ctxApp === 'function' ? ctxApp() : ctxApp;
  return simpleActive(app);
}

/** SIMPLE (S2): the core set, plus Computer Control and the Preview when the person enabled them. */
function simpleActive(app) {
  const core = require('./core');
  const full = legacyActive(app);
  const out = {};
  for (const n of core.CORE) out[n] = core.tools[n] || full[n];
  for (const [n, t] of Object.entries(full)) if (n === 'preview') out[n] = t;
  // ONE `computer` TOOL (S5.1, tools/computerone.js) while Computer Control is on, or from the start when Auto is chosen;
  // kept once present. The first call in Auto turns Computer Control on (execmode.autoComputer) — the desktop still asks.
  const s = app && app.session;
  if (s && (s._computerTools || require('../computercontrol').enabled(app) || require('../execmode').autoChosen(app, s))) {
    s._computerTools = true;
    out.computer = require('./computerone').tools.computer;
  }
  // Laya (S9): one optional tool, decided once per session so the cached tool list never flickers.
  if (s && s._semanticSearch === undefined) s._semanticSearch = require('./semanticsearch').installed(app);
  if (s && s._semanticSearch) out.semantic_search = require('./semanticsearch').tools.semantic_search;
  return out;
}

function legacyActive(ctxApp) {
  const app = typeof ctxApp === 'function' ? ctxApp() : ctxApp;
  let mcpConfigured = false;
  try { mcpConfigured = require('../mcp').configured(require('../config').load()); } catch { mcpConfigured = false; }
  let out = TOOLS;
  // `computer` FOLLOWS THE TRANSPORT, because it is LAIN's operation and not any bridge's: the model asks to click or to look, and LAIN decides which of…
  const computerMcp = require('../computermcp').existing(app);
  // COMPUTER CONTROL IS OFF UNTIL THE PERSON TURNS IT ON for this session (computercontrol.js): no desktop tool exists
  // before that; OBSERVE gets the structured reads and one capture, INTERACT/FULL the mouse and keyboard too.
  const cu = require('../computercontrol');
  if (computerMcp && computerMcp.connected && cu.enabled(app)) out = { ...out, ...require('./computermcp').tools, ...(cu.tier(app) === 'OBSERVE' ? { computer_capture: require('./computerinput').tools.computer_capture } : require('./computerinput').tools) };
  else if (mcpConfigured && cu.enabled(app)) out = { ...out, ...require('./computer').tools };
  // LAIN FOR CHROME follows its own transport too, for the same reason: a model on an ordinary coding task is never offered control of the user's real…
  const lainChrome = require('../lainchrome').existing(app);
  if (lainChrome && lainChrome.connected) out = { ...out, ...require('./chrometab').tools };
  // LOOKING SOMETHING UP, and the two halves follow different rules
  out = { ...out, ...require('./web').fetchTools };
  // CONNECTED MCP SERVERS' TOOLS described natively — a small set or pinned servers, under the person's trust
  // (mcpreg.js); the rest are reached through search_capabilities + mcp_call.
  try { const mcpTools = require('../integrations').toolDefs(app); if (Object.keys(mcpTools).length) out = { ...out, ...mcpTools }; } catch { /* none */ }
  // SKILLS AND LAZY MCP (tools/capreg.js): search_capabilities / use_skill / mcp_call exist only once something is
  // installed — zero skills and zero MCP servers cost a request nothing.
  if (app) { try { const cap = require('./capreg').active(app); if (Object.keys(cap).length) out = { ...out, ...cap }; } catch { /* none */ } }
  if (app?.session?.cowork) out = { ...out, ...require('./cowork').tools };
  const session = app && app.session;
  // THE PREVIEW TOOL FOLLOWS THE PREVIEW: offered once a Preview has been attached in this session, then kept for it.
  if (session && !session._previewTools) { try { if (require.cache[require.resolve('../workshop')] && require('../workshop/previewinput').attached(app)) session._previewTools = true; } catch { /* none */ } }
  if (!app || (session && session._previewTools) || process.env.LAIN_PREVIEW_TOOLS === '1') out = { ...out, ...require('./preview').tools };
  return out;
}

/** Why a registered tool is not part of this input's vocabulary, or '' when it simply does not exist. */
function notOffered(name) {
  if (name === 'job_wait') return 'there is no waiting on a job inside a turn: a background job\'s result rejoins this session by itself when it ends (job_status reads it once). If you need the result now, run the command in the foreground (run_bash / run_tests).';
  if (name === 'preview') return 'no LAIN Preview is attached to this session — open the project in the Preview (`lain preview`) first.';
  return '';
}

/** Schemas sent to the model. */
function schemas(app, { turn = false, session: turnSession = null } = {}) {
  const all = active(() => app);
  // The fixed set; an agent never gets Agent, and an explore agent only reads.
  const sess = turnSession || (app && app.session) || null;
  let list = Object.keys(all);
  if (sess && sess._agentType) list = list.filter((n) => require('../agenttypes').allows(sess._agentSpec || require('../agenttypes').BUILT_IN[sess._agentType], n));   // a type's tools; never Agent or computer
  return list.map((n) => all[n].schema);

}

function has(name, app) { return Object.prototype.hasOwnProperty.call(active(() => app), name); }
function isMutating(name, app) { const t = active(() => app)[name]; return Boolean(t && t.mutates); }
function effect(name, app) { const t = active(() => app)[name]; return t && t.effect ? t.effect : null; }
function names(app) { return Object.keys(active(() => app)); }

/** Execute one call. An unknown name is a normal, recoverable result — the model gets told what does exist and picks again. */
async function execute(name, input, ctx, { canonical = false, deferred = false } = {}) {
  const app = (ctx && ctx.app) || null;
  // A MODEL'S OWN TOOL DIALECT (discipline/dialect.js) Claude's Read/Edit/Grep, Codex's shell/apply_patch, GLM's bash/str_replace: translated here and…
  if (!canonical) {
    const s0 = (ctx && ctx.session) || (app && app.session) || null;
    const family = s0 && s0._toolDialect;
    const dl = family ? require('../discipline/dialect').resolve(name, input, family) : null;
    if (dl) {
      if (!dl.calls.length) return { output: `${name}: nothing to apply — no file operation was recognised`, isError: true };
      const outs = []; const mutated = []; let last = null;
      for (const c of dl.calls) {
        // eslint-disable-next-line no-await-in-loop -- one patch's file operations apply in order.
        const reg = active(() => app);
        last = await execute(c.name === 'run_bash' && !reg.run_bash && reg.shell ? 'shell' : c.name, c.input, ctx, { canonical: true });
        outs.push(dl.calls.length > 1 ? `${c.name} ${(c.input && c.input.path) || ''}: ${last.output}` : last.output);
        for (const m of last.mutated || []) mutated.push(m);
        if (last.isError) break;
      }
      return { ...last, output: outs.join('\n'), mutated, dialect: dl.from };
    }
  }
  // A DEFERRED TOOL (simple mode) runs by its own name too, once tool_search has shown it — same door, same gates;
  // the described list stays fixed. Retired names (ceremony, judges) never run.
  const tool = (deferred ? legacyActive(app) : active(() => app))[name] || require('./core').deferred(app)[name];
  if (!tool) {
    // A NAME THAT IS NOT OURS BUT WHOSE MEANING IS — a foreign namespace ("functions/grep") or a known foreign tool ("print_tree").
    const alias = require('../toolalias').resolve(name, input, (n) => has(n, app));
    if (alias) {
      const r = await execute(alias.name, alias.input, ctx);
      return { ...r, output: `${alias.note}\n${r.output}`, adaptedFrom: alias.from };
    }
    // THE CATALOGUE ONCE PER TURN. The same unknown name again in the same turn
    // gets the short answer: the list was already given and has not changed.
    const s = (ctx && ctx.session) || (app && app.session) || null;
    const offered = names(app);
    const seen = s ? (s._unknownTools && s._unknownTools.turn === (ctx && ctx.turnId) ? s._unknownTools : (s._unknownTools = { turn: ctx && ctx.turnId, names: new Set(), listed: false })) : null;
    const again = Boolean(seen && seen.names.has(name));
    if (seen) seen.names.add(name);
    if (again || (seen && seen.listed)) {
      return { output: `unknown tool "${name}"${again ? ' — already reported this turn; do not call it again' : ''}. It does not exist; the available tools were listed earlier in this turn.`, isError: true };
    }
    if (seen) seen.listed = true;
    const gated = notOffered(name);
    if (gated) return { output: `"${name}" is not offered for this task: ${gated}`, isError: true };
    return { output: `unknown tool "${name}". Available: ${offered.join(', ')}`, isError: true };
  }
  // THE DESKTOP IS THE PRIMARY AGENT'S (Phase CU): a subagent never drives it unless the person set cfg.computer.agents — a permission, not exposure, so…
  { const s = (ctx && ctx.session) || null; const spec = s && s._agentType ? (s._agentSpec || require('../agenttypes').BUILT_IN[s._agentType]) : null; if (spec && (name === 'Agent' || (spec.readOnly && tool.mutates && name !== 'call_tool'))) return { output: `DENIED: ${name === 'Agent' ? 'an agent cannot start agents' : `the ${spec.name} agent only reads — ${name} changes things`}.`, isError: true, denied: true }; }
  { const s = (ctx && ctx.session) || null; if (s && (s._agentRole || s._agentType) && (name === 'computer' || /^computer_/.test(name)) && !(app && app.cfg && app.cfg.computer && app.cfg.computer.agents)) return { output: `DENIED: ${name} drives the person's desktop, and subagents never do (only the primary agent).`, isError: true, denied: true }; }

  // THE CHAT VIEW DISCUSSES; IT NEVER WRITES
  const chatView = ctx && ctx.app && ctx.app.session && ctx.app.session.thread === 'chat';
  if (chatView && tool.mutates) {
    return { output: `DENIED CHAT_VIEW_READ_ONLY: ${name} changes things, and the Chat view only reads and plans. Put it in the plan; the Coding view implements it.`, isError: true, denied: true };
  }
  // THE BOT IN THE IDE READS; THE CODING AGENT WRITES.
  const botTurn = ctx && ctx.app && ctx.app.session && ctx.app.session._botTurn;
  if (botTurn && tool.mutates) {
    return { output: `DENIED BOT_READ_ONLY: ${name} changes things, and the BOT does not edit. Hand the task to the Coding Agent.`, isError: true, denied: true };
  }
  // A PLUGIN COMMAND'S TURN CARRIES ITS GRANT (plugins.js): a tool outside the permissions the person granted that plugin is refused here, whatever the…
  const pluginDenied = require('../plugins').denies(ctx && ctx.app && ctx.app.session, name, tool);
  if (pluginDenied) return { output: pluginDenied, isError: true, denied: true };
  const roSession = (ctx && ctx.app && ctx.app.session) || (ctx && ctx.session) || null;
  // ---- EXECUTION DISCIPLINE, MECHANICALLY (discipline/) — contextual, only when it applies ------------------------
  const lifeNow = roSession && roSession.lifecycle;
  if (lifeNow && lifeNow.discipline) {
    // NO BLIND RETRIES: the same failing command with nothing changed since would observe the same thing again.
    const blind = require('../discipline/retry').check(lifeNow, name, input);
    if (blind) return { output: blind, isError: true, denied: true, blindRetry: true };
  }
  // THE SESSION'S PERMISSION MODE (execmode.js).
  const modeVerdict = await require('../execmode').gate(ctx, name, tool, input);
  if (!modeVerdict.ok) return { output: modeVerdict.output, isError: true, denied: true };
  const exec = await require('./download').executeGuard(ctx, name, input);
  if (exec && !exec.ok) return { output: exec.output, isError: true, denied: true };
  // ---- THE PERSON'S HOOKS (userhooks.js): PreToolUse may DENY or make this call ASK. "allow" is no exemption —
  // every refusal above and the gate below still stand (a hook cannot disable a mandatory invariant).
  const hooks = require('../userhooks');
  const pre = app ? await hooks.fire(app, 'PreToolUse', { tool: name, input }, { match: name }) : { decision: null };
  if (pre.decision === 'deny') return { output: `DENIED HOOK: ${pre.reason || 'a PreToolUse hook refused this call'}`, isError: true, denied: true };
  if (pre.decision === 'ask') {
    const v = await require('../gate').externalApproval(name, input, ctx, () => ({ what: name, reason: `your hook asks first: ${pre.reason || 'confirm this call'}`, details: JSON.stringify(input || {}).slice(0, 400) }));
    if (!v.ok) return { output: v.output, isError: true, denied: true };
  }

  const verdict = await require('../gate').check(name, input, ctx, {
    mutates: Boolean(tool.mutates), effect: tool.effect || null, approval: tool.approval || null,
  });
  if (!verdict.ok) return { output: verdict.output, isError: true };
  const args = input && typeof input === 'object' ? input : {};
  const post = (res) => { if (app) hooks.fire(app, 'PostToolUse', { tool: name, input: args, isError: Boolean(res && res.isError) }, { match: name }).catch(() => {}); return res; };
  // ONE LIFECYCLE FOR EVERY SOURCE WRITE
  const mutation = require('../mutation');
  if (mutation.isSourceMutation(name)) {
    return post(await mutation.transact({ name, input: args, ctx: ctx || {}, apply: () => tool.run(args, ctx) }));
  }
  let r;
  try {
    r = await tool.run(args, ctx);
    r = r && typeof r === 'object' ? r : { output: String(r == null ? '' : r) };
  } catch (e) {
    return { output: `${name} failed: ${(e && e.message) || e}`, isError: true };
  }
  // DID THE WRITE LEAVE THE FILE PARSEABLE?
  if (r.mutated && r.mutated.length && !r.isError) {
    try {
      // THE PARSE IS EVIDENCE (discipline/checks.js `parse`): a clean parse proves a DIRECT change; a broken one is
      // this task's own failure. Never a gate on anything the model does next.
      const life = (ctx && ctx.app && ctx.app.session && ctx.app.session.lifecycle) || (ctx && ctx.session && ctx.session.lifecycle) || null;
      const onResult = life && life.discipline ? (abs, res) => {
        const rel = require('path').relative((ctx && ctx.cwd) || process.cwd(), abs).replace(/\\/g, '/');
        life.discipline.checks.parse({ rel, ok: res.ok !== false, message: res.message || '', gen: life.mutationSeq || 0 });
      } : null;
      const note = await require('../diagnostics').reportFor(r.mutated, ctx && ctx.cwd, { onResult });
      if (note) r = { ...r, output: String(r.output || '') + note, syntaxError: true };
    } catch { /* a checker that fails must never fail the edit it was checking */ }
    // AND THE THIRD RUNG: THE PROJECT'S OWN LINTER, ON THIS FILE
    try {
      const lint = await require('../filecheck').reportFor(r.mutated, ctx && ctx.cwd);
      if (lint) r = { ...r, output: String(r.output || '') + lint, diagnostics: true };
    } catch { /* same rule: a checker may never fail the edit it was checking */ }
  }
  return post(r);
}

module.exports = { TOOLS, active, legacyActive, schemas, execute, has, isMutating, effect, names };
