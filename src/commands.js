'use strict';

/** Slash commands, and the single authority on WHAT COUNTS AS ONE. */

const path = require('path');
const { Session } = require('./session');
const { C } = require('./render');
const toolRegistry = require('./tools');
const providerMod = require('./provider');
const config = require('./config');
// The catalog and connection modules moved out with the route commands; this
// file no longer knows what a route is.

const REGISTRY = new Map();

/** MAY THIS COMMAND RUN WHILE A TURN IS IN FLIGHT? */
const DURING_TURN = Object.freeze({
  SAFE: 'safe',        // reads state, or changes only what the NEXT turn reads
  BLOCKED: 'blocked',  // would rewrite the session, the plan or the working tree
});

/** `surface: true` — THIS COMMAND TALKS ABOUT LAIN'S OWN MACHINERY. */
/** HOW LONG A RECEIPT STAYS BEFORE CLEARING ITSELF. */
const FLASH_MS = 1500;

/** THE DEFAULT: A PANEL STAYS UNTIL IT IS DISMISSED. */
const STAY_OPEN = 0;
/** and it is not offered anywhere. */
function define(name, { args = '', desc, run, duringTurn = DURING_TURN.SAFE, surface = false, flashMs = STAY_OPEN, hidden = false }) {
  const key = name.toLowerCase();
  if (REGISTRY.has(key)) throw new Error(`duplicate command: ${key}`);
  REGISTRY.set(key, { name: key, args, desc, run, duringTurn, surface, flashMs, hidden: Boolean(hidden) });
}

/** Everything a person is offered — the registry minus its compatibility aliases. */
function offered() {
  return [...REGISTRY.values()].filter((c) => !c.hidden);
}

/** True when this command must wait for the active turn to finish. */
function blockedDuringTurn(name) {
  const c = REGISTRY.get(String(name || '').toLowerCase());
  return Boolean(c && c.duringTurn === DURING_TURN.BLOCKED);
}

/** All three conditions, in one place. */
function looksLikeCommand(input) {
  const s = String(input == null ? '' : input);
  if (s.includes('\n')) return false;            // multi-line input is content
  const t = s.trim();
  if (!t.startsWith('/')) return false;
  const first = t.split(/\s+/)[0].toLowerCase();
  return REGISTRY.has(first);
}

function parse(input) {
  const t = String(input).trim();
  const parts = t.split(/\s+/);
  return { name: parts[0].toLowerCase(), args: parts.slice(1), rest: t.slice(parts[0].length).trim() };
}

async function run(app, input) {
  const { name, args, rest } = parse(input);
  const cmd = REGISTRY.get(name);
  if (!cmd) return; // unreachable via looksLikeCommand, kept honest anyway
  // THE ONE GATE. A turn is in flight exactly when there is a controller that could still abort it. A blocked command SAYS SO rather than hanging or…
  const turnActive = Boolean(app.abort && !app.abort.signal.aborted);
  if (turnActive && cmd.duringTurn === DURING_TURN.BLOCKED) {
    app.render.notice('warn',
      `${cmd.name} can't run while a turn is in flight — it would change the session under it. `
      + 'Press Ctrl+C to stop the turn first, or wait for it to finish.');
    return;
  }

  // WHERE THE COMMAND'S OUTPUT GOES
  if (!cmd.surface) return cmd.run(app, { args, rest });
  app.render.openSurface(cmd.name); receiptMarked = false;
  try {
    return await cmd.run(app, { args, rest });
  } finally {
    // `flashMs` MARKS A RECEIPT — output that confirms an action the user just took deliberately, and so clears itself rather than waiting for an Esc that…
    app.render.doneSurface({ closeAfterMs: cmd.flashMs || (receiptMarked ? FLASH_MS : 0) });
  }
}
let receiptMarked = false; function receipt() { receiptMarked = true; }   // THIS RUN is a receipt though other forms inspect (/bg detach vs summary)
// ------------------------------------------------------------- commands ----


// Leaving mid-turn would abandon work in flight, so it is BLOCKED and says so
// rather than half-happening. Ctrl+C twice is the way to leave right now.
const LEAVE = 'Save the session and leave (Ctrl+C twice to leave immediately)';
define('/exit', { duringTurn: DURING_TURN.BLOCKED, desc: LEAVE, run(app) { app.wantExit = true; } });
define('/quit', { duringTurn: DURING_TURN.BLOCKED, desc: LEAVE, run(app) { app.wantExit = true; } });

