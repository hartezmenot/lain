'use strict';

/**
 * The tool registry. ONE vocabulary — there is no second list of names, no
 * parallel schema set, and no "advertised but not dispatchable" gap (V1 had 68
 * schemas against 78 dispatch entries).
 *
 * A tool is `{ mutates, schema, run(input, ctx) }` and returns
 * `{ output, isError?, mutated?[], meta? }`. `run` never throws for an ordinary
 * failure — a failure is a result the model should see.
 */

const shell = require('./shell');
const fsTools = require('./fs');
const editTools = require('./edit');
const search = require('./search');
// PROJECT INTELLIGENCE - `understand` and `locate`. Separated from search.js
// because they COMPOSE the primitives there rather than being more of them,
// and because that file crossed the god-object guard when they arrived.
const intel = require('./intel');
const ask = require('./ask');
const planTools = require('./plan');
const jobTools = require('./jobs');
const execTools = require('./exec');
// SEMANTIC EDITS are always offered, like search and unlike `computer`: they
// need no bridge, no runtime and no configuration, and the alternative
// behaviour they replace — read a whole file to change one function, then write
// the whole file back — is the most expensive habit a model has on any task
// with code in it. See tools/semantic.js.
const semanticTools = require('./semantic');
// MIGRATION is always offered, for the same reason as semantic edits and for a
// sharper one. It needs no bridge and no configuration, and the behaviour it
// replaces is not merely expensive — it is WRONG: asked to migrate X to Y, a
// model writes Y, leaves X exactly where it was, and reports success truthfully
// about what it added and falsely about what was asked. A tool that only
// appeared once something detected a migration would be missing at the one
// moment that failure forms. See tools/migrate.js.
const migrateTools = require('./migrate');

// `observe_*` IS ALWAYS OFFERED TOO, for the same reason and a stronger one.
// It needs no bridge — a run that writes a log is watchable with no screen at
// all, and the capture rules simply record NOT SEEN when nothing can look. And
// it is the cheap alternative to a behaviour the model will otherwise invent
// for itself: watching a long run by screenshotting it in a loop. A tool that
// only appears once a Probe is connected would be missing at exactly the moment
// the expensive habit forms.
const observeTools = require('./observe');
// TESTS ARE ALWAYS OFFERED, for the sharpest version of the reason semantic
// edits are. What they replace is not an expensive habit but a FALSE REPORT:
// "there are no tests" said about a tree with 179 of them, and "all tests pass"
// said about a run that never happened. Both were reachable because discovery
// and execution had no vocabulary of their own — see testing.js. A tool that
// only appeared once something had detected a test suite would be missing at
// exactly the moment the model decides there is nothing to detect.
const testTools = require('./tests');
// THE DURABLE LAYER — `concept`, `architecture`, `wiring`, `scratch` — is always
// offered, for the same reason and for the one the compaction design turns on:
// the knowledge these hold is exactly the knowledge a conversation loses, so a
// tool that appeared once something had detected a vocabulary would be missing
// at the moment the definition was in hand — and the moment after a compaction
// is the moment a model most needs what a previous context recorded. They write
// only LAIN's own .lain/ state (lainstore.js), never user source. See
// tools/concept.js for why they are four tools and one family.
const conceptTools = require('./concept');
// THE HARNESS TOOLS — `verify_task`, `service_start`, `service_check`,
// `observe` — are always offered, for the sharpest version of the reason the
// test tools are. What each replaces is not an expensive habit but a WRONG
// ONE: "I've fixed it" said with nothing run; `npm run dev &` left on a port
// nobody recorded; a `sleep 5` standing in for a health check; a screenshot
// taken to read a value the DOM already knows. A tool that only appeared once
// something had detected a task, a service or a browser would be missing at
// exactly the moment each of those habits forms. See tools/harness.js.
const harnessTools = require('./harness');

