'use strict';

/**
 * THE ENGINEERING SESSION'S CONTRACT ROUTES — views, plan handoff, models,
 * workspace panel, project attachment and pins.
 *
 * Every route here delegates: sessionviews.js owns views, threads, panel, pins
 * and attachment; planhandoff.js owns plan states and the handoff;
 * modelinventory.js owns search and per-view selection. This file adds an
 * envelope and the one sequencing rule a turn from a view needs (`submit`).
 */

const sv = require('../sessionviews');
const plans = require('../planhandoff');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400, extra = {}) { return { code, body: { ok: false, why: String(why || 'refused'), ...extra } }; }

function save(app) { try { app.session.save(); } catch { /* the state still holds for this run */ } }

/**
 * A TURN FROM A VIEW.
 *
 *   · into a session already working IN THE SAME VIEW, it is a steer — the
 *     long-standing contract (routes.js `POST /api/turn`);
 *   · into a session working in the OTHER view it is refused with `busy`,
 *     because a Chat sentence steering a Coding turn would put discussion into
 *     implementation. One writer per session is unchanged;
 *   · Coding needs an attached project — a Coding turn in LAIN's own folder or
 *     the empty placeholder is refused with `projectRequired`;
 *   · Chat runs read-only (EXPLAIN on LAIN's runtime; mutating tools are refused
 *     in tools/index.js) and, when it ends, a plan in its reply becomes a DRAFT.
 *
 * NOT AWAITED: the reply arrives through /api/state and `session.status`.
 */
function submit(app, body = {}) {
  const text = String(body.text || '').trim();
  if (!text) return bad('nothing was asked');
  const view = body.view === 'chat' ? 'chat' : 'coding';
  const s = app.session;
  if (s.cowork) return bad('Chat and Coding views belong to engineering sessions; this is a Cowork session', 409);
  const running = Boolean(app.abort && !app.abort.signal.aborted);
  if (running) {
    const busy = sv.current(s);
    // CHAT WHILE THE CODING AGENT WORKS: supervised, never raced (supervision.js). A status
    // question is answered from Core; "stop doing X" is put to the person as Steer now /
    // Wait; anything else becomes a pending steer for the next checkpoint. No model call.
    if (busy === 'coding' && view === 'chat') {
      const r = require('../supervision').chatWhileRunning(app, text);
      save(app);
      return ok({ accepted: true, supervised: r, view });
    }
    if (busy !== view) {
      return bad(`the ${busy === 'chat' ? 'Chat' : 'Coding'} view is working in this session — wait for it or stop it first`, 409, { busy });
    }
    app.queueSteer(text, body.now ? 'NOW' : 'WAIT');
    return ok({ accepted: true, steered: true, when: body.now ? 'NOW' : 'WAIT', view });
  }
  if (view === 'coding') {
    const p = sv.project(s);
    if (!p.attached) return bad('Coding requires a project folder. Add an existing project or create a project to continue.', 409, { projectRequired: true });
    if (p.missing) return bad(`this session's project is no longer at ${s.cwd}`, 409, { projectMissing: true });
    // A BROAD REQUEST is offered planning first — LAIN's workflow decision, no model call.
    // `direct: true` is the person's answer "Implement directly" (or a plan already approved).
    // A PHASED change (changeclass.js: a migration, a new architecture) gets the same offer.
    const cc = require('../changeclass').classify(String(body.classText || text), { selection: require('../changeclass').selectionOf(app), fromPreview: Boolean(body.fromPreview) });
    if (!body.direct && body.from !== 'ide' && (require('../supervision').isBroad(text) || cc.class === 'PHASED')) {
      const o = require('../supervision').planFirstOffer(s, text);
      save(app);
      return ok({ accepted: false, offer: o, view });
    }
    // THE IDE'S BOT DECIDES WHO ANSWERS: itself, or the Coding Agent. A caller
    // that names neither (the terminal, an older window) keeps the old
    // behaviour — the whole turn on the Coding model. See botroute.js.
    if (body.from === 'ide') {
      // WHAT THE PERSON TOOK OUT of the BOT's view for this turn — a context
      // chip they removed. idecontext.js leaves those parts out of the prompt.
      const cx = body.context && typeof body.context === 'object' ? body.context : {};
      s._ideExclude = { file: cx.file === false, selection: cx.selection === false, problems: cx.problems === false, terminal: cx.terminal === false };
      const br = require('./botroute');
      const route = br.decide(app, text, body);
      if (body.focus === false) route.focus = false;
      return br.start(app, text, route);
    }
  }
  // CHAT PLANS; THE CODING AGENT IMPLEMENTS (Phase 8). Chat stays read-only and
  // does NOT hand work to the Agent on its own any more: a plan made in Chat is
  // sent with "Send to Coding Agent" (POST /api/plan/send), and the person talks
  // to the Agent directly in its lane. A caller may still ask for the old
  // routing explicitly (`agent: true`) — the CLI-era journey behaviour.
  if (view === 'chat' && body.agent === true) {
    const p = sv.project(s);
    const br = require('./botroute');
    const route = p.attached && !p.missing ? br.decide(app, text, { ...body, from: 'chat', via: 'chat', route: body.route === 'agent' ? 'agent' : undefined }) : null;
    if (route && route.role === 'agent') return br.start(app, text, { ...route, via: 'chat' });
  }
  sv.settle(s, 'coding');              // anything untagged so far is engineering history
  sv.views(s).active = view;
  s.thread = view;
  // A CHAT QUESTION IS AN ASIDE to a task the Agent carries (identify.js).
  s._asideTurn = view === 'chat';
  if (view === 'coding') plans.noteSubmitted(s);
  // THE EXECUTION CLASS of a Coding turn (changeclass.js) rides this turn only: DIRECT and NARROW are told to stay small.
  if (view === 'coding') require('../changeclass').begin(app, String(body.classText || text), { fromPreview: Boolean(body.fromPreview), via: body.from || 'harness' });
  const turnsBefore = (s.turns || []).length;
  const run = () => app.handle(text, { from: 'harness-app', forceMode: view === 'chat' ? 'EXPLAIN' : null, sameTask: Boolean(body.sameTask) });
  Promise.resolve(require('./sessionroutes').withPort(app, run))
    .catch(() => {})
    .finally(() => {
      sv.settle(s, view);
      if (view === 'chat') {
        const rec = (s.turns || []).length > turnsBefore ? s.turns[s.turns.length - 1] : null;
        if (rec && rec.text) {
          const sel = require('../modelinventory').chatSelection(app);
          plans.capture(s, { reply: rec.text, asked: text, origin: { view: 'chat', source: sel.source, model: sel.modelId } });
        }
      } else {
        plans.afterCoding(s);
        try { require('../changeclass').end(app); } catch { /* the result list is a courtesy */ }
      }
      if (s.thread === view) s.thread = null;
      s._asideTurn = false;
      save(app);
      require('../sessionstatus').touch(app, { ended: true });
    });
  return ok({ accepted: true, view });
}

