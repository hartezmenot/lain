'use strict';

/**
 * ONE ENGINEERING SESSION, TWO VIEWS — Chat and Coding.
 *
 * ------------------------------------------------------------------------
 * THEY ARE NOT TWO SESSIONS.
 *
 *     EngineeringSession
 *     ├── project, goal, accepted plan, evidence, project intelligence   (shared)
 *     ├── Chat thread    — its own model/source, never mutates
 *     └── Coding thread  — its own model, governed by the usual authority
 *
 * The session file is still one file with one `messages` array. Each message
 * carries `thread`, and the WIRE for a turn is that thread's messages only
 * (contextfit.buildWire). That is how a Chat model on ChatGPT.com and a Coding
 * model on GLM share a project without the Coding model being handed the whole
 * Chat transcript: what crosses between them is the DURABLE state — goal,
 * accepted plan, pins, evidence — never the other thread's conversation.
 *
 * UNTAGGED MEANS CODING. Every message written before views existed, and every
 * message a terminal turn writes, is engineering history, and that is the
 * thread it has always been. `settle` tags a message the first time a wire is
 * built after it was written, with the thread the running turn belongs to, so
 * no push site in turn.js or chatdispatch.js has to know views exist.
 *
 * ------------------------------------------------------------------------
 * WHAT ELSE LIVES HERE, because each is a fact about THIS session's views and
 * nothing else owns it:
 *
 *   active     which view the session was last shown in
 *   coding     the Coding model, when it differs from the process default.
 *              The Chat model is modelsource/sessionstate's (chatSource +
 *              sourceSelections) and is not duplicated here.
 *   panel      the contextual workspace panel: which one is open, its width,
 *              and the file Project Files was showing
 *   pins       files the person pinned to context (browsing is not pinning)
 *   project    whether a project is ATTACHED, as opposed to a cwd inherited
 *              from wherever LAIN happened to be started
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const VIEW = Object.freeze({ CHAT: 'chat', CODING: 'coding' });

/** The contextual workspace resources a Coding view can open. One at a time. */
const PANEL = Object.freeze({
  NONE: 'NONE',
  PROJECT_FILES: 'PROJECT_FILES',
  CHANGES: 'CHANGES',
  PLAN: 'PLAN',
  TERMINAL: 'TERMINAL',
  WORKSHOP: 'WORKSHOP',
  VERIFICATION: 'VERIFICATION',
});

/** Pins are emphasis, not a second context window. */
const MAX_PINS = 12;
const PIN_EXCERPT_CHARS = 4000;
const PIN_EXCERPT_LINES = 120;

function defaults() {
  return {
    active: VIEW.CODING,
    coding: { model: null, connection: null },
    panel: { open: PANEL.NONE, width: null, file: null },
    pins: [],
    project: { attached: null, attachedAt: null },
  };
}

function attach(session) {
  session.views = defaults();
  return session;
}

function toJSON(session) {
  const v = (session && session.views) || defaults();
  return {
    views: {
      active: v.active,
      coding: { model: v.coding.model || null, connection: v.coding.connection || null },
      panel: { open: v.panel.open, width: v.panel.width, file: v.panel.file },
      pins: (v.pins || []).slice(0, MAX_PINS),
      project: { attached: v.project.attached, attachedAt: v.project.attachedAt || null },
    },
  };
}

function restore(session, data = {}) {
  const d = (data && data.views && typeof data.views === 'object') ? data.views : {};
  const v = defaults();
  if (d.active === VIEW.CHAT) v.active = VIEW.CHAT;
  if (d.coding && typeof d.coding === 'object') {
    v.coding.model = typeof d.coding.model === 'string' ? d.coding.model : null;
    v.coding.connection = typeof d.coding.connection === 'string' ? d.coding.connection : null;
  }
  if (d.panel && typeof d.panel === 'object') {
    v.panel.open = PANEL[d.panel.open] ? d.panel.open : PANEL.NONE;
    v.panel.width = Number.isFinite(d.panel.width) ? d.panel.width : null;
    v.panel.file = typeof d.panel.file === 'string' ? d.panel.file : null;
  }
  if (Array.isArray(d.pins)) v.pins = d.pins.filter((p) => p && typeof p.path === 'string').slice(0, MAX_PINS);
  if (d.project && typeof d.project === 'object') {
    v.project.attached = typeof d.project.attached === 'boolean' ? d.project.attached : null;
    v.project.attachedAt = d.project.attachedAt || null;
  }
  session.views = v;
  return session;
}

