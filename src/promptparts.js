'use strict';

/**
 * THE REQUEST HAS A STABLE HALF AND A CHANGING HALF, AND THEY MUST NOT BE
 * ADJACENT IN THE WRONG ORDER.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR, measured before it was written.
 *
 * `app.systemPrompt()` returns one string, and that string becomes
 * `messages[0]`. Inside it, in this order:
 *
 *     BASE instructions           identical for the life of the install
 *     working directory, OS       identical for the life of the session
 *     mode guidance               CHANGES EVERY TURN
 *     working context / handover  CHANGES EVERY TURN
 *     project brief               identical for the life of the session
 *     plan digest                 CHANGES AS STEPS COMPLETE
 *
 * A prefix cache keeps the longest identical HEAD of a request. Volatile text
 * sitting at position 4 of `messages[0]` means everything after it — including
 * the entire conversation, which may be fifty thousand tokens of transcript
 * that did not change at all — is behind a byte that did. Every turn boundary
 * re-prices the whole request.
 *
 * MEASURED on a five-turn, eight-step workload: moving the changing half to the
 * TAIL of the wire left total input identical (0.0% — it is the same
 * information, in the same words) and cut BILLED, uncached input by 11.2%,
 * lifting the cache hit rate from 59.2% to 63.8%. The real workload that
 * prompted this had 815 requests and far more turn boundaries than five, so the
 * saving there is larger; this file does not claim a number it did not measure.
 *
 * ------------------------------------------------------------------------
 * NOTHING IS REMOVED, SHORTENED, OR SUMMARISED. The model receives every word
 * it received before. This is an ORDERING change and only an ordering change,
 * which is why it is safe: there is no judgement here about what the model
 * needs, and therefore no way for it to be wrong about that.
 *
 * ------------------------------------------------------------------------
 * WHY A PLAIN FUNCTION OVER `app` rather than a method. app.js is at 697 lines
 * against a 700-line guard, and this is the same shape runtimefacts.js and
 * turnauthority.js already use for the same reason: no `this`, testable without
 * an App, and impossible to grow into a second orchestration layer.
 */

const prompt = require('./prompt');
const providerMod = require('./provider');

/**
 * THE TWO HALVES OF THE SYSTEM PROMPT.
 *
 * @returns {{stable:string, live:string}}
 *   `stable` becomes `messages[0]` and must be byte-identical between requests
 *   for as long as the session's model and directory are unchanged.
 *   `live` rides at the tail of the wire, after the conversation, where a
 *   change costs only itself.
 */
/**
 * THE DURABLE SECTIONS EVERY REQUEST CARRIES — one assembly for both paths.
 *
 * MEASURED DEFECT: the goal, the Cowork context and a worker's assignment were
 * added only to `appprompt.build`, which no live turn calls. Every real turn
 * (app.js, and `/bg` through jobrunner.js) is built here, so `/goal` never
 * reached the model and a background worker never saw its own order. Both
 * builders now take these sections from this one function.
 *
 * @returns {{agents, cowork, goal, assignment}} each '' when absent
 */
function durable(app, session) {
  const s = session || app.session;
  const out = { agents: '', cowork: '', goal: '', assignment: '' };
  try { out.agents = require('./agentsmd').forPrompt(s.cwd); } catch { out.agents = ''; }
  // ENABLED SKILLS (integrations.js): name, description and where SKILL.md is — read on demand.
  try { const sk = require('./integrations').skillsPrompt(app); if (sk) out.agents = out.agents ? `${out.agents}\n\n${sk}` : sk; } catch { /* none */ }
  try { out.cowork = require('./cowork/prompt').forSession(s) || ''; } catch { out.cowork = ''; }
  try { const g = require('./goal').forPrompt(s); out.goal = g ? `# Goal\n${g}` : ''; } catch { out.goal = ''; }
  if (s.workOrder) {
    try {
      const authority = require('./authority');
      // THE GOAL AND THE PLAN are stated under their own headings and the task
      // by the working context; the assignment is the part nothing else says.
      const brief = authority.brief(authority.project(s, { workOrder: s.workOrder }), { omit: ['goal', 'task', 'plan'] });
      out.assignment = brief ? `# Your assignment\n${brief}` : '';
    } catch { out.assignment = ''; }
  }
  return out;
}