const TOOLS = {
  ...fsTools.tools, ...editTools.tools, ...search.tools, ...intel.tools, ...shell.tools,
  ...planTools.tools, ...ask.tools, ...jobTools.tools,
  ...execTools.tools, ...observeTools.tools, ...semanticTools.tools,
  ...migrateTools.tools, ...testTools.tools, ...conceptTools.tools,
  ...harnessTools.tools,
  // ALWAYS OFFERED: a request for a capability LAIN does not hold yet is itself
  // a real tool call, admitted and executed — see tools/capability.js.
  ...require('./capability').tools,
  // Delegation to bounded subagents and the A/B candidate workflow.
  ...require('./delegate').tools,
  // DOWNLOAD_FILE is its own permission class; see tools/download.js.
  ...require('./download').tools,
  // LAIN describing itself — models, usage, MCP, where a setting lives — from
  // the same projection the window reads. Read-only; see tools/lainself.js.
  ...require('./lainself').tools,
  // The BOT handing implementation to the Coding Agent — tools/handoff.js.
  ...require('./handoff').tools,
  // Addressable evidence: an earlier deterministic result, by id (evidencerefs.js).
  ...require('./recall').tools,
  // The model's own pointer and keyboard — inside the LAIN Preview only (tools/preview.js): added by `active` once a
  // Preview is attached (below), like `computer` follows its transport.
  // The task contract and the request to finish — LAIN decides completion (tools/contract.js, discipline/).
  ...require('./contract').tools,
};

/**
 * THE ACTIVE VOCABULARY — still ONE list, computed in one place.
 *
 * ONE NAME FOR THE MACHINE, and it is `computer`.
 *
 * There used to be three. `desktop` was advertised whenever an MCP bridge was
 * configured, `probe` whenever a Probe was running, and `computer` for either —
 * so a model with a Probe up was offered BOTH `computer{op:"key"}` AND
 * `probe{op:"input.keyboard.tap"}`, and with a bridge configured both
 * `computer{op:"click"}` and `desktop{op:"mouse.click"}`. Three ways to press
 * one key is not three capabilities; it is one capability the model has to
 * guess its way through, and a guess that lands on the wrong spelling is a
 * keystroke that goes nowhere with no way to tell why.
 *
 * `computer` covers everything `desktop` did AND OCR — computer.js owns the
 * dialects — so this is pure subtraction. The bridge did not go away; it
 * stopped being a second vocabulary.
 *
 * A model on an ordinary coding task is still never told it can control the
 * machine: `computer` appears only when a transport is live. Every function
 * below reads THIS, so schemas and dispatch cannot drift apart — the property
 * the architecture guard checks.
 */
/** THE TOOLS A SESSION HAS: the fixed set in simple mode (tools/core.js), the legacy registry otherwise. */
function active(ctxApp) {
  const app = typeof ctxApp === 'function' ? ctxApp() : ctxApp;
  return require('../simple').on(app) ? simpleActive(app) : legacyActive(app);
}

/** SIMPLE (S2): the core set, plus Computer Control and the Preview when the person enabled them. */
function simpleActive(app) {
  const core = require('./core');
  const full = legacyActive(app);
  const out = {};
  for (const n of core.CORE) out[n] = core.tools[n] || full[n];
  for (const [n, t] of Object.entries(full)) if (n === 'computer' || /^computer_|^preview_/.test(n)) out[n] = t;
  return out;
}

