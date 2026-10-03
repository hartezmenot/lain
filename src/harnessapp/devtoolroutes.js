'use strict';

/** THE DEVELOPMENT TOOLING'S ROUTES — the window onto three Core owners */

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function reply(r) { return r && r.ok !== false ? ok(r) : { code: 200, body: { ok: false, ...(r || {}), why: String((r && r.why) || 'refused') } }; }

const ROUTES = {
  // ---- runtime ----------------------------------------------------------------
  'POST /api/runtime/list': () => {
    const reg = require('../runtimeregistry');
    return ok({ processes: reg.list().filter((p) => p.alive !== false), owner: reg.defaultOwner() });
  },
  /** LEGACY TEST SUPERVISORS (legacyprocs.js): a scan that changes nothing, and a stop of the SELECTED ids only — each re-verified as the same process and… */
  'POST /api/runtime/legacy/scan': () => ok(require('../legacyprocs').scan()),
  'POST /api/runtime/legacy/stop': (app, body = {}) => reply(require('../legacyprocs').stop(Array.isArray(body.ids) ? body.ids.slice(0, 200) : [])),
  /** A person pressed Stop on ONE verified record. */
  'POST /api/runtime/stop': (app, body = {}) => reply(require('../runtimeregistry').stop(String(body.id || ''), { explicit: true })),

  // ---- extension host ----------------------------------------------------------
  'POST /api/exthost/status': (app) => ok({ extensions: require('../exthost/manager').status(app) }),
  'POST /api/exthost/allow': (app, body = {}) => reply(require('../exthost/manager').allow(app, String(body.id || ''), body.scope === 'workspace' ? 'workspace' : 'global', { run: body.run !== false, grant: body.grant || {} })),
  'POST /api/exthost/start': async (app) => ok({ started: await require('../exthost/manager').startAll(app) }),
  'POST /api/exthost/restart': async (app, body = {}) => reply(await require('../exthost/manager').restart(app, String(body.id || ''), body.scope === 'workspace' ? 'workspace' : 'global')),
  'POST /api/exthost/stop': (app, body = {}) => reply(require('../exthost/manager').stop(app, String(body.id || ''), body.scope === 'workspace' ? 'workspace' : 'global')),
  'POST /api/exthost/command': async (app, body = {}) => reply(await require('../exthost/manager').executeCommand(app, String(body.id || ''), Array.isArray(body.args) ? body.args : [], { origin: 'user' })),
  'POST /api/exthost/diagnostics': () => ok({ diagnostics: require('../exthost/manager').diagnostics() }),
  'POST /api/exthost/provide': async (app, body = {}) => ok({ results: await require('../exthost/manager').provide(app, body.kind === 'hover' ? 'hover' : 'completion', { path: String(body.path || ''), line: Number(body.line) || 0, col: Number(body.col) || 0 }) }),

  // ---- the debugger (dap/manager.js) -------------------------------------------------
  'POST /api/debug/status': (app) => ok(require('../dap/manager').status(app)),
  'POST /api/debug/start': async (app, body = {}) => reply(await require('../dap/manager').start(app, { program: String(body.program || ''), adapter: body.adapter || null, args: Array.isArray(body.args) ? body.args.map(String).slice(0, 40) : [], cwd: body.cwd || null, stopOnEntry: Boolean(body.stopOnEntry) })),
  'POST /api/debug/breakpoints': async (app, body = {}) => reply(await require('../dap/manager').setBreakpoints(app, String(body.path || ''), Array.isArray(body.lines) ? body.lines.slice(0, 200) : [])),
  'POST /api/debug/control': async (app, body = {}) => reply(await require('../dap/manager').control(app, String(body.action || ''))),
  'POST /api/debug/evaluate': async (app, body = {}) => reply(await require('../dap/manager').evaluate(app, String(body.expression || '').slice(0, 2000), { context: body.context === 'watch' ? 'watch' : 'repl' })),
  'POST /api/debug/expand': async (app, body = {}) => reply(await require('../dap/manager').expand(app, Number(body.ref) || 0)),
  'POST /api/debug/frame': async (app, body = {}) => reply(await require('../dap/manager').selectFrame(app, Number(body.frameId))),
  'POST /api/debug/watches': async (app, body = {}) => reply(await require('../dap/manager').setWatches(app, Array.isArray(body.watches) ? body.watches : [])),
  'POST /api/debug/stop': async (app) => reply(await require('../dap/manager').stop(app)),

  // ---- language servers ---------------------------------------------------------
  'POST /api/lsp/status': (app) => ok({ servers: require('../lsp/manager').status(app) }),
  'POST /api/lsp/restart': async (app, body = {}) => reply(await require('../lsp/manager').restart(app, String(body.id || ''))),
  'POST /api/lsp/stop': async (app, body = {}) => reply(await require('../lsp/manager').stop(app, String(body.id || ''))),
  'POST /api/lsp/definition': async (app, body = {}) => reply(await require('../lsp/manager').definition(app, body)),
  'POST /api/lsp/references': async (app, body = {}) => reply(await require('../lsp/manager').references(app, body)),
  'POST /api/lsp/hover': async (app, body = {}) => reply(await require('../lsp/manager').hover(app, body)),
  'POST /api/lsp/symbols': async (app, body = {}) => reply(body.query != null ? await require('../lsp/manager').workspaceSymbols(app, body) : await require('../lsp/manager').documentSymbols(app, body)),
  'POST /api/lsp/diagnostics': (app) => ok({ diagnostics: require('../lsp/manager').diagnostics(app) }),
  /** The person's F2: planned by the server, applied through the one mutation transaction (actor USER). */
  'POST /api/lsp/rename': async (app, body = {}) => {
    const lsp = require('../lsp/manager');
    const plan = await lsp.rename(app, body);
    if (!plan.ok || body.dryRun) return reply(plan);
    return reply({ ...(await lsp.applyRename(app, plan, { actor: 'USER' })), count: plan.count });
  },
};

const QUIET = ['POST /api/runtime/list', 'POST /api/debug/status', 'POST /api/exthost/status', 'POST /api/exthost/diagnostics', 'POST /api/lsp/status', 'POST /api/lsp/diagnostics',
  'POST /api/lsp/definition', 'POST /api/lsp/references', 'POST /api/lsp/hover', 'POST /api/lsp/symbols', 'POST /api/exthost/provide'];

module.exports = { ROUTES, QUIET };
