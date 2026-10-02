'use strict';

/**
 * THE HOUSE DOORS — the capabilities through which the BOT, the hover menus
 * and every surface move through LAIN.
 *
 * ------------------------------------------------------------------------
 * ONE REGISTRY, THREE KINDS OF DOOR.
 *
 *   navigate   the window goes somewhere: a view, a section, a file, a flow
 *              the PERSON completes (Add API key opens the dialog; the key is
 *              typed by the person, never by the BOT). Core validates the
 *              arguments and records `_uiNavigate` with the capability id;
 *              the window runs the SAME handler its own menus run
 *              (page/pagehouse.js). Nothing is changed by opening a door.
 *   read       answered here, from the owner: the IDE's diagnostics and
 *              selection (idecontext.js), the task (journey.js), who changed
 *              what (editledger.js), sessions (sessionindex.js).
 *   change     a LAIN SETTING the person asked for, done through its owner —
 *              `model.assign` is modelinventory.select, the same call the
 *              model pickers make. Reversible, visible in MODEL at once, and
 *              never a file: the BOT's read-only rule is about the project,
 *              and nothing here writes to it.
 *
 * The BOT does not click the DOM and does not keep its own copy of any of
 * these systems: it asks for a door by id (tools/lainself.js, action "do").
 */

const path = require('path');

const KIND = Object.freeze({ NAVIGATE: 'navigate', READ: 'read', CHANGE: 'change' });

function str(v, n = 300) { return v == null ? '' : String(v).slice(0, n); }

/** Record a navigation for the window to apply once (state.js → `navigate`). */
function go(app, capability, surface, section = null, args = {}) {
  const root = app._sibling || app;
  const prev = root._uiNavigate;
  root._uiNavigate = { seq: (prev && prev.seq ? prev.seq : 0) + 1, capability, surface, section, args, at: Date.now() };
  try { require('./journey').note(app.session, require('./journey').EVENT.CAPABILITY, { capability }); } catch { /* the path is a record, not a gate */ }
  let windows = 0;
  try { windows = require('./harnessapp/ipc').status().clients; } catch { windows = 0; }
  return { ok: true, windows, navigated: { surface, section } };
}

function attachedRoot(app) {
  try {
    const p = require('./sessionviews').project(app.session);
    return p.attached && !p.missing ? app.session.cwd : null;
  } catch { return null; }
}