function views(session) {
  if (!session.views) attach(session);
  return session.views;
}

// ------------------------------------------------------------- threads --

/** Which thread a message belongs to. Untagged is engineering history. */
function threadOf(m) {
  return m && m.thread === VIEW.CHAT ? VIEW.CHAT : VIEW.CODING;
}

/** The thread the turn now running belongs to. A terminal turn is Coding. */
function current(session) {
  return session && session.thread === VIEW.CHAT ? VIEW.CHAT : VIEW.CODING;
}

/** Tag every untagged message with a thread. Idempotent and cheap. */
function settle(session, thread = current(session)) {
  const msgs = (session && session.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || typeof m !== 'object') continue;
    if (m.thread) break;   // everything older was settled already
    m.thread = thread;
  }
}

/**
 * THE MESSAGES A TURN'S WIRE CARRIES — its own thread's.
 *
 * A tool call and its result are always written by the same turn, so a thread
 * filter can never split a call from its result.
 */
function wireMessages(session) {
  const msgs = (session && session.messages) || [];
  // A SESSION THAT HAS NEVER HAD A CHAT TURN IS UNTOUCHED — no tags written,
  // no filter applied — so a terminal-only session behaves bit-for-bit as it
  // always did.
  if (!msgs.some((m) => m && m.thread === VIEW.CHAT) && current(session) === VIEW.CODING) return msgs;
  settle(session);
  const want = current(session);
  return msgs.filter((m) => threadOf(m) === want);
}

// -------------------------------------------------------------- models --

/**
 * THE CONFIG A TURN RUNS WITH — the process config, with this view's model.
 *
 * The process config is shared by every live session (sessionpool.js), so a
 * per-view model can never be written into it; it is overlaid here, per turn,
 * on a copy. Chat on LAIN's runtime uses the runtime selection the Chat source
 * picker stored; Coding uses its own. Neither changes the other.
 */
function turnCfg(app, session) {
  const cfg = { ...app.cfg, _evidence: app.connectionEvidence };
  const s = session || app.session;
  // THE EXECUTION PROFILE rides the turn config: the context budget reads it (profile.js).
  cfg.executionProfile = require('./profile').of(s, app.cfg);
  if (!s) return cfg;
  if (current(s) === VIEW.CHAT) {
    const pick = (s.sourceSelections || {}).lain;
    if (pick) cfg.model = pick;
    return cfg;
  }
  const v = views(s);
  if (v.coding.model) {
    cfg.model = v.coding.model;
    if (v.coding.connection) cfg.connection = v.coding.connection;
  }
  return cfg;
}

// ------------------------------------------------------------ projects --

/**
 * DIRECTORIES THAT ARE LAIN, NOT A PROJECT.
 *
 * A session inheriting one of these as its cwd — because LAIN.exe was started
 * from its install folder — is a session with NO project, and Project Files
 * must say so rather than offering LAIN's own tree as "the source".
 */
function lainOwnDirs() {
  const out = [path.join(__dirname, '..'), os.homedir()];
  try { out.push(require('./config').configDir()); } catch { /* none */ }
  try { out.push(require('./desktop').homeDir()); } catch { /* none */ }
  return out.map((d) => path.resolve(d).toLowerCase());
}

/** The empty directory an unattached session works in. Never a real tree. */
function unattachedDir() {
  const dir = path.join(require('./config').configDir(), 'no-project');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported by the tools */ }
  return dir;
}

/**
 * IS A PROJECT ATTACHED?
 *
 * Explicit wins. A session from before views existed is attached when its cwd
 * is a directory that is not LAIN's own and not the placeholder.
 */
function project(session) {
  const v = views(session);
  const root = session.cwd || '';
  let exists = false;
  try { exists = Boolean(root) && fs.statSync(root).isDirectory(); } catch { exists = false; }
  const own = lainOwnDirs().includes(path.resolve(root || '.').toLowerCase())
    || path.resolve(root || '.').toLowerCase() === path.resolve(path.join(require('./config').configDir(), 'no-project')).toLowerCase();
  const attached = v.project.attached === null ? (exists && !own) : (v.project.attached && !own);
  return {
    attached,
    root: attached ? root : null,
    name: attached ? path.basename(root) : null,
    missing: attached && !exists,
    attachedAt: v.project.attachedAt || null,
  };
}

