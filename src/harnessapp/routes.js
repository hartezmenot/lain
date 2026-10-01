'use strict';

/**
 * THE HARNESS APPLICATION'S API — reads, and the few actions that cost something.
 *
 * ------------------------------------------------------------------------
 * TWO KINDS OF ROUTE, AND THE SPLIT IS THE POINT.
 *
 *   GET /api/state        cheap, polled, opens nothing. See state.js.
 *   POST /api/…           deliberate. Each one launches a browser, contacts a
 *                         website, starts a dev server or submits a turn, and
 *                         is reached only because a person clicked something.
 *
 * A poll that could open a browser is a poll that opens one every two seconds.
 * So model DISCOVERY, Workshop OPEN, viewport changes, captures and
 * verification are all POSTs, and `/api/state` reports only what is already
 * known.
 *
 * ------------------------------------------------------------------------
 * IT DELEGATES EVERY DECISION.
 *
 * Nothing here decides whether a task passed, which model is available, whether
 * a page loaded, or whether a file changed. Each route calls the module that
 * owns that question and hands back what it said. The one thing these functions
 * add is an HTTP shape.
 *
 * ------------------------------------------------------------------------
 * SUBMITTING A TURN GOES THROUGH `app.handle`, WHICH IS THE ONE DOOR.
 *
 * Not `submit`, and certainly not `runTurn`. `handle` is where a command is
 * recognised, an open question is answered, a composed goal is captured and the
 * input gateway admits or holds a sentence — and every one of those must behave
 * identically whether the words arrived from the terminal or from the
 * application. A second entry point would be a second set of rules.
 */

const state = require('./state');
const source = require('./source');

/** How long a Workshop action may take before the app is told it did not finish. */
const ACTION_TIMEOUT_MS = 120_000;

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400) { return { code, body: { ok: false, why: String(why || 'refused') } }; }
function noProject() { return { code: 409, body: { ok: false, why: 'no project is attached to this session', projectRequired: true } }; }

/**
 * Bound work, so a wedged browser cannot hold an HTTP connection open forever. The deadline
 * goes when the work does (deadline.js) — it used to stay armed 30–120 s after every call.
 */
function within(promise, ms = ACTION_TIMEOUT_MS, what = 'the operation') {
  return require('../deadline').race(promise, ms, () => ({ ok: false, why: `${what} did not finish within ${Math.round(ms / 1000)}s` }));
}

/**
 * EVERY ROUTE, as `METHOD /path` -> handler.
 *
 * A flat table rather than a chain of ifs, so "what can this application do"
 * is answerable by reading one object — and so an unknown path is a 404 rather
 * than something falling through to a handler that half-matches it.
 */
/**
 * A WORKSHOP PICK, ANSWERED ONCE — both doors (a click on the preview image,
 * a click in the preview window) end here. The pick is measured into the GUG
 * (workshopPicked), which makes it the canonical Selection; the answer is THAT
 * Selection's one binding (node, style owner, component evidence), not a second
 * resolution — and `open` is the source the IDE should show: the style owner
 * when it is bound EXACT / LIKELY, otherwise the component that renders it.
 */
async function pickAnswer(app, ws, element) {
  const hc = require('../harnesscontext');
  let gug = null;
  try { gug = await within(hc.workshopPicked(app, app.session, ws, element), 30_000, 'mapping the selection'); } catch { gug = null; }
  let sel = null;
  try { sel = hc.selection(app, app.session); } catch { sel = null; }
  const binding = sel && sel.kind === 'visual' && sel.visual ? sel.visual.sourceBinding || null : null;
  const style = binding && binding.style && binding.style.file && ['EXACT', 'LIKELY'].includes(binding.style.confidence) ? { file: binding.style.file, line: binding.style.line || 1, why: `style owner ${binding.style.selector || ''} (${binding.style.confidence})` } : null;
  const top = binding && binding.component && binding.component.candidates && binding.component.candidates[0];
  const comp = top && binding.component.confidence !== 'UNKNOWN' ? { file: top.rel, line: (top.hits && top.hits[0] && top.hits[0].line) || 1, why: `component (${binding.component.confidence})` } : null;
  return { source: binding ? binding.component : null, gug, binding, selection: sel ? sel.id : null, projectGeneration: sel ? sel.projectGeneration : null, open: style || comp || null, alternatives: [style, comp].filter(Boolean) };
}