/** A project-relative path that stays inside the project, or null. */
function insideProject(app, rel) {
  const root = attachedRoot(app);
  if (!root || !rel) return null;
  const abs = path.resolve(root, String(rel));
  const back = path.relative(root, abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
  return { root, abs, rel: back.split(path.sep).join('/') };
}

/** Find a file by name or partial path in the project index. */
function findFile(app, query) {
  const root = attachedRoot(app);
  if (!root) return { ok: false, why: 'no project is open — open one in the IDE first' };
  const q = str(query).replace(/\\/g, '/').trim();
  if (!q) return { ok: false, why: 'which file?' };
  const direct = insideProject(app, q);
  if (direct && require('fs').existsSync(direct.abs)) return { ok: true, path: direct.rel };
  let idx;
  try { idx = require('./projectindex').fresh(root, { persist: false }).index; } catch { idx = null; }
  const files = Object.keys((idx && idx.files) || {});
  const lower = q.toLowerCase();
  const hits = files.filter((f) => f.toLowerCase() === lower || f.toLowerCase().endsWith(`/${lower}`));
  const loose = hits.length ? hits : files.filter((f) => path.posix.basename(f).toLowerCase().includes(lower));
  if (!loose.length) return { ok: false, why: `no file in the project matches "${q}"` };
  if (loose.length > 1 && !hits.length) return { ok: false, why: `several files match "${q}": ${loose.slice(0, 6).join(', ')}`, candidates: loose.slice(0, 12) };
  return { ok: true, path: loose.sort((a, b) => a.length - b.length)[0], others: loose.length - 1 };
}

// ---- the doors -------------------------------------------------------------------

const DOORS = [
  // IDE /focus
  {
    id: 'ide.enter_focus', kind: KIND.NAVIGATE, what: 'enter the IDE (/focus) with the current task and its relevant files',
    // A SURFACE TRANSFER, recorded as one (planhandoff.js): the same task moves to the IDE.
    run: (app) => {
      const root = app._sibling || app;
      const from = root._surface ? root._surface.surface : null;
      try { require('./planhandoff').transfer(app, { kind: 'surface', from: from || 'chat', to: 'ide', text: 'continue in /focus', reason: 'opened in /focus', state: 'DONE' }); } catch { /* the move still happens */ }
      return go(app, 'ide.enter_focus', 'ide');
    },
  },
  {
    id: 'ide.open_project', kind: KIND.NAVIGATE, what: 'open a project folder in the IDE (args: path)',
    run: (app, a) => {
      const dir = str(a.path, 1000);
      if (!dir || !path.isAbsolute(dir)) return { ok: false, why: 'give the project folder as an absolute path, or use recent projects' };
      try { if (!require('fs').statSync(dir).isDirectory()) return { ok: false, why: `${dir} is not a folder` }; } catch { return { ok: false, why: `${dir} does not exist` }; }
      return go(app, 'ide.open_project', 'ide', null, { path: dir });
    },
  },
  {
    id: 'ide.open_file', kind: KIND.NAVIGATE, what: 'open a project file in the IDE editor (args: path or name, optional line)',
    run: (app, a) => {
      const f = findFile(app, a.path || a.name);
      if (!f.ok) return f;
      return go(app, 'ide.open_file', 'ide', null, { path: f.path, line: Number(a.line) || null });
    },
  },
  {
    id: 'ide.open_symbol', kind: KIND.NAVIGATE, what: 'open where a symbol is declared (args: name)',
    run: (app, a) => {
      const root = attachedRoot(app);
      if (!root) return { ok: false, why: 'no project is open' };
      const name = str(a.name, 120).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) return { ok: false, why: 'give a symbol name' };
      const idx = require('./projectindex').fresh(root, { persist: false }).index;
      const defs = require('./projectindex').definitionsOf(idx, name);
      if (!defs.length) return { ok: false, why: `no declaration of ${name} in the project index` };
      const d = defs[0];
      const out = go(app, 'ide.open_symbol', 'ide', null, { path: d.file, line: d.line || null, name });
      return { ...out, declared: defs.slice(0, 6).map((x) => `${x.file}:${x.line || '?'}`) };
    },
  },
  { id: 'ide.show_problems', kind: KIND.NAVIGATE, what: 'show the Problems panel in the IDE', run: (app) => go(app, 'ide.show_problems', 'ide') },
  { id: 'ide.new_project', kind: KIND.NAVIGATE, what: 'start the New Project flow (the person chooses where)', run: (app) => go(app, 'ide.new_project', 'ide') },
  { id: 'ide.get_selection', kind: KIND.READ, what: 'the selection and file in front in the IDE', run: (app) => readIde(app, 'selection') },
  { id: 'ide.get_diagnostics', kind: KIND.READ, what: 'errors and warnings the IDE reported for the open files', run: (app) => readIde(app, 'diagnostics') },
  { id: 'ide.get_terminal_context', kind: KIND.READ, what: 'the last output of the IDE terminal', run: (app) => readIde(app, 'terminal') },

  // CHAT
  { id: 'chat.open', kind: KIND.NAVIGATE, what: 'show Chat', run: (app) => go(app, 'chat.open', 'chat') },
  { id: 'chat.new', kind: KIND.NAVIGATE, what: 'start a new Chat conversation', run: (app) => go(app, 'chat.new', 'chat') },

  // MODEL
  { id: 'model.open', kind: KIND.NAVIGATE, what: 'open the Model view (args: section: providers | roles)', run: (app, a) => go(app, 'model.open', 'model', str(a.section, 30) || null) },
  { id: 'model.add_api_key', kind: KIND.NAVIGATE, what: 'open the Add API key dialog (the person types the key there)', run: (app, a) => go(app, 'model.add_api_key', 'model', 'providers', { provider: str(a.provider, 40) || null }) },
  { id: 'model.add_account', kind: KIND.NAVIGATE, what: 'open the account connection choices in Model', run: (app) => go(app, 'model.add_account', 'model', 'providers') },
  { id: 'model.refresh', kind: KIND.NAVIGATE, what: 'refresh the model lists in Model', run: (app) => go(app, 'model.refresh', 'model', 'providers') },
  { id: 'model.get_usage', kind: KIND.READ, what: 'model roles, providers and the usage each provider reported', run: async (app) => ({ ok: true, text: await require('./tools/lainself').describe(app, 'quota') }) },
  {
    id: 'model.assign', kind: KIND.CHANGE, what: 'assign a model to a role (args: role "coding" or "bot", model: a name to search for)',
    run: (app, a) => assign(app, a),
  },

  // BOT
  { id: 'bot.add_telegram', kind: KIND.NAVIGATE, what: 'open the Telegram connection flow in Bot', run: (app) => go(app, 'bot.add_telegram', 'bot', 'connections', { platform: 'telegram' }) },
  { id: 'bot.add_whatsapp', kind: KIND.NAVIGATE, what: 'open the WhatsApp setup in Bot', run: (app) => go(app, 'bot.add_whatsapp', 'bot', 'connections', { platform: 'whatsapp' }) },
  { id: 'bot.open_settings', kind: KIND.NAVIGATE, what: 'open Bot settings', run: (app) => go(app, 'bot.open_settings', 'bot', null) },

  // SESSION
  { id: 'session.search', kind: KIND.READ, what: 'find sessions (args: query, or when: today | yesterday)', run: (app, a) => sessions(app, a) },
  {
    id: 'session.open', kind: KIND.NAVIGATE, what: 'show a session in the Session view (args: id, or query / when: yesterday)',
    run: (app, a) => {
      const r = sessions(app, a);
      if (!r.ok) return r;
      if (!r.rows.length) return { ok: false, why: `no session matches${a.when ? ` ${a.when}` : ''}${a.query ? ` "${a.query}"` : ''}` };
      const pick = a.id ? r.rows[0] : r.rows[0];
      const out = go(app, 'session.open', 'session', null, { id: pick.id });
      return { ...out, opened: pick, others: r.rows.slice(1, 6) };
    },
  },

  // SETTINGS
  { id: 'settings.open', kind: KIND.NAVIGATE, what: 'open Settings (args: section: mcp | skills | editor | notifications | privacy | paths)', run: (app, a) => go(app, 'settings.open', 'settings', str(a.section, 30) || null) },
  { id: 'settings.open_mcp', kind: KIND.NAVIGATE, what: 'open Settings › MCP', run: (app) => go(app, 'settings.open_mcp', 'settings', 'mcp') },
  { id: 'settings.open_skills', kind: KIND.NAVIGATE, what: 'open Settings › Skills', run: (app) => go(app, 'settings.open_skills', 'settings', 'skills') },

  // THE TASK AND THE AGENT
  { id: 'task.status', kind: KIND.READ, what: 'the current task, what the Coding Agent carries, and the path the work took', run: (app) => taskStatus(app) },
  { id: 'changes.who', kind: KIND.READ, what: 'who changed what in this project: the person (USER), LAIN\'s Agent (AGENT), or outside LAIN (args: optional path — who wrote which lines of that file)', run: (app, a) => whoChanged(app, a) },

  // /focus — the Focus capabilities (the palette's "LAIN:" commands, the BOT, the menus: one door each)
  {
    id: 'focus.context', kind: KIND.READ, what: 'what the Coding Agent would be handed for a request about the current selection: the focused context packet, computed, not sent (args: optional task)',
    run: async (app, a) => {
      if (!attachedRoot(app)) return { ok: false, why: 'no project is open' };
      const pk = await require('./focuspacket').build(app, app.session, { task: str(a.task, 2000) || 'the current selection' });
      return pk ? { ok: true, text: pk.text, metrics: pk.metrics } : { ok: false, why: 'no focused context could be built' };
    },
  },
  { id: 'focus.pick_element', kind: KIND.NAVIGATE, what: 'open the preview and start picking an element (the person clicks it; LAIN opens the code that owns it)', run: (app) => go(app, 'focus.pick_element', 'ide') },
  { id: 'focus.ask_bot', kind: KIND.NAVIGATE, what: 'ask the BOT about the current selection (opens the BOT pane with the selection attached)', run: (app) => go(app, 'focus.ask_bot', 'ide') },
  { id: 'focus.move_to_agent', kind: KIND.NAVIGATE, what: 'switch /focus to the Coding Agent pane (the same task and session)', run: (app) => go(app, 'focus.move_to_agent', 'ide') },
  {
    id: 'lsp.restart', kind: KIND.CHANGE, what: 'restart the language server for a file\'s language (args: path, or id of the server)',
    run: async (app, a) => {
      const lsp = require('./lsp/manager');
      let id = str(a.id, 40);
      if (!id && a.path) { const c = lsp.coverage(app, str(a.path, 300)); if (!c.available) return { ok: false, why: c.why }; id = c.id; }
      if (!id) return { ok: false, why: 'give the file (path) or the server (id)' };
      const r = await lsp.restart(app, id);
      return r && r.ok ? { ok: true, text: `restarted ${id}` } : { ok: false, why: (r && r.why) || `could not restart ${id}` };
    },
  },
  {
    // ASKED FOR, NEVER INJECTED: the paused debugger state, compact (dap/manager.js context).
    id: 'debug.context', kind: KIND.READ, what: 'the paused debugger state, when the program is paused: why it stopped, where, the call stack, the frame\'s variables and the source lines around it',
    run: (app) => require('./dap/manager').context(app),
  },
  {
    id: 'project.reconcile', kind: KIND.READ, what: 'compare the recorded architecture with what is on disk now (missing, damaged, drifted components)',
    run: (app) => {
      const root = attachedRoot(app);
      if (!root) return { ok: false, why: 'no project is open' };
      const rc = require('./reconcile');
      const m = require('./architecture').load(root);
      const report = rc.run(root, { model: m });
      return { ok: true, text: rc.say(m, report) || `checked ${report.checked} component(s): nothing missing, damaged or drifted`, counts: { checked: report.checked, missing: report.missing, damaged: report.damaged } };
    },
  },
  // THE ASSISTANT (assistant/doors.js): the one task store, with its own validation and channel permissions.
  ...require('./assistant/doors').DOORS(KIND, go),
];