function legacyActive(ctxApp) {
  const app = typeof ctxApp === 'function' ? ctxApp() : ctxApp;
  let mcpConfigured = false;
  try { mcpConfigured = require('../mcp').configured(require('../config').load()); } catch { mcpConfigured = false; }
  let out = TOOLS;
  // `computer` FOLLOWS THE TRANSPORT, because it is LAIN's operation and not
  // any bridge's: the model asks to click or to look, and LAIN decides which of
  // the connected bridges carries it. That is the whole ownership correction —
  // screen and input are how anyone uses a computer. (The Probe transport and
  // its `probe` tool were removed from LAIN CLI in 2026-09; the desktop bridge
  // remains the carrier.)
  // COMPUTER MCP WINS WHEN IT IS LIVE. It is the same one name, `computer`,
  // with the structured vocabulary — a model is never offered both it and the
  // coordinate-only one, because two ways to press a button is exactly the
  // duplication this file exists to prevent. See src/computermcp.js.
  const computerMcp = require('../computermcp').existing(app);
  // COMPUTER CONTROL IS OFF UNTIL THE PERSON TURNS IT ON for this session (computercontrol.js): no desktop tool exists
  // before that; OBSERVE gets the structured reads and one capture, INTERACT/FULL the mouse and keyboard too.
  const cu = require('../computercontrol');
  if (computerMcp && computerMcp.connected && cu.enabled(app)) out = { ...out, ...require('./computermcp').tools, ...(cu.tier(app) === 'OBSERVE' ? { computer_capture: require('./computerinput').tools.computer_capture } : require('./computerinput').tools) };
  else if (mcpConfigured && cu.enabled(app)) out = { ...out, ...require('./computer').tools };
  // LAIN FOR CHROME follows its own transport too, for the same reason: a
  // model on an ordinary coding task is never offered control of the user's
  // real browser. See src/lainchrome.js.
  const lainChrome = require('../lainchrome').existing(app);
  if (lainChrome && lainChrome.connected) out = { ...out, ...require('./chrometab').tools };
  // ---- LOOKING SOMETHING UP, and the two halves follow different rules ----
  //
  // `web_fetch` is a plain HTTP GET: no browser, no profile, no cookies. It
  // works headless, in CI and over SSH, so it is always offered — a question
  // whose answer is in a changelog should never have to be answered from a
  // training cut-off. See src/research.js for what leaves and who is told.
  // (LAIN's browser ownership — the `browser` tool and the Chromium-driving
  // `web_search` — was removed in 2026-09; the plain fetch survives.)
  out = { ...out, ...require('./web').fetchTools };
  // CONNECTED MCP SERVERS' TOOLS described natively — a small set or pinned servers, under the person's trust
  // (mcpreg.js); the rest are reached through search_capabilities + mcp_call.
  try { const mcpTools = require('../integrations').toolDefs(app); if (Object.keys(mcpTools).length) out = { ...out, ...mcpTools }; } catch { /* none */ }
  // SKILLS AND LAZY MCP (tools/capreg.js): search_capabilities / use_skill / mcp_call exist only once something is
  // installed — zero skills and zero MCP servers cost a request nothing.
  if (app) { try { const cap = require('./capreg').active(app); if (Object.keys(cap).length) out = { ...out, ...cap }; } catch { /* none */ } }
  if (app?.session?.cowork) out = { ...out, ...require('./cowork').tools };
  // ---- SPECIALIST MACHINERY IS NOT FLAGSHIP VOCABULARY (dispatch.js) -------
  //
  // CORE ASSIGNS; CAPABILITIES DO NOT VOLUNTEER. A tool that exists is not a
  // tool every request needs to be told about:
  //   - the migration tools only when Core found a real old → new transition
  //     in this input, or a migration contract is already in flight;
  //   - `hand_to_coding_agent` only on the IDE BOT's own turn, the one place it
  //     can do anything;
  //   - workers, Laya, GUG maintenance and background preprocessing never:
  //     Core runs them and the flagship receives compact, validated slices
  //     (harnesscontext.js packet, gug.js slice, geometryjob.js facts). The
  //     retired `geometry_specialist` tool (Violetto) is gone.
  const session = app && app.session;
  // THE PREVIEW TOOLS FOLLOW THE PREVIEW (2026-10-01): eleven schemas (~11 KB) were described on every request of every
  // CLI session, with nothing to click. Offered once a Preview has been attached in this session, then kept for it —
  // the tool list is part of the cached prefix and must not flicker as the window opens and closes.
  if (session && !session._previewTools) { try { if (require('../workshop/previewinput').attached(app)) session._previewTools = true; } catch { /* none */ } }
  if (!app || (session && session._previewTools) || process.env.LAIN_PREVIEW_TOOLS === '1') out = { ...out, ...require('./preview').tools };
  if (!require('../dispatch').offersMigration(session)) out = without(out, MIGRATION_TOOLS);
  if (!(session && session._botTurn)) out = without(out, BOT_TOOLS);
  return out;
}

