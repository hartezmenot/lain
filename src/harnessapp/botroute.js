'use strict';

/** THE IDE PANE'S CHAT | AGENT TOGGLE — which role a message typed in the IDE goes to, and running it. */

const sv = require('../sessionviews');
const plans = require('../planhandoff');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }

/** WHICH ROLE TAKES THIS MESSAGE: the pane's Chat | Agent toggle (S12) — never the words. The message names its pane; else the project's remembered toggle (default Agent). */
function decide(app, text, body = {}) {
  const journey = require('../journey');
  const asked = body.pane === 'agent' || body.pane === 'bot' ? body.pane : body.route === 'agent' || body.route === 'bot' ? body.route : null;
  if (asked) journey.setIdePane(app, asked);
  const role = asked || journey.idePane(app);
  return { role, reason: role === 'agent' ? 'the Agent toggle' : 'the Chat toggle' };
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

/** THE MESSAGE THAT STARTED A TURN, marked for the tab it belongs to: `to` ('bot' | 'agent') and `via` (the surface it came from). */
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

/** RUN ONE ROLE'S TURN in the IDE thread; chain the Coding Agent when the BOT handed work over. */
function start(app, text, route) {
  const s = app.session;
  const journey = require('../journey');
  const via = route.via || 'ide';
  sv.settle(s, 'coding');
  sv.views(s).active = 'coding';
  s.thread = 'coding';
  s._ideTurn = true;
  const bot = route.role === 'bot';
  s._botTurn = bot;
  s._botOwnModel = bot ? botOnRuntime(app) : false;
  // A BOT QUESTION IS AN ASIDE to whatever task the Agent carries: it does not replace that task (identify.js).
  s._asideTurn = bot;
  if (!bot) { journey.reseat(app); if (route.transferId) require('../planhandoff').settleTransfer(app, route.transferId, 'SUBMITTED'); }
  // A PLUGIN COMMAND'S GRANT lives exactly as long as its turn (plugins.js;
  // enforced in tools/index.js).
  s._pluginGrant = route.grant || null;
  if (!bot) plans.noteSubmitted(s);
  // THE EXECUTION CLASS (changeclass.js) of an Agent turn: DIRECT and NARROW are told to stay small.
  if (!bot) require('../changeclass').begin(app, text, { via });
  const msgsBefore = (s.messages || []).length;
  // THE ROLE IS KNOWN WHILE THE TURN RUNS — a Coding Agent turn can work for minutes after its first reply, and the window labels each reply as it…
  s._role = bot ? 'bot' : 'agent';
  s._roleFrom = msgsBefore;
  s._roleVia = via;
  // identify.js marks the task it settles on as the Agent's (journey.agentStarted)
  // — there, and only there, is the task in hand certainly this turn's.
  s._agentVia = bot ? null : { via, reason: route.reason };
  // THE FOCUSED CONTEXT PACKET (focuspacket.js): the symbol's neighbourhood, the person's recent hand-edits and the constraints, built once from the…
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

module.exports = { decide, start, stamp };
