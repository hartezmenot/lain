'use strict';

/**
 * THE BOT, THEN THE CODING AGENT — how a sentence typed in the IDE is routed.
 *
 *     person ──▶ BOT (the BOT model, read-only)
 *                 ├─ a question, an explanation, a workspace request → answers
 *                 └─ work that changes code → hand_to_coding_agent
 *                                                  │
 *                    Coding Agent (the Coding model, full tools) ◀──┘
 *
 * ------------------------------------------------------------------------
 * TWO DOORS INTO THE SAME CONVERSATION.
 *
 *   FAST PATH   Core's own deterministic intent classifier (mode.js) reads the
 *               sentence. A clear implementation request ("rename this class
 *               and update callers") goes straight to the Coding Agent — paying
 *               a BOT round trip to learn what a dozen words already say would
 *               be the circular model call mode.js exists to avoid.
 *   BOT PATH    Everything read-only — questions, explanations, audits, "open
 *               the MCP settings" — runs on the BOT model with mutating tools
 *               refused. If the BOT concludes that code must change, it calls
 *               `hand_to_coding_agent` (tools/delegate… see handoff tool below)
 *               and the Coding Agent turn starts the moment the BOT's ends.
 *
 * Both turns are in the IDE's thread; the messages carry `by: 'bot' | 'agent'`
 * (and a user message `to: 'agent'`) so the window can put each in its own
 * sub-tab — BOT | AGENT — without narrating the routing.
 *
 * ------------------------------------------------------------------------
 * THE BOT ASKS BEFORE THE AGENT TAKES OVER (the session journey). In the IDE's BOT
 * tab, work that changes code is not silently turned into Coding Agent output:
 *
 *     "Rename fixButton to ButtonFix everywhere."
 *        → This requires code changes. Move to Agent?  [Move to Agent] [Stay with BOT]
 *
 * The FAST PATH above therefore PROPOSES (no model call at all) instead of
 * starting the Agent, and the BOT's own `hand_to_coding_agent` records a
 * proposal instead of chaining. The person's answer arrives on
 * POST /api/agent/proposal. The AGENT tab, a direct choice (`route: 'agent'`)
 * and Chat's agentic coding go straight to the Agent — there the person
 * already said who should do it.
 *
 * ------------------------------------------------------------------------
 * THE BOT'S MODEL IS THE CHAT SELECTION on LAIN's runtime. When the BOT is a
 * signed-in website (ChatGPT.com), that account cannot read a project, so the
 * BOT half runs read-only on the Coding model instead — and the route says so.
 */

const sv = require('../sessionviews');
const plans = require('../planhandoff');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }

/**
 * Which role takes this sentence: 'bot', 'agent' or 'propose', and why.
 *
 * NOT DECIDED HERE. Core's dispatch.route owns what the words mean (from
 * mode.js's verdict); this passes the FACTS the window knows — which surface,
 * which sub-tab, the person's chosen route — and maps Core's answer onto the
 * IDE's roles. The Harness renders the proposal; Core owns why it exists.
 */
function decide(app, text, body = {}) {
  const surface = body.via === 'chat' || body.from === 'chat' ? 'chat' : 'ide';
  const r = require('../dispatch').route(app, text, {
    surface,
    pane: body.pane === 'agent' || body.pane === 'bot' ? body.pane : null,
    preferred: body.route === 'agent' || body.route === 'bot' ? body.route : null,
  });
  return { role: r.executor === 'conversation' ? 'bot' : r.executor, reason: r.reason };
}

/** Does the BOT run on its own model here, or fall back to the Coding model? */
function botOnRuntime(app) {
  try { return require('../modelsource/registry').selectedId(app) === 'lain'; } catch { return true; }
}

/** Stamp the assistant messages a turn added with the role that wrote them. */
function stamp(s, from, by, via) {
  const msgs = Array.isArray(s.messages) ? s.messages : [];
  for (let i = from; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.role !== 'assistant') continue;
    if (!m.by) m.by = by;
    if (via && !m.via) m.via = via;
  }
}

/**
 * THE MESSAGE THAT STARTED A TURN, marked for the tab it belongs to: `to`
 * ('bot' | 'agent') and `via` (the surface it came from). The task the BOT
 * handed over is not the person speaking, so that one is also `by: 'handoff'`
 * and the window shows "BOT → Coding Agent", not "You". The message is written
 * once the turn begins, so this looks for it briefly.
 */
function stampUser(s, from, text, fields) {
  let tries = 0;
  const look = () => {
    const msgs = Array.isArray(s.messages) ? s.messages : [];
    for (let i = from; i < msgs.length; i++) {
      if (msgs[i] && msgs[i].role === 'user' && String(msgs[i].content || '').startsWith(text.slice(0, 40))) { Object.assign(msgs[i], fields); return; }
    }
    if (++tries < 40) setTimeout(look, 50);
  };
  look();
}

/**
 * RUN ONE ROLE'S TURN in the IDE thread; chain the Coding Agent when the BOT
 * handed work over. Not awaited — the reply arrives through /api/state.
 */
