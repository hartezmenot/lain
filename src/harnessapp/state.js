'use strict';

/** WHAT THE HARNESS APPLICATION IS TOLD — a read model, and nothing else. */

const path = require('path');

/** How many sessions a lane lists. A sidebar, not an archive browser. */
const SESSION_LIMIT = 40;
/** How many conversation turns the app is handed at once. */
const TURN_LIMIT = 200;
/** How much of one message body travels. The app renders prose, not a log. */
const MESSAGE_CHARS = 20_000;
/** The product line the window draws beside its name. Read once; it cannot change while Core runs. */
const PRODUCT = Object.freeze({ name: 'LAIN', version: (() => { try { return String(require('../../package.json').version); } catch { return ''; } })() });

/** WHICH LANE A SESSION BELONGS TO. */
function laneOf(data) {
  const c = data && data.cowork;
  return c && c.lane === 'cowork' ? 'cowork' : 'engineering';
}

/** THE SESSION LISTS, one per lane. */
function sessions(app, { limit = SESSION_LIMIT } = {}) {
  let rows = [];
  try {
    rows = require('../sessionindex').summaries({ limit: Math.min(limit, 200) }) || [];
  } catch { rows = []; }
  const current = app && app.session ? app.session.id : null;
  // WHAT EACH LIVE CONVERSATION IS DOING — the reason a person can leave a session and still know when it finished.
  let live = {};
  try { live = app.pool().statuses(); } catch { live = {}; }
  // A CONVERSATION YOU ARE IN IS ALWAYS IN THE LIST
  const known = new Set(rows.map((r) => r.id));
  for (const id of Object.keys(live)) {
    if (known.has(id)) continue;
    const held = (() => { try { return app.pool().live(id); } catch { return null; } })();
    if (!held) continue;
    try {
      // A session that has never been written has no mtime, and "now" is the
      // true answer for one that is open in front of you.
      const row = require('../sessionindex').describe(id, held.session.toJSON(), { mtimeMs: Date.now() });
      row.here = true;
      rows.unshift(row);
    } catch { /* a session that cannot describe itself is left to the next poll */ }
  }
  const out = { engineering: [], cowork: [] };
  // LAIN'S OWN FOLDERS AND THE NO-PROJECT PLACEHOLDER are not projects: a session there is Unassigned.
  let own = [];
  try { const sv = require('../sessionviews'); own = [...sv.lainOwnDirs(), path.resolve(sv.unattachedDir()).toLowerCase()]; } catch { own = []; }
  for (const s of rows) {
    const lane = laneOf(s.data || s);
    const entry = {
      id: s.id,
      short: s.short || (s.id || '').split('-').pop(),
      title: require('../sessionindex').headline(s),
      project: s.cwd ? path.basename(s.cwd) : '',
      assigned: Boolean(s.cwd) && !own.includes(path.resolve(s.cwd).toLowerCase()),
      cwd: s.cwd || '',
      when: s.when && s.when.text ? s.when.text : '',
      // WHEN IT WAS LAST TOUCHED, as a time — the Session view groups by day,
      // and a sentence like "2 hours ago" cannot be grouped.
      at: s.lastActivity || s.mtimeMs || null,
      turns: s.turns || 0,
      current: s.id === current,
      // LIVE IN THIS PROCESS, and what it is doing. `null` means it is a
      // transcript on disk and nothing more.
      live: Boolean(live[s.id]),
      // THE AUTHORITATIVE STATUS — one of the eight sessionstatus.js words, with its summary and clock.
      status: live[s.id] ? live[s.id].state : null,
      detail: live[s.id] ? live[s.id].detail : '',
      state: live[s.id] ? (live[s.id].status || null) : null,
      // REMOTE ORIGIN, and only when Astra actually recorded one. `harness`
      // means the person started it here; the rest name where it came from.
      source: lane === 'cowork' ? ((s.data && s.data.cowork && s.data.cowork.source) || 'harness') : null,
    };
    out[lane].push(entry);
  }
  return out;
}

/** COMPUTER MCP, or null when the desktop has never been connected. */
function computer(app) {
  const c = require('../computermcp').existing(app);
  if (!c) return null;
  const s = c.status();
  return {
    connected: s.connected,
    authorized: s.authorized,
    why: s.why,
    steps: s.steps.slice(-8),
    target: (s.permissions && s.permissions.target) || null,
  };
}

