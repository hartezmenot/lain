'use strict';

/** WHAT HAPPENS ONCE A TURN HAS ENDED — the REPL's half, not the loop's. */

async function after(app, record, text) {
  // THE TURN HAS ENDED: an account switch that waited for it is applied now — never in the middle of a request.
  try { await require('./sessionintel').applyPending(app, app.session); } catch { /* the choice stays as it was */ }
  if (record && app.ui && app.ui.enabled) require('./compacttip').afterTurn(app);
  // AN INTERRUPTED TURN HAS NO RECORD, AND THAT IS ORDINARY
  if (!record) {
    const waiting = app.wantExit ? [] : app.drainSteers();
    if (waiting.length) {
      return app.submit(waiting.join('\n'), { sameTask: true, from: 'steer', typed: true });
    }
    // A QUEUED CONTINUATION IS DROPPED WHEN THE TURN IT WAITED FOR WAS CANCELLED.
    if (app._queuedContinue) app._queuedContinue = null;
    return record;
  }
  // WHAT YOU TYPED WHILE IT WORKED, NOW THAT IT HAS FINISHED
  const waiting = app.wantExit ? [] : app.drainSteers();
  if (waiting.length) {
    // NO ACKNOWLEDGEMENT ROW: the next turn's USER block IS the delivery, and a
    // transient note here was cleared by `beginTurn` before any frame drew it.
    const joined = waiting.join('\n');
    return await app.submit(joined, { sameTask: true, from: 'steer', typed: true });
  }

  // A CONTINUATION THAT WAS QUEUED BEHIND THIS TURN
  if (!app.wantExit && app._queuedContinue) {
    const queued = app._queuedContinue;
    app._queuedContinue = null;
    // A GOAL SET MID-TURN (`/goal <text>`) is the person's own message, a new task.
    if (queued.goal) return await app.submit(queued.text, {});
    return await app.submit(queued.text, { sameTask: true, from: 'continue' });
  }

  // THE FAMILY'S ACCOUNT POLICY FIRST (Phase 8.3, fabric/fallback.js) Automatic fallback moves to the next eligible account of the same family for the…
  let fallback = null;
  if (record.stopReason === 'rate-limited' && record.providerFailure && !app.wantExit) {
    try { fallback = require('./fabric/fallback').onTurnLimited(app, record); } catch { fallback = null; }
    if (fallback && fallback.action === 'switched') {
      if (app.ui.enabled) app.ui.noteActor('note', fallback.text); else app.render.notice('info', fallback.text);
      return await app.submit(require('./ratelimit').RESUME_PROMPT, { sameTask: true, from: 'account-fallback' });
    }
    if (fallback && app.ui.enabled && await require('./fabric/fallback').askInTerminal(app)) {
      return await app.submit(require('./ratelimit').RESUME_PROMPT, { sameTask: true, from: 'account-fallback' });
    }
  }

  // RATE LIMITED FOR HOURS: WAIT, OR CHANGE MODEL
  if (record.stopReason === 'rate-limited' && record.providerFailure) {
    // AN ACCOUNT QUESTION IS ALREADY ON THE SESSION (Ask / Pinned / no compatible account): it is the answer
    // the person gives — the window and Telegram show it; nothing waits on a second question here.
    if (fallback) { app.render.notice('warn', fallback.text || 'The account is rate limited — choose what to do.'); return record; }
    return await require('./ratelimit').handle(app, record, text);
  }

  // AND IF NOBODY IS LOOKING, SAY SO
  require('./notify').turnEnded(app, record);
  return record;
}

module.exports = { after };