const ROUTES = {
  // ------------------------------------------------------------- reading --

  'GET /api/state': async (app) => ok({ state: await state.read(app) }),

  // --------------------------------------------------------------- Cowork --

  'POST /api/cowork/bind': async (app) => {
    if (!app.session.cowork && ((app.session.messages || []).length || (app.session.turns || []).length)) {
      return bad('start an empty session before binding it to Cowork; existing engineering history is not reclassified');
    }
    const binding = require('../cowork/sessionstate');
    try {
      binding.bind(app.session, 'harness', binding.sourceBinding('harness', [app.session.id, app.session.cwd]));
      app.session.save();
    } catch (error) { return bad(error.message); }
    return ok({ cowork: require('../cowork/runtime').project(app) });
  },

  'POST /api/cowork/attachment': async (app, body = {}) => {
    const result = require('../cowork/attachments').stage(app, body);
    return result.ok ? ok(result) : bad(result.why, result.class === 'PERMISSION_REQUIRED' ? 403 : 400);
  },

  /**
   * A FILE DROPPED ON THE APPLICATION WINDOW.
   *
   * ------------------------------------------------------------------------
   * THE NATIVE HOST SENDS PATHS; NOTHING ELSE IN LAIN EVER SEES THEM.
   *
   * Dragging `sales.xlsx` onto the window is the most natural way to start a
   * Cowork task, and it is also the shortest path from "the operating system"
   * to "a model's input" — so it is the one that has to be narrowest. This
   * route reads the bytes and hands them to the SAME staging authority the
   * browser upload uses (`cowork/attachments.stage`), which names, bounds,
   * types and scopes the result to the session.
   *
   * WHAT THE MODEL RECEIVES is an artifact reference. The absolute path the
   * host reported is never put into a session, never rendered, and never
   * reaches a prompt: a path is machine authority in text form, and handing one
   * to untrusted content is how a file outside the work gets opened.
   *
   * The host originates this call, so a refusal is reported the same way any
   * other staging refusal is — it does not become a native dialog of its own.
   */
  'POST /api/desktop/drop': async (app, body = {}) => {
    const fs2 = require('fs');
    const path2 = require('path');
    const paths = Array.isArray(body.paths) ? body.paths.slice(0, 10) : [];
    if (!paths.length) return bad('nothing was dropped');
    const staged = [];
    const refused = [];
    for (const p of paths) {
      const abs = String(p || '');
      let st = null;
      try { st = fs2.statSync(abs); } catch { refused.push({ name: path2.basename(abs), why: 'it could not be read' }); continue; }
      if (!st.isFile()) { refused.push({ name: path2.basename(abs), why: 'a folder cannot be attached' }); continue; }
      let data;
      try { data = fs2.readFileSync(abs).toString('base64'); } catch (e) {
        refused.push({ name: path2.basename(abs), why: (e && e.message) || 'unreadable' });
        continue;
      }
      const r = require('../cowork/attachments').stage(app, { name: path2.basename(abs), data });
      if (r.ok) staged.push(r.attachment);
      else refused.push({ name: path2.basename(abs), why: r.why });
    }
    if (!staged.length) return bad(refused.length ? refused[0].why : 'nothing could be attached', 400);
    return ok({ staged, refused });
  },

  /**
   * QUIT LAIN — from the tray, which is the only place this comes from.
   *
   * ------------------------------------------------------------------------
   * THE HOST ASKS; CORE DECIDES AND CORE DOES IT.
   *
   * Closing the window hides it (native/host.cs); this is the other thing, and
   * the two are deliberately different gestures. The reason it is a ROUTE rather
   * than the host simply exiting is ownership: the messaging gateway, the agent
   * jobs, the shell children, the browsers and the dev servers all belong to
   * Core, and only Core's own sequence stops all of them. A host that killed
   * itself would leave every one of those running with nothing on screen to say
   * so — the exact orphan the sequence exists to prevent.
   *
   * IT CLOSES THE WINDOW AS PART OF THE SHUTDOWN, so the answer to this request
   * may never arrive. That is correct and is why the host has its own bounded
   * backstop.
   */
  'POST /api/desktop/quit': async (app) => {
    app.wantExit = true;
    setTimeout(async () => {
      try { await require('../teardown').shutdown(app, { why: 'you quit Noema' }); } catch { /* going anyway */ }
      process.exit(0);
    }, 10);
    return ok({ quitting: true });
  },

  'POST /api/cowork/artifact': async (app, body = {}) => {
    const owned = require('../cowork/artifacts'), rec = owned.find(app, body.ref), bytes = rec && owned.bytes(app, body.ref);
    if (!rec || !bytes) return bad('artifact is unavailable or does not belong to this Cowork session', 404);
    return ok({ artifact: { ...owned.publicRecord(rec), data: bytes.toString('base64') } });
  },

  'POST /api/cowork/background': async (app, body = {}) => {
    if (!app.session.cowork) return bad('bind this session to Cowork first', 403);
    const text = String(body.text || '').trim();
    if (!text) return bad('background work needs an instruction');
    if (app.jobs.running().filter((job) => !job.primary).length >= 2) return bad('two background tasks are already running', 409);
    const job = app.startBackground(text);
    return job ? ok({ job: require('../cowork/runtime').jobs(app).find((row) => row.id === job.id) }) : bad('background work could not start', 409);
  },

  'POST /api/cowork/cancel': async (app, body = {}) => {
    const job = app.jobs.get(String(body.id || ''));
    if (!job || job.primary) return bad('no such Cowork background task', 404);
    return ok({ cancelled: job.cancel('cancelled from Cowork') });
  },

  'POST /api/cowork/answer': async (app, body = {}) => {
    const job = app.jobs.get(String(body.id || ''));
    if (!job || !job.needsInput) return bad('that Cowork task is not waiting for an answer', 409);
    return ok({ answered: job.reply(String(body.answer || '')) });
  },

  // ------------------------------------------------ the chat model source --

  /**
   * WHAT THIS ACCOUNT ACTUALLY OFFERS. Paid: it opens the authenticated
   * browser, and on a signed-out account it reports AUTH_REQUIRED rather than
   * an empty list — see modelsource/webmodel.js on why those are different
   * answers.
   */
  'POST /api/source/models': async (app, body) => {
    const registry = require('../modelsource/registry');
    const src = registry.get(app, String(body.source || ''));
    if (!src) return bad(`"${body.source}" is not a chat source`);
    const inv = await within(src.discoverModels({ refresh: Boolean(body.refresh) }), ACTION_TIMEOUT_MS, 'model discovery');
    return ok({
      source: src.id,
      models: inv.models || [],
      cached: Boolean(inv.cached),
      why: inv.why || '',
      authRequired: Boolean(inv.authRequired),
    });
  },

  /** Open the site so a PERSON can sign in. LAIN never types a credential. */
  'POST /api/source/connect': async (app, body) => {
    const registry = require('../modelsource/registry');
    const src = registry.get(app, String(body.source || ''));
    if (!src) return bad(`"${body.source}" is not a chat source`);
    const st = await within(src.connect(), ACTION_TIMEOUT_MS, 'connecting');
    return ok({ state: st.state, why: st.why || '' });
  },

  // THE CHAT VIEW'S SOURCE AND MODEL — for THIS session only. It goes through
  // the same per-view selection as `/api/models/select`, so picking a runtime
  // model for Chat never moves the Coding model or the process default.
  'POST /api/source/select': async (app, body) => {
    const picked = await within(require('../modelinventory').select(app, {
      lane: 'chat', source: String(body.source || ''), modelId: body.model ? String(body.model) : '',
    }), ACTION_TIMEOUT_MS, 'selecting the model');
    if (!picked.ok) return bad(picked.why);
    try { app.session.save(); } catch { /* the selection still holds for this run */ }
    return ok({ source: picked.selected.source, model: picked.selected.modelId || null });
  },

  // ------------------------------------------------------------- the turn --

  /**
   * ASK SOMETHING. The application does not wait for the answer: a coding turn
   * runs for minutes, and an HTTP request held open for one is a request that
   * times out somewhere in between. The reply arrives through `/api/state` like
   * everything else, which is also what keeps the terminal and the application
   * showing the same conversation.
   */
  // ---- THE SOURCE WORKSPACE -------------------------------------------
  //
  // `/api/files/…`, NOT `/api/source/…`. That prefix was already taken, by the
  // MODEL sources — ChatGPT, Gemini, the local runtime. Two unrelated meanings
  // of "source" under one namespace is the kind of collision that reads fine
  // the day it lands and costs an afternoon later.
  //
  // READS ARE POSTs, and that is deliberate rather than sloppy REST: they take
  // a PATH from the caller, and a path in a query string is a path in the
  // browser's history, in the address bar and in any log between. The bodies
  // are tiny and the page is the only client.
  //
  // Every one of them goes through harnessapp/source.js, which resolves through
  // tools/fs.js and refuses anything outside the project — the UI holds edit
  // INTENT and never the file authority.
  // PROJECT FILES ARE THE ATTACHED PROJECT'S. With no project attached there is
  // no tree to show — never LAIN's own folder — and the refusal says so
  // structurally (`projectRequired`) so the panel can offer Add project.
  'POST /api/files/tree': (app, body) => {
    if (!require('../sessionviews').project(app.session).attached) return noProject();
    const r = source.tree(app, String(body.path || ''));
    return ok({ ...r, root: app.session.cwd });
  },
  'POST /api/files/open': (app, body) => {
    if (!require('../sessionviews').project(app.session).attached) return noProject();
    const r = source.open(app, String(body.path || ''));
    if (r.ok) {
      // BROWSING IS REMEMBERED, NOT INJECTED: the open file is panel state, and
      // nothing about it reaches a prompt unless it is pinned.
      require('../sessionviews').panel(app.session, { action: 'set', file: r.path });
      r.pinned = require('../sessionviews').views(app.session).pins.some((p) => p.path === r.path);
    }
    return r.ok ? ok(r) : bad(r.why);
  },
  'POST /api/files/find': (app, body) => {
    if (!require('../sessionviews').project(app.session).attached) return noProject();
    return ok(source.find(app, String(body.q || '')));
  },
  'POST /api/files/freshness': (app, body) => ok({ files: source.freshness(app, body.open || []) }),
  'POST /api/files/save': async (app, body) => {
    const r = await source.save(app, String(body.path || ''), body.body, {
      hash: body.hash, mtimeMs: body.mtimeMs, force: Boolean(body.force), encoding: body.encoding || null,
      origin: body.origin === 'FORMATTER' ? 'FORMATTER' : 'USER',
    });
    // A REFUSAL IS NOT AN ERROR HERE. Stale and truncation both come back 200
    // with the reason and the evidence, because the page has to SHOW them —
    // a 4xx would be swallowed by the generic handler and the person would see
    // "save failed" with nothing to act on.
    // (The generation, the GUG and provenance follow inside the mutation
    // transaction the save went through — source.save → mutation.change.)
    const { transaction, checkpoint, output, isError, mutated, ...shown } = r || {};
    return ok({ ...shown, generation: transaction ? transaction.generation : null });
  },

  // ---- UI <-> SOURCE --------------------------------------------------
  //
  // The defining feature. Both directions return EVIDENCE and a CONFIDENCE,
  // and `UNKNOWN` is a real answer — see harnessapp/uisource.js on why a
  // confident wrong file costs more than an honest shrug.
  // THE ONE UI → SOURCE BINDING (gug.sourceBinding): the component evidence is
  // what this route has always answered; the style owner comes with it.
  'POST /api/files/from-element': (app, body) => {
    const b = require('../gug').sourceBinding(app, app.session.cwd, body.element || {});
    return ok({ ...(b.component || { confidence: 'UNKNOWN', candidates: [] }), binding: b });
  },
  'POST /api/files/to-ui': (app, body) => ok(
    require('./uisource').toSelectors(app, String(body.path || ''), { line: body.line }),
  ),

  /**
   * A SENTENCE TYPED INTO A CONVERSATION.
   *
   * ------------------------------------------------------------------------
   * INTO A SESSION THAT IS ALREADY WORKING, IT IS A STEER — as in the terminal.
   *
   * This used to be a flat 409. That is the right shape of answer for "two
   * uncontrolled turns in one session" and the wrong answer for what a person
   * is actually doing, which is adding a sentence to work in progress. The
   * terminal has had the correct contract for a long time: a steer defaults to
   * WAIT and lands when the work in flight finishes, and `submit`'s drain
   * delivers it as the user's own text. So the window uses that contract rather
   * than a second one.
   *
   * NOTE WHICH SESSION. `app` here is the one the request named (see
   * `acting`), so a steer reaches the conversation it was typed into and a turn
   * running in a different one is untouched.
   */
  'POST /api/turn': async (app, body) => {
    // A TURN FROM A VIEW — Chat or Coding — has its own sequencing rules. See
    // viewroutes.submit. Without `view` the behaviour below is unchanged.
    if (body && (body.view === 'chat' || body.view === 'coding')) return require('./viewroutes').submit(app, body);
    const text = String(body.text || '').trim();
    if (!text) return bad('nothing was asked');
    if (app.abort && !app.abort.signal.aborted) {
      app.queueSteer(text, body.now ? 'NOW' : 'WAIT');
      return ok({ accepted: true, steered: true, when: body.now ? 'NOW' : 'WAIT' });
    }
    // NOT AWAITED, deliberately — see above. `handle` is the one door: it
    // recognises commands, answers open questions, captures a composed goal and
    // consults the input gateway, exactly as it does for the terminal.
    // IN THE HARNESS PORT: this turn's questions and approvals come to the window.
    Promise.resolve(require('./sessionroutes').withPort(app, () => app.handle(text, { from: 'harness-app' }))).catch(() => {});
    return ok({ accepted: true });
  },

  'POST /api/interrupt': async (app) => {
    if (!app.abort || app.abort.signal.aborted) return ok({ interrupted: false });
    app.abort.abort();
    return ok({ interrupted: true });
  },

  // ------------------------------------------------------- the Workshop ---

  /**
   * OPEN THE WORKSHOP for the current project: start or adopt the dev server,
   * launch the project-bound preview browser, and load the page.
   */
  'POST /api/workshop/open': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.open(app.session.cwd, {
      taskId: body.taskId || null,
    }), ACTION_TIMEOUT_MS, 'opening the Workshop');
    return r.ok ? ok(r) : bad(r.why);
  },

  'POST /api/workshop/close': async (app) => {
    const ws = require('../workshop').forApp(app);
    return ok(await ws.close(app.session.cwd));
  },

  'POST /api/workshop/navigate': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.navigate(app.session.cwd, String(body.url || '')), ACTION_TIMEOUT_MS, 'navigation');
    return r.ok ? ok(r) : bad(r.why);
  },

  'POST /api/workshop/reload': async (app) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.reload(app.session.cwd), ACTION_TIMEOUT_MS, 'reload');
    return r.ok ? ok(r) : bad(r.why);
  },

  /** ARM ELEMENT PICKING. The next click in the preview selects rather than acts. */
  'POST /api/workshop/pick': async (app) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.pick(app.session.cwd), 30_000, 'arming the picker');
    return r.ok ? ok(r) : bad(r.why);
  },

  /** WHAT THE PERSON PICKED, or null. Polled by the app while picking is armed. */
  'POST /api/workshop/picked': async (app) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.picked(app.session.cwd), 30_000, 'reading the selection');
    // THE PICK AS A GUG NODE (harnesscontext.js): Core now knows what "this" is.
    if (r && r.ok && r.element) return ok({ ...r, ...(await pickAnswer(app, ws, r.element)) });
    return ok(r);
  },

  /**
   * THE WORKSHOP'S GEOMETRIC UI GRAPH (gug.js): re-measure, and say what moved
   * since the last measurement — "SearchBar height +6px · Results moved +6px"
   * rather than "SearchView.tsx changed". Optional `id`: that node's slice.
   */
  'POST /api/workshop/gug': async (app, body = {}) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(require('../harnesscontext').measureWorkshop(app, app.session, ws), 30_000, 'measuring the page');
    if (!r.ok) return bad(r.why);
    const slice = body.id ? require('../gug').slice(r.graph, String(body.id)) : null;
    return ok({ gug: r.summary, impact: r.impact ? { from: r.impact.from, to: r.impact.to, lines: r.impact.lines, affectedRelations: r.impact.affectedRelations } : null, slice: slice && slice.found ? slice.text : null });
  },

  /** SELECT BY CLICKING THE PREVIEW IMAGE: page coordinates, mapped by the page. */
  'POST /api/workshop/pick-at': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.pickAt(app.session.cwd, body.x, body.y), 30_000, 'selecting the element');
    if (!r.ok) return bad(r.why);
    return ok({ element: r.element, ...(r.element ? await pickAnswer(app, ws, r.element) : { source: null, gug: null, binding: null, selection: null, open: null }) });
  },

  'POST /api/workshop/unpick': async (app) => {
    const ws = require('../workshop').forApp(app);
    return ok(await ws.unpick(app.session.cwd));
  },

  'POST /api/workshop/element': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.element(app.session.cwd, String(body.selector || '')), 30_000, 'inspecting the element');
    return r.ok ? ok(r) : bad(r.why);
  },

  'POST /api/workshop/ax': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.axTree(app.session.cwd, body.selector || null), 30_000, 'reading the accessibility tree');
    return r.ok ? ok(r) : bad(r.why);
  },

  'POST /api/workshop/viewport': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.viewport(app.session.cwd, String(body.name || 'desktop')), ACTION_TIMEOUT_MS, 'the viewport change');
    return r.ok ? ok(r) : bad(r.why);
  },

  /** A SCREENSHOT. `as: 'before'` also banks it for the comparison. */
  'POST /api/workshop/capture': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const taskId = (app._harness && app._harness.snapshot && app._harness.snapshot().task)
      ? app._harness.snapshot().task.id : null;
    const r = await within(ws.capture(app.session.cwd, {
      as: body.as || null, taskId, name: body.name || null,
    }), ACTION_TIMEOUT_MS, 'the capture');
    if (!r.ok) return bad(r.why);
    const before = body.as === 'after' ? ws.before(app.session.cwd, r.viewport) : null;
    return ok({ shot: r, before });
  },

  /**
   * VERIFY THE FRONTEND at one or more viewports.
   *
   * IT RETURNS EVIDENCE, NOT A VERDICT ABOUT THE TASK. harness/verify.js and
   * completion.js remain the only things that settle work; this is what they
   * settle from. See workshop/index.js `verify`.
   */
  'POST /api/workshop/verify': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const taskId = (app._harness && app._harness.snapshot && app._harness.snapshot().task)
      ? app._harness.snapshot().task.id : null;
    const r = await within(ws.verify(app.session.cwd, {
      viewports: Array.isArray(body.viewports) && body.viewports.length ? body.viewports : ['desktop', 'mobile'],
      taskId,
      selector: body.selector || null,
    }), ACTION_TIMEOUT_MS * 2, 'verification');
    if (!Array.isArray(r.results)) return bad(r.why || 'verification did not complete');
    // A FAILING CHECK IS EVIDENCE, NOT AN ERROR. `r.ok` is the verdict and used to
    // override the envelope, so the page showed "did not complete" and threw away
    // the one result a person needed — which viewport broke, and how.
    return { code: 200, body: { ...r, ok: true, passed: Boolean(r.ok) } };
  },

  /**
   * ATTACH AN OBSERVATION TO THE NEXT TURN.
   *
   * The Workshop's whole reason for existing on the same screen as the
   * conversation: a person selects an element, and what they selected becomes
   * the context of what they ask next — WITHOUT sending the DOM.
   *
   * Bounded and specific by construction: the selector, the accessible name,
   * the box, and the console/network lines that are actually failing.
   */
  'POST /api/workshop/attach': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const text = String(body.text || '').trim();
    if (!text) return bad('nothing was asked');
    const el = body.selector
      ? await within(ws.element(app.session.cwd, String(body.selector)), 30_000, 'inspecting the element')
      : { ok: false };
    const obs = ws.observations(app.session.cwd) || {};
    const lines = [text, ''];
    if (el.ok && el.element) {
      const e = el.element;
      lines.push('THE ELEMENT I SELECTED IN THE PREVIEW:');
      lines.push(`  selector   ${e.selector || body.selector}`);
      if (e.role || e.name) lines.push(`  accessible ${[e.role, e.name].filter(Boolean).join(' — ')}`);
      if (e.tag) lines.push(`  tag        ${e.tag}${e.id ? `#${e.id}` : ''}${e.classes ? `.${String(e.classes).trim().split(/\s+/).join('.')}` : ''}`);
      if (e.rect) lines.push(`  box        ${e.rect.w}×${e.rect.h} at ${e.rect.x},${e.rect.y}`);
      // ---- THE COMPUTED VALUES, AND ONLY THE ONES THAT DECIDE LAYOUT ----
      //
      // `layout` carries every property inspect.js reads. Sending all of them
      // would be a wall of defaults; these are the ones an alignment question is
      // actually answered by. See workshop/inspect.js LAYOUT_PROPS.
      if (e.layout) {
        const care = ['display', 'position', 'align-items', 'justify-content', 'margin', 'padding', 'width', 'text-align'];
        const said = care.filter((k) => e.layout[k]).map((k) => `${k}: ${String(e.layout[k]).trim()}`);
        if (said.length) lines.push(`  computed   ${said.join('; ')}`);
      }
      // THE PARENT DECIDES MOST ALIGNMENT, which is why inspect.js carries it:
      // a child that will not centre is usually a parent that is not a flex row.
      if (e.parent) {
        lines.push(`  parent     <${e.parent.tag}> display: ${e.parent.display}`
          + `${e.parent.justify ? `; justify-content: ${e.parent.justify}` : ''}`
          + `${e.parent.align ? `; align-items: ${e.parent.align}` : ''}`);
      }
    }
    // ---- THE REPORTS ARE SUMMARIES, NOT ARRAYS -------------------------
    //
    // `consoleReport` and `networkReport` return `{errors,total,entries}` and
    // `{total,failed,entries}` — already filtered to what is worth reading, and
    // already bounded. Treating them as raw arrays (which this did until a real
    // run printed `console undefined`) silently attaches nothing at all.
    const cons = obs.console || {};
    const errs = (cons.entries || []).slice(0, 5);
    if (errs.length) {
      lines.push('', `CONSOLE ERRORS ON THE PAGE (${cons.errors} of ${cons.total} entries):`);
      for (const e of errs) lines.push(`  ${String(e.text).slice(0, 200)}`);
    }
    const net = obs.network || {};
    const failed = (net.entries || []).slice(0, 5);
    if (failed.length) {
      lines.push('', `FAILED REQUESTS (${net.failed} of ${net.total}):`);
      for (const n of failed) lines.push(`  ${n.status} ${String(n.url).slice(0, 160)}`);
    }
    if (obs.viewport) lines.push('', `Observed at the ${obs.viewport} viewport.`);
    if (app.abort && !app.abort.signal.aborted) return bad('a turn is already running', 409);
    const composed = lines.join('\n');
    Promise.resolve(require('./sessionroutes').withPort(app, () => app.handle(composed, { from: 'harness-app' }))).catch(() => {});
    return ok({ accepted: true, sent: composed });
  },
};