/** The conversation, as the application renders it. Bounded, and prose only. */
function conversation(session) {
  if (!session) return [];
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  const out = [];
  const first = Math.max(0, msgs.length - TURN_LIMIT);
  const role = session._role || null;
  const roleFrom = Number(session._roleFrom) || 0;
  for (let i = first; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.role === 'system') continue;
    // TOOL RESULTS ARE NOT CONVERSATION.
    if (m.role === 'tool') continue;
    const body = String(m.content || '');
    if (!body.trim()) continue;
    out.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: body.slice(0, MESSAGE_CHARS),
      at: m.ts || null,
      // WHICH VIEW'S THREAD — the Chat view renders `chat`, the Coding view the
      // rest. Untagged history is engineering history (sessionviews.threadOf).
      thread: require('../sessionviews').threadOf(m),
      // WHO ANSWERED, when it was not LAIN's own runtime. Stamped at execution
      // time by chatdispatch.js and carried on the message ever since.
      provenance: m.provenance ? { label: m.provenance.label, source: m.provenance.sourceId } : null,
      // WHICH ROLE, in the IDE: the BOT or the Coding Agent (botroute.js).
      by: m.by === 'bot' || m.by === 'agent' || m.by === 'handoff' ? m.by
        : (role && m.role === 'assistant' && i >= roleFrom ? role : null),
      // WHICH SUB-TAB (BOT | AGENT) a person's message went to, and from which
      // surface — Chat's agentic coding is shown in Chat and in the AGENT tab.
      to: m.to === 'agent' || m.to === 'bot' ? m.to : null,
      // THE FACT FOOTER (factfooter.js): what LAIN recorded during the turn, under its report.
      facts: m.role === 'assistant' && m.facts ? require('../factfooter').lines(m.facts) : null,
      via: m.via === 'chat' || m.via === 'ide' ? m.via
        : (role && m.role === 'assistant' && i >= roleFrom && (session._roleVia === 'chat' || session._roleVia === 'ide') ? session._roleVia : null),
    });
  }
  return out;
}

/** Files this session has actually changed, from the checkpoint ledger. */
function changes(app) {
  try {
    return require('../ui/panes')
      .changedFiles({ checkpoints: app.checkpoints, cwd: app.session.cwd })
      .map((f) => ({ path: f.rel, kind: f.kind, added: f.added, removed: f.removed }));
  } catch { return []; }
}

/** THE CHAT SOURCES, cheaply. */
async function sources(app) {
  try {
    const view = await require('../modelsource/registry').overview(app);
    return {
      selected: view.selected,
      sources: view.sources.map((s) => ({
        id: s.source,
        label: s.label,
        kind: s.kind,
        state: s.state,
        why: s.why || '',
        model: s.selected || null,
        chosen: Boolean(s.chosen),
        capabilities: s.capabilities || null,
      })),
    };
  } catch (e) {
    return { selected: 'lain', sources: [], why: (e && e.message) || String(e) };
  }
}

/** The Workshop, if one is open for this project. Never opens one. */
function workshop(app) {
  try {
    const ws = require('../workshop').forApp(app);
    const cwd = app.session.cwd;
    const live = ws.existing(cwd);
    const avail = ws.availability();
    return {
      available: Boolean(avail.available),
      why: avail.why || '',
      open: Boolean(live),
      url: live ? (live.url || null) : null,
      viewport: live ? (live.viewport || 'desktop') : null,
      observations: live ? ws.observations(cwd) : null,
      before: Boolean(ws.before(cwd, live ? live.viewport || 'desktop' : 'desktop')),
      // THE FRAME PREVIEW (the real frontend in the window): URL, shared viewport, page, capabilities — or null.
      frame: typeof ws.frameState === 'function' ? ws.frameState(cwd) : null,
      // THE DEV SERVER AS ITS OWN OBJECT — status from the process authority,
      // never inferred from whether a preview happens to be showing.
      devServer: require('./stateviews').devServer(app),
    };
  } catch (e) {
    return { available: false, why: (e && e.message) || String(e), open: false };
  }
}

