'use strict';

/** THE HARNESS APPLICATION'S API — reads, and the few actions that cost something. */

const state = require('./state');
const source = require('./source');

/** How long a Workshop action may take before the app is told it did not finish. */
const ACTION_TIMEOUT_MS = 120_000;

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400) { return { code, body: { ok: false, why: String(why || 'refused') } }; }
function noProject() { return { code: 409, body: { ok: false, why: 'no project is attached to this session', projectRequired: true } }; }

/** Bound work, so a wedged browser cannot hold an HTTP connection open forever. */
function within(promise, ms = ACTION_TIMEOUT_MS, what = 'the operation') {
  return require('../deadline').race(promise, ms, () => ({ ok: false, why: `${what} did not finish within ${Math.round(ms / 1000)}s` }));
}

/** EVERY ROUTE, as `METHOD /path` -> handler. */
/** A WORKSHOP PICK, ANSWERED ONCE — both doors (a click on the preview image, a click in the preview window) end here. */
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

  /** A FILE DROPPED ON THE APPLICATION WINDOW. */
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

  /** QUIT LAIN — from the tray, which is the only place this comes from. */
  'POST /api/desktop/quit': async (app) => {
    app.wantExit = true;
    setTimeout(async () => {
      try { await require('../teardown').shutdown(app, { why: 'you quit LAIN' }); } catch { /* going anyway */ }
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

  /** WHAT THIS ACCOUNT ACTUALLY OFFERS. */
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


  // ------------------------------------------------------------- the turn --

  /** ASK SOMETHING. The application does not wait for the answer: a coding turn runs for minutes, and an HTTP request held open for one is a request that… */
  // THE SOURCE WORKSPACE
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
    // A REFUSAL IS NOT AN ERROR HERE.
    const { transaction, checkpoint, output, isError, mutated, ...shown } = r || {};
    return ok({ ...shown, generation: transaction ? transaction.generation : null });
  },

  // UI <-> SOURCE
  'POST /api/files/from-element': (app, body) => {
    const b = require('../gug').sourceBinding(app, app.session.cwd, body.element || {});
    return ok({ ...(b.component || { confidence: 'UNKNOWN', candidates: [] }), binding: b });
  },
  'POST /api/files/to-ui': (app, body) => ok(
    require('./uisource').toSelectors(app, String(body.path || ''), { line: body.line }),
  ),

  /** A SENTENCE TYPED INTO A CONVERSATION. */
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
    // NOT AWAITED, deliberately — see above.
    Promise.resolve(require('./sessionroutes').withPort(app, () => app.handle(text, { from: 'harness-app' }))).catch(() => {});
    return ok({ accepted: true });
  },

  'POST /api/interrupt': async (app) => {
    if (!app.abort || app.abort.signal.aborted) return ok({ interrupted: false });
    app.abort.abort();
    return ok({ interrupted: true });
  },

  // ------------------------------------------------------- the Workshop ---

  /** OPEN THE WORKSHOP for the current project: start or adopt the dev server, launch the project-bound preview browser, and load the page. */
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


  /** SELECT BY CLICKING THE PREVIEW IMAGE: page coordinates, mapped by the page. */
  'POST /api/workshop/pick-at': async (app, body) => {
    const ws = require('../workshop').forApp(app);
    const r = await within(ws.pickAt(app.session.cwd, body.x, body.y), 30_000, 'selecting the element');
    if (!r.ok) return bad(r.why);
    return ok({ element: r.element, ...(r.element ? await pickAnswer(app, ws, r.element) : { source: null, gug: null, binding: null, selection: null, open: null }) });
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

  /** VERIFY THE FRONTEND at one or more viewports. */
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
    // A FAILING CHECK IS EVIDENCE, NOT AN ERROR.
    return { code: 200, body: { ...r, ok: true, passed: Boolean(r.ok) } };
  },

};

/** Dispatch one request. */
/** WHICH CONVERSATION A REQUEST IS FOR. */
function acting(app, body) {
  // DISPATCH ASKS NO MORE OF ITS ARGUMENT THAN A HANDLER DOES.
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
    // A WRITE MOVED SOMETHING; LOOK AGAIN NOW
    if (String(method).toUpperCase() !== 'GET' && !QUIET_READS.has(pathname)) {
      try { require('./ipc').wake(); } catch { /* no window is connected */ }
    }
    return out;
  } catch (e) {
    // A ROUTE THAT THREW IS REPORTED, NEVER SWALLOWED.
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
// Route modules with their quiet reads: the editor profile, VS Code / Cursor import and extensions (extroutes); the session journey, house doors…
// LAIN Design's routes (designroutes.js) — each loads the Design engine only when Design is installed.
for (const mod of [require('./extroutes'), require('./journeyroutes'), require('./devtoolroutes'), require('./cacheroutes'), require('./updateroutes'), require('./computerroutes'), require('./designroutes')]) {   // + Computer Control (Phase CU)
  Object.assign(ROUTES, mod.ROUTES);
  for (const q of mod.QUIET || []) QUIET_READS.add(q);
}

module.exports = { dispatch, ROUTES, ACTION_TIMEOUT_MS };
