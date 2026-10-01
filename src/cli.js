'use strict';

const pkg = require('../package.json');

const USAGE = `Noema CLI ${pkg.version} — an evidence-driven coding agent

Usage
  noema                     Start an interactive session (always EMPTY)
  noema -p "<prompt>"        Run one prompt and exit
  noema --resume <id>        Restore a saved session, then continue
  noema --sessions           List saved sessions and exit
  noema --doctor             Report what works on this machine, and exit
  noema --desktop            Open Noema Desktop (starts Noema, or shows the running one)
  noema --open <path>        Open a file or folder in Noema's IDE (what Windows' "Open with Noema" runs)
  noema --register-open-with / --unregister-open-with
                            Offer (or stop offering) Noema in Windows' "Open with" and the folder menu —
                            per-user; it never becomes the default program for any file type
  noema --serve              Serve Noema's models to other apps (OpenAI/Anthropic-compatible, 127.0.0.1)
                            [--port N] [--host H]; clients use your Noema access token, never a provider key
  noema --bot                Run the configured messaging gateway in the foreground
  noema --bot-check <name>   Observe telegram, discord or whatsapp configuration

Options
  -p, --print <prompt>   one-shot prompt
      --resume <id>      explicitly restore a session (the only way state crosses
                         a session boundary — there is no automatic resume)
      --sessions         list saved session ids
      --doctor           what this installation can and cannot do, and why.
                         Touches no provider and creates no session — this is
                         the command an installer uses to verify itself.
      --cwd <dir>        working directory for the session
      --desktop          start Noema as an application: no terminal, no REPL, a
                         native window and a tray icon. If this account is
                         already running Noema — a CLI, or an earlier launch in
                         the tray — its window is shown instead and no second
                         Noema is started. See src/desktoprun.js.
      --dev              with --desktop: developer window (devtools, context menu)
      --bot-check <name> read-only bot diagnostics; no service is started
  cache inspect          what Noema keeps that can be cleared, by category and size
  cache clear [ids] [--yes]
                         clear the safe categories, or the named ones (advanced
                         ones need --yes); sessions, accounts and settings stay
      --live             with --bot-check: authenticate using live platform APIs
      --record           with --bot-check --live: save non-secret evidence
  -v, --version          print version
  -h, --help             this
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      case '-p': case '--print': opts.print = argv[++i]; break;
      case '--resume': opts.resume = argv[++i]; break;
      case '--continue-session': opts.continueSession = true; break;
      case '--sessions': opts.sessions = true; break;
      case '--doctor': opts.doctor = true; break;
      case '--bot': opts.bot = true; break;
      case '--bot-check': opts.botCheck = argv[++i] || ''; break;
      case '--live': opts.botLive = true; break;
      case '--record': opts.botRecord = true; break;
      case '--cwd': opts.cwd = argv[++i]; break;
      case '--desktop': opts.desktop = true; break;
      case '--serve': opts.serve = true; break;
      case '--port': opts.port = argv[++i]; break;
      case '--host': opts.host = argv[++i]; break;
      case '--dev': opts.dev = true; break;
      case '--open': opts.open = argv[++i] || ''; opts.desktop = true; break;
      case '--register-open-with': opts.assoc = 'register'; break;
      case '--unregister-open-with': opts.assoc = 'unregister'; break;
      case '--yes': opts.yes = true; break;
      case '--check': opts.check = true; break;
      // THE LAUNCHER RESTARTED THIS INTO A NEW VERSION (update/lifecycle.js): say so, and continue the task in hand.
      case '--after-update': opts.afterUpdate = true; break;
      // STARTED AT WINDOWS SIGN-IN by the Startup shortcut (startup.js): the Harness, with the person's startup choices.
      case '--startup': opts.startup = true; opts.desktop = true; break;
      default:
        if (a.startsWith('-')) { opts.unknown = a; return opts; }
        opts._.push(a);
    }
  }
  // `lain -p Build a game` from a launcher that split the string
  if (opts.print !== undefined && opts._.length) {
    opts.print = [opts.print, ...opts._].join(' ');
    opts._ = [];
  }
  return opts;
}

async function main(argv) {
  // WINDOWS "OPEN WITH" FOR THE INSTALLER (setupsystem.cs): `noema assoc register --exe <launcher> [--no-files]
  // [--no-folders]` / `noema assoc remove` — winassoc.js, the one implementation; it also removes LAIN's old entries.
  if (argv[0] === 'assoc') return require('./winassoc').cli(argv.slice(1));
  // STARTUP (startup.js): `noema settings startup status | harness on|off | minimized on|off | restore on|off | sync`
  // — the SAME setting the Harness's Settings page changes, never a second config source.
  if (argv[0] === 'settings' && argv[1] === 'startup') return require('./startup').cli(argv.slice(2));
  // LAIN'S LEFTOVERS (legacycleanup.js): `noema legacy status | cleanup` — choices carried over, obsolete files removed.
  if (argv[0] === 'legacy') return require('./legacycleanup').cli(argv.slice(1));
  const opts = parseArgs(argv);

  if (opts.unknown) {
    process.stderr.write(`noema: unknown option ${opts.unknown} (try --help)\n`);
    return 2;
  }
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (opts.version) {
    const b = require('./update/updater').build();
    process.stdout.write(`Noema CLI ${b.version} (${b.channel}${b.revision ? `, ${b.revision}` : ''}) · node ${process.version}\n`);
    return 0;
  }
  if (opts.botCheck !== undefined) {
    if (opts.bot || opts.doctor || opts.sessions || opts.resume || opts.print !== undefined || opts._.length) {
      process.stderr.write('noema: --bot-check cannot be combined with a session or service command\n'); return 2;
    }
    return require('./bot/check').main(opts.botCheck, { live: opts.botLive, record: opts.botRecord });
  }
  if (opts.botLive || opts.botRecord) { process.stderr.write('noema: --live and --record require --bot-check <platform>\n'); return 2; }
  // CACHE AND TEMPORARY FILES (cachecare.js): `lain cache inspect | clear [ids…] [--yes]` — no session is built.
  if (opts._[0] === 'cache' && ['inspect', 'clear', 'help'].includes(opts._[1] || 'help') && opts.print === undefined) {
    return require('./cachecare').cli([...opts._.slice(1), ...(opts.yes ? ['--yes'] : [])]);
  }
  // ---- NOEMA SUBCOMMANDS (packaging pass §D2) — only these exact forms: `noema update the readme` is still a prompt.
  const words = opts.print === undefined ? opts._ : [];
  if (words.length && words.length <= 2) {
    const [w0, w1] = words;
    if (w0 === 'update' && (!w1 || w1 === 'check' || w1 === 'install')) return require('./update/cli').oneShot(w1 === 'check' || opts.check ? ['--check'] : []);
    if (w0 === 'project' && w1 === 'migrate') {
      const r = require('./projectmeta').migrate(opts.cwd || process.cwd());
      process.stdout.write(r.ok ? `${r.state === 'moved' ? 'Moved this project\'s .lain/ to .noema/.' : r.why}\n` : `noema: ${r.why}\n`);
      return r.ok ? 0 : 1;
    }
    // REFRESH MODELS WITHOUT A WINDOW (2026-10-02): the same Core catalog refresh as MODEL › Refresh models.
    if ((w0 === 'model' || w0 === 'models') && w1 === 'refresh') return require('./modelcommand').refreshCli({ cwd: opts.cwd });
    const DASH = { model: 'models', models: 'models', account: 'accounts', accounts: 'accounts', api: 'api', local: 'local', dashboard: 'accounts' };
    if (!w1 && DASH[w0]) return require('./desktoprun').main({ cwd: opts.cwd, mode: 'dashboard', section: DASH[w0] });
    if (!w1 && w0 === 'preview') return require('./desktoprun').main({ cwd: opts.cwd, mode: 'preview' });
    if (!w1 && (w0 === 'chat' || w0 === 'coding')) { opts.lane = w0; opts._ = []; }
  }
  if ((opts._.join(' ') === '/bot doctor' && opts.print === undefined) || opts.print?.trim() === '/bot doctor') return require('./bot/doctor').main();
  if (opts.bot) return require('./bot/service').foreground({ cwd: opts.cwd });

  // ---- LAIN AS AN APPLICATION -------------------------------------------
  //
  // Before anything that would build a session: a direct launch may turn out to
  // be a request to SHOW the LAIN that is already running, in which case this
  // process must not construct an App at all. See src/desktoprun.js.
  if (opts.desktop) return require('./desktoprun').main({ cwd: opts.cwd, dev: opts.dev, open: opts.open || null, resume: opts.resume || null, continueSession: Boolean(opts.continueSession), afterUpdate: Boolean(opts.afterUpdate), startup: Boolean(opts.startup) });
  // WINDOWS' "OPEN WITH" (winassoc.js): the stable launcher is built/installed first, then offered — never made a default.
  if (opts.assoc) {
    const desk = require('./desktop');
    const wa = require('./winassoc');
    if (opts.assoc === 'unregister') { const r = wa.unregister({ exe: desk.launcherPath() }); process.stdout.write(`Noema removed from "Open with" (${r.removed || 0} entries).\n`); return 0; }
    const inst = desk.installLauncher(desk.build({ quiet: true }));
    if (!inst.ok) { process.stderr.write(`noema: the launcher could not be installed: ${inst.why}\n`); return 1; }
    const r = wa.register({ exe: inst.launcher });
    if (!r.ok) { process.stderr.write(`noema: ${r.why || `${r.failed.length} registry write(s) failed: ${(r.failed[0] || {}).err || ''}`}\n`); return 1; }
    process.stdout.write(`Noema is offered in "Open with" for ${wa.EXTENSIONS.length} file types, and "Open folder in Noema" on folders. No default program was changed.\n`);
    return 0;
  }
  // LAIN AS A LOCAL MODEL SERVER (serve.js): LAIN's accounts for other applications, on loopback.
  if (opts.serve) return require('./serve').cli([...(opts.port ? ['--port', String(opts.port)] : []), ...(opts.host ? ['--host', String(opts.host)] : [])]);

  // ---- THE POST-INSTALL VERIFICATION COMMAND ----------------------------
  //
  // A FLAG RATHER THAN ONLY `lain /harness doctor`, for one unglamorous reason:
  // an argument beginning with `/` is rewritten into a Windows path by MSYS and
  // Git Bash before node ever sees it, so the slash form needs quoting exactly
  // where an installer is least able to guarantee it. `--doctor` is safe in
  // cmd, PowerShell, bash, zsh and fish alike.
  //
  // It builds no session, reads no credential and contacts nothing. That is
  // what makes it usable as an installation check on a machine that has not
  // been configured yet — which is every machine, at the moment it is checked.
  if (opts.doctor) {
    const { Harness } = require('./harness');
    const h = new Harness({ workspace: opts.cwd || process.cwd(), persist: true });
    try {
      const rows = await h.doctor();
      process.stdout.write(require('./harnessreport').render(rows, Harness.summarise(rows)));
      process.stdout.write(require('./bot/service').describe(await require('./bot/service').control()) + '\n');
      return Harness.summarise(rows).ok ? 0 : 1;
    } finally {
      await h.shutdown();
    }
  }

  if (opts.sessions) {
    const { Session } = require('./session');
    const ids = Session.list(50);
    process.stdout.write(ids.length ? ids.join('\n') + '\n' : 'no saved sessions\n');
    return 0;
  }

  const { App } = require('./app');
  const app = new App({ resume: opts.resume, cwd: opts.cwd, interactive: opts.print === undefined });

  // STARTED WELL: the launcher keeps a freshly updated version only once it reports healthy (update/updater.js).
  try { require('./update/updater').markHealthy(); } catch { /* not started by the launcher */ }
  if (opts.lane === 'chat') { try { app.session.thread = 'chat'; } catch { /* default lane */ } }

  const oneShot = opts.print !== undefined ? opts.print : (opts._.length ? opts._.join(' ') : undefined);
  if (oneShot !== undefined) {
    if (!String(oneShot).trim()) { process.stderr.write('noema: empty prompt\n'); return 2; }
    return await app.once(String(oneShot));
  }
  // UPDATES FOR AN INTERACTIVE CLI: checked at most every six hours, staged in the background, never interrupting work.
  try { require('./update/cli').start(app); } catch { /* updates are optional */ }
  if (opts.afterUpdate) require('./update/cli').afterRestart(app);
  return await app.start();
}

module.exports = { main, parseArgs, USAGE };