/** THE ONE LIVE OPERATIONAL ROW, PROJECTED FOR THE FRONTEND. */
function execution(app) {
  const idle = { word: 'READY', detail: '', level: 'idle', spin: false, clock: null, alert: null };
  try {
    const ui = app.ui;
    // A CONVERSATION WITH NO TERMINAL
    if (!ui || !ui.enabled) {
      const st = require('../sessionpool').statusOf(app, Boolean(app.abort && !app.abort.signal.aborted));
      if (!st.notable) return idle;
      return { word: st.word, detail: st.detail, level: st.level, spin: st.spin, clock: null, alert: null };
    }
    const live = require('../ui/status').liveState(require('../ui/projection').statusState(ui));
    const rest = require('../ui/alert').resting(ui);
    return {
      word: live.word || 'READY',
      detail: live.detail || '',
      // The colour vocabulary is the strip's own — 'bad' and 'warn' are what
      // liveState emits — mapped once, here, to the two words this brief uses.
      level: live.colour === 'bad' ? 'red' : live.colour === 'warn' ? 'amber' : (live.spin ? 'working' : 'idle'),
      spin: Boolean(live.spin),
      clock: require('../ui/workclock').reading(ui.clock),
      // NULL WHEN NOTHING IS RESTING, so the frontend cannot render a stale
      // warning it was handed as an empty object.
      alert: rest.level ? { level: rest.level, word: rest.word, resumable: rest.resumable } : null,
    };
  } catch (e) {
    return { ...idle, detail: (e && e.message) || String(e) };
  }
}

/** WHERE THIS SESSION'S WORK RUNS, AND WHICH BROWSER RUNS IT. */
function environment(app) {
  try {
    const chromium = require('../env/chromium').forApp(app);
    const h = chromium.health();
    const task = (() => {
      try {
        const harness = require('../harnesslink').existing(app);
        const t = harness && harness.runtime && harness.runtime.latest ? harness.runtime.latest() : null;
        return (t && t.environment) || 'host';
      } catch { return 'host'; }
    })();
    const vm = require('../env/environments').parse(task);
    return {
      task,
      kind: vm.ok && vm.kind === 'vm' ? 'vm' : 'host',
      // VMware's real state is NOT polled — see the header. This says only
      // whether a VM environment is even registered, which is a config read.
      vms: require('../env/environments').list().filter((e) => e.kind === 'vm').length,
      browser: h.browser
        ? { version: h.browser.version, owned: h.browser.owned, source: h.browser.source }
        : null,
      why: h.available ? '' : h.why,
      running: (h.running || []).filter((i) => i.state === 'RUNNING').map((i) => i.purpose),
    };
  } catch (e) {
    return { task: 'host', kind: 'host', vms: 0, browser: null, why: (e && e.message) || String(e), running: [] };
  }
}