/**
 * Dispatch one request. Returns `{code, body}`; the server does the writing.
 *
 * UNKNOWN IS 404, not a fall-through. A path that half-matches a handler is how
 * an application quietly does the wrong thing.
 */
/**
 * WHICH CONVERSATION A REQUEST IS FOR.
 *
 * ------------------------------------------------------------------------
 * THE SURFACE NAMES THE SESSION; IT DOES NOT MOVE INTO IT.
 *
 * Every route below used to act on "the App", which meant "whatever session the
 * terminal happened to be on" — so the window could only ever operate on one
 * conversation, and switching to a second one had to drag the terminal with it.
 * That coupling is what made a running turn look like a lock on the whole
 * application. See src/sessionpool.js.
 *
 * Now a request may carry `session`, and the handler is given the App that owns
 * that conversation. Without one it is given the VIEW — the session the window
 * is showing, which is a fact about the window and not about what is executing.
 *
 * A NAMED SESSION THAT IS NOT LIVE IS A REFUSAL, not a silent fallback onto the
 * view: acting on a different conversation than the one the caller named is the
 * worst possible way to be wrong here.
 */
function acting(app, body) {
  // DISPATCH ASKS NO MORE OF ITS ARGUMENT THAN A HANDLER DOES. A real `App`
  // always has a pool; a test double standing in for one may not, and a
  // transport layer that demanded a method the routes themselves never call
  // would turn "this object is missing something" into an error about pools.
  const pool = typeof app.pool === 'function' ? app.pool() : null;
  if (!pool) return { app };
  const named = body && body.session ? String(body.session) : '';
  if (!named) return { app: pool.view() };
  const target = pool.live(named);
  if (!target) return { refuse: { code: 409, body: { ok: false, why: `session ${named} is not open` } } };
  return { app: target };
}

