'use strict';

/** THE INTERACTIVE SESSION LOOP — read, route, run, drain, shut down. */

const { C } = require('./render');
const { Session } = require('./session');
const { Input } = require('./input');
const commands = require('./commands');
const { onInterrupt } = require('./interrupt');

async function start(app) {
  // TTY: the four-region UI.
  if (process.env.LAIN_NO_TUI !== '1' && app.render.out.isTTY) app.splash();
  // BEFORE the alternate screen: discovery prints, and those lines belong in the scrollback with the splash rather than flashing behind a UI that is…
  await app.prepare();

  // THIS TERMINAL IS THE LAIN THIS ACCOUNT IS RUNNING
  try { require('./credentials').prefetchAsync(Object.values((app.cfg && app.cfg.connections) || {}).map((c) => c && c.credentialRef).filter(Boolean)); } catch { /* read when needed */ }
  try { await require('./corelock').announce(app, { surface: 'cli' }); } catch { /* a lock is a convenience */ }
  // `lain --resume <id>` IS AN EXPLICIT ACT: a session another surface holds is asked for (it hands over when idle).
  if (app.resumedFrom) { try { const held = require('./surfacehandoff').askOnResume(app); if (held) app.render.write(C.dim(`  Asked the ${held.writer === 'harness' ? 'Harness' : held.writer} to hand this session over — it does when it is idle.\n`)); } catch { /* the first sentence says so */ } }
  // The Telegram gateway is frozen (S9): it no longer starts with LAIN; /bot starts it on demand.
  try { require('./assistant/scheduler').start(app); } catch { /* the assistant's clock is not fatal */ }
  // MODELS, LIGHTLY (modelcatalog.js): a provider listing older than a day is re-read once, a minute after start — never blocking.
  try { require('./modelcatalog').scheduleBackground(app); } catch { /* the next start tries again */ }


  const tui = process.env.LAIN_NO_TUI === '1' ? false : app.ui.enable();

  // WHAT SURVIVED SINCE LAST TIME — one line each, only when there is something to say.
  try {
    const root = app.session ? app.session.cwd : process.cwd();
    const lainstore = require('./lainstore');
    if (lainstore.has(root, 'architecture')) {
      const { report } = require('./reconcile').run(root);
      const bad = report.missing + report.damaged + report.drifted;
      if (bad) app.render.write(C.yellow(`  architecture: ${bad} recorded component(s) missing/damaged/drifted — /doctor\n`));
    }
    const orphans = require('./scratch').orphans(root, { exclude: app.session ? app.session.id : '' });
    // MARKED AS AN OPERATION, not as prose.
    if (orphans.length) require('./ui/operation').say(app, `${orphans.length} unfinished turn(s) left findings behind · /lain`);
    // A TURN RECOVERED FROM A FORCE-CLOSE (inflight.js) says so once.
    const rec = app.session && app.session.recovered;
    if (rec && !rec.shown) { rec.shown = true; require('./ui/operation').say(app, rec.line); }
  } catch { /* startup chrome never blocks the session */ }
  // PLAINTEXT CREDENTIALS LEFT BY AN OLDER VERSION (legacysecrets.js): counted, never shown, never deleted for you.
  // ONCE: on the status row in the TUI (a transcript write is redrawn under every turn), a line on a pipe; /doctor lists it.
  try { const s = require('./legacysecrets').summary(); if (s) { if (tui) require('./ui/operation').say(app, s.text, 'warn'); else app.render.notice('warn', s.text); } } catch { /* a scan never blocks the session */ }

  if (!tui) app.banner();
  const input = new Input({ stdin: process.stdin, stdout: process.stdout });
  app.input = input;
  // In TUI mode the screen owns the input row; letting the reader echo too
  // would draw every character twice.
  input.echo = !tui;
  const promptStr = tui ? '' : C.green('› ');
  // Keys, in priority order.
  for (const ev of ['key', 'edit', 'input', 'mouse', 'clipboard']) input.on(ev, () => { app._lastInputAt = Date.now(); });
  input.on('key', (k) => {
    app.disarmExit();              // any deliberate key clears the exit confirmation
    if (!tui) return;
    if (app.ui.completionKey(k)) return;
    if (app.ui.handleKey(k)) return;
    // ESC INTERRUPTS A RUNNING TURN when nothing on screen claimed it — the live row says `esc to interrupt`.
    if (k === 'escape' && app.abort && !app.abort.signal.aborted) { input.emit('interrupt'); return; }
    // Caret movement and history recall, once no menu has claimed the key.
    // The editor owns both, because both are about where the caret is.
    if (input.editKey(k)) { /* consumed by the line editor */ }
    // Enter on an empty line opens what the view offers; with text it SENDS.
    else if (k === 'enter' && !input.line.trim()
             && Boolean(app.abort && !app.abort.signal.aborted)
             && !app.pendingAsk && app.steerQueue.length) {
      const n = app.promoteSteers();
      if (n) app.transient('info', `steering now — ${n} message(s) at the next step`);
    }
    else if (k === 'enter' && !input.line.trim()) app.ui.workspaceSelect();
    // TAB NO LONGER MOVES ANYTHING
  });
  // THE MOUSE. Only ever asked for on a real terminal, and only in TUI mode: a linear `lain -p` run has nothing to click, and enabling tracking there…
  if (tui && require('./config').load().mouse === true) input.enableMouse();
  input.on('mouse', (ev) => { app.disarmExit(); if (tui) app.ui.handleMouse(ev); });

  // THE CLIPBOARD
  input.on('clipboard', (ev) => {
    app.disarmExit();
    const clip = require('./copy');
    if (ev.action === 'copy' || ev.action === 'cut') {
      const r = clip.toClipboard(ev.text);
      // SAID, EITHER WAY. A copy that silently did nothing is indistinguishable
      // from one that worked until the paste fails somewhere else entirely.
      app.transient(r.ok ? 'info' : 'warn', r.ok
        ? `copied ${ev.text.length} character(s)`
        : `could not copy: ${r.error}`);
      return;
    }
    if (ev.action === 'paste') {
      const text = clip.fromClipboard();
      if (!text.ok) { app.transient('warn', `could not paste: ${text.error}`); return; }
      // THROUGH THE READER, so it is one edit on the one line, with the paste
      // flag set exactly as a bracketed paste would set it.
      input.insertText(text.text, { pasted: true });
    }
  });
  input.on('edit', (text, meta) => {
    app.disarmExit();              // typing means the user is staying, not leaving
    if (!tui) return;
    // A letter the completion overlay advertises is a shortcut, not typing.
    if (app.ui.completionShortcut(text)) { input.setLine(''); return; }
    // Likewise a letter an OPEN PANEL advertises — `D` for details on the
    // session browser. The panel claims it or it is typed; see panel.shortcut.
    if (app.ui.panelShortcut(text)) { input.setLine(''); return; }
    app.ui.setInput(text, input.cursor);
    // The menus follow TYPING. A paste is content arriving in the box, so it
    // is shown and nothing is offered on the strength of it.
    app.ui.updateMenus(text, meta || {});
  });
  // Enter is the menu's while a menu is open, and the line's otherwise.
  input.enterGoesToUI = () => {
    if (tui && app.ui.panel.visible) require('./admissiontrace').note(app, 'enter:panel-open');
    if (!tui || !app.ui.panel.visible) return false;
    if (app.ui.panel.isAdvisory) return false;
    if (app.ui.panel.isPassive) { app.ui.panel.close(null); app.ui.refresh(); return false; }
    return true;
  };

  const queue = [];
  let closed = false;
  let waiter = null;
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };

  input.on('input', (ev) => {
    app.disarmExit();
    // A COMMAND TYPED DURING A TURN runs now, for the same reason a command chosen from the palette does: the REPL loop is parked inside the turn, so…
    const turnActive = Boolean(app.abort && !app.abort.signal.aborted) || app.dispatching > 0;
    const trace = require('./admissiontrace');
    trace.note(app, 'input', { chars: String(ev.text || '').length, turnActive });
    // AN ANSWER NEVER QUEUES.
    if (app.pendingAsk && app.answerPending(ev.text)) { trace.note(app, 'input:answer'); return; }
    if (turnActive && !ev.isPaste && !app.pendingAsk
        && commands.looksLikeCommand(ev.text)
        // ONLY the safe ones jump the queue.
        && !commands.blockedDuringTurn(commands.parse(ev.text).name)) {
      trace.note(app, 'input:command-during-turn');
      Promise.resolve(commands.run(app, ev.text)).catch((e) => {
        app.render.notice('error', `${ev.text}: ${e && e.message}`);
      });
      return;
    }
    // ANYTHING ELSE TYPED AT A WORKING LAIN IS A STEER —
    if (turnActive && !app.pendingAsk && !app.composing && app.queueSteer(ev.text)) { trace.note(app, 'input:steer'); return; }
    trace.note(app, 'input:queued');
    queue.push(ev);
    wake();
  });
  input.on('close', () => {
    closed = true;
    // AND THE APP IS TOLD, because a question asked AFTER this point can never be answered either.
    app.inputClosed = true;
    // An open panel awaits a selection.
    if (app.ui.panel.visible) app.ui.panel.close(null);
    if (app.pendingAsk) { const r = app.pendingAsk; app.pendingAsk = null; r(null); }
    wake();
  });
  input.on('interrupt', () => {
    // WORKING means a request or tool is genuinely in flight — an already aborted controller that is still unwinding does not count, so a second Ctrl+C…
    const working = Boolean(app.abort && !app.abort.signal.aborted);
    const d = onInterrupt({ working, armedAt: app._exitArmedAt }, Date.now());
    if (d.action === 'cancel') {
      // SHOWN BEFORE THE UNWIND, not after it.
      if (app.ui.enabled) {
        // A panel open over the work must not survive the cancellation — it
        // would keep reporting NEEDS USER for a turn that is being torn down.
        if (app.ui.panel.visible) app.ui.panel.close(null);
        if (app.pendingAsk) { const r = app.pendingAsk; app.pendingAsk = null; r(null); }
        app.ui.setInterrupting(true);
      }
      app.abort.abort();
      // THE LIVE ROW ALREADY SAYS THIS, AND KEEPS SAYING IT
      require('./ui/operation').say(app, 'Interrupted', 'warn');
      app.disarmExit();
      return;
    }
    if (d.action === 'exit') {
      app.disarmExit();
      // AN OPEN PANEL IS AWAITING AN ANSWER, and `wantExit` is only read by the REPL loop — which is currently parked inside `await ui.ask(...)`.
      if (app.ui.enabled && app.ui.panel.visible) app.ui.panel.close(null);
      if (app.pendingAsk) { const r = app.pendingAsk; app.pendingAsk = null; r(null); }
      app.wantExit = true; closed = true; wake();
      return;
    }
    app.armExit();                 // first idle press: arm + hint, do NOT exit
  });

  input.start();

  // IS THIS DIRECTORY MINE TO WORK ON?
  if (tui) {
    try { await require('./trustask').ensureTrusted(app); } catch { /* an unreadable config still runs */ }
  }

  // A REJECTION MUST NOT END THE SESSION
  const onRejection = (reason) => {
    const msg = (reason && reason.message) || String(reason);
    try {
      app.render.notice('error', `unhandled error (the session is still running): ${msg}`);
      if (process.env.LAIN_DEBUG && reason && reason.stack) app.render.write(String(reason.stack) + String.fromCharCode(10));
    } catch { /* the renderer is gone; the session ending is worse than a lost line */ }
  };
  process.on('unhandledRejection', onRejection);

  input.prompt(promptStr);

  for (;;) {
    if (app.wantExit) break;
    if (!queue.length) {
      if (closed) {
        // EOF DOES NOT MEAN THE WORK IS OVER
        const running = app.jobs.running();
        if (running.length) { await Promise.all(running.map((j) => j.wait())); continue; }
        break;                                 // drained, closed, and idle = real EOF
      }
      await new Promise((r) => { waiter = r; });
      continue;
    }
    // QUEUED WORK STILL RUNS IN ORDER
    if (queue.length) {
      const primary = app.jobs.primary();
      if (primary) { require('./admissiontrace').note(app, 'queue:wait-primary'); await primary.wait(); continue; }
    }
    const ev = queue.shift();
    require('./admissiontrace').note(app, 'queue:dequeue', { chars: String(ev.text || '').length });
    try {
      if (tui) app.ui.setInput('');
      // THE LINE THAT USED TO BLOCK THE WHOLE INTERFACE
      await app.handle(ev.text, { isPaste: ev.isPaste, from: ev.from, background: true });
    } catch (e) {
      // A bug in LAIN must not end the session.
      app.render.notice('error', `internal error: ${e && e.message}`);
      if (process.env.LAIN_DEBUG) app.render.write(String(e && e.stack) + '\n');
    }
    if (!app.wantExit) input.prompt();
  }

  input.stop();
  // NOTHING KEEPS WORKING AFTER THE SESSION ENDS
  let continueIn = null;
  try { if (require('./desktopwindow').alive() && app.session && require('./surfacehandoff').unfinished(app.session)) continueIn = app.session.id; } catch { continueIn = null; }
  await require('./teardown').shutdown(app, { why: 'the session ended' });
  process.removeListener('unhandledRejection', onRejection);
  app.ui.disable();                       // restore the user's terminal
  // CLOSING THE CLI PAUSES THE TASK, never ends it: the Harness shows Paused · CLI closed and ▶ Continue.
  try { require('./surfacehandoff').release(app); } catch { /* best effort */ }
  try { app.session.save(); } catch { /* best effort on the way out */ }
  app.render.nl();
  // The REAL persisted session id — never a fresh one generated at exit.
  if (continueIn) {
    try {
      const { spawn } = require('child_process');
      const entry = require('path').join(__dirname, '..', 'bin', 'lain.js');
      const child = spawn(process.execPath, [entry, '--desktop', '--resume', continueIn, '--continue-session'], { cwd: app.session.cwd || process.cwd(), detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, LAIN_NO_TUI: '1' } });
      child.unref();
      app.render.write(C.dim('  The Harness continues this session.') + '\n');
    } catch { /* ▶ Continue in the Harness picks it up */ }
  }
  app.render.write(C.dim('  Session saved.') + '\n\n');
  app.render.write(C.dim('  Resume with:') + '\n');
  app.render.write(`    lain --resume ${Session.shortId(app.session.id)}` + '\n');
  return app.exitCode;
}

module.exports = { start };