function start(app, text, route) {
  const s = app.session;
  const journey = require('../journey');
  if (route.role === 'propose') {
    // NOTHING RUNS: the person is asked first (see the header).
    const p = journey.propose(app, { text, origin: 'fast', via: route.via || 'ide', reason: route.reason });
    return ok({ accepted: true, view: 'coding', route: 'propose', reason: route.reason, proposal: { id: p.id } });
  }
  const via = route.via || 'ide';
  sv.settle(s, 'coding');
  sv.views(s).active = 'coding';
  s.thread = 'coding';
  s._ideTurn = true;
  const bot = route.role === 'bot';
  s._botTurn = bot;
  s._botOwnModel = bot ? botOnRuntime(app) : false;
  // A BOT QUESTION IS AN ASIDE to whatever task the Agent carries: it does not
  // replace that task (identify.js). An Agent turn is re-seated on the task it
  // was carrying and marks the task agentic (journey.js).
  s._asideTurn = bot;
  if (!bot) { journey.reseat(app); if (route.transferId) require('../planhandoff').settleTransfer(app, route.transferId, 'SUBMITTED'); }
  // A PLUGIN COMMAND'S GRANT lives exactly as long as its turn (plugins.js;
  // enforced in tools/index.js).
  s._pluginGrant = route.grant || null;
  if (!bot) plans.noteSubmitted(s);
  // THE EXECUTION CLASS (changeclass.js) of an Agent turn: DIRECT and NARROW are told to stay small.
  if (!bot) require('../changeclass').begin(app, text, { via });
  const msgsBefore = (s.messages || []).length;
  // THE ROLE IS KNOWN WHILE THE TURN RUNS — a Coding Agent turn can work for
  // minutes after its first reply, and the window labels each reply as it
  // arrives (state.js reads these two fields), not only when the turn ends.
  s._role = bot ? 'bot' : 'agent';
  s._roleFrom = msgsBefore;
  s._roleVia = via;
  // identify.js marks the task it settles on as the Agent's (journey.agentStarted)
  // — there, and only there, is the task in hand certainly this turn's.
  s._agentVia = bot ? null : { via, reason: route.reason };
  // THE FOCUSED CONTEXT PACKET (focuspacket.js): the symbol's neighbourhood,
  // the person's recent hand-edits and the constraints, built once from the
  // deterministic owners before the Agent starts. `focus: false` (the AGENT
  // gear's Context: Standard) leaves it out.
  // The research (language server, UI graph, git) runs in parallel BEFORE the
  // model, and also decides what the turn is shown (toolfunnel.js).
  const focusing = route.focus !== false;
  const run = async () => {
    if (focusing) { try { await require('../focuspacket').prepare(app, text, { useSelection: via === 'ide', role: bot ? 'bot' : 'agent' }); } catch { /* the turn runs without it */ } }
    return app.handle(text, { from: 'harness-app', forceMode: bot ? 'EXPLAIN' : null });
  };
  stampUser(s, msgsBefore, text, route.handed ? { by: 'handoff', to: 'agent', via } : { to: bot ? 'bot' : 'agent', via });
  Promise.resolve(require('./sessionroutes').withPort(app, run))
    .catch(() => {})
    .finally(() => {
      stamp(s, msgsBefore, bot ? 'bot' : 'agent', via);
      try { require('../focuspacket').afterTurn(app); } catch { /* measurement only */ }
      s._role = null;
      s._roleVia = null;
      s._asideTurn = false;
      if (bot) journey.note(s, journey.EVENT.BOT, { via });
      else journey.agentEnded(app);
      s._agentVia = null;
      s._focusPacket = null;
      s._pluginGrant = null;
      sv.settle(s, 'coding');
      s._botTurn = false;
      s._botOwnModel = false;
      if (!bot) plans.afterCoding(s);
      if (!bot) { try { require('../changeclass').end(app); } catch { /* the result list is a courtesy */ } }
      // (A BOT that concluded code must change recorded a transfer through
      // hand_to_coding_agent — the person is asked; accepting runs it below.)
      if (s.thread === 'coding') s.thread = null;
      s._ideTurn = false;
      try { s.save(); } catch { /* the state still holds for this run */ }
      require('../sessionstatus').touch(app, { ended: true });
    });
  return ok({ accepted: true, view: 'coding', route: route.role, reason: route.reason, botModel: bot ? (s._botOwnModel ? 'bot' : 'coding-fallback') : null });
}

/**
 * THE PERSON ANSWERED "MOVE TO AGENT?". Accept runs the Agent on the same
 * session and task — the BOT's written task when the BOT proposed it, the
 * person's own words when the fast path did. Stay with BOT runs the BOT on the
 * person's words (fast path) or simply lets the proposal go (BOT path).
 */
function answer(app, { id, accept } = {}) {
  const journey = require('../journey');
  const s = app.session;
  const running = Boolean(app.abort && !app.abort.signal.aborted);
  const waiting = journey.proposal(app);
  if (!waiting || waiting.id !== String(id || '')) return { code: 409, body: { ok: false, why: 'that proposal is no longer waiting — ask again' } };
  if (running) return { code: 409, body: { ok: false, why: 'LAIN is still working — wait for it or stop it first', busy: true } };
  const p = journey.takeProposal(app, id, Boolean(accept));
  if (accept) {
    journey.note(s, journey.EVENT.MOVED, { origin: p.origin });
    const task = p.task ? `${p.task}${p.context ? `\n\n${p.context}` : ''}` : p.text;
    return start(app, task, { role: 'agent', reason: 'moved to the Agent', via: p.via, handed: Boolean(p.task), transferId: p.id });
  }
  journey.note(s, journey.EVENT.STAYED, { origin: p.origin });
  if (p.origin === 'fast') return start(app, p.text, { role: 'bot', reason: 'kept with the BOT', via: p.via });
  return ok({ accepted: true, stayed: true });
}

module.exports = { decide, start, stamp, answer };