/** POST routes that change nothing the window shows — they never wake it. */
const QUIET_READS = new Set([
  '/api/files/freshness', '/api/files/open', '/api/files/raw', '/api/files/tree', '/api/files/find',
  '/api/files/diff', '/api/files/search', '/api/files/check',
  '/api/terminal/read', '/api/terminal/processes', '/api/terminal/resize', '/api/terminal/input',
  '/api/git/status', '/api/git/diff', '/api/git/show', '/api/git/branches',
  '/api/ide/context', '/api/ide/definition', '/api/ide/resolve', '/api/workspace/vscode',
  '/api/clipboard/read', '/api/clipboard/write', '/api/image/read',
  '/api/devserver/status', '/api/chrome/status', '/api/project/recent', '/api/preview/input/next',
]);

async function dispatch(app, method, pathname, body) {
  const key = `${String(method).toUpperCase()} ${pathname}`;
  const fn = ROUTES[key];
  if (!fn) return { code: 404, body: { ok: false, why: `no route ${key}` } };
  try {
    const pick = acting(app, body);
    if (pick.refuse) return pick.refuse;
    const out = await fn(pick.app, body || {});
    // ---- A WRITE MOVED SOMETHING; LOOK AGAIN NOW -------------------------
    //
    // Creating a session, selecting one, closing one, starting a turn — every
    // POST here changes what the window is showing. Waiting for the next poll
    // to notice meant a click could sit for most of a second before the
    // application admitted it had happened, which reads as LAIN being slow at
    // the one thing that is instant. GET is excluded: a read changes nothing,
    // and waking on it would be a loop.
    //
    // A READ SENT AS POST IS STILL A READ. The window calls several of these
    // on every render (is the open file fresh?) or on a short clock (the
    // terminal pump); waking on them made poll → render → read → wake → poll a
    // loop at pipe speed — measured at ~70 state reads a second, enough to
    // starve every turn on Core's event loop.
    if (String(method).toUpperCase() !== 'GET' && !QUIET_READS.has(pathname)) {
      try { require('./ipc').wake(); } catch { /* no window is connected */ }
    }
    return out;
  } catch (e) {
    // A ROUTE THAT THREW IS REPORTED, NEVER SWALLOWED. The application shows the
    // sentence; the alternative is a button that does nothing for no stated
    // reason, which is indistinguishable from a broken build.
    return { code: 500, body: { ok: false, why: `${key}: ${(e && e.message) || e}` } };
  }
}