const BY_ID = new Map(DOORS.map((d) => [d.id, d]));

/** The list the BOT is shown. */
function list() { return DOORS.map((d) => ({ id: d.id, kind: d.kind, what: d.what })); }

async function run(app, id, args = {}) {
  const d = BY_ID.get(String(id || ''));
  if (!d) return { ok: false, why: `no capability "${id}" — ask for the list` };
  try {
    const r = await d.run(app, args && typeof args === 'object' ? args : {});
    return { kind: d.kind, ...r };
  } catch (e) {
    return { ok: false, why: (e && e.message) || String(e) };
  }
}

// ---- reads ---------------------------------------------------------------------

function readIde(app, what) {
  const c = app.session && app.session._ide;
  if (!c) return { ok: true, text: 'The IDE has not reported anything in this session (it reports while a project is open in the IDE).' };
  const age = Math.round((Date.now() - c.at) / 60000);
  if (what === 'selection') {
    // "THIS" IS THE CANONICAL SELECTION — the editor report only says where the caret is.
    let sel = null;
    try { sel = require('./harnesscontext').selection(app, app.session); } catch { sel = null; }
    if (sel && sel.source) return { ok: true, selection: sel.id, text: `selection ${sel.id}: ${sel.source.file || 'current file'} lines ${sel.source.startLine}-${sel.source.endLine} (project generation ${sel.projectGeneration}):\n${sel.source.text}` };
    if (sel && sel.visual) return { ok: true, selection: sel.id, text: `selection ${sel.id}: ${sel.visual.gugId ? `UI node ${sel.visual.gugId}` : sel.visual.selector || sel.kind}${sel.visual.binding ? ` → ${sel.visual.binding.file}:${sel.visual.binding.line}` : ''}` };
    return { ok: true, text: `No selection. File in front: ${c.file || 'none'}${c.cursor ? `, line ${c.cursor.line}` : ''}.` };
  }
  if (what === 'diagnostics') {
    const errs = c.diagnostics.filter((d) => d.severity === 'error');
    const lines = c.diagnostics.slice(0, 40).map((d) => `${d.severity.toUpperCase()} ${d.path}:${d.line}:${d.col} ${d.message}`);
    return { ok: true, text: `${errs.length} error(s), ${c.diagnostics.length - errs.length} other, in the open files (reported ${age} min ago)${lines.length ? `:\n${lines.join('\n')}` : '.'}` };
  }
  const t = require('./idecontext').terminalTail(app, c.terminal);
  return { ok: true, text: t && t.text.trim() ? `Terminal${t.alive ? '' : ' (shell exited)'}:\n${t.text}` : 'No terminal output.' };
}