/** Validate a directory a person chose. */
function checkRoot(dir) {
  const want = String(dir || '').trim();
  if (!want) return { ok: false, why: 'no folder was given' };
  if (!path.isAbsolute(want)) return { ok: false, why: 'give the full path to the project folder' };
  let st;
  try { st = fs.statSync(want); } catch { return { ok: false, why: `no folder at ${want}` }; }
  if (!st.isDirectory()) return { ok: false, why: `${want} is a file, not a folder` };
  const abs = path.resolve(want);
  if (lainOwnDirs().includes(abs.toLowerCase())) return { ok: false, why: `${abs} is LAIN's own folder, not a project` };
  if (path.parse(abs).root.toLowerCase() === abs.toLowerCase()) return { ok: false, why: 'a drive root is not a project' };
  return { ok: true, root: abs };
}

// ---------------------------------------------------------------- pins --

function pin(session, rel, { from = null, to = null } = {}) {
  const v = views(session);
  const p = String(rel || '').replace(/\\/g, '/');
  if (!p) return { ok: false, why: 'no file given' };
  const range = Number.isInteger(from) && Number.isInteger(to) && from > 0 && to >= from ? { from, to } : null;
  v.pins = v.pins.filter((x) => !(x.path === p && JSON.stringify(x.range || null) === JSON.stringify(range)));
  if (v.pins.length >= MAX_PINS) return { ok: false, why: `at most ${MAX_PINS} pins — unpin one first` };
  v.pins.push({ path: p, range, at: Date.now() });
  return { ok: true, pins: v.pins };
}

function unpin(session, rel) {
  const v = views(session);
  const p = String(rel || '').replace(/\\/g, '/');
  const before = v.pins.length;
  v.pins = v.pins.filter((x) => x.path !== p);
  return { ok: true, removed: before - v.pins.length, pins: v.pins };
}

/**
 * THE PINNED EXCERPTS, bounded — what "emphasized" means on the wire.
 * Read at prompt time from disk, so an edit since pinning is what is sent.
 */
function pinnedContext(session) {
  const v = views(session);
  if (!v.pins.length || !session.cwd) return '';
  const out = ['# Pinned by the user', 'The person pinned these to emphasize them. They are current file contents, bounded.'];
  for (const p of v.pins) {
    const abs = path.resolve(session.cwd, p.path);
    const rel = path.relative(path.resolve(session.cwd), abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { out.push(`\n## ${p.path}\n(unreadable now)`); continue; }
    let lines = text.split('\n');
    const start = p.range ? p.range.from : 1;
    if (p.range) lines = lines.slice(p.range.from - 1, p.range.to);
    const clipped = lines.slice(0, PIN_EXCERPT_LINES).join('\n').slice(0, PIN_EXCERPT_CHARS);
    out.push(`\n## ${p.path}${p.range ? `:${p.range.from}-${p.range.to}` : ''} (from line ${start})\n\`\`\`\n${clipped}\n\`\`\``);
  }
  return out.join('\n');
}

// --------------------------------------------------------------- panel --

/**
 * OPEN, CLOSE OR TOGGLE THE WORKSPACE PANEL. Pure state: nothing is launched,
 * navigated or stopped because a panel changed.
 */
function panel(session, { action = 'toggle', panel: which = null, width = null, file } = {}) {
  const v = views(session);
  const want = which && PANEL[which] ? which : null;
  if (action === 'close') v.panel.open = PANEL.NONE;
  else if (action === 'open') {
    if (!want || want === PANEL.NONE) return { ok: false, why: `open which panel? (${Object.keys(PANEL).join(', ')})` };
    v.panel.open = want;
  } else if (action === 'toggle') {
    if (!want || want === PANEL.NONE) return { ok: false, why: 'toggle which panel?' };
    v.panel.open = v.panel.open === want ? PANEL.NONE : want;
  } else if (action !== 'set') {
    return { ok: false, why: `unknown panel action "${action}"` };
  }
  if (width != null) {
    const w = Number(width);
    if (!Number.isFinite(w) || w < 240 || w > 2400) return { ok: false, why: 'width must be between 240 and 2400 pixels' };
    v.panel.width = Math.round(w);
  }
  if (file !== undefined) v.panel.file = file ? String(file).replace(/\\/g, '/') : null;
  return { ok: true, panel: { ...v.panel } };
}

module.exports = {
  VIEW, PANEL, MAX_PINS,
  attach, toJSON, restore, views,
  threadOf, current, settle, wireMessages, turnCfg,
  project, checkRoot, lainOwnDirs, unattachedDir,
  pin, unpin, pinnedContext, panel,
};