// Sessions, and the questions a window-started turn asks — see sessionroutes.js.
Object.assign(ROUTES, require('./sessionroutes').ROUTES);
// The project's processes, and the way out to a real terminal — terminalroutes.js.
Object.assign(ROUTES, require('./terminalroutes').ROUTES);
// Looking at a picture, in the native window rather than a generated HTML page
// handed to a browser — imageroutes.js.
Object.assign(ROUTES, require('./imageroutes').ROUTES);
// Chat/Coding views, plan handoff, models, workspace panel, project, pins.
Object.assign(ROUTES, require('./viewroutes').ROUTES);
// The project's dev server as a first-class object — devroutes.js.
Object.assign(ROUTES, require('./devroutes').ROUTES);
// Messaging connections and the Telegram setup flow — botroutes.js.
Object.assign(ROUTES, require('./botroutes').ROUTES);
// Account instances: runtime accounts (Codex, …) and API routes as one list.
Object.assign(ROUTES, require('./instanceroutes').ROUTES);
Object.assign(ROUTES, require('./usageroutes').ROUTES);
// The personal assistant: tasks, activity, settings — assistantroutes.js.
Object.assign(ROUTES, require('./assistantroutes').ROUTES);
// Chat supervising the Coding Agent: offers, findings, strategy, profile, quota Continue, plan send — workbenchroutes.js.
Object.assign(ROUTES, require('./workbenchroutes').ROUTES);
// GitHub as a project source — githubroutes.js.
Object.assign(ROUTES, require('./githubroutes').ROUTES);
// Appearance, AGENTS.md, feedback, session controls, surface handoff, reset windows — productroutes.js.
Object.assign(ROUTES, require('./productroutes').ROUTES);
// MODEL's intelligence fabric: local models, runtimes, legacy keys — fabricroutes.js.
Object.assign(ROUTES, require('./fabricroutes').ROUTES);
// LAIN for Chrome's connection state — chromeroutes.js.
Object.assign(ROUTES, require('./chromeroutes').ROUTES);
// Settings: a schema, validated updates — settingsroutes via src/settings.js.
Object.assign(ROUTES, require('../settings').ROUTES);
// The workspace shell: accounts and usage, MCP, skills, opening a project.
Object.assign(ROUTES, require('./workspaceroutes').ROUTES);
// The IDE: file operations, search, source control, editor context — ideroutes.js.
Object.assign(ROUTES, require('./ideroutes').ROUTES);
// Route modules with their quiet reads: the editor profile, VS Code / Cursor import and extensions (extroutes); the
// session journey, house doors, Laya's provenance and the focused packet (journeyroutes); runtime processes, the
// extension host and language servers (devtoolroutes); Settings › Storage (cacheroutes); updates and Exit (updateroutes).
for (const mod of [require('./extroutes'), require('./journeyroutes'), require('./devtoolroutes'), require('./cacheroutes'), require('./updateroutes')]) {
  Object.assign(ROUTES, mod.ROUTES);
  for (const q of mod.QUIET || []) QUIET_READS.add(q);
}

module.exports = { dispatch, ROUTES, ACTION_TIMEOUT_MS };