function dayBounds(when) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (when === 'yesterday') return [d.getTime() - 86400000, d.getTime()];
  if (when === 'today') return [d.getTime(), d.getTime() + 86400000];
  return null;
}

function sessions(app, a = {}) {
  let rows = [];
  try { rows = require('./harnessapp/state').sessions(app, { limit: 200 }).engineering || []; } catch { rows = []; }
  const range = dayBounds(str(a.when, 20).toLowerCase());
  const q = str(a.query, 100).toLowerCase().trim();
  const id = str(a.id, 80);
  let out = rows;
  if (id) out = out.filter((r) => r.id === id || r.short === id);
  if (range) out = out.filter((r) => r.at && r.at >= range[0] && r.at < range[1]);
  if (q) out = out.filter((r) => `${r.title} ${r.project} ${r.cwd}`.toLowerCase().includes(q));
  out = out.slice().sort((x, y) => (y.at || 0) - (x.at || 0));
  return {
    ok: true,
    rows: out.slice(0, 12).map((r) => ({ id: r.id, title: r.title, project: r.project, at: r.at, current: r.current })),
    text: out.length ? out.slice(0, 12).map((r) => `${r.current ? '* ' : '  '}${r.title} — ${r.project || 'no project'} (${new Date(r.at || 0).toLocaleString()}) [${r.short}]`).join('\n') : 'no session matches',
  };
}

