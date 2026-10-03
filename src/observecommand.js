'use strict';

/** `/stop` AND `/observing` — stopping the BOT without stopping LAIN. */

function register({ define, DURING_TURN, C, FLASH_MS }) {
  define('/stop', {
    flashMs: FLASH_MS,   // a receipt, not an inspector - see FLASH_MS
    // MACHINERY: about the run, not about the conversation. It goes to the
    // bottom surface and clears itself.
    surface: true,
    // NOT BLOCKED DURING A TURN, and that is the whole point of it.
    duringTurn: DURING_TURN.SAFE,
    desc: 'Stop the observed run — LAIN keeps the evidence and keeps working',
    run(app, { rest } = {}) {
      const w = (s) => app.render.write(s);
      const yard = app._observatory;
      const obs = yard && yard.current;
      if (!obs || !obs.running) {
        w(C.dim('  Nothing is being observed. ') + C.dim('Ctrl+C stops the turn; /exit leaves LAIN.\n'));
        return;
      }
      const observe = require('./observe');
      if (obs.job && typeof obs.job.cancel === 'function' && !obs.job.done) {
        try { obs.job.cancel('you stopped the run'); } catch { /* already gone */ }
      }
      observe.finish(obs, String(rest || '').trim() || 'you stopped it');
      const s = obs.summary();
      w('\n' + C.green('  RUN STOPPED') + C.dim(`  ${obs.command}\n`));
      w(C.dim(`  ${Math.round(s.elapsedMs / 1000)}s · ${s.events} event(s) · ${s.captures} capture(s) kept.\n`));
      // SAID EXPLICITLY, because the fear this command answers is that stopping
      // throws the work away.
      w(C.dim('  The investigation is still open and every piece of evidence is kept.\n'));
      if (app.ui && app.ui.enabled) app.ui.refresh();
    },
  });

  define('/observing', {
    surface: true,
    // READ, not glanced at — it waits for Esc.
    flashMs: 0,
    desc: 'What is being watched right now, and what has been collected',
    run(app) {
      const w = (s) => app.render.write(s);
      const yard = app._observatory;
      const obs = yard && (yard.current || yard.past[yard.past.length - 1]);
      if (!obs) { w(C.dim('  Nothing has been observed in this session.\n')); return; }
      const s = obs.summary();
      w('\n' + C.bold(`  ${s.state}`) + C.dim(`  ${s.command}\n`));
      w(C.dim(`  ${Math.round(s.elapsedMs / 1000)}s · ${s.lines} line(s) · ${s.events} event(s) · `
        + `${s.captures} capture(s)${s.capturesRefused ? `, ${s.capturesRefused} refused` : ''}\n`));
      if (s.expectation.length) {
        w('\n' + C.dim('  EXPECTED\n'));
        s.expectation.forEach((e, i) => w(C.dim(`    ${i + 1}. ${e}\n`)));
      }
      if (s.kinds.length) {
        w('\n' + C.dim('  SEEN\n'));
        for (const k of s.kinds) w(C.dim(`    ${k.kind} ×${k.n}\n`));
      }
      // WHAT IS CURRENTLY HELD DOWN belongs here more than anywhere: a bot that was stopped while a key was down leaves a keyboard that does not work, and…
      const held = require('./heldkeys').list();
      if (held.length) {
        w('\n' + C.yellow('  KEYS STILL HELD\n'));
        for (const h of held) w(C.yellow(`    ${h.key}`) + C.dim(` — ${Math.round(h.heldMs / 1000)}s\n`));
      }
      if (obs.running) w('\n' + C.dim('  /stop ends the run and keeps everything.\n'));
    },
  });
}

module.exports = { register };