/** EVERYTHING THE APPLICATION POLLS FOR. */
async function read(app) {
  // A SESSION HANDED BACK FROM THE CLI is reloaded before it is drawn (surfacehandoff.js).
  try { require('../surfacehandoff').sync(app); } catch { /* drawn as it is */ }
  const s = app.session;
  const harness = (() => {
    try { return require('../harnesssurface').project(app); } catch { return null; }
  })();
  const goalText = (() => {
    try { return require('../goal').text(s); } catch { return ''; }
  })();
  const out = {
    at: Date.now(),
    // WHAT IS RUNNING — the product and its version, for the window's brand line.
    product: PRODUCT,
    // WHICH SESSION IS OPEN IN THE TERMINAL.
    current: {
      id: s.id,
      lane: laneOf(s),
      project: path.basename(s.cwd || ''),
      cwd: s.cwd,
      goal: goalText,
      turns: (s.turns || []).length,
      cowork: s.cowork ? { source: s.cowork.source } : null,
      // WHETHER THE PROJECT IS STILL THERE.
      projectMissing: Boolean(app._projectMissing),
    },
    sessions: sessions(app),
    conversation: conversation(s),
    changes: changes(app),
    // THE USAGE TRACKER'S RINGS (usagetracker.js): per lane, what remains of the route's tightest REPORTED window —
    // Core's figure; the window's top-right tracker draws it and computes nothing of its own.
    tracker: (() => { try { return s.cowork ? null : require('../usagetracker').lanes(app); } catch { return null; } })(),
    // THE QUICK CHANGES (changeclass.js): each DIRECT or NARROW turn's request, the files it changed, and whether
    // it landed — what the IDE's Changes panel lists, so a small edit's result never needs a conversation.
    quickChanges: (Array.isArray(s.quickChanges) ? s.quickChanges : []).slice(-10),
    // A PICTURE THE PERSON ASKED TO SEE.
    viewing: (() => { try { return require('../imageviewer').current(app); } catch { return null; } })(),
    sources: await sources(app),
    workshop: workshop(app),
    // THE LIVE OPERATIONAL ROW. One state, shared with the terminal and the
    // window title — see `execution` above.
    execution: execution(app),
    // WHERE THE WORK RUNS. Small on purpose — see `environment` above.
    environment: environment(app),
    // THE HARNESS'S OWN PROJECTION, passed through untouched. `null` means no
    // task — which is a fact, and is drawn as one rather than as an empty task.
    harness,
    plan: s.plan && s.plan.steps && s.plan.steps.length
      ? {
        live: s.plan.isLive,
        done: s.plan.completed.length,
        total: s.plan.steps.length,
        steps: s.plan.steps.slice(0, 40).map((x) => ({ id: x.id || null, n: x.n, text: x.text, status: x.status, origin: x.origin || 'llm' })),
        // THE COMMITTED CHECKPOINT (taskcheckpoint.js) — the one position every surface shows.
        checkpoint: require('../taskcheckpoint').view(s),
      }
      : null,
    // The neutral Cowork projection reads the same Session, Harness, approval,
    // artifact and background-job owners as every other surface.
    cowork: require('../cowork/runtime').project(app),
    // A QUESTION A WINDOW-STARTED TURN IS WAITING ON. See sessionroutes.js.
    ask: require('./sessionroutes').pendingAsk(app),
    // THE DESKTOP, only when there is one. `existing` never creates it, so
    // polling the application does not connect anything. See computermcp.js.
    computer: computer(app),
    // WHERE THE BOT ASKED THE WINDOW TO GO — "open the MCP settings".
    navigate: ((app && app._sibling) || app)._uiNavigate || null,
    // THE SESSION JOURNEY — surface, the Agent's task pointer, the waiting
    // transfer, the project generation, the canonical Selection; see journey.js.
    journey: (() => { try { return require('../journey').project(app); } catch { return null; } })(),
    // CHAT'S SUPERVISION OF THE CODING AGENT — phase, strategy, profile, pending
    // steers, findings, phase summaries, plan deltas, LAIN's open offers, quota pause.
    workbench: (() => { try { return s.cowork ? null : require('../supervision').state(app); } catch { return null; } })(),
    // THE SESSION'S FACTS, ACCOUNT FIRST — the same projection the terminal's /status and Telegram's print (sessionfacts.js).
    facts: (() => { try { return s.cowork ? null : require('../sessionfacts').facts(app); } catch { return null; } })(),
    // UPDATES (update/updater.js, cached state — never the network) and WHAT THIS WINDOW IS: the full Harness, the
    // CLI's Model Dashboard, or the CLI's standalone Preview (desktopwindow.js `mode`), plus the installed components.
    update: (() => { try { return require('./updateroutes').view((app && app._sibling) || app); } catch { return null; } })(),
    // COMPUTER CONTROL (Phase CU): the same state /computer reads — the chip, Enable, target and Stop draw from it.
    computer: (() => { try { return require('../computercontrol').view(app); } catch { return null; } })(),
    surface: {
      mode: ((app && app._sibling) || app)._surfaceMode || 'harness',
      // `lain preview` while this LAIN runs (corelock.js): when it was asked, so the window opens the Preview once.
      previewWanted: (((app && app._sibling) || app)._previewWanted || {}).at || null,
      components: (() => { try { return require('../components').read(); } catch { return null; } })(),
    },
  };
  // THE ENGINEERING SESSION CONTRACT — header, Chat/Coding views, plans and handoff, composer prefill, workspace panels, per-view models.
  Object.assign(out, require('./stateviews').project(app, out));
  // `environment` is DIAGNOSTICS (host, browser build, running instruments) —
  // kept for the diagnostics surface, not primary UX.
  out.diagnostics = { environment: out.environment };
  return out;
}

module.exports = { read, sessions, conversation, changes, sources, workshop, execution, environment, laneOf, SESSION_LIMIT, TURN_LIMIT };