const MIGRATION_TOOLS = ['migration_plan', 'migration_verify', 'migration_activate'];
const BOT_TOOLS = ['hand_to_coding_agent'];
function without(all, names) {
  if (!names.some((n) => Object.prototype.hasOwnProperty.call(all, n))) return all;
  const o = { ...all };
  for (const n of names) delete o[n];
  return o;
}

/** Why a registered tool is not part of this input's vocabulary, or '' when it simply does not exist. */
function notOffered(name) {
  if (MIGRATION_TOOLS.includes(name)) return 'it is offered only when Core identifies a real migration (a current representation, a target one and the boundary between them) or one is in flight. Plan this work with the ordinary tools.';
  if (BOT_TOOLS.includes(name)) return 'it exists only on the IDE BOT turn.';
  if (name === 'job_wait') return 'there is no waiting on a job inside a turn: a background job\'s result rejoins this session by itself when it ends (job_status reads it once). If you need the result now, run the command in the foreground (run_bash / run_tests).';
  if (/^preview_/.test(name)) return 'no LAIN Preview is attached to this session — open the project in the Preview (`lain preview`) first.';
  return '';
}

/**
 * Schemas sent to the model. Same source as dispatch, so they cannot drift.
 *
 * THE APP IS THE CONTEXT, and the transport-gated vocabulary (`computer`)
 * rides the session's connections, so every reader forwards the App it is
 * working for. A reader with none (a unit test, a cold start) gets the
 * connection-only vocabulary, which is the same answer it always gave.
 */
function schemas(app, { turn = false, session: turnSession = null } = {}) {
  const all = active(() => app);
  // SIMPLE: the fixed set; an agent never gets Agent, and an explore agent only reads.
  if (require('../simple').on(app)) {
    const sess = turnSession || (app && app.session) || null;
    let list = Object.keys(all);
    if (sess && sess._agentType) list = list.filter((n) => n !== 'Agent' && (sess._agentType !== 'explore' || require('./core').READ_ONLY.has(n)));
    return list.map((n) => all[n].schema);
  }
  // EVERY PROFILE GETS CORE + THE PACKS ITS TASK NEEDS (2026-10-02, toolfunnel.packsFor). Opened ONCE per classified
  // request (keyed by the change class's mark), so the list — part of the cached prefix — never moves between two
  // steps of one turn, and only grows across a session. A focus packet's own shape (explain / rename / geometry) wins.
  // THE TURN'S OWN SESSION: a subagent's turn runs on its parent's App and used to inherit the PARENT'S funnel —
  // every SCOUT was described all 63 tools. A child session with a role gets that role's pack instead.
  const sess = turnSession || (app && app.session) || null;
  if (turn && sess && sess._agentRole && sess !== (app && app.session)) {
    require('../toolfunnel').openForRole(sess, sess._agentRole, { only: sess._agentTools || null, extra: app && app.cfg && app.cfg.computer && app.cfg.computer.agents ? ['computer'] : [] });
  } else if (turn && app && app.session) {
    const s = app.session;
    const cc = s._changeClass || null;
    const thread = s.thread === 'chat' ? 'chat' : null;
    const key = cc ? `cls:${cc.at}` : `turn:${thread || 'coding'}:${(s.turns || []).length}`;
    const focus = s._toolFunnel && /^(explain|rename|geometry|symbol-edit)$/.test(String(s._toolFunnel.shape || ''));
    if (!focus) require('../toolfunnel').openForTurn(s, { cls: cc ? cc.class : null, thread, text: cc ? cc.text : '', key });
  }
  // A DECLARED READ-ONLY task is not offered the file writers at all (readonly.js):
  // a tool the model never sees is a write it can never attempt.
  const offered = require('../readonly').offered(Object.keys(all), sess);
  // THE TURN'S FUNNEL (toolfunnel.js): what this task is SHOWN. Exposure only —
  // `execute` below still reads the whole active set.
  return require('../toolfunnel').filter(sess, offered).map((n) => all[n].schema);
}