function of(app, { opened = false, session = null } = {}) {
  // THE SESSION BEING RUN, which for `/bg` is the fork and not app.session.
  const s = session || app.session;
  const pc = providerMod.resolve({ ...app.cfg, _evidence: app.connectionEvidence });
  const built = prompt.build({
    opened,
    cwd: s.cwd,
    platform: process.platform,
    model: pc.model,
    mode: s.mode,
    session: s,
    checkpoints: app.checkpoints,
    jobs: app._supervisedJobs || [],
    providers: app._supervisedProviders || [],
    runtime: app._handover || null,
    // THE SPLIT ITSELF happens in prompt.build, because that is where the
    // sections are assembled and the only place that knows which is which.
    separate: true,
    // READ-ONLY, for the clarification budget alone (§15) — see prompt.js
    // `build`'s doc comment on why this is the one field sourced from the
    // App rather than the session.
    app,
  });

  // ---- THE STABLE HALF ---------------------------------------------------
  //
  // The project brief joins it: built once per session and cached on the app,
  // so it is exactly as stable as the base instructions and belongs in front of
  // the conversation rather than behind the volatile block, where it used to
  // sit and where it was re-priced on every turn for no reason.
  if (app._projectBrief === undefined) {
    try { app._projectBrief = require('./project').brief(app.session.cwd); } catch { app._projectBrief = ''; }
    // THE GENERATION THIS BRIEF DESCRIBES. It is never regenerated mid-session
    // (that would re-price every cached byte after it); what changes later rides
    // the tail as PROJECT_DELTA base → now (harnesscontext.js).
    try { require('./projectgen').pinBase(app.session.cwd); } catch { /* context only */ }
  }
  let stable = built.stable;
  if (app._projectBrief) stable += `\n\n# This project\n${app._projectBrief}`;
  // DURABLE PER SESSION, so they belong in the cached prefix: AGENTS.md, the
  // Cowork context, the standing goal and a worker's assignment. The goal reads
  // before the plan, which rides in the live tail below.
  const d = durable(app, s);
  for (const part of [d.agents, d.cowork, d.goal, d.assignment]) if (part) stable += `\n\n${part}`;
  // WHICH VIEW, AND THE PLAN THE PERSON ACCEPTED. Durable per thread, so it sits
  // in the stable half: the Chat view is told it plans and never writes; the
  // Coding view carries the accepted plan in full. See planhandoff.js.
  const view = require('./planhandoff').promptSection(s);
  if (view) stable += `\n\n${view}`;

  // ---- THE CHANGING HALF -------------------------------------------------
  let live = built.live;
  // WHAT GIT SAYS ABOUT THE TREE, per turn. The gap this closes: gitsense
  // existed but nothing fed it to the model, so working-tree state was a
  // run_bash the model had to spend. It is measured in the background at
  // submit time (gitsnapshot.js prefetch — which is where the ledger's
  // expected-paths list goes, because gitsense owns the one normalization
  // rule that compares it to git names) and rendered here, in the volatile
  // half — NEVER the stable prefix, because tree state is the definition of
  // volatile. Silent for a clean tree, a tree with no .git, or a turn that
  // started before the measurement landed.
  const git = require('./gitsnapshot').say(app._gitSnapshot);
  if (git) live += `${live ? '\n\n' : ''}# Working tree (git)\n${git}`;
  // ONLY THIS SESSION'S PLAN can ever reach the prompt: it is a field on this
  // session object, so there is no other plan it could pick up. It advances as
  // steps complete, which is precisely why it is here and not above.
  // THE SESSION IS PASSED, AND WITHOUT IT HALF THE RECORD NEVER ARRIVES.
  // `digest({ session })` is what runs planfindings.derive — the step's LANDED
  // list read out of Core's own mutation receipts rather than out of whatever
  // the model remembered to write down. Called bare, as this was, the derived
  // half was built and never reached the prompt: a turn that had just patched
  // three files came back across a context boundary with no record of it.
  if (s.plan) live += `\n\n# Plan (this session)\n${s.plan.digest(700, { session: s })}`;
  // FILES THE PERSON PINNED — read now, bounded. Browsing a file in Project
  // Files puts nothing here; pinning is the explicit act. See sessionviews.js.
  const pinned = require('./sessionviews').pinnedContext(s);
  if (pinned) live += `\n\n${pinned}`;
  // WHAT THE IDE HAS IN FRONT OF THE PERSON — file, cursor, selection, tabs,
  // problems — and the project's terminal output, for turns typed in the IDE
  // only. Volatile by construction. See idecontext.js.
  const ide = require('./idecontext').section(app, s);
  if (ide) live += `\n\n${ide}`;
  // THE FOCUSED CONTEXT PACKET, for the Coding Agent's turn only: the
  // neighbourhood of the change, built once when the turn began. focuspacket.js.
  const focus = require('./focuspacket').section(s);
  if (focus) live += `\n\n${focus}`;
  // HOW MUCH MACHINERY THIS CHANGE GETS (changeclass.js): a DIRECT or NARROW change is told to stay small.
  const cls = require('./changeclass').section(s);
  if (cls) live += `\n\n${cls}`;
  // THE CODING AGENT, AS CHAT SEES IT (supervision.js): compact Core state — phase, landed, findings,
  // pending steers — for the CHAT thread only. Never the Agent's transcript.
  if (require('./sessionviews').current(s) === 'chat') { const sup = require('./supervision').chatContext({ ...app, session: s }); if (sup) live += `\n\n${sup}`; }
  // THE HARNESS CONTEXT PACKET (Core's): surface, the resolved selection, a
  // bounded GUG slice, PROJECT_DELTA and recent user actions — canonical, and
  // NOT in this tail: a new packet is recorded once at the turn's start and
  // spliced into history before the turn's request (harnesscontext.anchorPacket,
  // contextfit.buildWire), so later requests find it cached instead of paying
  // for it again. A Laya line appears only after Core validated it.
  if (!opened) require('./harnesscontext').anchorPacket(app, s);
  // (The probe decoration that rode here — volatile by construction, since it
  // depended on `from` and the live environment — was removed with the Probe
  // integration in 2026-09. The tail above is the whole volatile half.)

  return { stable, live: live.trim() };
}

module.exports = { of, durable };