function taskStatus(app) {
  const sp = require('./journey').project(app);
  if (!sp) return { ok: true, text: 'no session' };
  const out = [];
  out.push(`Session ${sp.ids.session}${sp.project ? ` · project ${sp.project.name}` : ' · no project attached'}`);
  out.push(`Window: ${sp.surface ? `${sp.surface.surface}${sp.surface.pane ? ` (${sp.surface.pane} tab)` : ''}` : 'not reported'}`);
  if (sp.agentTask) {
    const t = sp.agentTask;
    out.push(`Coding Agent task ${t.id}: ${t.objective} — ${t.state}${t.origin ? `, began in ${t.origin}` : ''}${t.executor ? `, model ${t.executor.model}` : ''}${sp.agent.running ? ', RUNNING NOW' : ''}`);
    if (t.files.length) out.push(`  files it changed: ${t.files.join(', ')}`);
  } else out.push('The Coding Agent has not carried a task in this session.');
  if (sp.task && (!sp.agentTask || sp.task.id !== sp.agentTask.id)) out.push(`Current task ${sp.task.id}: ${sp.task.objective} — ${sp.task.state}`);
  if (sp.proposal) out.push(`Waiting for the person: move to Agent? — ${sp.proposal.task || sp.proposal.text}`);
  const ide = app.session._ide;
  if (ide && ide.tabs && ide.tabs.length) out.push(`IDE /focus: ${ide.tabs.length} file(s) open${ide.file ? `, ${ide.file} in front` : ''} (reported ${Math.round((Date.now() - ide.at) / 60000)} min ago)`);
  if (sp.route.length) out.push(`Path: ${sp.route.join(' → ')}`);
  return { ok: true, text: out.join('\n') };
}