define('/status', {
  // READ, not glanced at: a dozen facts you look through. It waits for Esc.
  flashMs: 0,
  // MACHINERY: about LAIN, not about the work. Goes to the command panel.
  surface: true,
  desc: 'Session, provider and tool state',
  run(app) {
    app.render.write('\n' + C.bold('Status') + '\n');
    for (const [k, v] of require('./diagnose').statusRows(app, { dim: C.dim })) {
      app.render.write('  ' + k.padEnd(16) + v + '\n');
    }
  },
});

// `/token` MOVED TO src/tokencommand.js

/** `/troubleshoot` — REMOVED FROM THE COMMAND SURFACE, 2026-09, UX subtraction pass. */

/** `/dash` LIVES IN dashcommand.js — it is the one command that runs a server, and it carries the three decisions that go with that */


/** `/mcp` — the desktop bridge: connect it, see it, and take it away. */
define('/mcp', {
  // MACHINERY: about LAIN, not about the work. Goes to the command panel.
  surface: true,
  args: '[status|computer|connect|revoke|disconnect|servers|trust]',
  desc: 'Computer MCP and the desktop bridge — what they are, and what they may do',
  async run(app, { args }) {
    const mcpMod = require('./mcp');
    const { bridge, permissions } = app.desktop();
    const sub = String(args[0] || 'status').toLowerCase();
    const w = (s) => app.render.write(s);

    // COMPUTER MCP is LAIN's own desktop capability — one question, once per
    // session. See src/computercommand.js and src/computermcp.js.
    if (sub === 'computer') return require('./computercommand').run(app, args.slice(1), { C }); if (sub === 'servers' || sub === 'trust') return require('./capcommands').mcp(app, args, { C });   // MCP servers: health + the person's trust (mcpreg.js)

    if (sub === 'connect') {
      if (!mcpMod.configured(app.cfg)) {
        w('  ' + C.yellow('✕ NOT CONFIGURED') + C.dim(' — add mcp.command to ' + require('./config').configFile() + ':\n'));
        w(C.dim('    { "mcp": { "command": ["node", "C:\\\\path\\\\to\\\\bridge.js"] } }\n'));
        w(C.dim('    The bridge is a separate program you provide. LAIN automates nothing itself.\n'));
        return;
      }
      w(C.dim('  starting the bridge…\n'));
      const r = await bridge.connect();
      if (!r.ok) { w('  ' + C.red('✕ ' + r.state) + C.dim(` — ${r.reason}\n`)); return; }
      w('  ' + C.green('✓ CONNECTED') + C.dim(`  ${r.info.name}${r.info.version ? ' ' + r.info.version : ''}\n`));
      w(C.dim(`    capabilities: ${r.capabilities.join(', ') || 'none advertised'}\n`));
      w(C.dim('    nothing is permitted yet — you are asked at the moment each one is needed.\n'));
      return;
    }
    if (sub === 'revoke') {
      const had = permissions.revoke('you revoked it');
      try { require('./controlwindow').update(app); } catch { /* no window */ }
      w(had.length
        ? '  ' + C.green('✓ REVOKED') + C.dim(`  ${had.join(', ')} — the next desktop action will be refused\n`)
        : C.dim('  nothing was granted; nothing to revoke.\n'));
      return;
    }
    if (sub === 'disconnect' || sub === 'stop') {
      bridge.close('you stopped it');
      try { require('./controlwindow').close(app); } catch { /* no window */ }
      w('  ' + C.green('✓ STOPPED') + C.dim(' — the bridge is closed and every grant is gone\n'));
      return;
    }

    const s = bridge.status();
    const ok = s.state === mcpMod.STATE.CONNECTED;
    w('\n' + C.bold('MCP') + '\n');
    // EVERY CONFIGURED SERVER, not only the one being talked to.
    const all = mcpMod.servers(app.cfg);
    const active = mcpMod.settings(app.cfg);
    if (all.length) {
      w(C.dim('  servers') + '\n');
      for (const srv of all) {
        const isActive = active && srv.id === active.id;
        const state = !srv.enabled ? C.dim('○ DISABLED')
          : isActive && ok ? C.green('✓ CONNECTED')
            : isActive ? C.yellow('⚠ ' + s.state)
              : C.dim('○ configured, not the active bridge');
        w('    ' + srv.id.padEnd(16) + state + '\n');
        w(C.dim('      ' + srv.command.join(' ').slice(0, 70)) + '\n');
      }
      w('\n');
    }
    w('  ' + 'Bridge'.padEnd(20) + (ok ? C.green('✓ CONNECTED') : s.configured ? C.yellow('⚠ ' + s.state) : C.red('✕ NOT CONFIGURED')) + '\n');
    if (!ok && s.reason) w('  ' + 'Reason'.padEnd(20) + C.dim(s.reason) + '\n');
    if (s.name) w('  ' + 'Process'.padEnd(20) + C.dim(s.name) + '\n');
    const perms = s.permissions.capabilities || {};
    for (const [cap, state] of Object.entries(perms)) {
      const label = cap[0].toUpperCase() + cap.slice(1);
      w('  ' + label.padEnd(20)
        + (state.granted
          ? C.green('✓ ALLOWED') + C.dim(`  ${Math.ceil(state.msLeft / 1000)}s left · ${state.scope}`)
          : C.dim('— ' + state.why)) + '\n');
    }
    w('  ' + 'Target'.padEnd(20) + C.dim(s.target || '—') + '\n');
    // CAN LAIN ACTUALLY LOOK AT THE SCREEN RIGHT NOW?
    const vis = require('./computer').visualReadiness(app);
    w('  ' + 'Visual inspection'.padEnd(20)
      + (vis.ok ? C.green('✓ POSSIBLE') : C.dim('— ' + vis.why)) + '\n');
    if (s.activity.length) {
      w('\n' + C.dim('  recent\n'));
      for (const a of s.activity.slice(-6)) w(C.dim(`    ${a.ok ? '·' : '✕'} ${a.text}\n`));
    }
    w(C.dim('\n  /mcp connect · /mcp revoke (stops everything now) · /mcp disconnect\n'));
  },
});