const ROUTES = {
  /**
   * EDIT & RESEND / RETRY THE LATEST MESSAGE (turnedit.js): the old wording and its replies become a kept branch, the
   * new wording is an ordinary turn. In the Coding lane, files the replaced turns changed need a choice first
   * (`files: 'undo' | 'keep'`) — the answer without it is `needsChoice`, and nothing has moved.
   */
  'POST /api/turn/edit': async (app, body = {}) => {
    const view = body.view === 'coding' ? 'coding' : 'chat';
    const text = String(body.text == null ? '' : body.text).trim();
    if (!text) return bad('the edited message is empty');
    const r = require('../turnedit').branch(app, { view, files: body.files === 'undo' || body.files === 'keep' ? body.files : null });
    if (!r.ok) return r.needsChoice ? ok({ needsChoice: true, files: r.files, why: r.why }) : bad(r.why, 409);
    const sent = submit(app, { view, text });
    return { code: sent.code, body: { ...(sent.body || {}), edited: true, replaced: r.replaced, undone: r.undone, kept: r.kept } };
  },
  'POST /api/turn/retry': async (app, body = {}) => {
    const view = body.view === 'coding' ? 'coding' : 'chat';
    const p = require('../turnedit').plan(app, view);
    if (!p.ok) return bad(p.why, 404);
    const r = require('../turnedit').branch(app, { view, files: body.files === 'undo' || body.files === 'keep' ? body.files : null });
    if (!r.ok) return r.needsChoice ? ok({ needsChoice: true, files: r.files, why: r.why }) : bad(r.why, 409);
    const sent = submit(app, { view, text: p.text });
    return { code: sent.code, body: { ...(sent.body || {}), retried: true, undone: r.undone, kept: r.kept } };
  },
  /** Which view the session is shown in. Navigation only — nothing runs. */
  'POST /api/view/select': async (app, body = {}) => {
    if (app.session.cowork) return bad('a Cowork session has no Chat/Coding views', 409);
    const view = body.view === 'chat' ? 'chat' : body.view === 'coding' ? 'coding' : null;
    if (!view) return bad('view must be "chat" or "coding"');
    sv.views(app.session).active = view;
    save(app);
    return ok({ view });
  },

  // ------------------------------------------------------------- models --

  'POST /api/models/search': async (app, body = {}) => ok(await require('../modelinventory').search(app, {
    lane: body.lane, query: body.query || '', limit: body.limit,
  })),

  'POST /api/models/select': async (app, body = {}) => {
    const r = await require('../modelinventory').select(app, {
      lane: body.lane, source: body.source || 'lain', modelId: body.model || body.modelId || '', connectionId: body.connectionId || null,
    });
    if (!r.ok) return bad(r.why);
    save(app);
    return ok({ lane: body.lane, selected: r.selected });
  },

  // --------------------------------------------------------------- plans --

  'POST /api/plan/draft': async (app, body = {}) => {
    const r = plans.draft(app.session, { text: body.text, title: body.title || null, origin: { view: 'chat', source: 'person' } });
    if (!r.ok) return bad(r.why);
    save(app);
    return ok({ plan: r.plan, plans: plans.project(app.session) });
  },
  'POST /api/plan/edit': async (app, body = {}) => {
    const r = plans.edit(app.session, body.id, body.text);
    if (!r.ok) return bad(r.why);
    save(app);
    return ok({ plan: r.plan, plans: plans.project(app.session) });
  },
  /** "Not yet": the draft stays a DRAFT and the prompt stops asking. */
  'POST /api/plan/defer': async (app, body = {}) => {
    const p = plans.find(app.session, body.id);
    if (!p || p.state !== plans.STATE.DRAFT) return bad('only a DRAFT can be deferred', 409);
    p.deferredAt = Date.now();
    save(app);
    return ok({ plans: plans.project(app.session) });
  },
  /** "Yes — Continue to Coding": accept, freeze, prefill. Executes nothing. */
  'POST /api/plan/accept': async (app, body = {}) => {
    const r = plans.accept(app, body.id);
    if (!r.ok) return bad(r.why, 409);
    save(app);
    return ok({ plan: r.plan, handoff: r.handoff, view: 'coding', composer: { view: 'coding', text: r.handoff.prompt } });
  },
  'POST /api/plan/complete': async (app, body = {}) => {
    const r = plans.complete(app.session, body.id);
    if (!r.ok) return bad(r.why, 409);
    save(app);
    return ok({ plan: r.plan });
  },
  /** The person decided not to send the prefilled instruction. The plan stays ACCEPTED. */
  'POST /api/handoff/discard': async (app) => {
    const h = plans.handoff(app.session);
    if (!h || h.state !== plans.HANDOFF.PREFILLED) return bad('there is no prefilled handoff', 409);
    h.state = 'DISCARDED';
    save(app);
    return ok({ handoff: h });
  },

  // ----------------------------------------------------------- workspace --

  // OPENING PROJECT FILES WITH NO PROJECT IS ALLOWED — the panel is where "Add
  // project" lives, and `state.workspace.project.attached` says which to show.
  'POST /api/workspace/panel': async (app, body = {}) => {
    const r = sv.panel(app.session, { action: body.action || 'toggle', panel: body.panel, width: body.width, file: body.file });
    if (!r.ok) return bad(r.why);
    save(app);
    return ok({ panel: r.panel });
  },

  // ------------------------------------------------------------- project --

  'POST /api/project/state': async (app) => ok({ project: projectState(app) }),

  'POST /api/project/attach': async (app, body = {}) => {
    const s = app.session;
    if (s.cowork) return bad('a Cowork session has no project', 409);
    const chk = sv.checkRoot(body.path);
    if (!chk.ok) return bad(chk.why);
    const current = sv.project(s);
    // MOVE TO PROJECT is allowed while the session has made no code change there: a
    // conversation is not tied to a folder until the Coding Agent edited it.
    if (current.attached && current.root && require('path').resolve(current.root).toLowerCase() !== chk.root.toLowerCase()
        && ((app.checkpoints && app.checkpoints.entries && app.checkpoints.entries.length) || (s.mutationReceipts || []).length)) {
      return bad(`this session already changed files in ${current.root}; start a new session for ${chk.root}`, 409);
    }
    if (app.abort && !app.abort.signal.aborted) return bad('a turn is running in this session', 409);
    // EVERYTHING BOUND TO THE OLD DIRECTORY IS REBUILT FOR THE NEW ONE: the
    // checkpoint store (refused above if it held edits), the project brief, and
    // a Harness whose workspace was the placeholder.
    if (app._harness) {
      try { await require('../harnesslink').shutdown(app); } catch { /* nothing it owned was project work */ }
      app._harness = null;
    }
    s.cwd = chk.root;
    app.cwd = chk.root;
    app.checkpoints = new (require('../checkpoint').Checkpoints)(s.id, chk.root, { load: false });
    app._projectBrief = undefined;
    const v = sv.views(s);
    v.project.attached = true;
    v.project.attachedAt = Date.now();
    v.panel.file = null;
    require('../sessionpool').reattach(app);
    save(app);
    return ok({ project: projectState(app) });
  },

  /**
   * REMOVE PROJECT — the Chat session becomes Unassigned again (Coding Agent
   * disabled). Refused once the Agent changed files there: that work belongs to
   * the project, and the session is its record.
   */
  'POST /api/project/detach': async (app) => {
    const s = app.session;
    if (s.cowork) return bad('a Cowork session has no project', 409);
    if (app.abort && !app.abort.signal.aborted) return bad('a turn is running in this session', 409);
    const cur = sv.project(s);
    if (!cur.attached) return ok({ project: projectState(app), already: true });
    if ((app.checkpoints && app.checkpoints.entries && app.checkpoints.entries.length) || (s.mutationReceipts || []).length) {
      return bad(`this session changed files in ${cur.root}; its record stays with that project`, 409);
    }
    if (app._harness) { try { await require('../harnesslink').shutdown(app); } catch { /* nothing project-bound */ } app._harness = null; }
    const dir = sv.unattachedDir();
    s.cwd = dir; app.cwd = dir;
    app.checkpoints = new (require('../checkpoint').Checkpoints)(s.id, dir, { load: false });
    app._projectBrief = undefined;
    const v = sv.views(s);
    v.project.attached = false; v.project.attachedAt = null; v.panel.file = null;
    require('../sessionpool').reattach(app);
    save(app);
    return ok({ project: projectState(app) });
  },

  /** Project roots this person has worked in, from the one session index. */
  'POST /api/project/recent': async () => {
    let rows = [];
    try { rows = require('../sessionindex').summaries({ limit: 200 }) || []; } catch { rows = []; }
    const seen = new Map();
    // NOT A PROJECT: LAIN's own folders, and the empty placeholder a session
    // with no project sits in — offering that as a "recent project" would
    // attach nothing to nothing.
    const own = [...sv.lainOwnDirs(), require('path').resolve(sv.unattachedDir()).toLowerCase()];
    for (const r of rows) {
      if (!r.cwd || seen.has(r.cwd.toLowerCase())) continue;
      if (own.includes(require('path').resolve(r.cwd).toLowerCase())) continue;
      let exists = false;
      try { exists = require('fs').statSync(r.cwd).isDirectory(); } catch { exists = false; }
      if (!exists) continue;
      seen.set(r.cwd.toLowerCase(), { root: r.cwd, name: require('path').basename(r.cwd), lastUsed: r.mtimeMs || null });
    }
    let fallback = null;
    try { fallback = require('../config').load().defaultProjectRoot || null; } catch { fallback = null; }
    return ok({ recent: [...seen.values()].slice(0, 20), defaultProjectRoot: fallback });
  },

  // ---------------------------------------------------------------- pins --

  'POST /api/files/pin': async (app, body = {}) => {
    if (!sv.project(app.session).attached) return bad('attach a project first', 409, { projectRequired: true });
    const at = require('./source').open(app, String(body.path || ''));
    if (!at.ok) return bad(at.why);
    const r = sv.pin(app.session, at.path, { from: body.from, to: body.to });
    if (!r.ok) return bad(r.why);
    save(app);
    return ok({ pins: r.pins });
  },
  'POST /api/files/unpin': async (app, body = {}) => {
    const r = sv.unpin(app.session, body.path);
    save(app);
    return ok({ removed: r.removed, pins: r.pins });
  },

  /** A changed file's diff against how this session found it. */
  'POST /api/files/diff': async (app, body = {}) => {
    if (!sv.project(app.session).attached) return bad('attach a project first', 409, { projectRequired: true });
    const want = String(body.path || '').replace(/\\/g, '/');
    const panes = require('../ui/panes');
    const f = panes.changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd }).find((x) => x.rel === want);
    if (!f) return ok({ path: want, changed: false, lines: [] });
    return ok({ path: f.rel, changed: true, kind: f.kind, added: f.added, removed: f.removed, lines: panes.unified(f.before, f.after, 800) });
  },
};

/** THE PROJECT, as Project Files and the session header read it. */
function projectState(app) {
  const s = app.session;
  const p = sv.project(s);
  let intelligence = null;
  if (p.attached && !p.missing) {
    try {
      const cov = require('../projectindex').coverage(p.root);
      intelligence = { freshness: cov.state, files: cov.discovered, declarations: cov.symbols, refreshedAt: cov.refreshedAt || null };
    } catch { intelligence = null; }
  }
  return {
    ...p,
    sync: app._projectSync || null,
    intelligence,
    pins: sv.views(s).pins,
    openFile: sv.views(s).panel.file,
  };
}

module.exports = { ROUTES, submit, projectState };