function whoChanged(app, a = {}) {
  const root = attachedRoot(app);
  if (!root) return { ok: true, text: 'no project is open, so there is no change history to read' };
  // A FILE: who wrote which of its lines (the same regions the editor gutter draws).
  if (a.path) {
    const f = insideProject(app, a.path);
    if (!f) return { ok: false, why: 'that file is not inside the project' };
    const r = require('./editledger').regions(root, f.rel);
    const rows = (r.regions || []).map((g) => `  lines ${g.startLine}-${g.endLine}: ${g.source}${g.approximate ? ' (approximate)' : ''}`);
    return { ok: true, text: rows.length ? `${f.rel}:\n${rows.join('\n')}` : `${f.rel}: no change LAIN has recorded`, regions: r.regions || [] };
  }
  const who = str(a.source, 20).toUpperCase() || null;
  const r = require('./editledger').summary(root, { source: who, since: Number(a.since) || null, sessionId: a.session === 'this' ? app.session.id : null });
  return { ok: true, text: r.text, counts: r.counts };
}

async function assign(app, a = {}) {
  const role = str(a.role, 20).toLowerCase();
  const lane = role === 'coding' || role === 'agent' || role === 'coding_agent' ? 'coding' : role === 'bot' || role === 'chat' ? 'chat' : null;
  if (!lane) return { ok: false, why: 'role must be "coding" (the Coding Agent) or "bot"' };
  const q = str(a.model, 120).trim();
  if (!q) return { ok: false, why: 'which model? give a name to search for' };
  const inv = require('./modelinventory');
  const found = await inv.search(app, { lane, query: q, limit: 8 });
  const rows = (found.rows || []).filter((r) => r.modelId && (lane === 'coding' ? r.source === 'lain' : true));
  if (!rows.length) return { ok: false, why: `no configured model matches "${q}" — add an account or API key in Model first` };
  const exact = rows.filter((r) => [r.modelId, r.displayName].some((x) => String(x || '').toLowerCase() === q.toLowerCase()));
  const pick = exact[0] || rows[0];
  // A GUESS BETWEEN TWO REAL CANDIDATES IS NOT MADE: the person chooses.
  if (!exact.length && rows.length > 1 && !String(pick.displayName || pick.modelId).toLowerCase().includes(q.toLowerCase())) {
    return { ok: false, why: `"${q}" is ambiguous`, candidates: rows.slice(0, 6).map((r) => r.displayName || r.modelId) };
  }
  const r = await inv.select(app, { lane, source: pick.source || 'lain', modelId: pick.modelId, connectionId: pick.connectionId || null });
  if (!r.ok) return r;
  try { app.session.save(); } catch { /* the selection still holds for this run */ }
  try { require('./journey').note(app.session, require('./journey').EVENT.CAPABILITY, { capability: 'model.assign', role: lane, model: pick.modelId }); } catch { /* record only */ }
  return { ok: true, text: `${lane === 'coding' ? 'Coding Agent' : 'BOT'} model is now ${pick.displayName || pick.modelId} (this session). MODEL, IDE and Chat show the same assignment.`, selected: r.selected };
}

module.exports = { KIND, DOORS, list, run, findFile, sessions, taskStatus, go };
