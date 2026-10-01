'use strict';

/**
 * THE WORKSPACE SHELL'S ROUTES — accounts, tools, and opening a project.
 *
 * The LAIN window is one workspace with a Model view, Settings › MCP and
 * Skills, and an IDE that opens a folder. Each route here reads or calls the
 * owner that already exists; none of them keeps state of its own.
 *
 *   POST /api/accounts            providers, routes, usage, roles  (accounts.js)
 *   POST /api/accounts/refresh    re-discover every route's catalog, bounded
 *   POST /api/mcp/servers         Computer MCP and the configured servers (mcp.js)
 *   POST /api/skills              what the skill loader reports — none exists yet
 *   POST /api/project/open        attach here, or a new session on that folder
 *   POST /api/project/create      make the folder, then open it
 *
 * NOT POLLED. Every one of these is reached because a person opened a view or
 * pressed something; `/api/state` stays the only thing on a timer.
 */

const fs = require('fs');
const path = require('path');

function ok(body = {}) { return { code: 200, body: { ok: true, ...body } }; }
function bad(why, code = 400, extra = {}) { return { code, body: { ok: false, why: String(why || 'refused'), ...extra } }; }
/** An owner's `{ok, why, ...}` answer, as a response. */
function reply(r) { return r && r.ok ? ok(r) : bad(r && r.why, 400, r || {}); }

function cfgOf(app) { return ((app && app._sibling) || app).cfg || {}; }

/** Has this conversation anything in it a new project would be mixed into? */
function untouched(app) {
  const s = app.session;
  if (s.cowork) return false;
  const said = (s.messages || []).some((m) => m && m.role !== 'system' && String(m.content || '').trim());
  const edits = app.checkpoints && app.checkpoints.entries && app.checkpoints.entries.length;
  return !said && !(s.turns || []).length && !edits;
}

/**
 * OPEN A FOLDER AS THE IDE'S PROJECT.
 *
 * The existing verbs decide everything: the SAME project already attached is
 * a no-op; an untouched engineering session attaches it in place
 * (`/api/project/attach`); anything else — a conversation with history, a
 * Cowork session, a different project — gets a NEW engineering session on
 * that folder (`/api/session/new`), because mixing two projects into one
 * conversation is exactly what attach refuses.
 */
async function openProject(app, dir) {
  const sv = require('../sessionviews');
  const chk = sv.checkRoot(dir);
  if (!chk.ok) return bad(chk.why);
  const s = app.session;
  const cur = s.cowork ? null : sv.project(s);
  if (cur && cur.attached && path.resolve(cur.root).toLowerCase() === chk.root.toLowerCase()) {
    return ok({ id: s.id, project: cur, reused: true });
  }
  const running = Boolean(app.abort && !app.abort.signal.aborted);
  if (!running && untouched(app)) {
    const r = await require('./viewroutes').ROUTES['POST /api/project/attach'](app, { path: chk.root });
    if (r.body && r.body.ok) return ok({ id: s.id, project: r.body.project, attached: true });
  }
  const made = await require('./sessionroutes').ROUTES['POST /api/session/new'](app, { lane: 'engineering', project: chk.root });
  if (!made.body || !made.body.ok) return made;
  return ok({ id: made.body.id, project: made.body.project, created: true });
}

/** A folder name a person typed, refused if it could escape its parent. */
function folderName(name) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, why: 'name the project' };
  if (n.length > 120) return { ok: false, why: 'a project name is at most 120 characters' };
  if (/[<>:"/\\|?*]/.test(n) || n === '.' || n === '..' || /[. ]$/.test(n)) {
    return { ok: false, why: 'a project name cannot contain < > : " / \\ | ? * or end with a dot or space' };
  }
  return { ok: true, name: n };
}