function has(name, app) { return Object.prototype.hasOwnProperty.call(active(() => app), name); }
function isMutating(name, app) { const t = active(() => app)[name]; return Boolean(t && t.mutates); }
function effect(name, app) { const t = active(() => app)[name]; return t && t.effect ? t.effect : null; }
function names(app) { return Object.keys(active(() => app)); }

/**
 * Execute one call. An unknown name is a normal, recoverable result — the model
 * gets told what does exist and picks again.
 */
async function execute(name, input, ctx, { canonical = false, deferred = false } = {}) {
  const app = (ctx && ctx.app) || null;
  // ---- A MODEL'S OWN TOOL DIALECT (discipline/dialect.js) ------------------------------------------------------
  // Claude's Read/Edit/Grep, Codex's shell/apply_patch, GLM's bash/str_replace: translated here and run as the
  // canonical tool through this same door, so every gate, permission and ledger below applies unchanged.
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
  const simpleMode = require('../simple').on(app);
  const tool = (deferred ? legacyActive(app) : active(() => app))[name] || (simpleMode && !deferred ? require('./core').deferred(app)[name] : undefined);
  if (!tool) {
    // A NAME THAT IS NOT OURS BUT WHOSE MEANING IS — a foreign namespace
    // ("functions/grep") or a known foreign tool ("print_tree"). Recovered
    // locally and said so; see toolalias.js for why nothing fuzzier is.
    const alias = require('../toolalias').resolve(name, input, (n) => has(n, app));
    if (alias) {
      const r = await execute(alias.name, alias.input, ctx);
      return { ...r, output: `${alias.note}\n${r.output}`, adaptedFrom: alias.from };
    }
    // THE CATALOGUE ONCE PER TURN. The same unknown name again in the same turn
    // gets the short answer: the list was already given and has not changed.
    const s = (ctx && ctx.session) || (app && app.session) || null;
    const offered = require('../readonly').offered(names(app), app && app.session);
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
  // A REGISTERED TOOL THE TURN'S FUNNEL DID NOT SHOW still runs — the funnel is
  // exposure, not permission — and is counted; its family is shown from now on.
  try { require('../toolfunnel').miss((ctx && ctx.session) || (app && app.session), name); } catch { /* metrics only */ }
  // THE DESKTOP IS THE PRIMARY AGENT'S (Phase CU): a subagent never drives it unless the person set cfg.computer.agents —
  // a permission, not exposure, so it holds even for a tool the funnel did not show.
  // AN AGENT'S TOOLS ARE ITS TYPE'S (agentrun.js): no agents from agents; an explore agent never writes or runs.
  { const s = (ctx && ctx.session) || null; if (s && s._agentType && (name === 'Agent' || (s._agentType === 'explore' && tool.mutates && name !== 'call_tool'))) return { output: `DENIED: ${name === 'Agent' ? 'an agent cannot start agents' : `an explore agent only reads — ${name} changes things`}.`, isError: true, denied: true }; }
  { const s = (ctx && ctx.session) || null; if (s && s._agentRole && require('../toolfunnel').familyOf(name) === 'computer' && !(app && app.cfg && app.cfg.computer && app.cfg.computer.agents)) return { output: `DENIED: ${name} drives the person's desktop, and subagents never do (only the primary agent).`, isError: true, denied: true }; }
  // ---- MAY THIS TOUCH THAT PATH? ------------------------------------------
  //
  // ONE GATE, HERE, because this is the one door every tool call goes through.
  // The alternative was a check at each `resolve()` — four in fs.js, more in
  // edit.js and search.js — which is six places to keep in step and one place
  // to forget. A tool added tomorrow is covered without its author knowing the
  // gate exists.
  //
  // It answers whether a directory is ours to work in and asks immediately
  // before an explicit EXTERNAL effect. Screen access remains permissions.js's
  // question and is asked elsewhere.
  // (The PROBE-environment tool gate that sat beside this one was removed with
  // the Probe integration in 2026-09 — there is no longer a second execution
  // environment to enforce a boundary for.)

  // ---- A BOUNDED WORKER READS ONLY ITS ASSIGNMENT, AND RUNS NO COMMANDS ------
  //
  // workorderguard.js. The main executor carries no bounded order and is not
  // affected. A shell command's targets cannot be known, so a bounded worker
  // may not run one unless its order says so.
  // ---- THE CHAT VIEW DISCUSSES; IT NEVER WRITES ------------------------------
  //
  // A Chat model proposing a patch does not gain the authority to apply it.
  // Structural, not a prompt instruction: a mutating tool from a Chat-view turn
  // is refused here, whatever model asked. See sessionviews.js.
  const chatView = ctx && ctx.app && ctx.app.session && ctx.app.session.thread === 'chat';
  if (chatView && tool.mutates) {
    return { output: `DENIED CHAT_VIEW_READ_ONLY: ${name} changes things, and the Chat view only reads and plans. Put it in the plan; the Coding view implements it.`, isError: true, denied: true };
  }
  // THE BOT IN THE IDE READS; THE CODING AGENT WRITES. The same structural
  // refusal, for the BOT's turn — and the way forward is named: hand the work
  // over, and the Coding Agent takes it (harnessapp/botroute.js).
  const botTurn = ctx && ctx.app && ctx.app.session && ctx.app.session._botTurn;
  if (botTurn && tool.mutates) {
    return { output: `DENIED BOT_READ_ONLY: ${name} changes things, and the BOT does not edit. Call hand_to_coding_agent with the task and the Coding Agent will do it.`, isError: true, denied: true };
  }
  // A PLUGIN COMMAND'S TURN CARRIES ITS GRANT (plugins.js): a tool outside the
  // permissions the person granted that plugin is refused here, whatever the
  // model asks.
  const pluginDenied = require('../plugins').denies(ctx && ctx.app && ctx.app.session, name, tool);
  if (pluginDenied) return { output: pluginDenied, isError: true, denied: true };
  // ---- A DECLARED READ-ONLY TASK: THE WRITE IS REFUSED, NOT THE TASK --------
  //
  // readonly.js. Structural, like the Chat view above: whatever model asked,
  // a change — a file write, a non-inspecting command, a recorded
  // architecture/wiring/vocabulary entry — is refused here, and the refusal
  // says what remains available so the investigation carries on.
  const roSession = (ctx && ctx.app && ctx.app.session) || (ctx && ctx.session) || null;
  const roDenied = require('../readonly').denies(name, input, roSession, Boolean(tool.mutates));
  if (roDenied) return { output: roDenied, isError: true, denied: true };
  // ---- EXECUTION DISCIPLINE, MECHANICALLY (discipline/) — contextual, only when it applies ------------------------
  const lifeNow = roSession && roSession.lifecycle;
  if (lifeNow && lifeNow.discipline) {
    // NO BLIND RETRIES: the same failing command with nothing changed since would observe the same thing again.
    const blind = require('../discipline/retry').check(lifeNow, name, input);
    if (blind) return { output: blind, isError: true, denied: true, blindRetry: true };
    // OUTCOME SATISFIED: every acceptance criterion is evidenced — further changes are beyond what was asked.
    // Removing or keeping the task's own scaffolding is still allowed.
    // A FILE CHANGE, not a command: a final check after the outcome is evidenced is still a legitimate observation.
    if (require('../mutation').isSourceMutation(name) && require('../discipline/arbiter').outcomeSatisfied(lifeNow)) {
      const cwd0 = (ctx && ctx.cwd) || roSession.cwd || process.cwd();
      const scaffold = new Set(lifeNow.discipline.contract.scaffolding.map((x) => x.path));
      const targets = require('../gate').pathsIn(input, cwd0).map((p) => require('path').relative(cwd0, p).replace(/\\/g, '/'));
      if (!targets.length || !targets.every((t) => scaffold.has(t))) {
        return { output: 'OUTCOME SATISFIED: every acceptance criterion of this task is evidenced by a current observation, so further changes are beyond what was asked. Report the result and call request_completion. If the person wants more, that is a new request.', isError: true, denied: true, outcomeSatisfied: true };
      }
    }
  }
  const order = ctx && ctx.workOrder;
  if (order && order.bounded && !require('../simple').on(app)) {   // legacy: bounded work orders
    const guard = require('../workorderguard');
    const p = input && (input.path || input.file);
    if (p && !tool.mutates) {
      const ok = guard.readAllowed(order, require('path').resolve((ctx && ctx.cwd) || process.cwd(), String(p)), ctx && ctx.cwd);
      if (!ok.ok) return { output: `DENIED ${ok.why}`, isError: true, denied: true };
    }
    if (tool.mutates && !require('../mutation').isSourceMutation(name) && order.allowCommands !== true) {
      return { output: `DENIED ${guard.VERDICT.OUTSIDE_WORK_ORDER}: work order ${order.id} does not allow ${name}`, isError: true, denied: true };
    }
  }

  // ---- THE SESSION'S EXECUTION MODE, AND WHO OWNS WHICH FILES --------------
  //
  // PLAN refuses anything that acts; MANUAL asks first (execmode.js). A write
  // into files a background job or subagent holds is refused (leases.js) —
  // the holder itself writes freely inside its own lease.
  const modeVerdict = await require('../execmode').gate(ctx, name, tool, input);
  if (!modeVerdict.ok) return { output: modeVerdict.output, isError: true, denied: true };
  const exec = await require('./download').executeGuard(ctx, name, input);
  if (exec && !exec.ok) return { output: exec.output, isError: true, denied: true };
  if (tool.mutates) {
    const cwd = (ctx && ctx.cwd) || process.cwd();
    const holder = (order && order.leaseHolder) || null;
    for (const p of require('../gate').pathsIn(input, cwd)) {
      const l = require('../leases').check(holder, p, cwd);
      if (!l.ok) return { output: `DENIED LEASED: ${l.why}. Work on independent files, or wait for it (/jobs).`, isError: true, denied: true };
    }
  }
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
  // ---- ONE LIFECYCLE FOR EVERY SOURCE WRITE ---------------------------------
  //
  // Authority, baseline, stale check, checkpoint, apply, structural verify,
  // refresh, verify, keep or revert, receipt — mutation.js. It runs the parse
  // and lint rungs below itself, so a transacted write returns from here.
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
  // ---- DID THE WRITE LEAVE THE FILE PARSEABLE? ----------------------------
  //
  // HERE FOR THE SAME REASON THE GATE IS: every tool that writes comes through
  // this door and reports what it touched in `mutated`, so one check covers
  // eight edit tools and whatever is added next. Per-tool checks would be eight
  // copies to keep in step and one to forget.
  //
  // The result is APPENDED, never converted into an error: the file really was
  // written, and calling the write a failure would be a false report the model
  // would then try to undo. What it changes is when the breakage is discovered
  // — at the edit, rather than by whatever expensive thing runs next.
  //
  // Silent unless the file genuinely does not parse. See diagnostics.js on why
  // saying nothing is the default.
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
    // ---- AND THE THIRD RUNG: THE PROJECT'S OWN LINTER, ON THIS FILE --------
    //
    // The two rungs above answer "does it parse" and "does every name resolve",
    // and the second is only built for JavaScript. So a Python file containing
    //
    //     pirnt("hello")
    //
    // passed both and reached the model as a clean write — the defect was then
    // discovered by RUNNING it, which costs a suite, a stack trace and a turn
    // spent working backwards to a typo `ruff` names in eight milliseconds.
    //
    // ONLY WHAT THE PROJECT ALREADY HAS, only ever the one file, and only fast
    // tools: `tsc` and `cargo check` are stronger and are deliberately not here,
    // because both are whole-project and would make editing a large repository
    // unusable. See filecheck.js for all three rules.
    //
    // NOT `syntaxError`. A lint finding is not a broken file, and the flag that
    // says "this write did not produce something loadable" must keep meaning
    // that or the surfaces reading it start over-reporting.
    try {
      const lint = await require('../filecheck').reportFor(r.mutated, ctx && ctx.cwd);
      if (lint) r = { ...r, output: String(r.output || '') + lint, diagnostics: true };
    } catch { /* same rule: a checker may never fail the edit it was checking */ }
  }
  return post(r);
}

module.exports = { TOOLS, active, legacyActive, schemas, execute, has, isMutating, effect, names };