/** `/copy` — a LOCAL utility. */
/** `/image` — LOOK AT ONE. */
define('/image', {
  // MACHINERY: LAIN talking about itself, not about the work. Goes to the
  // command panel, never into the conversation the model reads.
  surface: true,
  args: '[path]',
  desc: 'Open an image so you can actually look at it (a terminal cannot show one)',
  async run(app, { rest }) {
    const view = require('./imageview');
    let file = String(rest || '').trim().replace(/^["']|["']$/g, '');

    if (!file) {
      const seen = view.recent(app);
      if (!seen.length) {
        app.render.write(C.dim('  No images seen yet. /image <path> opens one.\n'));
        return;
      }
      if (seen.length > 1 && app.ui.enabled) {
        // THE ONE QUESTION SURFACE, never a second picker. See ui/answer.js.
        const picked = await app.ui.askUser({
          question: 'Which image?', options: seen, input: 'choice',
        });
        if (!picked) return;
        file = picked;
      } else {
        [file] = seen;
      }
    }

    const r = await view.open(app, file);
    if (!r.ok) {
      app.render.write('  ' + C.yellow('NOT OPENED') + C.dim(` — ${r.why}\n`));
      return;
    }
    const f = r.facts || {};
    const size = f.ok
      ? `${f.kind} ${f.width}×${f.height}, ${Math.round(f.bytes / 1024)} KB`
      : 'size unknown';
    // WHICH WINDOW IT IS IN MATTERS: one of them is LAIN's and one is the user's.
    app.render.write('  ' + C.green('OPENED') + C.dim(` in ${r.how} — ${size}\n`));
    app.render.write(C.dim(`    ${r.file}\n`));
  },
});



define('/copy', {
  // MACHINERY: LAIN talking about itself, not about the work. Goes to the
  // command panel, never into the conversation the model reads.
  surface: true,
  args: '[context|context all|last|output|diff|task|status|activity|messages|audit|health|rc|troubleshoot]',
  desc: 'Copy the task summary; /copy context exports diagnostic context (local; costs nothing)',
  run(app, ctx) { return require('./copy').runCommand(app, ctx, { C }); },
});

define('/tools', {
  // MACHINERY: LAIN talking about itself, not about the work. Goes to the
  // command panel, never into the conversation the model reads.
  surface: true,
  // READ, not glanced at — it waits for Esc.
  flashMs: 0,
  desc: 'List the tools the model can call',
  run(app) {
    app.render.write('\n');
    for (const n of toolRegistry.names()) {
      app.render.write('  ' + n.padEnd(18) + C.dim(toolRegistry.isMutating(n) ? 'mutating' : 'read-only') + '\n');
    }
  },
});

define('/cwd', {
  // MACHINERY: about LAIN, not about the work. Goes to the command panel.
  surface: true,
  duringTurn: DURING_TURN.BLOCKED,
  args: '[dir]',
  desc: 'Show or change the working directory',
  run(app, { rest }) {
    if (!rest) { app.render.write('  ' + app.session.cwd + '\n'); return; }
    const next = path.resolve(app.session.cwd, rest);
    try {
      process.chdir(next);
      app.session.cwd = next;
      app.cwd = next;
      app.render.write(C.dim('  ' + next + '\n'));
    } catch (e) { app.render.notice('error', `cannot cd: ${e.message}`); }
  },
});

define('/task', {
  // NOT MACHINERY, for the same reason as /plan: the objective, the lifecycle state and the evidence behind it ARE the work, and they belong in the…
  desc: 'The active task, its lifecycle state and its evidence',
  run(app) {
    const t = app.session.task;
    if (!t) { app.render.write(C.dim('  No active task.\n')); return; }
    const w = (k, v) => app.render.write('  ' + String(k).padEnd(16) + v + '\n');
    app.render.write('\n' + C.bold('Task') + '\n');
    // A pasted objective is multi-line; collapse it so the table stays a table.
    const oneLine = t.objective.replace(/\s+/g, ' ').trim();
    w('objective', oneLine.slice(0, 90) + (oneLine.length > 90 ? '…' : ''));
    w('started', t.startedAt);
    const l = app.session.lifecycle;
    if (l) {
      const s = l.summary();
      w('state', s.state + (s.reason ? C.dim(` — ${s.reason}`) : ''));
      w('turns', String(s.turns));
      w('tool calls', String(s.toolCalls));
      w('files changed', String(s.filesChanged));
      w('commands run', String(s.commandsRun));
      w('repeats', String(s.repeatedObservations));
    }
    if (t.steers.length) {
      app.render.write('  ' + 'steers'.padEnd(16) + '\n');
      for (const s of t.steers.slice(-5)) app.render.write(C.dim(`      - ${s.text.slice(0, 90)}\n`));
    }
    const ev = app.session.evidence.digest(6);
    if (ev) app.render.write('\n  ' + ev.split('\n').join('\n  ') + '\n');
    // AND THE TASK RECORD, WHICH OUTLIVES THIS SESSION
    try { require('./harnesscommands').status(app, C); } catch { /* no harness in this session */ }
  },
});

define('/plan', {
  // NOT MACHINERY — and this was got wrong once already, by me, in the sweep that moved every other command's output to the panel.
  duringTurn: DURING_TURN.BLOCKED,
  args: '[<nothing — discuss it>|accept|show|step <text>|done <note>|drop <n>|clear]',
  desc: 'The session-owned plan (optional — plans are never required)',
  run(app, ctx) { return require('./plan').runCommand(app, ctx, { C }); },
});

define('/config', {
  // MACHINERY: about LAIN, not about the work. Goes to the command panel.
  surface: true,
  desc: 'Show configuration (opens the interaction panel on a TTY)',
  async run(app) {
    // Reads the EXISTING config store. There is no second config system, and
    // nothing here is derived by asking a model.
    const keys = ['model', 'connection', 'effort', 'maxSteps', 'stream'];
    if (app.ui && app.ui.enabled) {
      const p = require('./ui/panel');
      const cat = app.catalog();
      // The editors REUSE the adapters the matching commands use, so there is
      // one model picker and one effort picker in the program, not three.
      const editors = {
        model: () => ({
          push: p.modelsAdapter({
            catalog: cat,
            current: app.cfg.model,
            onPickRoute: (model, conn, effort) => {
              app.cfg.model = model.id;
              app.cfg.connection = conn.connectionId;
              config.save(app.cfg);
            },
          }),
        }),
        // These two adapters only OFFER a value — their commands apply it after `ask` returns.
        connection: () => ({
          push: {
            ...p.providerAdapter({
              connections: app.connections(),
              availabilityOf: (cid) => app.availability.get(cid).status,
            }),
            onSelect(item) {
              app.cfg.connection = item.value;
              config.save(app.cfg);
              return { close: item.value };
            },
          },
        }),
        effort: () => {
          const m = app.cfg.model ? cat.byId.get(app.cfg.model) : null;
          const conn = m && (app.cfg.connection ? m.connections.find((c) => c.connectionId === app.cfg.connection) : m.connections[0]);
          return {
            push: {
              ...p.effortAdapter({ available: conn ? conn.efforts : [], current: app.cfg.effort }),
              onSelect(item) {
                // `auto` is the ABSENCE of a pin, exactly as /effort treats it.
                app.cfg.effort = item.value === 'auto' ? null : item.value;
                config.save(app.cfg);
                return { close: item.value };
              },
            },
          };
        },
        // Applied in place: a toggle and a short cycle need no second screen.
        stream: (cfg) => { cfg.stream = !cfg.stream; config.save(cfg); },
        maxSteps: (cfg) => {
          // 0 IS ON THE LADDER, AND IT IS THE HOME POSITION.
          const ladder = [0, 10, 20, 30, 50, 100];
          const i = ladder.indexOf(Number(cfg.maxSteps) || 0);
          cfg.maxSteps = ladder[(i + 1) % ladder.length];
          config.save(cfg);
        },
      };
      await app.ui.ask(p.configAdapter({ cfg: app.cfg, keys, editors }));
      return;
    }
    app.render.write('\n' + C.bold('Config') + '\n');
    for (const k of keys) {
      const v = app.cfg[k];
      app.render.write('  ' + k.padEnd(18) + (v === null || v === undefined ? C.dim('auto') : String(v)) + '\n');
    }
    app.render.write(C.dim('\n  stored in ' + config.configFile() + '\n'));
  },
});


// THE ROUTE COMMANDS register into THIS registry, from their own file.
require('./sessioncommands').register({ define, FLASH_MS, REGISTRY, DURING_TURN, C });
require('./routecommands').register({ define, FLASH_MS, REGISTRY, C });
// THE WORKING-TREE COMMANDS do the same, for the same reason: /undo and /changes are one subject — the bytes on disk and how to put them back — and…
require('./workcommands').register({ define, FLASH_MS, DURING_TURN, C });
// AND /dash, which left for a reason of its own: it is the only command that runs a SERVER, and the decisions that come with that — bind the network or…
require('./trustcommand').register({ define, FLASH_MS, C });
// AND /jobs + /bg + /cancel, which are one subject — work in flight and what it is doing.
require('./jobcommands').register({ define, FLASH_MS, C });
// AND /ps, THE OTHER ALTITUDE OF THE SAME SUBJECT.
require('./pscommand').register({ define, FLASH_MS, C });
// AND `/token` — the whole token account. One subject, its own file: the
// header carries the live output number and this carries everything else.
require('./tokencommand').register({ define, FLASH_MS });
// AND /runtime + /session — ONE subject: the process that outlives this
// one, and the windows onto it. sessionview.js registers /session.
require('./runtimecommand').register({ define, FLASH_MS, C });
require('./sessionview').register({ define, FLASH_MS, C });
// AND /stop + /observing, whose subject is A RUN BEING WATCHED.
require('./observecommand').register({ define, FLASH_MS, DURING_TURN, C });
// `/compact` uses the same context authority as the automatic path, in its own
// module so the command registry stays below the architecture guard.
require('./compactcommand').register({ define, FLASH_MS, DURING_TURN, C });
// `/lain` surveys what `.lain/` remembers — architecture, wiring, vocabulary,
// facts and unfinished turns — in its own module for the same reason.
require('./laincommand').register({ define, FLASH_MS, C }); require('./capcommands').register({ define, C }); require('./computercontrol').register({ define, C });   // /skill /hooks (CAP) · /computer (CU)
require('./provenancecommand').register({ define, C });
require('./modecommands').register({ define, C });   // /focus /fast /browser (/chrome = hidden alias)
// AND THE REPORT COMMANDS — /compare, /audit, /health, /ready, /doctor: read
// something and say what is true of it, changing nothing.

// `/note` — the one door into RUNTIME NOTES (this machine's observations; evidence-gated FACTS are .lain's). See notecommand.js; it is one command and not four.
require('./notecommand').register({ define, FLASH_MS, C });
require('./reportcommands').register({ define, FLASH_MS, C, config });
// `/brief` — the engineering briefing.
require('./briefcommand').register({ define, FLASH_MS, C });
// THE HARNESS COMMANDS — /harness, /tasks, /verify, /artifacts, /env.
require('./harnesscommands').register({ define, FLASH_MS, DURING_TURN, C });
require('./botcommand').register({ define, FLASH_MS }); require('./accountcommand').register({ define, FLASH_MS }); require('./accountcommand').registerUsage({ define }); require('./accountcommand').registerChannels({ define });
// AND `/source` — WHICH MODEL ANSWERS A CHAT TURN: LAIN's own runtime, ChatGPT.com or Gemini.google.com.
require('./sourcecommand').register({ define, FLASH_MS, C });
// AND `/goal` — the standing direction this work serves.
require('./goalcommand').register({ define, FLASH_MS, C });
// `/app` IS GONE (2026-09-15).
require('./helpcommand').register({ define, FLASH_MS, REGISTRY, C });

module.exports = { receipt,
  REGISTRY, define, looksLikeCommand, parse, run,
  DURING_TURN, blockedDuringTurn, offered,
  // EVERY name, aliases included — this answers "can this be typed", which is a
  // different question from "is this offered". `offered()` is the second one.
  names: () => [...REGISTRY.keys()],
};