/** The configured MCP servers, plus LAIN's own Computer MCP. Never connects one. */
function mcpServers(app) {
  const out = [];
  const cm = require('../computermcp').existing(app);
  const st = cm ? cm.status() : null;
  out.push({
    id: 'computer',
    name: 'Computer',
    builtIn: true,
    transport: 'stdio',
    enabled: process.platform === 'win32',
    state: st ? (st.connected ? 'CONNECTED' : 'DISCONNECTED') : 'NOT_STARTED',
    why: st ? st.why : (process.platform === 'win32' ? 'starts when Noema is asked to use the computer' : 'Windows only'),
    authorized: st ? Boolean(st.authorized) : false,
    tools: st ? (st.capabilities || []) : [],
    // WHO CAN CALL IT: the `computer` tool is offered to any turn — the BOT's
    // and the Coding Agent's alike — while this transport is live. See
    // tools/index.js `active`.
    usedBy: st && st.connected ? ['BOT', 'Coding Agent'] : [],
  });
  const cfg = cfgOf(app);
  const live = require('../mcp').settings(cfg);
  for (const s of require('../mcp').servers(cfg)) {
    out.push({
      id: s.id,
      name: s.name,
      builtIn: false,
      transport: 'stdio',
      enabled: s.enabled,
      // THE PROGRAM, NOT ITS ARGUMENTS OR ENVIRONMENT — either can carry a token.
      command: path.basename(String(s.command[0] || '')),
      state: !s.enabled ? 'DISABLED' : (live && live.id === s.id ? 'ACTIVE_BRIDGE' : 'CONFIGURED'),
      why: !s.enabled ? 'switched off in config' : (live && live.id === s.id ? 'the desktop bridge Noema talks to' : 'configured; one bridge is connected at a time'),
      tools: [],
      usedBy: live && live.id === s.id ? ['BOT', 'Coding Agent'] : [],
    });
  }
  return out;
}

const ROUTES = {
  'POST /api/accounts': async (app) => ok(await require('./accounts').read(app)),

  'POST /api/accounts/refresh': async (app, body = {}) => ok(await require('./accounts').refresh(app, { force: Boolean(body.force) })),

  // ADD / TEST / REMOVE a provider route (accountops.js). The key travels in
  // once, is proven, and only its shape ever comes back.
  'POST /api/accounts/choices': async (app) => ok({ providers: require('./accountops').choices(app) }),
  'POST /api/accounts/addkey': async (app, body = {}) => reply(await require('./accountops').addKey(app, body)),
  'POST /api/accounts/test': async (app, body = {}) => reply(await require('./accountops').test(app, body)),
  'POST /api/accounts/remove': async (app, body = {}) => reply(require('./accountops').remove(app, body)),

  'POST /api/mcp/servers': async (app) => ok({ servers: mcpServers(app) }),

  // THERE IS NO SKILL LOADER IN THIS BUILD, and the answer says so rather than
  // the window drawing an empty list that reads as "you have none installed".
  'POST /api/skills': async (app) => ok({ supported: true, skills: require('../integrations').listSkills(app), why: '' }),

  'POST /api/project/open': async (app, body = {}) => openProject(app, body.path),

  'POST /api/project/create': async (app, body = {}) => {
    const sv = require('../sessionviews');
    const parent = sv.checkRoot(body.parent);
    if (!parent.ok && !/drive root/.test(parent.why)) return bad(parent.why);
    const parentDir = parent.ok ? parent.root : path.resolve(String(body.parent));
    const nm = folderName(body.name);
    if (!nm.ok) return bad(nm.why);
    const dir = path.join(parentDir, nm.name);
    if (fs.existsSync(dir)) {
      let empty = false;
      try { empty = fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0; } catch { empty = false; }
      if (!empty) return bad(`${dir} already exists — use Open Project for an existing folder`, 409);
    } else {
      try { fs.mkdirSync(dir, { recursive: false }); } catch (e) { return bad(`could not create ${dir}: ${(e && e.message) || e}`); }
    }
    // FROM CHAT (`attach: true`): the SAME session is bound to the new folder — the
    // conversation is not duplicated into a new session (Phase 8 project attachment).
    if (body.attach === true) return require('./viewroutes').ROUTES['POST /api/project/attach'](app, { path: dir });
    return openProject(app, dir);
  },
};

module.exports = { ROUTES, openProject, mcpServers, folderName };
